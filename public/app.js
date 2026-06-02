const frame = document.querySelector("#documentFrame");
const documentPathEl = document.querySelector("#documentPath");
const saveStatusEl = document.querySelector("#saveStatus");
const reloadButton = document.querySelector("#reloadButton");
const editButton = document.querySelector("#editButton");
const commentButton = document.querySelector("#commentButton");
const authorNameInput = document.querySelector("#authorName");
const composer = document.querySelector("#composer");
const selectedQuoteEl = document.querySelector("#selectedQuote");
const commentForm = document.querySelector("#commentForm");
const commentBody = document.querySelector("#commentBody");
const cancelCommentButton = document.querySelector("#cancelCommentButton");
const threadsEl = document.querySelector("#threads");
const threadCountEl = document.querySelector("#threadCount");
const notice = document.querySelector("#notice");
const noticeTitle = document.querySelector("#noticeTitle");
const noticeBody = document.querySelector("#noticeBody");
const noticeAction = document.querySelector("#noticeAction");

let state = null;
let editMode = false;
let dirty = false;
let saving = false;
let pendingSelection = null;
let activeThreadId = null;
let saveTimer = null;
let blockedRemoteUpdate = false;
let activeEditableElement = null;
let anchorStatusReady = false;
let anchoredThreadIds = new Set();

authorNameInput.value = getStoredAuthorName();

await loadState({ force: true });
connectEvents();

reloadButton.addEventListener("click", () => loadState({ force: true }));
noticeAction.addEventListener("click", () => loadState({ force: true }));
authorNameInput.addEventListener("input", () => {
  localStorage.setItem("redline.authorName", getAuthorName());
});
editButton.addEventListener("click", () => {
  editMode = !editMode;
  if (!editMode && dirty) {
    void saveNow();
  }
  syncEditMode();
  updateToolbar();
});

commentButton.addEventListener("click", beginCommentFromSelection);

cancelCommentButton.addEventListener("click", () => closeComposer({ discardDraft: true }));
commentBody.addEventListener("keydown", submitFormOnCommandEnter);

commentForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!pendingSelection) return;
  const body = commentBody.value.trim();
  if (!body) return;
  if (!ensurePendingInlineAnchor()) return;

  const threadId = pendingSelection.threadId;
  if (!threadId) return;

  const response = await fetch("/api/comments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      threadId,
      author: getAuthorName(),
      body,
      quote: pendingSelection.quote,
      anchor: pendingSelection.anchor,
      html: cleanFrameHtml(),
      expectedVersion: state.version,
    }),
  });
  if (response.status === 409) {
    const payload = await response.json();
    removeInlineAnchorFromFrame(threadId);
    pendingSelection = null;
    closeComposer({ discardDraft: false });
    blockedRemoteUpdate = true;
    showNotice(
      "Comment paused",
      payload.error || "The document changed outside this browser. Reload before saving this comment.",
    );
    updateToolbar();
    return;
  }
  if (!response.ok) {
    removeInlineAnchorFromFrame(threadId);
    pendingSelection = null;
    closeComposer({ discardDraft: false });
    const payload = await response.json().catch(() => ({}));
    showNotice("Comment failed", payload.error || "The comment could not be saved.");
    updateToolbar();
    return;
  }
  state = await response.json();
  activeThreadId = threadId;
  pendingSelection = null;
  closeComposer({ discardDraft: false });
  render();
});

threadsEl.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;

  const resolveButton = target.closest("[data-resolve-thread]");
  if (resolveButton instanceof HTMLElement) {
    const id = resolveButton.getAttribute("data-resolve-thread");
    if (id) await resolveComment(id);
    return;
  }

  const threadCard = target.closest("[data-thread-id]");
  const threadId = threadCard?.getAttribute("data-thread-id");
  if (!threadId) return;

  if (target.closest(".reply-form textarea, .reply-form button")) {
    activateThreadWithoutRender(threadId);
    return;
  }

  selectThread(threadId);
});

threadsEl.addEventListener("keydown", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLTextAreaElement)) return;
  if (!target.closest(".reply-form")) return;
  submitFormOnCommandEnter(event);
});

threadsEl.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  const threadId = form.getAttribute("data-reply-form");
  const input = form.querySelector("textarea");
  const body = input?.value.trim() ?? "";
  if (!threadId || !body) return;

  const response = await fetch(`/api/comments/${encodeURIComponent(threadId)}/replies`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ author: getAuthorName(), body }),
  });

  if (!response.ok) {
    const payload = await readJsonPayload(response);
    showNotice("Reply failed", payload.error || "Redline could not save this reply.");
    updateToolbar();
    return;
  }

  state = await response.json();
  activeThreadId = threadId;
  render();
});

window.addEventListener("keydown", handleGlobalShortcut);

function handleGlobalShortcut(event) {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    void saveNow();
    return;
  }

  if (
    (event.metaKey || event.ctrlKey) &&
    event.shiftKey &&
    event.key.toLowerCase() === "m" &&
    !isFormControl(event.target)
  ) {
    updateSelection();
    if (!pendingSelection) return;
    event.preventDefault();
    beginCommentFromSelection();
  }
}

function submitFormOnCommandEnter(event) {
  if (!(event.metaKey || event.ctrlKey) || event.key !== "Enter") return;
  const target = event.target;
  if (!(target instanceof HTMLTextAreaElement)) return;
  const form = target.form;
  if (!form) return;
  event.preventDefault();
  form.requestSubmit();
}

function isFormControl(target) {
  const element = elementFromEventTarget(target);
  return Boolean(element?.closest?.("input, textarea, select, button"));
}

function elementFromEventTarget(target) {
  if (!target || typeof target !== "object") return null;
  if ("nodeType" in target && target.nodeType === Node.ELEMENT_NODE) {
    return target;
  }
  if ("parentElement" in target) {
    return target.parentElement;
  }
  return null;
}

async function loadState({ force = false } = {}) {
  if (saving && !force) {
    return;
  }

  if (dirty && !force) {
    blockedRemoteUpdate = true;
    showNotice(
      "Newer document available",
      "Save or reload before taking the latest agent update.",
    );
    return;
  }

  let response;
  try {
    response = await fetch("/api/state");
  } catch {
    showNotice("Load failed", "Redline could not reach the local server. Check that it is still running.");
    return;
  }

  if (!response.ok) {
    const payload = await readJsonPayload(response);
    showNotice("Load failed", payload.error || "Redline could not read the document.");
    return;
  }

  state = await response.json();
  dirty = false;
  blockedRemoteUpdate = false;
  hideNotice();
  if (activeThreadId && !state.threads.some((thread) => thread.id === activeThreadId)) {
    activeThreadId = null;
  }
  render();
}

function connectEvents() {
  const events = new EventSource("/api/events");
  events.addEventListener("state", (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (state?.version && payload.version === state.version) {
        return;
      }
    } catch {}
    void loadState();
  });
}

function render() {
  if (!state) return;
  documentPathEl.textContent = state.documentPath;
  renderFrame();
  renderThreads();
  updateToolbar();
}

function renderFrame() {
  anchorStatusReady = false;
  anchoredThreadIds = new Set();
  frame.addEventListener("load", setupFrame, { once: true });
  frame.srcdoc = prepareHtmlForFrame(state.html);
}

function setupFrame() {
  const doc = frame.contentDocument;
  if (!doc?.body) return;

  syncEditMode();
  doc.addEventListener("selectionchange", updateSelection);
  doc.addEventListener("mouseup", updateSelection);
  doc.addEventListener("keyup", updateSelection);
  doc.addEventListener("keydown", handleGlobalShortcut);
  doc.addEventListener("click", handleFrameClick);
  doc.body.addEventListener("focusin", handleEditableFocus);
  doc.body.addEventListener("focusout", handleEditableBlur);
  doc.body.addEventListener("keydown", handleEditableKeydown);
  doc.body.addEventListener("beforeinput", handleBeforeInput);
  doc.body.addEventListener("input", handleDocumentInput);
  doc.body.addEventListener("paste", handlePaste);
  applyHighlights();
  anchorStatusReady = true;
  renderThreads();
  syncHighlightSelection();
}

function prepareHtmlForFrame(html) {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  parsed.querySelector("#redline-base")?.remove();
  parsed.querySelector("#coauthor-base")?.remove();
  parsed.querySelector("#redline-runtime-style")?.remove();
  parsed.querySelector("#coauthor-runtime-style")?.remove();
  parsed.querySelector("#redline-state")?.remove();
  parsed.querySelector("#coauthor-state")?.remove();

  const base = parsed.createElement("base");
  base.id = "redline-base";
  base.href = `${window.location.origin}/document-assets/`;
  parsed.head.prepend(base);

  const style = parsed.createElement("style");
  style.id = "redline-runtime-style";
  style.textContent = `
    .redline-highlight {
      background: rgba(252, 211, 77, 0.55);
      border-bottom: 2px solid rgba(217, 119, 6, 0.8);
      cursor: pointer;
    }
    .redline-highlight.redline-active {
      background: rgba(45, 212, 191, 0.35);
      border-bottom-color: rgba(13, 148, 136, 0.9);
    }
    body.redline-edit-mode .redline-editable-text {
      cursor: text;
      border-radius: 4px;
      outline: 1px solid transparent;
      outline-offset: 3px;
      white-space: normal;
      transition: background-color 120ms ease, outline-color 120ms ease, box-shadow 120ms ease;
    }
    body.redline-edit-mode .redline-editable-text:hover {
      outline-color: rgba(20, 184, 166, 0.28);
    }
    body.redline-edit-mode .redline-editable-text:focus {
      outline: 2px solid rgba(20, 184, 166, 0.58);
      box-shadow: 0 0 0 5px rgba(20, 184, 166, 0.08);
    }
  `;
  parsed.head.append(style);

  return `<!doctype html>\n${parsed.documentElement.outerHTML}`;
}

function syncEditMode() {
  const doc = frame.contentDocument;
  if (!doc?.body) return;
  activeEditableElement = null;
  doc.body.classList.toggle("redline-edit-mode", editMode);
  doc.body.contentEditable = "false";
  doc.body.spellcheck = editMode;

  for (const element of doc.body.querySelectorAll(".redline-editable-text")) {
    element.classList.remove("redline-editable-text");
    element.removeAttribute("contenteditable");
    element.removeAttribute("spellcheck");
  }

  if (!editMode) return;

  for (const element of getEditableTextElements(doc)) {
    element.classList.add("redline-editable-text");
    element.setAttribute("contenteditable", "true");
    element.setAttribute("spellcheck", "true");
  }
}

function getEditableTextElements(doc) {
  const selector = [
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "p",
    "li",
    "td",
    "th",
    "figcaption",
    "caption",
    "dt",
    "dd",
    "summary",
  ].join(",");

  return [...doc.body.querySelectorAll(selector)].filter((element) => {
    if (!(element instanceof doc.defaultView.HTMLElement)) return false;
    if (element.closest("script,style,noscript,template,svg,canvas")) return false;
    if (!hasEditableText(element)) return false;

    const nestedEditable = element.querySelector(selector);
    if (nestedEditable && hasEditableText(nestedEditable)) return false;

    return true;
  });
}

function hasEditableText(element) {
  return (element.textContent ?? "").trim().length > 0;
}

function handleEditableFocus(event) {
  if (!editMode) return;
  const target = event.target;
  if (!(target instanceof frame.contentWindow.HTMLElement)) return;
  if (!target.classList.contains("redline-editable-text")) return;
  activeEditableElement = target;
}

function handleEditableBlur(event) {
  const target = event.target;
  if (target === activeEditableElement) {
    activeEditableElement = null;
  }
}

function handleEditableKeydown(event) {
  if (!editMode) return;
  const target = event.target;
  if (!(target instanceof frame.contentWindow.HTMLElement)) return;
  if (!target.classList.contains("redline-editable-text")) return;

  if (event.key === "Enter") {
    event.preventDefault();
  }
}

function handleBeforeInput(event) {
  if (!editMode) return;
  const target = event.target;
  if (!(target instanceof frame.contentWindow.HTMLElement)) return;
  if (!target.classList.contains("redline-editable-text")) return;

  const allowedInputTypes = new Set([
    "insertText",
    "insertCompositionText",
    "deleteContent",
    "deleteContentBackward",
    "deleteContentForward",
    "deleteByCut",
    "deleteByDrag",
    "historyUndo",
    "historyRedo",
  ]);

  if (allowedInputTypes.has(event.inputType)) return;

  if (event.inputType === "insertFromPaste" || event.inputType === "insertFromDrop") {
    event.preventDefault();
    insertPlainText(target.ownerDocument, event.dataTransfer?.getData("text/plain") ?? "");
    return;
  }

  event.preventDefault();
}

function handlePaste(event) {
  if (!editMode) return;
  const target = event.target;
  if (!(target instanceof frame.contentWindow.HTMLElement)) return;
  if (!target.classList.contains("redline-editable-text")) return;

  event.preventDefault();
  insertPlainText(target.ownerDocument, event.clipboardData?.getData("text/plain") ?? "");
}

function insertPlainText(doc, text) {
  if (!text) return;
  const selection = doc.defaultView.getSelection();
  if (!selection || selection.rangeCount === 0) return;
  selection.deleteFromDocument();
  selection.getRangeAt(0).insertNode(doc.createTextNode(text));
  selection.collapseToEnd();
  handleDocumentInput();
}

function handleDocumentInput() {
  if (!editMode) return;
  dirty = true;
  updateToolbar();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void saveNow();
  }, 900);
}

async function saveNow() {
  if (!state || saving || !frame.contentDocument) return;
  clearTimeout(saveTimer);
  const shouldPreserveFrame = editMode && !blockedRemoteUpdate;
  saving = true;
  updateToolbar();

  const html = cleanFrameHtml();
  const response = await fetch("/api/document", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      html,
      expectedVersion: state.version,
    }),
  });

  if (response.status === 409) {
    saving = false;
    blockedRemoteUpdate = true;
    showNotice(
      "Save paused",
      "The document changed outside this browser. Reload to review that version.",
    );
    updateToolbar();
    return;
  }

  if (!response.ok) {
    const payload = await readJsonPayload(response);
    saving = false;
    dirty = true;
    showNotice("Save failed", payload.error || "Redline could not write the document file.");
    updateToolbar();
    return;
  }

  state = await response.json();
  dirty = false;
  saving = false;
  blockedRemoteUpdate = false;
  hideNotice();
  if (shouldPreserveFrame) {
    documentPathEl.textContent = state.documentPath;
    renderThreads();
    updateToolbar();
    syncHighlightSelection();
    return;
  }
  render();
}

function cleanFrameHtml() {
  const doc = frame.contentDocument;
  const clone = doc.documentElement.cloneNode(true);
  clone.querySelector("#redline-base")?.remove();
  clone.querySelector("#coauthor-base")?.remove();
  clone.querySelector("#redline-runtime-style")?.remove();
  clone.querySelector("#coauthor-runtime-style")?.remove();

  for (const node of clone.querySelectorAll(".redline-highlight, .coauthor-highlight")) {
    if (node.hasAttribute("data-redline-anchor") || node.hasAttribute("data-coauthor-anchor")) {
      migrateLegacyAnchor(node);
      node.classList.remove("redline-highlight", "redline-active", "coauthor-highlight", "coauthor-active");
      node.removeAttribute("data-thread-id");
    } else {
      node.replaceWith(...node.childNodes);
    }
  }

  for (const node of clone.querySelectorAll("[data-redline-anchor], [data-coauthor-anchor]")) {
    migrateLegacyAnchor(node);
    node.classList.remove("redline-highlight", "redline-active", "coauthor-highlight", "coauthor-active");
    node.removeAttribute("data-thread-id");
  }

  const body = clone.querySelector("body");
  body?.removeAttribute("contenteditable");
  body?.removeAttribute("spellcheck");
  body?.classList.remove("redline-edit-mode");
  body?.classList.remove("coauthor-edit-mode");

  for (const element of clone.querySelectorAll(".redline-editable-text, .coauthor-editable-text")) {
    element.classList.remove("redline-editable-text", "coauthor-editable-text");
    element.removeAttribute("contenteditable");
    element.removeAttribute("spellcheck");
  }

  removeEmptyClassAttributes(clone);

  return `<!doctype html>\n${clone.outerHTML}\n`;
}

function removeEmptyClassAttributes(root) {
  for (const element of root.querySelectorAll("[class]")) {
    if (element.getAttribute("class")?.trim() === "") {
      element.removeAttribute("class");
    }
  }
}

function migrateLegacyAnchor(element) {
  const legacyAnchor = element.getAttribute("data-coauthor-anchor");
  if (legacyAnchor && !element.hasAttribute("data-redline-anchor")) {
    element.setAttribute("data-redline-anchor", legacyAnchor);
  }
  element.removeAttribute("data-coauthor-anchor");
}

function updateSelection() {
  const doc = frame.contentDocument;
  const win = frame.contentWindow;
  if (!doc?.body || !win) return;

  if (composer.hidden === false) return;

  const selection = win.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    pendingSelection = null;
    updateToolbar();
    return;
  }

  const range = selection.getRangeAt(0);
  if (!rangeIntersectsRoot(range, doc.body)) {
    pendingSelection = null;
    updateToolbar();
    return;
  }

  const quote = selection.toString().replace(/\s+/g, " ").trim();
  if (!quote) {
    pendingSelection = null;
    updateToolbar();
    return;
  }

  const preRange = doc.createRange();
  preRange.selectNodeContents(doc.body);
  preRange.setEnd(range.startContainer, range.startOffset);
  const start = preRange.toString().length;
  const end = start + selection.toString().length;
  const fullText = doc.body.textContent ?? "";

  pendingSelection = {
    quote,
    range: range.cloneRange(),
    anchor: {
      type: "text-range",
      quote,
      prefix: fullText.slice(Math.max(0, start - 120), start),
      suffix: fullText.slice(end, end + 120),
      textPosition: { start, end },
    },
  };
  updateToolbar();
}

function rangeIntersectsRoot(range, root) {
  const node = range.commonAncestorContainer;
  const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  return element === root || root.contains(element);
}

function beginCommentFromSelection() {
  if (!pendingSelection) return false;
  if (!ensurePendingInlineAnchor()) {
    showNotice(
      "Selection changed",
      "Select the text again before adding a comment.",
    );
    return false;
  }
  openComposer();
  return true;
}

function openComposer() {
  selectedQuoteEl.textContent = pendingSelection.quote;
  commentBody.value = "";
  composer.hidden = false;
  commentBody.focus();
}

function closeComposer({ discardDraft = false } = {}) {
  if (discardDraft && pendingSelection?.threadId) {
    removeInlineAnchorFromFrame(pendingSelection.threadId);
    pendingSelection = null;
  }
  composer.hidden = true;
  commentBody.value = "";
  updateToolbar();
}

function ensurePendingInlineAnchor() {
  if (!pendingSelection) return false;
  if (pendingSelection.threadId) return true;

  const doc = frame.contentDocument;
  if (!doc?.body || !pendingSelection.range) return false;
  const range = pendingSelection.range;
  const ancestor = range.commonAncestorContainer;
  const anchorElement =
    ancestor.nodeType === Node.ELEMENT_NODE ? ancestor : ancestor.parentElement;
  if (!anchorElement || !doc.body.contains(anchorElement)) return false;

  const threadId = newThreadId();
  if (!insertHighlightSpan(doc, range, threadId, { persistent: true })) {
    return false;
  }

  pendingSelection.threadId = threadId;
  pendingSelection.anchor = {
    ...pendingSelection.anchor,
    anchorId: threadId,
  };
  anchoredThreadIds.add(threadId);
  syncHighlightSelection();
  return true;
}

function removeInlineAnchorFromFrame(threadId) {
  const doc = frame.contentDocument;
  if (!doc) return;
  const anchorValue = attributeValue(threadId);
  for (const element of doc.querySelectorAll(
    `[data-redline-anchor="${anchorValue}"], [data-coauthor-anchor="${anchorValue}"]`,
  )) {
    unwrapElement(element);
  }
}

function unwrapElement(element) {
  element.replaceWith(...element.childNodes);
}

function getStoredAuthorName() {
  const stored = localStorage.getItem("redline.authorName") || localStorage.getItem("coauthor.authorName");
  if (stored) {
    localStorage.setItem("redline.authorName", stored);
    return stored;
  }
  return "User";
}

function getAuthorName() {
  return authorNameInput.value.trim() || "User";
}

function renderThreads() {
  const threads = [...(state?.threads ?? [])].sort((left, right) => {
    const leftStart = left.anchor.textPosition?.start ?? Number.MAX_SAFE_INTEGER;
    const rightStart = right.anchor.textPosition?.start ?? Number.MAX_SAFE_INTEGER;
    return leftStart - rightStart || left.createdAt.localeCompare(right.createdAt);
  });

  threadCountEl.textContent = `${threads.length} ${threads.length === 1 ? "thread" : "threads"}`;

  if (threads.length === 0) {
    threadsEl.innerHTML = `<div class="empty-state">No open comments.</div>`;
    return;
  }

  threadsEl.innerHTML = threads
    .map((thread) => {
      const active = thread.id === activeThreadId;
      const quote = thread.quote || thread.anchor.quote || "Document comment";
      const anchorMissing =
        anchorStatusReady &&
        thread.anchor.type === "text-range" &&
        !anchoredThreadIds.has(thread.id);
      const messages = thread.messages
        .map(
          (message) => `
            <div class="message">
              <div class="message-meta">
                <span>${escapeHtml(message.author)}</span>
                <time>${formatTime(message.createdAt)}</time>
              </div>
              <p>${escapeHtml(message.body)}</p>
            </div>
          `,
        )
        .join("");

      return `
        <article class="thread-card ${active ? "active" : ""} ${anchorMissing ? "unanchored" : ""}" data-thread-id="${escapeHtml(thread.id)}">
          <button type="button" class="thread-target" data-thread-id="${escapeHtml(thread.id)}">
            <span>${escapeHtml(quote)}</span>
          </button>
          ${
            anchorMissing
              ? `<div class="anchor-warning">Anchor text changed. Thread kept until resolved.</div>`
              : ""
          }
          ${messages}
          <form class="reply-form" data-reply-form="${escapeHtml(thread.id)}">
            <textarea rows="2" placeholder="Reply"></textarea>
            <div class="thread-actions">
              <button type="submit" class="ghost-button">Reply</button>
              <button type="button" class="ghost-button" data-resolve-thread="${escapeHtml(thread.id)}">Resolve</button>
            </div>
          </form>
        </article>
      `;
    })
    .join("");
}

function handleFrameClick(event) {
  const target = event.target;
  if (!(target instanceof frame.contentWindow.HTMLElement)) return;
  const highlight = target.closest(".redline-highlight, .coauthor-highlight");
  if (!highlight) return;
  const threadId = highlight.getAttribute("data-thread-id");
  if (threadId) selectThread(threadId);
}

function selectThread(threadId, keepFocus = false) {
  activeThreadId = threadId;
  renderThreads();
  syncHighlightSelection();
  if (!keepFocus) {
    scrollToThreadAnchor(threadId);
  }
}

function activateThreadWithoutRender(threadId) {
  activeThreadId = threadId;
  for (const card of threadsEl.querySelectorAll(".thread-card[data-thread-id]")) {
    card.classList.toggle("active", card.getAttribute("data-thread-id") === threadId);
  }
  syncHighlightSelection();
}

async function resolveComment(threadId) {
  const response = await fetch(`/api/comments/${encodeURIComponent(threadId)}/resolve`, {
    method: "POST",
  });
  if (!response.ok) {
    const payload = await readJsonPayload(response);
    showNotice("Resolve failed", payload.error || "Redline could not resolve this thread.");
    updateToolbar();
    return;
  }
  state = await response.json();
  if (activeThreadId === threadId) activeThreadId = null;
  render();
}

function applyHighlights() {
  const doc = frame.contentDocument;
  if (!doc?.body || !state) return;
  anchoredThreadIds = new Set();

  const threadsByAnchor = new Map();
  for (const thread of state.threads) {
    threadsByAnchor.set(thread.id, thread);
    if (thread.anchor.anchorId) {
      threadsByAnchor.set(thread.anchor.anchorId, thread);
    }
  }

  for (const element of doc.body.querySelectorAll("[data-redline-anchor], [data-coauthor-anchor]")) {
    migrateLegacyAnchor(element);
    const anchorId = element.getAttribute("data-redline-anchor");
    const thread = anchorId ? threadsByAnchor.get(anchorId) : null;
    if (!thread) continue;
    element.classList.add("redline-highlight");
    element.setAttribute("data-thread-id", thread.id);
    anchoredThreadIds.add(thread.id);
  }

  const ranges = state.threads
    .filter((thread) => !anchoredThreadIds.has(thread.id))
    .map((thread) => ({
      thread,
      range: findRangeForAnchor(doc.body, thread.anchor),
    }))
    .filter((item) => item.range)
    .sort((left, right) => right.range.start - left.range.start);

  for (const item of ranges) {
    if (wrapRange(doc, item.range, item.thread.id)) {
      anchoredThreadIds.add(item.thread.id);
    }
  }
}

function findRangeForAnchor(root, anchor) {
  if (anchor.type !== "text-range") return null;
  const text = root.textContent ?? "";
  const quote = anchor.quote ?? "";

  if (anchor.textPosition) {
    const { start, end } = anchor.textPosition;
    if (start >= 0 && end > start && text.slice(start, end).replace(/\s+/g, " ").trim() === quote) {
      return { start, end };
    }
  }

  if (!quote) return null;
  const exact = text.indexOf(quote);
  if (exact !== -1) {
    return { start: exact, end: exact + quote.length };
  }

  const normalizedText = text.replace(/\s+/g, " ");
  const normalizedQuote = quote.replace(/\s+/g, " ");
  const normalizedIndex = normalizedText.indexOf(normalizedQuote);
  if (normalizedIndex === -1) return null;
  return mapNormalizedRange(text, normalizedIndex, normalizedIndex + normalizedQuote.length);
}

function mapNormalizedRange(original, normalizedStart, normalizedEnd) {
  let normalizedIndex = 0;
  let start = null;
  let end = null;
  let inWhitespace = false;

  for (let index = 0; index < original.length; index += 1) {
    const char = original[index];
    const isWhitespace = /\s/.test(char);
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
  return { start, end: end ?? original.length };
}

function wrapRange(doc, range, threadId) {
  const startPoint = locateTextOffset(doc.body, range.start);
  const endPoint = locateTextOffset(doc.body, range.end);
  if (!startPoint || !endPoint) return;

  const domRange = doc.createRange();
  domRange.setStart(startPoint.node, startPoint.offset);
  domRange.setEnd(endPoint.node, endPoint.offset);

  return insertHighlightSpan(doc, domRange, threadId);
}

function insertHighlightSpan(doc, domRange, threadId, { persistent = false } = {}) {
  const span = doc.createElement("span");
  span.className = "redline-highlight";
  span.setAttribute("data-thread-id", threadId);
  if (persistent) {
    span.setAttribute("data-redline-anchor", threadId);
  }
  try {
    const fragment = domRange.extractContents();
    span.append(fragment);
    domRange.insertNode(span);
    return true;
  } catch {
    span.remove();
    return false;
  }
}

function locateTextOffset(root, offset) {
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let currentOffset = 0;
  let lastNode = null;

  while (walker.nextNode()) {
    const node = walker.currentNode;
    lastNode = node;
    const nextOffset = currentOffset + node.nodeValue.length;
    if (offset <= nextOffset) {
      return {
        node,
        offset: Math.max(0, offset - currentOffset),
      };
    }
    currentOffset = nextOffset;
  }

  if (lastNode) {
    return { node: lastNode, offset: lastNode.nodeValue.length };
  }
  return null;
}

function syncHighlightSelection() {
  const doc = frame.contentDocument;
  if (!doc) return;
  for (const item of doc.querySelectorAll(".redline-highlight, .coauthor-highlight")) {
    item.classList.toggle("redline-active", item.getAttribute("data-thread-id") === activeThreadId);
    item.classList.toggle("coauthor-active", item.getAttribute("data-thread-id") === activeThreadId);
  }
}

function scrollToThreadAnchor(threadId) {
  const doc = frame.contentDocument;
  const escapedThreadId = cssEscape(threadId);
  const anchor = doc?.querySelector(
    `.redline-highlight[data-thread-id="${escapedThreadId}"], .coauthor-highlight[data-thread-id="${escapedThreadId}"]`,
  );
  anchor?.scrollIntoView({ block: "center", behavior: "smooth" });
}

function updateToolbar() {
  editButton.textContent = editMode ? "Editing" : "Edit";
  editButton.classList.toggle("active", editMode);
  commentButton.disabled = !pendingSelection;

  if (saving) {
    saveStatusEl.textContent = "Saving";
    saveStatusEl.dataset.tone = "neutral";
    return;
  }

  if (blockedRemoteUpdate) {
    saveStatusEl.textContent = "Reload needed";
    saveStatusEl.dataset.tone = "warning";
    return;
  }

  if (dirty) {
    saveStatusEl.textContent = "Unsaved";
    saveStatusEl.dataset.tone = "warning";
    return;
  }

  saveStatusEl.textContent = "Saved";
  saveStatusEl.dataset.tone = "success";
}

function showNotice(title, body) {
  noticeTitle.textContent = title;
  noticeBody.textContent = body;
  notice.hidden = false;
}

function hideNotice() {
  notice.hidden = true;
}

async function readJsonPayload(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function cssEscape(value) {
  if (window.CSS?.escape) return CSS.escape(value);
  return String(value).replace(/["\\]/g, "\\$&");
}

function attributeValue(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function newThreadId() {
  return `thread_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
}
