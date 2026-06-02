import { readCommentState, readDocumentFileState } from "./state";

export interface AgentRouteOptions {
  documentPath: string;
}

export function handleAgentRequest(request: Request, options: AgentRouteOptions): Response | undefined {
  const url = new URL(request.url);

  if (url.pathname === "/api/agent/comments") {
    return json(readCommentState(options.documentPath));
  }

  if (url.pathname === "/api/agent/file") {
    return json(readDocumentFileState(options.documentPath));
  }

  return undefined;
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
