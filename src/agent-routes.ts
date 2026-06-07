import {
  readAgentCommentIndexState,
  readAgentCommentThreadState,
  readDocumentFileState,
} from "./state";

export interface AgentRouteOptions {
  documentPath: string;
}

export function handleAgentRequest(request: Request, options: AgentRouteOptions): Response | undefined {
  const url = new URL(request.url);

  if (url.pathname === "/api/agent/comments/index") {
    const since = url.searchParams.get("since") ?? undefined;
    if (since !== undefined && !isIsoTimestamp(since)) {
      return json({ error: "since must be an ISO timestamp." }, 400);
    }
    return json(readAgentCommentIndexState(options.documentPath, { since }));
  }

  const threadMatch = url.pathname.match(/^\/api\/agent\/comments\/([^/]+)$/);
  if (threadMatch) {
    try {
      return json(readAgentCommentThreadState(options.documentPath, decodeURIComponent(threadMatch[1] ?? "")));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Comment thread not found.";
      return json({ error: message }, 404);
    }
  }

  if (url.pathname === "/api/agent/file") {
    return json(readDocumentFileState(options.documentPath));
  }

  return undefined;
}

function isIsoTimestamp(value: string): boolean {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  ) {
    return false;
  }
  return Number.isFinite(Date.parse(value));
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: {
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
