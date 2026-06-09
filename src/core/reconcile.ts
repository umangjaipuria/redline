// Reconciliation: re-resolve every anchored thread against the current canonical
// text and classify each as anchored / needs-review / orphaned. Pure resolution
// — it never deletes or moves a comment, and re-running it on the same text
// yields the same result (idempotent, lossless). It also surfaces lazily-healed
// selectors so the app can refresh stored hints on the next write without racing
// the editing agent.

import { resolveAnchor, type AnchorState } from "./anchor";
import type { AnchorSelectors, Thread } from "./model";
import type { TextRange } from "./text";

export interface AnchorStatus {
  threadId: string;
  state: AnchorState;
  range?: TextRange; // resolved position over canonical text, when matched
  confidence?: number; // 0..1 for fuzzy matches
  quote: string; // resolved (anchored/needs-review) or last-known (orphaned) quote
  prefix?: string;
  suffix?: string;
}

export interface ReconcileResult {
  statuses: AnchorStatus[]; // one per anchored thread, in thread order
  healedThreads: Thread[]; // threads with refreshed anchor hints applied
  changed: boolean; // whether any healed anchor differs from its stored form
}

export function reconcile(canonicalText: string, threads: Thread[]): ReconcileResult {
  const statuses: AnchorStatus[] = [];
  const healedThreads: Thread[] = [];
  let changed = false;

  for (const thread of threads) {
    if (!thread.anchor) {
      healedThreads.push(thread);
      continue;
    }

    const resolution = resolveAnchor(canonicalText, thread.anchor);
    const status: AnchorStatus = {
      threadId: thread.id,
      state: resolution.state,
      quote: resolution.quote,
    };
    if (resolution.range) status.range = resolution.range;
    if (resolution.confidence !== undefined) status.confidence = resolution.confidence;
    if (resolution.prefix !== undefined) status.prefix = resolution.prefix;
    if (resolution.suffix !== undefined) status.suffix = resolution.suffix;
    statuses.push(status);

    if (resolution.healed && anchorChanged(thread.anchor, resolution.healed)) {
      healedThreads.push({ ...thread, anchor: resolution.healed });
      changed = true;
    } else {
      healedThreads.push(thread);
    }
  }

  return { statuses, healedThreads, changed };
}

// Filter statuses to a canonical-text character range — backs `anchors --in A:B`.
export function statusesInRange(statuses: AnchorStatus[], range: TextRange): AnchorStatus[] {
  return statuses.filter((status) => {
    if (!status.range) return false;
    return status.range.start < range.end && status.range.end > range.start;
  });
}

function anchorChanged(current: AnchorSelectors, next: AnchorSelectors): boolean {
  return (
    current.quote !== next.quote ||
    current.prefix !== next.prefix ||
    current.suffix !== next.suffix ||
    current.posStart !== next.posStart ||
    current.posEnd !== next.posEnd ||
    current.originalQuote !== next.originalQuote
  );
}
