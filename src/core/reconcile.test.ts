import { describe, expect, test } from "bun:test";
import { captureSelectorsFromQuote } from "./anchor";
import { normalizeThread, type Thread } from "./model";
import { reconcile, statusesInRange } from "./reconcile";

const BASE =
  "The team shipped the new dashboard last week. The metrics are accurate. Users praised the redesign.";

function threadWithQuote(quote: string, occurrence?: number): Thread {
  const capture = captureSelectorsFromQuote(BASE, quote, occurrence);
  if (!capture.ok) throw new Error("capture failed");
  return normalizeThread({
    id: "thread_" + quote.replace(/\W+/g, "").slice(0, 12).padEnd(4, "x"),
    anchor: capture.selectors,
    messages: [{ author: "User", body: "comment on " + quote }],
  });
}

describe("reconcile", () => {
  test("classifies anchored, needs-review, and orphaned together", () => {
    const anchored = threadWithQuote("metrics are accurate");
    const orphaned = threadWithQuote("new dashboard");
    const edited = BASE.replace("the new dashboard last week", "a brand new analytics surface yesterday");
    const result = reconcile(edited, [anchored, orphaned]);

    const byId = new Map(result.statuses.map((s) => [s.threadId, s]));
    expect(byId.get(anchored.id)!.state).toBe("anchored");
    expect(byId.get(orphaned.id)!.state).toBe("orphaned");
  });

  test("never mutates thread bodies, only anchors", () => {
    const thread = threadWithQuote("metrics are accurate");
    const original = JSON.stringify(thread.messages);
    const edited = BASE.replace("metrics are accurate", "metrics are highly accurate");
    const result = reconcile(edited, [thread]);
    expect(JSON.stringify(result.healedThreads[0]!.messages)).toBe(original);
  });

  test("is idempotent on unchanged text", () => {
    const thread = threadWithQuote("redesign");
    const a = reconcile(BASE, [thread]);
    const b = reconcile(BASE, [thread]);
    expect(JSON.stringify(a.statuses)).toBe(JSON.stringify(b.statuses));
    expect(a.changed).toBe(false);
  });

  test("document-level threads get no anchor status", () => {
    const general = normalizeThread({ id: "thread_general1", messages: [{ body: "overall note" }] });
    const result = reconcile(BASE, [general]);
    expect(result.statuses).toHaveLength(0);
    expect(result.healedThreads).toHaveLength(1);
  });

  test("statusesInRange filters by overlap", () => {
    const thread = threadWithQuote("redesign");
    const { statuses } = reconcile(BASE, [thread]);
    const range = statuses[0]!.range!;
    expect(statusesInRange(statuses, range)).toHaveLength(1);
    expect(statusesInRange(statuses, { start: 0, end: 5 })).toHaveLength(0);
  });
});
