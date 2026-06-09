// Compact, content-light reads for agents: the thread index and a single full
// thread. Mirrors the previous agent comment index but keyed off the new model
// and the reconcile report (each entry carries its current anchor state).

import type { Thread } from "../core";
import type { AgentIndexThread } from "../shared";
import { listAnchors } from "./anchors";
import { readDocument } from "./document";
import { NotFoundError } from "./errors";

export interface AgentIndex {
  path: string;
  format: string;
  version: string;
  updatedAt: string;
  threads: AgentIndexThread[];
}

// `since` (ISO) keeps only threads with a message created at/after that time.
export function agentCommentIndex(absolutePath: string, since?: string): AgentIndex {
  const report = listAnchors(absolutePath);
  const stateByThread = new Map(report.anchors.map((a) => [a.threadId, a.state]));
  const sinceTime = since === undefined ? undefined : Date.parse(since);

  const threads: AgentIndexThread[] = report.threads
    .filter((thread) => matchesSince(thread.messages, sinceTime))
    .map((thread) => ({
      id: thread.id,
      quote: thread.anchor?.quote ?? "",
      state: stateByThread.get(thread.id) ?? (thread.anchor ? "orphaned" : "general"),
      author: thread.author,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      messageCount: thread.messages.length,
      lastMessageBody: thread.messages.at(-1)?.body ?? "",
    }));

  return {
    path: report.path,
    format: report.format,
    version: report.version,
    updatedAt: report.updatedAt,
    threads,
  };
}

export function agentThread(absolutePath: string, threadId: string): Thread {
  const view = readDocument(absolutePath);
  const thread = view.threads.find((item) => item.id === threadId);
  if (!thread) throw new NotFoundError(`Comment thread not found: ${threadId}`);
  return thread;
}

function matchesSince(messages: { createdAt: string }[], sinceTime: number | undefined): boolean {
  if (sinceTime === undefined || !Number.isFinite(sinceTime)) return true;
  return messages.some((message) => {
    const time = Date.parse(message.createdAt);
    return Number.isFinite(time) && time >= sinceTime;
  });
}
