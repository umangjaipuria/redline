import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { AnchorStatus, Thread } from "../core";
import type { DocumentSessionInfo, DocumentStateResponse, SelectorInput } from "../shared";
import { ApiError, api } from "./api";
import { DocumentViewer } from "./viewer";
import { FileBrowser } from "./file-browser";
import { Rail } from "./rail";

type Mode = "loading" | "empty" | "document";

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

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const viewerRef = useRef<DocumentViewer | null>(null);
  const lastRenderedRef = useRef<string>("");
  const eventsRef = useRef<EventSource | null>(null);
  const activeDocRef = useRef<string | null>(null);
  const activeThreadRef = useRef<string | null>(null);

  activeThreadRef.current = activeThread;

  // Create the imperative viewer once the iframe element exists.
  useEffect(() => {
    if (!iframeRef.current || viewerRef.current) return;
    viewerRef.current = new DocumentViewer(iframeRef.current, {
      onSelection: (selectors) => setSelection(selectors),
      onHighlightClick: (threadId) => {
        setActiveThread(threadId);
      },
    });
  }, [mode]);

  const refreshFrom = useCallback((next: DocumentStateResponse) => {
    setState(next);
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

  // Initial load: branch on the open documents.
  useEffect(() => {
    (async () => {
      try {
        const { docs: list } = await api.listDocs();
        setDocs(list);
        const requested = new URL(location.href).searchParams.get("doc");
        if (requested && list.some((doc) => doc.docId === requested)) {
          activate(requested);
        } else if (list.length > 0) {
          activate(list[0]!.docId);
        } else {
          setMode("empty");
        }
      } catch {
        setMode("empty");
      }
    })();
    // Server-level stream keeps the doc list fresh for the switcher.
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

  // Keep active highlight in sync without a full repaint.
  useEffect(() => {
    viewerRef.current?.setActiveHighlight(activeThread);
    if (activeThread) viewerRef.current?.scrollToThread(activeThread);
  }, [activeThread]);

  const onAuthorChange = (value: string) => {
    setAuthor(value);
    localStorage.setItem("redline.author", value);
  };

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

  const statusByThread = useMemo(() => {
    const map = new Map<string, AnchorStatus>();
    for (const anchor of state?.anchors ?? []) map.set(anchor.threadId, anchor);
    return map;
  }, [state]);

  const docId = activeDocId;

  return (
    <div class="app-shell" data-mode={mode}>
      <header class="topbar">
        <div class="brand">
          <span class="brand-mark">✎</span>
          <span class="app-name">redline</span>
          {state?.title && <span class="document-title">{state.title}</span>}
          {docs.length > 1 && (
            <select
              class="doc-switcher"
              value={activeDocId ?? ""}
              onChange={(e) => activate((e.target as HTMLSelectElement).value)}
            >
              {docs.map((doc) => (
                <option value={doc.docId}>{doc.title || basename(doc.path)}</option>
              ))}
            </select>
          )}
        </div>
        <div class="toolbar">
          <label class="author-control">
            <span aria-hidden="true">👤</span>
            <input
              type="text"
              value={author}
              placeholder="Your name"
              onInput={(e) => onAuthorChange((e.target as HTMLInputElement).value)}
            />
          </label>
          <button type="button" class="ghost-button" onClick={() => setBrowserOpen(true)}>
            Open file…
          </button>
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
                <h1>No document open</h1>
                <p>Open an HTML file to review it. Comments are saved inside the file itself, so it stays portable.</p>
                <button type="button" class="primary-button" onClick={() => setBrowserOpen(true)}>
                  Open a file…
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
            onSelectThread={(id) => setActiveThread(id)}
            onCreateComment={(text, withSelection) =>
              withWrite(() =>
                api.createComment(docId, {
                  message: text,
                  author,
                  ...(withSelection && selection ? { selectors: selection } : {}),
                  expectedVersion: state.version,
                }),
              ).then(() => setSelection(null))
            }
            onReply={(threadId, text) =>
              withWrite(() => api.reply(docId, threadId, text, author, state.version))
            }
            onEdit={(threadId, messageId, text) =>
              withWrite(() => api.editMessage(docId, threadId, messageId, text, state.version))
            }
            onDeleteReply={(threadId, messageId) =>
              withWrite(() => api.deleteReply(docId, threadId, messageId))
            }
            onDeleteThread={(threadId) => withWrite(() => api.deleteThread(docId, threadId))}
            onReanchor={(threadId) =>
              selection
                ? withWrite(() => api.reanchor(docId, threadId, selection.quote)).then(() => setSelection(null))
                : Promise.resolve()
            }
          />
        )}
      </main>

      {browserOpen && (
        <FileBrowser onOpen={openFile} onClose={() => setBrowserOpen(false)} onError={setError} />
      )}
    </div>
  );
}

function basename(path: string): string {
  return path.split("/").pop() || path;
}

export type { Thread };
