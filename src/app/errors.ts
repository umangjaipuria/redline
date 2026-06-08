// Typed application errors. The server maps these to HTTP status codes and the
// CLI prints their messages; keeping them as classes lets both layers branch on
// the error kind rather than string-matching messages.

import type { DocumentView } from "./document";

export class ValidationError extends Error {
  status = 400 as const;
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

// 422 — the request was well-formed but the anchor couldn't be resolved as asked
// (quote missing, ambiguous without an occurrence, occurrence out of range).
export class AnchorError extends Error {
  status = 422 as const;
  constructor(message: string) {
    super(message);
    this.name = "AnchorError";
  }
}

export class NotFoundError extends Error {
  status = 404 as const;
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

// 409 — the document version moved under the writer (optimistic concurrency).
// Carries the current view so the client can rebase instead of clobbering.
export class ConflictError extends Error {
  status = 409 as const;
  constructor(
    message: string,
    public readonly current: DocumentView,
  ) {
    super(message);
    this.name = "ConflictError";
  }
}

// 422 — the embedded block is present but unparseable / unknown version, so we
// refuse to overwrite it without the caller making that explicit.
export class MalformedDocumentError extends Error {
  status = 422 as const;
  constructor(message: string) {
    super(message);
    this.name = "MalformedDocumentError";
  }
}
