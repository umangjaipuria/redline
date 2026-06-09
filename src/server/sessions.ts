// The document session map. The server keeps a Map<docId, DocumentSession>;
// there is no module-level "current document". Sessions are keyed internally by
// canonical absolute path (opening the same file twice returns the same session)
// and addressed over the API by an opaque, ephemeral docId. Each session owns
// its document's path, version, SSE subscribers, and external-change tracking.

import fs from "node:fs";
import path from "node:path";
import { flushReconciledHints, reconcileDocument, versionFor, type DocumentView } from "../app";
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
  // Cheap change-detection signature from the last time we VERIFIED the file's
  // bytes hash to `lastKnownVersion`. The poll skips the expensive read+render
  // entirely when this is unchanged, so an idle open document costs one stat()
  // per tick, not a render. Set to null after any write of ours (and after a
  // reconcile) so the next poll re-validates against disk rather than trusting a
  // signature that might have been captured across an interleaved external edit.
  lastStat: StatSignature | null;
  pendingHealedHints?: PendingHealedHints;
  subscribers: Set<Controller>;
}

interface PendingHealedHints {
  version: string;
  detectedAt: number;
}

interface StatSignature {
  mtimeMs: number;
  ctimeMs: number; // inode change time — bumps on a content write even if mtime is preserved
  size: number;
  ino: number; // changes when an atomic temp+rename swaps the file
}

const encoder = new TextEncoder();
const DEFAULT_HEALED_HINT_FLUSH_QUIET_MS = 10_000;

export interface SessionManagerOptions {
  healedHintFlushQuietMs?: number;
}

// A cheap filesystem signature for change detection. null when the file is gone.
// mtime+size alone can miss a same-length edit on a coarse-mtime filesystem;
// ctime and ino close most of that gap (ctime can't be set backwards by normal
// tools, and an atomic-rename replacement changes the inode).
function statSignature(filePath: string): StatSignature | null {
  try {
    const stat = fs.statSync(filePath);
    return { mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, size: stat.size, ino: stat.ino };
  } catch {
    return null;
  }
}

function sameStat(a: StatSignature | null, b: StatSignature | null): boolean {
  return (
    a !== null &&
    b !== null &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs &&
    a.size === b.size &&
    a.ino === b.ino
  );
}

export class SessionManager {
  private readonly byDocId = new Map<string, DocumentSession>();
  private readonly byPath = new Map<string, string>(); // canonicalPath -> docId
  private readonly serverSubscribers = new Set<Controller>();
  private poll?: ReturnType<typeof setInterval>;
  private readonly healedHintFlushQuietMs: number;

  constructor(
    private readonly onDocsChanged: () => void = () => {},
    options: SessionManagerOptions = {},
  ) {
    this.healedHintFlushQuietMs = options.healedHintFlushQuietMs ?? DEFAULT_HEALED_HINT_FLUSH_QUIET_MS;
  }

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

    // Reconcile on open so the browser sees fresh statuses. Do not write healed
    // hints here; queue them for an idle/close flush instead.
    const { view, healed } = reconcileDocument(canonical);
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
      // null → the first poll re-validates against disk; an external edit could
      // interleave while opening. Cheap: one read.
      lastStat: null,
      subscribers: new Set(),
    };
    this.notePendingHeal(session, view, healed);
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
    this.flushPendingHeal(session, { broadcast: false });
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
    updateSessionFromView(session, view);
    session.pendingHealedHints = undefined;
    // Don't trust a post-write stat: an external edit could have interleaved
    // between our write and here. Force the next poll to validate by hash.
    session.lastStat = null;
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
    const now = Date.now();
    for (const session of [...this.byDocId.values()]) {
      try {
        const stat = statSignature(session.path);

        // Rename/delete: treat as external change, then close the session.
        if (stat === null) {
          this.close(session.docId);
          continue;
        }

        // Cheap gate: an unchanged signature means the bytes are untouched, so we
        // skip the read + parse + render entirely. This is the common case every
        // tick for every idle document — the whole point of the poll being
        // affordable at many open docs.
        if (sameStat(stat, session.lastStat)) {
          this.flushPendingHealIfQuiet(session, now);
          continue;
        }

        // Stat moved but the bytes may still hash the same (our own atomic write,
        // or a touch). Confirm against the content hash before doing real work —
        // reading bytes is far cheaper than the full render in readDocument.
        const onDiskVersion = versionFor(fs.readFileSync(session.path, "utf8"));
        if (onDiskVersion === session.lastKnownVersion) {
          // Verified: these exact bytes match our tracked version. Safe to cache
          // this signature so the next tick takes the cheap path. (If an external
          // write had interleaved, the hash would differ and we'd reconcile.)
          const flushed = this.flushPendingHealIfQuiet(session, now);
          if (!flushed) session.lastStat = stat;
          continue;
        }

        // External edit detected. Reconcile in memory and announce, but do not
        // write healed hints back while an external editor may still be active.
        const { view, healed } = reconcileDocument(session.path);
        updateSessionFromView(session, view);
        this.notePendingHeal(session, view, healed);
        // Leave lastStat null so the next tick re-validates by hash rather than
        // trusting a signature that might have been captured across an
        // interleaved external edit.
        session.lastStat = null;
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

  private notePendingHeal(session: DocumentSession, view: DocumentView, healed: boolean): void {
    if (healed && !view.warning) {
      session.pendingHealedHints = { version: view.version, detectedAt: Date.now() };
    } else {
      session.pendingHealedHints = undefined;
    }
  }

  private flushPendingHealIfQuiet(session: DocumentSession, now: number): boolean {
    const pending = session.pendingHealedHints;
    if (!pending) return false;
    if (now - pending.detectedAt < this.healedHintFlushQuietMs) return false;
    this.flushPendingHeal(session, { broadcast: true });
    return true;
  }

  private flushPendingHeal(session: DocumentSession, options: { broadcast: boolean }): void {
    const pending = session.pendingHealedHints;
    if (!pending) return;

    try {
      const { view, healed } = flushReconciledHints(session.path, pending.version);
      updateSessionFromView(session, view);
      session.pendingHealedHints = undefined;
      // We just wrote (or verified a no-op); force the next poll to validate by
      // hash before caching a stat signature.
      session.lastStat = null;
      if (options.broadcast && healed) {
        this.broadcastDoc(session, "anchors.reconciled", {
          docId: session.docId,
          version: view.version,
          summary: summarizeAnchors(view),
        });
      }
    } catch (error) {
      session.pendingHealedHints = undefined;
      session.lastStat = null;
      // A concurrent edit or malformed state just means this cache-like hint
      // flush was skipped. Do not advance lastKnownVersion here: if the file
      // changed, the next watcher pass must still detect and broadcast it.
    }
  }
}

function updateSessionFromView(session: DocumentSession, view: DocumentView): void {
  session.version = view.version;
  session.updatedAt = view.updatedAt;
  session.title = view.title;
  session.lastKnownVersion = view.version;
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
