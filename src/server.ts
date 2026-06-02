import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleAgentRequest } from "./agent-routes";
import { handleCommentRequest } from "./comment-routes";
import {
  applyAgentUpdate,
  openDocumentForReview,
  readDocumentState,
  resolveDocumentPath,
  writeDocumentHtml,
  type AgentUpdateInput,
  type DocumentState,
} from "./state";

export interface ServerOptions {
  documentPath: string;
  host: string;
  port: number;
}

interface ServerRuntime {
  options: ServerOptions;
  latestVersion: string;
  eventClients: Set<ReadableStreamDefaultController<Uint8Array>>;
  serverUrl?: string;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "../public");
const stateDir = path.resolve(process.cwd(), ".redline");
const textEncoder = new TextEncoder();

if (import.meta.main) {
  startServer(parseArgs(Bun.argv.slice(2)));
}

export function createRequestHandler(options: ServerOptions): (request: Request) => Promise<Response> {
  const runtime = createRuntime(options);
  runtime.latestVersion = openDocumentForReview(runtime.options.documentPath).version;
  return async (request) => {
    try {
      return await handleRequest(request, runtime);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown server error.";
      return json({ error: message }, 500);
    }
  };
}

function startServer(options: ServerOptions): void {
  const runtime = createRuntime(options);
  const openedState = openDocumentForReview(runtime.options.documentPath);
  const server = Bun.serve({
    hostname: runtime.options.host,
    port: runtime.options.port,
    // The /api/events SSE stream is long-lived and only sends data when the
    // document changes. Bun's default 10s idleTimeout would drop it (and log a
    // warning) on every quiet stretch; a heartbeat keeps it under this ceiling.
    idleTimeout: 120,
    async fetch(request) {
      try {
        return await handleRequest(request, runtime);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown server error.";
        return json({ error: message }, 500);
      }
    },
  });

  runtime.serverUrl = server.url.toString();
  writeServerState(runtime.serverUrl, runtime.options.documentPath);
  runtime.latestVersion = openedState.version;
  setInterval(() => pollForExternalChanges(runtime), 750).unref?.();

  console.log(`Redline is serving ${runtime.options.documentPath}`);
  console.log(`Open ${server.url}`);
  console.log(`Agent state: ${new URL("/api/agent/state", server.url)}`);
}

function createRuntime(options: ServerOptions): ServerRuntime {
  return {
    options: { ...options },
    latestVersion: "",
    eventClients: new Set<ReadableStreamDefaultController<Uint8Array>>(),
  };
}

async function handleRequest(request: Request, runtime: ServerRuntime): Promise<Response> {
  const url = new URL(request.url);

  // The API can read/write/switch files on disk. Block requests carrying a
  // foreign Origin so a malicious web page (or a DNS-rebinding attack) can't
  // drive these endpoints against your machine. Same-origin requests, the CLI,
  // and curl send no foreign Origin and are unaffected.
  if (url.pathname.startsWith("/api/") && !isLoopbackOrigin(request)) {
    return json({ error: "Cross-origin requests are not allowed." }, 403);
  }

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders() });
  }

  if (url.pathname === "/api/health") {
    return json({ ok: true, documentPath: runtime.options.documentPath });
  }

  if (url.pathname === "/api/state" || url.pathname === "/api/agent/state") {
    return json(readDocumentState(runtime.options.documentPath));
  }

  const agentResponse = handleAgentRequest(request, {
    documentPath: runtime.options.documentPath,
  });
  if (agentResponse) return agentResponse;

  if (url.pathname === "/api/open" && request.method === "POST") {
    const body = await readJson<{ path?: unknown }>(request);
    if (typeof body.path !== "string" || !body.path.trim()) {
      return json({ error: "A file path is required." }, 400);
    }
    return openTarget(runtime, expandPath(body.path));
  }

  if (url.pathname === "/api/open-dialog" && request.method === "POST") {
    let picked: string | null;
    try {
      picked = await pickFileWithNativeDialog(path.dirname(runtime.options.documentPath), request.signal);
    } catch (error) {
      const message = error instanceof Error ? error.message : "The file picker failed.";
      return json({ error: message }, 500);
    }
    if (picked === null) {
      return json({ cancelled: true });
    }
    return openTarget(runtime, picked);
  }

  if (url.pathname === "/api/document" && request.method === "PUT") {
    const body = await readJson<{ html?: unknown; expectedVersion?: unknown }>(request);
    if (typeof body.html !== "string") {
      return json({ error: "html is required." }, 400);
    }
    if (
      typeof body.expectedVersion === "string" &&
      body.expectedVersion !== readDocumentState(runtime.options.documentPath).version
    ) {
      return json(
        {
          error: "Document changed before this save completed.",
          current: readDocumentState(runtime.options.documentPath),
        },
        409,
      );
    }
    return changed(runtime, writeDocumentHtml(runtime.options.documentPath, body.html), "document.saved");
  }

  const commentResponse = await handleCommentRequest(request, {
    documentPath: runtime.options.documentPath,
    changed: (state, reason) => changed(runtime, state, reason),
  });
  if (commentResponse) return commentResponse;

  if (url.pathname === "/api/agent/update" && request.method === "POST") {
    const body = await readJson<AgentUpdateInput>(request);
    return changed(runtime, applyAgentUpdate(runtime.options.documentPath, body), "agent.updated");
  }

  if (url.pathname === "/api/events") {
    return eventStream(runtime);
  }

  if (url.pathname.startsWith("/document-assets/")) {
    return serveDocumentAsset(runtime, url.pathname);
  }

  return serveStatic(url.pathname);
}

function changed(runtime: ServerRuntime, state: DocumentState, reason: string): Response {
  runtime.latestVersion = state.version;
  broadcast(runtime, reason, state);
  return json(state);
}

// Validate and switch the served document. Redline only renders HTML, so reject
// anything that isn't an existing .html/.htm file (the picker filter is only a
// hint — this is the actual guard).
function openTarget(runtime: ServerRuntime, target: string): Response {
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    return json({ error: `Not a file: ${target}` }, 404);
  }
  if (!/\.html?$/i.test(target)) {
    return json({ error: "Redline can only open .html or .htm files." }, 415);
  }
  runtime.options.documentPath = target;
  if (runtime.serverUrl) {
    writeServerState(runtime.serverUrl, runtime.options.documentPath);
  }
  console.log(`Redline switched to ${runtime.options.documentPath}`);
  return changed(runtime, openDocumentForReview(runtime.options.documentPath), "document.opened");
}

function pollForExternalChanges(runtime: ServerRuntime): void {
  try {
    const state = readDocumentState(runtime.options.documentPath);
    if (state.version === runtime.latestVersion) return;
    runtime.latestVersion = state.version;
    broadcast(runtime, "external.changed", state);
  } catch {
    // Keep the server alive if an editor temporarily swaps files on disk.
  }
}

function broadcast(
  runtime: ServerRuntime,
  reason: string,
  state = readDocumentState(runtime.options.documentPath),
): void {
  const payload = `event: state\ndata: ${JSON.stringify({
    reason,
    version: state.version,
    updatedAt: state.updatedAt,
    summary: state.summary,
  })}\n\n`;

  for (const client of [...runtime.eventClients]) {
    try {
      client.enqueue(textEncoder.encode(payload));
    } catch {
      runtime.eventClients.delete(client);
    }
  }
}

function eventStream(runtime: ServerRuntime): Response {
  let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
      runtime.eventClients.add(controller);
      controller.enqueue(textEncoder.encode("event: connected\ndata: {}\n\n"));
      // Comment line every 25s keeps the connection active so it never trips
      // the idleTimeout during quiet periods.
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(textEncoder.encode(": keepalive\n\n"));
        } catch {
          clearInterval(heartbeat);
          runtime.eventClients.delete(controller);
        }
      }, 25_000);
      heartbeat.unref?.();
    },
    cancel() {
      clearInterval(heartbeat);
      if (streamController) {
        runtime.eventClients.delete(streamController);
      }
    },
  });

  return new Response(stream, {
    headers: {
      ...corsHeaders(),
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    },
  });
}

async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
}

function serveStatic(urlPath: string): Response {
  const requested = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const absolutePath = path.resolve(publicDir, requested);
  if (!isInside(publicDir, absolutePath) || !fs.existsSync(absolutePath)) {
    return new Response("Not found", { status: 404 });
  }
  return new Response(Bun.file(absolutePath), {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}

function serveDocumentAsset(runtime: ServerRuntime, urlPath: string): Response {
  const relativePath = decodeURIComponent(urlPath.replace(/^\/document-assets\/?/, ""));
  const documentDir = path.dirname(runtime.options.documentPath);
  const absolutePath = path.resolve(documentDir, relativePath);
  if (!isInside(documentDir, absolutePath) || !fs.existsSync(absolutePath)) {
    return new Response("Not found", { status: 404 });
  }
  return new Response(Bun.file(absolutePath), {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}

function expandPath(input: string): string {
  let value = input.trim();
  if (value === "~") {
    value = os.homedir();
  } else if (value.startsWith("~/")) {
    value = path.join(os.homedir(), value.slice(2));
  }
  return path.resolve(process.cwd(), value);
}

// Only one native dialog at a time, so repeated requests can't stack Finder
// windows and leave orphaned osascript processes.
let dialogInFlight = false;

// Open the OS-native file picker (macOS) so the user browses with Finder and we
// still get the real absolute path the server needs. Returns null if cancelled.
async function pickFileWithNativeDialog(
  startDir: string,
  signal?: AbortSignal,
): Promise<string | null> {
  if (process.platform !== "darwin") {
    throw new Error(
      "The native file picker is only available on macOS. Use POST /api/open with a path instead.",
    );
  }
  if (dialogInFlight) {
    throw new Error("A file dialog is already open.");
  }
  dialogInFlight = true;

  const start = startDir && fs.existsSync(startDir) ? startDir : "";
  const proc = Bun.spawn(
    [
      "osascript",
      "-e", "on run argv",
      "-e", "set startDir to item 1 of argv",
      "-e", 'if startDir is not "" then',
      "-e", 'set chosen to choose file of type {"public.html"} default location (POSIX file startDir) with prompt "Open a document in Redline"',
      "-e", "else",
      "-e", 'set chosen to choose file of type {"public.html"} with prompt "Open a document in Redline"',
      "-e", "end if",
      "-e", "POSIX path of chosen",
      "-e", "end run",
      start,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );

  // If the browser request is abandoned (tab closed, navigation), kill the
  // dialog instead of leaving osascript blocked on user input forever.
  const onAbort = () => proc.kill();
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = (await new Response(proc.stderr).text()).trim();
      // osascript reports a user cancel (or an abort kill) as error -128.
      if (/-128/.test(stderr) || /User canceled/i.test(stderr) || signal?.aborted) {
        return null;
      }
      throw new Error(stderr || "The file picker could not be opened.");
    }
    const stdout = (await new Response(proc.stdout).text()).trim();
    return stdout || null;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    dialogInFlight = false;
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: {
      ...corsHeaders(),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

// Allow the request only if it carries no Origin (CLI, curl, same-origin GET)
// or a loopback Origin (the local SPA, possibly on another local port). Any
// real remote site sends its own non-loopback Origin and is rejected.
function isLoopbackOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    const host = new URL(origin).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    return false;
  }
}

function corsHeaders(): Record<string, string> {
  // No wildcard Access-Control-Allow-Origin: foreign origins are already
  // rejected by isLoopbackOrigin, and the same-origin SPA needs no CORS.
  return {
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  };
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function writeServerState(url: string, documentPath: string): void {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "server.json"),
    `${JSON.stringify(
      {
        url,
        documentPath,
        pid: process.pid,
        startedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function parseArgs(args: string[]): ServerOptions {
  let documentArg: string | undefined;
  let host = "127.0.0.1";
  let port = 7331;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;

    if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    }

    if (arg === "--host") {
      host = requireValue(args, index, "--host");
      index += 1;
      continue;
    }

    if (arg === "--port" || arg === "-p") {
      port = parsePort(requireValue(args, index, arg));
      index += 1;
      continue;
    }

    if (arg.startsWith("--port=")) {
      port = parsePort(arg.slice("--port=".length));
      continue;
    }

    if (arg.startsWith("-p=")) {
      port = parsePort(arg.slice("-p=".length));
      continue;
    }

    if (arg.startsWith("--host=")) {
      host = arg.slice("--host=".length);
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown flag: ${arg}`);
    }

    documentArg = arg;
  }

  return {
    documentPath: resolveDocumentPath(documentArg),
    host,
    port,
  };
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function parsePort(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error("--port must be a positive integer.");
  }
  const port = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("--port must be between 1 and 65535.");
  }
  return port;
}

function printHelp(): void {
  console.log(`Usage:
  bun run start -- [document.html] [--port 7331] [--host 127.0.0.1]
  bun run start -- [document.html] -p 8099

The server creates documents/sample.html when no document path is provided.
Agent-readable state is available at /api/agent/state and in embedded review
JSON inside the HTML file.`);
}
