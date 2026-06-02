---
name: redline-review
description: Work with Redline for reviewing AI-authored HTML documents. Use when the user asks to use Redline, asks an agent to review or revise a document it wrote, needs browser-visible comments/replies/resolves, or when reading, preserving, adding, replying to, resolving, or acting on Redline comments with inline data-redline-anchor spans and embedded thread state.
---

# Redline Review

Redline documents are ordinary HTML files with open review state embedded inside the file. Treat comments as user-authored review data and preserve them while editing.

## When To Use

Use this skill when:

- The user asks to use Redline.
- The user asks an agent to review, revise, or respond to feedback on an HTML document the agent wrote.
- The task involves browser-visible comments, replies, resolves, or review threads on HTML.
- An HTML file already contains Redline state:

```html
<script type="application/json" id="redline-state">...</script>
```

or:

```html
<span data-redline-anchor="thread_abc123">reviewed text</span>
```

If the local server is running, `.redline/server.json` contains the current URL and document path.

## Read State

Prefer the repo helper when available:

```bash
bun src/agent.ts state <document.html>
```

With a running server, read:

```text
GET /api/agent/state
```

The returned state includes `html`, `threads`, `version`, and `summary`. Each thread has an `id`, `anchor`, `quote`, and `messages`.

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

## Reply Or Resolve

Reply after making a relevant change:

```bash
bun src/agent.ts reply <document.html> <thread-id> "I revised this section." --author AI
```

Resolve only when the requested work is done or the user asks:

```bash
bun src/agent.ts resolve <document.html> <thread-id>
```

`resolve` removes the thread from `#redline-state` and unwraps its inline anchor.

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
  "replies": [{ "threadId": "thread_abc123", "body": "Updated.", "author": "AI" }],
  "resolveThreadIds": ["thread_done456"]
}
```

## Add A Comment

For direct HTML editing, choose a unique thread id, wrap the exact target text, and add a matching thread entry.

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

If the same quote appears multiple times, do not rely on quote text alone. Insert the span around the specific occurrence in the HTML, and include `prefix`, `suffix`, or `textPosition` in `anchor` when useful for fallback matching.

Inside `#redline-state`, escape `<` in JSON strings as `\u003c` to avoid breaking the HTML script tag.
