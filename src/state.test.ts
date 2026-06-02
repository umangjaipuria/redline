import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendReply,
  applyAgentUpdate,
  createComment,
  legacySidecarPathFor,
  readDocumentState,
  resolveThread,
  sidecarPathFor,
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

test("creates, replies to, and resolves comment threads", () => {
  const documentPath = tempDocument();
  const withComment = createComment(documentPath, {
    body: "Tighten this sentence.",
    author: "User",
    quote: "Hello world.",
    anchor: {
      type: "text-range",
      quote: "Hello world.",
      textPosition: { start: 0, end: 12 },
    },
  });

  expect(withComment.threads).toHaveLength(1);
  const threadId = withComment.threads[0]?.id ?? "";

  const withReply = appendReply(documentPath, threadId, "Updated the paragraph.", "AI");
  expect(withReply.threads[0]?.messages).toHaveLength(2);
  expect(fs.readFileSync(documentPath, "utf8")).toContain('id="redline-state"');

  const resolved = resolveThread(documentPath, threadId);
  expect(resolved.threads).toHaveLength(0);
  expect(fs.readFileSync(documentPath, "utf8")).not.toContain('id="redline-state"');
  expect(fs.existsSync(sidecarPathFor(documentPath))).toBe(false);
});

test("agent updates can replace html and append replies together", () => {
  const documentPath = tempDocument();
  const withComment = createComment(documentPath, {
    body: "Make the greeting warmer.",
    anchor: {
      type: "text-range",
      quote: "Hello world.",
      textPosition: { start: 0, end: 12 },
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
      textPosition: { start: 0, end: 12 },
    },
  });

  expect(withComment.threads[0]?.id).toBe("thread_inline123");
  expect(withComment.threads[0]?.anchor.anchorId).toBe("thread_inline123");
  expect(fs.readFileSync(documentPath, "utf8")).toContain('data-redline-anchor="thread_inline123"');

  resolveThread(documentPath, "thread_inline123");

  expect(fs.readFileSync(documentPath, "utf8")).not.toContain("data-redline-anchor");
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
      textPosition: { start: 0, end: 12 },
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
