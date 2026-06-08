import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendReply,
  applyAgentUpdate,
  createComment,
  deleteReply,
  deleteThread,
  editMessage,
  listAnchors,
  reanchor,
  readDocument,
  reconcileDocument,
  ConflictError,
  NotFoundError,
  AnchorError,
} from "./index";
import { agentCommentIndex, agentThread } from "./agent-reads";

const DOC = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Doc</title></head>
  <body>
    <h1>Quarterly review</h1>
    <p>The team shipped the new dashboard last week. The metrics are accurate.</p>
    <p>Users praised the redesign and asked for more charts.</p>
  </body>
</html>
`;

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "redline-app-"));
  file = path.join(dir, "doc.html");
  fs.writeFileSync(file, DOC, "utf8");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("createComment", () => {
  test("anchors to a unique quote and persists the block", () => {
    const view = createComment(file, { message: "Needs a source", quote: "new dashboard" });
    expect(view.threads).toHaveLength(1);
    expect(view.threads[0]!.anchor?.quote).toBe("new dashboard");
    expect(view.anchors[0]!.state).toBe("anchored");
    expect(fs.readFileSync(file, "utf8")).toContain('id="redline-state"');
  });

  test("defaults author to User, or AI for agents", () => {
    const browser = createComment(file, { message: "hi", quote: "redesign" });
    expect(browser.threads[0]!.author).toBe("User");
    const agent = createComment(file, { message: "hi", quote: "metrics" }, { defaultAuthor: "AI" });
    expect(agent.threads.at(-1)!.author).toBe("AI");
  });

  test("ambiguous quote is rejected", () => {
    expect(() => createComment(file, { message: "x", quote: "The" })).toThrow(AnchorError);
  });

  test("document-level comment when no quote", () => {
    const view = createComment(file, { message: "overall solid" });
    expect(view.threads[0]!.anchor).toBeUndefined();
    expect(view.anchors).toHaveLength(0);
  });

  test("accepts explicit selectors from the client", () => {
    const view = createComment(file, {
      message: "x",
      selectors: { quote: "metrics are accurate", prefix: "The", suffix: "", posStart: 70, posEnd: 90 },
    });
    expect(view.threads[0]!.anchor?.quote).toBe("metrics are accurate");
  });
});

describe("replies, edits, deletes", () => {
  test("reply / edit / delete-reply lifecycle", () => {
    let view = createComment(file, { message: "first", quote: "redesign" });
    const threadId = view.threads[0]!.id;
    view = appendReply(file, threadId, "second", { author: "Codex" });
    expect(view.threads[0]!.messages).toHaveLength(2);
    const replyId = view.threads[0]!.messages[1]!.id;
    view = editMessage(file, threadId, replyId, "second edited");
    expect(view.threads[0]!.messages[1]!.body).toBe("second edited");
    view = deleteReply(file, threadId, replyId);
    expect(view.threads[0]!.messages).toHaveLength(1);
  });

  test("cannot delete the original message as a reply", () => {
    const view = createComment(file, { message: "first", quote: "redesign" });
    const threadId = view.threads[0]!.id;
    const firstId = view.threads[0]!.messages[0]!.id;
    expect(() => deleteReply(file, threadId, firstId)).toThrow(AnchorError);
  });

  test("delete thread removes it and clears the block when empty", () => {
    const view = createComment(file, { message: "first", quote: "redesign" });
    const after = deleteThread(file, view.threads[0]!.id);
    expect(after.threads).toHaveLength(0);
    expect(fs.readFileSync(file, "utf8")).not.toContain('id="redline-state"');
  });

  test("missing thread / message raise NotFoundError", () => {
    expect(() => appendReply(file, "thread_missing0", "x")).toThrow(NotFoundError);
    const view = createComment(file, { message: "x", quote: "redesign" });
    expect(() => editMessage(file, view.threads[0]!.id, "message_missing", "y")).toThrow(NotFoundError);
  });
});

describe("content is never mutated", () => {
  test("body bytes are unchanged; only head gains the marker + block", () => {
    const canonicalBefore = readDocument(file).canonicalText;
    createComment(file, { message: "x", quote: "redesign" });
    const written = fs.readFileSync(file, "utf8");
    const body = (s: string) => s.slice(s.indexOf("<body"), s.indexOf("</body>"));
    expect(body(written)).toBe(body(DOC));
    // Canonical text (what anchoring sees) is identical before and after the
    // write — the comment touched only the head's marker + state block.
    expect(readDocument(file).canonicalText).toBe(canonicalBefore);
    expect(written).toContain('id="redline-state"');
    expect(written).toContain('name="redline-agent-guide"');
  });
});

describe("reconcile + reanchor after external edits", () => {
  test("edit elsewhere keeps the anchor; rewrite orphans it", () => {
    const view = createComment(file, { message: "x", quote: "metrics are accurate" });
    const threadId = view.threads[0]!.id;

    // Simulate the agent editing content directly: prepend a sentence.
    const edited = fs
      .readFileSync(file, "utf8")
      .replace("<h1>Quarterly review</h1>", "<h1>Quarterly review</h1>\n    <p>New intro paragraph added.</p>");
    fs.writeFileSync(file, edited, "utf8");
    expect(readDocument(file).anchors[0]!.state).toBe("anchored");

    // Now rewrite the anchored region entirely → orphaned.
    const rewritten = fs
      .readFileSync(file, "utf8")
      .replace("The metrics are accurate.", "We rebuilt the whole reporting pipeline overnight.");
    fs.writeFileSync(file, rewritten, "utf8");
    const report = listAnchors(file);
    expect(report.anchors[0]!.state).toBe("orphaned");

    // Re-anchor to the new text.
    const reanchored = reanchor(file, threadId, "reporting pipeline");
    expect(reanchored.anchors[0]!.state).toBe("anchored");
  });

  test("reconcileDocument heals hints without bumping updatedAt", () => {
    const view = createComment(file, { message: "x", quote: "metrics are accurate" });
    const before = view.updatedAt;
    const edited = fs
      .readFileSync(file, "utf8")
      .replace("The metrics are accurate", "The metrics are very accurate");
    fs.writeFileSync(file, edited, "utf8");
    const { view: healedView, healed } = reconcileDocument(file);
    expect(healed).toBe(true);
    expect(healedView.updatedAt).toBe(before);
  });
});

describe("merge-on-write (no expectedVersion)", () => {
  test("a comment added between read and a self-heal write is not dropped", () => {
    // Seed two threads, then orphan-free edit elsewhere so reconcile heals hints.
    createComment(file, { message: "first", quote: "metrics are accurate" });
    const second = createComment(file, { message: "second", quote: "redesign" });
    expect(second.threads).toHaveLength(2);

    // External content edit shifts positions so reconcile will want to heal.
    fs.writeFileSync(
      file,
      fs.readFileSync(file, "utf8").replace("Quarterly review", "Q3 quarterly review"),
      "utf8",
    );
    const { view } = reconcileDocument(file);
    // Both threads survive the self-heal write.
    expect(view.threads).toHaveLength(2);
  });

  test("agent batch and a direct comment both land (id-keyed merge)", () => {
    const seed = createComment(file, { message: "seed", quote: "redesign" });
    const update = applyAgentUpdate(file, {
      comments: [{ quote: "metrics are accurate", body: "from agent" }],
    });
    expect(update.threads).toHaveLength(2);
    expect(update.threads.some((t) => t.id === seed.threads[0]!.id)).toBe(true);
  });
});

describe("optimistic concurrency", () => {
  test("stale expectedVersion raises ConflictError with the current view", () => {
    const view = createComment(file, { message: "x", quote: "redesign" });
    expect(() =>
      createComment(file, { message: "y", quote: "metrics", expectedVersion: "deadbeef" }),
    ).toThrow(ConflictError);
    // A correct version succeeds.
    const ok = createComment(file, { message: "y", quote: "metrics", expectedVersion: view.version });
    expect(ok.threads).toHaveLength(2);
  });
});

describe("agent batch + reads", () => {
  test("applyAgentUpdate creates, replies, reanchors, and deletes atomically", () => {
    const seed = createComment(file, { message: "seed", quote: "redesign" });
    const threadId = seed.threads[0]!.id;
    const view = applyAgentUpdate(file, {
      comments: [{ quote: "metrics are accurate", body: "verify this", author: "Codex" }],
      replies: [{ threadId, body: "ack", author: "Codex" }],
    });
    expect(view.threads).toHaveLength(2);
    const seedThread = view.threads.find((t) => t.id === threadId)!;
    expect(seedThread.messages).toHaveLength(2);
  });

  test("agentCommentIndex filters by since and reports anchor state", () => {
    createComment(file, { message: "x", quote: "redesign" });
    const index = agentCommentIndex(file);
    expect(index.threads).toHaveLength(1);
    expect(index.threads[0]!.state).toBe("anchored");
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(agentCommentIndex(file, future).threads).toHaveLength(0);
  });

  test("agentThread returns one full thread or throws", () => {
    const view = createComment(file, { message: "x", quote: "redesign" });
    const thread = agentThread(file, view.threads[0]!.id);
    expect(thread.messages[0]!.body).toBe("x");
    expect(() => agentThread(file, "thread_missing0")).toThrow(NotFoundError);
  });
});
