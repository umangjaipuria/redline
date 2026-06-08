// Per-document read/write primitives composed from core + the format adapter.
// The server's session map supplies the path; everything here is path-addressed
// and stateless (review state lives in the file).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  emptyState,
  reconcile,
  summarize,
  SCHEMA_VERSION,
  type AnchorStatus,
  type EmbeddedState,
  type Thread,
} from "../core";
import { MalformedStateError, requireAdapterForPath } from "../formats";
import { ConflictError, MalformedDocumentError } from "./errors";

export interface DocumentView {
  path: string;
  format: string;
  version: string;
  updatedAt: string;
  title?: string;
  renderedHtml: string;
  threads: Thread[];
  anchors: AnchorStatus[];
  summary: { threads: number; messages: number };
  canonicalText: string;
  // Set when the embedded block couldn't be parsed: the view shows the document
  // with no review state and writes are refused until it's resolved.
  warning?: string;
}

// A content hash identifying the exact bytes on disk. Used both as the version
// the client echoes back (expectedVersion) and as the optimistic-concurrency
// guard for state-block writes.
export function versionFor(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function readFile(absolutePath: string): string {
  return fs.readFileSync(absolutePath, "utf8");
}

// Build the full view for the UI/agents: render, reconcile anchors against the
// canonical text, summarize. A malformed block degrades to "no review state"
// plus a warning rather than throwing — the document is still viewable.
export function buildView(absolutePath: string, content: string): DocumentView {
  const adapter = requireAdapterForPath(absolutePath);
  let state: EmbeddedState;
  let warning: string | undefined;
  try {
    state = adapter.readState(content) ?? emptyState();
  } catch (error) {
    if (error instanceof MalformedStateError) {
      state = emptyState();
      warning = error.message;
    } else {
      throw error;
    }
  }

  const canonicalText = adapter.extractText(content);
  const { statuses } = reconcile(canonicalText, state.threads);
  const rendered = adapter.render(content);
  const view: DocumentView = {
    path: absolutePath,
    format: adapter.id,
    version: versionFor(content),
    updatedAt: state.updatedAt,
    renderedHtml: rendered.html,
    threads: state.threads,
    anchors: statuses,
    summary: summarize(state.threads),
    canonicalText,
  };
  if (rendered.title) view.title = rendered.title;
  if (warning) view.warning = warning;
  return view;
}

export function readDocument(absolutePath: string): DocumentView {
  return buildView(absolutePath, readFile(absolutePath));
}

// Read the state block for a write. Unlike buildView, a malformed block throws
// here so a mutation never silently discards comments it couldn't parse.
function readStateForWrite(adapterContent: string, absolutePath: string): EmbeddedState {
  const adapter = requireAdapterForPath(absolutePath);
  try {
    return adapter.readState(adapterContent) ?? emptyState();
  } catch (error) {
    if (error instanceof MalformedStateError) {
      throw new MalformedDocumentError(
        `Refusing to write: ${error.message} Resolve the embedded #redline-state block first.`,
      );
    }
    throw error;
  }
}

export interface MutationContext {
  threads: Thread[]; // the current on-disk threads (freshly read at write time)
  canonicalText: string; // current canonical text, for selector capture/resolution
}

export interface MutationResult {
  threads: Thread[];
  // When false, the mutation is a no-op write (used by reconcile self-healing to
  // avoid bumping updatedAt for a pure hint refresh). Defaults to true.
  bumpUpdatedAt?: boolean;
}

// The single state-block write path. Re-reads the file immediately before
// writing so an external content edit is preserved (we re-apply only our block
// onto the current content) and so cross-writer mutations merge by thread id:
// the mutator runs against whatever threads are on disk now, not a stale copy.
// Writes atomically (temp + rename). `expectedVersion`, when given, is the
// optimistic-concurrency guard — a mismatch is a ConflictError carrying the
// current view.
const MAX_WRITE_ATTEMPTS = 5;

export function mutateState(
  absolutePath: string,
  expectedVersion: string | undefined,
  mutate: (ctx: MutationContext) => MutationResult,
): DocumentView {
  const adapter = requireAdapterForPath(absolutePath);

  // Two layers of protection:
  //  1. A cooperative lockfile serializes REDLINE writers to this file across
  //     processes (a second server, a stale registry, a direct CLI write). The
  //     plan's "every state-block write is serialized by Redline" — Redline
  //     instances honor it because they are the same code. This is NOT relying
  //     on the external agent to honor a lock (it doesn't); see layer 2.
  //  2. Inside the lock, an optimistic re-read-before-rename merges any external
  //     CONTENT edit the agent made (the agent writes content without the lock):
  //     we re-apply only our state block onto the freshest bytes, and retry if
  //     the file moved between our read and the rename.
  return withWriteLock(absolutePath, () => mutateLocked(absolutePath, adapter, expectedVersion, mutate));
}

function mutateLocked(
  absolutePath: string,
  adapter: ReturnType<typeof requireAdapterForPath>,
  expectedVersion: string | undefined,
  mutate: (ctx: MutationContext) => MutationResult,
): DocumentView {
  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
    const content = readFile(absolutePath);
    const currentVersion = versionFor(content);
    if (expectedVersion !== undefined && expectedVersion !== currentVersion) {
      throw new ConflictError(
        "The document changed before this write completed. Re-read its current state and retry.",
        buildView(absolutePath, content),
      );
    }

    const state = readStateForWrite(content, absolutePath);
    const canonicalText = adapter.extractText(content);
    const result = mutate({ threads: state.threads, canonicalText });
    const bump = result.bumpUpdatedAt !== false;

    const nextState: EmbeddedState = {
      schemaVersion: SCHEMA_VERSION,
      updatedAt: bump ? new Date().toISOString() : state.updatedAt,
      threads: result.threads,
    };
    const nextContent = adapter.writeState(content, nextState);
    if (nextContent === content) {
      return buildView(absolutePath, content); // no-op write (e.g. idle self-heal)
    }

    // CAS guard: if the bytes changed since we read them, another writer (a
    // second Redline or a direct content edit) slipped in — retry against the
    // fresh bytes so we merge instead of clobber.
    if (readFile(absolutePath) !== content) {
      continue;
    }
    writeFileAtomic(absolutePath, nextContent);
    return buildView(absolutePath, nextContent);
  }

  throw new ConflictError(
    "The document is being written concurrently; could not complete the write. Retry.",
    buildView(absolutePath, readFile(absolutePath)),
  );
}

// Reconcile + lazily persist refreshed anchor hints. Returns the view and
// whether a self-healing write happened. Intended for "on open / on external
// change" — a state-block-only write that never races the editor (it merges
// against the current on-disk threads via mutateState).
export function reconcileDocument(absolutePath: string): {
  view: DocumentView;
  healed: boolean;
} {
  let healed = false;
  try {
    // The heal runs INSIDE mutateState, as a transform over the threads on disk
    // now — never a stale snapshot. A comment added between read and write
    // therefore can't be dropped: it's part of ctx.threads when we reconcile.
    const view = mutateState(absolutePath, undefined, (ctx) => {
      const result = reconcile(ctx.canonicalText, ctx.threads);
      healed = result.changed;
      return { threads: result.healedThreads, bumpUpdatedAt: false };
    });
    return { view, healed };
  } catch (error) {
    if (error instanceof MalformedDocumentError) {
      // Can't heal an unparseable block; return the warning-bearing view.
      return { view: readDocument(absolutePath), healed: false };
    }
    throw error;
  }
}

export function resolveAbsolutePath(input: string): string {
  return path.resolve(input);
}

function writeFileAtomic(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomSuffix()}.tmp`;
  fs.writeFileSync(tempPath, content, "utf8");
  fs.renameSync(tempPath, filePath);
}

const LOCK_TIMEOUT_MS = 10_000;
const LOCK_STALE_MS = 30_000;

// Cooperative advisory lock between Redline writers, via an O_EXCL lockfile next
// to the document. Held only for the short, synchronous read/mutate/write cycle.
// Ownership rules (the round-3 fix): a UNIQUE token is written into the lock; we
// only ever remove a lock that still carries our token; a LIVE (non-stale) lock
// is never broken — we time out with a ConflictError instead; and a stale lock
// is broken atomically by renaming it away (only one waiter can win the rename),
// so two waiters can't both "break" it into double ownership. The lockfile is a
// hidden sibling so it never shows in the file browser.
function withWriteLock<T>(targetPath: string, fn: () => T): T {
  const dir = path.dirname(targetPath);
  const lockPath = path.join(dir, `.${path.basename(targetPath)}.redline-lock`);
  fs.mkdirSync(dir, { recursive: true });
  const token = `${process.pid}.${randomSuffix()}`;

  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let acquired = false;
  while (!acquired) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      fs.writeSync(fd, token);
      fs.closeSync(fd);
      acquired = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (tryBreakStaleLock(lockPath)) continue; // broke an abandoned lock; retry
      if (Date.now() > deadline) {
        // Do NOT break a live lock — that would create double ownership. The
        // holder is actively writing (its critical section is sub-millisecond,
        // so this only fires under genuine pathology); surface a conflict.
        throw new ConflictError(
          "Another Redline writer holds the document lock. Retry.",
          buildView(targetPath, readFile(targetPath)),
        );
      }
      sleepSync(10);
    }
  }

  try {
    return fn();
  } finally {
    releaseLock(lockPath, token);
  }
}

// Break a lock only if it is older than LOCK_STALE_MS, and atomically: rename it
// to a unique name first (only one waiter can win that rename) and delete the
// renamed copy. Returns true if a stale lock was broken (caller should retry).
function tryBreakStaleLock(lockPath: string): boolean {
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(lockPath).mtimeMs;
  } catch {
    return true; // lock vanished between open and stat; just retry the create
  }
  if (Date.now() - mtimeMs <= LOCK_STALE_MS) return false;
  const stealPath = `${lockPath}.${process.pid}.${randomSuffix()}.steal`;
  try {
    fs.renameSync(lockPath, stealPath); // atomic: only one waiter wins
    fs.rmSync(stealPath, { force: true });
    return true;
  } catch {
    // Another waiter renamed it first, or the holder removed it; retry the create.
    return true;
  }
}

// Remove the lock only if it still carries OUR token (a stale-break by another
// waiter, after we somehow exceeded the stale window, must not let us delete a
// successor's lock).
function releaseLock(lockPath: string, token: string): void {
  try {
    if (fs.readFileSync(lockPath, "utf8") === token) {
      fs.rmSync(lockPath, { force: true });
    }
  } catch {
    // Already gone or unreadable; nothing to release.
  }
}

// Block the current thread briefly (lock contention is rare and the critical
// section is microseconds, so this never meaningfully stalls the event loop).
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function randomSuffix(): string {
  return crypto.randomBytes(6).toString("hex");
}
