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

async function send<T>(method: string, url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
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
  listDocs: (signal?: AbortSignal) => send<DocsList>("GET", "/api/docs", undefined, signal),
  openDoc: (path: string, signal?: AbortSignal) =>
    send<DocumentSessionInfo>("POST", "/api/docs", { path }, signal),
  closeDoc: (docId: string) => send<{ closed: boolean }>("DELETE", `/api/docs/${docId}`),
  state: (docId: string, signal?: AbortSignal) =>
    send<DocumentStateResponse>("GET", `/api/docs/${docId}/state`, undefined, signal),
  // Conditional poll: sends If-None-Match with the version we hold; resolves to
  // null when the server answers 304 (unchanged), so the caller repaints only on
  // a real change. A 404 throws an ApiError the poller reads as "doc gone".
  pollState: async (
    docId: string,
    knownVersion?: string,
    signal?: AbortSignal,
  ): Promise<DocumentStateResponse | null> => {
    const response = await fetch(`/api/docs/${docId}/state`, {
      headers: knownVersion ? { "If-None-Match": `"${knownVersion}"` } : {},
      signal,
    });
    if (response.status === 304) return null;
    const text = await response.text();
    const parsed = text ? JSON.parse(text) : {};
    if (!response.ok) {
      throw new ApiError(parsed?.error ?? `Request failed (${response.status}).`, response.status, parsed?.current);
    }
    return parsed as DocumentStateResponse;
  },
  // Re-resolve a document by its (durable) path — used after a docId 404s to find
  // the same file reopened under a fresh id. Throws ApiError(404) if not open.
  resolveByPath: (path: string, signal?: AbortSignal) =>
    send<DocumentSessionInfo>("GET", `/api/docs?path=${encodeURIComponent(path)}`, undefined, signal),
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
