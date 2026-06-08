import { describe, expect, test } from "bun:test";
import {
  alignedRailItemTop,
  centeredRailScrollTop,
  commentNavigationState,
  commentNavigationTarget,
  composerInsertIndex,
  documentSyncedRailContentHeight,
  documentSyncedRailScrollTop,
  stackedRailItemLayout,
} from "./layout";

describe("alignedRailItemTop", () => {
  test("translates an anchor's viewport position into rail scroll space", () => {
    expect(alignedRailItemTop({ railScrollTop: 100, railViewportTop: 60, targetViewportTop: 200 })).toBe(240);
  });
  test("falls back to the rail viewport top when target is missing/non-finite", () => {
    expect(alignedRailItemTop({ railScrollTop: 0, railViewportTop: 50, targetViewportTop: NaN })).toBe(0);
  });
  test("clamps a negative rail scroll to zero", () => {
    expect(alignedRailItemTop({ railScrollTop: -10, railViewportTop: 0, targetViewportTop: 30 })).toBe(30);
  });
});

describe("centeredRailScrollTop", () => {
  test("centers a deep composer by scrolling only the rail", () => {
    expect(centeredRailScrollTop({
      itemHeight: 140,
      itemViewportTop: 720,
      maxScrollTop: 900,
      railClientHeight: 620,
      railScrollTop: 0,
      railViewportTop: 52,
    })).toBe(428);
  });

  test("clamps to the rail's own scroll range", () => {
    expect(centeredRailScrollTop({
      itemHeight: 120,
      itemViewportTop: 40,
      maxScrollTop: 500,
      railClientHeight: 600,
      railScrollTop: 0,
      railViewportTop: 52,
    })).toBe(0);
    expect(centeredRailScrollTop({
      itemHeight: 120,
      itemViewportTop: 1200,
      maxScrollTop: 500,
      railClientHeight: 600,
      railScrollTop: 0,
      railViewportTop: 52,
    })).toBe(500);
  });
});

describe("documentSyncedRailContentHeight", () => {
  test("keeps the rail scroll range tied to the document during comment jumps", () => {
    const documentRange = {
      documentClientHeight: 800,
      documentScrollHeight: 6200,
      railClientHeight: 700,
    };
    const beforeJump = documentSyncedRailContentHeight({ ...documentRange, contentHeight: 5200 });
    const afterAnchorIsVisible = documentSyncedRailContentHeight({ ...documentRange, contentHeight: 420 });
    expect(beforeJump).toBe(6100);
    expect(afterAnchorIsVisible).toBe(6100);
  });

  test("still grows to fit comments outside the document scroll range", () => {
    expect(documentSyncedRailContentHeight({
      contentHeight: 8000,
      documentClientHeight: 800,
      documentScrollHeight: 6200,
      railClientHeight: 700,
    })).toBe(8000);
  });
});

describe("documentSyncedRailScrollTop", () => {
  test("mirrors the document scroll position during automatic sync", () => {
    expect(documentSyncedRailScrollTop({
      currentRailScrollTop: 120,
      documentScrollTop: 840,
      fallbackScrollTop: 40,
    })).toBe(840);
  });

  test("preserves manual rail scroll during passive layout updates", () => {
    expect(documentSyncedRailScrollTop({
      currentRailScrollTop: 120,
      documentScrollTop: 840,
      fallbackScrollTop: 40,
      manualOverride: true,
    })).toBe(120);
  });

  test("uses the layout fallback when document metrics are unavailable", () => {
    expect(documentSyncedRailScrollTop({
      currentRailScrollTop: 120,
      fallbackScrollTop: 40,
    })).toBe(40);
  });
});

describe("stackedRailItemLayout", () => {
  test("empty input yields no positions", () => {
    const { positions, contentHeight, positionShift } = stackedRailItemLayout({ items: [] });
    expect(positions.size).toBe(0);
    expect(contentHeight).toBe(0);
    expect(positionShift).toBe(0);
  });

  test("packs items to their target tops without overlap (no active card)", () => {
    const { positions, positionShift } = stackedRailItemLayout({
      edgePadding: 16,
      gap: 12,
      railViewportTop: 0,
      railScrollTop: 0,
      items: [
        { id: "a", height: 100, targetViewportTop: 0 },
        { id: "b", height: 100, targetViewportTop: 50 }, // wants to overlap a
        { id: "c", height: 100, targetViewportTop: 400 },
      ],
    });
    // a sits at its target; b is pushed below a (0 + 100 + 12); c keeps its target.
    expect(positions.get("a")).toBe(0);
    expect(positions.get("b")).toBe(112);
    expect(positions.get("c")).toBe(400);
    expect(positionShift).toBe(0);
  });

  test("active card keeps its exact target; earlier cards are pushed above it", () => {
    const { positions } = stackedRailItemLayout({
      activeId: "b",
      edgePadding: 16,
      gap: 12,
      items: [
        { id: "a", height: 100, targetViewportTop: 300 }, // wants to overlap active b
        { id: "b", height: 100, targetViewportTop: 320 },
      ],
    });
    expect(positions.get("b")).toBe(320); // active pinned to its target
    expect(positions.get("a")).toBe(208); // 320 - 12 - 100, forced above
  });

  test("many cards on one anchor pack into a non-negative reachable stack (no active pin)", () => {
    // The reported bug: with the active card pinned, earlier cards were placed at
    // negative tops a scroll container can't reach. With no active pin, all cards
    // anchored to the same spot stack downward from edgePadding — every one
    // reachable (top >= 0), ordered, non-overlapping.
    const items = Array.from({ length: 6 }, (_, i) => ({ id: `c${i}`, height: 100, targetViewportTop: 120 }));
    const { positions, contentHeight } = stackedRailItemLayout({ edgePadding: 16, gap: 12, items });
    const tops = items.map((it) => positions.get(it.id)!);
    expect(Math.min(...tops)).toBeGreaterThanOrEqual(0);
    for (let i = 1; i < tops.length; i += 1) {
      expect(tops[i]!).toBeGreaterThanOrEqual(tops[i - 1]! + 100 + 12); // no overlap, in order
    }
    expect(contentHeight).toBe(tops[5]! + 100 + 16);
  });

  test("comments above the viewport stay reachable after jumping to a lower anchor", () => {
    const { positions, contentHeight, positionShift } = stackedRailItemLayout({
      edgePadding: 16,
      gap: 12,
      items: [
        { id: "top", height: 100, targetViewportTop: -520 },
        { id: "middle", height: 100, targetViewportTop: -340 },
        { id: "bottom", height: 100, targetViewportTop: 260 },
      ],
    });
    const tops = ["top", "middle", "bottom"].map((id) => positions.get(id)!);
    expect(Math.min(...tops)).toBe(0);
    for (let i = 1; i < tops.length; i += 1) {
      expect(tops[i]!).toBeGreaterThanOrEqual(tops[i - 1]! + 100 + 12);
    }
    expect(contentHeight).toBe(tops[2]! + 100 + 16);
    expect(positionShift).toBe(520);
  });

  test("null target (anchor offscreen) flows off the previous card", () => {
    const { positions } = stackedRailItemLayout({
      edgePadding: 16,
      gap: 12,
      items: [
        { id: "a", height: 100, targetViewportTop: 0 },
        { id: "b", height: 50, targetViewportTop: null },
      ],
    });
    expect(positions.get("a")).toBe(0);
    expect(positions.get("b")).toBe(112);
  });

  test("a new-file composer keeps its selected-text target instead of defaulting to the rail top", () => {
    const { positions, positionShift } = stackedRailItemLayout({
      edgePadding: 16,
      gap: 12,
      railViewportTop: 52,
      railScrollTop: 0,
      items: [
        { id: "__composer__", height: 140, targetViewportTop: 720 },
      ],
    });
    expect(positions.get("__composer__")).toBe(668);
    expect(positionShift).toBe(0);
  });
});

describe("composerInsertIndex", () => {
  test("composer goes after a card whose anchor is above the selection", () => {
    // The reported bug: one comment at the top of the file (scrolled off the top,
    // so its anchor target is negative); a new comment created near the bottom
    // (large positive target). The composer must come AFTER the top comment.
    expect(composerInsertIndex([-500], 600)).toBe(1);
  });

  test("composer goes before a card whose anchor is below the selection", () => {
    expect(composerInsertIndex([400], 100)).toBe(0);
  });

  test("composer lands between cards in document order", () => {
    expect(composerInsertIndex([0, 100, 200], 150)).toBe(2);
    expect(composerInsertIndex([0, 100, 200], 50)).toBe(1);
  });

  test("composer trails all cards when its selection is below them", () => {
    expect(composerInsertIndex([0, 100, 200], 300)).toBe(3);
  });

  test("orphaned (null-target) cards always sort after the composer", () => {
    expect(composerInsertIndex([0, 200, null], 300)).toBe(2);
    expect(composerInsertIndex([null], 100)).toBe(0);
  });

  test("a null composer target leaves cards in place (composer before orphans, else last)", () => {
    expect(composerInsertIndex([0, 100], null)).toBe(2);
    expect(composerInsertIndex([0, null], null)).toBe(1);
  });
});

describe("commentNavigationState", () => {
  test("no comments disables both directions", () => {
    expect(commentNavigationState([], null)).toEqual({ hasComments: false, previousDisabled: true, nextDisabled: true });
  });
  test("nothing active leaves both enabled", () => {
    expect(commentNavigationState(["a", "b"], null)).toEqual({ hasComments: true, previousDisabled: false, nextDisabled: false });
  });
  test("ends disable the matching direction", () => {
    expect(commentNavigationState(["a", "b", "c"], "a").previousDisabled).toBe(true);
    expect(commentNavigationState(["a", "b", "c"], "c").nextDisabled).toBe(true);
  });
});

describe("commentNavigationTarget", () => {
  test("first comment when nothing active", () => {
    expect(commentNavigationTarget(["a", "b"], null, "next")).toBe("a");
    expect(commentNavigationTarget(["a", "b"], null, "previous")).toBe("a");
  });
  test("steps one in each direction", () => {
    expect(commentNavigationTarget(["a", "b", "c"], "b", "next")).toBe("c");
    expect(commentNavigationTarget(["a", "b", "c"], "b", "previous")).toBe("a");
  });
  test("returns null at the ends", () => {
    expect(commentNavigationTarget(["a", "b"], "b", "next")).toBeNull();
    expect(commentNavigationTarget(["a", "b"], "a", "previous")).toBeNull();
  });
  test("deduplicates repeated ids before navigating", () => {
    expect(commentNavigationTarget(["a", "a", "b"], "a", "next")).toBe("b");
  });
});
