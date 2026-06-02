import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendReply,
  applyAgentUpdate,
  createComment,
  readDocumentState,
  resolveDocumentPath,
  resolveThread,
  writeDocumentHtml,
  type AgentUpdateInput,
  type CreateCommentInput,
  type DocumentState,
} from "./state";

interface ServerOptions {
  documentPath: string;
  host: string;
  port: number;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "../public");
const stateDir = path.resolve(process.cwd(), ".redline");
const textEncoder = new TextEncoder();

const options = parseArgs(Bun.argv.slice(2));
let latestVersion = "";
const eventClients = new Set<ReadableStreamDefaultController<Uint8Array>>();

const server = Bun.serve({
  hostname: options.host,
  port: options.port,
  async fetch(request) {
    try {
      return await handleRequest(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown server error.";
      return json({ error: message }, 500);
    }
  },
});

writeServerState(server.url.toString(), options.documentPath);
latestVersion = readDocumentState(options.documentPath).version;
setInterval(pollForExternalChanges, 750).unref?.();

console.log(`Redline is serving ${options.documentPath}`);
console.log(`Open ${server.url}`);
console.log(`Agent state: ${new URL("/api/agent/state", server.url)}`);

async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders() });
  }

  if (url.pathname === "/api/health") {
    return json({ ok: true, documentPath: options.documentPath });
  }

  if (url.pathname === "/api/state" || url.pathname === "/api/agent/state") {
    return json(readDocumentState(options.documentPath));
  }

  if (url.pathname === "/api/document" && request.method === "PUT") {
    const body = await readJson<{ html?: unknown; expectedVersion?: unknown }>(request);
    if (typeof body.html !== "string") {
      return json({ error: "html is required." }, 400);
    }
    if (
      typeof body.expectedVersion === "string" &&
      body.expectedVersion !== readDocumentState(options.documentPath).version
    ) {
      return json(
        {
          error: "Document changed before this save completed.",
          current: readDocumentState(options.documentPath),
        },
        409,
      );
    }
    return changed(writeDocumentHtml(options.documentPath, body.html), "document.saved");
  }

  if (url.pathname === "/api/comments" && request.method === "POST") {
    const body = await readJson<CreateCommentInput>(request);
    if (
      typeof body.expectedVersion === "string" &&
      body.expectedVersion !== readDocumentState(options.documentPath).version
    ) {
      return json(
        {
          error: "Document changed before this comment was saved.",
          current: readDocumentState(options.documentPath),
        },
        409,
      );
    }
    return changed(createComment(options.documentPath, body), "comment.created");
  }

  const replyMatch = url.pathname.match(/^\/api\/comments\/([^/]+)\/replies$/);
  if (replyMatch && request.method === "POST") {
    const body = await readJson<{ body?: unknown; author?: unknown }>(request);
    if (typeof body.body !== "string") {
      return json({ error: "body is required." }, 400);
    }
    const author = typeof body.author === "string" ? body.author : "User";
    return changed(appendReply(options.documentPath, replyMatch[1] ?? "", body.body, author), "reply.created");
  }

  const resolveMatch = url.pathname.match(/^\/api\/comments\/([^/]+)\/resolve$/);
  if (resolveMatch && request.method === "POST") {
    return changed(resolveThread(options.documentPath, resolveMatch[1] ?? ""), "comment.resolved");
  }

  const deleteMatch = url.pathname.match(/^\/api\/comments\/([^/]+)$/);
  if (deleteMatch && request.method === "DELETE") {
    return changed(resolveThread(options.documentPath, deleteMatch[1] ?? ""), "comment.resolved");
  }

  if (url.pathname === "/api/agent/update" && request.method === "POST") {
    const body = await readJson<AgentUpdateInput>(request);
    return changed(applyAgentUpdate(options.documentPath, body), "agent.updated");
  }

  if (url.pathname === "/api/events") {
    return eventStream();
  }

  if (url.pathname.startsWith("/document-assets/")) {
    return serveDocumentAsset(url.pathname);
  }

  return serveStatic(url.pathname);
}

function changed(state: DocumentState, reason: string): Response {
  latestVersion = state.version;
  broadcast(reason, state);
  return json(state);
}

function pollForExternalChanges(): void {
  try {
    const state = readDocumentState(options.documentPath);
    if (state.version === latestVersion) return;
    latestVersion = state.version;
    broadcast("external.changed", state);
  } catch {
    // Keep the server alive if an editor temporarily swaps files on disk.
  }
}

function broadcast(reason: string, state = readDocumentState(options.documentPath)): void {
  const payload = `event: state\ndata: ${JSON.stringify({
    reason,
    version: state.version,
    updatedAt: state.updatedAt,
    summary: state.summary,
  })}\n\n`;

  for (const client of [...eventClients]) {
    try {
      client.enqueue(textEncoder.encode(payload));
    } catch {
      eventClients.delete(client);
    }
  }
}

function eventStream(): Response {
  let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
      eventClients.add(controller);
      controller.enqueue(textEncoder.encode("event: connected\ndata: {}\n\n"));
    },
    cancel() {
      if (streamController) {
        eventClients.delete(streamController);
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

function serveDocumentAsset(urlPath: string): Response {
  const relativePath = decodeURIComponent(urlPath.replace(/^\/document-assets\/?/, ""));
  const documentDir = path.dirname(options.documentPath);
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

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
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
