import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendReply,
  applyAgentUpdate,
  createComment,
  deleteReply,
  defaultDocumentPath,
  ensureDocument,
  legacySidecarPathFor,
  openDocumentForReview,
  readCommentState,
  readDocumentState,
  readDocumentFileState,
  repairDocumentAnchors,
  resolveDocumentPath,
  resolveThread,
  sidecarPathFor,
  updateCommentMessage,
  writeSidecar,
  writeDocumentHtml,
} from "./state";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDocument() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "redline-"));
  tempDirs.push(dir);
  const documentPath = path.join(dir, "draft.html");
  fs.writeFileSync(documentPath, "<!doctype html><html><body><p>Hello world.</p></body></html>");
  return documentPath;
}

test("resolves default and explicit document paths", () => {
  const cwd = path.join(os.tmpdir(), "workspace");

  expect(defaultDocumentPath(cwd)).toBe(path.join(cwd, "documents", "howto.html"));
  expect(resolveDocumentPath(undefined, cwd)).toBe(path.join(cwd, "documents", "howto.html"));
  expect(resolveDocumentPath("docs/draft.html", cwd)).toBe(path.join(cwd, "docs/draft.html"));
  expect(resolveDocumentPath("   ", cwd)).toBe(path.join(cwd, "documents", "howto.html"));
  expect(resolveDocumentPath("/tmp/draft.html", cwd)).toBe("/tmp/draft.html");
});

test("creates a default document when one is missing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "redline-"));
  tempDirs.push(dir);
  const documentPath = path.join(dir, "nested", "missing.html");

  ensureDocument(documentPath);

  const html = fs.readFileSync(documentPath, "utf8");
  expect(html).toContain("<h1>Redline sample</h1>");
  expect(readDocumentState(documentPath).summary).toEqual({
    threads: 0,
    messages: 0,
    unresolved: 0,
  });
});

test("opening a document for review adds an agent discovery marker", () => {
  const documentPath = tempDocument();
  fs.writeFileSync(
    documentPath,
    "<!doctype html><html><head><title>Draft</title></head><body><p>Hello world.</p></body></html>",
  );

  const opened = openDocumentForReview(documentPath);
  const html = fs.readFileSync(documentPath, "utf8");

  expect(opened.html).toContain('name="redline-agent-guide"');
  expect(html).toContain('name="redline-agent-guide"');
  expect(html).toContain("use the redline-review skill");

  openDocumentForReview(documentPath);
  const afterSecondOpen = fs.readFileSync(documentPath, "utf8");
  expect(afterSecondOpen.match(/name="redline-agent-guide"/g)?.length).toBe(1);
});

test("opening a fragment for review adds an agent discovery comment", () => {
  const documentPath = tempDocument();
  fs.writeFileSync(documentPath, "<p>Hello world.</p>");

  const opened = openDocumentForReview(documentPath);

  expect(opened.html.startsWith("<!-- redline-agent-guide:")).toBe(true);
  expect(opened.html).toContain("data-redline-anchor spans");
});

test("creates, replies to, and resolves comment threads", () => {
  const documentPath = tempDocument();
  const withComment = createComment(documentPath, {
    body: "Tighten this sentence.",
    author: "User",
    quote: "Hello world.",
    anchor: {
      type: "text-range",
      quote: "Hello world.",
    },
  });

  expect(withComment.threads).toHaveLength(1);
  const threadId = withComment.threads[0]?.id ?? "";

  const withReply = appendReply(documentPath, threadId, "Updated the paragraph.", "  ");
  expect(withReply.threads[0]?.messages).toHaveLength(2);
  expect(withReply.threads[0]?.messages.at(-1)?.author).toBe("AI");
  expect(fs.readFileSync(documentPath, "utf8")).toContain('id="redline-state"');

  const resolved = resolveThread(documentPath, threadId);
  expect(resolved.threads).toHaveLength(0);
  expect(fs.readFileSync(documentPath, "utf8")).not.toContain('id="redline-state"');
  expect(fs.existsSync(sidecarPathFor(documentPath))).toBe(false);
});

test("text-range comments insert durable inline anchors", () => {
  const documentPath = tempDocument();
  const withComment = createComment(documentPath, {
    body: "Tighten this sentence.",
    author: "User",
    quote: "Hello world.",
    anchor: {
      type: "text-range",
      quote: "Hello world.",
    },
  });
  const threadId = withComment.threads[0]?.id ?? "";

  expect(withComment.threads[0]?.anchor.anchorId).toBe(threadId);
  expect(fs.readFileSync(documentPath, "utf8")).toContain(
    `<span data-redline-anchor="${threadId}">Hello world.</span>`,
  );
});

test("text-range comments use explicit anchor ids as thread ids", () => {
  const documentPath = tempDocument();
  const withComment = createComment(documentPath, {
    body: "Tighten this sentence.",
    author: "User",
    quote: "Hello world.",
    anchor: {
      type: "text-range",
      anchorId: "thread_anchor_supplied",
      quote: "Hello world.",
    },
  });

  expect(withComment.threads[0]?.id).toBe("thread_anchor_supplied");
  expect(withComment.threads[0]?.anchor.anchorId).toBe("thread_anchor_supplied");
  expect(withComment.html).toContain(
    '<span data-redline-anchor="thread_anchor_supplied">Hello world.</span>',
  );
});

test("text-range comments reject mismatched thread and anchor ids", () => {
  const documentPath = tempDocument();

  expect(() =>
    createComment(documentPath, {
      threadId: "thread_outer",
      body: "Mismatched ids.",
      quote: "Hello world.",
      anchor: {
        type: "text-range",
        anchorId: "thread_inner",
        quote: "Hello world.",
      },
    }),
  ).toThrow("threadId and anchor.anchorId must match");
});

test("text-range comments reject unmappable quotes instead of saving spanless anchors", () => {
  const documentPath = tempDocument();

  expect(() =>
    createComment(documentPath, {
      body: "Missing target.",
      quote: "Missing target text.",
      anchor: {
        type: "text-range",
        quote: "Missing target text.",
      },
    }),
  ).toThrow("Quoted text was not found in the document body.");
});

test("bare text-range comments require an occurrence when the quote repeats", () => {
  const documentPath = tempDocument();
  fs.writeFileSync(
    documentPath,
    "<!doctype html><html><body><p>Hello world.</p><p>Hello world.</p></body></html>",
  );

  expect(() =>
    createComment(documentPath, {
      body: "Ambiguous target.",
      quote: "Hello world.",
      anchor: {
        type: "text-range",
        quote: "Hello world.",
      },
    }),
  ).toThrow("Quoted text appears 2 times");
});

test("text-range comments anchor the requested occurrence of a repeated quote", () => {
  const documentPath = tempDocument();
  fs.writeFileSync(
    documentPath,
    "<!doctype html><html><body><p>Hello world.</p><p>Hello world.</p></body></html>",
  );

  const withComment = createComment(documentPath, {
    threadId: "thread_second_match",
    body: "Second one.",
    quote: "Hello world.",
    anchor: {
      type: "text-range",
      quote: "Hello world.",
      occurrence: 2,
    },
  });

  expect(withComment.threads[0]?.anchor.occurrence).toBe(2);
  expect(withComment.html).toContain(
    '<p><span data-redline-anchor="thread_second_match">Hello world.</span></p></body>',
  );
});

test("text-range comments can anchor uniquely matched css-transformed casing", () => {
  const documentPath = tempDocument();
  fs.writeFileSync(
    documentPath,
    '<!doctype html><html><body><div class="label">columns (River/Hermes-shaped)</div></body></html>',
  );

  const withComment = createComment(documentPath, {
    threadId: "thread_columns_label",
    body: "Explain the table.",
    quote: "COLUMNS (RIVER/HERMES-SHAPED)",
    anchor: {
      type: "text-range",
      quote: "COLUMNS (RIVER/HERMES-SHAPED)",
    },
  });

  expect(withComment.threads[0]?.anchor.anchorId).toBe("thread_columns_label");
  expect(withComment.html).toContain(
    '<span data-redline-anchor="thread_columns_label">columns (River/Hermes-shaped)</span>',
  );
});

test("text-range comments match quotes across decoded typographic entities", () => {
  const documentPath = tempDocument();
  fs.writeFileSync(
    documentPath,
    "<!doctype html><html><body><p>It&rsquo;s the team&mdash;all of it.</p></body></html>",
  );

  const withComment = createComment(documentPath, {
    threadId: "thread_entity",
    body: "Check the phrasing.",
    quote: "It’s the team—all of it.",
    anchor: { type: "text-range", quote: "It’s the team—all of it." },
  });

  expect(withComment.threads[0]?.anchor.anchorId).toBe("thread_entity");
  expect(withComment.html).toContain(
    '<span data-redline-anchor="thread_entity">It&rsquo;s the team&mdash;all of it.</span>',
  );
});

test("text-range comments spanning a block boundary stay span-less but are kept", () => {
  const documentPath = tempDocument();
  fs.writeFileSync(
    documentPath,
    "<!doctype html><html><body><p>Hello</p>\n<p>world</p></body></html>",
  );

  const withComment = createComment(documentPath, {
    threadId: "thread_cross",
    body: "Crosses a paragraph boundary.",
    quote: "Hello world",
    anchor: { type: "text-range", quote: "Hello world" },
  });

  // The quote resolves (whitespace between the blocks collapses to a space), but
  // it cannot be wrapped without crossing the </p><p> boundary, so the thread is
  // kept span-less and the markup is left valid rather than rejected or corrupted.
  expect(withComment.threads).toHaveLength(1);
  expect(withComment.html).not.toContain("<span data-redline-anchor");
  expect(withComment.html).toContain("<p>Hello</p>\n<p>world</p>");
});

test("text-range comments wrap inline markup whose attributes contain '>'", () => {
  const documentPath = tempDocument();
  fs.writeFileSync(
    documentPath,
    '<!doctype html><html><body><p>a<span data-x="/>">b</span>c</p></body></html>',
  );

  const withComment = createComment(documentPath, {
    threadId: "thread_attr",
    body: "Spans an inline element with a tricky attribute.",
    quote: "abc",
    anchor: { type: "text-range", quote: "abc" },
  });

  // The wrapped slice is tag-balanced (an inline <span> with a "/>"-containing
  // attribute), so it must anchor rather than be mistaken for crossed markup.
  expect(withComment.html).toContain('<span data-redline-anchor="thread_attr">');
});

test("text-range comments reject an occurrence beyond the match count", () => {
  const documentPath = tempDocument();

  expect(() =>
    createComment(documentPath, {
      body: "Too far.",
      quote: "Hello world.",
      anchor: { type: "text-range", quote: "Hello world.", occurrence: 3 },
    }),
  ).toThrow("Quoted text appears 1 times, but occurrence 3 was requested.");
});

test("reads compact agent states without returning html", () => {
  const documentPath = tempDocument();
  const withComment = createComment(documentPath, {
    body: "Compact state note.",
    author: "User",
    anchor: { type: "document" },
  });

  const comments = readCommentState(documentPath);
  const file = readDocumentFileState(documentPath);

  expect(comments).toEqual({
    documentPath,
    legacySidecarPath: legacySidecarPathFor(documentPath),
    version: withComment.version,
    updatedAt: withComment.updatedAt,
    threads: withComment.threads,
    summary: withComment.summary,
  });
  expect(file).toEqual({
    documentPath,
    legacySidecarPath: legacySidecarPathFor(documentPath),
    version: withComment.version,
    updatedAt: withComment.updatedAt,
    summary: withComment.summary,
  });
  expect("html" in comments).toBe(false);
  expect("html" in file).toBe(false);
  expect("threads" in file).toBe(false);
});

test("deletes a single reply without removing the thread", () => {
  const documentPath = tempDocument();
  const withComment = createComment(documentPath, {
    body: "Root comment.",
    author: "User",
    anchor: { type: "document" },
  });
  const threadId = withComment.threads[0]?.id ?? "";
  const withFirstReply = appendReply(documentPath, threadId, "First reply.", "AI");
  appendReply(documentPath, threadId, "Second reply.", "User");
  const replyId = withFirstReply.threads[0]?.messages[1]?.id ?? "";

  const updated = deleteReply(documentPath, threadId, replyId);

  expect(updated.threads).toHaveLength(1);
  expect(updated.threads[0]?.messages.map((message) => message.body)).toEqual([
    "Root comment.",
    "Second reply.",
  ]);
  expect(updated.summary).toEqual({
    threads: 1,
    messages: 2,
    unresolved: 1,
  });
});

test("edits original comments and replies without moving anchors", () => {
  const documentPath = tempDocument();
  fs.writeFileSync(
    documentPath,
    '<!doctype html><html><body><p><span data-redline-anchor="thread_edit">Hello world.</span></p></body></html>',
  );
  const withComment = createComment(documentPath, {
    threadId: "thread_edit",
    body: "Original comment.",
    quote: "Hello world.",
    html: fs.readFileSync(documentPath, "utf8"),
    anchor: {
      type: "text-range",
      anchorId: "thread_edit",
      quote: "Hello world.",
    },
  });
  const threadId = withComment.threads[0]?.id ?? "";
  const rootMessageId = withComment.threads[0]?.messages[0]?.id ?? "";
  const withReply = appendReply(documentPath, threadId, "Original reply.", "AI");
  const replyId = withReply.threads[0]?.messages[1]?.id ?? "";

  updateCommentMessage(documentPath, threadId, rootMessageId, "Edited comment.");
  const updated = updateCommentMessage(documentPath, threadId, replyId, "Edited reply.");

  expect(updated.threads[0]?.messages.map((message) => message.body)).toEqual([
    "Edited comment.",
    "Edited reply.",
  ]);
  expect(updated.summary).toEqual({
    threads: 1,
    messages: 2,
    unresolved: 1,
  });
  expect(fs.readFileSync(documentPath, "utf8")).toContain('data-redline-anchor="thread_edit"');
});

test("rejects invalid comment operations", () => {
  const documentPath = tempDocument();
  const withComment = createComment(documentPath, {
    threadId: "thread_fixed",
    body: "First note.",
    anchor: { type: "document" },
  });
  const rootMessageId = withComment.threads[0]?.messages[0]?.id ?? "";

  expect(() =>
    createComment(documentPath, {
      threadId: "thread_fixed",
      body: "Duplicate note.",
      anchor: { type: "document" },
    }),
  ).toThrow("Comment thread already exists");
  expect(() => createComment(documentPath, { body: "  ", anchor: { type: "document" } })).toThrow(
    "Comment body is required.",
  );
  expect(() => appendReply(documentPath, "thread_missing", "Reply.", "AI")).toThrow(
    "Comment thread not found",
  );
  expect(() => deleteReply(documentPath, "thread_missing", "message_missing")).toThrow(
    "Comment thread not found",
  );
  expect(() => deleteReply(documentPath, "thread_fixed", "message_missing")).toThrow(
    "Reply not found",
  );
  expect(() => deleteReply(documentPath, "thread_fixed", rootMessageId)).toThrow(
    "The original comment cannot be deleted as a reply.",
  );
  expect(() => updateCommentMessage(documentPath, "thread_missing", rootMessageId, "Edit.")).toThrow(
    "Comment thread not found",
  );
  expect(() => updateCommentMessage(documentPath, "thread_fixed", "message_missing", "Edit.")).toThrow(
    "Comment message not found",
  );
  expect(() => updateCommentMessage(documentPath, "thread_fixed", rootMessageId, "  ")).toThrow(
    "Comment body is required.",
  );
  expect(() => resolveThread(documentPath, "thread_missing")).toThrow("Comment thread not found");
  expect(() =>
    applyAgentUpdate(documentPath, {
      replies: [{ threadId: "thread_missing", body: "Reply.", author: "AI" }],
    }),
  ).toThrow("Comment thread not found");
});

test("agent updates can replace html and append replies together", () => {
  const documentPath = tempDocument();
  const withComment = createComment(documentPath, {
    body: "Make the greeting warmer.",
    anchor: {
      type: "text-range",
      quote: "Hello world.",
    },
  });
  const threadId = withComment.threads[0]?.id ?? "";

  const updated = applyAgentUpdate(documentPath, {
    html: "<!doctype html><html><body><p>Hello, friend.</p></body></html>",
    replies: [{ threadId, body: "Changed to a warmer greeting.", author: "AI" }],
  });

  expect(updated.html).toContain("Hello, friend.");
  expect(updated.html).toContain('id="redline-state"');
  expect(updated.threads[0]?.messages.at(-1)?.author).toBe("AI");
});

test("agent updates use supplied author names and fall back to AI for blanks", () => {
  const documentPath = tempDocument();
  const withComment = createComment(documentPath, {
    body: "Make the greeting warmer.",
    anchor: { type: "document" },
  });
  const threadId = withComment.threads[0]?.id ?? "";

  const updated = applyAgentUpdate(documentPath, {
    comments: [
      {
        body: "Fresh agent note.",
        author: "Codex",
        quote: "Document-level follow-up.",
        anchor: { type: "document" },
      },
    ],
    replies: [{ threadId, body: "Blank author reply.", author: "  " }],
  });

  expect(updated.threads[0]?.messages.at(-1)?.author).toBe("AI");
  expect(updated.threads[1]?.author).toBe("Codex");
  expect(updated.threads[1]?.messages[0]?.author).toBe("Codex");
});

test("agent updates insert durable inline anchors for new text comments", () => {
  const documentPath = tempDocument();

  const updated = applyAgentUpdate(documentPath, {
    comments: [
      {
        threadId: "thread_agent_supplied",
        body: "Anchor this note.",
        author: "Codex",
        quote: "Hello world.",
        anchor: {
          type: "text-range",
          quote: "Hello world.",
        },
      },
    ],
  });

  expect(updated.threads[0]?.id).toBe("thread_agent_supplied");
  expect(updated.threads[0]?.anchor.anchorId).toBe("thread_agent_supplied");
  expect(updated.html).toContain(
    '<span data-redline-anchor="thread_agent_supplied">Hello world.</span>',
  );
});

test("agent updates reject mismatched comment ids before writing partial state", () => {
  const documentPath = tempDocument();

  expect(() =>
    applyAgentUpdate(documentPath, {
      comments: [
        {
          threadId: "thread_outer",
          body: "Mismatched ids.",
          quote: "Hello world.",
          anchor: {
            type: "text-range",
            anchorId: "thread_inner",
            quote: "Hello world.",
          },
        },
      ],
    }),
  ).toThrow("threadId and anchor.anchorId must match");

  expect(readDocumentState(documentPath).threads).toHaveLength(0);
  expect(fs.readFileSync(documentPath, "utf8")).not.toContain("data-redline-anchor");
});

test("repairing document anchors materializes old spanless text threads", () => {
  const documentPath = tempDocument();
  const embeddedState = {
    schemaVersion: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
    threads: [
      {
        id: "thread_current",
        anchor: {
          type: "text-range",
          anchorId: "thread_old",
          quote: "Hello world.",
        },
        quote: "Hello world.",
        author: "Codex",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        messages: [
          {
            id: "message_old",
            author: "Codex",
            body: "Old spanless comment.",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      },
    ],
  };
  fs.writeFileSync(
    documentPath,
    `<!doctype html><html><head><script type="application/json" id="redline-state">${JSON.stringify(
      embeddedState,
    )}</script></head><body><p>Hello world.</p></body></html>`,
  );

  const repaired = repairDocumentAnchors(documentPath);

  expect(repaired.threads[0]?.id).toBe("thread_current");
  expect(repaired.threads[0]?.anchor.anchorId).toBe("thread_current");
  expect(repaired.html).toContain('<span data-redline-anchor="thread_current">Hello world.</span>');
  expect(repaired.html).not.toContain("thread_old");
});

test("agent updates can add comments and resolve inline anchors", () => {
  const documentPath = tempDocument();
  const withComment = createComment(documentPath, {
    threadId: "thread_inline789",
    body: "This one can be resolved.",
    quote: "Hello world.",
    html: '<!doctype html><html><body><p><span data-redline-anchor="thread_inline789">Hello world.</span></p></body></html>',
    anchor: {
      type: "text-range",
      anchorId: "thread_inline789",
      quote: "Hello world.",
    },
  });

  const updated = applyAgentUpdate(documentPath, {
    html: withComment.html,
    comments: [
      {
        body: "Fresh agent note.",
        author: "AI",
        quote: "Document-level follow-up.",
        anchor: { type: "document" },
      },
    ],
    resolveThreadIds: ["thread_inline789"],
  });

  expect(updated.threads).toHaveLength(1);
  expect(updated.threads[0]?.messages[0]?.body).toBe("Fresh agent note.");
  expect(updated.html).not.toContain('data-redline-anchor="thread_inline789"');
});

test("writing html preserves existing comments", () => {
  const documentPath = tempDocument();
  const before = createComment(documentPath, {
    body: "Keep this tracked.",
    anchor: { type: "document" },
  });

  writeDocumentHtml(documentPath, "<!doctype html><html><body><p>Changed.</p></body></html>");
  const after = readDocumentState(documentPath);

  expect(after.html).toContain("Changed.");
  expect(after.threads[0]?.id).toBe(before.threads[0]?.id);
  expect(after.html).toContain('id="redline-state"');
});

test("embedded state is injected into documents without a head", () => {
  const htmlDocumentPath = tempDocument();
  fs.writeFileSync(htmlDocumentPath, "<html><body><p>Loose shell.</p></body></html>");

  const htmlDocument = createComment(htmlDocumentPath, {
    body: "Works without a head.",
    anchor: { type: "document" },
  });

  expect(htmlDocument.html).toContain("<head>");
  expect(htmlDocument.html).toContain('name="redline-agent-guide"');
  expect(htmlDocument.html).toContain('id="redline-state"');

  const markedHtmlDocumentPath = tempDocument();
  fs.writeFileSync(
    markedHtmlDocumentPath,
    "<!-- redline-agent-guide: existing marker --><html><body><p>Marked loose shell.</p></body></html>",
  );

  const markedHtmlDocument = createComment(markedHtmlDocumentPath, {
    body: "Works with an existing marker.",
    anchor: { type: "document" },
  });

  expect(markedHtmlDocument.html).toContain("<head>");
  expect(markedHtmlDocument.html).toContain('id="redline-state"');

  const fragmentPath = tempDocument();
  fs.writeFileSync(fragmentPath, "<p>Fragment document.</p>");

  const fragmentDocument = createComment(fragmentPath, {
    body: "Works as a fragment.",
    anchor: { type: "document" },
  });

  expect(fragmentDocument.html.startsWith('<script type="application/json" id="redline-state">')).toBe(true);
});

test("browser-created comments keep inline anchors in the html", () => {
  const documentPath = tempDocument();
  const withComment = createComment(documentPath, {
    threadId: "thread_inline123",
    body: "This should stay attached.",
    quote: "Hello world.",
    html: '<!doctype html><html><body><p><span data-redline-anchor="thread_inline123">Hello world.</span></p></body></html>',
    anchor: {
      type: "text-range",
      anchorId: "thread_inline123",
      quote: "Hello world.",
    },
  });

  expect(withComment.threads[0]?.id).toBe("thread_inline123");
  expect(withComment.threads[0]?.anchor.anchorId).toBe("thread_inline123");
  expect(fs.readFileSync(documentPath, "utf8")).toContain('data-redline-anchor="thread_inline123"');

  resolveThread(documentPath, "thread_inline123");

  expect(fs.readFileSync(documentPath, "utf8")).not.toContain("data-redline-anchor=");
});

test("browser-created comments merge with existing embedded comments", () => {
  const documentPath = tempDocument();
  createComment(documentPath, {
    body: "First note.",
    anchor: { type: "document" },
  });

  const withSecond = createComment(documentPath, {
    threadId: "thread_inline456",
    body: "Second note.",
    html: '<!doctype html><html><body><p><span data-redline-anchor="thread_inline456">Hello world.</span></p></body></html>',
    anchor: {
      type: "text-range",
      anchorId: "thread_inline456",
      quote: "Hello world.",
    },
  });

  expect(withSecond.threads).toHaveLength(2);
  expect(withSecond.html).toContain('data-redline-anchor="thread_inline456"');
});

test("documents without embedded comments have stable versions", () => {
  const documentPath = tempDocument();
  const first = readDocumentState(documentPath);
  const second = readDocumentState(documentPath);

  expect(first.version).toBe(second.version);
});

test("legacy sidecars migrate into the html on the next write", () => {
  const documentPath = tempDocument();
  writeSidecar(documentPath, {
    schemaVersion: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
    threads: [
      {
        id: "thread_legacy",
        anchor: { type: "document" },
        quote: "",
        author: "Reviewer",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        messages: [
          {
            id: "message_legacy",
            author: "Reviewer",
            body: "Legacy note.",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      },
    ],
  });

  expect(readDocumentState(documentPath).threads).toHaveLength(1);
  appendReply(documentPath, "thread_legacy", "Migrated.", "AI");

  const html = fs.readFileSync(documentPath, "utf8");
  expect(html).toContain('id="redline-state"');
  expect(html).toContain("Legacy note.");
  expect(fs.existsSync(sidecarPathFor(documentPath))).toBe(false);
});

test("legacy coauthor sidecars migrate into redline html on the next write", () => {
  const documentPath = tempDocument();
  fs.writeFileSync(
    legacySidecarPathFor(documentPath),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        updatedAt: "2026-01-01T00:00:00.000Z",
        threads: [
          {
            id: "thread_coauthor_legacy",
            anchor: { type: "document" },
            quote: "",
            author: "Reviewer",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            messages: [
              {
                id: "message_coauthor_legacy",
                author: "Reviewer",
                body: "Old sidecar note.",
                createdAt: "2026-01-01T00:00:00.000Z",
              },
            ],
          },
        ],
      },
      null,
      2,
    )}\n`,
  );

  expect(readDocumentState(documentPath).threads).toHaveLength(1);
  appendReply(documentPath, "thread_coauthor_legacy", "Migrated.", "AI");

  const html = fs.readFileSync(documentPath, "utf8");
  expect(html).toContain('id="redline-state"');
  expect(html).toContain("Old sidecar note.");
  expect(fs.existsSync(legacySidecarPathFor(documentPath))).toBe(false);
});

test("legacy coauthor embedded state and anchors migrate on write", () => {
  const documentPath = tempDocument();
  fs.writeFileSync(
    documentPath,
    '<!doctype html><html><head><script type="application/json" id="coauthor-state">{"schemaVersion":1,"updatedAt":"2026-01-01T00:00:00.000Z","threads":[{"id":"thread_old_anchor","anchor":{"type":"text-range","anchorId":"thread_old_anchor","quote":"Hello world."},"quote":"Hello world.","author":"Reviewer","createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z","messages":[{"id":"message_old_anchor","author":"Reviewer","body":"Old inline anchor.","createdAt":"2026-01-01T00:00:00.000Z"}]}]}</script></head><body><p><span data-coauthor-anchor="thread_old_anchor">Hello world.</span></p></body></html>',
  );

  expect(readDocumentState(documentPath).threads).toHaveLength(1);
  appendReply(documentPath, "thread_old_anchor", "Migrated.", "AI");

  const html = fs.readFileSync(documentPath, "utf8");
  expect(html).toContain('id="redline-state"');
  expect(html).not.toContain('id="coauthor-state"');
  expect(html).toContain('data-redline-anchor="thread_old_anchor"');
  expect(html).not.toContain("data-coauthor-anchor");
});
