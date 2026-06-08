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
  // buildView (re-read + render + reconcile) runs OUTSIDE the lock to keep the
  // hold time to the bare write cycle.
  const finalContent = withWriteLock(absolutePath, () =>
    mutateLocked(absolutePath, adapter, expectedVersion, mutate),
  );
  return buildView(absolutePath, finalContent);
}

// Runs under the write lock. Returns the final on-disk content (the caller
// builds the view outside the lock).
function mutateLocked(
  absolutePath: string,
  adapter: ReturnType<typeof requireAdapterForPath>,
  expectedVersion: string | undefined,
  mutate: (ctx: MutationContext) => MutationResult,
): string {
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
      return content; // no-op write (e.g. idle self-heal)
    }

    // CAS guard: if the bytes changed since we read them, another writer (a
    // second Redline or a direct content edit) slipped in — retry against the
    // fresh bytes so we merge instead of clobber.
    if (readFile(absolutePath) !== content) {
      continue;
    }
    writeFileAtomic(absolutePath, nextContent);
    return nextContent;
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
// A lock this old is treated as abandoned even if its owner pid looks alive
// (guards against pid reuse deadlocking writes). Far longer than any real hold —
// a Redline state-block write is sub-millisecond — so it never steals from a
// legitimately-active writer.
const LOCK_ANCIENT_MS = 30_000;

// Cooperative advisory lock between Redline writers, via an O_EXCL lockfile next
// to the document, held only for the short synchronous read/mutate/write cycle.
// Correctness rules:
//   - Each acquisition writes "<pid>.<random>" so ownership is identifiable.
//   - A lock is broken ONLY when its owner process is dead (pid-liveness) or the
//     lock is ancient — never when the owner is alive, so a slow-but-live writer
//     is never stolen from. On timeout we surface a ConflictError, not a steal.
//   - Breaking and releasing are atomic via rename (only one racer wins), so two
//     waiters can't both "break" a lock, and a releasing owner can never delete a
//     successor's lock.
// The lockfile is a hidden sibling so it never shows in the file browser.
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
      if (Date.now() > deadline) {
        // The holder is alive and recent — surface a conflict rather than break
        // a live lock (which would create double ownership and lose a write).
        throw new ConflictError(
          "Another Redline writer holds the document lock. Retry.",
          buildView(targetPath, readFile(targetPath)),
        );
      }
      if (tryBreakStaleLock(lockPath)) continue; // broke an abandoned lock; retry now
      sleepSync(10);
    }
  }

  try {
    return fn();
  } finally {
    releaseLock(lockPath, token);
  }
}

// Break a lock only when its owner process is dead, or it is ancient. The break
// is atomic (rename away, then delete), so concurrent waiters can't both break
// one lock into double ownership. Returns true if a break was attempted and the
// caller should retry the create; false to keep waiting (owner alive & recent,
// or a persistent filesystem error).
function tryBreakStaleLock(lockPath: string): boolean {
  let content: string;
  let mtimeMs: number;
  try {
    content = fs.readFileSync(lockPath, "utf8");
    mtimeMs = fs.statSync(lockPath).mtimeMs;
  } catch {
    return true; // vanished between open and read; just retry the create
  }
  const ownerPid = Number.parseInt(content.split(".")[0] ?? "", 10);
  const ownerDead = Number.isInteger(ownerPid) && !isProcessAlive(ownerPid);
  const ancient = Date.now() - mtimeMs > LOCK_ANCIENT_MS;
  if (!ownerDead && !ancient) return false; // live & recent owner — do not break

  const stealPath = `${lockPath}.${process.pid}.${randomSuffix()}.steal`;
  try {
    fs.renameSync(lockPath, stealPath); // atomic: only one waiter wins this
    fs.rmSync(stealPath, { force: true });
    return true;
  } catch (error) {
    // ENOENT: another waiter already broke it — retry. Anything else (e.g.
    // EPERM): can't break; wait so the deadline path can fire.
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

// Release atomically so we can never delete a SUCCESSOR's lock (one that
// replaced ours after we were broken as ancient). Rename our lock away first; if
// the renamed file still carries our token it was ours (delete it), otherwise a
// successor exists and we restore it untouched.
export function releaseLock(lockPath: string, token: string): void {
  const releasePath = `${lockPath}.${process.pid}.${randomSuffix()}.release`;
  try {
    fs.renameSync(lockPath, releasePath);
  } catch {
    return; // already gone / broken by someone else — nothing to release
  }
  try {
    if (fs.readFileSync(releasePath, "utf8") === token) {
      fs.rmSync(releasePath, { force: true });
    } else {
      // A successor's lock — put it back. If a newer lock already exists, drop
      // our copy rather than clobber it.
      try {
        fs.renameSync(releasePath, lockPath);
      } catch {
        fs.rmSync(releasePath, { force: true });
      }
    }
  } catch {
    fs.rmSync(releasePath, { force: true });
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = existence check, no signal delivered
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM"; // exists, other user
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
