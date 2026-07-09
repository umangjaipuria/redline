# Redline Agent Guide

Redline is for local review of documents (HTML in this version). It is a reviewing-and-commenting tool, not the document owner: **you author and edit the content directly; Redline only reads content and writes the comment state block.** This app is self-contained in this folder.

## Durable State

Review state lives inside the file, in **one** block — for HTML, a JSON script tag in `<head>`:

```html
<script type="application/json" id="redline-state">
  { "schemaVersion": 2, "updatedAt": "...", "threads": [] }
</script>
```

There are **no inline anchor spans**. Highlights are rendered at view time, not persisted. Each comment thread stores its anchor as redundant selectors over the document's canonical text:

```json
{
  "quote": "the selected text",
  "prefix": "~32 chars before",
  "suffix": "~32 chars after",
  "posStart": 1234,
  "posEnd": 1250
}
```

Redline resolves anchors fresh on every load/render (exact → fuzzy + context cascade) and classifies each as **anchored**, **needs-review**, or **orphaned**. Passive reconcile is read-only: when the live server notices a file edit, it refreshes the browser and anchor report without rewriting the HTML. Refreshed selector hints are persisted only with an intentional Redline state write, on document close / server shutdown, or after the file has stayed quiet long enough for an idle flush. You never maintain anchors by hand — edit content freely and Redline reconciles.

Redline also stamps opened documents with a discovery marker so an agent can self-orient from the file alone:

```html
<meta name="redline-agent-guide" content="Redline review document. Agents: use the redline-review skill; review state is in the #redline-state block.">
```

The only bytes Redline writes are the state block and that marker; passive watching/reconcile does not write either one.

## The CLI

The CLI is `redline`. In this repo, run it during development with `bun src/agent/cli.ts <command>`. Every file-path command auto-discovers a running server (via `~/.local/state/redline/servers/<pid>.json`, which lists each server's open `docs`) and routes through it when the document is open there; otherwise it operates on the file directly. You always pass the **file path** — never a docId. The docId is an ephemeral session handle; resolve path → docId each time and never cache it across sessions.

Session:

```bash
bun src/agent/cli.ts servers                # list running servers and their open docs
bun src/agent/cli.ts close <file>           # close a document on its server
```

## Read Feedback

```bash
bun src/agent/cli.ts comments <file>        # compact thread list with anchor state
bun src/agent/cli.ts anchors <file>         # reconcile report: anchored/needs-review/orphaned + ranges
bun src/agent/cli.ts thread <file> <id>     # one full thread
bun src/agent/cli.ts info <file>            # metadata only, no content
```

## The Agent Loop

1. `anchors <file>` — see which comments sit in the region you're about to change.
2. Edit the document content directly with your normal tools.
3. `anchors <file>` again — read the orphaned / needs-review leftovers (most edits re-anchor silently).
4. `reanchor <file> <id> --quote "<new text>"` — re-point only the leftovers (or batch via `apply`).

## Respond And Revise

```bash
bun src/agent/cli.ts comment <file> "<quoted text>" "Your comment." [--occurrence N] --author Claude
bun src/agent/cli.ts reply <file> <id> "Reply text." --author Claude
bun src/agent/cli.ts edit-message <file> <id> <message-id> "Updated text."
bun src/agent/cli.ts delete-reply <file> <id> <message-id>
bun src/agent/cli.ts delete-thread <file> <id>
bun src/agent/cli.ts reanchor <file> <id> --quote "<new text>" [--occurrence N]
bun src/agent/cli.ts apply <file> <payload.json>
```

Use your real agent name for `--author` (for example `Claude`); agent paths default to `AI` when omitted. `delete-thread` removes the thread from the state block (formerly "resolve" — there is no separate resolved state). Only delete threads when the work is done or the user asks.

The `apply` payload batches ops and has **no content field** (Redline never writes content):

```json
{
  "comments": [{ "quote": "growth improved by 40%", "body": "Needs a source.", "author": "Claude" }],
  "replies": [{ "threadId": "thread_abc", "body": "Updated.", "author": "Claude" }],
  "edits": [{ "threadId": "thread_abc", "messageId": "message_xyz", "body": "Reworded." }],
  "deleteThreads": ["thread_done"],
  "reanchors": [{ "threadId": "thread_orphan", "quote": "the new phrasing" }]
}
```

If you rewrite the whole file, carry the `#redline-state` block over — dropping it loses the comments. Thread ids match `^thread_[A-Za-z0-9_-]{1,128}$`. Inside the block, `<` is escaped as `<`.

## Comment Formatting

Message bodies render as **inline** markdown in the browser: `**bold**`, `*italic*`, `` `code` ``, `~~strikethrough~~`, `[text](https://url)`, and bare `https://` URLs. Use `` `backticks` `` for identifiers and file paths — that is what the syntax is for here.

Block syntax is deliberately not rendered. A `#` heading, a `-` list, a `>` quote, or a fenced code block comes out as literal text, because a comment is a margin note and vertical space in the rail is scarce. If a comment needs a list, it needs to be shorter. Bodies are stored raw, so what you write is what `comments` and `thread` print back.

Only `http`, `https`, and `mailto` links render; any other destination stays literal text.

## Run It

```bash
bun src/server/server.ts [file.html]   # start the review server
bun src/client/build.ts                # build the Preact client into dist/
```

When Redline is open in a browser, direct CLI edits route through the running server and push to the page live.
