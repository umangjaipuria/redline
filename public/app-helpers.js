export const MISSING_THREAD_ORDER = Number.MAX_SAFE_INTEGER;

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
    const leftStart =
      liveOrder.get(left.id) ?? left.anchor?.textPosition?.start ?? MISSING_THREAD_ORDER;
    const rightStart =
      liveOrder.get(right.id) ?? right.anchor?.textPosition?.start ?? MISSING_THREAD_ORDER;
    return leftStart - rightStart || String(left.createdAt ?? "").localeCompare(String(right.createdAt ?? ""));
  });
}

export function collectThreadLiveOrderFromAnchors(root) {
  const order = new Map();
  if (!root?.querySelectorAll) return order;

  let index = 0;
  const anchors = root.querySelectorAll(
    ".redline-highlight[data-thread-id], .coauthor-highlight[data-thread-id]",
  );
  for (const element of anchors) {
    const threadId = element.getAttribute("data-thread-id");
    if (threadId && !order.has(threadId)) {
      order.set(threadId, index);
      index += 1;
    }
  }
  return order;
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
