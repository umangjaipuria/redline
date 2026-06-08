// A small, dependency-free fuzzy text matcher vendored into core, in the spirit
// of diff-match-patch's `match_main` (Bitap algorithm). It locates the best
// approximate occurrence of a pattern within a text near an expected location
// and reports both the index and a normalized similarity in [0, 1] (1 = exact).
//
// This is the engine behind the anchor resolution cascade: on an exact-quote
// miss, we fuzzy-match the quote to find where the edited text now sits. Its
// behavior is locked by fixture tests (known edits → expected match/score) so
// thresholds are tuned against stable ground truth, not folklore.

// Tunable knobs — defaults mirror diff-match-patch.
export interface FuzzyOptions {
  // How far (in characters) a match may drift from the expected location before
  // the distance penalty dominates. Larger = location matters less.
  distance: number;
  // Maximum pattern length the Bitap bitmask path supports (32 on 32-bit ints).
  maxBits: number;
}

export const DEFAULT_FUZZY_OPTIONS: FuzzyOptions = {
  distance: 1000,
  maxBits: 32,
};

export interface FuzzyMatch {
  index: number; // start index of the best match in `text`, or -1 if none viable
  score: number; // similarity in [0, 1]; 1 = exact, 0 = no usable match
}

// Find the best approximate match of `pattern` in `text` near `expectedLoc`.
// Returns the start index and a similarity score. A `score` of 0 means no match
// was found within the viable error budget; callers classify by score tier.
export function fuzzyMatch(
  text: string,
  pattern: string,
  expectedLoc: number,
  options: Partial<FuzzyOptions> = {},
): FuzzyMatch {
  const { distance, maxBits } = { ...DEFAULT_FUZZY_OPTIONS, ...options };

  if (pattern.length === 0) return { index: -1, score: 0 };
  if (text === pattern) return { index: 0, score: 1 };
  if (text.length === 0) return { index: -1, score: 0 };

  const loc = Math.max(0, Math.min(expectedLoc, text.length));

  // Exact match at the expected location wins outright.
  if (text.substring(loc, loc + pattern.length) === pattern) {
    return { index: loc, score: 1 };
  }

  // Bitap is bounded by the machine word size. For longer patterns, fall back to
  // an n-gram similarity over the closest exact-substring anchor so the matcher
  // still degrades gracefully instead of throwing.
  if (pattern.length > maxBits) {
    return longPatternMatch(text, pattern, loc, distance);
  }

  return bitapMatch(text, pattern, loc, distance, maxBits);
}

// diff-match-patch's match_bitap, adapted to also surface the similarity score
// of the winning location (1 - bestError, where bestError is the normalized
// Bitap score at that location).
function bitapMatch(
  text: string,
  pattern: string,
  loc: number,
  distance: number,
  maxBits: number,
): FuzzyMatch {
  const matchmask = 1 << (pattern.length - 1);
  const alphabet = patternAlphabet(pattern, maxBits);

  // Walk the error count up from 0; the first error level that yields any match
  // within the score floor is necessarily the best (fewest edits).
  let scoreThreshold = 1.0;
  let bestLoc = -1;

  const matchScore = (errors: number, location: number): number => {
    const accuracy = errors / pattern.length;
    const proximity = Math.abs(loc - location);
    if (distance === 0) {
      return proximity ? 1.0 : accuracy;
    }
    return accuracy + proximity / distance;
  };

  // Seed the threshold with any exact-ish occurrences around `loc`.
  let bestExact = text.indexOf(pattern, loc);
  if (bestExact !== -1) {
    scoreThreshold = Math.min(matchScore(0, bestExact), scoreThreshold);
    bestExact = text.lastIndexOf(pattern, loc + pattern.length);
    if (bestExact !== -1) {
      scoreThreshold = Math.min(matchScore(0, bestExact), scoreThreshold);
    }
  }

  let binMax = pattern.length + text.length;
  let lastRd: number[] = [];
  let finalError = pattern.length;

  for (let errorCount = 0; errorCount < pattern.length; errorCount += 1) {
    // Tighten the search width to locations whose score could beat the best.
    let binMin = 0;
    let binMid = binMax;
    while (binMin < binMid) {
      if (matchScore(errorCount, loc + binMid) <= scoreThreshold) {
        binMin = binMid;
      } else {
        binMax = binMid;
      }
      binMid = Math.floor((binMax - binMin) / 2 + binMin);
    }
    binMax = binMid;
    let start = Math.max(1, loc - binMid + 1);
    const finish = Math.min(loc + binMid, text.length) + pattern.length;

    const rd = new Array<number>(finish + 2);
    rd[finish + 1] = (1 << errorCount) - 1;
    for (let j = finish; j >= start; j -= 1) {
      const charMatch = alphabet[text.charAt(j - 1)] ?? 0;
      if (errorCount === 0) {
        rd[j] = ((rd[j + 1]! << 1) | 1) & charMatch;
      } else {
        rd[j] =
          (((rd[j + 1]! << 1) | 1) & charMatch) |
          (((lastRd[j + 1]! | lastRd[j]!) << 1) | 1) |
          lastRd[j + 1]!;
      }
      if (rd[j]! & matchmask) {
        const score = matchScore(errorCount, j - 1);
        if (score <= scoreThreshold) {
          scoreThreshold = score;
          bestLoc = j - 1;
          finalError = errorCount;
          if (bestLoc > loc) {
            start = Math.max(1, 2 * loc - bestLoc);
          } else {
            break;
          }
        }
      }
    }
    // No hope of a better match at the next error level.
    if (matchScore(errorCount + 1, loc) > scoreThreshold) {
      break;
    }
    lastRd = rd;
  }

  if (bestLoc === -1) return { index: -1, score: 0 };
  // Similarity from edit fraction only (location bias is a search aid, not a
  // quality measure): 1 - errors/patternLength.
  const similarity = Math.max(0, 1 - finalError / pattern.length);
  return { index: bestLoc, score: similarity };
}

function patternAlphabet(pattern: string, maxBits: number): Record<string, number> {
  const alphabet: Record<string, number> = {};
  for (let i = 0; i < pattern.length; i += 1) {
    alphabet[pattern.charAt(i)] = 0;
  }
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern.charAt(i);
    alphabet[char] = (alphabet[char] ?? 0) | (1 << (pattern.length - i - 1));
  }
  return alphabet;
}

// Fallback for patterns longer than the Bitap word size: slide a window and
// score by a character-bigram Dice coefficient, biased toward `loc`. Coarser
// than Bitap but monotonic and bounded, which is all the cascade needs for long
// quotes (they are rare and usually still have a strong exact anchor).
function longPatternMatch(
  text: string,
  pattern: string,
  loc: number,
  distance: number,
): FuzzyMatch {
  const patternGrams = bigrams(pattern);
  let bestScore = 0;
  let bestIndex = -1;
  const step = Math.max(1, Math.floor(pattern.length / 8));
  for (let i = 0; i + 1 < text.length; i += step) {
    const window = text.substring(i, i + pattern.length);
    const sim = diceCoefficient(patternGrams, bigrams(window));
    const proximityPenalty = distance === 0 ? 0 : Math.abs(loc - i) / (distance * 4);
    const adjusted = sim - proximityPenalty;
    if (adjusted > bestScore) {
      bestScore = adjusted;
      bestIndex = i;
    }
  }
  if (bestIndex === -1) return { index: -1, score: 0 };
  return { index: bestIndex, score: Math.max(0, Math.min(1, bestScore)) };
}

function bigrams(value: string): Map<string, number> {
  const grams = new Map<string, number>();
  for (let i = 0; i + 1 < value.length; i += 1) {
    const gram = value.substring(i, i + 2);
    grams.set(gram, (grams.get(gram) ?? 0) + 1);
  }
  return grams;
}

function diceCoefficient(a: Map<string, number>, b: Map<string, number>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let overlap = 0;
  for (const [gram, countA] of a) {
    const countB = b.get(gram);
    if (countB) overlap += Math.min(countA, countB);
  }
  const total = sum(a) + sum(b);
  return total === 0 ? 0 : (2 * overlap) / total;
}

function sum(map: Map<string, number>): number {
  let total = 0;
  for (const count of map.values()) total += count;
  return total;
}
