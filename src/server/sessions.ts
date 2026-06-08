// The document session map. The server keeps a Map<docId, DocumentSession>;
// there is no module-level "current document". Sessions are keyed internally by
// canonical absolute path (opening the same file twice returns the same session)
// and addressed over the API by an opaque, ephemeral docId. Each session owns
// its document's path, version, SSE subscribers, and external-change tracking.

import fs from "node:fs";
import path from "node:path";
import { reconcileDocument, readDocument, type DocumentView } from "../app";
import { adapterForPath } from "../formats";
import type { DocumentSessionInfo } from "../shared";
import { generateDocId } from "./docid";

type Controller = ReadableStreamDefaultController<Uint8Array>;

export interface DocumentSession {
  docId: string;
  path: string; // canonical absolute path
  format: string;
  version: string;
  updatedAt: string;
  title?: string;
  lastActiveAt: number;
  // Version last produced by THIS server (our own writes). The poll loop compares
  // the on-disk version against it to detect external edits without re-firing on
  // our own writes.
  lastKnownVersion: string;
  subscribers: Set<Controller>;
}

const encoder = new TextEncoder();

export class SessionManager {
  private readonly byDocId = new Map<string, DocumentSession>();
  private readonly byPath = new Map<string, string>(); // canonicalPath -> docId
  private readonly serverSubscribers = new Set<Controller>();
  private poll?: ReturnType<typeof setInterval>;

  constructor(private readonly onDocsChanged: () => void = () => {}) {}

  // Open a document, or return the existing session for its canonical path.
  openOrGet(rawPath: string): { session: DocumentSession; opened: boolean } {
    const canonical = path.resolve(rawPath);
    const existingId = this.byPath.get(canonical);
    if (existingId) {
      const session = this.byDocId.get(existingId)!;
      session.lastActiveAt = Date.now();
      return { session, opened: false };
    }

    if (!fs.existsSync(canonical) || !fs.statSync(canonical).isFile()) {
      throw new SessionError(`Not a file: ${canonical}`, 404);
    }
    if (!adapterForPath(canonical)) {
      throw new SessionError(
        `Redline cannot open this file yet: ${canonical}. Only .html/.htm are supported.`,
        415,
      );
    }

    // Reconcile on open (heals stale hints once, lazily).
    const { view } = reconcileDocument(canonical);
    const docId = generateDocId((candidate) => this.byDocId.has(candidate));
    const session: DocumentSession = {
      docId,
      path: canonical,
      format: view.format,
      version: view.version,
      updatedAt: view.updatedAt,
      title: view.title,
      lastActiveAt: Date.now(),
      lastKnownVersion: view.version,
      subscribers: new Set(),
    };
    this.byDocId.set(docId, session);
    this.byPath.set(canonical, docId);
    this.onDocsChanged();
    this.broadcastServer("document.opened", { docId, path: canonical });
    return { session, opened: true };
  }

  get(docId: string): DocumentSession | undefined {
    return this.byDocId.get(docId);
  }

  getByPath(rawPath: string): DocumentSession | undefined {
    const id = this.byPath.get(path.resolve(rawPath));
    return id ? this.byDocId.get(id) : undefined;
  }

  list(): DocumentSession[] {
    return [...this.byDocId.values()].sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  }

  close(docId: string): boolean {
    const session = this.byDocId.get(docId);
    if (!session) return false;
    this.broadcastDoc(session, "document.closed", { docId });
    for (const controller of session.subscribers) {
      try {
        controller.close();
      } catch {
        // Already closed.
      }
    }
    session.subscribers.clear();
    this.byDocId.delete(docId);
    this.byPath.delete(session.path);
    this.onDocsChanged();
    this.broadcastServer("document.closed", { docId, path: session.path });
    return true;
  }

  info(session: DocumentSession): DocumentSessionInfo {
    const out: DocumentSessionInfo = {
      docId: session.docId,
      path: session.path,
      format: session.format,
      version: session.version,
      updatedAt: session.updatedAt,
    };
    if (session.title) out.title = session.title;
    return out;
  }

  // Record the result of one of our own writes so the poll loop doesn't mistake
  // it for an external edit, and broadcast the mutation event.
  applyMutation(session: DocumentSession, view: DocumentView, event: string): void {
    session.version = view.version;
    session.updatedAt = view.updatedAt;
    session.title = view.title;
    session.lastKnownVersion = view.version;
    session.lastActiveAt = Date.now();
    this.broadcastDoc(session, event, {
      docId: session.docId,
      version: view.version,
      summary: view.summary,
    });
  }

  // --- SSE subscription ---------------------------------------------------

  subscribeDoc(session: DocumentSession, controller: Controller): void {
    session.subscribers.add(controller);
  }

  unsubscribeDoc(session: DocumentSession, controller: Controller): void {
    session.subscribers.delete(controller);
  }

  subscribeServer(controller: Controller): void {
    this.serverSubscribers.add(controller);
  }

  unsubscribeServer(controller: Controller): void {
    this.serverSubscribers.delete(controller);
  }

  broadcastDoc(session: DocumentSession, event: string, data: unknown): void {
    const payload = encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    for (const controller of [...session.subscribers]) {
      try {
        controller.enqueue(payload);
      } catch {
        session.subscribers.delete(controller);
      }
    }
  }

  broadcastServer(event: string, data: unknown): void {
    const payload = encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    for (const controller of [...this.serverSubscribers]) {
      try {
        controller.enqueue(payload);
      } catch {
        this.serverSubscribers.delete(controller);
      }
    }
  }

  // --- external change watching -------------------------------------------

  startWatching(intervalMs = 750): void {
    if (this.poll) return;
    this.poll = setInterval(() => this.checkExternalChanges(), intervalMs);
    this.poll.unref?.();
  }

  stopWatching(): void {
    if (this.poll) clearInterval(this.poll);
    this.poll = undefined;
  }

  checkExternalChanges(): void {
    for (const session of [...this.byDocId.values()]) {
      try {
        // Rename/delete: treat as external change, then close the session.
        if (!fs.existsSync(session.path)) {
          this.close(session.docId);
          continue;
        }
        const onDisk = readDocument(session.path);
        if (onDisk.version === session.lastKnownVersion) continue;

        // External edit detected. Reconcile (heal hints lazily) and announce.
        const { view } = reconcileDocument(session.path);
        session.version = view.version;
        session.updatedAt = view.updatedAt;
        session.title = view.title;
        session.lastKnownVersion = view.version;
        this.broadcastDoc(session, "external.changed", {
          docId: session.docId,
          version: view.version,
        });
        this.broadcastDoc(session, "anchors.reconciled", {
          docId: session.docId,
          version: view.version,
          summary: summarizeAnchors(view),
        });
      } catch {
        // Keep the server alive if an editor temporarily swaps the file on disk.
      }
    }
  }

  closeAll(): void {
    for (const docId of [...this.byDocId.keys()]) this.close(docId);
  }

  registryDocs(): { docId: string; path: string }[] {
    return [...this.byDocId.values()].map((session) => ({ docId: session.docId, path: session.path }));
  }
}

function summarizeAnchors(view: DocumentView): {
  orphaned: number;
  needsReview: number;
  anchored: number;
} {
  let orphaned = 0;
  let needsReview = 0;
  let anchored = 0;
  for (const anchor of view.anchors) {
    if (anchor.state === "orphaned") orphaned += 1;
    else if (anchor.state === "needs-review") needsReview += 1;
    else anchored += 1;
  }
  return { orphaned, needsReview, anchored };
}

export class SessionError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "SessionError";
  }
}
