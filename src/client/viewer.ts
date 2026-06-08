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

// Highlight decoration styles, injected into the (sandboxed) document so the
// reviewed file needs no styling of its own. Painted as a translucent underlay
// behind the author's text.
const HIGHLIGHT_STYLE = `<style>
  .redline-highlight { background: rgba(196, 54, 29, 0.14); border-bottom: 2px solid rgba(196, 54, 29, 0.5); cursor: pointer; border-radius: 2px; }
  .redline-highlight.needs-review { background: rgba(179, 121, 26, 0.16); border-bottom-color: rgba(179, 121, 26, 0.6); }
  .redline-highlight.active { background: rgba(196, 54, 29, 0.28); }
  ::selection { background: rgba(196, 54, 29, 0.25); }
</style>`;

// A strict CSP for the reviewed document, layered on top of the iframe sandbox
// (which already blocks scripts/forms/popups/top-navigation). It forbids ALL
// remote resource loads — images, styles, fonts, media resolve only from THIS
// document's own asset route (an absolute, path-scoped source, not the broad
// 'self') or inline/data/blob. No script runs, nothing beacons out, nothing
// navigates.
function buildCsp(assetSource: string): string {
  const policy = [
    `default-src 'none'`,
    `img-src ${assetSource} data: blob:`,
    `media-src ${assetSource} data: blob:`,
    `style-src ${assetSource} 'unsafe-inline'`,
    `font-src ${assetSource} data:`,
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
  const bodyInner = html
    .replace(/<head\b[^>]*>[\s\S]*?<\/head>/i, "")
    .replace(/<!doctype[^>]*>/i, "")
    .replace(/<\/?html\b[^>]*>/gi, "")
    .replace(/<body\b[^>]*>/i, "")
    .replace(/<\/body>/i, "")
    .trim();

  const head = `${buildCsp(assetSource)}<base href="${base}">${HIGHLIGHT_STYLE}${headInner}`;
  return `<!doctype html><html><head>${head}</head><body${bodyAttrs}>${bodyInner}</body></html>`;
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
