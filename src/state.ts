import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface TextPosition {
  start: number;
  end: number;
}

interface HtmlTextRange {
  start: number;
  end: number;
}

export interface CommentAnchor {
  type: "text-range" | "document";
  anchorId?: string;
  quote?: string;
  prefix?: string;
  suffix?: string;
  textPosition?: TextPosition;
}

export interface CommentMessage {
  id: string;
  author: string;
  body: string;
  createdAt: string;
}

export interface CommentThread {
  id: string;
  anchor: CommentAnchor;
  quote: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  messages: CommentMessage[];
}

export interface EmbeddedCommentState {
  schemaVersion: 1;
  updatedAt: string;
  threads: CommentThread[];
}

export interface ReviewSummary {
  threads: number;
  messages: number;
  unresolved: number;
}

export interface DocumentState {
  documentPath: string;
  legacySidecarPath: string;
  html: string;
  version: string;
  updatedAt: string;
  threads: CommentThread[];
  summary: ReviewSummary;
  // Set on the placeholder state served when no document is open. The client
  // renders its "open a file" panel instead of a document, and the server
  // rejects any write until a real document is opened.
  noDocument?: boolean;
  // Absolute path to the bundled how-to, present only when it exists on disk so
  // the empty state can offer to open it in one click.
  howtoPath?: string;
}

export interface CommentState {
  documentPath: string;
  legacySidecarPath: string;
  version: string;
  updatedAt: string;
  threads: CommentThread[];
  summary: ReviewSummary;
}

export interface DocumentFileState {
  documentPath: string;
  legacySidecarPath: string;
  version: string;
  updatedAt: string;
  summary: ReviewSummary;
}

export interface CreateCommentInput {
  anchor: CommentAnchor;
  body: string;
  author?: string;
  expectedVersion?: string;
  html?: string;
  quote?: string;
  threadId?: string;
}

export interface AgentUpdateInput {
  html?: string;
  replies?: Array<{
    threadId: string;
    body: string;
    author?: string;
  }>;
  resolveThreadIds?: string[];
  comments?: CreateCommentInput[];
}

const schemaVersion = 1;
const emptyReviewUpdatedAt = "1970-01-01T00:00:00.000Z";
const embeddedStateScriptId = "redline-state";
const agentGuideMetaName = "redline-agent-guide";
const agentGuideMetaContent =
  "Redline document. Agents: use the redline-review skill; comments live in #redline-state and data-redline-anchor spans.";
const agentGuideMetaTag = `<meta name="${agentGuideMetaName}" content="${agentGuideMetaContent}">`;
const agentGuideComment =
  "<!-- redline-agent-guide: use the redline-review skill; comments live in #redline-state and data-redline-anchor spans. -->";
const embeddedStateScriptPattern =
  /<script\b(?=[^>]*\bid\s*=\s*(["'])redline-state\1)(?=[^>]*\btype\s*=\s*(["'])application\/json\2)[^>]*>[\s\S]*?<\/script>\s*/i;
const legacyEmbeddedStateScriptPattern =
  /<script\b(?=[^>]*\bid\s*=\s*(["'])coauthor-state\1)(?=[^>]*\btype\s*=\s*(["'])application\/json\2)[^>]*>[\s\S]*?<\/script>\s*/i;
const embeddedStateScriptRemovalPattern =
  /[ \t]*<script\b(?=[^>]*\bid\s*=\s*(["'])(?:redline-state|coauthor-state)\1)(?=[^>]*\btype\s*=\s*(["'])application\/json\2)[^>]*>[\s\S]*?<\/script>[ \t]*(?:\r?\n)?/gi;
const agentGuideMetaPattern =
  /<meta\b(?=[^>]*\bname\s*=\s*(["'])redline-agent-guide\1)[^>]*>/i;
const agentGuideCommentPattern = /<!--\s*redline-agent-guide:/i;

export function defaultDocumentPath(cwd = process.cwd()): string {
  return path.join(cwd, "documents", "howto.html");
}

// The placeholder state served when no document is open. Nothing is written to
// disk — the client shows its "open a file" panel, and opening a file switches
// the server to a real document. `howtoPath` is included only when the bundled
// how-to exists, so the panel can offer to open it.
export function emptyDocumentState(howtoPath?: string): DocumentState {
  return {
    documentPath: "",
    legacySidecarPath: "",
    html: "",
    version: "",
    updatedAt: emptyReviewUpdatedAt,
    threads: [],
    summary: summarize([]),
    noDocument: true,
    ...(howtoPath ? { howtoPath } : {}),
  };
}

export function resolveDocumentPath(input?: string, cwd = process.cwd()): string {
  const candidate = input && input.trim().length > 0 ? input : defaultDocumentPath(cwd);
  return path.resolve(cwd, candidate);
}

export function sidecarPathFor(documentPath: string): string {
  return `${documentPath}.redline.json`;
}

export function legacySidecarPathFor(documentPath: string): string {
  return `${documentPath}.coauthor.json`;
}

export function ensureDocument(documentPath: string): void {
  if (fs.existsSync(documentPath)) return;
  fs.mkdirSync(path.dirname(documentPath), { recursive: true });
  fs.writeFileSync(documentPath, defaultHtml(), "utf8");
}

export function openDocumentForReview(documentPath: string): DocumentState {
  const absoluteDocumentPath = path.resolve(documentPath);
  ensureDocument(absoluteDocumentPath);
  const html = fs.readFileSync(absoluteDocumentPath, "utf8");
  const normalizedHtml = normalizeReviewHtml(html);
  if (normalizedHtml !== html) {
    writeFileAtomic(absoluteDocumentPath, normalizedHtml);
  }
  return readDocumentState(absoluteDocumentPath);
}

export function readDocumentState(documentPath: string): DocumentState {
  const absoluteDocumentPath = path.resolve(documentPath);
  ensureDocument(absoluteDocumentPath);

  const html = fs.readFileSync(absoluteDocumentPath, "utf8");
  const reviewState = readReviewState(absoluteDocumentPath, html);
  return {
    documentPath: absoluteDocumentPath,
    legacySidecarPath: legacySidecarPathFor(absoluteDocumentPath),
    html,
    version: versionFor(html),
    updatedAt: reviewState.updatedAt,
    threads: reviewState.threads,
    summary: summarize(reviewState.threads),
  };
}

export function readCommentState(documentPath: string): CommentState {
  const state = readDocumentState(documentPath);
  return {
    documentPath: state.documentPath,
    legacySidecarPath: state.legacySidecarPath,
    version: state.version,
    updatedAt: state.updatedAt,
    threads: state.threads,
    summary: state.summary,
  };
}

export function readDocumentFileState(documentPath: string): DocumentFileState {
  const state = readDocumentState(documentPath);
  return {
    documentPath: state.documentPath,
    legacySidecarPath: state.legacySidecarPath,
    version: state.version,
    updatedAt: state.updatedAt,
    summary: state.summary,
  };
}

export function writeDocumentHtml(documentPath: string, html: string): DocumentState {
  const absoluteDocumentPath = path.resolve(documentPath);
  fs.mkdirSync(path.dirname(absoluteDocumentPath), { recursive: true });
  const current = readDocumentState(absoluteDocumentPath);
  writeHtmlWithReviewState(absoluteDocumentPath, html, {
    updatedAt: current.updatedAt,
    threads: current.threads,
  });
  return readDocumentState(absoluteDocumentPath);
}

export function createComment(
  documentPath: string,
  input: CreateCommentInput,
): DocumentState {
  const body = normalizeBody(input.body, "Comment body is required.");
  const absoluteDocumentPath = path.resolve(documentPath);
  const currentHtml = readDocumentHtml(absoluteDocumentPath);
  const html = typeof input.html === "string" ? input.html : currentHtml;
  const reviewState = readReviewState(absoluteDocumentPath, currentHtml);
  const now = new Date().toISOString();
  const id = normalizeId(input.threadId, "thread") ?? newId("thread");
  if (reviewState.threads.some((thread) => thread.id === id)) {
    throw new Error(`Comment thread already exists: ${id}`);
  }
  const message: CommentMessage = {
    id: newId("message"),
    author: normalizeAuthor(input.author),
    body,
    createdAt: now,
  };

  const quote = normalizeQuote(input.quote ?? input.anchor.quote ?? "");
  const { anchor, html: htmlWithAnchor } = prepareCommentAnchor(html, input.anchor, quote, id);
  reviewState.threads.push({
    id,
    anchor,
    quote,
    author: message.author,
    createdAt: now,
    updatedAt: now,
    messages: [message],
  });
  reviewState.updatedAt = now;
  writeHtmlWithReviewState(absoluteDocumentPath, htmlWithAnchor, reviewState);
  return readDocumentState(absoluteDocumentPath);
}

export function appendReply(
  documentPath: string,
  threadId: string,
  body: string,
  author = "AI",
): DocumentState {
  const absoluteDocumentPath = path.resolve(documentPath);
  const html = readDocumentHtml(absoluteDocumentPath);
  const reviewState = readReviewState(absoluteDocumentPath, html);
  const thread = reviewState.threads.find((item) => item.id === threadId);
  if (!thread) {
    throw new Error(`Comment thread not found: ${threadId}`);
  }

  const now = new Date().toISOString();
  thread.messages.push({
    id: newId("message"),
    author: normalizeAuthor(author, "AI"),
    body: normalizeBody(body, "Reply body is required."),
    createdAt: now,
  });
  thread.updatedAt = now;
  reviewState.updatedAt = now;
  writeHtmlWithReviewState(absoluteDocumentPath, html, reviewState);
  return readDocumentState(absoluteDocumentPath);
}

export function deleteReply(
  documentPath: string,
  threadId: string,
  messageId: string,
): DocumentState {
  const absoluteDocumentPath = path.resolve(documentPath);
  const html = readDocumentHtml(absoluteDocumentPath);
  const reviewState = readReviewState(absoluteDocumentPath, html);
  const thread = reviewState.threads.find((item) => item.id === threadId);
  if (!thread) {
    throw new Error(`Comment thread not found: ${threadId}`);
  }

  const messageIndex = thread.messages.findIndex((message) => message.id === messageId);
  if (messageIndex === -1) {
    throw new Error(`Reply not found: ${messageId}`);
  }
  if (messageIndex === 0) {
    throw new Error("The original comment cannot be deleted as a reply.");
  }

  thread.messages.splice(messageIndex, 1);
  const now = new Date().toISOString();
  thread.updatedAt = now;
  reviewState.updatedAt = now;
  writeHtmlWithReviewState(absoluteDocumentPath, html, reviewState);
  return readDocumentState(absoluteDocumentPath);
}

export function updateCommentMessage(
  documentPath: string,
  threadId: string,
  messageId: string,
  body: string,
): DocumentState {
  const absoluteDocumentPath = path.resolve(documentPath);
  const html = readDocumentHtml(absoluteDocumentPath);
  const reviewState = readReviewState(absoluteDocumentPath, html);
  const thread = reviewState.threads.find((item) => item.id === threadId);
  if (!thread) {
    throw new Error(`Comment thread not found: ${threadId}`);
  }

  const message = thread.messages.find((item) => item.id === messageId);
  if (!message) {
    throw new Error(`Comment message not found: ${messageId}`);
  }

  const now = new Date().toISOString();
  message.body = normalizeBody(body, "Comment body is required.");
  thread.updatedAt = now;
  reviewState.updatedAt = now;
  writeHtmlWithReviewState(absoluteDocumentPath, html, reviewState);
  return readDocumentState(absoluteDocumentPath);
}

export function resolveThread(documentPath: string, threadId: string): DocumentState {
  const absoluteDocumentPath = path.resolve(documentPath);
  const html = readDocumentHtml(absoluteDocumentPath);
  const reviewState = readReviewState(absoluteDocumentPath, html);
  const before = reviewState.threads.length;
  const removed = reviewState.threads.filter((thread) => thread.id === threadId);
  reviewState.threads = reviewState.threads.filter((thread) => thread.id !== threadId);
  if (reviewState.threads.length === before) {
    throw new Error(`Comment thread not found: ${threadId}`);
  }

  reviewState.updatedAt = new Date().toISOString();
  writeHtmlWithReviewState(absoluteDocumentPath, removeInlineAnchors(html, anchorIdsFor(removed)), reviewState);
  return readDocumentState(absoluteDocumentPath);
}

export function applyAgentUpdate(
  documentPath: string,
  input: AgentUpdateInput,
): DocumentState {
  const absoluteDocumentPath = path.resolve(documentPath);
  const currentHtml = readDocumentHtml(absoluteDocumentPath);
  const reviewState = readReviewState(absoluteDocumentPath, currentHtml);
  let nextHtml = typeof input.html === "string" ? input.html : currentHtml;
  const now = new Date().toISOString();
  let changed = false;

  for (const reply of input.replies ?? []) {
    const thread = reviewState.threads.find((item) => item.id === reply.threadId);
    if (!thread) {
      throw new Error(`Comment thread not found: ${reply.threadId}`);
    }

    thread.messages.push({
      id: newId("message"),
      author: normalizeAuthor(reply.author, "AI"),
      body: normalizeBody(reply.body, "Reply body is required."),
      createdAt: now,
    });
    thread.updatedAt = now;
    changed = true;
  }

  for (const comment of input.comments ?? []) {
    const body = normalizeBody(comment.body, "Comment body is required.");
    const id = newId("thread");
    const author = normalizeAuthor(comment.author, "AI");
    const quote = normalizeQuote(comment.quote ?? comment.anchor.quote ?? "");
    const prepared = prepareCommentAnchor(nextHtml, comment.anchor, quote, id);
    nextHtml = prepared.html;
    reviewState.threads.push({
      id,
      anchor: prepared.anchor,
      quote,
      author,
      createdAt: now,
      updatedAt: now,
      messages: [
        {
          id: newId("message"),
          author,
          body,
          createdAt: now,
        },
      ],
    });
    changed = true;
  }

  const resolveIds = new Set(input.resolveThreadIds ?? []);
  const resolvedThreads = reviewState.threads.filter((thread) => resolveIds.has(thread.id));
  if (resolveIds.size > 0) {
    const before = reviewState.threads.length;
    reviewState.threads = reviewState.threads.filter((thread) => !resolveIds.has(thread.id));
    changed = changed || reviewState.threads.length !== before;
  }

  if (changed || typeof input.html === "string") {
    reviewState.updatedAt = changed ? now : reviewState.updatedAt;
    writeHtmlWithReviewState(
      absoluteDocumentPath,
      removeInlineAnchors(nextHtml, anchorIdsFor(resolvedThreads)),
      reviewState,
    );
  }

  return readDocumentState(absoluteDocumentPath);
}

export function readSidecar(documentPath: string): EmbeddedCommentState {
  const absoluteDocumentPath = path.resolve(documentPath);
  const sidecarPath = fs.existsSync(sidecarPathFor(absoluteDocumentPath))
    ? sidecarPathFor(absoluteDocumentPath)
    : legacySidecarPathFor(absoluteDocumentPath);
  if (!fs.existsSync(sidecarPath)) {
    return emptyReviewState();
  }

  const parsed = JSON.parse(fs.readFileSync(sidecarPath, "utf8")) as Partial<EmbeddedCommentState>;
  return {
    schemaVersion,
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : emptyReviewUpdatedAt,
    threads: Array.isArray(parsed.threads) ? parsed.threads.map(normalizeThread) : [],
  };
}

export function writeSidecar(documentPath: string, sidecar: EmbeddedCommentState): void {
  const absoluteDocumentPath = path.resolve(documentPath);
  const normalized: EmbeddedCommentState = {
    schemaVersion,
    updatedAt: sidecar.updatedAt || new Date().toISOString(),
    threads: sidecar.threads.map(normalizeThread),
  };
  writeFileAtomic(sidecarPathFor(absoluteDocumentPath), `${JSON.stringify(normalized, null, 2)}\n`);
}

export function summarize(threads: CommentThread[]): ReviewSummary {
  return {
    threads: threads.length,
    messages: threads.reduce((total, thread) => total + thread.messages.length, 0),
    unresolved: threads.length,
  };
}

function emptyReviewState(): EmbeddedCommentState {
  return {
    schemaVersion,
    updatedAt: emptyReviewUpdatedAt,
    threads: [],
  };
}

function readDocumentHtml(documentPath: string): string {
  const absoluteDocumentPath = path.resolve(documentPath);
  ensureDocument(absoluteDocumentPath);
  return fs.readFileSync(absoluteDocumentPath, "utf8");
}

function readReviewState(documentPath: string, html: string): EmbeddedCommentState {
  const embedded = extractEmbeddedReviewState(html);
  if (embedded) return embedded;
  return readSidecar(documentPath);
}

function extractEmbeddedReviewState(html: string): EmbeddedCommentState | null {
  const match = html.match(embeddedStateScriptPattern) ?? html.match(legacyEmbeddedStateScriptPattern);
  if (!match?.[0]) return null;

  const jsonText = match[0]
    .replace(/^<script\b[^>]*>/i, "")
    .replace(/<\/script>\s*$/i, "");

  const parsed = JSON.parse(jsonText) as Partial<EmbeddedCommentState>;
  return {
    schemaVersion,
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : emptyReviewUpdatedAt,
    threads: Array.isArray(parsed.threads) ? parsed.threads.map(normalizeThread) : [],
  };
}

function writeHtmlWithReviewState(
  documentPath: string,
  html: string,
  reviewState: Omit<EmbeddedCommentState, "schemaVersion">,
): void {
  const absoluteDocumentPath = path.resolve(documentPath);
  const normalized: EmbeddedCommentState = {
    schemaVersion,
    updatedAt: reviewState.updatedAt || new Date().toISOString(),
    threads: reviewState.threads.map(normalizeThread),
  };
  writeFileAtomic(absoluteDocumentPath, injectEmbeddedReviewState(normalizeReviewHtml(html), normalized));
  fs.rmSync(sidecarPathFor(absoluteDocumentPath), { force: true });
  fs.rmSync(legacySidecarPathFor(absoluteDocumentPath), { force: true });
}

function injectEmbeddedReviewState(html: string, reviewState: EmbeddedCommentState): string {
  const withoutExisting = html.replace(embeddedStateScriptRemovalPattern, "");
  if (reviewState.threads.length === 0) {
    return withoutExisting;
  }

  const script = `<script type="application/json" id="${embeddedStateScriptId}">${jsonForHtmlScript(reviewState)}</script>`;

  if (/<\/head>/i.test(withoutExisting)) {
    return withoutExisting.replace(/<\/head>/i, `${script}\n  </head>`);
  }

  if (/<html\b[^>]*>/i.test(withoutExisting)) {
    return withoutExisting.replace(/<html\b[^>]*>/i, (match) => `${match}\n  <head>\n    ${script}\n  </head>`);
  }

  return `${script}\n${withoutExisting}`;
}

function normalizeReviewHtml(html: string): string {
  return ensureAgentDiscoveryMarker(html.replace(/\bdata-coauthor-anchor=/gi, "data-redline-anchor="));
}

function ensureAgentDiscoveryMarker(html: string): string {
  if (agentGuideMetaPattern.test(html) || agentGuideCommentPattern.test(html)) {
    return html;
  }

  if (/<\/head>/i.test(html)) {
    return html.replace(/<\/head>/i, `    ${agentGuideMetaTag}\n  </head>`);
  }

  if (/<html\b[^>]*>/i.test(html)) {
    return html.replace(/<html\b[^>]*>/i, (match) => `${match}\n  <head>\n    ${agentGuideMetaTag}\n  </head>`);
  }

  return `${agentGuideComment}\n${html}`;
}

function anchorIdsFor(threads: CommentThread[]): string[] {
  return threads
    .map((thread) => thread.anchor.anchorId || thread.id)
    .filter((id): id is string => id.length > 0);
}

function prepareCommentAnchor(
  html: string,
  inputAnchor: CommentAnchor,
  quote: string,
  threadId: string,
): { anchor: CommentAnchor; html: string } {
  const initialAnchor = normalizeAnchor(inputAnchor);
  if (initialAnchor.type !== "text-range") {
    return { anchor: initialAnchor, html };
  }

  const anchorId = initialAnchor.anchorId ?? threadId;
  const anchor: CommentAnchor = { ...initialAnchor, anchorId };
  if (hasInlineAnchor(html, anchorId)) {
    return { anchor, html };
  }

  const range = findTextRangeForAnchor(html, anchor, quote);
  if (!range) {
    return { anchor, html };
  }

  return {
    anchor,
    html: insertInlineAnchor(html, anchorId, range) ?? html,
  };
}

function hasInlineAnchor(html: string, anchorId: string): boolean {
  return inlineAnchorPattern(anchorId).some((pattern) => pattern.test(html));
}

function removeInlineAnchors(html: string, anchorIds: string[]): string {
  let nextHtml = html;
  for (const anchorId of anchorIds) {
    for (const pattern of inlineAnchorPattern(anchorId)) {
      nextHtml = nextHtml.replace(pattern, "$3");
    }
  }
  return nextHtml;
}

function inlineAnchorPattern(anchorId: string): RegExp[] {
  return ["redline", "coauthor"].map(
    (name) =>
      new RegExp(
        `<span\\b(?=[^>]*\\bdata-${name}-anchor\\s*=\\s*(["'])${escapeRegExp(anchorId)}\\1)([^>]*)>([\\s\\S]*?)<\\/span>`,
        "gi",
      ),
  );
}

function findTextRangeForAnchor(
  html: string,
  anchor: CommentAnchor,
  quote: string,
): HtmlTextRange | null {
  if (anchor.type !== "text-range") return null;

  const text = textContentForAnchoring(html);
  const normalizedQuote = normalizeQuote(quote || anchor.quote || "");
  if (anchor.textPosition) {
    const { start, end } = anchor.textPosition;
    if (
      start >= 0 &&
      end > start &&
      end <= text.length &&
      normalizeQuote(text.slice(start, end)) === normalizedQuote
    ) {
      return { start, end };
    }
  }

  if (!normalizedQuote) return null;

  const contextual = findContextualTextRange(text, normalizedQuote, anchor.prefix, anchor.suffix);
  if (contextual) return contextual;

  const exact = text.indexOf(normalizedQuote);
  if (exact !== -1) {
    return { start: exact, end: exact + normalizedQuote.length };
  }

  return findNormalizedTextRange(text, normalizedQuote);
}

function findContextualTextRange(
  text: string,
  quote: string,
  prefix = "",
  suffix = "",
): HtmlTextRange | null {
  if (!prefix && !suffix) return null;

  const matches: HtmlTextRange[] = [];
  let startAt = 0;
  while (startAt <= text.length) {
    const start = text.indexOf(quote, startAt);
    if (start === -1) break;
    const end = start + quote.length;
    const prefixMatches = !prefix || text.slice(0, start).endsWith(prefix);
    const suffixMatches = !suffix || text.slice(end).startsWith(suffix);
    if (prefixMatches && suffixMatches) {
      matches.push({ start, end });
    }
    startAt = end;
  }

  return matches.length === 1 ? matches[0] ?? null : null;
}

function findNormalizedTextRange(text: string, quote: string): HtmlTextRange | null {
  const normalizedText = text.replace(/\s+/g, " ");
  const normalizedQuote = quote.replace(/\s+/g, " ");
  const normalizedStart = normalizedText.indexOf(normalizedQuote);
  if (normalizedStart === -1) return null;

  return mapNormalizedTextRange(text, normalizedStart, normalizedStart + normalizedQuote.length);
}

function mapNormalizedTextRange(
  text: string,
  normalizedStart: number,
  normalizedEnd: number,
): HtmlTextRange | null {
  let normalizedIndex = 0;
  let start: number | null = null;
  let end: number | null = null;
  let inWhitespace = false;

  for (let index = 0; index < text.length; index += 1) {
    const isWhitespace = /\s/.test(text[index] ?? "");
    if (isWhitespace && inWhitespace) continue;

    if (normalizedIndex === normalizedStart && start === null) start = index;
    if (normalizedIndex === normalizedEnd && end === null) {
      end = index;
      break;
    }

    normalizedIndex += 1;
    inWhitespace = isWhitespace;
  }

  if (start === null) return null;
  return { start, end: end ?? text.length };
}

function insertInlineAnchor(html: string, anchorId: string, range: HtmlTextRange): string | null {
  const indices = htmlIndicesForTextRange(html, range);
  if (!indices || indices.start >= indices.end) return null;

  const open = `<span data-redline-anchor="${anchorId}">`;
  return `${html.slice(0, indices.start)}${open}${html.slice(indices.start, indices.end)}</span>${html.slice(
    indices.end,
  )}`;
}

function htmlIndicesForTextRange(html: string, range: HtmlTextRange): HtmlTextRange | null {
  const bounds = bodyContentBounds(html);
  let textOffset = 0;
  let htmlStart: number | null = null;
  let htmlEnd: number | null = null;
  let index = bounds.start;

  while (index < bounds.end) {
    const skipped = skippableHtmlEnd(html, index, bounds.end);
    if (skipped !== null) {
      index = skipped;
      continue;
    }

    const token = readTextToken(html, index, bounds.end);
    const nextTextOffset = textOffset + token.text.length;
    if (htmlStart === null && range.start >= textOffset && range.start < nextTextOffset) {
      htmlStart = htmlIndexWithinTextToken(token, range.start - textOffset);
    }
    if (htmlEnd === null && range.end > textOffset && range.end <= nextTextOffset) {
      htmlEnd = htmlIndexWithinTextToken(token, range.end - textOffset);
      break;
    }

    textOffset = nextTextOffset;
    index = token.end;
  }

  if (htmlStart === null || htmlEnd === null) return null;
  return { start: htmlStart, end: htmlEnd };
}

function textContentForAnchoring(html: string): string {
  const bounds = bodyContentBounds(html);
  let text = "";
  let index = bounds.start;

  while (index < bounds.end) {
    const skipped = skippableHtmlEnd(html, index, bounds.end);
    if (skipped !== null) {
      index = skipped;
      continue;
    }

    const token = readTextToken(html, index, bounds.end);
    text += token.text;
    index = token.end;
  }

  return text;
}

function bodyContentBounds(html: string): HtmlTextRange {
  const bodyMatch = /<body\b/i.exec(html);
  if (!bodyMatch) {
    return { start: 0, end: html.length };
  }

  const openEnd = tagEndIndex(html, bodyMatch.index, html.length);
  const closeMatch = /<\/body\s*>/i.exec(html.slice(openEnd));
  return {
    start: openEnd,
    end: closeMatch ? openEnd + closeMatch.index : html.length,
  };
}

function skippableHtmlEnd(html: string, index: number, limit: number): number | null {
  if (html.startsWith("<!--", index)) {
    const end = html.indexOf("-->", index + 4);
    return end === -1 ? limit : Math.min(limit, end + 3);
  }

  if (html[index] !== "<") return null;

  const tagEnd = tagEndIndex(html, index, limit);
  const tagText = html.slice(index, tagEnd);
  const tagName = tagText.match(/^<\/?\s*([A-Za-z][\w:-]*)/)?.[1]?.toLowerCase();
  if (tagName === "script" || tagName === "style") {
    const closePattern = new RegExp(`<\\/${tagName}\\s*>`, "i");
    const closeMatch = closePattern.exec(html.slice(tagEnd, limit));
    return closeMatch ? Math.min(limit, tagEnd + closeMatch.index + closeMatch[0].length) : limit;
  }

  return tagEnd;
}

function tagEndIndex(html: string, start: number, limit: number): number {
  let quote: string | null = null;
  for (let index = start + 1; index < limit; index += 1) {
    const char = html[index];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ">") {
      return index + 1;
    }
  }
  return limit;
}

function readTextToken(html: string, index: number, limit: number): { start: number; end: number; text: string } {
  if (html[index] === "&") {
    const entityEnd = html.indexOf(";", index + 1);
    if (entityEnd !== -1 && entityEnd < limit) {
      const raw = html.slice(index, entityEnd + 1);
      return { start: index, end: entityEnd + 1, text: decodeHtmlEntity(raw) };
    }
  }

  return { start: index, end: index + 1, text: html[index] ?? "" };
}

function htmlIndexWithinTextToken(
  token: { start: number; end: number; text: string },
  textOffset: number,
): number {
  if (textOffset <= 0) return token.start;
  if (textOffset >= token.text.length) return token.end;
  return token.end;
}

function decodeHtmlEntity(entity: string): string {
  const body = entity.slice(1, -1);
  if (body.startsWith("#x") || body.startsWith("#X")) {
    const codePoint = Number.parseInt(body.slice(2), 16);
    return isValidCodePoint(codePoint) ? String.fromCodePoint(codePoint) : entity;
  }
  if (body.startsWith("#")) {
    const codePoint = Number.parseInt(body.slice(1), 10);
    return isValidCodePoint(codePoint) ? String.fromCodePoint(codePoint) : entity;
  }

  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: "\u00a0",
    quot: '"',
  };
  return named[body.toLowerCase()] ?? entity;
}

function isValidCodePoint(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff;
}

function jsonForHtmlScript(value: EmbeddedCommentState): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function versionFor(html: string): string {
  const hash = crypto.createHash("sha256");
  hash.update(html);
  return hash.digest("hex");
}

function normalizeThread(input: CommentThread): CommentThread {
  const now = new Date().toISOString();
  const messages = Array.isArray(input.messages)
    ? input.messages.map((message) => ({
        id: stringOr(message.id, newId("message")),
        author: normalizeAuthor(message.author),
        body: String(message.body ?? ""),
        createdAt: stringOr(message.createdAt, now),
      }))
    : [];

  return {
    id: stringOr(input.id, newId("thread")),
    anchor: normalizeAnchor(input.anchor),
    quote: normalizeQuote(input.quote ?? input.anchor?.quote ?? ""),
    author: normalizeAuthor(input.author),
    createdAt: stringOr(input.createdAt, now),
    updatedAt: stringOr(input.updatedAt, now),
    messages,
  };
}

function normalizeAnchor(input: CommentAnchor | undefined): CommentAnchor {
  if (!input || input.type !== "text-range") {
    return { type: "document" };
  }

  const anchor: CommentAnchor = {
    type: "text-range",
    anchorId: normalizeId(input.anchorId, "thread") ?? undefined,
    quote: normalizeQuote(input.quote ?? ""),
    prefix: typeof input.prefix === "string" ? input.prefix : "",
    suffix: typeof input.suffix === "string" ? input.suffix : "",
  };
  if (
    input.textPosition &&
    Number.isFinite(input.textPosition.start) &&
    Number.isFinite(input.textPosition.end) &&
    input.textPosition.end >= input.textPosition.start
  ) {
    anchor.textPosition = {
      start: Math.max(0, Math.floor(input.textPosition.start)),
      end: Math.max(0, Math.floor(input.textPosition.end)),
    };
  }

  return anchor;
}

function normalizeQuote(value: string): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
}

function normalizeAuthor(value?: string, fallback = "User"): string {
  const author = typeof value === "string" ? value.trim() : "";
  return author || fallback;
}

function normalizeId(value: unknown, prefix: string): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  if (!id.startsWith(`${prefix}_`)) return null;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return null;
  return id;
}

function normalizeBody(value: string, message: string): string {
  const body = typeof value === "string" ? value.trim() : "";
  if (!body) {
    throw new Error(message);
  }
  return body;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function writeFileAtomic(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, content, "utf8");
  fs.renameSync(tempPath, filePath);
}

function defaultHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    ${agentGuideMetaTag}
    <title>Sample Redline document</title>
    <style>
      body {
        font-family: ui-serif, Georgia, serif;
        line-height: 1.62;
        max-width: 760px;
        margin: 48px auto;
        padding: 0 24px;
        color: #1f2933;
      }
      h1, h2 {
        font-family: ui-sans-serif, system-ui, sans-serif;
        line-height: 1.1;
      }
    </style>
  </head>
  <body>
    <h1>Redline sample</h1>
    <p>Select any text in this document, add a comment, then let an AI agent read the embedded review JSON or the local API.</p>
    <p>The HTML file stays portable. Comments live inside it in an inert JSON script tag and disappear when a thread is resolved.</p>
  </body>
</html>
`;
}
