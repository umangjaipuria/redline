import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
// Shared with the browser (public/app.js) so occurrence indexing is identical on
// both sides — see public/app-helpers.js.
import { findQuoteMatches } from "../public/app-helpers.js";

interface HtmlTextRange {
  start: number;
  end: number;
}

export interface CommentAnchor {
  type: "text-range" | "document";
  anchorId?: string;
  quote?: string;
  // 1-based index selecting which occurrence of `quote` to anchor when the
  // document contains the same text more than once. Omitted when the quote is
  // unique.
  occurrence?: number;
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

export interface AgentCommentIndexMessage {
  author: string;
  createdAt: string;
}

export interface AgentCommentIndexThread {
  id: string;
  anchor: CommentAnchor;
  quote: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  comments: AgentCommentIndexMessage[];
  lastCommentBody: string;
}

export interface AgentCommentIndexState {
  documentPath: string;
  legacySidecarPath: string;
  version: string;
  updatedAt: string;
  threads: AgentCommentIndexThread[];
  summary: ReviewSummary;
}

export interface AgentCommentThreadState {
  documentPath: string;
  legacySidecarPath: string;
  version: string;
  updatedAt: string;
  thread: CommentThread;
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

export function readAgentCommentIndexState(
  documentPath: string,
  options: { since?: string } = {},
): AgentCommentIndexState {
  const state = readDocumentState(documentPath);
  const sinceTime = options.since === undefined ? undefined : Date.parse(options.since);
  const threads = state.threads
    .filter((thread) => threadMatchesSince(thread, sinceTime))
    .map((thread) => ({
      id: thread.id,
      anchor: thread.anchor,
      quote: thread.quote,
      author: thread.author,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      comments: thread.messages.map((message) => ({
        author: message.author,
        createdAt: message.createdAt,
      })),
      lastCommentBody: thread.messages.at(-1)?.body ?? "",
    }));

  return {
    documentPath: state.documentPath,
    legacySidecarPath: state.legacySidecarPath,
    version: state.version,
    updatedAt: state.updatedAt,
    threads,
    summary: summarizeForIndex(threads),
  };
}

export function readAgentCommentThreadState(
  documentPath: string,
  threadId: string,
): AgentCommentThreadState {
  const state = readDocumentState(documentPath);
  const thread = state.threads.find((item) => item.id === threadId);
  if (!thread) {
    throw new Error(`Comment thread not found: ${threadId}`);
  }

  return {
    documentPath: state.documentPath,
    legacySidecarPath: state.legacySidecarPath,
    version: state.version,
    updatedAt: state.updatedAt,
    thread,
    summary: summarize([thread]),
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
  const id = idForNewComment(input);
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
  const { anchor, html: htmlWithAnchor } = prepareCommentAnchor(html, input.anchor, quote, id, {
    requireInlineAnchor: true,
  });
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
    const id = idForNewComment(comment);
    if (reviewState.threads.some((thread) => thread.id === id)) {
      throw new Error(`Comment thread already exists: ${id}`);
    }
    const author = normalizeAuthor(comment.author, "AI");
    const quote = normalizeQuote(comment.quote ?? comment.anchor.quote ?? "");
    const prepared = prepareCommentAnchor(nextHtml, comment.anchor, quote, id, {
      requireInlineAnchor: true,
    });
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

export function repairDocumentAnchors(documentPath: string): DocumentState {
  const absoluteDocumentPath = path.resolve(documentPath);
  const html = readDocumentHtml(absoluteDocumentPath);
  const reviewState = readReviewState(absoluteDocumentPath, html);
  const repaired = materializeReviewAnchors(html, reviewState.threads);
  if (repaired.changed) {
    writeHtmlWithReviewState(absoluteDocumentPath, repaired.html, {
      updatedAt: new Date().toISOString(),
      threads: repaired.threads,
    });
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

function summarizeForIndex(threads: AgentCommentIndexThread[]): ReviewSummary {
  return {
    threads: threads.length,
    messages: threads.reduce((total, thread) => total + thread.comments.length, 0),
    unresolved: threads.length,
  };
}

function threadMatchesSince(thread: CommentThread, sinceTime: number | undefined): boolean {
  if (sinceTime === undefined) return true;
  return thread.messages.some((message) => {
    const messageTime = Date.parse(message.createdAt);
    return Number.isFinite(messageTime) && messageTime >= sinceTime;
  });
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
  const repaired = materializeReviewAnchors(html, reviewState.threads.map(normalizeThread));
  const normalized: EmbeddedCommentState = {
    schemaVersion,
    updatedAt: reviewState.updatedAt || new Date().toISOString(),
    threads: repaired.threads.map(normalizeThread),
  };
  writeFileAtomic(absoluteDocumentPath, injectEmbeddedReviewState(normalizeReviewHtml(repaired.html), normalized));
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

function idForNewComment(input: CreateCommentInput): string {
  const threadId = normalizeId(input.threadId, "thread") ?? undefined;
  const anchorId = normalizeId(input.anchor?.anchorId, "thread") ?? undefined;
  if (threadId && anchorId && threadId !== anchorId) {
    throw new Error("threadId and anchor.anchorId must match for anchored comments.");
  }
  return threadId ?? anchorId ?? newId("thread");
}

function prepareCommentAnchor(
  html: string,
  inputAnchor: CommentAnchor,
  quote: string,
  threadId: string,
  options: { requireInlineAnchor?: boolean } = {},
): { anchor: CommentAnchor; html: string } {
  const initialAnchor = normalizeAnchor(inputAnchor);
  if (initialAnchor.type !== "text-range") {
    return { anchor: initialAnchor, html };
  }

  const anchorId = threadId;
  const anchor: CommentAnchor = { ...initialAnchor, anchorId };
  if (hasInlineAnchor(html, anchorId)) {
    return { anchor, html };
  }

  const located = locateQuote(html, quote || anchor.quote || "", anchor.occurrence);
  if (!located.ok) {
    if (options.requireInlineAnchor) {
      throw new Error(locateFailureMessage(located, anchor.occurrence));
    }
    return { anchor, html };
  }

  // The quote resolved to a location, but it can't be wrapped in a span (e.g. it
  // spans a block boundary). Keep the thread span-less rather than reject it: the
  // browser still re-anchors by quote + occurrence at render time.
  const htmlWithAnchor = insertInlineAnchor(html, anchorId, located.range);
  if (!htmlWithAnchor) {
    return { anchor, html };
  }

  return {
    anchor,
    html: htmlWithAnchor,
  };
}

function locateFailureMessage(failure: LocateFailure, occurrence: number | undefined): string {
  if (failure.reason === "ambiguous") {
    return `Quoted text appears ${failure.count} times. Pass --occurrence N (or anchor.occurrence) to choose the 1-based occurrence.`;
  }
  if (failure.reason === "out-of-range") {
    return `Quoted text appears ${failure.count} times, but occurrence ${occurrence} was requested.`;
  }
  return "Quoted text was not found in the document body.";
}

function materializeReviewAnchors(
  html: string,
  threads: CommentThread[],
): { html: string; threads: CommentThread[]; changed: boolean } {
  let nextHtml = html;
  let nextThreads = threads;
  let changed = false;

  for (const thread of threads) {
    if (thread.anchor.type !== "text-range") continue;

    const anchorId = thread.anchor.anchorId || thread.id;
    if (hasInlineAnchor(nextHtml, thread.id)) {
      if (thread.anchor.anchorId !== thread.id) {
        nextThreads = replaceThreadAnchor(nextThreads, thread.id, { ...thread.anchor, anchorId: thread.id });
        changed = true;
      }
      continue;
    }

    if (anchorId !== thread.id && hasInlineAnchor(nextHtml, anchorId)) {
      nextHtml = renameInlineAnchor(nextHtml, anchorId, thread.id);
      nextThreads = replaceThreadAnchor(nextThreads, thread.id, { ...thread.anchor, anchorId: thread.id });
      changed = true;
      continue;
    }

    const range = findTextRangeForAnchor(nextHtml, thread.anchor, thread.quote);
    if (!range) continue;

    const htmlWithAnchor = insertInlineAnchor(nextHtml, thread.id, range);
    if (!htmlWithAnchor) continue;

    nextHtml = htmlWithAnchor;
    nextThreads = replaceThreadAnchor(nextThreads, thread.id, { ...thread.anchor, anchorId: thread.id });
    changed = true;
  }

  return { html: nextHtml, threads: nextThreads, changed };
}

function replaceThreadAnchor(
  threads: CommentThread[],
  threadId: string,
  anchor: CommentAnchor,
): CommentThread[] {
  return threads.map((thread) => (thread.id === threadId ? { ...thread, anchor } : thread));
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

type LocateFailure = {
  ok: false;
  reason: "empty" | "not-found" | "ambiguous" | "out-of-range";
  count: number;
};
type LocateResult = { ok: true; range: HtmlTextRange } | LocateFailure;

function findTextRangeForAnchor(
  html: string,
  anchor: CommentAnchor,
  quote: string,
): HtmlTextRange | null {
  if (anchor.type !== "text-range") return null;
  const located = locateQuote(html, quote || anchor.quote || "", anchor.occurrence);
  return located.ok ? located.range : null;
}

// Resolve a quote to a single text range using one rule: collapse whitespace,
// match case-insensitively, and disambiguate repeats by a 1-based occurrence
// index. Both the server (here) and the browser count occurrences the same way
// so an occurrence chosen in one place resolves to the same span in the other.
function locateQuote(
  html: string,
  quote: string,
  occurrence: number | undefined,
): LocateResult {
  const normalizedQuote = normalizeQuote(quote);
  if (!normalizedQuote) return { ok: false, reason: "empty", count: 0 };

  const matches = findQuoteMatches(textContentForAnchoring(html), normalizedQuote);
  if (matches.length === 0) return { ok: false, reason: "not-found", count: 0 };
  if (occurrence !== undefined && (occurrence < 1 || occurrence > matches.length)) {
    return { ok: false, reason: "out-of-range", count: matches.length };
  }
  if (matches.length === 1) return { ok: true, range: matches[0] as HtmlTextRange };
  if (occurrence === undefined) {
    return { ok: false, reason: "ambiguous", count: matches.length };
  }
  return { ok: true, range: matches[occurrence - 1] as HtmlTextRange };
}

function insertInlineAnchor(html: string, anchorId: string, range: HtmlTextRange): string | null {
  const indices = htmlIndicesForTextRange(html, range);
  if (!indices || indices.start >= indices.end) return null;

  const inner = html.slice(indices.start, indices.end);
  // A span may only wrap a tag-balanced slice. A normalized quote can match
  // across element boundaries (e.g. "Hello world" over `<p>Hello</p><p>world</p>`),
  // and wrapping that would emit crossed, invalid markup. Bail so the caller can
  // keep the thread span-less instead.
  if (!spanWrapIsSafe(inner)) return null;

  const open = `<span data-redline-anchor="${anchorId}">`;
  return `${html.slice(0, indices.start)}${open}${inner}</span>${html.slice(indices.end)}`;
}

const voidHtmlElements = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

// True when `htmlSlice` can be wrapped in a single element without breaking
// nesting: every tag opened inside is also closed inside, and no tag closes one
// opened before the slice.
function spanWrapIsSafe(htmlSlice: string): boolean {
  // The attribute group tolerates quoted values that contain ">" (e.g.
  // title="a > b") so such tags aren't mis-tokenized into a false imbalance.
  const tagPattern =
    /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  const open: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(htmlSlice)) !== null) {
    if (match[0].startsWith("<!--")) continue;
    const tagName = (match[2] ?? "").toLowerCase();
    const selfClosing = /\/\s*$/.test(match[3] ?? "");
    if (match[1] === "/") {
      if (open.pop() !== tagName) return false;
    } else if (!selfClosing && !voidHtmlElements.has(tagName)) {
      open.push(tagName);
    }
  }
  return open.length === 0;
}

function renameInlineAnchor(html: string, fromAnchorId: string, toAnchorId: string): string {
  let nextHtml = html;
  for (const pattern of inlineAnchorPattern(fromAnchorId)) {
    nextHtml = nextHtml.replace(pattern, (match) =>
      match.replace(
        /\bdata-(?:redline|coauthor)-anchor\s*=\s*(["'])([^"']+)\1/i,
        `data-redline-anchor=$1${toAnchorId}$1`,
      ),
    );
  }
  return nextHtml;
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
    // Common typographic entities: prose documents lean on these heavily, and
    // the browser decodes them in full, so the server must too for quote parity.
    copy: "\u00a9",
    reg: "\u00ae",
    trade: "\u2122",
    hellip: "\u2026",
    mdash: "\u2014",
    ndash: "\u2013",
    lsquo: "\u2018",
    rsquo: "\u2019",
    ldquo: "\u201c",
    rdquo: "\u201d",
    laquo: "\u00ab",
    raquo: "\u00bb",
    bull: "\u2022",
    middot: "\u00b7",
    deg: "\u00b0",
    times: "\u00d7",
    divide: "\u00f7",
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
  };
  const occurrence = normalizeOccurrence(input.occurrence);
  if (occurrence !== undefined) {
    anchor.occurrence = occurrence;
  }

  return anchor;
}

function normalizeOccurrence(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return undefined;
  }
  return value;
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
