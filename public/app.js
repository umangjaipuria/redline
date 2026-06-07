import {
  collectThreadLiveOrderFromAnchors,
  commentNavigationState,
  commentNavigationTarget,
  createProgrammaticScrollGuard,
  findQuoteMatches,
  openAncestorDetails,
  removeRuntimeOpenedDetails,
  sortThreadsForRail,
  stackedRailItemLayout,
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
const commentControls = document.querySelector("#commentControls");
const previousCommentButton = document.querySelector("#previousCommentButton");
const nextCommentButton = document.querySelector("#nextCommentButton");
const openButton = document.querySelector("#openButton");
const selectionFab = document.querySelector("#selectionFab");
const selectionAlert = document.querySelector("#selectionAlert");
const selectionAlertClose = document.querySelector("#selectionAlertClose");
const emptyState = document.querySelector("#emptyState");
const emptyOpenButton = document.querySelector("#emptyOpenButton");
const howtoHint = document.querySelector("#howtoHint");
const howtoLink = document.querySelector("#howtoLink");

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
let frameViewportFrame = null;
let pendingFrameRevealThreadId = null;
let frameViewportCleanup = null;
let fabTimer = null;
let pointerSelectionActive = false;
let localMutationDepth = 0;
let railRevealFrame = null;
let railRevealTimer = null;
let railScrollFrame = null;
let railScrollToken = 0;

const RAIL_EDGE_PADDING = 16;
const RAIL_CARD_GAP = 12;

const frameScrollGuard = createProgrammaticScrollGuard({
  onRestore: (threadId) => {
    if (activeThreadId !== threadId) {
      activateThreadWithoutRender(threadId);
    }
    syncFrameViewport();
    revealThreadCardInRail(threadId);
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
previousCommentButton.addEventListener("click", () => jumpComment("previous"));
nextCommentButton.addEventListener("click", () => jumpComment("next"));

openButton.addEventListener("click", () => void openViaDialog());
emptyOpenButton.addEventListener("click", () => void openViaDialog());
howtoLink.addEventListener("click", (event) => {
  event.preventDefault();
  void openPath(state?.howtoPath);
});
selectionFab.addEventListener("mousedown", (event) => event.preventDefault());
selectionFab.addEventListener("click", () => {
  beginCommentFromSelection();
});
selectionAlert.addEventListener("click", (event) => {
  if (event.target === selectionAlert) hideSelectionAlert();
});
selectionAlertClose.addEventListener("click", hideSelectionAlert);
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
    revealThreadCardInRailSoon(threadId, { behavior: "smooth" });
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
  if (event.key === "Escape" && !selectionAlert.hidden) {
    event.preventDefault();
    hideSelectionAlert();
    return;
  }

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
  if (state.noDocument) {
    renderEmptyState();
    return;
  }
  appShell.dataset.empty = "false";
  emptyState.hidden = true;
  frame.hidden = false;
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

// Shown when the server has no document open: the document pane is replaced by
// the "open a file" panel, and the how-to link appears only when the bundled
// guide exists.
function renderEmptyState() {
  appShell.dataset.empty = "true";
  frame.hidden = true;
  emptyState.hidden = false;
  documentPathEl.textContent = "";
  composer.hidden = true;
  threadsEl.replaceChildren();
  activeThreadId = null;
  pendingSelection = null;
  hideSelectionFab();
  hideNotice();
  howtoHint.hidden = !state.howtoPath;
  updateRail();
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
  commentControls.hidden = threadCount === 0;
  railToggle.hidden = threadCount === 0;
  railToggle.setAttribute("aria-pressed", open ? "true" : "false");
  railToggle.classList.toggle("active", open);
  railToggle.title = open ? "Hide comments" : "Show comments";
  railToggleCount.textContent = String(threadCount);
  updateCommentNavigation();
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
  applyOpenedDocument(data);
}

// Open a specific file by path (used by the how-to link in the empty state).
// The same guards as the dialog apply: never drop unsaved edits.
async function openPath(targetPath) {
  if (!targetPath) return;
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
  let response;
  try {
    response = await fetch("/api/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: targetPath }),
    });
  } catch {
    showNotice("Open failed", "Redline could not reach the local server.");
    return;
  }
  if (!response.ok) {
    const payload = await readJsonPayload(response);
    showNotice("Open failed", payload.error || "That file could not be opened.");
    return;
  }
  applyOpenedDocument(await response.json());
}

function applyOpenedDocument(data) {
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
  cancelFrameViewportSync();
  cancelRailScrollAnimation();
  frameResizeObserver?.disconnect();
  frameResizeObserver = null;
}

function syncFrameViewport() {
  layoutRail();
  repositionSelectionFab();
}

function scheduleFrameViewportSync({ revealThreadId = null } = {}) {
  if (revealThreadId) {
    pendingFrameRevealThreadId = revealThreadId;
  }
  if (frameViewportFrame !== null) return;

  frameViewportFrame = requestAnimationFrame(() => {
    frameViewportFrame = null;
    const revealThreadId = pendingFrameRevealThreadId;
    pendingFrameRevealThreadId = null;
    syncFrameViewport();
    if (revealThreadId && activeThreadId === revealThreadId) {
      revealThreadCardInRail(revealThreadId);
    }
  });
}

function cancelFrameViewportSync() {
  if (frameViewportFrame !== null) {
    cancelAnimationFrame(frameViewportFrame);
    frameViewportFrame = null;
  }
  pendingFrameRevealThreadId = null;
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
      scheduleFrameViewportSync({ revealThreadId: activeThreadId });
      return;
    }
    syncFrameViewport();
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
  parsed.querySelector("#redline-runtime-style")?.remove();
  parsed.querySelector("#redline-state")?.remove();

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
  clone.querySelector("#redline-runtime-style")?.remove();

  for (const node of clone.querySelectorAll(".redline-highlight")) {
    if (node.hasAttribute("data-redline-anchor")) {
      node.classList.remove("redline-highlight", "redline-active");
      node.removeAttribute("data-thread-id");
    } else {
      node.replaceWith(...node.childNodes);
    }
  }

  for (const node of clone.querySelectorAll("[data-redline-anchor]")) {
    node.classList.remove("redline-highlight", "redline-active");
    node.removeAttribute("data-thread-id");
  }

  const body = clone.querySelector("body");
  body?.removeAttribute("contenteditable");
  body?.removeAttribute("spellcheck");
  body?.classList.remove("redline-edit-mode");

  for (const element of clone.querySelectorAll(".redline-editable-text")) {
    element.classList.remove("redline-editable-text");
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
      const highlight = element?.closest?.(".redline-highlight");
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

  // Count against the same text basis the server uses: body text with
  // <script>/<style> excluded (see collectAnchorText / locateTextOffset).
  const fullText = collectAnchorText(doc.body);
  const start = anchorTextOffsetAt(doc.body, range.startContainer, range.startOffset);

  // Only record an occurrence when the quote repeats. A unique quote needs none,
  // and omitting it means that if the text later duplicates and the span is lost,
  // the thread orphans honestly instead of silently re-anchoring to the first copy.
  const matches = findQuoteMatches(fullText, quote);
  const anchor = { type: "text-range", quote };
  if (matches.length > 1) {
    let occurrence = 1;
    for (const match of matches) {
      if (match.start >= start) break;
      occurrence += 1;
    }
    anchor.occurrence = occurrence;
  }

  pendingSelection = {
    quote,
    range: range.cloneRange(),
    anchor,
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
    if (pendingSelection) {
      showNotice(
        "Selection changed",
        "Select the text again before adding a comment.",
      );
    }
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
  requestAnimationFrame(layoutRail);
  commentBody.focus({ preventScroll: true });
}

// ---------- Comment rail viewport sync ----------
//
// Thread cards stay in document order in the independently scrollable rail.
// As the iframe scrolls, the rail passively repositions cards toward their
// anchors. Explicit clicks choose which pair gets active-state priority.
function layoutRail() {
  if (!commentRailInner) return;
  const railScrollTop = commentRail.scrollTop;
  commentRailInner.style.height = "";
  commentRailInner.classList.remove("rail-aligned");
  threadsEl.style.height = "";
  composer.style.top = "";
  composer.classList.remove("composer-floating");
  for (const card of threadsEl.querySelectorAll(".thread-card")) {
    card.style.top = "";
  }
  if (!shouldFloatRailItems()) return;

  const doc = frame.contentDocument;
  if (!doc?.body) return;

  const frameRect = frame.getBoundingClientRect();
  const railRect = commentRail.getBoundingClientRect();
  if (railRect.width <= 0 || railRect.height <= 0) return;

  const layoutItems = railLayoutItems(doc, frameRect);
  if (layoutItems.length === 0) return;

  commentRailInner.classList.add("rail-aligned");
  const priorityThreadId = composer.hidden === false ? pendingSelection?.threadId : activeThreadId;
  const layout = stackedRailItemLayout({
    activeId: priorityThreadId,
    edgePadding: RAIL_EDGE_PADDING,
    gap: RAIL_CARD_GAP,
    items: layoutItems.map((item) => ({
      id: item.id,
      height: item.element.offsetHeight,
      targetViewportTop: item.targetViewportTop,
    })),
    railScrollTop,
    railViewportHeight: commentRail.clientHeight,
    railViewportTop: railRect.top,
  });

  for (const item of layoutItems) {
    const top = layout.positions.get(item.id);
    if (Number.isFinite(top)) {
      item.element.style.top = `${Math.round(top)}px`;
    }
  }

  const minHeight = Math.max(commentRail.clientHeight, layout.contentHeight);
  if (minHeight > 0) {
    commentRailInner.style.height = `${Math.ceil(minHeight)}px`;
  }
  restoreRailScrollTop(railScrollTop);
}

function restoreRailScrollTop(scrollTop) {
  if (!Number.isFinite(scrollTop)) return;
  const maxTop = Math.max(0, commentRail.scrollHeight - commentRail.clientHeight);
  const nextTop = Math.max(0, Math.min(maxTop, scrollTop));
  if (Math.abs(commentRail.scrollTop - nextTop) >= 1) {
    commentRail.scrollTop = nextTop;
  }
}

function railLayoutItems(doc, frameRect) {
  const items = [];
  const liveOrder = threadLiveOrder();

  if (composer.hidden === false && pendingSelection?.threadId) {
    const targetViewportTop = targetViewportTopForThread(pendingSelection.threadId, doc, frameRect);
    if (Number.isFinite(targetViewportTop)) {
      composer.classList.add("composer-floating");
      items.push({
        element: composer,
        fallbackOrder: -1,
        id: pendingSelection.threadId,
        order: liveOrder.get(pendingSelection.threadId),
        targetViewportTop,
      });
    }
  }

  Array.from(threadsEl.querySelectorAll(".thread-card[data-thread-id]")).forEach((card, index) => {
    if (!(card instanceof HTMLElement)) return;
    const id = card.getAttribute("data-thread-id");
    if (!id) return;
    items.push({
      element: card,
      fallbackOrder: index,
      id,
      order: liveOrder.get(id),
      targetViewportTop: targetViewportTopForThread(id, doc, frameRect),
    });
  });

  return items.sort((left, right) => {
    const leftOrder = Number.isFinite(left.order) ? left.order : Number.MAX_SAFE_INTEGER;
    const rightOrder = Number.isFinite(right.order) ? right.order : Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder || left.fallbackOrder - right.fallbackOrder;
  });
}

function targetViewportTopForThread(threadId, doc, frameRect) {
  const metric = anchorViewportMetric(threadId, doc);
  return metric ? frameRect.top + metric.top : null;
}

function shouldFloatRailItems() {
  return window.matchMedia("(min-width: 941px)").matches && getComputedStyle(commentRail).overflowY !== "visible";
}

function anchorViewportMetric(threadId, doc) {
  const escapedThreadId = cssEscape(threadId);
  const anchors = doc.querySelectorAll(
    `.redline-highlight[data-thread-id="${escapedThreadId}"]`,
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

  if (behavior === "smooth") {
    animateRailScrollTo(nextTop);
  } else {
    cancelRailScrollAnimation();
    commentRail.scrollTo({ top: nextTop, behavior: "auto" });
  }
}

function animateRailScrollTo(targetTop) {
  cancelRailScrollAnimation();
  const startTop = commentRail.scrollTop;
  const distance = targetTop - startTop;
  if (Math.abs(distance) < 1) return;

  const duration = 420;
  const token = ++railScrollToken;
  let startedAt = null;

  const step = (timestamp) => {
    if (token !== railScrollToken) return;
    startedAt ??= timestamp;
    const progress = Math.min(1, (timestamp - startedAt) / duration);
    const eased = 1 - Math.pow(1 - progress, 3);
    commentRail.scrollTop = startTop + distance * eased;
    if (progress < 1) {
      railScrollFrame = requestAnimationFrame(step);
      return;
    }
    railScrollFrame = null;
  };

  railScrollFrame = requestAnimationFrame(step);
}

function cancelRailScrollAnimation() {
  railScrollToken += 1;
  if (railScrollFrame !== null) {
    cancelAnimationFrame(railScrollFrame);
    railScrollFrame = null;
  }
}

function revealThreadCardInRailSoon(threadId, options = {}) {
  revealThreadCardInRail(threadId, options);
  cancelRailReveal();
  railRevealFrame = requestAnimationFrame(() => {
    railRevealFrame = null;
    revealThreadCardInRail(threadId, options);
  });
  railRevealTimer = setTimeout(() => {
    revealThreadCardInRail(threadId, options);
  }, 140);
}

function cancelRailReveal() {
  cancelRailScrollAnimation();
  if (railRevealFrame != null) {
    cancelAnimationFrame(railRevealFrame);
    railRevealFrame = null;
  }
  clearTimeout(railRevealTimer);
  railRevealTimer = null;
}

function closeComposer({ discardDraft = false } = {}) {
  if (discardDraft && pendingSelection?.threadId) {
    removeInlineAnchorFromFrame(pendingSelection.threadId);
    pendingSelection = null;
  }
  composer.hidden = true;
  composer.style.top = "";
  composer.classList.remove("composer-floating");
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
  pendingSelection.threadId = threadId;

  if (insertHighlightSpan(doc, range, threadId, { persistent: true })) {
    pendingSelection.anchor = {
      ...pendingSelection.anchor,
      anchorId: threadId,
    };
    anchoredThreadIds.add(threadId);
    syncHighlightSelection();
    return true;
  }

  pendingSelection = null;
  hideSelectionFab();
  showSelectionAlert();
  updateToolbar();
  return false;
}

function removeInlineAnchorFromFrame(threadId) {
  const doc = frame.contentDocument;
  if (!doc) return;
  const anchorValue = attributeValue(threadId);
  for (const element of doc.querySelectorAll(`[data-redline-anchor="${anchorValue}"]`)) {
    unwrapElement(element);
  }
}

function unwrapElement(element) {
  element.replaceWith(...element.childNodes);
}

function getStoredAuthorName() {
  const stored = localStorage.getItem("redline.authorName");
  if (stored) {
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

function sortedThreadIds() {
  return sortedThreads().map((thread) => thread.id);
}

function jumpComment(direction) {
  const targetId = commentNavigationTarget(sortedThreadIds(), activeThreadId, direction);
  if (!targetId) {
    updateCommentNavigation();
    return;
  }
  selectThread(targetId);
}

function updateCommentNavigation() {
  const navigation = commentNavigationState(sortedThreadIds(), activeThreadId);
  previousCommentButton.disabled = navigation.previousDisabled;
  nextCommentButton.disabled = navigation.nextDisabled;
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
              ? `
                <p class="thread-detached" role="note">
                  <svg class="detached-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M10.2 13.4 8.4 15.2a3.1 3.1 0 0 1-4.4-4.4l1.8-1.8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
                    <path d="m13.8 10.6 1.8-1.8a3.1 3.1 0 0 1 4.4 4.4l-1.8 1.8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
                    <path d="M8.5 7.2 7.1 5.8M16.9 18.2l-1.4-1.4M5.9 9.6 4 9.1M18.1 14.4l1.9.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
                  </svg>
                  <span>Orphaned <span class="detached-note">&middot; kept until you resolve it</span></span>
                </p>
              `
              : ""
          }
          ${messages}
          <div class="thread-foot">
            <button type="button" class="icon-action" data-reply-toggle="${escapeHtml(thread.id)}" title="Reply" aria-label="Reply">
              <svg class="btn-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M9.5 7 5 11.5 9.5 16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
                <path d="M5 11.5h8.5a5 5 0 0 1 5 5V18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </button>
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
  if (target?.closest?.(".thread-card, .comment-controls")) return;
  deselectThread();
}

function handleFrameClick(event) {
  closeEmptyReplyForms({ ignoreFocus: true });

  const target = event.target;
  if (!(target instanceof frame.contentWindow.Element)) return;

  if (handleFrameHashLinkClick(event, target)) return;

  const highlight = target.closest(".redline-highlight");
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
  updateCommentNavigation();
  layoutRail();
}

function selectThread(threadId, keepFocus = false) {
  activateThreadWithoutRender(threadId);
  if (keepFocus) {
    layoutRail();
    revealThreadCardInRailSoon(threadId, { behavior: "smooth" });
    return;
  }

  cancelRailReveal();
  layoutRail();
  revealThreadCardInRailSoon(threadId, { behavior: "smooth" });
  if (!scrollToThreadAnchor(threadId)) {
    return;
  }
}

function activateThreadWithoutRender(threadId) {
  activeThreadId = threadId;
  for (const card of threadsEl.querySelectorAll(".thread-card[data-thread-id]")) {
    card.classList.toggle("active", card.getAttribute("data-thread-id") === threadId);
  }
  syncHighlightSelection();
  updateCommentNavigation();
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
    `[data-redline-anchor="${escapedThreadId}"]`,
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

  for (const element of doc.body.querySelectorAll("[data-redline-anchor]")) {
    const anchorId = element.getAttribute("data-redline-anchor");
    const thread = anchorId ? threadsByAnchor.get(anchorId) : null;
    if (!thread) continue;
    element.classList.add("redline-highlight");
    element.setAttribute("data-thread-id", thread.id);
    anchoredThreadIds.add(thread.id);
  }

  const anchorText = collectAnchorText(doc.body);
  const ranges = state.threads
    .filter((thread) => !anchoredThreadIds.has(thread.id))
    .map((thread) => ({
      thread,
      range: findRangeForAnchor(anchorText, thread.anchor),
    }))
    .filter((item) => item.range)
    .sort((left, right) => right.range.start - left.range.start);

  for (const item of ranges) {
    if (wrapRange(doc, item.range, item.thread.id)) {
      anchoredThreadIds.add(item.thread.id);
    }
  }
}

function findRangeForAnchor(text, anchor) {
  if (anchor.type !== "text-range") return null;
  const matches = findQuoteMatches(text, anchor.quote ?? "");
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];
  const occurrence = Number.isInteger(anchor.occurrence) ? anchor.occurrence : null;
  if (occurrence === null || occurrence < 1 || occurrence > matches.length) return null;
  return matches[occurrence - 1];
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

const BLOCK_LEVEL_SELECTOR =
  "address,article,aside,blockquote,details,dd,div,dl,dt,fieldset,figcaption," +
  "figure,footer,form,h1,h2,h3,h4,h5,h6,header,hgroup,hr,li,main,nav,ol,p,pre," +
  "section,table,tbody,td,tfoot,th,thead,tr,ul";

// A range can only become a single inline <span> if it stays within inline
// content. extractContents() is destructive and would otherwise split blocks
// into a content-model-invalid `<span><p>…</p><p>…</p></span>`, so check
// non-destructively (cloneContents) first and bail before mutating the DOM.
function rangeCrossesBlock(domRange) {
  return domRange.cloneContents().querySelector(BLOCK_LEVEL_SELECTOR) !== null;
}

function insertHighlightSpan(doc, domRange, threadId, { persistent = false } = {}) {
  if (rangeCrossesBlock(domRange)) return false;

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

// A DOM segment stream that skips <script>/<style> content and inserts virtual
// spaces around block elements. This mirrors state.ts textContentForAnchoring:
// browser selections report whitespace between blocks, and quote matching needs
// the same basis while DOM insertion still maps back to real text nodes.
function makeAnchorTextSegments(root) {
  const segments = [];
  appendAnchorTextSegments(root, root, segments);
  return segments;
}

function appendAnchorTextSegments(node, root, segments) {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.nodeValue ?? "";
    if (text) segments.push({ type: "text", node, text });
    return;
  }

  if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) {
    return;
  }

  const element = node.nodeType === Node.ELEMENT_NODE ? node : null;
  if (element && element !== root && (element.nodeName === "SCRIPT" || element.nodeName === "STYLE")) {
    return;
  }

  const block = element && element !== root && element.matches?.(BLOCK_LEVEL_SELECTOR);
  if (block) segments.push({ type: "boundary", element, side: "start", text: " " });
  for (const child of node.childNodes) appendAnchorTextSegments(child, root, segments);
  if (block) segments.push({ type: "boundary", element, side: "end", text: " " });
}

function collectAnchorText(root) {
  return makeAnchorTextSegments(root)
    .map((segment) => segment.text)
    .join("");
}

// Length of the anchoring text before a DOM point (container, offset), handling
// both text-node and element-node containers (e.g. a selection starting at a
// paragraph boundary).
function anchorTextOffsetAt(root, container, offset) {
  const doc = root.ownerDocument;
  const point = doc.createRange();
  point.setStart(container, offset);
  let total = 0;

  for (const segment of makeAnchorTextSegments(root)) {
    if (segment.type === "text") {
      const node = segment.node;
      if (node === container) {
        return total + Math.min(Math.max(offset, 0), node.nodeValue.length);
      }
      const nodeStart = anchorSegmentRange(doc, segment);
      // If the point is at or before this node's start, it falls in the gap before
      // this node — the accumulated length is the answer.
      if (point.compareBoundaryPoints(Range.START_TO_START, nodeStart) <= 0) {
        return total;
      }
      total += segment.text.length;
      continue;
    }

    const boundary = anchorSegmentRange(doc, segment);
    const relation = point.compareBoundaryPoints(Range.START_TO_START, boundary);
    if (relation < 0 || (relation === 0 && segment.side === "start")) {
      return total;
    }
    total += segment.text.length;
  }

  return total;
}

function locateTextOffset(root, offset) {
  let currentOffset = 0;
  let lastNode = null;
  let lastPoint = null;

  for (const segment of makeAnchorTextSegments(root)) {
    const nextOffset = currentOffset + segment.text.length;
    if (segment.type === "text") {
      const node = segment.node;
      lastNode = node;
      if (offset <= nextOffset) {
        return {
          node,
          offset: Math.max(0, offset - currentOffset),
        };
      }
    } else {
      lastPoint = anchorSegmentPoint(root.ownerDocument, segment);
      if (offset < nextOffset) {
        return lastPoint;
      }
    }
    currentOffset = nextOffset;
  }

  if (lastNode) {
    return { node: lastNode, offset: lastNode.nodeValue.length };
  }
  if (lastPoint) return lastPoint;
  return null;
}

function anchorSegmentRange(doc, segment) {
  const range = doc.createRange();
  if (segment.type === "text") {
    range.setStart(segment.node, 0);
  } else if (segment.side === "start") {
    range.setStartBefore(segment.element);
  } else {
    range.setStartAfter(segment.element);
  }
  return range;
}

function anchorSegmentPoint(doc, segment) {
  const range = anchorSegmentRange(doc, segment);
  return { node: range.startContainer, offset: range.startOffset };
}

function syncHighlightSelection() {
  const doc = frame.contentDocument;
  if (!doc) return;
  for (const item of doc.querySelectorAll(".redline-highlight")) {
    item.classList.toggle("redline-active", item.getAttribute("data-thread-id") === activeThreadId);
  }
}

function scrollToThreadAnchor(threadId) {
  const doc = frame.contentDocument;
  const escapedThreadId = cssEscape(threadId);
  const anchor = doc?.querySelector(
    `.redline-highlight[data-thread-id="${escapedThreadId}"]`,
  );
  if (!anchor) return false;

  openAncestorDetails(anchor);
  frameScrollGuard.begin(threadId);
  anchor.scrollIntoView({ block: "center", behavior: "smooth" });
  return true;
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

function showSelectionAlert() {
  selectionAlert.hidden = false;
  requestAnimationFrame(() => {
    selectionAlertClose.focus({ preventScroll: true });
  });
}

function hideSelectionAlert() {
  selectionAlert.hidden = true;
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
