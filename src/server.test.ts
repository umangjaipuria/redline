import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleCommentRequest } from "./comment-routes";
import { appendReply, createComment } from "./state";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDocument(html = "<!doctype html><html><body><p>Hello world.</p></body></html>") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "redline-server-"));
  tempDirs.push(dir);
  const documentPath = path.join(dir, "draft.html");
  fs.writeFileSync(documentPath, html);
  return documentPath;
}

function commentRouter(documentPath: string) {
  const reasons: string[] = [];
  const handle = (request: Request) =>
    handleCommentRequest(request, {
      documentPath,
      changed(state, reason) {
        reasons.push(reason);
        return new Response(JSON.stringify(state), {
          headers: { "Content-Type": "application/json; charset=utf-8" },
        });
      },
    });
  return { handle, reasons };
}

test("POST /api/comments creates a routed comment", async () => {
  const documentPath = tempDocument();
  const router = commentRouter(documentPath);

  const response = await router.handle(
    new Request("http://127.0.0.1/api/comments", {
      method: "POST",
      body: JSON.stringify({
        body: "Add a note.",
        author: "User",
        anchor: { type: "document" },
      }),
    }),
  );
  const payload = await response?.json();

  expect(response?.status).toBe(200);
  expect(router.reasons).toEqual(["comment.created"]);
  expect(payload.threads).toHaveLength(1);
  expect(payload.threads[0]?.messages[0]?.body).toBe("Add a note.");
});

test("POST /api/comments rejects stale expected versions", async () => {
  const documentPath = tempDocument();
  const router = commentRouter(documentPath);

  const response = await router.handle(
    new Request("http://127.0.0.1/api/comments", {
      method: "POST",
      body: JSON.stringify({
        body: "Stale note.",
        expectedVersion: "older-version",
        anchor: { type: "document" },
      }),
    }),
  );
  const payload = await response?.json();

  expect(response?.status).toBe(409);
  expect(router.reasons).toEqual([]);
  expect(payload.error).toBe("Document changed before this comment was saved.");
  expect(payload.current.summary).toEqual({ threads: 0, messages: 0, unresolved: 0 });
});

test("POST /api/comments/:threadId/replies appends a routed reply", async () => {
  const documentPath = tempDocument();
  const withComment = createComment(documentPath, {
    body: "Root comment.",
    anchor: { type: "document" },
  });
  const threadId = withComment.threads[0]?.id ?? "";
  const router = commentRouter(documentPath);

  const response = await router.handle(
    new Request(`http://127.0.0.1/api/comments/${threadId}/replies`, {
      method: "POST",
      body: JSON.stringify({ body: "Routed reply." }),
    }),
  );
  const payload = await response?.json();

  expect(response?.status).toBe(200);
  expect(router.reasons).toEqual(["reply.created"]);
  expect(payload.threads[0]?.messages.map((message: { body: string }) => message.body)).toEqual([
    "Root comment.",
    "Routed reply.",
  ]);
  expect(payload.threads[0]?.messages[1]?.author).toBe("User");
});

test("POST /api/comments/:threadId/replies rejects missing bodies", async () => {
  const documentPath = tempDocument();
  const withComment = createComment(documentPath, {
    body: "Root comment.",
    anchor: { type: "document" },
  });
  const threadId = withComment.threads[0]?.id ?? "";

  const response = await commentRouter(documentPath).handle(
    new Request(`http://127.0.0.1/api/comments/${threadId}/replies`, {
      method: "POST",
      body: JSON.stringify({ author: "User" }),
    }),
  );
  const payload = await response?.json();

  expect(response?.status).toBe(400);
  expect(payload.error).toBe("body is required.");
});

test("POST /api/comments/:threadId/resolve resolves a whole thread", async () => {
  const documentPath = tempDocument(
    '<!doctype html><html><body><p><span data-redline-anchor="thread_delete">Hello world.</span></p></body></html>',
  );
  createComment(documentPath, {
    threadId: "thread_delete",
    body: "Remove this thread.",
    quote: "Hello world.",
    html: fs.readFileSync(documentPath, "utf8"),
    anchor: {
      type: "text-range",
      anchorId: "thread_delete",
      quote: "Hello world.",
    },
  });
  const router = commentRouter(documentPath);

  const response = await router.handle(
    new Request("http://127.0.0.1/api/comments/thread_delete/resolve", { method: "POST" }),
  );
  const payload = await response?.json();

  expect(response?.status).toBe(200);
  expect(router.reasons).toEqual(["comment.resolved"]);
  expect(payload.summary).toEqual({ threads: 0, messages: 0, unresolved: 0 });
  expect(payload.threads).toHaveLength(0);
  expect(fs.readFileSync(documentPath, "utf8")).not.toContain('data-redline-anchor="thread_delete"');
});

test("DELETE /api/comments/:threadId resolves a whole thread", async () => {
  const documentPath = tempDocument();
  createComment(documentPath, {
    threadId: "thread_delete",
    body: "Remove this thread.",
    anchor: { type: "document" },
  });
  const router = commentRouter(documentPath);

  const response = await router.handle(
    new Request("http://127.0.0.1/api/comments/thread_delete", { method: "DELETE" }),
  );
  const payload = await response?.json();

  expect(response?.status).toBe(200);
  expect(router.reasons).toEqual(["comment.resolved"]);
  expect(payload.summary).toEqual({ threads: 0, messages: 0, unresolved: 0 });
  expect(payload.threads).toHaveLength(0);
});

test("DELETE /api/comments/:threadId/replies/:messageId deletes only that reply", async () => {
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

  const router = commentRouter(documentPath);
  const response = await router.handle(
    new Request(`http://127.0.0.1/api/comments/${threadId}/replies/${replyId}`, {
      method: "DELETE",
    }),
  );
  const payload = await response?.json();

  expect(response?.status).toBe(200);
  expect(router.reasons).toEqual(["reply.deleted"]);
  expect(payload.threads).toHaveLength(1);
  expect(payload.threads[0]?.messages.map((message: { body: string }) => message.body)).toEqual([
    "Root comment.",
    "Second reply.",
  ]);
  expect(payload.summary).toEqual({ threads: 1, messages: 2, unresolved: 1 });
});

test("comment routes return undefined for unrelated requests", async () => {
  const response = await commentRouter(tempDocument()).handle(
    new Request("http://127.0.0.1/api/state", { method: "GET" }),
  );

  expect(response).toBeUndefined();
});

test("comment routes reject invalid JSON bodies", async () => {
  await expect(
    commentRouter(tempDocument()).handle(
      new Request("http://127.0.0.1/api/comments", { method: "POST", body: "{" }),
    ),
  ).rejects.toThrow("Request body must be valid JSON.");
});
