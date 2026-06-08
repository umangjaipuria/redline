import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { AnchorStatus, Thread } from "../core";
import type { DocumentSessionInfo, DocumentStateResponse, SelectorInput } from "../shared";
import { ApiError, api } from "./api";
import { DocumentViewer } from "./viewer";
import { FileBrowser } from "./file-browser";
import { Rail } from "./rail";
import { BrandMark, FolderIcon, OpenIcon, PersonIcon, ChevronLeftIcon, ChevronRightIcon, RailIcon } from "./icons";
import { commentNavigationState, commentNavigationTarget, composerInsertIndex, stackedRailItemLayout } from "./layout";

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

  activeThreadRef.current = activeThread;
  selectionRef.current = selection;
  composerOpenRef.current = composerOpen;

  // Create the imperative viewer once the iframe element exists.
  useEffect(() => {
    if (!iframeRef.current || viewerRef.current) return;
    viewerRef.current = new DocumentViewer(iframeRef.current, {
      onSelection: (selectors) => setSelection(selectors),
      onHighlightClick: (threadId) => setActiveThread(threadId),
      onViewportChange: () => onViewportRef.current(),
      onCommentShortcut: () => beginCommentRef.current(),
    });
  }, [mode]);

  const refreshFrom = useCallback((next: DocumentStateResponse) => {
    setState(next);
    if (next.warning) {
      setNotice({ title: "Embedded review state could not be read", body: next.warning });
    }
    const viewer = viewerRef.current;
    if (!viewer) return;
    if (next.renderedHtml !== lastRenderedRef.current) {
      lastRenderedRef.current = next.renderedHtml;
      viewer.load(next.docId, next.renderedHtml).then(() => {
        viewer.applyHighlights(next.anchors, activeThreadRef.current);
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
        const requested = new URL(location.href).searchParams.get("doc");
        if (requested && list.some((doc) => doc.docId === requested)) {
          activate(requested);
        } else if (list.length === 1) {
          activate(list[0]!.docId);
        } else if (list.length > 1) {
          setMode("switcher");
        } else {
          setMode("empty");
        }
      } catch {
        setMode("empty");
      }
    })();
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
    viewerRef.current?.scrollToThread(id);
    requestAnimationFrame(() => {
      if (activeThreadRef.current !== id) return;
      const el = document.querySelector(`.thread-card[data-thread-id="${CSS.escape(id)}"]`) as HTMLElement | null;
      el?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  }, [activeThread]);

  // When the composer opens, scroll the rail so it is visible.
  useEffect(() => {
    if (!composerOpen) return;
    requestAnimationFrame(() => {
      (document.querySelector(".composer") as HTMLElement | null)?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  }, [composerOpen]);

  const onAuthorChange = (value: string) => {
    setAuthor(value);
    localStorage.setItem("redline.author", value);
  };

  const setRailCollapsed = useCallback((collapsed: boolean) => {
    setRailCollapsedState(collapsed);
    localStorage.setItem("redline.railCollapsed", collapsed ? "1" : "0");
  }, []);

  const openFile = async (path: string) => {
    try {
      const info = await api.openDoc(path);
      setBrowserOpen(false);
      setDocs((await api.listDocs()).docs);
      activate(info.docId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open that file.");
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
    setComposerSelection(sel);
    setComposerOpen(true);
    setRailCollapsed(false);
    if (fabRef.current) fabRef.current.hidden = true;
  }, [setRailCollapsed]);

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
    const composerEl = composerOpenRef.current ? (inner.querySelector(".composer") as HTMLElement | null) : null;
    // Cards in document order (the order Rail renders them), each with its
    // anchor's current viewport position.
    const entries = Array.from(inner.querySelectorAll<HTMLElement>(".thread-card[data-thread-id]")).map((el) => {
      const id = el.getAttribute("data-thread-id")!;
      return { id, el, height: el.offsetHeight, targetViewportTop: viewer.anchorViewportTop(id) };
    });
    // Splice the composer into its document position by selection location, so a
    // new comment never jumps ahead of an earlier comment scrolled out of view.
    if (composerEl) {
      const composerTarget = viewer.selectionViewportTop();
      const at = composerInsertIndex(entries.map((e) => e.targetViewportTop), composerTarget);
      entries.splice(at, 0, { id: "__composer__", el: composerEl, height: composerEl.offsetHeight, targetViewportTop: composerTarget });
    }
    // No active pinning, and railScrollTop fixed at 0: cards pack top-to-bottom in
    // document order at NON-NEGATIVE positions, so every card is reachable by
    // scrolling the rail (pinning the active card pushed earlier cards to negative
    // positions a scroll container can't reach). Positions are stable regardless of
    // rail scroll; alignment to the active comment is done by scrolling the rail to
    // it on activation (see the activeThread effect). At rail.scrollTop=0 the cards
    // sit at their anchors; scrolling the rail browses overflow.
    const { positions, contentHeight } = stackedRailItemLayout({
      items: entries.map((e) => ({ id: e.id, height: e.height, targetViewportTop: e.targetViewportTop })),
      railScrollTop: 0,
      railViewportTop: railTop,
    });
    for (const e of entries) {
      const top = positions.get(e.id);
      e.el.style.top = top === undefined ? "" : `${Math.round(top)}px`;
    }
    inner.style.height = `${Math.round(contentHeight)}px`;
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
  // onViewportChange; rail scroll comes through the Rail's onScroll prop.
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
    setSelection(null);
    const created = next.threads.find((t) => !prev.has(t.id));
    if (created) setActiveThread(created.id);
  };

  return (
    <div class="app-shell" data-rail={railMode} data-empty={mode !== "document" ? "true" : "false"}>
      <header class="topbar">
        <div class="brand">
          <button
            type="button"
            class="brand-home"
            onClick={goToChooser}
            disabled={docs.length <= 1}
            title={docs.length > 1 ? "Switch document" : undefined}
          >
            <span class="brand-mark" aria-hidden="true"><BrandMark /></span>
            <span class="app-name">redline</span>
          </button>
          {mode === "document" && state?.path && (
            <span class="document-id" title={state.path}>
              <span class="document-name">{basename(state.path)}</span>
              <span class="document-path">{state.path}</span>
            </span>
          )}
          <button type="button" class="icon-button open-icon" title="Open file…" aria-label="Open file" onClick={() => setBrowserOpen(true)}>
            <OpenIcon />
          </button>
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
                    <li key={doc.docId}>
                      <button type="button" class="chooser-item" onClick={() => activate(doc.docId)}>
                        <span class="chooser-title">{basename(doc.path)}</span>
                        <span class="chooser-path">{doc.path}</span>
                      </button>
                    </li>
                  ))}
                </ul>
                <button type="button" class="primary-button" onClick={() => setBrowserOpen(true)}>
                  Open another file…
                </button>
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
            onSelectThread={(id) => setActiveThread(id)}
            onCreateComment={createComment}
            onCancelComposer={cancelComposer}
            onReply={(threadId, text) => withWrite(() => api.reply(docId, threadId, text, author, state.version))}
            onEdit={(threadId, messageId, text) => withWrite(() => api.editMessage(docId, threadId, messageId, text, state.version))}
            onDeleteReply={(threadId, messageId) => withWrite(() => api.deleteReply(docId, threadId, messageId, state.version))}
            onDeleteThread={(threadId) => withWrite(() => api.deleteThread(docId, threadId, state.version))}
            onReanchor={(threadId) =>
              selection
                ? withWrite(() => api.reanchor(docId, threadId, selection.quote, undefined, state.version)).then(() =>
                    setSelection(null),
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

      {browserOpen && <FileBrowser onOpen={openFile} onClose={() => setBrowserOpen(false)} onError={setError} />}
    </div>
  );

  function jump(direction: "next" | "previous") {
    const target = commentNavigationTarget(railOrderIds, activeThreadRef.current, direction);
    if (target) setActiveThread(target);
  }
}

function isFormControl(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

function basename(path: string): string {
  return path.split("/").pop() || path;
}

export type { Thread };
