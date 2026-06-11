// The Redline CLI. Every file-path command auto-discovers a running server via
// the registry: if a server already holds the document open, the command routes
// through it (so the browser updates live and anchor writes are serialized);
// otherwise it operates on the file directly. The direct-write path is the floor;
// server coordination is an optimization on top.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  agentCommentIndex,
  agentThread,
  appendReply,
  applyAgentUpdate,
  createComment,
  deleteReply,
  deleteThread,
  editMessage,
  listAnchors,
  reanchor,
  readDocument,
} from "../app";
import { expandPath } from "../server/files";
import { openBrowserTab, type OpenBrowser } from "../server/browser";
import {
  SERVERS_DIR,
  findServerForPath,
  readServerRecords,
  type ServerRecord,
} from "../server/registry";
import type { AgentUpdate } from "../shared";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.resolve(__dirname, "../server/server.ts");

export interface CliDeps {
  serversDir: string;
  fetchImpl: typeof fetch;
  startServer: (file: string | undefined, deps: CliDeps) => Promise<ServerRecord>;
  openBrowser: OpenBrowser;
}

const defaultDeps: CliDeps = {
  serversDir: SERVERS_DIR,
  fetchImpl: globalThis.fetch,
  startServer: spawnServer,
  openBrowser: openBrowserTab,
};

export interface CliResult {
  output: string;
  code: number;
}

export async function runCli(argv: string[], overrides: Partial<CliDeps> = {}): Promise<CliResult> {
  const deps: CliDeps = { ...defaultDeps, ...overrides };
  const [command, ...args] = argv;
  try {
    const output = await dispatch(command, args, deps);
    return { output, code: 0 };
  } catch (error) {
    return { output: error instanceof Error ? error.message : String(error), code: 1 };
  }
}

async function dispatch(command: string | undefined, args: string[], deps: CliDeps): Promise<string> {
  switch (command) {
    case undefined:
      return openHome(deps);
    case "-h":
    case "--help":
      return helpText();

    // --- launch & session ---
    case "servers":
      return listServers(deps);
    case "close":
      return closeDoc(requireFile(args[0]), deps);
    case "docid":
      return resolveDocId(requireFile(args[0]), deps);

    // --- reading ---
    case "comments":
      return readCommand(requireFile(args[0]), deps, {
        server: (url, docId) => getJson(deps, `${url}api/docs/${docId}/agent/comments/index`),
        direct: (file) => agentCommentIndex(file),
      });
    case "anchors": {
      const { value: inRange, rest } = takeOption(args.slice(1), "--in");
      void rest;
      const file = requireFile(args[0]);
      const range = parseRange(inRange);
      return readCommand(file, deps, {
        server: (url, docId) => getJson(deps, `${url}api/docs/${docId}/anchors${inRange ? `?in=${inRange}` : ""}`),
        direct: (f) => listAnchors(f, range),
      });
    }
    case "thread": {
      const file = requireFile(args[0]);
      const threadId = requireArg(args[1], "thread requires a thread id.");
      return readCommand(file, deps, {
        server: (url, docId) => getJson(deps, `${url}api/docs/${docId}/agent/comments/${encodeURIComponent(threadId)}`),
        direct: (f) => agentThread(f, threadId),
      });
    }
    case "info":
      return readCommand(requireFile(args[0]), deps, {
        server: (url, docId) => getJson(deps, `${url}api/docs/${docId}/agent/info`),
        direct: (f) => documentInfo(f),
      });

    // --- comment writes ---
    case "comment":
      return commentCommand(args, deps);
    case "reply":
      return replyCommand(args, deps);
    case "edit-message":
      return editMessageCommand(args, deps);
    case "delete-reply":
      return deleteReplyCommand(args, deps);
    case "delete-thread":
      return deleteThreadCommand(args, deps);

    // --- anchor writes & batch ---
    case "reanchor":
      return reanchorCommand(args, deps);
    case "apply":
      return applyCommand(args, deps);

    // --- launch ---
    default:
      // `redline <file>` opens/focuses the document and prints its URL.
      if (command && !command.startsWith("-")) {
        return openDoc(requireFile(command), deps);
      }
      throw new Error(`Unknown command: ${command}`);
  }
}

// --- routing -------------------------------------------------------------

interface ServerTarget {
  url: string;
  docId: string;
}

// The server hosting this file's canonical path, if one has it open. When more
// than one live server claims the same path, the freshest wins deterministically
// (findServerForPath sorts by startedAt) and we warn — a stale entry or a second
// server shouldn't silently misroute writes.
function serverTargetFor(canonical: string, deps: CliDeps): ServerTarget | undefined {
  const claimants = readServerRecords(deps.serversDir).filter((record) =>
    record.docs.some((entry) => entry.path === canonical),
  );
  if (claimants.length === 0) return undefined;
  if (claimants.length > 1) {
    console.warn(
      `Warning: ${claimants.length} servers report ${canonical} open (${claimants
        .map((r) => r.url)
        .join(", ")}). Routing to the most recently started (${claimants[0]!.url}).`,
    );
  }
  const record = claimants[0]!;
  const doc = record.docs.find((entry) => entry.path === canonical)!;
  return { url: record.url, docId: doc.docId };
}

async function readCommand(
  file: string,
  deps: CliDeps,
  handlers: { server: (url: string, docId: string) => Promise<unknown>; direct: (file: string) => unknown },
): Promise<string> {
  const canonical = path.resolve(file);
  const target = serverTargetFor(canonical, deps);
  const result = target ? await handlers.server(target.url, target.docId) : handlers.direct(canonical);
  return pretty(result);
}

async function writeCommand(
  file: string,
  deps: CliDeps,
  handlers: { server: (url: string, docId: string) => Promise<unknown>; direct: (file: string) => unknown },
): Promise<string> {
  const canonical = path.resolve(file);
  const target = serverTargetFor(canonical, deps);
  const result = target ? await handlers.server(target.url, target.docId) : handlers.direct(canonical);
  return pretty(result);
}

// --- commands ------------------------------------------------------------

async function commentCommand(args: string[], deps: CliDeps): Promise<string> {
  const file = requireFile(args[0]);
  const quote = requireArg(args[1], 'comment requires the quoted target text.');
  const withAuthor = takeAuthor(args.slice(2), "AI");
  const withOccurrence = takeOption(withAuthor.rest, "--occurrence");
  const occurrence = parseOccurrence(withOccurrence.value);
  const body = withOccurrence.rest.join(" ").trim();
  if (!body) throw new Error("comment requires a message body.");

  return writeCommand(file, deps, {
    server: (url, docId) =>
      postJson(deps, `${url}api/docs/${docId}/comments`, {
        message: body,
        quote,
        author: withAuthor.author,
        ...(occurrence !== undefined ? { occurrence } : {}),
      }),
    direct: (f) =>
      createComment(
        f,
        { message: body, quote, author: withAuthor.author, ...(occurrence !== undefined ? { occurrence } : {}) },
        { defaultAuthor: "AI" },
      ),
  });
}

async function replyCommand(args: string[], deps: CliDeps): Promise<string> {
  const file = requireFile(args[0]);
  const threadId = requireArg(args[1], "reply requires a thread id.");
  const withAuthor = takeAuthor(args.slice(2), "AI");
  const body = withAuthor.rest.join(" ").trim();
  if (!body) throw new Error("reply requires a message body.");

  return writeCommand(file, deps, {
    server: (url, docId) =>
      postJson(deps, `${url}api/docs/${docId}/comments/${encodeURIComponent(threadId)}/replies`, {
        body,
        author: withAuthor.author,
      }),
    direct: (f) => appendReply(f, threadId, body, { author: withAuthor.author, defaultAuthor: "AI" }),
  });
}

async function editMessageCommand(args: string[], deps: CliDeps): Promise<string> {
  const file = requireFile(args[0]);
  const threadId = requireArg(args[1], "edit-message requires a thread id.");
  const messageId = requireArg(args[2], "edit-message requires a message id.");
  const body = args.slice(3).join(" ").trim();
  if (!body) throw new Error("edit-message requires a message body.");

  return writeCommand(file, deps, {
    server: (url, docId) =>
      putJson(
        deps,
        `${url}api/docs/${docId}/comments/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}`,
        { body },
      ),
    direct: (f) => editMessage(f, threadId, messageId, body),
  });
}

async function deleteReplyCommand(args: string[], deps: CliDeps): Promise<string> {
  const file = requireFile(args[0]);
  const threadId = requireArg(args[1], "delete-reply requires a thread id.");
  const messageId = requireArg(args[2], "delete-reply requires a message id.");

  return writeCommand(file, deps, {
    server: (url, docId) =>
      sendJson(
        deps,
        "DELETE",
        `${url}api/docs/${docId}/comments/${encodeURIComponent(threadId)}/replies/${encodeURIComponent(messageId)}`,
      ),
    direct: (f) => deleteReply(f, threadId, messageId),
  });
}

async function deleteThreadCommand(args: string[], deps: CliDeps): Promise<string> {
  const file = requireFile(args[0]);
  const threadId = requireArg(args[1], "delete-thread requires a thread id.");

  return writeCommand(file, deps, {
    server: (url, docId) =>
      sendJson(deps, "DELETE", `${url}api/docs/${docId}/comments/${encodeURIComponent(threadId)}`),
    direct: (f) => deleteThread(f, threadId),
  });
}

async function reanchorCommand(args: string[], deps: CliDeps): Promise<string> {
  const file = requireFile(args[0]);
  const threadId = requireArg(args[1], "reanchor requires a thread id.");
  const withQuote = takeOption(args.slice(2), "--quote");
  const quote = requireArg(withQuote.value, "reanchor requires --quote \"<new text>\".");
  const withOccurrence = takeOption(withQuote.rest, "--occurrence");
  const occurrence = parseOccurrence(withOccurrence.value);

  return writeCommand(file, deps, {
    server: (url, docId) =>
      postJson(deps, `${url}api/docs/${docId}/anchors/${encodeURIComponent(threadId)}/reanchor`, {
        quote,
        ...(occurrence !== undefined ? { occurrence } : {}),
      }),
    direct: (f) => reanchor(f, threadId, quote, occurrence !== undefined ? { occurrence } : {}),
  });
}

async function applyCommand(args: string[], deps: CliDeps): Promise<string> {
  const file = requireFile(args[0]);
  const payloadPath = requireArg(args[1], "apply requires a JSON payload file.");
  const payload = JSON.parse(fs.readFileSync(path.resolve(payloadPath), "utf8")) as AgentUpdate;

  return writeCommand(file, deps, {
    server: (url, docId) => postJson(deps, `${url}api/docs/${docId}/agent/update`, payload),
    direct: (f) => applyAgentUpdate(f, payload, { defaultAuthor: "AI" }),
  });
}

function documentInfo(file: string): unknown {
  const view = readDocument(file);
  return {
    path: view.path,
    format: view.format,
    version: view.version,
    updatedAt: view.updatedAt,
    ...(view.title ? { title: view.title } : {}),
    summary: view.summary,
    ...(view.warning ? { warning: view.warning } : {}),
  };
}

// --- launch / session ----------------------------------------------------

async function openDoc(file: string, deps: CliDeps): Promise<string> {
  const canonical = path.resolve(file);
  if (!fs.existsSync(canonical)) throw new Error(`Not a file: ${canonical}`);
  const { url, docId } = await ensureServerWithDoc(canonical, deps);
  const browserUrl = docUrl(url, docId);
  await deps.openBrowser(browserUrl);
  return `Redline is serving ${canonical}\n${browserUrl}`;
}

async function openHome(deps: CliDeps): Promise<string> {
  const { url } = await ensureServer(deps);
  await deps.openBrowser(url);
  return `Redline is serving\n${url}`;
}

async function resolveDocId(file: string, deps: CliDeps): Promise<string> {
  const canonical = path.resolve(file);
  const { docId } = await ensureServerWithDoc(canonical, deps);
  return docId;
}

async function closeDoc(file: string, deps: CliDeps): Promise<string> {
  const canonical = path.resolve(file);
  const target = serverTargetFor(canonical, deps);
  if (!target) return `No running server has ${canonical} open.`;
  await sendJson(deps, "DELETE", `${target.url}api/docs/${target.docId}`);
  return `Closed ${canonical} on ${target.url}`;
}

function listServers(deps: CliDeps): string {
  const records = readServerRecords(deps.serversDir);
  if (records.length === 0) return "No Redline servers are running.";
  return pretty(
    records.map((record) => ({
      url: record.url,
      pid: record.pid,
      startedAt: record.startedAt,
      docs: record.docs,
    })),
  );
}

// Ensure SOME server has this file open, returning its url + the doc's id. Opens
// on an existing server if one is running, else starts a fresh server. The docId
// comes from the POST /api/docs RESPONSE, not the registry file, so it is correct
// even before the registry has flushed.
async function ensureServerWithDoc(
  canonical: string,
  deps: CliDeps,
): Promise<{ url: string; docId: string }> {
  const hosting = serverTargetFor(canonical, deps);
  if (hosting) return hosting;

  const running = readServerRecords(deps.serversDir);
  if (running.length > 0) {
    const server = running[0]!;
    const info = (await postJson(deps, `${server.url}api/docs`, { path: canonical })) as {
      docId?: string;
    };
    if (!info.docId) throw new Error("Server did not return a docId for the opened document.");
    return { url: server.url, docId: info.docId };
  }

  const record = await deps.startServer(canonical, deps);
  const docId = record.docs.find((entry) => entry.path === canonical)?.docId;
  if (!docId) throw new Error("Started a server but it did not report the document's docId.");
  return { url: record.url, docId };
}

async function ensureServer(deps: CliDeps): Promise<{ url: string }> {
  const running = readServerRecords(deps.serversDir);
  if (running.length > 0) return { url: running[0]!.url };

  const record = await deps.startServer(undefined, deps);
  return { url: record.url };
}

function docUrl(url: string, docId: string): string {
  return `${url}?doc=${encodeURIComponent(docId)}`;
}

// --- HTTP helpers --------------------------------------------------------

async function getJson(deps: CliDeps, url: string): Promise<unknown> {
  return sendJson(deps, "GET", url);
}

async function postJson(deps: CliDeps, url: string, body: unknown): Promise<unknown> {
  return sendJson(deps, "POST", url, body);
}

async function putJson(deps: CliDeps, url: string, body: unknown): Promise<unknown> {
  return sendJson(deps, "PUT", url, body);
}

async function sendJson(deps: CliDeps, method: string, url: string, body?: unknown): Promise<unknown> {
  const response = await deps.fetchImpl(url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const message = (parsed && typeof parsed === "object" && "error" in parsed && (parsed as { error: string }).error) || `Request failed (${response.status}).`;
    throw new Error(String(message));
  }
  return parsed;
}

// Start a detached server process and wait for it to register the document.
async function spawnServer(file: string | undefined, deps: CliDeps): Promise<ServerRecord> {
  const child = spawn("bun", file ? [serverEntry, file] : [serverEntry], {
    detached: true,
    env: { ...process.env, REDLINE_NO_BROWSER: "1" },
    stdio: "ignore",
  });
  child.unref();

  const canonical = file ? path.resolve(file) : undefined;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (canonical) {
      const record = findServerForPath(canonical, deps.serversDir);
      if (record) return record;
    }
    const pid = child.pid;
    if (pid !== undefined) {
      const record = readServerRecords(deps.serversDir).find((entry) => entry.pid === pid);
      if (record) return record;
    }
    await delay(150);
  }
  throw new Error("Started a server but it did not register in time.");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- arg parsing ---------------------------------------------------------

function requireFile(input: string | undefined): string {
  if (!input) throw new Error("A document path is required.");
  return expandPath(input);
}

function requireArg(value: string | undefined, message: string): string {
  if (value === undefined || value === "") throw new Error(message);
  return value;
}

function takeAuthor(parts: string[], fallback: string): { author: string; rest: string[] } {
  const index = parts.findIndex((part) => part === "--author");
  if (index === -1) return { author: fallback, rest: parts };
  const author = parts[index + 1];
  if (author === undefined) throw new Error("--author requires a value.");
  return { author: author.trim() || fallback, rest: [...parts.slice(0, index), ...parts.slice(index + 2)] };
}

function takeOption(parts: string[], flag: string): { value: string | undefined; rest: string[] } {
  const index = parts.findIndex((part) => part === flag);
  if (index === -1) return { value: undefined, rest: parts };
  const value = parts[index + 1];
  if (value === undefined) throw new Error(`${flag} requires a value.`);
  return { value, rest: [...parts.slice(0, index), ...parts.slice(index + 2)] };
}

function parseOccurrence(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(value)) throw new Error("--occurrence must be a positive 1-based integer.");
  return Number(value);
}

function parseRange(value: string | undefined): { start: number; end: number } | undefined {
  if (!value) return undefined;
  const match = value.match(/^(\d+):(\d+)$/);
  if (!match) throw new Error("--in must look like START:END (character offsets).");
  return { start: Number(match[1]), end: Number(match[2]) };
}

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function helpText(): string {
  return `Redline CLI

Launch & session:
  redline                              Open/focus Redline; open and print its URL.
  redline <file>                       Open/focus a document; open and print its URL.
  redline close <file>                 Close a document on its server.
  redline servers                      List running servers and their open docs.
  redline docid <file>                 Resolve a file path to its docId.

Reading:
  redline comments <file>              Compact thread list with anchor state.
  redline anchors <file> [--in A:B]    Anchor resolution report (reconcile report).
  redline thread <file> <thread-id>    One thread in full.
  redline info <file>                  Document metadata (no content).

Comment writes:
  redline comment <file> "<quote>" "<body>" [--occurrence N] [--author NAME]
  redline reply <file> <thread-id> "<body>" [--author NAME]
  redline edit-message <file> <thread-id> <message-id> "<body>"
  redline delete-reply <file> <thread-id> <message-id>
  redline delete-thread <file> <thread-id>

Anchor writes & batch:
  redline reanchor <file> <thread-id> --quote "<new text>" [--occurrence N]
  redline apply <file> <payload.json>  One atomic batch of comment/anchor ops.`;
}

if (import.meta.main) {
  runCli(Bun.argv.slice(2)).then((result) => {
    if (result.code === 0) {
      if (result.output) console.log(result.output);
    } else {
      console.error(result.output);
    }
    process.exit(result.code);
  });
}
