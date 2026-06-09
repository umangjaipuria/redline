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
  ConflictError,
  ValidationError,
  type DocumentView,
} from "../app";
import type {
  AgentUpdate,
  CreateCommentRequest,
  DocumentStateResponse,
  ServerInfo,
} from "../shared";
import { isDocId } from "./docid";
import { FileBrowseError, expandPath, listDirectory, pickFileNativeDialog } from "./files";
import {
  SERVERS_DIR,
  readServerRecords,
  removeServerRecord,
  serverRecordPath,
  writeServerRecord,
} from "./registry";
import { SessionError, SessionManager, type DocumentSession } from "./sessions";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, "../../dist");
const publicDir = path.resolve(__dirname, "../../public");
// The bundled how-it-works document, offered as an in-app onboarding doc from the
// landing page. Absent in some packaged builds — the endpoint reports null then.
const howtoPath = path.resolve(__dirname, "../../docs/howto.html");
const encoder = new TextEncoder();

export interface ServerHandlerContext {
  manager: SessionManager;
  serverInfo: () => ServerInfo;
}

// A request handler bound to a session manager. Exposed for tests (drive it with
// fetch-like Request objects) and reused by the live Bun.serve bootstrap.
export function createRequestHandler(ctx: ServerHandlerContext): (request: Request) => Promise<Response> {
  return async (request) => {
    try {
      return await handleRequest(request, ctx);
    } catch (error) {
      return errorResponse(error);
    }
  };
}

async function handleRequest(request: Request, ctx: ServerHandlerContext): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;

  // Block foreign-origin API calls (a malicious page or DNS-rebinding attack);
  // the CLI, curl, and same-origin requests carry no foreign Origin.
  if (pathname.startsWith("/api/") && !isLoopbackOrigin(request)) {
    return json({ error: "Cross-origin requests are not allowed." }, 403);
  }
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders() });
  }

  // --- server-level routes ------------------------------------------------
  if (pathname === "/api/health") {
    return json({ ok: true, docs: ctx.manager.list().length });
  }

  if (pathname === "/api/docs") {
    return handleDocsCollection(request, url, ctx);
  }

  if (pathname === "/api/files" && request.method === "GET") {
    const listing = listDirectory(url.searchParams.get("dir") ?? "");
    return json(listing);
  }

  if (pathname === "/api/howto" && request.method === "GET") {
    return json({ path: fs.existsSync(howtoPath) ? howtoPath : null });
  }

  if (pathname === "/api/open-dialog" && request.method === "POST") {
    const startDir = expandPath(url.searchParams.get("dir") ?? "");
    const picked = await pickFileNativeDialog(startDir, request.signal);
    if (picked === null) return json({ cancelled: true });
    const { session } = ctx.manager.openOrGet(picked);
    return json(ctx.manager.info(session));
  }

  if (pathname === "/api/events" && request.method === "GET") {
    return serverEventStream(ctx.manager);
  }

  // --- document-scoped routes ---------------------------------------------
  const docMatch = pathname.match(/^\/api\/docs\/([^/]+)(?:\/(.*))?$/);
  if (docMatch) {
    const docId = decodeURIComponent(docMatch[1]!);
    const rest = docMatch[2] ?? "";
    return handleDocScoped(request, ctx, docId, rest);
  }

  // --- static client ------------------------------------------------------
  return serveStatic(pathname);
}

async function handleDocsCollection(request: Request, url: URL, ctx: ServerHandlerContext): Promise<Response> {
  const { manager } = ctx;

  if (request.method === "GET") {
    const pathQuery = url.searchParams.get("path");
    if (pathQuery) {
      const session = manager.getByPath(expandPath(pathQuery));
      if (!session) return json({ error: "That path is not open. Use POST /api/docs to open it." }, 404);
      return json(manager.info(session));
    }
    return json({ docs: manager.list().map((session) => manager.info(session)) });
  }

  if (request.method === "POST") {
    const body = await readJson<{ path?: unknown }>(request);
    if (typeof body.path !== "string" || !body.path.trim()) {
      return json({ error: "A file path is required." }, 400);
    }
    const { session } = manager.openOrGet(expandPath(body.path));
    return json(manager.info(session));
  }

  return json({ error: "Method not allowed." }, 405);
}

async function handleDocScoped(
  request: Request,
  ctx: ServerHandlerContext,
  docId: string,
  rest: string,
): Promise<Response> {
  const { manager } = ctx;

  // Close: DELETE /api/docs/:docId
  if (rest === "" && request.method === "DELETE") {
    return manager.close(docId)
      ? json({ closed: true, docId })
      : unknownDoc();
  }

  const session = manager.get(docId);
  if (!session) return unknownDoc();
  if (!isDocId(docId)) return unknownDoc();

  if (rest === "" && request.method === "GET") {
    return json(manager.info(session));
  }

  if (rest === "state" && request.method === "GET") {
    return json(stateResponse(session, readDocument(session.path)));
  }

  if (rest === "events" && request.method === "GET") {
    return docEventStream(manager, session);
  }

  if (rest.startsWith("assets/")) {
    return serveDocAsset(session, rest.slice("assets/".length));
  }

  // Comments
  if (rest === "comments" && request.method === "POST") {
    const body = await readJson<CreateCommentRequest>(request);
    if (typeof body.message !== "string") return json({ error: "message is required." }, 400);
    const view = createComment(session.path, body, { defaultAuthor: "User" });
    return mutated(manager, session, view, "comment.created");
  }

  const replyMatch = rest.match(/^comments\/([^/]+)\/replies$/);
  if (replyMatch && request.method === "POST") {
    const body = await readJson<{ body?: unknown; author?: unknown; expectedVersion?: unknown }>(request);
    if (typeof body.body !== "string") return json({ error: "body is required." }, 400);
    const view = appendReply(session.path, decodeURIComponent(replyMatch[1]!), body.body, {
      author: typeof body.author === "string" ? body.author : undefined,
      expectedVersion: typeof body.expectedVersion === "string" ? body.expectedVersion : undefined,
      defaultAuthor: "User",
    });
    return mutated(manager, session, view, "comment.replied");
  }

  const messageMatch = rest.match(/^comments\/([^/]+)\/messages\/([^/]+)$/);
  if (messageMatch && request.method === "PUT") {
    const body = await readJson<{ body?: unknown; expectedVersion?: unknown }>(request);
    if (typeof body.body !== "string") return json({ error: "body is required." }, 400);
    const view = editMessage(
      session.path,
      decodeURIComponent(messageMatch[1]!),
      decodeURIComponent(messageMatch[2]!),
      body.body,
      { expectedVersion: typeof body.expectedVersion === "string" ? body.expectedVersion : undefined },
    );
    return mutated(manager, session, view, "comment.edited");
  }

  const deleteReplyMatch = rest.match(/^comments\/([^/]+)\/replies\/([^/]+)$/);
  if (deleteReplyMatch && request.method === "DELETE") {
    const view = deleteReply(
      session.path,
      decodeURIComponent(deleteReplyMatch[1]!),
      decodeURIComponent(deleteReplyMatch[2]!),
      { expectedVersion: expectedVersionFrom(request) },
    );
    return mutated(manager, session, view, "comment.deleted");
  }

  const deleteThreadMatch = rest.match(/^comments\/([^/]+)$/);
  if (deleteThreadMatch && request.method === "DELETE") {
    const view = deleteThread(session.path, decodeURIComponent(deleteThreadMatch[1]!), {
      expectedVersion: expectedVersionFrom(request),
    });
    return mutated(manager, session, view, "comment.deleted");
  }

  // Anchors
  if (rest === "anchors" && request.method === "GET") {
    const range = parseRange(new URL(request.url).searchParams.get("in"));
    return json(listAnchors(session.path, range));
  }

  const reanchorMatch = rest.match(/^anchors\/([^/]+)\/reanchor$/);
  if (reanchorMatch && request.method === "POST") {
    const body = await readJson<{ quote?: unknown; occurrence?: unknown; expectedVersion?: unknown }>(request);
    if (typeof body.quote !== "string") return json({ error: "quote is required." }, 400);
    const view = reanchor(session.path, decodeURIComponent(reanchorMatch[1]!), body.quote, {
      occurrence: typeof body.occurrence === "number" ? body.occurrence : undefined,
      expectedVersion: typeof body.expectedVersion === "string" ? body.expectedVersion : undefined,
    });
    return mutated(manager, session, view, "anchors.reconciled");
  }

  // Agent
  if (rest === "agent/comments/index" && request.method === "GET") {
    const since = new URL(request.url).searchParams.get("since") ?? undefined;
    return json(agentCommentIndex(session.path, since));
  }

  const agentThreadMatch = rest.match(/^agent\/comments\/([^/]+)$/);
  if (agentThreadMatch && request.method === "GET") {
    return json(agentThread(session.path, decodeURIComponent(agentThreadMatch[1]!)));
  }

  if (rest === "agent/info" && request.method === "GET") {
    const view = readDocument(session.path);
    return json({ ...manager.info(session), summary: view.summary, ...(view.warning ? { warning: view.warning } : {}) });
  }

  if (rest === "agent/update" && request.method === "POST") {
    const body = await readJson<AgentUpdate>(request);
    const view = applyAgentUpdate(session.path, body, { defaultAuthor: "AI" });
    return mutated(manager, session, view, "comment.created");
  }

  return json({ error: "Not found." }, 404);
}

function stateResponse(session: DocumentSession, view: DocumentView): DocumentStateResponse {
  const response: DocumentStateResponse = {
    docId: session.docId,
    path: session.path,
    format: view.format,
    version: view.version,
    updatedAt: view.updatedAt,
    renderedHtml: view.renderedHtml,
    threads: view.threads,
    anchors: view.anchors,
    summary: view.summary,
  };
  if (view.title) response.title = view.title;
  if (view.warning) response.warning = view.warning;
  return response;
}

// Record our own write and broadcast the event, then return the fresh state.
function mutated(
  manager: SessionManager,
  session: DocumentSession,
  view: DocumentView,
  event: string,
): Response {
  manager.applyMutation(session, view, event);
  return json(stateResponse(session, view));
}

function expectedVersionFrom(request: Request): string | undefined {
  return new URL(request.url).searchParams.get("expectedVersion") ?? undefined;
}

function parseRange(input: string | null): { start: number; end: number } | undefined {
  if (!input) return undefined;
  const match = input.match(/^(\d+):(\d+)$/);
  if (!match) return undefined;
  const start = Number.parseInt(match[1]!, 10);
  const end = Number.parseInt(match[2]!, 10);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined;
  return { start, end };
}

function unknownDoc(): Response {
  return json({ error: "Unknown document — re-resolve it by path.", code: "unknown-doc" }, 404);
}

// --- SSE -----------------------------------------------------------------

function docEventStream(manager: SessionManager, session: DocumentSession): Response {
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      manager.subscribeDoc(session, controller);
      controller.enqueue(encoder.encode("event: connected\ndata: {}\n\n"));
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        } catch {
          clearInterval(heartbeat);
        }
      }, 25_000);
      heartbeat.unref?.();
    },
    cancel() {
      clearInterval(heartbeat);
      if (controllerRef) manager.unsubscribeDoc(session, controllerRef);
    },
  });
  return new Response(stream, { headers: sseHeaders() });
}

function serverEventStream(manager: SessionManager): Response {
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      manager.subscribeServer(controller);
      controller.enqueue(encoder.encode("event: connected\ndata: {}\n\n"));
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        } catch {
          clearInterval(heartbeat);
        }
      }, 25_000);
      heartbeat.unref?.();
    },
    cancel() {
      clearInterval(heartbeat);
      if (controllerRef) manager.unsubscribeServer(controllerRef);
    },
  });
  return new Response(stream, { headers: sseHeaders() });
}

// --- static + assets -----------------------------------------------------

function serveStatic(urlPath: string): Response {
  const requested = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  for (const baseDir of [distDir, publicDir]) {
    const absolute = path.resolve(baseDir, requested);
    if (isInside(baseDir, absolute) && fs.existsSync(absolute) && fs.statSync(absolute).isFile()) {
      return new Response(Bun.file(absolute), { headers: { "Cache-Control": "no-store" } });
    }
  }
  // SPA fallback: unknown non-API paths serve the client shell so deep links work.
  const shell = path.resolve(distDir, "index.html");
  if (fs.existsSync(shell)) {
    return new Response(Bun.file(shell), { headers: { "Cache-Control": "no-store" } });
  }
  return new Response("Not found", { status: 404 });
}

function serveDocAsset(session: DocumentSession, relativePath: string): Response {
  const decoded = decodeURIComponent(relativePath);
  const documentDir = path.dirname(session.path);
  const absolute = path.resolve(documentDir, decoded);
  // realpath both sides so a symlink inside the document directory can't point
  // the response at a file outside it.
  if (!decoded || !fs.existsSync(absolute) || !fs.statSync(absolute).isFile() || !realInside(documentDir, absolute)) {
    return new Response("Not found", { status: 404 });
  }
  return new Response(Bun.file(absolute), { headers: { "Cache-Control": "no-store" } });
}

// True when `child` resolves (through symlinks) to a path inside `parent`.
function realInside(parent: string, child: string): boolean {
  try {
    const realParent = fs.realpathSync(parent);
    const realChild = fs.realpathSync(child);
    return isInside(realParent, realChild);
  } catch {
    return false;
  }
}

// --- error mapping -------------------------------------------------------

function errorResponse(error: unknown): Response {
  if (error instanceof ConflictError) {
    return json({ error: error.message, current: error.current }, 409);
  }
  if (error instanceof SessionError || error instanceof FileBrowseError) {
    return json({ error: error.message }, error.status);
  }
  if (typeof error === "object" && error !== null && "status" in error && typeof (error as { status: unknown }).status === "number") {
    const status = (error as { status: number }).status;
    const message = error instanceof Error ? error.message : "Request failed.";
    return json({ error: message }, status);
  }
  const message = error instanceof Error ? error.message : "Unknown server error.";
  return json({ error: message }, 500);
}

// --- helpers -------------------------------------------------------------

async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    // Malformed client payload is a 400, not a 500.
    throw new ValidationError("Request body must be valid JSON.");
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

function sseHeaders(): Record<string, string> {
  return {
    ...corsHeaders(),
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
  };
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "::ffff:127.0.0.1";
}

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
  return {
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  };
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

// --- bootstrap -----------------------------------------------------------

export interface ServerOptions {
  documentPath?: string; // optional file to open at startup
  host: string;
  port: number;
  portExplicit?: boolean; // user passed --port — start a distinct instance there
}

// Redline runs one shared server holding many documents. When `start <file>` is
// run and a server is ALREADY running, reuse it: open the file on it and return
// the URL to print, rather than binding a second server. Returns null to start
// fresh. Reuse is skipped when no file is given (a bare `start`/`dev` always
// boots its own server) or when --port pins a specific instance (use that to run
// a separate server). The candidate server's /api/health is probed first so a
// stale registry entry (pid alive but not actually serving) doesn't misroute.
export async function reuseRunningServer(
  options: ServerOptions,
  deps: { serversDir?: string; fetchImpl?: typeof fetch } = {},
): Promise<string | null> {
  if (!options.documentPath || options.portExplicit) return null;
  const serversDir = deps.serversDir ?? SERVERS_DIR;
  const fetchImpl = deps.fetchImpl ?? fetch;

  for (const record of readServerRecords(serversDir)) {
    try {
      const health = await fetchImpl(`${record.url}api/health`, { signal: AbortSignal.timeout(500) });
      if (!health.ok) continue;
      const opened = await fetchImpl(`${record.url}api/docs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: options.documentPath }),
      });
      if (!opened.ok) continue;
      const info = (await opened.json()) as { docId?: string };
      const url = info.docId ? `${record.url}?doc=${info.docId}` : record.url;
      return (
        `Redline is already running (pid ${record.pid}); opened ${options.documentPath} on the existing server.\n` +
        `URL: ${url}\n` +
        `To start a fresh Redline server instead, pass an explicit port, for example:\n` +
        `  bun run start ${options.documentPath} --port ${options.port + 1}`
      );
    } catch {
      // Unreachable or errored — try the next registered server.
    }
  }
  return null;
}

export function startServer(options: ServerOptions): void {
  let serverUrl = "";
  const manager = new SessionManager(() => syncRegistry());

  function syncRegistry(): void {
    if (!serverUrl) return;
    writeServerRecord(SERVERS_DIR, {
      url: serverUrl,
      pid: process.pid,
      startedAt: serverStartedAt,
      docs: manager.registryDocs(),
    });
  }

  const handler = createRequestHandler({
    manager,
    serverInfo: () => ({ url: serverUrl, pid: process.pid, startedAt: serverStartedAt, docs: manager.registryDocs() }),
  });

  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      hostname: options.host,
      port: options.port,
      idleTimeout: 120,
      fetch: handler,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "EADDRINUSE") {
      const running = readServerRecords(SERVERS_DIR);
      const here = running.find((r) => r.url.includes(`:${options.port}/`));
      console.error(`Port ${options.port} is already in use.`);
      if (here) {
        console.error(`A Redline server is already running there: ${here.url} (pid ${here.pid}).`);
        console.error(`Open that URL, or open a file on it with: redline <file>`);
      } else {
        console.error(`Another process is using it. Start Redline on a different port:`);
        console.error(`  bun run start ${options.documentPath ?? "<file>"} --port ${options.port + 1}`);
      }
      process.exit(1);
    }
    throw error;
  }

  serverUrl = server.url.toString();
  // The API reads/writes files on disk and is unauthenticated by design (the
  // plan scopes auth/multi-tenancy out). That is safe only on loopback: a
  // request with no Origin (a non-browser client) is trusted, which on a
  // non-loopback bind would let anything on the network drive these endpoints.
  // Refuse to start beyond loopback unless explicitly acknowledged.
  if (!isLoopbackHost(options.host)) {
    if (process.env.REDLINE_ALLOW_REMOTE !== "1") {
      console.error(
        `Refusing to bind ${options.host}: the Redline API is unauthenticated and would be exposed to the network. ` +
          `Bind 127.0.0.1 (default), or set REDLINE_ALLOW_REMOTE=1 if you have put auth in front of it.`,
      );
      server.stop(true);
      process.exit(1);
    }
    console.warn(
      `WARNING: bound to ${options.host}. The Redline API is unauthenticated — anyone who can reach this host can read/write files. Put auth in front of it.`,
    );
  }
  syncRegistry();
  registerCleanup(() => {
    manager.stopWatching();
    manager.closeAll();
    removeServerRecord(SERVERS_DIR, process.pid);
  });
  manager.startWatching();

  if (options.documentPath) {
    try {
      const { session } = manager.openOrGet(options.documentPath);
      console.log(`Redline opened ${session.path} as ${session.docId}`);
    } catch (error) {
      console.warn(`Could not open ${options.documentPath}: ${error instanceof Error ? error.message : error}`);
    }
  } else {
    console.log("Redline started with no document open — choose a file from the browser.");
  }
  console.log(`Open ${server.url}`);
  console.log(`Server registry: ${serverRecordPath(SERVERS_DIR, process.pid)}`);
}

const serverStartedAt = new Date().toISOString();

function registerCleanup(cleanup: () => void): void {
  process.once("exit", cleanup);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(signal, () => {
      cleanup();
      process.exit(0);
    });
  }
}

if (import.meta.main) {
  const options = parseArgs(Bun.argv.slice(2));
  const reused = await reuseRunningServer(options);
  if (reused) {
    console.log(reused);
    process.exit(0);
  } else {
    await ensureClientBuilt();
    startServer(options);
  }
}

// Build the browser client on demand so `bun run start` works on a fresh clone
// with no separate build step. Builds when the bundle is missing OR incomplete
// (e.g. an interrupted earlier build that left only some files) — routine runs
// skip it; client-code changes are rebuilt explicitly via `build:client`.
async function ensureClientBuilt(): Promise<void> {
  // All three are what the shell loads (index.html references main.js + style.css).
  const required = ["index.html", "main.js", "style.css"];
  if (required.every((f) => fs.existsSync(path.resolve(distDir, f)))) return;
  console.log("Building the web client (first run)…");
  const { buildClient } = await import("../client/build");
  await buildClient();
}

function parseArgs(args: string[]): ServerOptions {
  let documentPath: string | undefined;
  let host = "127.0.0.1";
  let port = 7331;
  let portExplicit = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg) continue;
    if (arg === "-h" || arg === "--help") {
      console.log(
        [
          "Usage: bun run start [document.html] [--port 7331] [--host 127.0.0.1]",
          "",
          "With a file, opens it for review and prints a localhost URL. If a Redline",
          "server is already running, the file is opened on THAT server (one shared",
          "server holds many documents); pass --port to run a separate server instead.",
        ].join("\n"),
      );
      process.exit(0);
    }
    if (arg === "--host") { host = args[++i] ?? host; continue; }
    if (arg === "--port" || arg === "-p") { port = parsePort(args[++i]); portExplicit = true; continue; }
    if (arg.startsWith("--port=")) { port = parsePort(arg.slice(7)); portExplicit = true; continue; }
    if (arg.startsWith("--host=")) { host = arg.slice(7); continue; }
    if (arg.startsWith("-")) throw new Error(`Unknown flag: ${arg}`);
    documentPath = expandPath(arg);
  }
  return { documentPath, host, port, portExplicit };
}

function parsePort(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value)) throw new Error("--port must be a positive integer.");
  const port = Number.parseInt(value, 10);
  if (port < 1 || port > 65535) throw new Error("--port must be between 1 and 65535.");
  return port;
}
