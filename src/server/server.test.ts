import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequestHandler, reuseRunningServer } from "./server";
import { SessionManager } from "./sessions";
import { writeServerRecord } from "./registry";
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

  test("malformed embedded state surfaces a warning in /state", async () => {
    const broken = DOC.replace(
      "</head>",
      '<script type="application/json" id="redline-state">{ broken </script></head>',
    );
    fs.writeFileSync(file, broken, "utf8");
    const { docId } = await openDoc();
    const state: DocumentStateResponse = await (await handler(req("GET", `/api/docs/${docId}/state`))).json();
    expect(state.warning).toBeDefined();
    expect(state.threads).toHaveLength(0);
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

describe("multiple documents", () => {
  function secondDoc(): string {
    const other = path.join(dir, "other.html");
    fs.writeFileSync(
      other,
      `<!doctype html><html><head><title>Other</title></head><body><h1>Roadmap</h1>` +
        `<p>We will ship offline mode and a mobile app next quarter.</p></body></html>`,
      "utf8",
    );
    return other;
  }

  test("two distinct files get two distinct docIds, both listed", async () => {
    const a = await openDoc();
    const other = secondDoc();
    const b: DocumentSessionInfo = await (await handler(req("POST", "/api/docs", { path: other }))).json();
    expect(a.docId).not.toBe(b.docId);
    const list = await (await handler(req("GET", "/api/docs"))).json();
    expect(list.docs.map((d: DocumentSessionInfo) => d.docId).sort()).toEqual([a.docId, b.docId].sort());
  });

  test("comment state is isolated per document", async () => {
    const a = await openDoc();
    const b: DocumentSessionInfo = await (await handler(req("POST", "/api/docs", { path: secondDoc() }))).json();

    await handler(req("POST", `/api/docs/${a.docId}/comments`, { message: "on A", quote: "new dashboard" }));
    await handler(req("POST", `/api/docs/${b.docId}/comments`, { message: "on B", quote: "offline mode" }));

    const stateA: DocumentStateResponse = await (await handler(req("GET", `/api/docs/${a.docId}/state`))).json();
    const stateB: DocumentStateResponse = await (await handler(req("GET", `/api/docs/${b.docId}/state`))).json();
    expect(stateA.threads).toHaveLength(1);
    expect(stateB.threads).toHaveLength(1);
    expect(stateA.threads[0]!.messages[0]!.body).toBe("on A");
    expect(stateB.threads[0]!.messages[0]!.body).toBe("on B");
    expect(stateA.threads[0]!.id).not.toBe(stateB.threads[0]!.id);
  });

  test("closing one document leaves the others served", async () => {
    const a = await openDoc();
    const b: DocumentSessionInfo = await (await handler(req("POST", "/api/docs", { path: secondDoc() }))).json();

    await handler(req("DELETE", `/api/docs/${a.docId}`));
    expect((await handler(req("GET", `/api/docs/${a.docId}/state`))).status).toBe(404);
    expect((await handler(req("GET", `/api/docs/${b.docId}/state`))).status).toBe(200);

    const list = await (await handler(req("GET", "/api/docs"))).json();
    expect(list.docs).toHaveLength(1);
    expect(list.docs[0].docId).toBe(b.docId);
  });

  test("opening the same path twice returns the same session", async () => {
    const a = await openDoc();
    const again: DocumentSessionInfo = await (await handler(req("POST", "/api/docs", { path: file }))).json();
    expect(again.docId).toBe(a.docId);
    expect((await (await handler(req("GET", "/api/docs"))).json()).docs).toHaveLength(1);
  });

  test("the server-level stream announces opens and closes to the switcher", () => {
    // Doc-scoped SSE can't announce a doc a client hasn't subscribed to yet, so
    // the switcher learns about opens/closes from this server-level signal.
    const events: string[] = [];
    const controller = {
      enqueue: (bytes: Uint8Array) => events.push(new TextDecoder().decode(bytes)),
      close: () => {},
    } as unknown as ReadableStreamDefaultController<Uint8Array>;
    manager.subscribeServer(controller);

    const { session } = manager.openOrGet(file);
    manager.openOrGet(secondDoc());
    manager.close(session.docId);

    const opened = events.filter((e) => e.includes("document.opened")).length;
    const closed = events.filter((e) => e.includes("document.closed")).length;
    expect(opened).toBe(2);
    expect(closed).toBe(1);
  });

  test("registryDocs reflects every open document for the registry file", () => {
    manager.openOrGet(file);
    manager.openOrGet(secondDoc());
    const docs = manager.registryDocs();
    expect(docs).toHaveLength(2);
    expect(new Set(docs.map((d) => d.path)).size).toBe(2);
  });
});

describe("reuseRunningServer (start reuses a running server)", () => {
  function fakeFetchTo(h: typeof handler): typeof fetch {
    return ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const rest = url.replace("http://server.local/", "");
      return h(new Request(`http://127.0.0.1/${rest}`, init));
    }) as unknown as typeof fetch;
  }

  function registerSelf(serversDir: string): void {
    // Use our own pid so readServerRecords keeps the entry (it prunes dead pids).
    writeServerRecord(serversDir, {
      url: "http://server.local/",
      pid: process.pid,
      startedAt: new Date().toISOString(),
      docs: [],
    });
  }

  test("opens the file on the running server instead of binding a second one", async () => {
    const serversDir = path.join(dir, "servers");
    registerSelf(serversDir);
    const msg = await reuseRunningServer(
      { documentPath: file, host: "127.0.0.1", port: 7331 },
      { serversDir, fetchImpl: fakeFetchTo(handler) },
    );
    expect(msg).not.toBeNull();
    expect(msg).toContain("already running");
    expect(msg).toMatch(/\?doc=doc_/);
    // The doc is now open on that server.
    const list = await (await handler(req("GET", "/api/docs"))).json();
    expect(list.docs).toHaveLength(1);
  });

  test("returns null (start fresh) with --port or no file", async () => {
    const serversDir = path.join(dir, "servers");
    registerSelf(serversDir);
    const fetchImpl = fakeFetchTo(handler);
    const base = { documentPath: file, host: "127.0.0.1", port: 7331 };
    expect(await reuseRunningServer({ ...base, portExplicit: true }, { serversDir, fetchImpl })).toBeNull();
    expect(await reuseRunningServer({ host: "127.0.0.1", port: 7331 }, { serversDir, fetchImpl })).toBeNull();
  });

  test("returns null when no server is registered (so a fresh one starts)", async () => {
    const serversDir = path.join(dir, "servers-empty");
    const msg = await reuseRunningServer(
      { documentPath: file, host: "127.0.0.1", port: 7331 },
      { serversDir, fetchImpl: fakeFetchTo(handler) },
    );
    expect(msg).toBeNull();
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

  test("an idle tick on an unchanged file is a no-op (cheap stat path)", async () => {
    const { docId } = await openDoc();
    const before = manager.get(docId)!.version;
    const mtimeBefore = fs.statSync(file).mtimeMs;
    // Several idle ticks: unchanged mtime+size must not trigger a read, reconcile,
    // or self-heal write — the version and the file's mtime stay put.
    manager.checkExternalChanges();
    manager.checkExternalChanges();
    expect(manager.get(docId)!.version).toBe(before);
    expect(fs.statSync(file).mtimeMs).toBe(mtimeBefore);
  });
});
