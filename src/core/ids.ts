import crypto from "node:crypto";

// Thread/message id format and validation, preserved from the previous code:
// `thread_<16 hex>` and `message_<16 hex>`, validated against a strict charset
// so ids that arrive over the wire can't smuggle anything unexpected into the
// state block.

export function newId(prefix: "thread" | "message"): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

// Returns the trimmed id when it is a well-formed id of the given prefix, else
// null. Used to validate caller-supplied ids before they touch state.
export function normalizeId(value: unknown, prefix: "thread" | "message"): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  if (!id.startsWith(`${prefix}_`)) return null;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return null;
  return id;
}

export function isThreadId(value: string): boolean {
  return normalizeId(value, "thread") !== null;
}
