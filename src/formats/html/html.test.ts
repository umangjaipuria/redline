import { describe, expect, test } from "bun:test";
import { SCHEMA_VERSION, emptyState, normalizeThread, type EmbeddedState } from "../../core/model";
import { MalformedStateError } from "../types";
import { htmlAdapter } from "./index";

const DOC = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Sample</title>
    <style>.x { color: red }</style>
  </head>
  <body>
    <h1>Heading</h1>
    <p>The quick brown fox jumps over the lazy dog.</p>
    <p>Second paragraph with &amp; an entity.</p>
    <script>console.log("should be ignored")</script>
  </body>
</html>
`;

function stateWith(threads = 1): EmbeddedState {
  const state = emptyState();
  state.updatedAt = "2024-01-01T00:00:00.000Z";
  for (let i = 0; i < threads; i += 1) {
    state.threads.push(
      normalizeThread({
        id: `thread_fixture${i}aaaa`,
        anchor: { quote: "quick brown", prefix: "the", suffix: "fox", posStart: 4, posEnd: 15 },
        messages: [{ author: "User", body: "note", createdAt: "2024-01-01T00:00:00.000Z" }],
      }),
    );
  }
  return state;
}

describe("extractText", () => {
  test("returns body text with block boundaries and decoded entities, excluding script/style", () => {
    const text = htmlAdapter.extractText(DOC);
    expect(text).toContain("Heading");
    expect(text).toContain("The quick brown fox jumps over the lazy dog.");
    expect(text).toContain("Second paragraph with & an entity.");
    expect(text).not.toContain("console.log");
    expect(text).not.toContain("color: red");
  });
});

describe("render", () => {
  test("strips scripts and surfaces the title", () => {
    const view = htmlAdapter.render(DOC);
    expect(view.title).toBe("Sample");
    expect(view.html).not.toContain("<script");
    expect(view.html).toContain("The quick brown fox");
  });

  test("removes inline event handlers and javascript: urls", () => {
    const dirty = `<body><a href="javascript:alert(1)" onclick="steal()">x</a></body>`;
    const view = htmlAdapter.render(dirty);
    expect(view.html).not.toContain("onclick");
    expect(view.html).not.toContain("javascript:");
  });

  test("strips nested frames, plugins, and author base tags", () => {
    const dirty =
      `<body><iframe src="http://evil"></iframe><object data="x.swf"></object>` +
      `<embed src="y"><base href="http://evil/"><meta http-equiv="refresh" content="0;url=http://evil"></body>`;
    const view = htmlAdapter.render(dirty);
    expect(view.html).not.toMatch(/<iframe|<object|<embed|<base|http-equiv/i);
  });
});

describe("readState / writeState round-trip", () => {
  test("writes the block in head and reads it back", () => {
    const written = htmlAdapter.writeState(DOC, stateWith(1));
    expect(written).toContain('id="redline-state"');
    expect(written).toContain('name="redline-agent-guide"');
    const read = htmlAdapter.readState(written);
    expect(read?.schemaVersion).toBe(SCHEMA_VERSION);
    expect(read?.threads).toHaveLength(1);
    expect(read?.threads[0]!.anchor?.quote).toBe("quick brown");
  });

  test("content outside the block is byte-identical except marker + block", () => {
    const written = htmlAdapter.writeState(DOC, stateWith(1));
    // Removing exactly the marker and the block should return the original.
    const stripped = written
      .replace(/\s*<meta name="redline-agent-guide"[^>]*>/i, "")
      .replace(/\s*<script type="application\/json" id="redline-state">[\s\S]*?<\/script>/i, "");
    expect(stripped).toBe(DOC);
  });

  test("empty state removes the block entirely", () => {
    const written = htmlAdapter.writeState(DOC, stateWith(1));
    const cleared = htmlAdapter.writeState(written, emptyState());
    expect(cleared).not.toContain('id="redline-state"');
    expect(htmlAdapter.readState(cleared)).toBeNull();
  });

  test("escapes < in the payload so it cannot break out of the script", () => {
    const state = stateWith(0);
    state.threads.push(
      normalizeThread({
        id: "thread_escapetest1",
        messages: [{ author: "User", body: "danger </script><script>alert(1)</script>" }],
      }),
    );
    const written = htmlAdapter.writeState(DOC, state);
    expect(written).not.toContain("</script><script>alert(1)");
    expect(written).toContain("\\u003c");
    // Still parses back to the original body.
    const read = htmlAdapter.readState(written);
    expect(read?.threads[0]!.messages[0]!.body).toContain("alert(1)");
  });

  test("no block present reads as null", () => {
    expect(htmlAdapter.readState(DOC)).toBeNull();
  });

  test("malformed block throws", () => {
    const broken = DOC.replace(
      "</head>",
      '<script type="application/json" id="redline-state">{ not json </script></head>',
    );
    expect(() => htmlAdapter.readState(broken)).toThrow(MalformedStateError);
  });

  test("unknown schema version throws", () => {
    const wrong = DOC.replace(
      "</head>",
      '<script type="application/json" id="redline-state">{"schemaVersion":999,"threads":[]}</script></head>',
    );
    expect(() => htmlAdapter.readState(wrong)).toThrow(MalformedStateError);
  });

  test("replacing the block does not duplicate it", () => {
    const once = htmlAdapter.writeState(DOC, stateWith(1));
    const twice = htmlAdapter.writeState(once, stateWith(2));
    expect(twice.match(/id="redline-state"/g)).toHaveLength(1);
    expect(twice.match(/name="redline-agent-guide"/g)).toHaveLength(1);
    expect(htmlAdapter.readState(twice)?.threads).toHaveLength(2);
  });
});
