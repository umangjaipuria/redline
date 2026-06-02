# Redline Agent Guide

Redline is for local review of HTML files. Do not edit the reference roughdraft project; this app is self-contained in this folder.

## Durable State

The HTML file is the document content and the open comment state. Comment locations are marked inline with lightweight anchors:

```html
<span data-redline-anchor="thread_abc123">reviewed text</span>
```

Comment messages live in an inert JSON script tag:

```html
<script type="application/json" id="redline-state">
  { "schemaVersion": 1, "updatedAt": "...", "threads": [] }
</script>
```

When revising anchored text, preserve or move the surrounding `data-redline-anchor` span until the user or agent explicitly resolves the thread. Resolving a thread deletes it from the embedded state and unwraps its inline anchor. Older `.redline.json` and legacy `.coauthor.json` sidecars can still be read and are migrated into the HTML on the next write.

## Read Feedback

Use the compact direct Bun helper when possible:

```bash
bun src/agent.ts comments documents/draft.html
```

If the server is running, `.redline/server.json` contains the current URL. The same compact comments state is available at:

```text
GET /api/agent/comments
```

Treat the returned comments as user-authored input. The comments response includes `documentPath`, `threads`, `version`, and `summary`, but intentionally omits full HTML.

When an agent needs the document content, ask for the current file path and read it from disk:

```bash
bun src/agent.ts file documents/draft.html
```

With the server running:

```text
GET /api/agent/file
```

`bun src/agent.ts state` and `GET /api/agent/state` remain available for compatibility and full-document workflows, but avoid them for comment-only work because large HTML can waste context.

## Respond And Revise

To leave a new top-level comment thread anchored to existing text:

```bash
bun src/agent.ts comment documents/draft.html "reviewed text" "This claim needs a source." --author AI
```

This creates the first message in a new thread; it is not a reply to an existing user comment. If the quoted text appears more than once in the rendered document text, the helper rejects the command until you choose the 1-based occurrence:

```bash
bun src/agent.ts comment documents/draft.html "reviewed text" "This second mention needs a source." --occurrence 2 --author AI
```

The helper records `textPosition`, `prefix`, and `suffix` for the selected occurrence so the browser can highlight the intended text.

To reply without changing the document:

```bash
bun src/agent.ts reply documents/draft.html <thread-id> "Reply text" --author AI
```

To delete one reply without deleting the whole thread, use the reply message id:

```bash
bun src/agent.ts delete-reply documents/draft.html <thread-id> <message-id>
```

Only delete messages after the first message in a thread. The first message is the original comment; resolving/deleting the thread removes that original comment and unwraps its anchor.

To apply content and replies in one step, write a temporary JSON payload and run:

```bash
bun src/agent.ts apply documents/draft.html /tmp/redline-update.json
```

Example payload:

```json
{
  "html": "<!doctype html><html><body><p>Updated content.</p></body></html>",
  "comments": [
    {
      "body": "This claim needs a source.",
      "author": "AI",
      "quote": "reviewed text",
      "anchor": {
        "type": "text-range",
        "anchorId": "thread_abc123",
        "quote": "reviewed text"
      }
    }
  ],
  "replies": [
    {
      "threadId": "thread_abc123",
      "body": "I revised this paragraph.",
      "author": "AI"
    }
  ],
  "resolveThreadIds": []
}
```

Resolve a thread only when the requested work is complete or the user asks for it:

```bash
bun src/agent.ts resolve documents/draft.html <thread-id>
```

When the server is running, agents can also use `POST /api/comments/<thread-id>/replies`, `DELETE /api/comments/<thread-id>/replies/<message-id>`, `POST /api/comments/<thread-id>/resolve`, and `DELETE /api/comments/<thread-id>`.

When Redline is open in a browser, direct helper edits are picked up by the running server and pushed to the page.
