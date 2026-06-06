import { expect, test } from "bun:test";
import {
  alignedRailItemTop,
  collectThreadLiveOrderFromAnchors,
  commentNavigationState,
  commentNavigationTarget,
  createProgrammaticScrollGuard,
  openAncestorDetails,
  removeRuntimeOpenedDetails,
  sortThreadsForRail,
  stackedRailItemLayout,
} from "../public/app-helpers.js";

class FakeElement {
  readonly attributes = new Map<string, string>();
  readonly parentElement: FakeElement | null;
  readonly tagName: string;

  constructor(tagName: string, options: { attrs?: Record<string, string>; parent?: FakeElement } = {}) {
    this.tagName = tagName.toUpperCase();
    this.parentElement = options.parent ?? null;
    for (const [name, value] of Object.entries(options.attrs ?? {})) {
      this.attributes.set(name, value);
    }
  }

  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name: string) {
    return this.attributes.has(name);
  }

  removeAttribute(name: string) {
    this.attributes.delete(name);
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
}

class FakeRoot {
  constructor(private readonly nodes: FakeElement[]) {}

  querySelectorAll() {
    return this.nodes;
  }
}

test("aligns a floating rail item with the target viewport position", () => {
  expect(
    alignedRailItemTop({
      edgePadding: 16,
      itemHeight: 140,
      railScrollTop: 320,
      railViewportHeight: 700,
      railViewportTop: 52,
      targetViewportTop: 260,
    }),
  ).toBe(528);
});

test("lets a floating rail item follow the anchor past rail edges", () => {
  expect(
    alignedRailItemTop({
      edgePadding: 16,
      itemHeight: 180,
      railScrollTop: 100,
      railViewportHeight: 500,
      railViewportTop: 52,
      targetViewportTop: 20,
    }),
  ).toBe(68);

  expect(
    alignedRailItemTop({
      edgePadding: 16,
      itemHeight: 180,
      railScrollTop: 100,
      railViewportHeight: 500,
      railViewportTop: 52,
      targetViewportTop: 620,
    }),
  ).toBe(668);
});

test("lets passive rail cards scroll above the rail with their anchors", () => {
  const layout = stackedRailItemLayout({
    edgePadding: 16,
    gap: 12,
    railScrollTop: 0,
    railViewportHeight: 500,
    railViewportTop: 52,
    items: [
      { id: "thread_a", height: 100, targetViewportTop: 20 },
      { id: "thread_b", height: 100, targetViewportTop: 220 },
    ],
  });

  expect(layout.positions.get("thread_a")).toBe(-32);
  expect(layout.positions.get("thread_b")).toBe(168);
});

test("stacks rail cards toward their anchor-aligned positions in document order", () => {
  const layout = stackedRailItemLayout({
    edgePadding: 16,
    gap: 12,
    railScrollTop: 0,
    railViewportHeight: 700,
    railViewportTop: 52,
    items: [
      { id: "thread_a", height: 100, targetViewportTop: 120 },
      { id: "thread_b", height: 100, targetViewportTop: 160 },
      { id: "thread_c", height: 100, targetViewportTop: 500 },
    ],
  });

  expect(layout.positions.get("thread_a")).toBe(68);
  expect(layout.positions.get("thread_b")).toBe(180);
  expect(layout.positions.get("thread_c")).toBe(448);
  expect(layout.contentHeight).toBe(564);
});

test("gives the active rail card priority while preserving surrounding order", () => {
  const layout = stackedRailItemLayout({
    activeId: "thread_b",
    edgePadding: 16,
    gap: 12,
    railScrollTop: 0,
    railViewportHeight: 700,
    railViewportTop: 52,
    items: [
      { id: "thread_a", height: 120, targetViewportTop: 460 },
      { id: "thread_b", height: 120, targetViewportTop: 260 },
      { id: "thread_c", height: 120, targetViewportTop: 300 },
    ],
  });

  expect(layout.positions.get("thread_b")).toBe(208);
  expect(layout.positions.get("thread_a")).toBe(76);
  expect(layout.positions.get("thread_c")).toBe(340);
});

test("keeps the active rail card with its anchor and moves earlier cards above it", () => {
  const layout = stackedRailItemLayout({
    activeId: "thread_c",
    edgePadding: 16,
    gap: 12,
    railScrollTop: 0,
    railViewportHeight: 500,
    railViewportTop: 52,
    items: [
      { id: "thread_a", height: 180, targetViewportTop: 40 },
      { id: "thread_b", height: 180, targetViewportTop: 80 },
      { id: "thread_c", height: 180, targetViewportTop: 120 },
    ],
  });

  expect(layout.positions.get("thread_a")).toBe(-316);
  expect(layout.positions.get("thread_b")).toBe(-124);
  expect(layout.positions.get("thread_c")).toBe(68);
});

test("sorts comment threads by live anchor order before stale text positions", () => {
  const threads = [
    thread("thread_top", 900, "2026-01-03T00:00:00.000Z"),
    thread("thread_middle", 100, "2026-01-02T00:00:00.000Z"),
    thread("thread_bottom", 50, "2026-01-01T00:00:00.000Z"),
  ];

  const sorted = sortThreadsForRail(
    threads,
    new Map([
      ["thread_top", 0],
      ["thread_middle", 1],
      ["thread_bottom", 2],
    ]),
  );

  expect(sorted.map((item) => item.id)).toEqual(["thread_top", "thread_middle", "thread_bottom"]);
  expect(threads.map((item) => item.id)).toEqual(["thread_top", "thread_middle", "thread_bottom"]);
});

test("falls back to text position, missing positions last, and created time for ties", () => {
  const sorted = sortThreadsForRail([
    thread("thread_missing", undefined, "2026-01-01T00:00:00.000Z"),
    thread("thread_later_tie", 12, "2026-01-03T00:00:00.000Z"),
    thread("thread_early", 3, "2026-01-02T00:00:00.000Z"),
    thread("thread_earlier_tie", 12, "2026-01-01T00:00:00.000Z"),
  ]);

  expect(sorted.map((item) => item.id)).toEqual([
    "thread_early",
    "thread_earlier_tie",
    "thread_later_tie",
    "thread_missing",
  ]);
});

test("collects first visible anchor order from highlighted frame nodes", () => {
  const anchors = new FakeRoot([
    new FakeElement("span", { attrs: { "data-thread-id": "thread_a" } }),
    new FakeElement("span", { attrs: { "data-thread-id": "thread_b" } }),
    new FakeElement("span", { attrs: { "data-thread-id": "thread_a" } }),
    new FakeElement("span"),
    new FakeElement("span", { attrs: { "data-thread-id": "thread_c" } }),
  ]);

  expect([...collectThreadLiveOrderFromAnchors(anchors).entries()]).toEqual([
    ["thread_a", 0],
    ["thread_b", 1],
    ["thread_c", 2],
  ]);
});

test("comment navigation starts at the first comment when none is active", () => {
  const ordered = ["thread_a", "thread_b", "thread_c"];

  expect(commentNavigationState(ordered, null)).toEqual({
    hasComments: true,
    nextDisabled: false,
    previousDisabled: false,
  });
  expect(commentNavigationTarget(ordered, null, "previous")).toBe("thread_a");
  expect(commentNavigationTarget(ordered, null, "next")).toBe("thread_a");
});

test("comment navigation disables at document-order ends", () => {
  const ordered = ["thread_a", "thread_b", "thread_c"];

  expect(commentNavigationState(ordered, "thread_a")).toEqual({
    hasComments: true,
    nextDisabled: false,
    previousDisabled: true,
  });
  expect(commentNavigationTarget(ordered, "thread_a", "previous")).toBeNull();
  expect(commentNavigationTarget(ordered, "thread_a", "next")).toBe("thread_b");

  expect(commentNavigationState(ordered, "thread_c")).toEqual({
    hasComments: true,
    nextDisabled: true,
    previousDisabled: false,
  });
  expect(commentNavigationTarget(ordered, "thread_c", "previous")).toBe("thread_b");
  expect(commentNavigationTarget(ordered, "thread_c", "next")).toBeNull();
});

test("opens closed ancestor details so hidden anchors can be revealed", () => {
  const body = new FakeElement("body");
  const alreadyOpenDetails = new FakeElement("details", { attrs: { open: "" }, parent: body });
  const closedDetails = new FakeElement("details", { parent: alreadyOpenDetails });
  const paragraph = new FakeElement("p", { parent: closedDetails });
  const anchor = new FakeElement("span", { parent: paragraph });

  openAncestorDetails(anchor);

  expect(closedDetails.hasAttribute("open")).toBe(true);
  expect(closedDetails.getAttribute("data-redline-opened-details")).toBe("true");
  expect(alreadyOpenDetails.hasAttribute("open")).toBe(true);
  expect(alreadyOpenDetails.hasAttribute("data-redline-opened-details")).toBe(false);
});

test("removes only runtime-opened details before saving document html", () => {
  const runtimeOpened = new FakeElement("details", {
    attrs: { "data-redline-opened-details": "true", open: "" },
  });
  const runtimeOpenedNested = new FakeElement("details", {
    attrs: { "data-redline-opened-details": "true", open: "" },
  });
  const root = new FakeRoot([runtimeOpened, runtimeOpenedNested]);

  removeRuntimeOpenedDetails(root);

  for (const detail of [runtimeOpened, runtimeOpenedNested]) {
    expect(detail.hasAttribute("data-redline-opened-details")).toBe(false);
    expect(detail.hasAttribute("open")).toBe(false);
  }
});

test("programmatic scroll guard restores the selected thread after smooth scroll settles", () => {
  const callbacks: Array<() => void> = [];
  const restored: string[] = [];
  const guard = createProgrammaticScrollGuard({
    delay: 700,
    setTimeoutFn: (callback, delay) => {
      expect(delay).toBe(700);
      callbacks.push(callback);
      return callbacks.length;
    },
    clearTimeoutFn: () => {},
    onRestore: (threadId) => restored.push(threadId),
  });

  guard.begin("thread_a");

  expect(guard.isActive()).toBe(true);
  callbacks[0]?.();
  expect(guard.isActive()).toBe(false);
  expect(restored).toEqual(["thread_a"]);
});

test("programmatic scroll guard ignores canceled and stale timers", () => {
  const callbacks: Array<() => void> = [];
  const restored: string[] = [];
  const cleared: unknown[] = [];
  const guard = createProgrammaticScrollGuard({
    setTimeoutFn: (callback) => {
      callbacks.push(callback);
      return callbacks.length;
    },
    clearTimeoutFn: (timer) => cleared.push(timer),
    onRestore: (threadId) => restored.push(threadId),
  });

  guard.begin("thread_a");
  guard.cancel();
  callbacks[0]?.();

  guard.begin("thread_b");
  const staleCallback = callbacks[1];
  guard.begin("thread_c");
  staleCallback?.();
  callbacks[2]?.();

  expect(guard.isActive()).toBe(false);
  expect(restored).toEqual(["thread_c"]);
  expect(cleared).toEqual([null, 1, null, 2]);
});

function thread(id: string, start: number | undefined, createdAt: string) {
  return {
    id,
    createdAt,
    anchor: start === undefined ? { type: "text-range" } : { type: "text-range", textPosition: { start } },
  };
}
