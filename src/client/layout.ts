// Pure rail-layout + comment-navigation helpers, vendored from the previous
// vanilla client (public/app-helpers.js) and kept framework-free so they can be
// unit-tested in isolation. The rail positions each comment card absolutely so
// it tracks its anchor as the document scrolls, packing cards to avoid overlap.

export interface RailItem {
  id: string;
  height: number;
  targetViewportTop: number | null; // null = anchor not currently in view
}

export interface RailLayout {
  contentHeight: number;
  positions: Map<string, number>;
}

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

// The top a card "wants": its anchor's viewport position translated into the
// rail's own scroll space, so anchor and card sit at the same screen height.
export function alignedRailItemTop(opts: {
  railScrollTop?: number;
  railViewportTop?: number;
  targetViewportTop?: number;
}): number {
  const railScrollTop = Math.max(0, finite(opts.railScrollTop ?? 0, 0));
  const railViewportTop = finite(opts.railViewportTop ?? 0, 0);
  return railScrollTop + finite(opts.targetViewportTop ?? railViewportTop, railViewportTop) - railViewportTop;
}

// Place every card as close as possible to its desired (anchor-aligned) top
// without overlapping, biasing around the active card so the focused comment
// keeps its exact alignment and its neighbours flow off it.
export function stackedRailItemLayout(opts: {
  activeId?: string | null;
  edgePadding?: number;
  gap?: number;
  items?: RailItem[];
  railScrollTop?: number;
  railViewportTop?: number;
}): RailLayout {
  const edgePadding = Math.max(0, finite(opts.edgePadding ?? 16, 0));
  const gap = Math.max(0, finite(opts.gap ?? 12, 0));
  const items = (opts.items ?? []).map((item) => ({
    id: item.id,
    height: Math.max(0, finite(item.height, 0)),
    targetViewportTop: item.targetViewportTop === null ? null : finite(item.targetViewportTop, NaN),
  }));
  const positions = new Map<string, number>();
  if (items.length === 0) return { contentHeight: 0, positions };

  const fallbackTops: number[] = [];
  let fallbackTop = edgePadding;
  for (const item of items) {
    fallbackTops.push(fallbackTop);
    fallbackTop += item.height + gap;
  }

  const desiredTops = items.map((item) =>
    item.targetViewportTop === null || !Number.isFinite(item.targetViewportTop)
      ? null
      : alignedRailItemTop({
          railScrollTop: opts.railScrollTop ?? 0,
          railViewportTop: opts.railViewportTop ?? 0,
          targetViewportTop: item.targetViewportTop,
        }),
  );

  const placeForward = (startIndex: number, startTop: number) => {
    let nextTop = startTop;
    for (let index = startIndex; index < items.length; index += 1) {
      const top = Math.max(desiredTops[index] ?? nextTop, nextTop);
      positions.set(items[index]!.id, top);
      nextTop = top + items[index]!.height + gap;
    }
  };

  const activeIndex =
    opts.activeId == null ? -1 : items.findIndex((item) => item.id === opts.activeId);

  if (activeIndex === -1) {
    placeForward(0, desiredTops[0] ?? edgePadding);
  } else {
    positions.set(items[activeIndex]!.id, desiredTops[activeIndex] ?? fallbackTops[activeIndex]!);
    // Walk back up from the active card, pushing earlier cards above it.
    for (let index = activeIndex - 1; index >= 0; index -= 1) {
      const nextTop = positions.get(items[index + 1]!.id) ?? fallbackTops[index + 1]!;
      const maxTop = nextTop - gap - items[index]!.height;
      positions.set(items[index]!.id, Math.min(desiredTops[index] ?? maxTop, maxTop));
    }
    placeForward(
      activeIndex + 1,
      (positions.get(items[activeIndex]!.id) ?? fallbackTops[activeIndex]!) +
        items[activeIndex]!.height +
        gap,
    );
  }

  let contentHeight = edgePadding;
  for (const item of items) {
    const top = positions.get(item.id);
    if (top === undefined || !Number.isFinite(top)) continue;
    contentHeight = Math.max(contentHeight, top + item.height + edgePadding);
  }
  return { contentHeight, positions };
}

// Where to splice the open composer among the document-ordered comment cards so
// it keeps document order by anchor position. `cardTargets` are the cards'
// anchor viewport tops (in document order; null = anchor offscreen/orphaned, which
// sorts to the end). The composer goes before the first card that sits below its
// selection, and before any null-target (orphaned) cards. Without this, a comment
// created near the bottom while an earlier comment is scrolled off the top would
// render above that earlier comment.
export function composerInsertIndex(cardTargets: (number | null)[], composerTarget: number | null): number {
  for (let i = 0; i < cardTargets.length; i += 1) {
    const target = cardTargets[i];
    if (target === null || target === undefined) return i; // orphaned cards trail the composer
    if (composerTarget !== null && target > composerTarget) return i;
  }
  return cardTargets.length;
}

function uniqueIds(ids: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export interface CommentNavState {
  hasComments: boolean;
  previousDisabled: boolean;
  nextDisabled: boolean;
}

// Prev/next button enablement for the topbar comment-navigation chevrons.
export function commentNavigationState(orderedIds: string[], activeId: string | null): CommentNavState {
  const ordered = uniqueIds(orderedIds);
  const activeIndex = activeId == null ? -1 : ordered.indexOf(activeId);
  const hasActive = activeIndex !== -1;
  return {
    hasComments: ordered.length > 0,
    nextDisabled: ordered.length === 0 || (hasActive && activeIndex === ordered.length - 1),
    previousDisabled: ordered.length === 0 || (hasActive && activeIndex === 0),
  };
}

// The thread to move to. With nothing active yet, the first comment; otherwise
// one step in `direction`, clamped (returns null at the ends).
export function commentNavigationTarget(
  orderedIds: string[],
  activeId: string | null,
  direction: "next" | "previous",
): string | null {
  const ordered = uniqueIds(orderedIds);
  if (ordered.length === 0) return null;
  const activeIndex = activeId == null ? -1 : ordered.indexOf(activeId);
  if (activeIndex === -1) return ordered[0]!;
  const target = Math.max(0, Math.min(ordered.length - 1, activeIndex + (direction === "previous" ? -1 : 1)));
  return target === activeIndex ? null : ordered[target]!;
}
