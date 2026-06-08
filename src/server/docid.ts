// Random, ephemeral docIds: doc_ + three words drawn (via crypto.getRandomValues)
// from the curated wordlist. Recognizable in URLs and logs, zero dependency.
// Collisions are resolved by regenerating against a caller-supplied "is taken?"
// predicate, so correctness never depends on entropy. Ids are NOT stable across
// server restarts — by design; the durable reference is the file path.

import { WORDLIST } from "./wordlist";

const PREFIX = "doc_";

export function generateDocId(isTaken: (candidate: string) => boolean): string {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const candidate = `${PREFIX}${pickWord()}-${pickWord()}-${pickWord()}`;
    if (!isTaken(candidate)) return candidate;
  }
  // Astronomically unlikely with a 130-word list and a path-keyed index; fall
  // back to a 4th word rather than ever looping forever.
  return `${PREFIX}${pickWord()}-${pickWord()}-${pickWord()}-${pickWord()}`;
}

export function isDocId(value: string): boolean {
  return /^doc_[a-z]+(?:-[a-z]+){2,3}$/.test(value);
}

function pickWord(): string {
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  const index = buffer[0]! % WORDLIST.length;
  return WORDLIST[index]!;
}
