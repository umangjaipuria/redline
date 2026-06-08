// Selector capture and the fuzzy resolution cascade. Everything here operates on
// the adapter's CANONICAL text (extractText) — never raw markup. Anchors are
// resolved fresh against the current text on every read/render, so there is no
// persisted position that can be stale-and-wrong; the stored posStart/posEnd are
// only hints that bias the fuzzy search.

import { fuzzyMatch } from "./fuzzy";
import { CONTEXT_WINDOW, type AnchorSelectors } from "./model";
import {
  findQuoteMatches,
  normalizeQuote,
  normalizeQuoteKey,
  normalizeWithOffsets,
  type TextRange,
} from "./text";

export type AnchorState = "anchored" | "needs-review" | "orphaned";

// Confidence tiers (a tuning knob). Exact quote ⇒ 1.0. Blended fuzzy+context
// score ≥ ANCHORED ⇒ anchored; ≥ NEEDS_REVIEW ⇒ flagged; below ⇒ orphaned.
export const ANCHORED_THRESHOLD = 0.9;
export const NEEDS_REVIEW_THRESHOLD = 0.6;

export interface AnchorResolution {
  state: AnchorState;
  range?: TextRange; // resolved range over canonical text, when matched
  confidence?: number; // 0..1
  quote: string; // resolved text (anchored/needs-review) or last-known (orphaned)
  prefix?: string;
  suffix?: string;
  // Refreshed selectors for lazy self-healing, present when matched. The app may
  // persist these on the next state write so hints track the document; resolution
  // is recomputed at render regardless, so stale hints only mildly affect
  // fuzzy accuracy, never correctness.
  healed?: AnchorSelectors;
}

// Capture the full selector set for a concrete canonical-text range.
export function captureSelectors(canonicalText: string, range: TextRange): AnchorSelectors {
  const quote = normalizeQuote(canonicalText.slice(range.start, range.end));
  const prefix = normalizeQuote(canonicalText.slice(Math.max(0, range.start - CONTEXT_WINDOW), range.start));
  const suffix = normalizeQuote(canonicalText.slice(range.end, range.end + CONTEXT_WINDOW));
  return { quote, prefix, suffix, posStart: range.start, posEnd: range.end };
}

export type CaptureResult =
  | { ok: true; selectors: AnchorSelectors; range: TextRange }
  | { ok: false; reason: "empty" | "not-found" | "ambiguous" | "out-of-range"; count: number };

// Capture selectors from a bare quote (+ optional 1-based occurrence) — the
// agent/CLI entry point. `occurrence` is a transient disambiguation input only;
// it is resolved to concrete selectors here and never persisted.
export function captureSelectorsFromQuote(
  canonicalText: string,
  quote: string,
  occurrence?: number,
): CaptureResult {
  const key = normalizeQuoteKey(quote);
  if (!key) return { ok: false, reason: "empty", count: 0 };
  const matches = findQuoteMatches(canonicalText, quote);
  if (matches.length === 0) return { ok: false, reason: "not-found", count: 0 };
  if (occurrence !== undefined && (occurrence < 1 || occurrence > matches.length)) {
    return { ok: false, reason: "out-of-range", count: matches.length };
  }
  let range: TextRange;
  if (matches.length === 1) {
    range = matches[0]!;
  } else if (occurrence === undefined) {
    return { ok: false, reason: "ambiguous", count: matches.length };
  } else {
    range = matches[occurrence - 1]!;
  }
  return { ok: true, selectors: captureSelectors(canonicalText, range), range };
}

// Resolve an anchor against the current canonical text. The cascade:
//   1. Exact quote match — disambiguate duplicates by context + position. ⇒ 1.0.
//   2. On exact miss, fuzzy-match the quote near posStart and blend with
//      prefix/suffix agreement.
//   3. Classify by the resulting confidence; below NEEDS_REVIEW ⇒ orphaned.
export function resolveAnchor(canonicalText: string, anchor: AnchorSelectors): AnchorResolution {
  const key = normalizeQuoteKey(anchor.quote);
  if (!key) {
    return { state: "orphaned", quote: anchor.quote, prefix: anchor.prefix, suffix: anchor.suffix };
  }

  const exact = findQuoteMatches(canonicalText, anchor.quote);
  if (exact.length > 0) {
    const range = chooseExactMatch(canonicalText, anchor, exact);
    return matched(canonicalText, anchor, range, 1, "anchored");
  }

  const { normalized, offsets } = normalizeWithOffsets(canonicalText);
  const expectedNorm = originalToNormalized(offsets, anchor.posStart);
  const fuzzy = fuzzyMatch(normalized, key, expectedNorm);
  if (fuzzy.index === -1 || fuzzy.score <= 0) {
    return { state: "orphaned", quote: anchor.quote, prefix: anchor.prefix, suffix: anchor.suffix };
  }

  // Bitap reports a start location but not an extent; an edit inside the quote
  // makes the current text longer or shorter than the stored quote. Refine the
  // end by maximizing edit-distance similarity over a bounded window, which also
  // yields a cleaner confidence than the location-biased Bitap score.
  const extent = refineExtent(normalized, key, fuzzy.index);
  const start = offsets[fuzzy.index];
  const end = offsets[Math.min(extent.end, offsets.length - 1)];
  if (start === undefined || end === undefined || end <= start) {
    return { state: "orphaned", quote: anchor.quote, prefix: anchor.prefix, suffix: anchor.suffix };
  }

  const range: TextRange = { start, end };
  const context = contextScore(canonicalText, anchor, range);
  const confidence = blendConfidence(extent.ratio, context);
  const state: AnchorState =
    confidence >= ANCHORED_THRESHOLD
      ? "anchored"
      : confidence >= NEEDS_REVIEW_THRESHOLD
        ? "needs-review"
        : "orphaned";

  if (state === "orphaned") {
    return { state, quote: anchor.quote, prefix: anchor.prefix, suffix: anchor.suffix, confidence };
  }
  return matched(canonicalText, anchor, range, confidence, state);
}

function matched(
  canonicalText: string,
  anchor: AnchorSelectors,
  range: TextRange,
  confidence: number,
  state: AnchorState,
): AnchorResolution {
  const healed = captureSelectors(canonicalText, range);
  // Preserve the audit trail when the quoted text itself shifted: record the
  // earliest original quote so the change stays inspectable.
  if (normalizeQuoteKey(healed.quote) !== normalizeQuoteKey(anchor.quote)) {
    healed.originalQuote = anchor.originalQuote ?? anchor.quote;
  } else if (anchor.originalQuote) {
    healed.originalQuote = anchor.originalQuote;
  }
  return {
    state,
    range,
    confidence,
    quote: healed.quote,
    prefix: healed.prefix,
    suffix: healed.suffix,
    healed,
  };
}

// Among several exact occurrences, pick the one whose surrounding context and
// position best match the stored selectors.
function chooseExactMatch(
  canonicalText: string,
  anchor: AnchorSelectors,
  matches: TextRange[],
): TextRange {
  let best = matches[0]!;
  let bestScore = -Infinity;
  for (const range of matches) {
    const ctx = contextScore(canonicalText, anchor, range);
    const positionPenalty = positionAffinity(anchor.posStart, range.start);
    const score = ctx + positionPenalty;
    if (score > bestScore) {
      bestScore = score;
      best = range;
    }
  }
  return best;
}

// Similarity of the text surrounding `range` to the stored prefix/suffix, in
// [0, 1]. Neutral (0.75) when no context was stored, so an anchor without
// context isn't penalized.
function contextScore(canonicalText: string, anchor: AnchorSelectors, range: TextRange): number {
  const hasPrefix = anchor.prefix.length > 0;
  const hasSuffix = anchor.suffix.length > 0;
  if (!hasPrefix && !hasSuffix) return 0.75;

  const beforeRaw = canonicalText.slice(Math.max(0, range.start - CONTEXT_WINDOW * 2), range.start);
  const afterRaw = canonicalText.slice(range.end, range.end + CONTEXT_WINDOW * 2);
  const before = normalizeQuoteKey(beforeRaw);
  const after = normalizeQuoteKey(afterRaw);

  const scores: number[] = [];
  if (hasPrefix) scores.push(suffixOverlap(normalizeQuoteKey(anchor.prefix), before));
  if (hasSuffix) scores.push(prefixOverlap(normalizeQuoteKey(anchor.suffix), after));
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}

// Fraction of the stored prefix's tail that matches the document text's tail
// immediately before the quote (context aligns at the boundary).
function suffixOverlap(stored: string, actual: string): number {
  if (!stored) return 1;
  const max = Math.min(stored.length, actual.length);
  let common = 0;
  for (let i = 1; i <= max; i += 1) {
    if (stored[stored.length - i] === actual[actual.length - i]) common += 1;
    else break;
  }
  return common / stored.length;
}

// Fraction of the stored suffix's head matching the document text immediately
// after the quote.
function prefixOverlap(stored: string, actual: string): number {
  if (!stored) return 1;
  const max = Math.min(stored.length, actual.length);
  let common = 0;
  for (let i = 0; i < max; i += 1) {
    if (stored[i] === actual[i]) common += 1;
    else break;
  }
  return common / stored.length;
}

// Small bonus in [0, 0.25] for being near the stored position hint — only ever a
// tiebreaker, never enough to override real context disagreement.
function positionAffinity(expected: number, actual: number): number {
  const distance = Math.abs(expected - actual);
  return 0.25 * Math.exp(-distance / 500);
}

function blendConfidence(fuzzyScore: number, context: number): number {
  return Math.max(0, Math.min(1, 0.6 * fuzzyScore + 0.4 * context));
}

// Given an approximate start, find the end offset that maximizes edit-distance
// similarity between text[start:end] and the pattern, scanning a window that
// allows the match to be up to ~2x the pattern length (covers insertions) or as
// short as ~half (covers deletions).
function refineExtent(
  text: string,
  pattern: string,
  start: number,
): { end: number; ratio: number } {
  const minEnd = Math.min(text.length, start + Math.max(1, Math.floor(pattern.length * 0.5)));
  const maxEnd = Math.min(text.length, start + pattern.length * 2 + 8);
  // Bound cost for long quotes; they are rare and a coarser step is acceptable.
  const step = pattern.length > 120 ? 4 : 1;
  let bestEnd = Math.min(text.length, start + pattern.length);
  let bestRatio = 0;
  for (let end = minEnd; end <= maxEnd; end += step) {
    const ratio = levenshteinRatio(text.slice(start, end), pattern);
    if (ratio > bestRatio) {
      bestRatio = ratio;
      bestEnd = end;
    }
  }
  return { end: bestEnd, ratio: bestRatio };
}

function levenshteinRatio(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    const ai = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j += 1) {
      const cost = ai === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length]!;
}

// Map an original-text offset to the corresponding index in the normalized
// string (rightmost normalized index whose source offset is ≤ `offset`).
function originalToNormalized(offsets: number[], offset: number): number {
  if (offsets.length === 0) return 0;
  let lo = 0;
  let hi = offsets.length - 1;
  let result = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((offsets[mid] ?? 0) <= offset) {
      result = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return result;
}
