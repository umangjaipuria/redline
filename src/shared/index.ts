// src/shared — DTOs shared across the server / client / agent boundaries. The
// wire format is ours to set; the one rule is that whatever shapes we land on
// stay consistent across all three consumers (the plan's Data shapes section).
//
// The core model types (Message, AnchorSelectors, Thread, EmbeddedState) and the
// reconcile report type (AnchorStatus) are re-exported from core so there is a
// single definition.

export type {
  Message,
  AnchorSelectors,
  Thread,
  EmbeddedState,
} from "../core/model";
export type { AnchorState } from "../core/anchor";
export type { AnchorStatus } from "../core/reconcile";
export type { TextRange } from "../core/text";

// ---- agent batch (apply / POST .../agent/update) — NO content field ----
// Redline never writes document content; every field here mutates only the
// embedded state block.
export interface AgentUpdate {
  comments?: { quote: string; body: string; author?: string; occurrence?: number }[];
  replies?: { threadId: string; body: string; author?: string }[];
  edits?: { threadId: string; messageId: string; body: string }[];
  deleteThreads?: string[];
  deleteReplies?: { threadId: string; messageId: string }[];
  reanchors?: { threadId: string; quote: string; occurrence?: number }[];
}

// ---- selector capture from the client (live selection in the rendered text) --
// The client captures the full selector set from the rendered text layer and
// sends all of it; the server does not reconstruct selectors from a bare quote.
export interface SelectorInput {
  quote: string;
  prefix?: string;
  suffix?: string;
  posStart?: number;
  posEnd?: number;
}

// ---- create-comment request body ----
export interface CreateCommentRequest {
  message: string;
  author?: string;
  // Either explicit selectors (browser, from the live selection) or a bare quote
  // (+ optional occurrence) that the server resolves to selectors (agent).
  selectors?: SelectorInput;
  quote?: string;
  occurrence?: number;
  expectedVersion?: string;
}

// ---- server: document session + responses ----
export interface DocumentSessionInfo {
  docId: string;
  path: string;
  format: string;
  version: string;
  updatedAt: string;
  title?: string;
}

import type { Thread as ThreadModel } from "../core/model";
import type { AnchorStatus as AnchorStatusModel } from "../core/reconcile";

export interface ReviewSummary {
  threads: number;
  messages: number;
}

// GET /api/docs/:docId/state — everything the UI needs to render a document.
export interface DocumentStateResponse {
  docId: string;
  path: string;
  format: string;
  version: string;
  // The server's boot timestamp. A restart is already handled reactively (docIds
  // are ephemeral across restarts, so the old id 404s and the client re-resolves
  // by path), but exposing the boot id lets clients/tools detect a restart
  // directly and is useful for diagnostics.
  startedAt: string;
  updatedAt: string;
  title?: string;
  renderedHtml: string;
  threads: ThreadModel[];
  anchors: AnchorStatusModel[];
  summary: ReviewSummary;
  // Present when the embedded state block could not be parsed: the document is
  // shown with no review state and writes are refused until it's resolved.
  warning?: string;
}

// Compact agent index entry (no message bodies except the last).
export interface AgentIndexThread {
  id: string;
  quote: string;
  state: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  lastMessageBody: string;
}

export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isHtml: boolean;
}

export interface ServerInfo {
  url: string;
  pid: number;
  startedAt: string;
  docs: { docId: string; path: string }[];
}
