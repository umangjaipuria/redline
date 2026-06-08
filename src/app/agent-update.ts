// The agent batch: one atomic set of comment/anchor ops applied to the state
// block in a single write (server twin of `redline apply`). No content field —
// Redline never writes document content. Threads are keyed by id, so the batch
// composes cleanly with whatever is already on disk.

import {
  captureSelectorsFromQuote,
  newId,
  normalizeAuthor,
  normalizeBody,
  type Message,
  type Thread,
} from "../core";
import type { AgentUpdate } from "../shared";
import { anchorErrorFor } from "./comments";
import { mutateState, type DocumentView } from "./document";
import { AnchorError, NotFoundError } from "./errors";

export function applyAgentUpdate(
  absolutePath: string,
  update: AgentUpdate,
  options: { defaultAuthor?: string; expectedVersion?: string } = {},
): DocumentView {
  const defaultAuthor = options.defaultAuthor ?? "AI";
  const now = new Date().toISOString();

  return mutateState(absolutePath, options.expectedVersion, (ctx) => {
    let threads = [...ctx.threads];

    // 1. Create new comment threads.
    for (const comment of update.comments ?? []) {
      const body = normalizeBody(comment.body, "Comment body is required.");
      const author = normalizeAuthor(comment.author, defaultAuthor);
      const capture = captureSelectorsFromQuote(ctx.canonicalText, comment.quote, comment.occurrence);
      if (!capture.ok) throw anchorErrorFor(capture, comment.occurrence);
      threads.push({
        id: newId("thread"),
        anchor: capture.selectors,
        author,
        createdAt: now,
        updatedAt: now,
        messages: [{ id: newId("message"), author, body, createdAt: now }],
      });
    }

    // 2. Edits to existing messages.
    for (const edit of update.edits ?? []) {
      const thread = mustFind(threads, edit.threadId);
      const body = normalizeBody(edit.body, "Comment body is required.");
      const index = thread.messages.findIndex((message) => message.id === edit.messageId);
      if (index === -1) throw new NotFoundError(`Comment message not found: ${edit.messageId}`);
      const messages = thread.messages.map((message, i) =>
        i === index ? { ...message, body, updatedAt: now } : message,
      );
      threads = replace(threads, { ...thread, messages, updatedAt: now });
    }

    // 3. Replies.
    for (const reply of update.replies ?? []) {
      const thread = mustFind(threads, reply.threadId);
      const author = normalizeAuthor(reply.author, defaultAuthor);
      const message: Message = {
        id: newId("message"),
        author,
        body: normalizeBody(reply.body, "Reply body is required."),
        createdAt: now,
      };
      threads = replace(threads, { ...thread, messages: [...thread.messages, message], updatedAt: now });
    }

    // 4. Bulk re-anchors.
    for (const r of update.reanchors ?? []) {
      const thread = mustFind(threads, r.threadId);
      const capture = captureSelectorsFromQuote(ctx.canonicalText, r.quote, r.occurrence);
      if (!capture.ok) throw anchorErrorFor(capture, r.occurrence);
      threads = replace(threads, { ...thread, anchor: capture.selectors, updatedAt: now });
    }

    // 5. Delete replies.
    for (const del of update.deleteReplies ?? []) {
      const thread = mustFind(threads, del.threadId);
      const index = thread.messages.findIndex((message) => message.id === del.messageId);
      if (index === -1) throw new NotFoundError(`Reply not found: ${del.messageId}`);
      if (index === 0) {
        throw new AnchorError("The original comment cannot be deleted as a reply. Delete the whole thread instead.");
      }
      threads = replace(threads, {
        ...thread,
        messages: thread.messages.filter((_, i) => i !== index),
        updatedAt: now,
      });
    }

    // 6. Delete whole threads, last.
    const deleteIds = new Set(update.deleteThreads ?? []);
    if (deleteIds.size > 0) {
      for (const id of deleteIds) {
        if (!threads.some((thread) => thread.id === id)) {
          throw new NotFoundError(`Comment thread not found: ${id}`);
        }
      }
      threads = threads.filter((thread) => !deleteIds.has(thread.id));
    }

    return { threads };
  });
}

function mustFind(threads: Thread[], threadId: string): Thread {
  const thread = threads.find((item) => item.id === threadId);
  if (!thread) throw new NotFoundError(`Comment thread not found: ${threadId}`);
  return thread;
}

function replace(threads: Thread[], next: Thread): Thread[] {
  return threads.map((thread) => (thread.id === next.id ? next : thread));
}
