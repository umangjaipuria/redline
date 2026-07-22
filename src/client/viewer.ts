// The imperative iframe document viewer, kept behind a small controller so
// React/Preact never models the reviewed document DOM. It loads rendered content
// into a locked-down sandboxed iframe, paints highlights by re-finding the
// resolved quote in the rendered text layer (the shared normalization contract),
// tracks the live selection for comment capture, and scrolls to a thread.

import { findQuoteMatches, normalizeQuoteKey, resolveAnchor, type AnchorStatus } from "../core";
import type { SelectorInput } from "../shared";
import { assetsBase } from "./api";

const CONTEXT_WINDOW = 32;

// Block-level tags contribute a boundary space to the canonical text, matching
// the server's extractText so client and server agree on what the text "is".
const BLOCK_TAGS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DETAILS", "DD", "DIV", "DL",
  "DT", "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER", "FORM", "H1", "H2",
  "H3", "H4", "H5", "H6", "HEADER", "HGROUP", "HR", "LI", "MAIN", "NAV",
  "OL", "P", "PRE", "SECTION", "TABLE", "TBODY", "TD", "TFOOT", "TH",
  "THEAD", "TR", "UL", "BR",
]);

interface CharRef {
  node: Text;
  offset: number;
}

interface TextIndex {
  text: string; // the document's canonical-ish text layer
  chars: CharRef[]; // per-character map back to (text node, offset)
  nodeStart: Map<Text, number>; // text node -> its first index in `text`
}

export interface ViewerCallbacks {
  onSelection: (selectors: SelectorInput | null) => void;
  // A highlight was clicked (activate its thread), or empty document space was
  // clicked (null → deactivate the current thread).
  onHighlightClick: (threadId: string | null) => void;
  // Fired when the document scrolls or its layout changes, so the rail can
  // re-align comment cards to their anchors.
  onViewportChange?: () => void;
  // Fired for user input that intends to scroll the document. Programmatic
  // smooth scrolls still emit onViewportChange, but should not by themselves
  // reclaim manual rail scrolling.
  onDocumentUserScroll?: () => void;
  // Cmd/Ctrl+Shift+M pressed while focus is inside the document iframe — the
  // parent window never sees that keydown, so the viewer forwards it.
  onCommentShortcut?: () => void;
}

export class DocumentViewer {
  private index: TextIndex | null = null;
  private resizeObserver: ResizeObserver | null = null;

  constructor(
    private readonly iframe: HTMLIFrameElement,
    private readonly callbacks: ViewerCallbacks,
  ) {}

  // Load rendered HTML for a document. Injects a <base> so relative asset URLs
  // resolve through the doc-scoped asset route. Resolves once the content has
  // parsed and the text index is built.
  load(docId: string, renderedHtml: string): Promise<void> {
    const withBase = injectBase(renderedHtml, assetsBase(docId));
    return new Promise((resolve) => {
      const onLoad = () => {
        this.iframe.removeEventListener("load", onLoad);
        this.attachDocumentListeners();
        this.rebuildIndex();
        resolve();
      };
      this.iframe.addEventListener("load", onLoad);
      this.iframe.srcdoc = withBase;
    });
  }

  private doc(): Document | null {
    return this.iframe.contentDocument;
  }

  private attachDocumentListeners(): void {
    const doc = this.doc();
    if (!doc) return;
    doc.addEventListener("mouseup", () => this.emitSelection());
    doc.addEventListener("keyup", () => this.emitSelection());
    doc.addEventListener("click", (event) => {
      const target = hasClosest(event.target) ? event.target : null;
      const highlight = target?.closest?.(".redline-highlight[data-thread-id]") as HTMLElement | null;
      const threadId = highlight?.getAttribute("data-thread-id") ?? null;
      // Clicking a highlight activates its thread; clicking elsewhere in the
      // document deactivates the current one.
      this.callbacks.onHighlightClick(threadId);
      this.handleLocalFragmentClick(doc, target, event);
    });
    doc.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "m") {
        event.preventDefault();
        this.callbacks.onCommentShortcut?.();
      }
      if (isScrollKey(event.key)) this.callbacks.onDocumentUserScroll?.();
    });
    // Anything that moves an anchor on screen should re-align the rail: the main
    // document scroll, a scroll inside a nested scroller (capture phase, since
    // scroll doesn't bubble), an iframe resize, and late font layout. (A fresh
    // document/window is created on each load, so these per-load listeners are
    // discarded with it — no accumulation.)
    const notify = () => this.callbacks.onViewportChange?.();
    const userScrollIntent = () => this.callbacks.onDocumentUserScroll?.();
    const scrollbarIntent = (event: MouseEvent | PointerEvent) => {
      const win = this.iframe.contentWindow;
      if (!win) return;
      const scrollbarLane = 24;
      if (event.clientX >= win.innerWidth - scrollbarLane || event.clientY >= win.innerHeight - scrollbarLane) {
        userScrollIntent();
      }
    };
    const win = this.iframe.contentWindow;
    win?.addEventListener("wheel", userScrollIntent, { passive: true });
    win?.addEventListener("touchstart", userScrollIntent, { passive: true });
    win?.addEventListener("scroll", notify, { passive: true });
    win?.addEventListener("resize", notify, { passive: true });
    doc.addEventListener("pointerdown", scrollbarIntent, { capture: true, passive: true });
    doc.addEventListener("mousedown", scrollbarIntent, { capture: true, passive: true });
    doc.addEventListener("scroll", notify, { capture: true, passive: true });
    doc.fonts?.ready?.then(notify).catch(() => {});
    // Content reflow (images loading, late layout) also shifts anchors.
    this.resizeObserver?.disconnect();
    if (typeof ResizeObserver !== "undefined" && doc.body) {
      this.resizeObserver = new ResizeObserver(notify);
      this.resizeObserver.observe(doc.body);
    }
  }

  // Rebuild the text layer + offset map. Called after load and after every
  // highlight repaint (which mutates the DOM).
  private rebuildIndex(): void {
    const doc = this.doc();
    if (!doc?.body) {
      this.index = null;
      return;
    }
    const chars: CharRef[] = [];
    const nodeStart = new Map<Text, number>();
    let text = "";
    let lastBlockAncestor: Element | null = null;

    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
      // Exclude script/style/hidden text so the client's text layer matches the
      // server's extractText (the shared canonical-text contract).
      acceptNode: (candidate) =>
        isExcludedText(candidate as Text) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    let node = walker.nextNode() as Text | null;
    while (node) {
      const block = nearestBlock(node);
      // Insert a boundary space when we cross into a different block, so block
      // boundaries normalize the same as the server's synthetic spaces.
      if (text.length > 0 && block !== lastBlockAncestor && !/\s$/.test(text)) {
        text += " ";
        chars.push({ node, offset: 0 }); // synthetic; never a match start/end
      }
      lastBlockAncestor = block;
      nodeStart.set(node, text.length);
      const data = node.data;
      for (let i = 0; i < data.length; i += 1) {
        text += data[i];
        chars.push({ node, offset: i });
      }
      node = walker.nextNode() as Text | null;
    }
    this.index = { text, chars, nodeStart };
  }

  private handleLocalFragmentClick(doc: Document, target: Element | null, event: MouseEvent): void {
    const link = target?.closest?.("a[href]") as HTMLAnchorElement | null;
    const fragment = localFragmentFromHref(link?.getAttribute("href") ?? null);
    if (fragment === null) return;

    event.preventDefault();
    if (fragment === "") {
      doc.defaultView?.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }

    const named = doc.getElementsByName(fragment)[0];
    const destination = doc.getElementById(fragment) ?? named ?? null;
    destination?.scrollIntoView({ block: "start", behavior: "smooth" });
  }

  // Paint highlights for the resolved anchors. Each anchored / needs-review
  // status carries its current quote; we re-find it in the rendered text and
  // wrap the matched range. A quote we cannot uniquely locate is left unpainted
  // (the rail still flags it) rather than mis-highlighted.
  applyHighlights(anchors: AnchorStatus[], activeThreadId: string | null): void {
    const doc = this.doc();
    if (!doc?.body) return;
    this.clearHighlights();
    this.rebuildIndex();
    const index = this.index;
    if (!index) return;

    // Resolve every range against the FRESH index first, then wrap from the end
    // of the document backward. Wrapping splits text nodes, which would
    // invalidate the index for any later range in the same node — back-to-front
    // wrapping keeps every lower offset valid because the original (truncated)
    // node still holds those characters.
    const planned: { range: Range; threadId: string; state: string; start: number }[] = [];
    for (const anchor of anchors) {
      if (anchor.state === "orphaned" || !anchor.quote) continue;
      const located = this.locate(index, anchor);
      if (!located) continue;
      planned.push({ range: located.range, threadId: anchor.threadId, state: anchor.state, start: located.start });
    }
    planned.sort((a, b) => b.start - a.start);
    for (const item of planned) {
      wrapRange(doc, item.range, item.threadId, item.state, item.threadId === activeThreadId);
    }
    // Wrapping split text nodes, so the offset map built above no longer points at
    // the live DOM nodes. Rebuild it so selection capture can map the current nodes
    // — otherwise selecting text in an already-highlighted block resolves to no
    // anchor and the comment button never appears.
    this.rebuildIndex();
    // Anchors were (re)painted — positions may have shifted, so re-align.
    this.callbacks.onViewportChange?.();
  }

  setActiveHighlight(activeThreadId: string | null): void {
    const doc = this.doc();
    if (!doc?.body) return;
    for (const el of Array.from(doc.querySelectorAll(".redline-highlight[data-thread-id]"))) {
      el.classList.toggle("active", el.getAttribute("data-thread-id") === activeThreadId);
    }
  }

  scrollToThread(threadId: string): void {
    const doc = this.doc();
    const el = doc?.querySelector(`.redline-highlight[data-thread-id="${cssEscape(threadId)}"]`);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  scrollPosition(): { left: number; top: number } | null {
    const win = this.iframe.contentWindow;
    if (!win) return null;
    return { left: win.scrollX, top: win.scrollY };
  }

  restoreScrollPosition(position: { left: number; top: number } | null): void {
    const win = this.iframe.contentWindow;
    if (!win || !position) return;
    win.scrollTo(position.left, position.top);
  }

  clearSelection(): void {
    const selection = this.doc()?.getSelection?.();
    selection?.removeAllRanges();
    this.callbacks.onSelection(null);
  }

  scrollMetrics(): { clientHeight: number; scrollHeight: number; scrollTop: number } | null {
    const doc = this.doc();
    const win = this.iframe.contentWindow;
    if (!doc?.documentElement || !win) return null;
    return {
      clientHeight: win.innerHeight || doc.documentElement.clientHeight,
      scrollHeight: Math.max(doc.documentElement.scrollHeight, doc.body?.scrollHeight ?? 0),
      scrollTop: win.scrollY,
    };
  }

  // The iframe's position in the top-window viewport — added to in-iframe
  // coordinates to translate anchor/selection geometry into window space.
  frameTop(): number {
    return this.iframe.getBoundingClientRect().top;
  }

  // Top-window viewport Y of a thread's anchor (the topmost of its highlight
  // rects), or null when the anchor isn't currently rendered/in layout.
  anchorViewportTop(threadId: string): number | null {
    const doc = this.doc();
    if (!doc) return null;
    let top = Infinity;
    for (const el of Array.from(
      doc.querySelectorAll(`.redline-highlight[data-thread-id="${cssEscape(threadId)}"]`),
    )) {
      for (const rect of Array.from(el.getClientRects())) {
        if (rect.width === 0 && rect.height === 0) continue;
        top = Math.min(top, rect.top);
      }
    }
    return top === Infinity ? null : this.frameTop() + top;
  }

  anchorDocumentTop(threadId: string): number | null {
    const metrics = this.scrollMetrics();
    const viewportTop = this.anchorViewportTop(threadId);
    if (!metrics || viewportTop === null) return null;
    return viewportTop - this.frameTop() + metrics.scrollTop;
  }

  // The live selection's last rect, in top-window coordinates — used to place
  // the floating "comment on selection" button beside the selection.
  selectionRect(): { left: number; right: number; top: number; bottom: number } | null {
    const doc = this.doc();
    const selection = doc?.getSelection?.();
    if (!doc || !selection || selection.isCollapsed || selection.rangeCount === 0) return null;
    const rects = selection.getRangeAt(0).getClientRects();
    const rect = rects[rects.length - 1];
    if (!rect || (rect.width === 0 && rect.height === 0)) return null;
    const frameLeft = this.iframe.getBoundingClientRect().left;
    const frameTop = this.frameTop();
    return {
      left: frameLeft + rect.left,
      right: frameLeft + rect.right,
      top: frameTop + rect.top,
      bottom: frameTop + rect.bottom,
    };
  }

  // Top-window Y of the start of the current selection — used to align the
  // floating composer to the text being commented on.
  selectionViewportTop(): number | null {
    const doc = this.doc();
    const selection = doc?.getSelection?.();
    if (!doc || !selection || selection.rangeCount === 0) return null;
    const rects = selection.getRangeAt(0).getClientRects();
    const rect = rects[0];
    if (!rect) return null;
    return this.frameTop() + rect.top;
  }

  selectionDocumentTop(): number | null {
    const metrics = this.scrollMetrics();
    const viewportTop = this.selectionViewportTop();
    if (!metrics || viewportTop === null) return null;
    return viewportTop - this.frameTop() + metrics.scrollTop;
  }

  // Top-window Y for a saved selection selector. Used after focus has moved out
  // of the iframe, when the browser may have cleared the live Selection object.
  selectorViewportTop(selectors: SelectorInput | null): number | null {
    const index = this.index;
    if (!index || !selectors?.quote) return null;
    const start = Number.isFinite(selectors.posStart) ? selectors.posStart! : 0;
    const resolution = resolveAnchor(index.text, {
      quote: selectors.quote,
      prefix: selectors.prefix ?? "",
      suffix: selectors.suffix ?? "",
      posStart: start,
      posEnd: Number.isFinite(selectors.posEnd) ? selectors.posEnd! : start + selectors.quote.length,
    });
    if (!resolution.range) return null;
    const range = this.rangeFor(index, resolution.range.start, resolution.range.end);
    if (!range) return null;
    for (const rect of Array.from(range.getClientRects())) {
      if (rect.width === 0 && rect.height === 0) continue;
      return this.frameTop() + rect.top;
    }
    return null;
  }

  selectorDocumentTop(selectors: SelectorInput | null): number | null {
    const metrics = this.scrollMetrics();
    const viewportTop = this.selectorViewportTop(selectors);
    if (!metrics || viewportTop === null) return null;
    return viewportTop - this.frameTop() + metrics.scrollTop;
  }

  // The DOM order of currently-painted highlights — drives rail ordering so the
  // rail follows document order.
  highlightOrder(): string[] {
    const doc = this.doc();
    if (!doc?.body) return [];
    const order: string[] = [];
    const seen = new Set<string>();
    for (const el of Array.from(doc.querySelectorAll(".redline-highlight[data-thread-id]"))) {
      const id = el.getAttribute("data-thread-id");
      if (id && !seen.has(id)) {
        seen.add(id);
        order.push(id);
      }
    }
    return order;
  }

  private clearHighlights(): void {
    const doc = this.doc();
    if (!doc?.body) return;
    for (const el of Array.from(doc.querySelectorAll(".redline-highlight[data-thread-id]"))) {
      const parent = el.parentNode;
      if (!parent) continue;
      while (el.firstChild) parent.insertBefore(el.firstChild, el);
      parent.removeChild(el);
    }
    doc.body.normalize();
  }

  // Locate an anchor's quote in the current text. The server already resolved
  // the anchor to a concrete range (choosing the right occurrence by context +
  // position); the client follows that decision by preferring the match nearest
  // the server's resolved offset, falling back to prefix/suffix context only
  // when no server range is available. A genuinely ambiguous match with no
  // discriminator is left unpainted rather than guessed.
  private locate(index: TextIndex, anchor: AnchorStatus): { range: Range; start: number } | null {
    const matches = findQuoteMatches(index.text, anchor.quote);
    if (matches.length === 0) return null;

    let chosen = matches[0]!;
    if (matches.length > 1) {
      // Disambiguate by surrounding context FIRST. prefix/suffix are compared
      // over a small local window, so they are robust to whitespace/offset drift
      // between the server's canonical text and the client's rendered text layer
      // (unlike absolute offsets, which accumulate drift across many blocks).
      let bestScore = -Infinity;
      const top: typeof matches = [];
      for (const match of matches) {
        const score = contextScore(index.text, match, anchor.prefix ?? "", anchor.suffix ?? "");
        if (score > bestScore) {
          bestScore = score;
          top.length = 0;
          top.push(match);
        } else if (score === bestScore) {
          top.push(match);
        }
      }

      if (top.length === 1 && bestScore > 0) {
        chosen = top[0]!;
      } else if (anchor.range) {
        // Context tied (or gave no signal): fall back to the server's resolved
        // offset as a tiebreaker among the otherwise-equal candidates — but only
        // if it picks a UNIQUE nearest. Equidistant candidates stay ambiguous.
        const target = anchor.range.start;
        const pool = top.length > 0 ? top : matches;
        const minDist = Math.min(...pool.map((m) => Math.abs(m.start - target)));
        const nearest = pool.filter((m) => Math.abs(m.start - target) === minDist);
        if (nearest.length !== 1) return null;
        chosen = nearest[0]!;
      } else {
        // No context signal and no server offset: genuinely ambiguous. Leave it
        // unpainted rather than silently highlight the wrong occurrence.
        return null;
      }
    }
    const range = this.rangeFor(index, chosen.start, chosen.end);
    return range ? { range, start: chosen.start } : null;
  }

  private rangeFor(index: TextIndex, start: number, end: number): Range | null {
    const doc = this.doc();
    const startRef = index.chars[start];
    const endRef = index.chars[end - 1];
    if (!doc || !startRef || !endRef) return null;
    const range = doc.createRange();
    range.setStart(startRef.node, startRef.offset);
    range.setEnd(endRef.node, endRef.offset + 1);
    return range;
  }

  // Capture selectors from the live selection in the rendered text layer.
  private emitSelection(): void {
    const doc = this.doc();
    const selection = doc?.getSelection?.();
    if (!doc || !selection || selection.isCollapsed || selection.rangeCount === 0) {
      this.callbacks.onSelection(null);
      return;
    }
    const selectors = this.selectorsFromSelection(selection);
    this.callbacks.onSelection(selectors);
  }

  private selectorsFromSelection(selection: Selection): SelectorInput | null {
    const index = this.index;
    if (!index) return null;
    const quote = normalizeQuoteKey(selection.toString());
    if (!quote) return null;

    const range = selection.getRangeAt(0);
    const posStart = this.indexOf(index, range.startContainer, range.startOffset);
    const posEnd = this.indexOf(index, range.endContainer, range.endOffset);
    if (posStart === null || posEnd === null || posEnd <= posStart) return null;

    const rawQuote = index.text.slice(posStart, posEnd);
    return {
      quote: rawQuote,
      prefix: index.text.slice(Math.max(0, posStart - CONTEXT_WINDOW), posStart),
      suffix: index.text.slice(posEnd, posEnd + CONTEXT_WINDOW),
      posStart,
      posEnd,
    };
  }

  private indexOf(index: TextIndex, container: Node, offset: number): number | null {
    if (container.nodeType === Node.TEXT_NODE) {
      const base = index.nodeStart.get(container as Text);
      if (base === undefined) return null;
      return base + offset;
    }
    // Element container: map to the start of the child node at `offset`.
    const child = container.childNodes[offset] ?? container.childNodes[offset - 1];
    if (child && child.nodeType === Node.TEXT_NODE) {
      return index.nodeStart.get(child as Text) ?? null;
    }
    // Fall back to the first text descendant.
    const firstText = firstTextNode(container);
    return firstText ? (index.nodeStart.get(firstText) ?? null) : null;
  }
}

function isScrollKey(key: string): boolean {
  return key === "ArrowDown" || key === "ArrowUp" || key === "PageDown" || key === "PageUp" ||
    key === "Home" || key === "End" || key === " " || key === "Spacebar";
}

// Highlight decoration styles, injected into the (sandboxed) document so the
// reviewed file needs no styling of its own. Painted as a translucent underlay
// behind the author's text.
const HIGHLIGHT_STYLE = `<style>
  .redline-highlight { background: rgba(196, 54, 29, 0.14); border-bottom: 2px solid rgba(196, 54, 29, 0.5); cursor: pointer; border-radius: 2px; }
  .redline-highlight.needs-review { background: rgba(179, 121, 26, 0.16); border-bottom-color: rgba(179, 121, 26, 0.6); }
  .redline-highlight.active { background: rgba(196, 54, 29, 0.28); }
  ::selection { background: rgba(196, 54, 29, 0.25); }
</style>`;

// Google Fonts is served from two hosts: the stylesheet (@font-face rules) comes
// from fonts.googleapis.com and the font files it references from fonts.gstatic.com.
// Both must be allow-listed — the CSS host under style-src, the file host under
// font-src — or the font silently falls back.
const GOOGLE_FONTS_CSS = "https://fonts.googleapis.com";
const GOOGLE_FONTS_FILES = "https://fonts.gstatic.com";

// CSP for the reviewed document, layered on top of the iframe sandbox (which
// already blocks scripts/forms/popups/top-navigation). Presentational remote
// resources are allowed — external images (any https host) and Google Fonts —
// but ACTIVE code is not: script-src stays 'none' so no external (or inline)
// JavaScript ever runs, and object/frame/form are all forbidden. Nothing the
// document loads can execute or navigate; the loosened directives only fetch
// pixels, fonts, and stylesheets.
function buildCsp(assetSource: string): string {
  const policy = [
    `default-src 'none'`,
    `img-src ${assetSource} data: blob: https:`,
    `media-src ${assetSource} data: blob: https:`,
    `style-src ${assetSource} 'unsafe-inline' ${GOOGLE_FONTS_CSS}`,
    `font-src ${assetSource} data: ${GOOGLE_FONTS_FILES}`,
    `base-uri ${assetSource}`, // permits exactly the <base> we inject
    `form-action 'none'`,
    `object-src 'none'`,
    `frame-src 'none'`,
    `script-src 'none'`,
  ].join("; ");
  return `<meta http-equiv="Content-Security-Policy" content="${policy}">`;
}

// Reconstruct the document into a known-good shell so Redline's CSP is the FIRST
// token the parser sees — author resource tags (even ones placed before <head>
// in malformed input) end up in <body>, after the CSP, and are therefore
// governed by it. The author's own head styles/links are preserved but placed
// after our CSP/base/style so the policy still applies to them.
// Exported for unit testing the reconstruction; not part of the public viewer API.
export function injectBase(html: string, base: string): string {
  const assetSource = absoluteAssetSource(base);
  const headInner = html.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i)?.[1] ?? "";
  const bodyAttrs = html.match(/<body\b([^>]*)>/i)?.[1] ?? "";
  // Body content = EVERYTHING that isn't in <head>. We strip the head block and
  // the doctype/html/body wrapper tags but keep all other tokens, wherever they
  // sat (before <head>, between </head> and <body>, inside body, after </body>),
  // so no author content is dropped and any stray resource tag still ends up
  // after our CSP in the rebuilt body.
  // No .trim(): trimming would drop author whitespace that matters inside
  // <pre>/significant-whitespace content. Strip only Redline-irrelevant wrapper
  // tags, never author bytes.
  const bodyInner = html
    .replace(/<head\b[^>]*>[\s\S]*?<\/head>/i, "")
    .replace(/<!doctype[^>]*>/i, "")
    .replace(/<\/?html\b[^>]*>/gi, "")
    .replace(/<body\b[^>]*>/i, "")
    .replace(/<\/body>/i, "");

  const head = `${buildCsp(assetSource)}<base href="${base}">${HIGHLIGHT_STYLE}${headInner}`;
  return `<!doctype html><html><head>${head}</head><body${bodyAttrs}>${bodyInner}</body></html>`;
}

export function localFragmentFromHref(rawHref: string | null): string | null {
  if (!rawHref?.startsWith("#")) return null;
  const rawFragment = rawHref.slice(1);
  try {
    return decodeURIComponent(rawFragment);
  } catch {
    return rawFragment;
  }
}

function hasClosest(target: EventTarget | null): target is Element {
  return typeof (target as Element | null)?.closest === "function";
}

// The absolute, path-scoped source for this document's assets, e.g.
// http://127.0.0.1:7331/api/docs/doc_x/assets/ — a CSP host-source with a path
// only matches URLs under that prefix.
function absoluteAssetSource(base: string): string {
  try {
    return new URL(base, location.href).href;
  } catch {
    return base;
  }
}

// EXACTLY what the server's extractText excludes — script and style — so the
// client's text layer and the server's canonical text agree (the shared
// normalization contract). Excluding more here (noscript/template/hidden) than
// the server does would re-introduce the very offset drift this is meant to
// avoid, so the two sets must stay identical.
const EXCLUDED_TEXT_ANCESTORS = new Set(["SCRIPT", "STYLE"]);

function isExcludedText(node: Text): boolean {
  let current = node.parentElement;
  while (current) {
    if (EXCLUDED_TEXT_ANCESTORS.has(current.tagName)) return true;
    current = current.parentElement;
  }
  return false;
}

function nearestBlock(node: Node): Element | null {
  let current = node.parentElement;
  while (current) {
    if (BLOCK_TAGS.has(current.tagName)) return current;
    current = current.parentElement;
  }
  return null;
}

function firstTextNode(node: Node): Text | null {
  if (node.nodeType === Node.TEXT_NODE) return node as Text;
  for (const child of Array.from(node.childNodes)) {
    const found = firstTextNode(child);
    if (found) return found;
  }
  return null;
}

// Wrap a (possibly multi-node) range in per-text-node highlight spans, splitting
// boundary text nodes so only the matched characters are wrapped.
function wrapRange(
  doc: Document,
  range: Range,
  threadId: string,
  state: string,
  active: boolean,
): void {
  // Root the walker at an ELEMENT: a TreeWalker rooted at a text node never
  // yields that node, so a match inside a single text node would wrap nothing.
  const container = range.commonAncestorContainer;
  const root = container.nodeType === Node.TEXT_NODE ? container.parentNode ?? container : container;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let node = walker.nextNode() as Text | null;
  while (node) {
    if (range.intersectsNode(node)) nodes.push(node);
    node = walker.nextNode() as Text | null;
  }
  for (const target of nodes) {
    const start = target === range.startContainer ? range.startOffset : 0;
    const end = target === range.endContainer ? range.endOffset : target.length;
    if (start >= end) continue;
    let piece = target;
    if (start > 0) piece = piece.splitText(start);
    if (end - start < piece.length) piece.splitText(end - start);
    const span = doc.createElement("span");
    span.className = "redline-highlight" + (state === "needs-review" ? " needs-review" : "") + (active ? " active" : "");
    span.setAttribute("data-thread-id", threadId);
    piece.parentNode?.insertBefore(span, piece);
    span.appendChild(piece);
  }
}

function contextScore(text: string, match: { start: number; end: number }, prefix: string, suffix: string): number {
  const before = normalizeQuoteKey(text.slice(Math.max(0, match.start - CONTEXT_WINDOW * 2), match.start));
  const after = normalizeQuoteKey(text.slice(match.end, match.end + CONTEXT_WINDOW * 2));
  const p = normalizeQuoteKey(prefix);
  const s = normalizeQuoteKey(suffix);
  let score = 0;
  if (p && before.endsWith(p.slice(-CONTEXT_WINDOW))) score += 1;
  if (s && after.startsWith(s.slice(0, CONTEXT_WINDOW))) score += 1;
  return score;
}

function cssEscape(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}
