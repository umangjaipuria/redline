import { describe, expect, test } from "bun:test";
import {
  normalizeAnchor,
  normalizeAuthor,
  normalizeBody,
  normalizeState,
  normalizeThread,
  SCHEMA_VERSION,
  summarize,
  UnknownSchemaError,
} from "./model";

describe("author and body normalization", () => {
  test("blank author falls back", () => {
    expect(normalizeAuthor("")).toBe("User");
    expect(normalizeAuthor("   ", "AI")).toBe("AI");
    expect(normalizeAuthor("Codex")).toBe("Codex");
  });

  test("empty body throws", () => {
    expect(() => normalizeBody("   ", "Body required.")).toThrow("Body required.");
    expect(normalizeBody("  hello ", "x")).toBe("hello");
  });
});

describe("normalizeAnchor", () => {
  test("returns undefined without a quote", () => {
    expect(normalizeAnchor({ prefix: "x" })).toBeUndefined();
    expect(normalizeAnchor(null)).toBeUndefined();
  });

  test("normalizes fields and clamps positions", () => {
    const anchor = normalizeAnchor({
      quote: "  the  quote ",
      prefix: " before ",
      suffix: " after ",
      posStart: -5,
      posEnd: 12.7,
    });
    expect(anchor).toEqual({
      quote: "the quote",
      prefix: "before",
      suffix: "after",
      posStart: 0,
      posEnd: 12,
    });
  });
});

describe("normalizeThread", () => {
  test("generates ids and preserves messages", () => {
    const thread = normalizeThread({
      messages: [{ author: "User", body: "Hi", createdAt: "2020-01-01T00:00:00.000Z" }],
    });
    expect(thread.id.startsWith("thread_")).toBe(true);
    expect(thread.messages[0]!.id.startsWith("message_")).toBe(true);
    expect(thread.messages[0]!.body).toBe("Hi");
  });

  test("keeps a valid supplied id and rejects a malformed one", () => {
    const valid = normalizeThread({ id: "thread_abc123", messages: [] });
    expect(valid.id).toBe("thread_abc123");
    const invalid = normalizeThread({ id: "not-a-thread", messages: [] });
    expect(invalid.id.startsWith("thread_")).toBe(true);
    expect(invalid.id).not.toBe("not-a-thread");
  });
});

describe("normalizeState", () => {
  test("accepts the current schema version", () => {
    const state = normalizeState({ schemaVersion: SCHEMA_VERSION, threads: [] });
    expect(state.schemaVersion).toBe(SCHEMA_VERSION);
  });

  test("rejects an unknown schema version", () => {
    expect(() => normalizeState({ schemaVersion: 99, threads: [] })).toThrow(UnknownSchemaError);
  });

  test("missing schemaVersion is treated as current", () => {
    const state = normalizeState({ threads: [] });
    expect(state.schemaVersion).toBe(SCHEMA_VERSION);
  });
});

describe("summarize", () => {
  test("counts threads and messages", () => {
    const summary = summarize([
      normalizeThread({ messages: [{ body: "a" }, { body: "b" }] }),
      normalizeThread({ messages: [{ body: "c" }] }),
    ]);
    expect(summary).toEqual({ threads: 2, messages: 3 });
  });
});
