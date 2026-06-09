import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { AnchorStatus, Thread } from "../core";
import type { DocumentSessionInfo, DocumentStateResponse, SelectorInput } from "../shared";
import { ApiError, api } from "./api";
import { DocumentViewer } from "./viewer";
import { FileBrowser } from "./file-browser";
import { pushRecentFolder } from "./recent";
import { Rail } from "./rail";
import { BrandMark, FolderIcon, OpenIcon, PersonIcon, ChevronLeftIcon, ChevronRightIcon, RailIcon } from "./icons";
import {
  centeredRailScrollTop,
  commentNavigationState,
  commentNavigationTarget,
  composerInsertIndex,
  documentSyncedRailContentHeight,
  documentSyncedRailScrollTop,
  nearestRailScrollTop,
  stackedRailItemLayout,
} from "./layout";

type Mode = "loading" | "empty" | "switcher" | "document";

const ALIGN_MIN_WIDTH = 941; // below this the rail flows normally (no anchor alignment)

export function App() {
  const [mode, setMode] = useState<Mode>("loading");
  const [docs, setDocs] = useState<DocumentSessionInfo[]>([]);
  const [activeDocId, setActiveDocId] = useState<string | null>(null);
  const [state, setState] = useState<DocumentStateResponse | null>(null);
  const [author, setAuthor] = useState<string>(() => localStorage.getItem("redline.author") || "User");
  const [activeThread, setActiveThread] = useState<string | null>(null);
  const [selection, setSelection] = useState<SelectorInput | null>(null);
  const [order, setOrder] = useState<string[]>([]);
  const [notice, setNotice] = useState<{ title: string; body: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [howtoPath, setHowtoPath] = useState<string | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [composerSelection, setComposerSelection] = useState<SelectorInput | null>(null);
  const [railCollapsed, setRailCollapsedState] = useState(() => localStorage.getItem("redline.railCollapsed") === "1");

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const viewerRef = useRef<DocumentViewer | null>(null);
  const lastRenderedRef = useRef<string>("");
  const eventsRef = useRef<EventSource | null>(null);
  const activeDocRef = useRef<string | null>(null);
  const activeThreadRef = useRef<string | null>(null);
  const selectionRef = useRef<SelectorInput | null>(null);
  const composerOpenRef = useRef(false);
  const railModeRef = useRef<string>("empty");
  const onViewportRef = useRef<() => void>(() => {});
  const beginCommentRef = useRef<() => void>(() => {});
  const fabRef = useRef<HTMLButtonElement | null>(null);
  const railRevealAnimationRef = useRef<number | null>(null);
  const railRevealGenerationRef = useRef(0);
  const railManualScrollRef = useRef(false);
  const skipNextActiveThreadDocumentScrollRef = useRef<Set<string>>(new Set());

  activeThreadRef.current = activeThread;
  selectionRef.current = selection;
  composerOpenRef.current = composerOpen;

  const setRailCollapsed = useCallback((collapsed: boolean) => {
    setRailCollapsedState(collapsed);
    localStorage.setItem("redline.railCollapsed", collapsed ? "1" : "0");
  }, []);

  const cancelRailRevealAnimation = useCallback(() => {
    if (railRevealAnimationRef.current !== null) {
      cancelAnimationFrame(railRevealAnimationRef.current);
      railRevealAnimationRef.current = null;
    }
    railRevealGenerationRef.current += 1;
  }, []);

  const markRailManualScroll = useCallback(() => {
    railManualScrollRef.current = true;
    cancelRailRevealAnimation();
  }, [cancelRailRevealAnimation]);

  const resumeRailSync = useCallback(() => {
    railManualScrollRef.current = false;
  }, []);

  useEffect(() => {
    const documentName = mode === "document" && state?.path ? basename(state.path) : null;
    document.title = documentName ? `${documentName} - redline` : "redline";
  }, [mode, state?.path]);

  const animateRailScrollTo = useCallback((rail: HTMLElement, targetTop: number, generation: number) => {
    if (railRevealAnimationRef.current !== null) {
      cancelAnimationFrame(railRevealAnimationRef.current);
      railRevealAnimationRef.current = null;
    }
    const startTop = rail.scrollTop;
    const distance = targetTop - startTop;
    if (Math.abs(distance) < 1) {
      if (railRevealGenerationRef.current === generation && !railManualScrollRef.current) {
        rail.scrollTop = targetTop;
      }
      return;
    }

    const startedAt = performance.now();
    const duration = 280;
    const step = (now: number) => {
      if (railRevealGenerationRef.current !== generation || railManualScrollRef.current) {
        railRevealAnimationRef.current = null;
        return;
      }
      const progress = Math.min(1, (now - startedAt) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      rail.scrollTop = startTop + distance * eased;
      if (progress < 1) {
        railRevealAnimationRef.current = requestAnimationFrame(step);
      } else {
        rail.scrollTop = targetTop;
        railRevealAnimationRef.current = null;
      }
    };
    railRevealAnimationRef.current = requestAnimationFrame(step);
  }, []);

  const revealRailElement = useCallback((selector: string, mode: "center" | "nearest" = "nearest") => {
    railManualScrollRef.current = false;
    if (railRevealAnimationRef.current !== null) {
      cancelAnimationFrame(railRevealAnimationRef.current);
      railRevealAnimationRef.current = null;
    }
    railRevealGenerationRef.current += 1;
    const generation = railRevealGenerationRef.current;
    const reveal = () => {
      if (railRevealGenerationRef.current !== generation || railManualScrollRef.current) return;
      const rail = document.querySelector(".comment-rail") as HTMLElement | null;
      const el = document.querySelector(selector) as HTMLElement | null;
      if (!rail || !el) return;
      const railRect = rail.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      const maxTop = Math.max(0, rail.scrollHeight - rail.clientHeight);
      const scrollTopForElement = mode === "center" ? centeredRailScrollTop : nearestRailScrollTop;
      animateRailScrollTo(rail, scrollTopForElement({
        itemHeight: el.offsetHeight,
        itemViewportTop: elRect.top,
        maxScrollTop: maxTop,
        railClientHeight: rail.clientHeight,
        railScrollTop: rail.scrollTop,
        railViewportTop: railRect.top,
      }), generation);
    };
    reveal();
    requestAnimationFrame(reveal);
    window.setTimeout(reveal, 140);
    window.setTimeout(reveal, 420);
  }, [animateRailScrollTo]);

  const revealThreadCardInRail = useCallback((id: string) => {
    revealRailElement(`.thread-card[data-thread-id="${CSS.escape(id)}"]`);
  }, [revealRailElement]);

  const revealComposerInRail = useCallback(() => {
    revealRailElement(".composer", "center");
  }, [revealRailElement]);

  const selectThreadFromHighlight = useCallback(
    (threadId: string | null) => {
      setActiveThread(threadId);
      if (!threadId) return;
      resumeRailSync();
      setRailCollapsed(false);
      revealThreadCardInRail(threadId);
    },
    [resumeRailSync, revealThreadCardInRail, setRailCollapsed],
  );

  // Create the imperative viewer once the iframe element exists.
  useEffect(() => {
    if (!iframeRef.current || viewerRef.current) return;
    viewerRef.current = new DocumentViewer(iframeRef.current, {
      onSelection: (selectors) => setSelection(selectors),
      onHighlightClick: selectThreadFromHighlight,
      onViewportChange: () => onViewportRef.current(),
      onDocumentUserScroll: () => resumeRailSync(),
      onCommentShortcut: () => beginCommentRef.current(),
    });
  }, [mode, resumeRailSync, selectThreadFromHighlight]);

  const refreshFrom = useCallback((next: DocumentStateResponse) => {
    setState(next);
    if (next.warning) {
      setNotice({ title: "Embedded review state could not be read", body: next.warning });
    }
    const viewer = viewerRef.current;
    if (!viewer) return;
    if (next.renderedHtml !== lastRenderedRef.current) {
      const previousRendered = lastRenderedRef.current;
      const scrollPosition =
        previousRendered && activeDocRef.current === next.docId ? viewer.scrollPosition() : null;
      lastRenderedRef.current = next.renderedHtml;
      viewer.load(next.docId, next.renderedHtml).then(() => {
        viewer.applyHighlights(next.anchors, activeThreadRef.current);
        if (scrollPosition) {
          viewer.restoreScrollPosition(scrollPosition);
          requestAnimationFrame(() => {
            viewer.restoreScrollPosition(scrollPosition);
            onViewportRef.current();
          });
        }
        setOrder(viewer.highlightOrder());
      });
    } else {
      viewer.applyHighlights(next.anchors, activeThreadRef.current);
      setOrder(viewer.highlightOrder());
    }
  }, []);

  const subscribe = useCallback(
    (docId: string) => {
      eventsRef.current?.close();
      const source = new EventSource(`/api/docs/${docId}/events`);
      const refetch = async () => {
        try {
          const next = await api.state(docId);
          if (activeDocRef.current === docId) refreshFrom(next);
        } catch {
          // Doc may have closed; ignore.
        }
      };
      for (const event of [
        "comment.created",
        "comment.replied",
        "comment.edited",
        "comment.deleted",
        "anchors.reconciled",
      ]) {
        source.addEventListener(event, refetch);
      }
      source.addEventListener("external.changed", () => {
        setNotice({ title: "Document changed on disk", body: "The file was edited outside Redline. Reloaded with anchors re-resolved." });
        refetch();
      });
      source.addEventListener("document.closed", () => {
        setNotice({ title: "Document closed", body: "This document was closed on the server." });
      });
      eventsRef.current = source;
    },
    [refreshFrom],
  );

  const activate = useCallback(
    async (docId: string) => {
      try {
        setError(null);
        activeDocRef.current = docId;
        setActiveDocId(docId);
        setActiveThread(null);
        setSelection(null);
        setComposerOpen(false);
        setComposerSelection(null);
        const next = await api.state(docId);
        setMode("document");
        lastRenderedRef.current = "";
        // refreshFrom needs the viewer; defer a tick so the iframe mounts.
        requestAnimationFrame(() => refreshFrom(next));
        subscribe(docId);
        const url = new URL(location.href);
        url.searchParams.set("doc", docId);
        history.replaceState(null, "", url);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not open the document.");
      }
    },
    [refreshFrom, subscribe],
  );

  // Return to the document chooser (the landing surface for multiple open docs).
  const goToChooser = useCallback(() => {
    eventsRef.current?.close();
    eventsRef.current = null;
    activeDocRef.current = null;
    setActiveDocId(null);
    setState(null);
    setActiveThread(null);
    setSelection(null);
    setComposerOpen(false);
    setMode("switcher");
    lastRenderedRef.current = "";
    const url = new URL(location.href);
    url.searchParams.delete("doc");
    history.replaceState(null, "", url);
  }, []);

  // Initial load: branch on the open documents.
  useEffect(() => {
    (async () => {
      try {
        const { docs: list } = await api.listDocs();
        setDocs(list);
        // Only a deep link (?doc=) opens a document directly. The bare root URL
        // always lands on the chooser/empty page — never auto-opens a doc, even
        // when just one is open.
        const requested = new URL(location.href).searchParams.get("doc");
        if (requested && list.some((doc) => doc.docId === requested)) {
          activate(requested);
        } else if (list.length > 0) {
          setMode("switcher");
        } else {
          setMode("empty");
        }
      } catch {
        setMode("empty");
      }
    })();
    // Surface the bundled how-it-works doc on the landing page (absent in some
    // packaged builds — then the link simply doesn't appear).
    api.howto().then(({ path }) => setHowtoPath(path)).catch(() => {});
    const serverEvents = new EventSource("/api/events");
    const refreshDocs = async () => {
      try {
        setDocs((await api.listDocs()).docs);
      } catch {
        /* ignore */
      }
    };
    serverEvents.addEventListener("document.opened", refreshDocs);
    serverEvents.addEventListener("document.closed", refreshDocs);
    return () => {
      serverEvents.close();
      eventsRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // On activation: highlight the anchor, scroll the document to center it, and
  // scroll the rail to reveal the active card (cards are a non-negative packed
  // list, so the active one may be below the fold). The two scrolls bring anchor
  // and card to the same height.
  useEffect(() => {
    viewerRef.current?.setActiveHighlight(activeThread);
    if (!activeThread) return;
    const id = activeThread;
    const skipDocumentScroll = skipNextActiveThreadDocumentScrollRef.current.delete(id);
    if (!skipDocumentScroll) viewerRef.current?.scrollToThread(id);
    revealThreadCardInRail(id);
  }, [activeThread, revealThreadCardInRail]);

  // When the composer opens, scroll the rail so it is visible.
  useEffect(() => {
    if (!composerOpen) return;
    revealComposerInRail();
  }, [composerOpen, revealComposerInRail]);

  const onAuthorChange = (value: string) => {
    setAuthor(value);
    localStorage.setItem("redline.author", value);
  };

  const openFile = async (path: string) => {
    try {
      const info = await api.openDoc(path);
      pushRecentFolder(dirname(path));
      setBrowserOpen(false);
      setDocs((await api.listDocs()).docs);
      activate(info.docId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open that file.");
    }
  };

  // Close a document from the chooser. Frees its server-side watcher + SSE and
  // drops it from the list; with nothing left we fall back to the empty state.
  const closeFile = async (docId: string) => {
    try {
      setError(null);
      await api.closeDoc(docId);
      const { docs: list } = await api.listDocs();
      setDocs(list);
      if (list.length === 0) setMode("empty");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not close that document.");
    }
  };

  const withWrite = async (fn: () => Promise<DocumentStateResponse>) => {
    try {
      setError(null);
      const next = await fn();
      refreshFrom(next);
      return next;
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.current) {
        setNotice({ title: "Document changed", body: "Someone else updated this document. Reloaded the latest." });
        refreshFrom(err.current);
      } else {
        setError(err instanceof Error ? err.message : "That action failed.");
      }
      throw err;
    }
  };

  // Open the composer for the current selection (from the FAB or the shortcut).
  const beginComment = useCallback(() => {
    const sel = selectionRef.current;
    if (!sel) return;
    resumeRailSync();
    setComposerSelection(sel);
    setComposerOpen(true);
    setRailCollapsed(false);
    if (fabRef.current) fabRef.current.hidden = true;
  }, [resumeRailSync, setRailCollapsed]);

  beginCommentRef.current = beginComment;

  const cancelComposer = useCallback(() => {
    setComposerOpen(false);
    setComposerSelection(null);
  }, []);

  // Cmd/Ctrl+Shift+M: comment on the current selection.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.key.toLowerCase() !== "m") return;
      if (isFormControl(event.target)) return;
      if (!selectionRef.current) return;
      event.preventDefault();
      beginComment();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [beginComment]);

  // Reposition / hide the floating comment button when the selection changes.
  useEffect(() => {
    onViewportRef.current();
  }, [selection, composerOpen]);

  const statusByThread = useMemo(() => {
    const map = new Map<string, AnchorStatus>();
    for (const anchor of state?.anchors ?? []) map.set(anchor.threadId, anchor);
    return map;
  }, [state]);

  // Thread ids in rail order (anchored by document order, orphaned last) — drives
  // the prev/next comment navigation.
  const railOrderIds = useMemo(() => {
    const index = new Map(order.map((id, i) => [id, i]));
    return [...(state?.threads ?? [])]
      .sort(
        (a, b) =>
          (index.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (index.get(b.id) ?? Number.MAX_SAFE_INTEGER) ||
          String(a.createdAt).localeCompare(String(b.createdAt)),
      )
      .map((thread) => thread.id);
  }, [state, order]);

  const docId = activeDocId;
  const threadCount = state?.threads.length ?? 0;
  const railMode =
    mode !== "document"
      ? "empty"
      : threadCount === 0 && !composerOpen
        ? "empty"
        : railCollapsed && !composerOpen
          ? "closed"
          : "open";
  railModeRef.current = railMode;
  const railOpen = railMode === "open";
  const nav = commentNavigationState(railOrderIds, activeThread);

  // Position rail cards (and the composer) absolutely so each tracks its anchor
  // as the document scrolls; pack to avoid overlap, in document order.
  const layoutRail = () => {
    const viewer = viewerRef.current;
    const inner = document.querySelector(".comment-rail-inner") as HTMLElement | null;
    const rail = document.querySelector(".comment-rail") as HTMLElement | null;
    if (!viewer || !inner || !rail) return;
    const clear = () => {
      inner.classList.remove("rail-aligned");
      inner.style.height = "";
      for (const el of Array.from(inner.querySelectorAll<HTMLElement>(".thread-card, .composer"))) el.style.top = "";
    };
    if (railModeRef.current !== "open" || window.innerWidth < ALIGN_MIN_WIDTH) {
      clear();
      return;
    }
    inner.classList.add("rail-aligned");
    const railTop = rail.getBoundingClientRect().top;
    const frameOffset = viewer.frameTop() - railTop;
    const scrollMetrics = viewer.scrollMetrics();
    const railTargetTop = (documentTop: number | null) =>
      documentTop === null ? null : documentTop + frameOffset;
    const composerEl = composerOpenRef.current ? (inner.querySelector(".composer") as HTMLElement | null) : null;
    // Cards in document order (the order Rail renders them), each with its
    // anchor's stable document position translated into rail scroll space.
    const entries = Array.from(inner.querySelectorAll<HTMLElement>(".thread-card[data-thread-id]")).map((el) => {
      const id = el.getAttribute("data-thread-id")!;
      return { id, el, height: el.offsetHeight, targetViewportTop: railTargetTop(viewer.anchorDocumentTop(id)) };
    });
    // Splice the composer into its document position by selection location, so a
    // new comment never jumps ahead of an earlier comment scrolled out of view.
    if (composerEl) {
      const composerTarget = railTargetTop(
        viewer.selectorDocumentTop(composerSelection) ?? viewer.selectionDocumentTop(),
      );
      const at = composerInsertIndex(entries.map((e) => e.targetViewportTop), composerTarget);
      entries.splice(at, 0, { id: "__composer__", el: composerEl, height: composerEl.offsetHeight, targetViewportTop: composerTarget });
    }
    // Cards are laid out in document coordinates, then the rail mirrors the
    // document's scrollTop. That keeps the rail scrollbar range stable during a
    // smooth document jump; viewport-relative positions would collapse the rail
    // height as the target anchor enters view.
    const { positions, contentHeight, positionShift } = stackedRailItemLayout({
      items: entries.map((e) => ({ id: e.id, height: e.height, targetViewportTop: e.targetViewportTop })),
      railScrollTop: 0,
      railViewportTop: 0,
    });
    for (const e of entries) {
      const top = positions.get(e.id);
      e.el.style.top = top === undefined ? "" : `${Math.round(top)}px`;
    }
    const syncedContentHeight = documentSyncedRailContentHeight({
      contentHeight,
      documentClientHeight: scrollMetrics?.clientHeight,
      documentScrollHeight: scrollMetrics?.scrollHeight,
      railClientHeight: rail.clientHeight,
    });
    inner.style.height = `${Math.round(syncedContentHeight)}px`;
    const focusedEntry = scrollMetrics
      ? focusedRailSyncEntry({
          activeId: activeThreadRef.current,
          entries: entries.map((e) => ({
            id: e.id,
            targetTop: e.targetViewportTop,
            top: positions.get(e.id),
          })),
          railClientHeight: rail.clientHeight,
          scrollTop: scrollMetrics.scrollTop,
        })
      : null;
    const nextRailScrollTop = documentSyncedRailScrollTop({
      currentRailScrollTop: rail.scrollTop,
      documentScrollTop: scrollMetrics?.scrollTop,
      fallbackScrollTop: positionShift,
      focusedItemTop: focusedEntry?.top,
      focusedTargetTop: focusedEntry?.targetTop,
      manualOverride: railManualScrollRef.current,
      maxScrollTop: syncedContentHeight - rail.clientHeight,
    });
    if (Math.abs(rail.scrollTop - nextRailScrollTop) >= 1) rail.scrollTop = nextRailScrollTop;
  };
  // Imperatively position/hide the floating comment button (no re-render on
  // scroll). Lives on the same viewport-change path as the rail layout so the
  // button stays glued to the selection while the document scrolls.
  const syncFab = () => {
    const el = fabRef.current;
    if (!el) return;
    if (!selectionRef.current || composerOpenRef.current) {
      el.hidden = true;
      return;
    }
    const rect = viewerRef.current?.selectionRect();
    if (!rect) {
      el.hidden = true;
      return;
    }
    el.style.left = `${Math.min(rect.right + 10, window.innerWidth - 22)}px`;
    el.style.top = `${Math.min(Math.max((rect.top + rect.bottom) / 2, 64), window.innerHeight - 20)}px`;
    el.hidden = false;
  };
  onViewportRef.current = () => {
    layoutRail();
    syncFab();
  };

  // Re-align after every render that changes the rail, and once more next frame
  // (card heights settle after paint).
  useEffect(() => {
    onViewportRef.current();
    const raf = requestAnimationFrame(() => onViewportRef.current());
    return () => cancelAnimationFrame(raf);
  });

  // Re-align on window resize. Document scroll comes through the viewer's
  // onViewportChange; manual rail scroll is tracked by Rail input events so
  // passive layout work does not snap the rail back to the document position.
  useEffect(() => {
    const onResize = () => onViewportRef.current();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const createComment = async (text: string) => {
    if (!docId || !state) return;
    const prev = new Set(state.threads.map((t) => t.id));
    const next = await withWrite(() =>
      api.createComment(docId, {
        message: text,
        author,
        ...(composerSelection ? { selectors: composerSelection } : {}),
        expectedVersion: state.version,
      }),
    );
    setComposerOpen(false);
    setComposerSelection(null);
    viewerRef.current?.clearSelection();
    const created = next.threads.find((t) => !prev.has(t.id));
    if (created) {
      skipNextActiveThreadDocumentScrollRef.current.add(created.id);
      setActiveThread(created.id);
    }
  };

  const deleteThread = async (threadId: string) => {
    if (!docId || !state) return;
    const wasActive = activeThreadRef.current === threadId;
    if (wasActive) setActiveThread(null);
    try {
      await withWrite(() => api.deleteThread(docId, threadId, state.version));
    } catch (error) {
      if (wasActive) setActiveThread(threadId);
      throw error;
    }
  };

  const guideLink = howtoPath ? (
    <button type="button" class="guide-link" onClick={() => openFile(howtoPath)}>
      New to Redline? Open the guide
    </button>
  ) : null;

  return (
    <div class="app-shell" data-rail={railMode} data-empty={mode !== "document" ? "true" : "false"}>
      <header class="topbar">
        <div class="brand">
          <button
            type="button"
            class="brand-home"
            onClick={goToChooser}
            disabled={mode !== "document"}
            title={mode === "document" ? "All documents" : undefined}
          >
            <span class="brand-mark" aria-hidden="true"><BrandMark /></span>
            <span class="app-name">redline</span>
          </button>
          {mode === "document" && state?.path && (() => {
            const dir = displayDir(state.path);
            return (
              <button
                type="button"
                class="document-switch"
                title={`${state.path}\nOpen another file…`}
                aria-label={`Current file ${basename(state.path)}. Open another file`}
                onClick={() => setBrowserOpen(true)}
              >
                <span class="document-switch-icon" aria-hidden="true"><OpenIcon /></span>
                <span class="document-id">
                  <span class="document-name">{basename(state.path)}</span>
                  <span class="document-path">
                    <span class="path-head">{dir.head}</span>
                    {dir.tail && <span class="path-tail">{dir.tail}</span>}
                  </span>
                </span>
              </button>
            );
          })()}
        </div>
        <div class="toolbar" aria-label="Document actions">
          <label class="author-control">
            <span class="author-icon" aria-hidden="true"><PersonIcon /></span>
            <input
              type="text"
              value={author}
              spellcheck={false}
              placeholder="Your name"
              onInput={(e) => onAuthorChange((e.target as HTMLInputElement).value)}
            />
          </label>
          {threadCount > 0 && (
            <>
              <span class="toolbar-divider" aria-hidden="true" />
              <div class="comment-controls">
                <button
                  type="button"
                  class="ghost-button comment-nav-button"
                  title="Previous comment"
                  aria-label="Previous comment"
                  disabled={nav.previousDisabled}
                  onClick={() => jump("previous")}
                >
                  <ChevronLeftIcon />
                </button>
                <button
                  type="button"
                  class={`ghost-button rail-toggle ${railOpen ? "active" : ""}`}
                  title={railOpen ? "Hide comments" : "Show comments"}
                  aria-pressed={railOpen ? "true" : "false"}
                  onClick={() => setRailCollapsed(railOpen)}
                >
                  <RailIcon />
                  <span class="btn-label">Comments</span>
                  <span class="count-badge">{threadCount}</span>
                </button>
                <button
                  type="button"
                  class="ghost-button comment-nav-button"
                  title="Next comment"
                  aria-label="Next comment"
                  disabled={nav.nextDisabled}
                  onClick={() => jump("next")}
                >
                  <ChevronRightIcon />
                </button>
              </div>
            </>
          )}
        </div>
      </header>

      {error && (
        <div class="banner error" role="alert">
          {error}
          <button type="button" onClick={() => setError(null)}>✕</button>
        </div>
      )}
      {notice && (
        <div class="banner notice" role="status">
          <strong>{notice.title}</strong> {notice.body}
          <button type="button" onClick={() => setNotice(null)}>✕</button>
        </div>
      )}

      <main class="workspace">
        <section class="document-pane">
          {mode === "empty" && (
            <div class="empty-state">
              <div class="empty-state-card">
                <span class="empty-state-mark" aria-hidden="true"><FolderIcon /></span>
                <h1>No document open</h1>
                <p>Open an HTML file to review it. Comments are saved inside the file itself, so it stays portable.</p>
                <button type="button" class="primary-button" onClick={() => setBrowserOpen(true)}>
                  Open a file…
                </button>
                {guideLink}
              </div>
            </div>
          )}
          {mode === "switcher" && (
            <div class="empty-state">
              <div class="empty-state-card chooser">
                <span class="empty-state-mark" aria-hidden="true"><FolderIcon /></span>
                <h1>Open documents</h1>
                <p>Pick a document to review.</p>
                <ul class="chooser-list">
                  {docs.map((doc) => (
                    <li key={doc.docId} class="chooser-row">
                      <button type="button" class="chooser-item" onClick={() => activate(doc.docId)}>
                        <span class="chooser-title">{basename(doc.path)}</span>
                        <span class="chooser-path">{doc.path}</span>
                      </button>
                      <button
                        type="button"
                        class="chooser-close"
                        title="Close document"
                        aria-label={`Close ${basename(doc.path)}`}
                        onClick={() => closeFile(doc.docId)}
                      >
                        ✕
                      </button>
                    </li>
                  ))}
                </ul>
                <button type="button" class="primary-button" onClick={() => setBrowserOpen(true)}>
                  Open another file…
                </button>
                {guideLink}
              </div>
            </div>
          )}
          {mode === "loading" && <div class="empty-state"><p>Loading…</p></div>}
          <iframe
            ref={iframeRef}
            class="document-frame"
            title="Reviewed document"
            hidden={mode !== "document"}
            sandbox="allow-same-origin"
          />
        </section>

        {mode === "document" && state && docId && (
          <Rail
            state={state}
            statusByThread={statusByThread}
            order={order}
            author={author}
            activeThread={activeThread}
            selection={selection}
            composerOpen={composerOpen}
            onDeselect={() => setActiveThread(null)}
            onManualScroll={markRailManualScroll}
            onSelectThread={(id) => {
              resumeRailSync();
              setActiveThread(id);
            }}
            onCreateComment={createComment}
            onCancelComposer={cancelComposer}
            onReply={(threadId, text) => withWrite(() => api.reply(docId, threadId, text, author, state.version))}
            onEdit={(threadId, messageId, text) => withWrite(() => api.editMessage(docId, threadId, messageId, text, state.version))}
            onDeleteReply={(threadId, messageId) => withWrite(() => api.deleteReply(docId, threadId, messageId, state.version))}
            onDeleteThread={deleteThread}
            onReanchor={(threadId) =>
              selection
                ? withWrite(() => api.reanchor(docId, threadId, selection.quote, undefined, state.version)).then(() =>
                    viewerRef.current?.clearSelection(),
                  )
                : Promise.resolve()
            }
          />
        )}
      </main>

      <button
        ref={fabRef}
        type="button"
        class="selection-fab"
        hidden
        title="Comment on selection"
        aria-label="Comment on selection"
        onMouseDown={(e) => e.preventDefault()}
        onClick={beginComment}
      >
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M4.5 6.5A2 2 0 0 1 6.5 4.5h11a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H10l-4 3.5v-3.5H6.5a2 2 0 0 1-2-2z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" />
          <path d="M9 10h6M9 7.6h6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
        </svg>
      </button>

      {browserOpen && (
        <FileBrowser
          initialDir={mode === "document" && state?.path ? dirname(state.path) : undefined}
          onOpen={openFile}
          onClose={() => setBrowserOpen(false)}
          onError={setError}
        />
      )}
    </div>
  );

  function jump(direction: "next" | "previous") {
    const target = commentNavigationTarget(railOrderIds, activeThreadRef.current, direction);
    if (target) {
      resumeRailSync();
      setActiveThread(target);
    }
  }
}

function isFormControl(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

function focusedRailSyncEntry(opts: {
  activeId: string | null;
  entries: { id: string; targetTop: number | null; top: number | undefined }[];
  railClientHeight: number;
  scrollTop: number;
}): { targetTop: number; top: number } | null {
  const candidates = opts.entries
    .filter((entry): entry is { id: string; targetTop: number; top: number } =>
      Number.isFinite(entry.targetTop) && Number.isFinite(entry.top),
    )
    .map((entry) => ({
      ...entry,
      viewportTop: entry.targetTop - opts.scrollTop,
    }))
    .filter((entry) => entry.viewportTop >= -32 && entry.viewportTop <= opts.railClientHeight + 32);
  if (candidates.length === 0) return null;
  const active = opts.activeId ? candidates.find((entry) => entry.id === opts.activeId) : null;
  const focused = active ?? candidates.sort(
    (a, b) =>
      Math.abs(a.viewportTop - opts.railClientHeight / 2) -
      Math.abs(b.viewportTop - opts.railClientHeight / 2),
  )[0]!;
  return { targetTop: focused.targetTop, top: focused.top };
}

function basename(path: string): string {
  return path.split("/").pop() || path;
}

function dirname(path: string): string {
  const idx = path.lastIndexOf("/");
  // idx === 0 means a file at the filesystem root ("/doc.html") → parent is "/".
  return idx > 0 ? path.slice(0, idx) : "/";
}

// The directory shown under the file name: the file name is already displayed
// above, so we drop it and show only the folder. We abbreviate $HOME to ~ and
// split off the last segment so it can stay pinned while the rest middle-truncates.
function displayDir(path: string): { head: string; tail: string } {
  const dir = dirname(path).replace(/^(\/Users\/[^/]+|\/home\/[^/]+|\/root)(?=\/|$)/, "~");
  const idx = dir.lastIndexOf("/");
  if (idx <= 0) return { head: dir, tail: "" };
  return { head: dir.slice(0, idx), tail: dir.slice(idx) };
}

export type { Thread };
