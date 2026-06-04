import {
  collectThreadLiveOrderFromAnchors,
  createProgrammaticScrollGuard,
  openAncestorDetails,
  removeRuntimeOpenedDetails,
  sortThreadsForRail,
} from "./app-helpers.js";

const frame = document.querySelector("#documentFrame");
const documentPathEl = document.querySelector("#documentPath");
const saveStatusEl = document.querySelector("#saveStatus");
const reloadButton = document.querySelector("#reloadButton");
const editButton = document.querySelector("#editButton");
const authorNameInput = document.querySelector("#authorName");
const composer = document.querySelector("#composer");
const commentForm = document.querySelector("#commentForm");
const commentBody = document.querySelector("#commentBody");
const cancelCommentButton = document.querySelector("#cancelCommentButton");
const threadsEl = document.querySelector("#threads");
const notice = document.querySelector("#notice");
const noticeTitle = document.querySelector("#noticeTitle");
const noticeBody = document.querySelector("#noticeBody");
const noticeAction = document.querySelector("#noticeAction");
const appShell = document.querySelector(".app-shell");
const commentRail = document.querySelector(".comment-rail");
const commentRailInner = document.querySelector(".comment-rail-inner");
const railToggle = document.querySelector("#railToggle");
const railToggleCount = document.querySelector("#railToggleCount");
const openButton = document.querySelector("#openButton");
const selectionFab = document.querySelector("#selectionFab");

let state = null;
let editMode = false;
let railCollapsed = localStorage.getItem("redline.railCollapsed") === "1";
let dirty = false;
let saving = false;
let pendingSelection = null;
let activeThreadId = null;
let saveTimer = null;
let blockedRemoteUpdate = false;
let activeEditableElement = null;
let anchorStatusReady = false;
let anchoredThreadIds = new Set();
let frameResizeObserver = null;
let frameViewportCleanup = null;
let fabTimer = null;
let pointerSelectionActive = false;
let localMutationDepth = 0;
let railAutoFollowPaused = false;
let railProgrammaticScrollDepth = 0;
let railRevealFrame = null;
let railRevealTimer = null;

const RAIL_EDGE_PADDING = 16;

const frameScrollGuard = createProgrammaticScrollGuard({
  onRestore: (threadId) => {
    if (activeThreadId !== threadId) {
      activateThreadWithoutRender(threadId);
    }
  },
});

authorNameInput.value = getStoredAuthorName();

await loadState({ force: true });
connectEvents();

reloadButton.addEventListener("click", () => loadState({ force: true }));
noticeAction.addEventListener("click", () => loadState({ force: true }));
authorNameInput.addEventListener("input", () => {
  localStorage.setItem("redline.authorName", getAuthorName());
  renderThreads();
});
editButton.addEventListener("click", () => {
  editMode = !editMode;
  if (!editMode && dirty) {
    void saveNow();
  }
  syncEditMode();
  updateToolbar();
});

railToggle.addEventListener("click", () => setRailCollapsed(!railCollapsed));
commentRail.addEventListener("scroll", () => {
  if (railProgrammaticScrollDepth > 0) return;
  railAutoFollowPaused = true;
}, { passive: true });

openButton.addEventListener("click", () => void openViaDialog());
selectionFab.addEventListener("mousedown", (event) => event.preventDefault());
selectionFab.addEventListener("click", () => {
  beginCommentFromSelection();
});
window.addEventListener("scroll", repositionSelectionFab, true);
window.addEventListener("resize", () => {
  repositionSelectionFab();
  layoutRail();
});

cancelCommentButton.addEventListener("click", () => closeComposer({ discardDraft: true }));
commentBody.addEventListener("keydown", submitFormOnCommandEnter);
document.addEventListener("pointerdown", (event) => {
  const target = elementFromEventTarget(event.target);
  if (target?.closest?.(".reply-form, .message-edit-form")) return;
  closeEmptyReplyForms({ ignoreFocus: true });
  deselectThreadIfOutsideComment(target);
});
document.addEventListener("focusin", (event) => {
  const target = elementFromEventTarget(event.target);
  if (target?.closest?.(".reply-form, .message-edit-form")) return;
  closeEmptyReplyForms();
  deselectThreadIfOutsideComment(target);
});

commentForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!pendingSelection) return;
  const body = commentBody.value.trim();
  if (!body) return;
  if (!ensurePendingInlineAnchor()) return;

  const threadId = pendingSelection.threadId;
  if (!threadId) return;

  const endLocalMutation = beginLocalMutation();
  try {
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
    render({ preserveFrame: true });
  } finally {
    endLocalMutation();
  }
});

threadsEl.addEventListener("click", async (event) => {
  // Use Element, not HTMLElement: clicking the SVG icon inside a button makes
  // event.target an SVGElement, which still has closest() for delegation.
  const target = event.target;
  if (!(target instanceof Element)) return;

  const editCancelButton = target.closest("[data-edit-cancel]");
  if (editCancelButton instanceof HTMLElement) {
    const form = editCancelButton.closest(".message-edit-form");
    if (form instanceof HTMLFormElement) closeMessageEditForm(form);
    return;
  }

  const editMessageButton = target.closest("[data-edit-message]");
  if (editMessageButton instanceof HTMLElement) {
    const threadId = editMessageButton.getAttribute("data-edit-thread");
    const messageId = editMessageButton.getAttribute("data-edit-message");
    if (threadId && messageId) openMessageEditForm(threadId, messageId);
    return;
  }

  const deleteReplyButton = target.closest("[data-delete-reply-message]");
  if (deleteReplyButton instanceof HTMLElement) {
    const threadId = deleteReplyButton.getAttribute("data-delete-reply-thread");
    const messageId = deleteReplyButton.getAttribute("data-delete-reply-message");
    if (threadId && messageId) await deleteReply(threadId, messageId);
    return;
  }

  const resolveButton = target.closest("[data-resolve-thread]");
  if (resolveButton instanceof HTMLElement) {
    const id = resolveButton.getAttribute("data-resolve-thread");
    if (id) await resolveComment(id);
    return;
  }

  const replyToggle = target.closest("[data-reply-toggle]");
  if (replyToggle instanceof HTMLElement) {
    const id = replyToggle.getAttribute("data-reply-toggle");
    if (id) openReplyForThread(id);
    return;
  }

  const threadCard = target.closest("[data-thread-id]");
  const threadId = threadCard?.getAttribute("data-thread-id");
  if (!threadId) return;

  if (target.closest(".reply-form textarea, .reply-form button, .message-edit-form textarea, .message-edit-form button")) {
    activateThreadWithoutRender(threadId);
    return;
  }

  selectThread(threadId);
});

threadsEl.addEventListener("keydown", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLTextAreaElement)) return;
  if (!target.closest(".reply-form, .message-edit-form")) return;
  submitFormOnCommandEnter(event);
});

threadsEl.addEventListener("focusout", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const form = target.closest(".reply-form");
  if (!(form instanceof HTMLFormElement)) return;

  setTimeout(() => closeReplyFormIfEmpty(form), 0);
});

threadsEl.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;

  if (form.matches(".message-edit-form")) {
    await submitMessageEditForm(form);
    return;
  }

  const threadId = form.getAttribute("data-reply-form");
  const input = form.querySelector("textarea");
  const body = input?.value.trim() ?? "";
  if (!threadId) return;
  if (!body) {
    closeReplyForm(form);
    return;
  }

  const endLocalMutation = beginLocalMutation();
  try {
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
    render({ preserveFrame: true });
  } finally {
    endLocalMutation();
  }
});

window.addEventListener("keydown", handleGlobalShortcut);
window.addEventListener("resize", syncFrameViewport);

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
    if (localMutationDepth > 0) return;
    try {
      const payload = JSON.parse(event.data);
      if (state?.version && payload.version === state.version) {
        return;
      }
    } catch {}
    void loadState();
  });
}

function beginLocalMutation() {
  localMutationDepth += 1;
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    localMutationDepth = Math.max(0, localMutationDepth - 1);
  };
}

function render({ preserveFrame = false } = {}) {
  if (!state) return;
  documentPathEl.textContent = state.documentPath;
  if (!preserveFrame) {
    renderFrame();
  }
  renderThreads();
  updateToolbar();
  updateRail();
  if (preserveFrame) {
    syncHighlightSelection();
  }
}

function setRailCollapsed(collapsed) {
  railCollapsed = collapsed;
  localStorage.setItem("redline.railCollapsed", collapsed ? "1" : "0");
  updateRail();
}

// Decide whether the comment rail is shown, and in which mode:
//   "empty"  — no threads and not composing → rail fully hidden, doc full width
//   "closed" — threads exist but the user collapsed the rail
//   "open"   — rail visible (always while composing)
function updateRail() {
  const threadCount = state?.threads?.length ?? 0;
  const composerOpen = composer.hidden === false;
  const mode = threadCount === 0 && !composerOpen
    ? "empty"
    : railCollapsed && !composerOpen
      ? "closed"
      : "open";

  const open = mode === "open";
  appShell.dataset.rail = mode;
  railToggle.hidden = threadCount === 0;
  railToggle.setAttribute("aria-pressed", open ? "true" : "false");
  railToggle.classList.toggle("active", open);
  railToggle.title = open ? "Hide comments" : "Show comments";
  railToggleCount.textContent = String(threadCount);
  layoutRail();
}

// ---------- Open another file (native OS picker) ----------

async function openViaDialog() {
  // Don't switch documents while a save is racing or unsaved edits would be
  // lost — flush first and bail if the document still isn't clean.
  if (saving) return;
  if (dirty) {
    await saveNow();
  }
  if (dirty || blockedRemoteUpdate) {
    showNotice(
      "Unsaved changes",
      "Save or reload this document before opening another file.",
    );
    return;
  }
  openButton.disabled = true;
  let response;
  try {
    response = await fetch("/api/open-dialog", { method: "POST" });
  } catch {
    showNotice("Open failed", "Redline could not reach the local server.");
    return;
  } finally {
    openButton.disabled = false;
  }
  if (!response.ok) {
    const payload = await readJsonPayload(response);
    showNotice("Open failed", payload.error || "That file could not be opened.");
    return;
  }
  const data = await response.json();
  if (data.cancelled) return;

  state = data;
  activeThreadId = null;
  pendingSelection = null;
  dirty = false;
  blockedRemoteUpdate = false;
  hideNotice();
  hideSelectionFab();
  render();
}

// ---------- Floating selection comment button ----------

function repositionSelectionFab() {
  if (selectionFab.hidden) return;
  positionSelectionFab();
}

// Show the button only from selection-complete events (mouseup/keyup), never
// from raw selectionchange while the user may still be dragging.
function scheduleSelectionFab() {
  hideSelectionFab();
  fabTimer = setTimeout(positionSelectionFab, 180);
}

function positionSelectionFab() {
  if (!pendingSelection?.range || composer.hidden === false) {
    hideSelectionFab();
    return;
  }
  const rects = pendingSelection.range.getClientRects();
  const rect = rects[rects.length - 1];
  if (!rect || (rect.width === 0 && rect.height === 0)) {
    hideSelectionFab();
    return;
  }
  const frameRect = frame.getBoundingClientRect();
  const x = Math.min(frameRect.left + rect.right + 10, window.innerWidth - 22);
  const y = Math.min(
    Math.max(frameRect.top + (rect.top + rect.bottom) / 2, 64),
    window.innerHeight - 20,
  );
  selectionFab.style.left = `${x}px`;
  selectionFab.style.top = `${y}px`;
  selectionFab.hidden = false;
}

function hideSelectionFab() {
  clearTimeout(fabTimer);
  selectionFab.hidden = true;
}

function renderFrame() {
  anchorStatusReady = false;
  anchoredThreadIds = new Set();
  pointerSelectionActive = false;
  teardownFrameViewportTracking();
  // Replacing the document invalidates any pending selection (its Range points
  // into the old document) and any queued selection-fab timer.
  pendingSelection = null;
  hideSelectionFab();
  // Drop any prior not-yet-fired load handler so a burst of renders can't run
  // setupFrame twice on one document (duplicate listeners / observers).
  frame.removeEventListener("load", setupFrame);
  frame.addEventListener("load", setupFrame, { once: true });
  frame.srcdoc = prepareHtmlForFrame(state.html);
}

function teardownFrameViewportTracking() {
  frameViewportCleanup?.();
  frameViewportCleanup = null;
  frameResizeObserver?.disconnect();
  frameResizeObserver = null;
}

function syncFrameViewport({ followRail = false } = {}) {
  layoutRail();
  repositionSelectionFab();
  if (followRail) syncRailToFrameViewport();
}

function setupFrame() {
  const doc = frame.contentDocument;
  if (!doc?.body) return;
  const win = frame.contentWindow;

  syncEditMode();
  doc.addEventListener("selectionchange", () => {
    updateSelection();
    if (pointerSelectionActive) hideSelectionFab();
  });
  doc.addEventListener("mousedown", () => {
    pointerSelectionActive = true;
    hideSelectionFab();
  });
  doc.addEventListener("mouseup", () => {
    pointerSelectionActive = false;
    updateSelection({ showFab: true });
  });
  doc.addEventListener("keyup", () => updateSelection({ showFab: true }));
  doc.addEventListener("keydown", (event) => {
    hideSelectionFab();
    handleGlobalShortcut(event);
  });
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

  let trackingActive = true;
  const onViewportChange = () => {
    if (trackingActive) syncFrameViewport();
  };
  const onFrameScroll = () => {
    if (!trackingActive) return;
    if (frameScrollGuard.isActive()) {
      syncFrameViewport();
      return;
    }
    railAutoFollowPaused = false;
    syncFrameViewport({ followRail: true });
  };
  win?.addEventListener("scroll", onFrameScroll, { passive: true });
  win?.addEventListener("resize", onViewportChange);
  doc.addEventListener("scroll", onFrameScroll, { capture: true, passive: true });
  doc.fonts?.ready.then(onViewportChange).catch(() => {});
  frameResizeObserver = new ResizeObserver(onViewportChange);
  frameResizeObserver.observe(doc.body);
  frameResizeObserver.observe(doc.documentElement);
  frameViewportCleanup = () => {
    trackingActive = false;
    win?.removeEventListener("scroll", onFrameScroll);
    win?.removeEventListener("resize", onViewportChange);
    doc.removeEventListener("scroll", onFrameScroll, { capture: true });
    frameResizeObserver?.disconnect();
    frameResizeObserver = null;
  };
  syncFrameViewport();
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
      background: rgba(196, 54, 29, 0.12);
      border-bottom: 2px solid rgba(196, 54, 29, 0.5);
      border-radius: 2px;
      cursor: pointer;
      transition: background-color 140ms ease, border-color 140ms ease;
    }
    .redline-highlight:hover {
      background: rgba(196, 54, 29, 0.18);
    }
    .redline-highlight.redline-active {
      background: rgba(196, 54, 29, 0.24);
      border-bottom: 2px solid rgba(160, 39, 18, 0.95);
      box-shadow: 0 0 0 2px rgba(196, 54, 29, 0.16);
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
      outline-color: rgba(196, 54, 29, 0.28);
    }
    body.redline-edit-mode .redline-editable-text:focus {
      outline: 2px solid rgba(196, 54, 29, 0.55);
      box-shadow: 0 0 0 5px rgba(196, 54, 29, 0.08);
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

  removeRuntimeOpenedDetails(clone);

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

function updateSelection({ showFab = false } = {}) {
  const doc = frame.contentDocument;
  const win = frame.contentWindow;
  if (!doc?.body || !win) return;

  if (composer.hidden === false) return;

  const selection = win.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    // A bare caret resting inside an anchored span focuses that thread (so
    // clicking into the highlighted text lights up its comment); a caret
    // anywhere else clears the active thread.
    if (selection?.isCollapsed) {
      const node = selection.anchorNode;
      const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
      const highlight = element?.closest?.(".redline-highlight, .coauthor-highlight");
      const id = highlight?.getAttribute("data-thread-id");
      if (id) {
        if (id !== activeThreadId) selectThread(id, true);
      } else {
        deselectThread();
      }
    }
    pendingSelection = null;
    hideSelectionFab();
    updateToolbar();
    return;
  }

  const range = selection.getRangeAt(0);
  if (!rangeIntersectsRoot(range, doc.body)) {
    pendingSelection = null;
    hideSelectionFab();
    updateToolbar();
    return;
  }

  const quote = selection.toString().replace(/\s+/g, " ").trim();
  if (!quote) {
    pendingSelection = null;
    hideSelectionFab();
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
  if (showFab) {
    scheduleSelectionFab();
  }
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
  commentBody.value = "";
  composer.hidden = false;
  hideSelectionFab();
  // Commenting implies you want the rail; reopen it and keep it open afterward.
  setRailCollapsed(false);
  layoutRail();
  commentBody.focus();
}

// ---------- Comment rail viewport sync ----------
//
// Thread cards stay in document order in the independently scrollable rail.
// As the iframe scrolls, the rail activates and reveals the thread whose anchor
// is visible or nearest to the document viewport.
function layoutRail() {
  if (!commentRailInner) return;
  commentRailInner.style.height = "";
  composer.style.top = "";
  for (const card of threadsEl.querySelectorAll(".thread-card")) {
    card.style.top = "";
  }
}

function syncRailToFrameViewport({ force = false, behavior = "auto" } = {}) {
  if (appShell.dataset.rail !== "open") return;
  if (composer.hidden === false) return;
  if (railAutoFollowPaused && !force) return;
  if (commentRail.contains(document.activeElement) && isFormControl(document.activeElement)) return;

  const threadId = threadIdForFrameViewport();
  if (!threadId) return;

  if (threadId !== activeThreadId) {
    activateThreadWithoutRender(threadId);
  }
  layoutRail();
  revealThreadCardInRailSoon(threadId, { behavior });
}

function threadIdForFrameViewport() {
  const doc = frame.contentDocument;
  const win = frame.contentWindow;
  if (!doc?.body || !win) return null;

  const viewportHeight = win.innerHeight || doc.documentElement.clientHeight || 0;
  const metrics = sortedThreads()
    .map((thread, index) => {
      const metric = anchorViewportMetric(thread.id, doc);
      return metric ? { ...metric, id: thread.id, index } : null;
    })
    .filter(Boolean);

  if (metrics.length === 0) return null;

  const visible = metrics
    .filter((metric) => metric.bottom >= 0 && metric.top <= viewportHeight)
    .sort((left, right) => {
      return Math.max(0, left.top) - Math.max(0, right.top) || left.index - right.index;
    });
  if (visible[0]) return visible[0].id;

  const below = metrics
    .filter((metric) => metric.top >= 0)
    .sort((left, right) => left.top - right.top || left.index - right.index);
  if (below[0]) return below[0].id;

  const above = metrics
    .filter((metric) => metric.bottom < 0)
    .sort((left, right) => right.bottom - left.bottom || right.index - left.index);
  return above[0]?.id ?? null;
}

function anchorViewportMetric(threadId, doc) {
  const escapedThreadId = cssEscape(threadId);
  const anchors = doc.querySelectorAll(
    `.redline-highlight[data-thread-id="${escapedThreadId}"], .coauthor-highlight[data-thread-id="${escapedThreadId}"]`,
  );
  let top = Infinity;
  let bottom = -Infinity;

  for (const anchor of anchors) {
    for (const rect of anchor.getClientRects()) {
      if (rect.width === 0 && rect.height === 0) continue;
      top = Math.min(top, rect.top);
      bottom = Math.max(bottom, rect.bottom);
    }
  }

  if (top === Infinity) return null;
  return { top, bottom };
}

function revealThreadCardInRail(threadId, { behavior = "auto" } = {}) {
  if (appShell.dataset.rail !== "open") return;

  const card = threadsEl.querySelector(`.thread-card[data-thread-id="${cssEscape(threadId)}"]`);
  if (!(card instanceof HTMLElement)) return;

  const railHeight = commentRail.clientHeight;
  const cardTop = card.offsetTop;
  const cardBottom = cardTop + card.offsetHeight;
  const currentTop = commentRail.scrollTop;
  const currentBottom = currentTop + railHeight;
  let nextTop = currentTop;

  if (cardTop - RAIL_EDGE_PADDING < currentTop) {
    nextTop = cardTop - RAIL_EDGE_PADDING;
  } else if (cardBottom + RAIL_EDGE_PADDING > currentBottom) {
    nextTop = cardBottom + RAIL_EDGE_PADDING - railHeight;
  }

  const maxTop = Math.max(0, commentRail.scrollHeight - railHeight);
  nextTop = Math.max(0, Math.min(maxTop, nextTop));
  if (Math.abs(nextTop - currentTop) < 1) return;

  railProgrammaticScrollDepth += 1;
  commentRail.scrollTo({ top: nextTop, behavior });
  window.setTimeout(() => {
    railProgrammaticScrollDepth = Math.max(0, railProgrammaticScrollDepth - 1);
  }, behavior === "smooth" ? 600 : 80);
}

function revealThreadCardInRailSoon(threadId, options = {}) {
  revealThreadCardInRail(threadId, options);
  if (railRevealFrame != null) {
    cancelAnimationFrame(railRevealFrame);
  }
  clearTimeout(railRevealTimer);
  railRevealFrame = requestAnimationFrame(() => {
    railRevealFrame = null;
    revealThreadCardInRail(threadId, options);
  });
  railRevealTimer = setTimeout(() => {
    revealThreadCardInRail(threadId, options);
  }, 140);
}

function closeComposer({ discardDraft = false } = {}) {
  if (discardDraft && pendingSelection?.threadId) {
    removeInlineAnchorFromFrame(pendingSelection.threadId);
    pendingSelection = null;
  }
  composer.hidden = true;
  composer.style.top = "";
  commentBody.value = "";
  updateToolbar();
  updateRail();
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

function sortedThreads() {
  return sortThreadsForRail(state?.threads ?? [], threadLiveOrder());
}

function threadLiveOrder() {
  const doc = frame.contentDocument;
  if (!anchorStatusReady || !doc?.body) return new Map();
  return collectThreadLiveOrderFromAnchors(doc.body);
}

function renderThreads() {
  const threads = sortedThreads();
  const currentAuthor = getAuthorName();

  if (threads.length === 0) {
    // The rail only shows at all when there's a thread or an open composer, so
    // an empty-state here would never be the whole story — leave it blank.
    threadsEl.innerHTML = "";
    return;
  }

  threadsEl.innerHTML = threads
    .map((thread) => {
      const active = thread.id === activeThreadId;
      const anchorMissing =
        anchorStatusReady &&
        thread.anchor.type === "text-range" &&
        !anchoredThreadIds.has(thread.id);
      const lastMessage = thread.messages.at(-1);
      const canEditLastMessage =
        Boolean(lastMessage) && lastMessage.author.trim() === currentAuthor;
      const messages = thread.messages
        .map(
          (message, messageIndex) => `
            <div class="message" data-message-id="${escapeHtml(message.id)}">
              <div class="message-meta">
                <span>${escapeHtml(message.author)}</span>
                <div class="message-meta-actions">
                  <time>${formatTime(message.createdAt)}</time>
                  ${
                    messageIndex > 0
                      ? `
                        <button type="button" class="message-delete-button"
                          data-delete-reply-thread="${escapeHtml(thread.id)}"
                          data-delete-reply-message="${escapeHtml(message.id)}"
                          title="Delete reply" aria-label="Delete reply">
                          <svg class="btn-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                            <path d="M5 7h14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
                            <path d="M9.5 7V5.6a1.1 1.1 0 0 1 1.1-1.1h2.8a1.1 1.1 0 0 1 1.1 1.1V7" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
                            <path d="M6.7 7.5 7.6 18.6A1.4 1.4 0 0 0 9 20h6a1.4 1.4 0 0 0 1.4-1.4L17.3 7.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
                          </svg>
                        </button>
                      `
                      : ""
                  }
                </div>
              </div>
              <p class="message-body">${escapeHtml(message.body)}</p>
              <form class="message-edit-form"
                data-edit-form-thread="${escapeHtml(thread.id)}"
                data-edit-form-message="${escapeHtml(message.id)}"
                hidden>
                <textarea rows="3">${escapeHtml(message.body)}</textarea>
                <div class="message-edit-actions">
                  <button type="button" class="message-edit-control" data-edit-cancel
                    title="Cancel edit" aria-label="Cancel edit">
                    <svg class="btn-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <path d="M6.5 6.5 17.5 17.5M17.5 6.5 6.5 17.5" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>
                    </svg>
                  </button>
                  <button type="submit" class="message-edit-control confirm" title="Save edit" aria-label="Save edit">
                    <svg class="btn-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <path d="m5 12.5 4.2 4.2L19 6.8" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                  </button>
                </div>
              </form>
            </div>
          `,
        )
        .join("");

      return `
        <article class="thread-card ${active ? "active" : ""} ${anchorMissing ? "unanchored" : ""}" data-thread-id="${escapeHtml(thread.id)}">
          ${
            anchorMissing
              ? `<div class="anchor-warning">Anchor text changed. Thread kept until resolved.</div>`
              : ""
          }
          ${messages}
          <div class="thread-foot">
            ${
              canEditLastMessage && lastMessage
                ? `
                  <button type="button" class="icon-action"
                    data-edit-thread="${escapeHtml(thread.id)}"
                    data-edit-message="${escapeHtml(lastMessage.id)}"
                    title="Edit comment" aria-label="Edit comment">
                    <svg class="btn-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <path d="M14.5 5.5 18.5 9.5 8.5 19.5 4 20.5 5 16z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
                      <path d="M13 7 17 11" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
                    </svg>
                  </button>
                `
                : ""
            }
            <button type="button" class="icon-action" data-reply-toggle="${escapeHtml(thread.id)}" title="Reply" aria-label="Reply">
              <svg class="btn-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M9.5 7 5 11.5 9.5 16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
                <path d="M5 11.5h8.5a5 5 0 0 1 5 5V18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </button>
            <button type="button" class="icon-action danger" data-resolve-thread="${escapeHtml(thread.id)}" title="Delete comment" aria-label="Delete comment">
              <svg class="btn-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M5 7h14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
                <path d="M9.5 7V5.6a1.1 1.1 0 0 1 1.1-1.1h2.8a1.1 1.1 0 0 1 1.1 1.1V7" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
                <path d="M6.7 7.5 7.6 18.6A1.4 1.4 0 0 0 9 20h6a1.4 1.4 0 0 0 1.4-1.4L17.3 7.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </button>
          </div>
          <form class="reply-form" data-reply-form="${escapeHtml(thread.id)}" hidden>
            <textarea rows="2" placeholder="Reply&#8230;"></textarea>
            <div class="thread-actions">
              <button type="submit" class="icon-action primary" title="Send reply" aria-label="Send reply">
                <svg class="btn-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M4.5 11.5 19 5l-6 14-2.6-5.4z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
                  <path d="m10.4 13.6 4.2-4.2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
                </svg>
              </button>
            </div>
          </form>
        </article>
      `;
    })
    .join("");

  layoutRail();
}

// Reveal a thread's reply box (hidden by default to keep cards compact), focus
// it, and make that thread active.
function openReplyForThread(threadId) {
  closeMessageEditForms();
  const card = threadsEl.querySelector(`.thread-card[data-thread-id="${cssEscape(threadId)}"]`);
  const form = card?.querySelector(".reply-form");
  if (!form) return;
  form.hidden = false;
  activateThreadWithoutRender(threadId);
  layoutRail();
  form.querySelector("textarea")?.focus();
}

function openMessageEditForm(threadId, messageId) {
  closeMessageEditForms();
  closeEmptyReplyForms({ ignoreFocus: true });

  const card = threadsEl.querySelector(`.thread-card[data-thread-id="${cssEscape(threadId)}"]`);
  const message = card?.querySelector(`.message[data-message-id="${cssEscape(messageId)}"]`);
  const form = message?.querySelector(".message-edit-form");
  const body = message?.querySelector(".message-body");
  if (!(form instanceof HTMLFormElement) || !(body instanceof HTMLElement)) return;

  form.hidden = false;
  body.hidden = true;
  card.classList.add("editing-message");
  activateThreadWithoutRender(threadId);
  layoutRail();

  const textarea = form.querySelector("textarea");
  textarea?.focus();
  textarea?.select();
}

function closeMessageEditForms() {
  for (const form of threadsEl.querySelectorAll(".message-edit-form")) {
    if (form instanceof HTMLFormElement) closeMessageEditForm(form);
  }
}

function closeMessageEditForm(form) {
  const card = form.closest(".thread-card");
  const message = form.closest(".message");
  const body = message?.querySelector(".message-body");
  const input = form.querySelector("textarea");
  if (input && body) {
    input.value = body.textContent ?? "";
  }
  if (body instanceof HTMLElement) {
    body.hidden = false;
  }
  form.hidden = true;
  card?.classList.remove("editing-message");
  layoutRail();
}

async function submitMessageEditForm(form) {
  const threadId = form.getAttribute("data-edit-form-thread");
  const messageId = form.getAttribute("data-edit-form-message");
  const input = form.querySelector("textarea");
  const body = input?.value.trim() ?? "";
  if (!threadId || !messageId) return;
  if (!body) {
    showNotice("Edit failed", "A comment cannot be empty.");
    input?.focus();
    return;
  }

  const endLocalMutation = beginLocalMutation();
  try {
    const response = await fetch(
      `/api/comments/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      },
    );

    if (!response.ok) {
      const payload = await readJsonPayload(response);
      showNotice("Edit failed", payload.error || "Redline could not save this comment edit.");
      updateToolbar();
      return;
    }

    state = await response.json();
    activeThreadId = threadId;
    render({ preserveFrame: true });
  } finally {
    endLocalMutation();
  }
}

function closeEmptyReplyForms({ ignoreFocus = false } = {}) {
  for (const form of threadsEl.querySelectorAll(".reply-form")) {
    closeReplyFormIfEmpty(form, { ignoreFocus });
  }
}

function closeReplyFormIfEmpty(form, { ignoreFocus = false } = {}) {
  if (form.hidden) return;
  if (!ignoreFocus && form.contains(document.activeElement)) return;
  const input = form.querySelector("textarea");
  if (input?.value.trim()) return;
  closeReplyForm(form);
}

function closeReplyForm(form) {
  const input = form.querySelector("textarea");
  if (input) input.value = "";
  form.hidden = true;
  layoutRail();
}

function deselectThreadIfOutsideComment(target) {
  if (target?.closest?.(".thread-card")) return;
  deselectThread();
}

function handleFrameClick(event) {
  closeEmptyReplyForms({ ignoreFocus: true });

  const target = event.target;
  if (!(target instanceof frame.contentWindow.Element)) return;

  if (handleFrameHashLinkClick(event, target)) return;

  const highlight = target.closest(".redline-highlight, .coauthor-highlight");
  // Clicking the anchored text springs its card into place without scrolling
  // (you're already looking at the anchor). Clicking anywhere else in the
  // document drops the comment back to its resting, inactive state.
  if (!highlight) {
    deselectThread();
    return;
  }
  const threadId = highlight.getAttribute("data-thread-id");
  if (threadId) selectThread(threadId, true);
}

function handleFrameHashLinkClick(event, target) {
  const link = target.closest("a[href]");
  const rawHref = link?.getAttribute("href");
  if (!rawHref?.startsWith("#")) return false;

  event.preventDefault();
  if (rawHref === "#") {
    frame.contentWindow?.scrollTo({ top: 0, behavior: "smooth" });
    return true;
  }

  const doc = frame.contentDocument;
  const id = decodeHashFragment(rawHref.slice(1));
  const destination =
    (id ? doc?.getElementById(id) : null) ??
    (id ? doc?.getElementsByName(id)[0] : null);
  destination?.scrollIntoView({ block: "start", behavior: "smooth" });
  return true;
}

function decodeHashFragment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function deselectThread() {
  frameScrollGuard.cancel();
  if (!activeThreadId) return;
  activeThreadId = null;
  for (const card of threadsEl.querySelectorAll(".thread-card.active")) {
    card.classList.remove("active");
  }
  syncHighlightSelection();
  layoutRail();
}

function selectThread(threadId, keepFocus = false) {
  railAutoFollowPaused = false;
  activateThreadWithoutRender(threadId);
  layoutRail();
  revealThreadCardInRailSoon(threadId, { behavior: "smooth" });
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
  const endLocalMutation = beginLocalMutation();
  try {
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
    removeThreadFromFrame(threadId);
    if (activeThreadId === threadId) activeThreadId = null;
    render({ preserveFrame: true });
  } finally {
    endLocalMutation();
  }
}

async function deleteReply(threadId, messageId) {
  const endLocalMutation = beginLocalMutation();
  try {
    const response = await fetch(
      `/api/comments/${encodeURIComponent(threadId)}/replies/${encodeURIComponent(messageId)}`,
      { method: "DELETE" },
    );

    if (!response.ok) {
      const payload = await readJsonPayload(response);
      showNotice("Reply delete failed", payload.error || "Redline could not delete this reply.");
      updateToolbar();
      return;
    }

    state = await response.json();
    activeThreadId = threadId;
    render({ preserveFrame: true });
  } finally {
    endLocalMutation();
  }
}

function removeThreadFromFrame(threadId) {
  const doc = frame.contentDocument;
  if (!doc?.body) return;

  const escapedThreadId = attributeValue(threadId);
  const selector = [
    `.redline-highlight[data-thread-id="${escapedThreadId}"]`,
    `.coauthor-highlight[data-thread-id="${escapedThreadId}"]`,
    `[data-redline-anchor="${escapedThreadId}"]`,
    `[data-coauthor-anchor="${escapedThreadId}"]`,
  ].join(",");

  for (const element of doc.querySelectorAll(selector)) {
    if (element.isConnected) {
      unwrapElement(element);
    }
  }
  anchoredThreadIds.delete(threadId);
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
  const contextual = findContextualRange(text, quote, anchor.prefix, anchor.suffix);
  if (contextual) return contextual;

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

function findContextualRange(text, quote, prefix = "", suffix = "") {
  if (!prefix && !suffix) return null;
  const matches = [];
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

  return matches.length === 1 ? matches[0] : null;
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
  if (!anchor) return;

  openAncestorDetails(anchor);
  frameScrollGuard.begin(threadId);
  anchor.scrollIntoView({ block: "center", behavior: "smooth" });
}

function updateToolbar() {
  editButton.querySelector(".btn-label").textContent = editMode ? "Editing" : "Edit";
  editButton.classList.toggle("active", editMode);

  // The save indicator is only meaningful for document edits: show it while
  // editing, mid-save, with unsaved changes, or on a conflict. When you're just
  // reading, hide it so it doesn't read as a status of the author field.
  saveStatusEl.hidden = !(editMode || dirty || saving || blockedRemoteUpdate);

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
