// Anchor use-cases: the reconcile report (list anchors) and re-anchoring a
// single comment. Re-anchor writes only the state block; it never touches
// content. Bulk re-anchoring goes through the agent batch (applyAgentUpdate).

import {
  captureSelectorsFromQuote,
  statusesInRange,
  type AnchorStatus,
  type TextRange,
  type Thread,
} from "../core";
import { anchorErrorFor } from "./comments";
import { mutateState, readDocument, type DocumentView } from "./document";
import { NotFoundError } from "./errors";

export interface AnchorReport {
  path: string;
  format: string;
  version: string;
  updatedAt: string;
  anchors: AnchorStatus[];
  threads: Thread[];
}

// The reconcile report — a queryable view of current anchor state, optionally
// filtered to a canonical-text range (backs `anchors --in A:B`).
export function listAnchors(absolutePath: string, range?: TextRange): AnchorReport {
  const view = readDocument(absolutePath);
  const anchors = range ? statusesInRange(view.anchors, range) : view.anchors;
  return {
    path: view.path,
    format: view.format,
    version: view.version,
    updatedAt: view.updatedAt,
    anchors,
    threads: view.threads,
  };
}

export function reanchor(
  absolutePath: string,
  threadId: string,
  quote: string,
  options: { occurrence?: number; expectedVersion?: string } = {},
): DocumentView {
  const now = new Date().toISOString();
  return mutateState(absolutePath, options.expectedVersion, (ctx) => {
    const thread = ctx.threads.find((item) => item.id === threadId);
    if (!thread) throw new NotFoundError(`Comment thread not found: ${threadId}`);
    const capture = captureSelectorsFromQuote(ctx.canonicalText, quote, options.occurrence);
    if (!capture.ok) throw anchorErrorFor(capture, options.occurrence);
    return {
      threads: ctx.threads.map((item) =>
        item.id === threadId ? { ...item, anchor: capture.selectors, updatedAt: now } : item,
      ),
    };
  });
}
