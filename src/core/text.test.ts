import { describe, expect, test } from "bun:test";
import {
  findQuoteMatches,
  normalizeQuote,
  normalizeQuoteKey,
  normalizeWithOffsets,
} from "./text";

describe("normalizeWithOffsets", () => {
  test("collapses whitespace runs to one space and lowercases", () => {
    const { normalized } = normalizeWithOffsets("Hello   World\n\tThere");
    expect(normalized).toBe("hello world there");
  });

  test("offsets map back to original indices with a trailing length entry", () => {
    const text = "Ab";
    const { normalized, offsets } = normalizeWithOffsets(text);
    expect(normalized).toBe("ab");
    expect(offsets).toEqual([0, 1, 2]);
  });
});

describe("findQuoteMatches", () => {
  test("matches case-insensitively across collapsed whitespace", () => {
    const text = "The quick   brown fox";
    const matches = findQuoteMatches(text, "QUICK BROWN");
    expect(matches).toHaveLength(1);
    expect(text.slice(matches[0]!.start, matches[0]!.end)).toBe("quick   brown");
  });

  test("returns every occurrence in document order", () => {
    const text = "alpha beta alpha beta alpha";
    const matches = findQuoteMatches(text, "alpha");
    expect(matches).toHaveLength(3);
    expect(matches.map((m) => m.start)).toEqual([0, 11, 22]);
  });

  test("empty needle yields no matches", () => {
    expect(findQuoteMatches("anything", "   ")).toEqual([]);
  });
});

describe("normalizeQuote", () => {
  test("collapses and trims but preserves case", () => {
    expect(normalizeQuote("  Hello   World  ")).toBe("Hello World");
  });

  test("caps at 500 characters", () => {
    expect(normalizeQuote("x".repeat(600))).toHaveLength(500);
  });

  test("key form lowercases", () => {
    expect(normalizeQuoteKey("  Hello World ")).toBe("hello world");
  });
});
