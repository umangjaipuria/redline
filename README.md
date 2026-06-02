# Redline

Redline is a self-contained local app for reviewing AI-written HTML documents in a browser.

It keeps the document and its open review state in one HTML file. Comment locations are marked inline with lightweight anchors:

```html
<span data-redline-anchor="thread_abc123">reviewed text</span>
```

Comment thread messages are stored in an inert JSON script tag:

```html
<script type="application/json" id="redline-state">
  { "schemaVersion": 1, "updatedAt": "...", "threads": [] }
</script>
```

Resolved threads are deleted from that embedded state and their inline anchors are unwrapped. Older `.redline.json` and legacy `.coauthor.json` sidecars can still be read and are migrated into the HTML on the next write.

## Run

```bash
bun run start -- documents/sample.html
```

Then open the printed localhost URL in any browser.

If you omit the document path, Redline creates and opens `documents/sample.html`.

```bash
bun run start
```

Use another port when needed:

```bash
bun run start -- documents/sample.html --port 7332
```

Short form:

```bash
bun run start -- documents/sample.html -p 8099
```

## Browser Workflow

1. Select text in the rendered HTML document.
2. Click `Comment`.
3. Leave a thread, reply to threads, or resolve them.
4. Set your author name in the top bar when you want comments attributed to you.
5. Click `Edit` to directly edit text regions in the browser.
6. Changes autosave back to the original HTML file.

The page listens for server events, so updates made by an agent through the API or the HTML file appear in the open browser.

When an agent rewrites anchored text, it should preserve or move the surrounding `data-redline-anchor` span until the thread is explicitly resolved. If the span disappears, Redline keeps the thread open in the comment rail and tries to fall back to the saved quote.

## Agent Workflow

Read the complete state:

```bash
bun src/agent.ts state documents/sample.html
```

Reply to a comment thread:

```bash
bun src/agent.ts reply documents/sample.html thread_abc123 "I updated this section." --author AI
```

Delete one reply without deleting the whole thread:

```bash
bun src/agent.ts delete-reply documents/sample.html thread_abc123 message_reply456
```

Resolve a completed thread:

```bash
bun src/agent.ts resolve documents/sample.html thread_abc123
```

Apply an HTML update and comment replies together:

```bash
bun src/agent.ts apply documents/sample.html /tmp/redline-update.json
```

Payload shape:

```json
{
  "html": "<!doctype html><html><body><p>Updated document.</p></body></html>",
  "replies": [
    {
      "threadId": "thread_abc123",
      "body": "I made the requested change.",
      "author": "AI"
    }
  ],
  "resolveThreadIds": ["thread_done456"]
}
```

When the server is running, agents can also use HTTP:

```bash
curl http://127.0.0.1:7331/api/agent/state
curl -X DELETE http://127.0.0.1:7331/api/comments/thread_abc123/replies/message_reply456
curl -X POST http://127.0.0.1:7331/api/agent/update \
  -H 'Content-Type: application/json' \
  -d @/tmp/redline-update.json
```

The server writes its current URL and document path to `.redline/server.json`.

## Check

```bash
bun run check
```
