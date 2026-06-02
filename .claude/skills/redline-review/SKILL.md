---
name: redline-review
description: Work with Redline for reviewing AI-authored HTML documents. Use when the user asks to use Redline, asks an agent to review or revise a document it wrote, needs browser-visible comments, replies, reply deletes, or resolves, or when reading, preserving, adding, replying to, resolving, or acting on Redline comments with inline data-redline-anchor spans and embedded thread state.
---

# Redline Review

Redline documents are ordinary HTML files with open review state embedded inside the file. Treat comments as user-authored review data and preserve them while editing.

## When To Use

Use this skill when:

- The user asks to use Redline.
- The user asks an agent to review, revise, or respond to feedback on an HTML document the agent wrote.
- The task involves browser-visible comments, replies, reply deletes, resolves, or review threads on HTML.
- An HTML file already contains Redline state:

```html
<script type="application/json" id="redline-state">...</script>
```

or:

```html
<span data-redline-anchor="thread_abc123">reviewed text</span>
```

If the local server is running, `.redline/server.json` contains the current URL and document path.

## Read Feedback

Prefer the compact comments helper when available:

```bash
bun src/agent.ts comments <document.html>
```

With a running server, read comments without loading the full HTML:

```text
GET /api/agent/comments
```

The returned state includes `documentPath`, `threads`, `version`, and `summary`, but not `html`. Each thread has an `id`, `anchor`, `quote`, and `messages`. Message ids are durable; the first message is the original comment, and later messages are replies.

When an agent needs to inspect or edit the document content, get the current file path and read the file from disk:

```bash
bun src/agent.ts file <document.html>
```

With a running server:

```text
GET /api/agent/file
```

`file` returns the current `documentPath`, version, update time, and summary without returning HTML. `state` and `GET /api/agent/state` remain available for compatibility and full-document workflows, but avoid them for comment-only work because large HTML can waste context.

## Preserve Anchors

Inline anchors are the durable location of a comment:

```html
<span data-redline-anchor="thread_abc123">reviewed text</span>
```

Rules:

- Do not delete a `data-redline-anchor` span unless explicitly resolving that thread.
- When rewriting anchored text, preserve or move the span so it still wraps the relevant revised text.
- Keep `thread.id`, `thread.anchor.anchorId`, and `data-redline-anchor` aligned when possible.
- Do not add runtime classes such as `redline-highlight`; the app adds those while rendering.
- If an anchor disappears, Redline may fall back to quote matching, but the thread should remain open until resolved.

### How anchoring resolves in the browser

A thread highlights in two ways, and you can rely on either:

- **Persisted span.** If the HTML contains `<span data-redline-anchor="thread_id">…</span>`, the highlight is durable: it survives edits that move surrounding text, because the location is stored in the file.
- **Quote match.** If there is no span, the browser re-anchors at render time by matching `anchor.textPosition` first, then `anchor.prefix`/`anchor.suffix` context, and then `anchor.quote` against the document text. The highlight appears in the browser but is *not* written back to the file.

So a comment created with a unique quote, or with a quote plus `textPosition`, will still show up highlighted; you do not have to hand-wrap a span for the comment to be visible. Hand-wrap a span only when you want the anchor to stay put across later text edits. The comment helpers (`comment`, `apply`, `POST /api/comments`) do **not** insert the span for you; they only record the thread.

### Thread and anchor ids

Thread ids and `anchorId` values must match `^thread_[A-Za-z0-9_-]{1,128}$` — they must start with `thread_`. The CLI validates explicit ids. Lower-level state/API paths normalize invalid ids, which can break alignment with a span you wrote by hand. Always prefix your ids with `thread_`.

## Comments, Replies, And Deletes

Reply after making a relevant change:

```bash
bun src/agent.ts reply <document.html> <thread-id> "I revised this section." --author AI
```

Delete one reply, and only that reply, by message id:

```bash
bun src/agent.ts delete-reply <document.html> <thread-id> <message-id>
```

Only delete messages after the first message in a thread. The first message is the original comment; deleting it means resolving/deleting the whole thread instead.

Resolve or delete a whole thread only when the requested work is done or the user asks:

```bash
bun src/agent.ts resolve <document.html> <thread-id>
```

`resolve` removes the thread from `#redline-state` and unwraps its inline anchor. In the browser UI, the thread delete button performs this same resolve operation.

With a running server, agents may use the equivalent HTTP endpoints:

```text
POST /api/comments                                   # create a comment (body: CreateCommentInput)
POST /api/comments/<thread-id>/replies
DELETE /api/comments/<thread-id>/replies/<message-id>
POST /api/comments/<thread-id>/resolve
DELETE /api/comments/<thread-id>
POST /api/agent/update                               # server twin of `apply` (body: AgentUpdateInput)
```

Note: the reply endpoint defaults the author to `User`, not `AI`, so pass `"author": "AI"` explicitly in the JSON body when an agent replies. The CLI `reply`/`comment` commands already default to `AI`.

Use `.redline/server.json` to find the current server URL and document path.

## Revise HTML

Agents may edit the HTML file directly. When doing so:

- Keep the `#redline-state` JSON script unless every thread is resolved.
- Preserve all unresolved `data-redline-anchor` spans.
- If replacing the whole document, carry over unresolved anchors and the embedded state, or use:

```bash
bun src/agent.ts apply <document.html> <payload.json>
```

Payloads may include:

```json
{
  "html": "<!doctype html>...",
  "comments": [
    {
      "body": "This claim needs a source.",
      "author": "AI",
      "quote": "growth improved by 40%",
      "anchor": {
        "type": "text-range",
        "anchorId": "thread_source_needed",
        "quote": "growth improved by 40%"
      }
    }
  ],
  "replies": [{ "threadId": "thread_abc123", "body": "Updated.", "author": "AI" }],
  "resolveThreadIds": ["thread_done456"]
}
```

## Add A Comment

Prefer the helper command. It creates a new top-level anchored comment thread, defaults the author to `AI`, and enforces the id rules:

```bash
bun src/agent.ts comment <document.html> "<exact quoted text>" "Your comment." [--occurrence N] --author AI
```

The quote must be one shell argument (wrap it in quotes); everything after it is the comment body. This command creates the first message in a new thread; use `reply` only when responding inside an existing thread. Pass `--thread-id thread_xyz` to choose the id (it must start with `thread_`); otherwise one is generated. The quote should match the rendered document text exactly so the browser can highlight it.

If the same quote appears multiple times, the helper rejects the command unless you pass `--occurrence N`, where `N` is the 1-based occurrence in document order:

```bash
bun src/agent.ts comment <document.html> "growth improved by 40%" "This second claim needs a source." --occurrence 2 --author AI
```

The helper records the selected occurrence's `textPosition`, `prefix`, and `suffix`. That gives the browser a specific target instead of relying on a first quote match.

On a running server, the equivalent is `POST /api/comments` with a `CreateCommentInput` body, or `bun src/agent.ts apply` / `POST /api/agent/update` with a `comments` entry when batching with replies or an HTML revision.

For direct HTML editing, choose a unique `thread_`-prefixed id, wrap the exact target text in a span, and add a matching thread entry. Use manual embedded-state editing only when a helper/API path is not enough.

HTML:

```html
<span data-redline-anchor="thread_source_needed">growth improved by 40%</span>
```

Embedded state:

```json
{
  "id": "thread_source_needed",
  "anchor": {
    "type": "text-range",
    "anchorId": "thread_source_needed",
    "quote": "growth improved by 40%"
  },
  "quote": "growth improved by 40%",
  "author": "AI",
  "createdAt": "2026-06-02T12:00:00.000Z",
  "updatedAt": "2026-06-02T12:00:00.000Z",
  "messages": [
    {
      "id": "message_source_needed",
      "author": "AI",
      "body": "This claim needs a source.",
      "createdAt": "2026-06-02T12:00:00.000Z"
    }
  ]
}
```

If editing embedded state by hand and the same quote appears multiple times, do not rely on quote text alone. Insert the span around the specific occurrence in the HTML, or include `textPosition` plus `prefix` and `suffix` in `anchor` for fallback matching.

Inside `#redline-state`, escape `<` in JSON strings as `\u003c` to avoid breaking the HTML script tag.
