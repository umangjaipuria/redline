export const MISSING_THREAD_ORDER = Number.MAX_SAFE_INTEGER;

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
