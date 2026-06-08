import { describe, expect, test } from "bun:test";
import { fuzzyMatch } from "./fuzzy";

// Lock the matcher's behavior with known edits → expected location/score, so
// thresholds downstream are tuned against stable ground truth.
describe("fuzzyMatch", () => {
  test("exact substring scores 1 at its location", () => {
    const text = "the quick brown fox jumps";
    const result = fuzzyMatch(text, "brown fox", text.indexOf("brown"));
    expect(result.index).toBe(text.indexOf("brown fox"));
    expect(result.score).toBe(1);
  });

  test("single-character edit still matches with high score", () => {
    const text = "the quick brown fox jumps";
    const result = fuzzyMatch(text, "brawn fox", 10);
    expect(result.index).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeGreaterThan(0.8);
  });

  test("unrelated pattern returns a low or no match", () => {
    const text = "the quick brown fox jumps";
    const result = fuzzyMatch(text, "zzzzzzzzzz", 0);
    expect(result.score).toBeLessThan(0.6);
  });

  test("empty pattern is no match", () => {
    expect(fuzzyMatch("anything", "", 0)).toEqual({ index: -1, score: 0 });
  });

  test("identical text and pattern scores 1", () => {
    expect(fuzzyMatch("hello", "hello", 0)).toEqual({ index: 0, score: 1 });
  });

  test("location bias picks the nearer of two identical candidates", () => {
    const text = "match here ... filler ... match here";
    const near = fuzzyMatch(text, "match here", 0);
    const far = fuzzyMatch(text, "match here", text.length);
    expect(near.index).toBe(0);
    expect(far.index).toBe(text.lastIndexOf("match here"));
  });
});
