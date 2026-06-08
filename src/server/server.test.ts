import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequestHandler } from "./server";
import { SessionManager } from "./sessions";
import type { DocumentStateResponse, DocumentSessionInfo } from "../shared";

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
let handler: (request: Request) => Promise<Response>;
let manager: SessionManager;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "redline-srv-"));
  file = path.join(dir, "doc.html");
  fs.writeFileSync(file, DOC, "utf8");
  manager = new SessionManager();
  handler = createRequestHandler({
    manager,
    serverInfo: () => ({ url: "http://x", pid: 1, startedAt: "now", docs: [] }),
  });
});

afterEach(() => {
  manager.closeAll();
  fs.rmSync(dir, { recursive: true, force: true });
});

function req(method: string, urlPath: string, body?: unknown): Request {
  return new Request(`http://127.0.0.1${urlPath}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function openDoc(): Promise<DocumentSessionInfo> {
  const res = await handler(req("POST", "/api/docs", { path: file }));
  expect(res.status).toBe(200);
  return res.json();
}

describe("server-level docs", () => {
  test("health reports open doc count", async () => {
    const res = await handler(req("GET", "/api/health"));
    expect(res.status).toBe(200);
    expect((await res.json()).docs).toBe(0);
  });

  test("open-or-return-existing returns the same docId for one path", async () => {
    const first = await openDoc();
    const second = await openDoc();
    expect(first.docId).toBe(second.docId);
    expect(first.docId.startsWith("doc_")).toBe(true);
  });

  test("GET /api/docs lists open docs and resolves by path", async () => {
    const opened = await openDoc();
    const list = await (await handler(req("GET", "/api/docs"))).json();
    expect(list.docs).toHaveLength(1);
    const byPath = await handler(req("GET", `/api/docs?path=${encodeURIComponent(file)}`));
    expect((await byPath.json()).docId).toBe(opened.docId);
  });

  test("cross-origin API requests are rejected", async () => {
    const res = await handler(
      new Request("http://127.0.0.1/api/docs", {
        method: "GET",
        headers: { Origin: "http://evil.example" },
      }),
    );
    expect(res.status).toBe(403);
  });

  test("unsupported file type is refused", async () => {
    const txt = path.join(dir, "notes.txt");
    fs.writeFileSync(txt, "hi");
    const res = await handler(req("POST", "/api/docs", { path: txt }));
    expect(res.status).toBe(415);
  });
});

describe("document-scoped state + comments", () => {
  test("state returns rendered html, threads, and anchors", async () => {
    const { docId } = await openDoc();
    const res = await handler(req("GET", `/api/docs/${docId}/state`));
    const state: DocumentStateResponse = await res.json();
    expect(state.renderedHtml).toContain("Quarterly review");
    expect(state.format).toBe("html");
    expect(state.threads).toHaveLength(0);
  });

  test("create comment, reply, edit, delete-thread round-trip", async () => {
    const { docId } = await openDoc();
    let res = await handler(req("POST", `/api/docs/${docId}/comments`, {
      message: "needs a source",
      quote: "new dashboard",
    }));
    expect(res.status).toBe(200);
    let state: DocumentStateResponse = await res.json();
    expect(state.threads).toHaveLength(1);
    expect(state.anchors[0]!.state).toBe("anchored");
    const threadId = state.threads[0]!.id;

    res = await handler(req("POST", `/api/docs/${docId}/comments/${threadId}/replies`, { body: "ok" }));
    state = await res.json();
    expect(state.threads[0]!.messages).toHaveLength(2);
    const messageId = state.threads[0]!.messages[1]!.id;

    res = await handler(req("PUT", `/api/docs/${docId}/comments/${threadId}/messages/${messageId}`, { body: "ok!" }));
    state = await res.json();
    expect(state.threads[0]!.messages[1]!.body).toBe("ok!");

    res = await handler(req("DELETE", `/api/docs/${docId}/comments/${threadId}`));
    state = await res.json();
    expect(state.threads).toHaveLength(0);
  });

  test("ambiguous quote returns 422", async () => {
    const { docId } = await openDoc();
    const res = await handler(req("POST", `/api/docs/${docId}/comments`, { message: "x", quote: "The" }));
    expect(res.status).toBe(422);
  });

  test("stale expectedVersion returns 409 with current state", async () => {
    const { docId } = await openDoc();
    const res = await handler(req("POST", `/api/docs/${docId}/comments`, {
      message: "x",
      quote: "redesign",
      expectedVersion: "stale",
    }));
    expect(res.status).toBe(409);
    expect((await res.json()).current).toBeDefined();
  });

  test("malformed JSON body returns 400, not 500", async () => {
    const { docId } = await openDoc();
    const res = await handler(
      new Request(`http://127.0.0.1/api/docs/${docId}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{ not json",
      }),
    );
    expect(res.status).toBe(400);
  });

  test("unknown docId returns 404 with re-resolve guidance", async () => {
    const res = await handler(req("GET", "/api/docs/doc_not-a-real-id/state"));
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("unknown-doc");
  });
});

describe("anchors + agent endpoints", () => {
  test("anchors report classifies after an external rewrite", async () => {
    const { docId } = await openDoc();
    await handler(req("POST", `/api/docs/${docId}/comments`, { message: "x", quote: "metrics are accurate" }));
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("The metrics are accurate.", "Pipeline rebuilt overnight."), "utf8");
    const report = await (await handler(req("GET", `/api/docs/${docId}/anchors`))).json();
    expect(report.anchors[0]!.state).toBe("orphaned");
  });

  test("agent update batch and index", async () => {
    const { docId } = await openDoc();
    await handler(req("POST", `/api/docs/${docId}/agent/update`, {
      comments: [{ quote: "redesign", body: "review this", author: "Codex" }],
    }));
    const index = await (await handler(req("GET", `/api/docs/${docId}/agent/comments/index`))).json();
    expect(index.threads).toHaveLength(1);
    expect(index.threads[0]!.author).toBe("Codex");
  });

  test("reanchor fixes an orphan", async () => {
    const { docId } = await openDoc();
    const created = await (await handler(req("POST", `/api/docs/${docId}/comments`, { message: "x", quote: "metrics are accurate" }))).json();
    const threadId = created.threads[0]!.id;
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("The metrics are accurate.", "The KPIs look solid."), "utf8");
    const res = await handler(req("POST", `/api/docs/${docId}/anchors/${threadId}/reanchor`, { quote: "KPIs look solid" }));
    const state: DocumentStateResponse = await res.json();
    expect(state.anchors[0]!.state).toBe("anchored");
  });
});

describe("file browser + close", () => {
  test("lists a directory with html flagged", async () => {
    const res = await handler(req("GET", `/api/files?dir=${encodeURIComponent(dir)}`));
    const listing = await res.json();
    expect(listing.entries.some((e: { name: string; isHtml: boolean }) => e.name === "doc.html" && e.isHtml)).toBe(true);
  });

  test("close frees the session", async () => {
    const { docId } = await openDoc();
    const res = await handler(req("DELETE", `/api/docs/${docId}`));
    expect((await res.json()).closed).toBe(true);
    const after = await handler(req("GET", `/api/docs/${docId}/state`));
    expect(after.status).toBe(404);
  });
});

describe("external change detection", () => {
  test("checkExternalChanges reconciles after a direct file edit", async () => {
    const { docId } = await openDoc();
    await handler(req("POST", `/api/docs/${docId}/comments`, { message: "x", quote: "metrics are accurate" }));
    // Edit body-only text (not present in the head's state block).
    fs.writeFileSync(
      file,
      fs.readFileSync(file, "utf8").replace("asked for more charts", "asked for more analytics charts"),
      "utf8",
    );
    manager.checkExternalChanges();
    const state: DocumentStateResponse = await (await handler(req("GET", `/api/docs/${docId}/state`))).json();
    // The doc still renders the edited content and the comment survives.
    expect(state.renderedHtml).toContain("more analytics charts");
    expect(state.threads).toHaveLength(1);
  });
});
