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

or an agent guide marker:

```html
<meta name="redline-agent-guide" content="...">
```

If a local server is running, look in `~/.local/state/redline/servers/`. Each running server writes one `<pid>.json` file there containing `url`, `documentPath`, `pid`, and `startedAt`. This is a fixed per-user path, so any agent finds it regardless of its working directory. Pick the entry whose `documentPath` matches the file you are reviewing; if only one is present, use it. Ignore any entry whose `pid` is no longer alive (servers delete their file on a clean exit, but a hard kill can leave a stale one). The file is rewritten in place when that server switches documents, so `documentPath` always reflects what it is currently serving.

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

- Redline stamps opened documents with `<meta name="redline-agent-guide" ...>` or a `redline-agent-guide` HTML comment so agents can discover this workflow from the file alone.
- Do not delete a `data-redline-anchor` span unless explicitly resolving that thread.
- When rewriting anchored text, preserve or move the span so it still wraps the relevant revised text.
- Keep `thread.id`, `thread.anchor.anchorId`, and `data-redline-anchor` aligned when possible.
- Do not add runtime classes such as `redline-highlight`; the app adds those while rendering.
- If an anchor disappears, Redline may fall back to quote matching, but the thread should remain open until resolved.
- When you rewrite anchored text, move the anchor with it (see [When threads orphan](#when-threads-orphan-and-how-to-avoid-it)). Otherwise the thread orphans.

### How anchoring resolves in the browser

A thread highlights in two ways, and you can rely on either:

- **Persisted span.** If the HTML contains `<span data-redline-anchor="thread_id">…</span>`, the highlight is durable: it survives edits that move surrounding text, because the location is stored in the file.
- **Quote match.** If there is no span, the browser re-anchors at render time by matching `anchor.quote` against the document text (whitespace-collapsed, case-insensitive). When the quote appears more than once, `anchor.occurrence` (1-based, in document order) selects which instance. The highlight appears in the browser but is *not* written back to the file.

A text-range anchor has exactly two locating fields: `anchor.quote` and an optional `anchor.occurrence`. The comment helpers (`comment`, `apply`, `POST /api/comments`) resolve the quote (plus occurrence) and insert a durable `data-redline-anchor` span. If the quote cannot be resolved to a single location — not found, or repeated with no `occurrence` — the helper **rejects** the command rather than creating a span-less thread. Hand-wrap a span yourself only when the target is inherently unquotable.

### Hidden anchor edge cases

Anchors can live inside native HTML disclosure widgets such as closed `<details>` blocks. In the browser, selecting the thread should temporarily open any closed ancestor `<details>` before scrolling to the anchor; that runtime-opened state is removed before saving so the source document does not gain an unintended `open` attribute.

If a user reports a missing anchor, inspect the HTML for the thread's `data-redline-anchor` first. If the span exists inside a closed `<details>`, the comment is still anchored; the browser just needs to reveal the disclosure. Redline can do this generically for native `<details>`, but not for arbitrary custom accordions, `display:none` regions, or JavaScript-driven panels with document scripts disabled. For those custom hiding patterns, keep the anchor span intact and explain that the document needs a manual or document-specific reveal path.

### When threads orphan (and how to avoid it)

A thread is *orphaned* when Redline can locate it by **neither** its `data-redline-anchor` span **nor** quote matching. In the browser it shows an amber "Orphaned · kept until you resolve it" header and floats free of the document text. This is deliberate: orphaned threads are kept, never auto-deleted, so review feedback is not silently lost. But a floating thread is harder to act on, so avoid creating one.

A thread orphans when you revise the anchored text and the anchor no longer points at it:

- the `data-redline-anchor` span was removed or unwrapped, **and**
- quote matching fails because the rewrite changed the text so it no longer matches `anchor.quote` (or `anchor.occurrence` now points at a different instance).

When you rewrite anchored text, update the anchor along with the text. In order of preference:

1. **Move the span (most durable).** Keep the `data-redline-anchor` span wrapped around the revised text. The span's location is persisted in the file, so it survives any rewording and the thread stays anchored regardless of quote drift. Prefer this whenever a span exists or can be added.
2. **Update the quote (span-less threads).** If the thread relies on quote matching only, edit the thread's `anchor.quote` and top-level `quote` in `#redline-state` to the new text, and update `anchor.occurrence` if the new text repeats. A stale quote is the most common cause of orphaning.
3. **Subject removed entirely.** If the text the comment referred to is gone, reply explaining the change and `resolve` the thread if the feedback is addressed; otherwise leave it open and orphaned for the human to decide.

Do not "fix" an orphaned thread by deleting it unless you are resolving the underlying feedback.

### Thread and anchor ids

Thread ids and `anchorId` values must match `^thread_[A-Za-z0-9_-]{1,128}$` — they must start with `thread_`. The CLI validates explicit ids. Lower-level state/API paths normalize invalid ids, which can break alignment with a span you wrote by hand. Always prefix your ids with `thread_`.

## Comments, Replies, And Deletes

Reply after making a relevant change:

```bash
bun src/agent.ts reply <document.html> <thread-id> "I revised this section." --author Claude
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

Use your actual agent name for `--author` or JSON `author` fields, for example `Claude`. Agent helper and update paths fall back to `AI` when the agent name is blank or omitted. Note: the generic reply endpoint defaults an omitted author to `User`, so pass `"author": "Claude"` explicitly in the JSON body when replying through that endpoint.

Use the `<pid>.json` files in `~/.local/state/redline/servers/` to find a running server's URL and document path (see [When To Use](#when-to-use) for how to pick among them). The directory is fixed and per-user, so it resolves the same way no matter which directory the agent runs in.

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
      "author": "Claude",
      "quote": "growth improved by 40%",
      "anchor": {
        "type": "text-range",
        "anchorId": "thread_source_needed",
        "quote": "growth improved by 40%"
      }
    }
  ],
  "replies": [{ "threadId": "thread_abc123", "body": "Updated.", "author": "Claude" }],
  "resolveThreadIds": ["thread_done456"]
}
```

## Add A Comment

Prefer the helper command. It creates a new top-level anchored comment thread, accepts your agent name with `--author`, falls back to `AI` when the name is blank or omitted, and enforces the id rules:

```bash
bun src/agent.ts comment <document.html> "<exact quoted text>" "Your comment." [--occurrence N] --author Claude
```

The quote must be one shell argument (wrap it in quotes); everything after it is the comment body. This command creates the first message in a new thread; use `reply` only when responding inside an existing thread. Pass `--thread-id thread_xyz` to choose the id (it must start with `thread_`); otherwise one is generated. The quote should match the rendered document text exactly so the browser can highlight it.

If the same quote appears multiple times, the helper rejects the command unless you pass `--occurrence N`, where `N` is the 1-based occurrence in document order:

```bash
bun src/agent.ts comment <document.html> "growth improved by 40%" "This second claim needs a source." --occurrence 2 --author Claude
```

The helper records `anchor.occurrence` and wraps the selected occurrence in a `data-redline-anchor` span in the source HTML.

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
  "author": "Claude",
  "createdAt": "2026-06-02T12:00:00.000Z",
  "updatedAt": "2026-06-02T12:00:00.000Z",
  "messages": [
    {
      "id": "message_source_needed",
      "author": "Claude",
      "body": "This claim needs a source.",
      "createdAt": "2026-06-02T12:00:00.000Z"
    }
  ]
}
```

If editing embedded state by hand and the same quote appears multiple times, do not rely on quote text alone. Insert the span around the specific occurrence in the HTML, or set `anchor.occurrence` (1-based, in document order) for fallback matching.

Inside `#redline-state`, escape `<` in JSON strings as `\u003c` to avoid breaking the HTML script tag.
