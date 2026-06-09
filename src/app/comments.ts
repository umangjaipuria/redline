// Comment use-cases: create a thread, reply, edit a message, delete a reply,
// delete a thread. Each is a state-block-only mutation run through mutateState,
// so it merges against the current on-disk threads and is guarded by the
// optional expectedVersion. Redline never writes document content here.

import {
  captureSelectorsFromQuote,
  newId,
  normalizeAnchor,
  normalizeAuthor,
  normalizeBody,
  type AnchorSelectors,
  type CaptureResult,
  type Message,
  type Thread,
} from "../core";
import type { CreateCommentRequest } from "../shared";
import { mutateState, type DocumentView, type MutationContext } from "./document";
import { AnchorError, NotFoundError } from "./errors";

export interface CommandOptions {
  defaultAuthor?: string; // "User" for the browser, "AI" for agents
}

export function createComment(
  absolutePath: string,
  input: CreateCommentRequest,
  options: CommandOptions = {},
): DocumentView {
  const defaultAuthor = options.defaultAuthor ?? "User";
  const body = normalizeBody(input.message, "Comment body is required.");
  const author = normalizeAuthor(input.author, defaultAuthor);
  const now = new Date().toISOString();

  return mutateState(absolutePath, input.expectedVersion, (ctx) => {
    const anchor = buildAnchor(ctx, input);
    const thread: Thread = {
      id: newId("thread"),
      author,
      createdAt: now,
      updatedAt: now,
      messages: [{ id: newId("message"), author, body, createdAt: now }],
    };
    if (anchor) thread.anchor = anchor;
    return { threads: [...ctx.threads, thread] };
  });
}

export function appendReply(
  absolutePath: string,
  threadId: string,
  body: string,
  options: CommandOptions & { author?: string; expectedVersion?: string } = {},
): DocumentView {
  const author = normalizeAuthor(options.author, options.defaultAuthor ?? "User");
  const text = normalizeBody(body, "Reply body is required.");
  const now = new Date().toISOString();

  return mutateState(absolutePath, options.expectedVersion, (ctx) => {
    const thread = requireThread(ctx.threads, threadId);
    const message: Message = { id: newId("message"), author, body: text, createdAt: now };
    return { threads: replaceThread(ctx.threads, threadId, { ...thread, messages: [...thread.messages, message], updatedAt: now }) };
  });
}

export function editMessage(
  absolutePath: string,
  threadId: string,
  messageId: string,
  body: string,
  options: { expectedVersion?: string } = {},
): DocumentView {
  const text = normalizeBody(body, "Comment body is required.");
  const now = new Date().toISOString();

  return mutateState(absolutePath, options.expectedVersion, (ctx) => {
    const thread = requireThread(ctx.threads, threadId);
    const index = thread.messages.findIndex((message) => message.id === messageId);
    if (index === -1) throw new NotFoundError(`Comment message not found: ${messageId}`);
    const updated = thread.messages.map((message, i) =>
      i === index ? { ...message, body: text, updatedAt: now } : message,
    );
    return { threads: replaceThread(ctx.threads, threadId, { ...thread, messages: updated, updatedAt: now }) };
  });
}

export function deleteReply(
  absolutePath: string,
  threadId: string,
  messageId: string,
  options: { expectedVersion?: string } = {},
): DocumentView {
  const now = new Date().toISOString();

  return mutateState(absolutePath, options.expectedVersion, (ctx) => {
    const thread = requireThread(ctx.threads, threadId);
    const index = thread.messages.findIndex((message) => message.id === messageId);
    if (index === -1) throw new NotFoundError(`Reply not found: ${messageId}`);
    if (index === 0) {
      throw new AnchorError("The original comment cannot be deleted as a reply. Delete the whole thread instead.");
    }
    const messages = thread.messages.filter((_, i) => i !== index);
    return { threads: replaceThread(ctx.threads, threadId, { ...thread, messages, updatedAt: now }) };
  });
}

// Delete a thread: remove it from the state block. This is what was formerly
// called "resolve" — there is no separate kept-resolved state.
export function deleteThread(
  absolutePath: string,
  threadId: string,
  options: { expectedVersion?: string } = {},
): DocumentView {
  return mutateState(absolutePath, options.expectedVersion, (ctx) => {
    if (!ctx.threads.some((thread) => thread.id === threadId)) {
      throw new NotFoundError(`Comment thread not found: ${threadId}`);
    }
    return { threads: ctx.threads.filter((thread) => thread.id !== threadId) };
  });
}

// Build the anchor for a new comment. Explicit selectors (browser, from the live
// selection) win; otherwise a bare quote (+ occurrence) is resolved against the
// canonical text. No quote at all ⇒ a document-level (general) comment.
function buildAnchor(ctx: MutationContext, input: CreateCommentRequest): AnchorSelectors | undefined {
  if (input.selectors && typeof input.selectors.quote === "string" && input.selectors.quote.trim()) {
    const fromSelectors = normalizeAnchor(input.selectors);
    if (fromSelectors) {
      // If the client omitted context/position, enrich from the canonical text
      // so resolution has hints to work with.
      if (!fromSelectors.prefix && !fromSelectors.suffix && fromSelectors.posStart === 0) {
        const capture = captureSelectorsFromQuote(ctx.canonicalText, fromSelectors.quote);
        if (capture.ok) return capture.selectors;
      }
      return fromSelectors;
    }
  }

  const quote = input.quote ?? input.selectors?.quote;
  if (!quote || !quote.trim()) return undefined;
  const capture = captureSelectorsFromQuote(ctx.canonicalText, quote, input.occurrence);
  if (!capture.ok) throw anchorErrorFor(capture, input.occurrence);
  return capture.selectors;
}

export function anchorErrorFor(failure: Extract<CaptureResult, { ok: false }>, occurrence?: number): AnchorError {
  switch (failure.reason) {
    case "empty":
      return new AnchorError("A quote is required to anchor a comment.");
    case "not-found":
      return new AnchorError("Quoted text was not found in the document.");
    case "ambiguous":
      return new AnchorError(
        `Quoted text appears ${failure.count} times. Pass an occurrence (1–${failure.count}) to choose which.`,
      );
    case "out-of-range":
      return new AnchorError(
        `Quoted text appears ${failure.count} times, but occurrence ${occurrence} was requested.`,
      );
  }
}

function requireThread(threads: Thread[], threadId: string): Thread {
  const thread = threads.find((item) => item.id === threadId);
  if (!thread) throw new NotFoundError(`Comment thread not found: ${threadId}`);
  return thread;
}

function replaceThread(threads: Thread[], threadId: string, next: Thread): Thread[] {
  return threads.map((thread) => (thread.id === threadId ? next : thread));
}
