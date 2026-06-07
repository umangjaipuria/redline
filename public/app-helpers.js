export const MISSING_THREAD_ORDER = Number.MAX_SAFE_INTEGER;

// The single source of truth for resolving a comment quote to character ranges,
// shared by the browser (public/app.js) and the server (src/state.ts) so an
// `occurrence` index chosen in one resolves to the same span in the other. The
// rule: collapse whitespace runs to one space, match case-insensitively, and
// return every match as a {start, end} range over the ORIGINAL text, in document
// order. Operates on already-extracted text (no HTML/tag handling here).
export function findQuoteMatches(text, quote) {
  // Mirror the server's normalizeQuote: collapse, trim, cap at 500, then lower.
  // The cap keeps occurrence counts identical for very long selections (the
  // server stores and re-locates the truncated quote).
  const needle = String(quote ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500)
    .toLowerCase();
  if (!needle) return [];

  const { normalized, offsets } = normalizeWithOffsets(String(text ?? ""));
  const matches = [];
  let from = 0;
  while (from <= normalized.length) {
    const at = normalized.indexOf(needle, from);
    if (at === -1) break;
    const start = offsets[at];
    const end = offsets[at + needle.length];
    if (start !== undefined && end !== undefined && end > start) {
      matches.push({ start, end });
    }
    from = at + Math.max(needle.length, 1);
  }
  return matches;
}

// Whitespace-collapsed, lowercased copy of `text` plus a per-character map back
// to original indices. `offsets` has a trailing text.length entry so a match end
// maps to the original index just past the matched run. Lowercasing that expands
// to multiple code units (e.g. "İ") maps each unit to the same original index.
export function normalizeWithOffsets(text) {
  let normalized = "";
  const offsets = [];
  let inWhitespace = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";
    if (/\s/.test(char)) {
      if (inWhitespace) continue;
      inWhitespace = true;
      normalized += " ";
      offsets.push(index);
      continue;
    }
    inWhitespace = false;
    for (const lowerChar of char.toLowerCase()) {
      normalized += lowerChar;
      offsets.push(index);
    }
  }
  offsets.push(text.length);

  return { normalized, offsets };
}

export function alignedRailItemTop({
  railScrollTop = 0,
  railViewportTop = 0,
  targetViewportTop = 0,
} = {}) {
  const safeRailScrollTop = Math.max(0, finiteNumber(railScrollTop, 0));
  const safeRailViewportTop = finiteNumber(railViewportTop, 0);
  return safeRailScrollTop + finiteNumber(targetViewportTop, safeRailViewportTop) - safeRailViewportTop;
}

export function stackedRailItemLayout({
  activeId = null,
  edgePadding = 16,
  gap = 12,
  items = [],
  railScrollTop = 0,
  railViewportHeight = 0,
  railViewportTop = 0,
} = {}) {
  const safeEdgePadding = Math.max(0, finiteNumber(edgePadding, 0));
  const safeGap = Math.max(0, finiteNumber(gap, 0));
  const normalizedItems = [...(items ?? [])].map((item) => ({
    id: item?.id,
    height: Math.max(0, finiteNumber(item?.height, 0)),
    targetViewportTop: finiteNumberOrNull(item?.targetViewportTop),
  }));
  const positions = new Map();

  if (normalizedItems.length === 0) {
    return { contentHeight: 0, positions };
  }

  const fallbackTops = [];
  let fallbackTop = safeEdgePadding;
  for (const item of normalizedItems) {
    fallbackTops.push(fallbackTop);
    fallbackTop += item.height + safeGap;
  }

  const desiredTops = normalizedItems.map((item) => {
    if (item.targetViewportTop === null) return null;
    return alignedRailItemTop({
      edgePadding: safeEdgePadding,
      itemHeight: item.height,
      railScrollTop,
      railViewportHeight,
      railViewportTop,
      targetViewportTop: item.targetViewportTop,
    });
  });

  const activeIndex =
    activeId === null || activeId === undefined
      ? -1
      : normalizedItems.findIndex((item) => item.id === activeId);

  if (activeIndex === -1) {
    placeForward(normalizedItems, desiredTops, positions, {
      gap: safeGap,
      startIndex: 0,
      startTop: desiredTops[0] ?? safeEdgePadding,
    });
  } else {
    const activeItem = normalizedItems[activeIndex];
    positions.set(activeItem.id, desiredTops[activeIndex] ?? fallbackTops[activeIndex]);

    for (let index = activeIndex - 1; index >= 0; index -= 1) {
      const item = normalizedItems[index];
      const nextItem = normalizedItems[index + 1];
      const nextTop = positions.get(nextItem.id) ?? fallbackTops[index + 1];
      const maxTop = nextTop - safeGap - item.height;
      positions.set(item.id, Math.min(desiredTops[index] ?? maxTop, maxTop));
    }

    placeForward(normalizedItems, desiredTops, positions, {
      gap: safeGap,
      startIndex: activeIndex + 1,
      startTop:
        (positions.get(activeItem.id) ?? fallbackTops[activeIndex]) +
        activeItem.height +
        safeGap,
    });
  }

  let contentHeight = safeEdgePadding;
  for (const item of normalizedItems) {
    const top = positions.get(item.id);
    if (!Number.isFinite(top)) continue;
    contentHeight = Math.max(contentHeight, top + item.height + safeEdgePadding);
  }

  return { contentHeight, positions };
}

export function sortThreadsForRail(threads, liveOrder = new Map()) {
  return [...(threads ?? [])].sort((left, right) => {
    const leftStart = liveOrder.get(left.id) ?? MISSING_THREAD_ORDER;
    const rightStart = liveOrder.get(right.id) ?? MISSING_THREAD_ORDER;
    return leftStart - rightStart || String(left.createdAt ?? "").localeCompare(String(right.createdAt ?? ""));
  });
}

export function collectThreadLiveOrderFromAnchors(root) {
  const order = new Map();
  if (!root?.querySelectorAll) return order;

  let index = 0;
  const anchors = root.querySelectorAll(".redline-highlight[data-thread-id]");
  for (const element of anchors) {
    const threadId = element.getAttribute("data-thread-id");
    if (threadId && !order.has(threadId)) {
      order.set(threadId, index);
      index += 1;
    }
  }
  return order;
}

export function commentNavigationState(orderedIds = [], activeId = null) {
  const ordered = uniqueThreadIds(orderedIds);
  const activeIndex = activeId === null || activeId === undefined ? -1 : ordered.indexOf(activeId);
  const hasActive = activeIndex !== -1;
  return {
    hasComments: ordered.length > 0,
    nextDisabled: ordered.length === 0 || (hasActive && activeIndex === ordered.length - 1),
    previousDisabled: ordered.length === 0 || (hasActive && activeIndex === 0),
  };
}

export function commentNavigationTarget(orderedIds = [], activeId = null, direction = "next") {
  const ordered = uniqueThreadIds(orderedIds);
  if (ordered.length === 0) return null;

  const activeIndex = activeId === null || activeId === undefined ? -1 : ordered.indexOf(activeId);
  if (activeIndex === -1) return ordered[0];

  const offset = direction === "previous" ? -1 : 1;
  const targetIndex = clamp(activeIndex + offset, 0, ordered.length - 1);
  return targetIndex === activeIndex ? null : ordered[targetIndex];
}

function uniqueThreadIds(orderedIds = []) {
  const ordered = [];
  const seenOrdered = new Set();
  for (const id of orderedIds ?? []) {
    if (!id || seenOrdered.has(id)) continue;
    seenOrdered.add(id);
    ordered.push(id);
  }
  return ordered;
}

export function openAncestorDetails(element) {
  let current = element?.parentElement;
  while (current) {
    if (current.tagName === "DETAILS" && !current.hasAttribute("open")) {
      current.setAttribute("data-redline-opened-details", "true");
      current.setAttribute("open", "");
    }
    current = current.parentElement;
  }
}

export function removeRuntimeOpenedDetails(root) {
  if (!root?.querySelectorAll) return;
  for (const element of root.querySelectorAll("[data-redline-opened-details]")) {
    element.removeAttribute("data-redline-opened-details");
    element.removeAttribute("open");
  }
}

export function createProgrammaticScrollGuard({
  clearTimeoutFn = globalThis.clearTimeout,
  delay = 1400,
  onRestore = () => {},
  setTimeoutFn = globalThis.setTimeout,
} = {}) {
  let active = false;
  let timer = null;
  let token = 0;

  return {
    begin(threadId) {
      token += 1;
      const currentToken = token;
      active = true;
      clearTimeoutFn(timer);
      timer = setTimeoutFn(() => {
        if (currentToken !== token) return;
        active = false;
        timer = null;
        onRestore(threadId);
      }, delay);
    },

    cancel() {
      token += 1;
      active = false;
      clearTimeoutFn(timer);
      timer = null;
    },

    isActive() {
      return active;
    },
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function finiteNumber(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function finiteNumberOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function placeForward(items, desiredTops, positions, { gap, startIndex, startTop }) {
  let nextTop = startTop;
  for (let index = startIndex; index < items.length; index += 1) {
    const item = items[index];
    const top = Math.max(desiredTops[index] ?? nextTop, nextTop);
    positions.set(item.id, top);
    nextTop = top + item.height + gap;
  }
}
