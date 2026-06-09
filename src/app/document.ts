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

interface BuiltDocumentView {
  view: DocumentView;
  healedThreads: Thread[];
  healed: boolean;
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
function buildDocumentView(absolutePath: string, content: string): BuiltDocumentView {
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
  const result = reconcile(canonicalText, state.threads);
  const rendered = adapter.render(content);
  const view: DocumentView = {
    path: absolutePath,
    format: adapter.id,
    version: versionFor(content),
    updatedAt: state.updatedAt,
    renderedHtml: rendered.html,
    threads: state.threads,
    anchors: result.statuses,
    summary: summarize(state.threads),
    canonicalText,
  };
  if (rendered.title) view.title = rendered.title;
  if (warning) view.warning = warning;
  return {
    view,
    healedThreads: warning ? state.threads : result.healedThreads,
    healed: warning ? false : result.changed,
  };
}

export function buildView(absolutePath: string, content: string): DocumentView {
  return buildDocumentView(absolutePath, content).view;
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

// The single state-block write path — optimistic concurrency, exactly as the
// plan specifies ("Guard every state-block write with an optimistic
// version/hash check against the current on-disk block: on mismatch, re-read and
// merge — threads are keyed by id, so independent adds/edits merge cleanly — or
// return a conflict"). NO cooperative lockfile: a file-based lock can't be made
// TOCTOU-free without OS advisory locks, which the plan rejects (an external
// agent won't honor them), and a buggy lock is worse than none. Instead:
//
//   - Within one process, writes are serialized already (this function is fully
//     synchronous — no await between read and rename).
//   - Across writers, each attempt reads the CURRENT bytes, runs the mutation
//     against the threads on disk now (so independent comment adds/edits/deletes
//     merge by id), re-applies ONLY our state block onto those bytes (so an
//     external CONTENT edit by the agent is preserved), and re-reads immediately
//     before the atomic rename — retrying if the file moved, so we merge instead
//     of clobber.
//   - The irreducible micro-window between that final compare and the rename
//     degrades to last-write-wins, which the plan accepts as the starting
//     behavior for two genuinely-simultaneous writers (paired with the client's
//     "document changed, reloaded" notice). It never loses data silently outside
//     that window, and never corrupts coordination state.
export function mutateState(
  absolutePath: string,
  expectedVersion: string | undefined,
  mutate: (ctx: MutationContext) => MutationResult,
): DocumentView {
  const adapter = requireAdapterForPath(absolutePath);

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
    const healed = reconcile(canonicalText, result.threads);
    const bump = result.bumpUpdatedAt !== false;

    const nextState: EmbeddedState = {
      schemaVersion: SCHEMA_VERSION,
      updatedAt: bump ? new Date().toISOString() : state.updatedAt,
      threads: healed.healedThreads,
    };
    const nextContent = adapter.writeState(content, nextState);
    if (nextContent === content) {
      return buildView(absolutePath, content); // no-op write (e.g. idle self-heal)
    }

    // Optimistic guard: if the bytes changed since we read them, another writer
    // (a second Redline or a direct content edit) slipped in — retry against the
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

// Reconcile the document without writing. Passive reads, opens, reloads, and
// watcher ticks may use this to get fresh anchor statuses and pending healed
// selector hints, but they must not rewrite the state block while an external
// editor may still be working.
export function reconcileDocument(absolutePath: string): {
  view: DocumentView;
  healed: boolean;
  healedThreads: Thread[];
} {
  return buildDocumentView(absolutePath, readFile(absolutePath));
}

// Persist only refreshed selector hints, guarded by the version that produced
// them. This is used for deliberate flush points (close/shutdown/quiet idle),
// never for the immediate passive watcher response to an external edit.
export function flushReconciledHints(
  absolutePath: string,
  expectedVersion: string,
): {
  view: DocumentView;
  healed: boolean;
} {
  let healed = false;
  const view = mutateState(absolutePath, expectedVersion, (ctx) => {
    const result = reconcile(ctx.canonicalText, ctx.threads);
    healed = result.changed;
    return { threads: result.healedThreads, bumpUpdatedAt: false };
  });
  return { view, healed };
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


function randomSuffix(): string {
  return crypto.randomBytes(6).toString("hex");
}
