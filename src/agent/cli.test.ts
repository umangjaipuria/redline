import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCli, type CliDeps } from "./cli";
import { createRequestHandler } from "../server/server";
import { SessionManager } from "../server/sessions";
import { writeServerRecord } from "../server/registry";

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
let serversDir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "redline-cli-"));
  file = path.join(dir, "doc.html");
  fs.writeFileSync(file, DOC, "utf8");
  serversDir = path.join(dir, "servers");
  fs.mkdirSync(serversDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function deps(overrides: Partial<CliDeps> = {}): Partial<CliDeps> {
  return { serversDir, ...overrides };
}

describe("direct mode (no server)", () => {
  test("comment then comments lists the thread", async () => {
    const created = await runCli(["comment", file, "new dashboard", "Needs a source"], deps());
    expect(created.code).toBe(0);
    const list = await runCli(["comments", file], deps());
    expect(list.code).toBe(0);
    const parsed = JSON.parse(list.output);
    expect(parsed.threads).toHaveLength(1);
    expect(parsed.threads[0].state).toBe("anchored");
    expect(parsed.threads[0].author).toBe("AI");
  });

  test("ambiguous quote fails with a helpful message", async () => {
    const res = await runCli(["comment", file, "The", "x"], deps());
    expect(res.code).toBe(1);
    expect(res.output).toContain("occurrence");
  });

  test("reply, edit-message, delete-reply, delete-thread", async () => {
    const created = JSON.parse((await runCli(["comment", file, "redesign", "first"], deps())).output);
    const threadId = created.threads[0].id;
    const replied = JSON.parse((await runCli(["reply", file, threadId, "second", "--author", "Codex"], deps())).output);
    expect(replied.threads[0].messages).toHaveLength(2);
    const messageId = replied.threads[0].messages[1].id;
    const edited = JSON.parse((await runCli(["edit-message", file, threadId, messageId, "second!"], deps())).output);
    expect(edited.threads[0].messages[1].body).toBe("second!");
    const deletedReply = JSON.parse((await runCli(["delete-reply", file, threadId, messageId], deps())).output);
    expect(deletedReply.threads[0].messages).toHaveLength(1);
    const deleted = JSON.parse((await runCli(["delete-thread", file, threadId], deps())).output);
    expect(deleted.threads).toHaveLength(0);
  });

  test("anchors report + reanchor after an edit", async () => {
    const created = JSON.parse((await runCli(["comment", file, "metrics are accurate", "verify"], deps())).output);
    const threadId = created.threads[0].id;
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("The metrics are accurate.", "The KPIs look solid."), "utf8");
    const report = JSON.parse((await runCli(["anchors", file], deps())).output);
    expect(report.anchors[0].state).toBe("orphaned");
    const fixed = JSON.parse((await runCli(["reanchor", file, threadId, "--quote", "KPIs look solid"], deps())).output);
    expect(fixed.anchors[0].state).toBe("anchored");
  });

  test("apply runs a batch", async () => {
    const payload = path.join(dir, "batch.json");
    fs.writeFileSync(
      payload,
      JSON.stringify({ comments: [{ quote: "redesign", body: "nice", author: "Codex" }] }),
    );
    const result = JSON.parse((await runCli(["apply", file, payload], deps())).output);
    expect(result.threads).toHaveLength(1);
  });

  test("info returns metadata without content", async () => {
    const info = JSON.parse((await runCli(["info", file], deps())).output);
    expect(info.format).toBe("html");
    expect(info.summary.threads).toBe(0);
    expect(info.renderedHtml).toBeUndefined();
  });

  test("servers reports none running", async () => {
    const res = await runCli(["servers"], deps());
    expect(res.output).toContain("No Redline servers");
  });

  test("redline <file> starts a server and opens the document URL", async () => {
    const opened: string[] = [];
    const res = await runCli([file], deps({
      openBrowser: (url) => {
        opened.push(url);
      },
      startServer: async (openedFile) => ({
        url: "http://server.local/",
        pid: process.pid,
        startedAt: new Date().toISOString(),
        docs: [{ docId: "doc_cli", path: path.resolve(openedFile!) }],
      }),
    }));
    expect(res.code).toBe(0);
    expect(res.output).toContain(`Redline is serving ${file}`);
    expect(res.output).toContain("http://server.local/?doc=doc_cli");
    expect(opened).toEqual(["http://server.local/?doc=doc_cli"]);
  });

  test("bare redline opens an existing server URL", async () => {
    writeServerRecord(serversDir, {
      url: "http://server.local/",
      pid: process.pid,
      startedAt: new Date().toISOString(),
      docs: [],
    });
    const opened: string[] = [];
    const res = await runCli([], deps({
      openBrowser: (url) => {
        opened.push(url);
      },
      startServer: async () => {
        throw new Error("should reuse the registered server");
      },
    }));
    expect(res.code).toBe(0);
    expect(res.output).toContain("Redline is serving");
    expect(res.output).toContain("http://server.local/");
    expect(opened).toEqual(["http://server.local/"]);
  });

  test("bare redline starts and opens a server when none is running", async () => {
    const opened: string[] = [];
    const res = await runCli([], deps({
      openBrowser: (url) => {
        opened.push(url);
      },
      startServer: async () => ({
        url: "http://fresh.local/",
        pid: process.pid,
        startedAt: new Date().toISOString(),
        docs: [],
      }),
    }));
    expect(res.code).toBe(0);
    expect(res.output).toContain("http://fresh.local/");
    expect(opened).toEqual(["http://fresh.local/"]);
  });
});

describe("registry routing (live server)", () => {
  test("routes a comment through the server holding the doc open", async () => {
    const manager = new SessionManager();
    const handler = createRequestHandler({
      manager,
      serverInfo: () => ({ url: "http://127.0.0.1/", pid: 1, startedAt: "now", docs: [] }),
    });
    const { session } = manager.openOrGet(file);

    // Register a fake server whose URL is served by our in-memory handler.
    writeServerRecord(serversDir, {
      url: "http://server.local/",
      pid: 999999,
      startedAt: new Date().toISOString(),
      docs: [{ docId: session.docId, path: session.path }],
    });
    // pid must look alive; use our own pid so readServerRecords keeps it.
    writeServerRecord(serversDir, {
      url: "http://server.local/",
      pid: process.pid,
      startedAt: new Date().toISOString(),
      docs: [{ docId: session.docId, path: session.path }],
    });

    const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const rest = url.replace("http://server.local/", "");
      return handler(new Request(`http://127.0.0.1/${rest}`, init));
    }) as unknown as typeof fetch;

    const res = await runCli(["comment", file, "redesign", "via server", "--author", "Codex"], {
      serversDir,
      fetchImpl,
    });
    expect(res.code).toBe(0);
    // The comment landed on the server's session, visible via its state.
    const state = await (await handler(new Request(`http://127.0.0.1/api/docs/${session.docId}/state`))).json();
    expect(state.threads).toHaveLength(1);
    expect(state.threads[0].author).toBe("Codex");
    manager.closeAll();
  });
});
