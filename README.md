# Redline

Agents write more and more of our plans, specs, and docs — and increasingly they write them in HTML rather than Markdown, because HTML renders into something a human can actually read, navigate, and react to. (See Thariq Shihipar's ["HTML is the new markdown"](https://x.com/trq212/status/2052811606032269638).)

But giving feedback on those documents is still painful. You read the rendered page, then drop back into a chat window to describe — in prose — which sentence you meant and what's wrong with it. The agent guesses at the mapping, edits, and you scroll back to check. Iterating this way is slow and lossy.

This is a solved problem everywhere else. Every modern word processor lets you select text and leave a comment in the margin. Enter Redline.

Redline is a local app that opens an agent-written HTML document in your browser and lets you comment on it like a Google Doc — select text, leave a note in the margin, reply, resolve. Your agent reads those comments, revises the document, and replies inline. The document and all of its open review state live in the same HTML file, so nothing extra to sync.

![Redline reviewing an HTML document, with comments anchored in the margin](media/screenshot.png)

## Getting started

1. **Clone the repo.**

   ```bash
   git clone <repo-url> redline && cd redline
   ```

2. **Install dependencies** (requires [Bun](https://bun.sh) ≥ 1.3).

   ```bash
   bun install
   ```

3. **Run the tests** to confirm everything works.

   ```bash
   bun run check
   ```

4. **Install the review skill** so your agent knows how to work with Redline documents. Symlink it into your agent's skills directory:

   ```bash
   # Claude Code
   ln -s "$(pwd)/.claude/skills/redline-review" ~/.claude/skills/redline-review
   ```

   For Codex or another agent, point it at this repo's `AGENTS.md`, which carries the same guidance.

5. **Open a document.** Pass any HTML file; Redline serves it and prints a localhost URL to open in your browser.

   ```bash
   bun run start documents/howto.html
   ```

   With no path — or a path that isn't an existing HTML file — Redline starts with no document open and prompts you
   to choose one in the browser (the bundled `documents/howto.html` guide is offered as a starting point). Redline
   only reviews files that already exist; it never creates one for you.

   ```bash
   bun run start
   ```

   Use another port when needed:

   ```bash
   bun run start documents/howto.html --port 7332
   ```

   Run `bun run start --help` to see all command-line options.

6. **Leave comments.** Select text in the rendered document, click `Comment`, and write your note. Reply to threads or edit your comments inline. A few controls in the top bar: change your author name so comments are attributed to you, show or hide the comments rail, and click `Edit` to fix text directly in the page. Inline editing is there for quick touch-ups — Redline assumes most of the writing and revising is done by the agent. Everything autosaves back to the original HTML file.

7. **Ask your agent to review the comments.** Tell Claude (or whichever agent wrote the doc) to review the open comments using the **redline-review** skill. It reads the threads, revises the document, replies to each thread with what changed, and resolves the ones that are done. The skill tells the agent how to find the running Redline instance on its own; if it can't, just give it the localhost URL the server printed.

8. **Iterate.** Agent edits show up live in the open browser. Read the replies, leave new comments, and go again until the document is right. The agent doesn't watch for new comments on its own, so each time you finish a round of comments, tell it to review them again.

## How review state lives in the file

Redline keeps the document and its open review state in one HTML file. Comment locations are marked inline with lightweight anchors:

```html
<span data-redline-anchor="thread_abc123">reviewed text</span>
```

Comment thread messages are stored in an inert JSON script tag:

```html
<script type="application/json" id="redline-state">
  { "schemaVersion": 1, "updatedAt": "...", "threads": [] }
</script>
```

When a document is opened with Redline, the app adds an agent discovery marker so an agent inspecting the file knows to use the Redline review skill:

```html
<meta name="redline-agent-guide" content="...">
```

Resolved threads are deleted from that embedded state and their inline anchors are unwrapped. Older `.redline.json` and legacy `.coauthor.json` sidecars can still be read and are migrated into the HTML on the next write.

When an agent rewrites anchored text, it should preserve or move the surrounding `data-redline-anchor` span until the thread is explicitly resolved. If the span disappears, Redline keeps the thread open in the comment rail and falls back to the saved quote.

The page listens for server events, so updates made by an agent — through the file, the CLI, or the API — appear in the open browser without a reload.

## How agents talk to Redline

Agents work through the `redline-review` skill, which wraps the commands below. They also work directly.
Agents should pass their own name with `--author` or in JSON payloads, for example `Codex` or `Claude`; blank or omitted agent authors fall back to `AI`.

Read comments without loading the full HTML:

```bash
bun src/agent.ts comments documents/howto.html
```

Get the current file path when you need to read or edit the HTML:

```bash
bun src/agent.ts file documents/howto.html
```

Leave a new top-level comment thread anchored to existing text:

```bash
bun src/agent.ts comment documents/howto.html "exact quoted text" "This needs a source." --author Codex
```

If the quoted text appears more than once, choose the 1-based occurrence in document order:

```bash
bun src/agent.ts comment documents/howto.html "exact quoted text" "This second mention needs a source." --occurrence 2 --author Codex
```

Reply to a comment thread:

```bash
bun src/agent.ts reply documents/howto.html thread_abc123 "I updated this section." --author Codex
```

Delete one reply without deleting the whole thread:

```bash
bun src/agent.ts delete-reply documents/howto.html thread_abc123 message_reply456
```

Edit an existing comment or reply:

```bash
bun src/agent.ts edit-comment documents/howto.html thread_abc123 message_reply456 "Revised wording."
```

Resolve a completed thread:

```bash
bun src/agent.ts resolve documents/howto.html thread_abc123
```

Apply an HTML update and comment replies together:

```bash
bun src/agent.ts apply documents/howto.html /tmp/redline-update.json
```

Payload shape:

```json
{
  "html": "<!doctype html><html><body><p>Updated document.</p></body></html>",
  "replies": [
    {
      "threadId": "thread_abc123",
      "body": "I made the requested change.",
      "author": "Codex"
    }
  ],
  "resolveThreadIds": ["thread_done456"]
}
```

When the server is running, agents can also use HTTP:

```bash
curl 'http://127.0.0.1:7331/api/agent/comments/index?since=2026-01-01T00:00:00.000Z'
curl http://127.0.0.1:7331/api/agent/comments/thread_abc123
curl http://127.0.0.1:7331/api/agent/file
curl -X PUT http://127.0.0.1:7331/api/comments/thread_abc123/messages/message_reply456 \
  -H 'Content-Type: application/json' \
  -d '{"body":"Revised wording."}'
curl -X DELETE http://127.0.0.1:7331/api/comments/thread_abc123/replies/message_reply456
curl -X POST http://127.0.0.1:7331/api/agent/update \
  -H 'Content-Type: application/json' \
  -d @/tmp/redline-update.json
```

The server writes its current URL and document path to `~/.local/state/redline/servers/<pid>.json` — a fixed per-user path, so any tool or agent can find the running server regardless of its working directory. Each running server gets its own pid-named file (so concurrent servers don't collide) and removes it on a clean exit; stale entries left by a hard kill are pruned by the next server to start.
