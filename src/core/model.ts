// The format-neutral review model: threads, messages, the anchor selector
// schema, and the embedded-state shape — plus normalization that hardens
// whatever is parsed from a file's state block or arrives over the wire. No
// knowledge of HTML, files, or transport lives here.

import { newId, normalizeId } from "./ids";
import { normalizeQuote } from "./text";

export interface Message {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  updatedAt?: string;
}

// Redundant selectors captured at comment-creation time, all over the adapter's
// CANONICAL text (extractText) — never raw markup. prefix/suffix replace the old
// 1-based occurrence index; context disambiguates duplicates and survives
// reordering where an occurrence count cannot.
export interface AnchorSelectors {
  quote: string; // exact selected text, normalized
  prefix: string; // context immediately before the quote
  suffix: string; // context immediately after the quote
  posStart: number; // approximate char offset in canonical text — a hint only
  posEnd: number;
  // Set when self-healing let `quote` follow an edit, keeping the change
  // auditable against the text originally selected.
  originalQuote?: string;
}

export interface Thread {
  id: string; // "thread_..."
  anchor?: AnchorSelectors; // omitted/null = document-level (general) comment
  author: string;
  createdAt: string;
  updatedAt: string;
  messages: Message[]; // [0] = original comment; rest = replies
}

// The only structure Redline serializes into a file. `schemaVersion` is bumped
// for the selector model so the on-disk format is self-identifying; older
// versions are rejected rather than silently corrupted.
export interface EmbeddedState {
  schemaVersion: number;
  updatedAt: string;
  threads: Thread[];
}

export const SCHEMA_VERSION = 2;
export const EMPTY_UPDATED_AT = "1970-01-01T00:00:00.000Z";

// How much surrounding context to capture on each side of a quote (chars). A
// tuning knob, kept central so capture and any re-capture stay consistent.
export const CONTEXT_WINDOW = 32;

export function emptyState(): EmbeddedState {
  return { schemaVersion: SCHEMA_VERSION, updatedAt: EMPTY_UPDATED_AT, threads: [] };
}

export function normalizeAuthor(value: unknown, fallback = "User"): string {
  const author = typeof value === "string" ? value.trim() : "";
  return author || fallback;
}

export function normalizeBody(value: unknown, message: string): string {
  const body = typeof value === "string" ? value.trim() : "";
  if (!body) throw new Error(message);
  return body;
}

function nonNegativeInt(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

export function normalizeAnchor(input: unknown): AnchorSelectors | undefined {
  if (!input || typeof input !== "object") return undefined;
  const raw = input as Partial<AnchorSelectors>;
  const quote = normalizeQuote(typeof raw.quote === "string" ? raw.quote : "");
  if (!quote) return undefined;
  const anchor: AnchorSelectors = {
    quote,
    prefix: normalizeQuote(typeof raw.prefix === "string" ? raw.prefix : ""),
    suffix: normalizeQuote(typeof raw.suffix === "string" ? raw.suffix : ""),
    posStart: nonNegativeInt(raw.posStart),
    posEnd: nonNegativeInt(raw.posEnd),
  };
  if (typeof raw.originalQuote === "string" && raw.originalQuote.trim()) {
    anchor.originalQuote = normalizeQuote(raw.originalQuote);
  }
  return anchor;
}

function normalizeMessage(input: unknown, now: string): Message {
  const raw = (input ?? {}) as Partial<Message>;
  const message: Message = {
    id: normalizeId(raw.id, "message") ?? newId("message"),
    author: normalizeAuthor(raw.author),
    body: typeof raw.body === "string" ? raw.body : "",
    createdAt: stringOr(raw.createdAt, now),
  };
  if (typeof raw.updatedAt === "string" && raw.updatedAt) {
    message.updatedAt = raw.updatedAt;
  }
  return message;
}

export function normalizeThread(input: unknown, now = new Date().toISOString()): Thread {
  const raw = (input ?? {}) as Partial<Thread>;
  const messages = Array.isArray(raw.messages)
    ? raw.messages.map((message) => normalizeMessage(message, now))
    : [];
  const anchor = normalizeAnchor(raw.anchor);
  const thread: Thread = {
    id: normalizeId(raw.id, "thread") ?? newId("thread"),
    author: normalizeAuthor(raw.author),
    createdAt: stringOr(raw.createdAt, now),
    updatedAt: stringOr(raw.updatedAt, now),
    messages,
  };
  if (anchor) thread.anchor = anchor;
  return thread;
}

// Parse + harden a state object read from a file's embedded block. Rejects
// unknown schema versions (caller surfaces a warning and refuses to overwrite an
// unparseable/foreign block).
export function normalizeState(input: unknown): EmbeddedState {
  const raw = (input ?? {}) as Partial<EmbeddedState>;
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== SCHEMA_VERSION) {
    throw new UnknownSchemaError(raw.schemaVersion);
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: stringOr(raw.updatedAt, EMPTY_UPDATED_AT),
    threads: Array.isArray(raw.threads) ? raw.threads.map((thread) => normalizeThread(thread)) : [],
  };
}

export class UnknownSchemaError extends Error {
  constructor(public readonly found: unknown) {
    super(`Unsupported Redline schemaVersion: ${String(found)} (expected ${SCHEMA_VERSION}).`);
    this.name = "UnknownSchemaError";
  }
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

export function summarize(threads: Thread[]): {
  threads: number;
  messages: number;
} {
  return {
    threads: threads.length,
    messages: threads.reduce((total, thread) => total + thread.messages.length, 0),
  };
}
