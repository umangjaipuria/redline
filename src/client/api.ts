// Thin fetch wrappers for the doc-scoped + server-level API. All responses carry
// `format` and `version`; writes accept an optional `expectedVersion` and a
// version mismatch surfaces as a 409 the caller can rebase from.

import type {
  AgentUpdate,
  CreateCommentRequest,
  DocumentSessionInfo,
  DocumentStateResponse,
  FileEntry,
} from "../shared";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly current?: DocumentStateResponse,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function send<T>(method: string, url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const message = parsed?.error ?? `Request failed (${response.status}).`;
    throw new ApiError(message, response.status, parsed?.current);
  }
  return parsed as T;
}

export interface DocsList {
  docs: DocumentSessionInfo[];
}

export const api = {
  listDocs: () => send<DocsList>("GET", "/api/docs"),
  openDoc: (path: string) => send<DocumentSessionInfo>("POST", "/api/docs", { path }),
  closeDoc: (docId: string) => send<{ closed: boolean }>("DELETE", `/api/docs/${docId}`),
  state: (docId: string) => send<DocumentStateResponse>("GET", `/api/docs/${docId}/state`),
  listFiles: (dir: string) =>
    send<{ dir: string; parent: string | null; entries: FileEntry[] }>(
      "GET",
      `/api/files?dir=${encodeURIComponent(dir)}`,
    ),
  openDialog: () => send<{ cancelled?: boolean } & Partial<DocumentSessionInfo>>("POST", "/api/open-dialog"),
  howto: () => send<{ path: string | null }>("GET", "/api/howto"),

  createComment: (docId: string, body: CreateCommentRequest) =>
    send<DocumentStateResponse>("POST", `/api/docs/${docId}/comments`, body),
  reply: (docId: string, threadId: string, body: string, author?: string, expectedVersion?: string) =>
    send<DocumentStateResponse>("POST", `/api/docs/${docId}/comments/${threadId}/replies`, {
      body,
      author,
      expectedVersion,
    }),
  editMessage: (docId: string, threadId: string, messageId: string, body: string, expectedVersion?: string) =>
    send<DocumentStateResponse>("PUT", `/api/docs/${docId}/comments/${threadId}/messages/${messageId}`, {
      body,
      expectedVersion,
    }),
  deleteReply: (docId: string, threadId: string, messageId: string, expectedVersion?: string) =>
    send<DocumentStateResponse>(
      "DELETE",
      `/api/docs/${docId}/comments/${threadId}/replies/${messageId}${versionQuery(expectedVersion)}`,
    ),
  deleteThread: (docId: string, threadId: string, expectedVersion?: string) =>
    send<DocumentStateResponse>(
      "DELETE",
      `/api/docs/${docId}/comments/${threadId}${versionQuery(expectedVersion)}`,
    ),
  reanchor: (docId: string, threadId: string, quote: string, occurrence?: number, expectedVersion?: string) =>
    send<DocumentStateResponse>("POST", `/api/docs/${docId}/anchors/${threadId}/reanchor`, {
      quote,
      occurrence,
      expectedVersion,
    }),
  agentUpdate: (docId: string, update: AgentUpdate) =>
    send<DocumentStateResponse>("POST", `/api/docs/${docId}/agent/update`, update),
};

export function assetsBase(docId: string): string {
  return `/api/docs/${docId}/assets/`;
}

function versionQuery(expectedVersion?: string): string {
  return expectedVersion ? `?expectedVersion=${encodeURIComponent(expectedVersion)}` : "";
}
