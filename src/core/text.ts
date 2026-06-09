// The single shared text-normalization contract used by BOTH sides of the
// system: the server resolves anchors against the adapter's canonical text
// (extractText), and the client paints highlights by re-finding the resolved
// quote in the rendered DOM's text layer. Those two must agree, so the
// normalization rule lives here, once, and is imported by core (server) and
// src/client (browser) alike.
//
// The rule (seeded from the previous public/app-helpers.js quote matcher):
// collapse every run of whitespace to a single space, match case-insensitively
// (lowercased), and report matches as {start, end} ranges over the ORIGINAL
// (un-normalized) text, in document order. This module operates purely on
// already-extracted text — no HTML/tag handling lives here; that is the
// adapter's job (extractText excludes script/style/hidden content and inserts
// block boundaries as spaces).

export interface TextRange {
  start: number;
  end: number;
}

// Cap matched against by both sides so occurrence counts stay identical for very
// long selections — the stored quote is the truncated form and is what gets
// re-located.
export const MAX_QUOTE_LENGTH = 500;

// Whitespace-collapsed, lowercased copy of `text` plus a per-character map back
// to original indices. `offsets` carries a trailing `text.length` entry so a
// match end maps to the original index just past the matched run. A lowercase
// expansion that yields multiple code units (e.g. "İ") maps each unit to the
// same original index.
export function normalizeWithOffsets(text: string): {
  normalized: string;
  offsets: number[];
} {
  let normalized = "";
  const offsets: number[] = [];
  let inWhitespace = false;
  const source = String(text ?? "");

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] ?? "";
    if (/\s/.test(char)) {
      if (inWhitespace) continue;
      inWhitespace = true;
      normalized += " ";
      offsets.push(index);
      continue;
    }
    inWhitespace = false;
    for (const lowerChar of char.toLowerCase()) {
      normalized += lowerChar;
      offsets.push(index);
    }
  }
  offsets.push(source.length);

  return { normalized, offsets };
}

// Normalize a quote the same way the server stores it: collapse, trim, cap, then
// lowercase. Returned to callers that need the comparison key.
export function normalizeQuoteKey(quote: string): string {
  return String(quote ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_QUOTE_LENGTH)
    .toLowerCase();
}

// Collapse + trim + cap, preserving original case — the form persisted as the
// anchor's `quote`/`prefix`/`suffix`.
export function normalizeQuote(quote: string): string {
  return String(quote ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_QUOTE_LENGTH);
}

// Every exact (whitespace-/case-insensitive) match of `quote` in `text`, as
// ranges over the original text, in document order. The shared occurrence rule.
export function findQuoteMatches(text: string, quote: string): TextRange[] {
  const needle = normalizeQuoteKey(quote);
  if (!needle) return [];

  const { normalized, offsets } = normalizeWithOffsets(String(text ?? ""));
  const matches: TextRange[] = [];
  let from = 0;
  while (from <= normalized.length) {
    const at = normalized.indexOf(needle, from);
    if (at === -1) break;
    const start = offsets[at];
    const end = offsets[at + needle.length];
    if (start !== undefined && end !== undefined && end > start) {
      matches.push({ start, end });
    }
    from = at + Math.max(needle.length, 1);
  }
  return matches;
}
