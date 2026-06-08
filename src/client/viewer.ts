// The imperative iframe document viewer, kept behind a small controller so
// React/Preact never models the reviewed document DOM. It loads rendered content
// into a locked-down sandboxed iframe, paints highlights by re-finding the
// resolved quote in the rendered text layer (the shared normalization contract),
// tracks the live selection for comment capture, and scrolls to a thread.

import { findQuoteMatches, normalizeQuoteKey, type AnchorStatus } from "../core";
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
  onHighlightClick: (threadId: string) => void;
}

export class DocumentViewer {
  private index: TextIndex | null = null;

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
      const target = event.target as HTMLElement | null;
      const highlight = target?.closest?.(".redline-highlight[data-thread-id]") as HTMLElement | null;
      if (highlight) {
        const threadId = highlight.getAttribute("data-thread-id");
        if (threadId) this.callbacks.onHighlightClick(threadId);
      }
    });
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
      if (anchor.range) {
        // The client text layer and the server canonical text use the same
        // normalization, so the resolved offset aligns closely; pick the nearest
        // occurrence. This faithfully reproduces the server's occurrence choice.
        const target = anchor.range.start;
        chosen = matches.reduce((best, m) =>
          Math.abs(m.start - target) < Math.abs(best.start - target) ? m : best,
        );
      } else {
        let bestScore = -Infinity;
        let unique = true;
        for (const match of matches) {
          const score = contextScore(index.text, match, anchor.prefix ?? "", anchor.suffix ?? "");
          if (score > bestScore) {
            bestScore = score;
            chosen = match;
            unique = true;
          } else if (score === bestScore) {
            unique = false;
          }
        }
        // No server range and context can't disambiguate: do not guess.
        if (!unique && bestScore <= 0) return null;
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

// Highlight decoration styles, injected into the (sandboxed) document so the
// reviewed file needs no styling of its own. Painted as a translucent underlay
// behind the author's text.
const HIGHLIGHT_STYLE = `<style>
  .redline-highlight { background: rgba(196, 54, 29, 0.14); border-bottom: 2px solid rgba(196, 54, 29, 0.5); cursor: pointer; border-radius: 2px; }
  .redline-highlight.needs-review { background: rgba(179, 121, 26, 0.16); border-bottom-color: rgba(179, 121, 26, 0.6); }
  .redline-highlight.active { background: rgba(196, 54, 29, 0.28); }
  ::selection { background: rgba(196, 54, 29, 0.25); }
</style>`;

// A strict CSP for the reviewed document, layered on top of the sandbox. The
// iframe already blocks scripts/forms/popups/top-navigation via its sandbox
// flags (no allow-scripts/allow-forms); this additionally forbids ALL remote
// resource loads — images, styles, fonts, media resolve only from the
// document's own asset route (same-origin) or inline/data/blob. No script can
// run, nothing beacons out, nothing navigates.
const CSP_META =
  `<meta http-equiv="Content-Security-Policy" content="` +
  `default-src 'none'; ` +
  `img-src 'self' data: blob:; ` +
  `media-src 'self' data: blob:; ` +
  `style-src 'self' 'unsafe-inline'; ` +
  `font-src 'self' data:; ` +
  // base-uri 'self' permits the doc-scoped asset <base> we inject (same origin)
  // while still blocking any author-supplied off-origin base.
  `base-uri 'self'; form-action 'none'; object-src 'none'; frame-src 'none'; script-src 'none'` +
  `">`;

function injectBase(html: string, base: string): string {
  // CSP must come first so it governs every subsequent resource declaration.
  const head = `${CSP_META}<base href="${base}">${HIGHLIGHT_STYLE}`;
  if (/<head\b[^>]*>/i.test(html)) {
    return html.replace(/<head\b[^>]*>/i, (m) => `${m}${head}`);
  }
  if (/<html\b[^>]*>/i.test(html)) {
    return html.replace(/<html\b[^>]*>/i, (m) => `${m}<head>${head}</head>`);
  }
  return `${head}${html}`;
}

const EXCLUDED_TEXT_ANCESTORS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);

// Text inside script/style/noscript/template, or inside a display:none /
// hidden subtree, is not part of the canonical anchoring text.
function isExcludedText(node: Text): boolean {
  let current = node.parentElement;
  while (current) {
    if (EXCLUDED_TEXT_ANCESTORS.has(current.tagName)) return true;
    if (current.hasAttribute("hidden")) return true;
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
