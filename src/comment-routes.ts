import {
  appendReply,
  createComment,
  deleteReply,
  readDocumentState,
  resolveThread,
  updateCommentMessage,
  type CreateCommentInput,
  type DocumentState,
} from "./state";
import { clientErrorFor } from "./http-errors";

export interface CommentRouteOptions {
  documentPath: string;
  changed: (state: DocumentState, reason: string) => Response;
}

export async function handleCommentRequest(
  request: Request,
  options: CommentRouteOptions,
): Promise<Response | undefined> {
  try {
    return await handleCommentRequestUnsafe(request, options);
  } catch (error) {
    const clientError = clientErrorFor(error);
    if (clientError) {
      return json({ error: clientError.message }, clientError.status);
    }
    throw error;
  }
}

async function handleCommentRequestUnsafe(
  request: Request,
  options: CommentRouteOptions,
): Promise<Response | undefined> {
  const url = new URL(request.url);

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
    return options.changed(createComment(options.documentPath, body), "comment.created");
  }

  const replyMatch = url.pathname.match(/^\/api\/comments\/([^/]+)\/replies$/);
  if (replyMatch && request.method === "POST") {
    const body = await readJson<{ body?: unknown; author?: unknown }>(request);
    if (typeof body.body !== "string") {
      return json({ error: "body is required." }, 400);
    }
    const author = typeof body.author === "string" ? body.author : "User";
    return options.changed(
      appendReply(options.documentPath, replyMatch[1] ?? "", body.body, author),
      "reply.created",
    );
  }

  const deleteReplyMatch = url.pathname.match(/^\/api\/comments\/([^/]+)\/replies\/([^/]+)$/);
  if (deleteReplyMatch && request.method === "DELETE") {
    return options.changed(
      deleteReply(
        options.documentPath,
        decodeURIComponent(deleteReplyMatch[1] ?? ""),
        decodeURIComponent(deleteReplyMatch[2] ?? ""),
      ),
      "reply.deleted",
    );
  }

  const messageMatch = url.pathname.match(/^\/api\/comments\/([^/]+)\/messages\/([^/]+)$/);
  if (messageMatch && request.method === "PUT") {
    const body = await readJson<{ body?: unknown }>(request);
    if (typeof body.body !== "string") {
      return json({ error: "body is required." }, 400);
    }
    return options.changed(
      updateCommentMessage(
        options.documentPath,
        decodeURIComponent(messageMatch[1] ?? ""),
        decodeURIComponent(messageMatch[2] ?? ""),
        body.body,
      ),
      "message.updated",
    );
  }

  const resolveMatch = url.pathname.match(/^\/api\/comments\/([^/]+)\/resolve$/);
  if (resolveMatch && request.method === "POST") {
    return options.changed(resolveThread(options.documentPath, resolveMatch[1] ?? ""), "comment.resolved");
  }

  const deleteMatch = url.pathname.match(/^\/api\/comments\/([^/]+)$/);
  if (deleteMatch && request.method === "DELETE") {
    return options.changed(resolveThread(options.documentPath, deleteMatch[1] ?? ""), "comment.resolved");
  }

  return undefined;
}

async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
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
