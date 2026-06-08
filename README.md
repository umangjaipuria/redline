# Redline

Agents write more and more of our plans, specs, and docs — and increasingly they write them in HTML rather than Markdown, because HTML renders into something a human can actually read, navigate, and react to. (See Thariq Shihipar's ["HTML is the new markdown"](https://x.com/trq212/status/2052811606032269638).)

But giving feedback on those documents is still painful. You read the rendered page, then drop back into a chat window to describe — in prose — which sentence you meant and what's wrong with it. The agent guesses at the mapping, edits, and you scroll back to check. Iterating this way is slow and lossy.

This is a solved problem everywhere else. Every modern word processor lets you select text and leave a comment in the margin. Enter Redline.

Redline is a local app that opens an agent-written HTML document in your browser and lets you comment on it like a Google Doc — select text, leave a note in the margin, reply. Your agent reads those comments, revises the document, and replies inline. The document and all of its open review state live in the same HTML file, so nothing extra to sync.

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

   # Codex
   ln -s "$(pwd)/.agents/skills/redline-review" ~/.agents/skills/redline-review
   ```

   Any other agent can be pointed at this repo's `AGENTS.md`, which carries the same guidance.

5. **Open a document.** Pass any HTML file; Redline serves it and prints a localhost URL to open in your browser. The first run builds the browser UI automatically (a few seconds); after that it starts instantly.

   ```bash
   bun run start docs/howto.html
   ```

   With no path — or a path that isn't an existing HTML file — Redline starts with no document open and prompts you
   to choose one in the browser (the bundled `docs/howto.html` guide is offered as a starting point). Redline
   only reviews files that already exist; it never creates one for you.

   ```bash
   bun run start
   ```

   Use another port when needed:

   ```bash
   bun run start docs/howto.html --port 7332
   ```

   Run `bun run start --help` to see all command-line options.

6. **Leave comments.** Select text in the rendered document, click `Comment` (or press `Cmd+Shift+M`), and write your note. Reply to threads, edit your own messages, or delete a thread once it's handled. In the top bar, set your author name so comments are attributed to you, and show or hide the comments rail. You're the reviewer here — your agent owns the document's text and makes the actual edits; your comments are saved inside the same HTML file.

7. **Ask your agent to review the comments.** Tell Claude (or whichever agent wrote the doc) to review the open comments using the **redline-review** skill. It reads the threads, revises the document, replies to each thread with what changed, and deletes the threads that are fully resolved. The skill tells the agent how to find the running Redline instance on its own; if it can't, just give it the localhost URL the server printed.

8. **Iterate.** Agent edits show up live in the open browser. Read the replies, leave new comments, and go again until the document is right. The agent doesn't watch for new comments on its own, so each time you finish a round of comments, tell it to review them again.

## Building and running

Redline needs only [Bun](https://bun.sh) ≥ 1.3 — no other toolchain. Bun runs the
TypeScript server and CLI directly; the only thing that gets built is the browser
client, which Bun bundles to `dist/`.

```bash
bun install                          # install dependencies (Preact)
bun run start docs/howto.html        # start the review server; prints a localhost URL (default :7331)
```

| Command | What it does |
| --- | --- |
| `bun run build:client` | Bundle the Preact client (`src/client`) to `dist/`. `bun run start` does this automatically on first run; run it by hand to rebuild after changing client code. |
| `bun run start [file] [--port N] [--host H]` | Start the server. With a file it opens that document; with none, the browser prompts you to pick one. **If a Redline server is already running, the file is opened on that server** (one shared server holds many documents) and its URL is printed — pass `--port N` to run a separate server on another port instead. Binds to `127.0.0.1` by default; binding elsewhere needs `REDLINE_ALLOW_REMOTE=1` because the local API is unauthenticated. |
| `bun run dev` | Start the server with `--watch` (auto-restart on server-code changes). The client bundle is not watched — re-run `build:client` after client edits. |
| `bun src/agent/cli.ts <command>` | The `redline` CLI (see [How agents talk to Redline](#how-agents-talk-to-redline)). Run `bun link` once to expose it globally as `redline`. |
| `bun test` | Run the test suite. |
| `bun run check` | Typecheck (`tsc --noEmit`) and run the tests. |
| `bun run build:binary` | Compile a standalone server executable to `./redline` via `bun build --compile`. |

Notes:

- **The client is built automatically.** `bun run start` bundles the UI into `dist/` on first run (it's gitignored), so users never run a build step. **Only if you're editing the client source** (`src/client`) do you rebuild by hand with `build:client` afterward — auto-build fires only when the bundle is missing, not when it's stale, and `bun run dev` watches server code, not the client.
- **`build:binary` is experimental.** It compiles the server into a single executable, but the web client and fonts are not yet embedded in the binary, so the full browser UI still needs `dist/` and `public/` alongside it. The HTTP API and CLI work from the binary as-is. For the complete experience, run from source.
- **Run the CLI** either as `bun src/agent/cli.ts <command>` or, after `bun link`, as `redline <command>`. Every command takes a file path; it routes through a running server automatically when one has the file open, and otherwise edits the file directly.

## How review state lives in the file

Redline keeps the document and all of its open review state in the one HTML file — no database, no sidecar. Comment threads are stored in a single inert JSON block in the `<head>`:

```html
<script type="application/json" id="redline-state">
  { "schemaVersion": 2, "updatedAt": "...", "threads": [ ... ] }
</script>
```

The first time Redline writes to a file it also stamps a one-line discovery marker, so a fresh agent opening the file later knows it's a Redline document and which skill to use:

```html
<meta name="redline-agent-guide" content="Redline review document. Agents: use the redline-review skill; review state is in the #redline-state block.">
```

That block and marker are the **only** bytes Redline writes — the rest of the document stays byte-for-byte what the author wrote. There are no inline anchor markers; highlights are drawn in the browser at view time, not saved to disk. When the last thread is deleted, the block is removed entirely.

Each thread anchors to its target by **selectors** — the exact `quote` plus a little surrounding `prefix`/`suffix` and an approximate position, not a fixed offset. Redline re-resolves every anchor against the current text on each load and render, with a fuzzy fallback, and classifies it as **anchored**, **needs-review** (low-confidence match, flagged), or **orphaned** (no match — kept in the rail with its last-known quote, never dropped). So when the agent rewrites text a comment was on, the comment follows the change automatically; only a wholesale rewrite orphans it, and even then it's surfaced for re-attachment, not lost. Agents never maintain anchors by hand.

The page listens for server events, so updates an agent makes — through the file, the CLI, or the API — appear in the open browser without a reload.

## How agents talk to Redline

Agents work through the `redline-review` skill, which wraps the `redline` CLI. Run it as `redline <command>` (after `bun link`) or, in this repo, as `bun src/agent/cli.ts <command>`. Every command takes a **file path** and resolves it to the running server automatically; with no server running, it edits the file directly. Agents pass their own name with `--author` (for example `Claude` or `Codex`); a blank or omitted author falls back to `AI`.

Read feedback without loading the full HTML:

```bash
redline comments <file>              # compact thread list with anchor state
redline anchors  <file> [--in A:B]   # anchor resolution report: anchored / needs-review / orphaned
redline thread   <file> <thread-id>  # one thread in full
redline info     <file>              # document metadata, no content
```

Write comments:

```bash
redline comment <file> "<quoted text>" "<body>" [--occurrence N] --author Claude
redline reply   <file> <thread-id> "<body>" --author Claude
redline edit-message  <file> <thread-id> <message-id> "<body>"
redline delete-reply  <file> <thread-id> <message-id>
redline delete-thread <file> <thread-id>
```

`delete-thread` removes the thread from the state block — this is what used to be "resolve"; there is no separate kept-resolved state. If the quoted text appears more than once, pass `--occurrence N` (1-based, document order); it's a transient hint, resolved to selectors at capture time and never persisted.

Re-anchor and batch. Most edits re-anchor on their own; you only intervene for what reconcile couldn't place (orphaned / needs-review):

```bash
redline reanchor <file> <thread-id> --quote "<new text>" [--occurrence N]
redline apply    <file> <payload.json>   # one atomic batch of comment/anchor ops
```

The `apply` payload mutates only the state block — there is **no content field** (the agent edits the document directly with its own tools):

```json
{
  "comments": [{ "quote": "growth improved by 40%", "body": "Needs a source.", "author": "Claude" }],
  "replies": [{ "threadId": "thread_abc123", "body": "Updated.", "author": "Claude" }],
  "edits": [{ "threadId": "thread_abc123", "messageId": "message_xyz", "body": "Reworded." }],
  "deleteThreads": ["thread_done456"],
  "deleteReplies": [{ "threadId": "thread_abc123", "messageId": "message_old" }],
  "reanchors": [{ "threadId": "thread_orphan1", "quote": "the new phrasing" }]
}
```

The agent loop: `redline anchors <file>` to see which comments sit where you're about to edit → edit the document directly → `redline anchors <file>` again to read the orphaned / needs-review leftovers → `redline reanchor` (or a batch `apply`) only those.

When the server is running, agents can also use HTTP. Everything is document-scoped under `/api/docs/:docId/`, so resolve the path to a `docId` first (it's an ephemeral session handle — always resolve path → docId, never cache it):

```bash
ID=$(redline docid docs/howto.html)
curl http://127.0.0.1:7331/api/docs/$ID/agent/comments/index
curl http://127.0.0.1:7331/api/docs/$ID/agent/comments/thread_abc123
curl -X POST http://127.0.0.1:7331/api/docs/$ID/agent/update \
  -H 'Content-Type: application/json' -d @payload.json
```

Write endpoints accept an optional `expectedVersion`; a mismatch returns `409` with the current state to rebase from. An unknown `docId` returns `404` — re-resolve by path.

The server registers itself at `~/.local/state/redline/servers/<pid>.json` — a fixed per-user path listing its `url`, `pid`, and the `docId` and `path` of each open document, so any tool or agent can find the running server regardless of its working directory. Each running server gets its own pid-named file (so concurrent servers don't collide) and removes it on a clean exit; stale entries left by a hard kill are pruned by the next server to start.
