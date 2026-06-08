import { describe, expect, test } from "bun:test";
import {
  captureSelectors,
  captureSelectorsFromQuote,
  resolveAnchor,
} from "./anchor";
import { findQuoteMatches } from "./text";

// A small canonical-text fixture. Selectors are captured from this baseline,
// then resolved against edited variants to lock the three-state classification.
const BASE =
  "The team shipped the new dashboard last week. The dashboard loads quickly and the metrics are accurate. Users praised the redesign.";

function anchorFor(quote: string, occurrence?: number) {
  const result = captureSelectorsFromQuote(BASE, quote, occurrence);
  if (!result.ok) throw new Error(`capture failed: ${result.reason}`);
  return result.selectors;
}

describe("captureSelectorsFromQuote", () => {
  test("captures quote, prefix, suffix, and position for a unique quote", () => {
    const result = captureSelectorsFromQuote(BASE, "new dashboard");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.selectors.quote).toBe("new dashboard");
    expect(result.selectors.prefix.endsWith("shipped the")).toBe(true);
    expect(result.selectors.suffix.startsWith("last week")).toBe(true);
    expect(result.selectors.posStart).toBeGreaterThan(0);
  });

  test("ambiguous quote requires an occurrence", () => {
    const result = captureSelectorsFromQuote(BASE, "dashboard");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("ambiguous");
    expect(result.count).toBe(2);
  });

  test("occurrence selects the intended instance", () => {
    const first = captureSelectorsFromQuote(BASE, "dashboard", 1);
    const second = captureSelectorsFromQuote(BASE, "dashboard", 2);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.range.start).toBeGreaterThan(first.range.start);
  });

  test("out-of-range occurrence is rejected", () => {
    const result = captureSelectorsFromQuote(BASE, "dashboard", 5);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("out-of-range");
  });

  test("missing quote is not-found", () => {
    const result = captureSelectorsFromQuote(BASE, "nonexistent phrase");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("not-found");
  });
});

describe("resolveAnchor — exact", () => {
  test("unchanged text resolves exact with confidence 1", () => {
    const anchor = anchorFor("new dashboard");
    const resolution = resolveAnchor(BASE, anchor);
    expect(resolution.state).toBe("anchored");
    expect(resolution.confidence).toBe(1);
    expect(BASE.slice(resolution.range!.start, resolution.range!.end)).toBe("new dashboard");
  });

  test("disambiguates duplicates by context", () => {
    const second = anchorFor("dashboard", 2);
    const resolution = resolveAnchor(BASE, second);
    expect(resolution.state).toBe("anchored");
    // The second "dashboard" is preceded by "The " and followed by " loads".
    const after = BASE.slice(resolution.range!.end, resolution.range!.end + 6);
    expect(after).toBe(" loads");
  });
});

describe("resolveAnchor — edits", () => {
  test("edit elsewhere: anchor follows the shift, still exact", () => {
    const anchor = anchorFor("metrics are accurate");
    const edited = "An intro sentence was prepended here. " + BASE;
    const resolution = resolveAnchor(edited, anchor);
    expect(resolution.state).toBe("anchored");
    expect(edited.slice(resolution.range!.start, resolution.range!.end)).toBe("metrics are accurate");
  });

  test("small edit inside the quote: fuzzy + context re-anchors", () => {
    const anchor = anchorFor("loads quickly and the metrics are accurate");
    const edited = BASE.replace("loads quickly", "loads very quickly");
    const resolution = resolveAnchor(edited, anchor);
    expect(resolution.state === "anchored" || resolution.state === "needs-review").toBe(true);
    expect(resolution.range).toBeDefined();
    // The resolved quote now covers the edited text.
    expect(resolution.quote.includes("very")).toBe(true);
  });

  test("wholesale rewrite of the region orphans the anchor", () => {
    const anchor = anchorFor("metrics are accurate");
    const edited = BASE.replace(
      "The dashboard loads quickly and the metrics are accurate.",
      "We rebuilt the entire reporting pipeline from scratch overnight.",
    );
    const resolution = resolveAnchor(edited, anchor);
    expect(resolution.state).toBe("orphaned");
    expect(resolution.range).toBeUndefined();
    // Last-known quote is retained for display.
    expect(resolution.quote).toBe("metrics are accurate");
  });
});

describe("self-healing", () => {
  test("healed selectors track the new text and record the original quote", () => {
    const anchor = anchorFor("loads quickly");
    const edited = BASE.replace("loads quickly", "loads very quickly");
    const resolution = resolveAnchor(edited, anchor);
    expect(resolution.healed).toBeDefined();
    if (!resolution.healed) return;
    if (resolution.healed.quote !== anchor.quote) {
      expect(resolution.healed.originalQuote).toBe("loads quickly");
    }
  });

  test("captureSelectors round-trips a concrete range", () => {
    const range = findQuoteMatches(BASE, "redesign")[0]!;
    const selectors = captureSelectors(BASE, range);
    expect(selectors.quote).toBe("redesign");
    const resolution = resolveAnchor(BASE, selectors);
    expect(resolution.state).toBe("anchored");
  });
});
