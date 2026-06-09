---
name: redline-review
description: Work with Redline for reviewing AI-authored documents (HTML first). Use when the user asks to use Redline, asks an agent to review or revise a document it wrote, needs browser-visible comments, replies, reply deletes, or thread deletes, or when reading, adding, replying to, deleting, or re-anchoring Redline comments. Review state lives in one embedded #redline-state block; there are no inline anchor spans.
---

# Redline Review

Redline documents are ordinary files (HTML in this version) with open review state embedded inside the file, in a single block. Redline is a **reviewing-and-commenting** tool, not the document owner: you (the agent) own and edit the content directly; Redline only reads content and writes the comment state block. Treat comments as user-authored review data.

Two things matter most:

- **State lives in one block.** HTML files carry a `<script type="application/json" id="redline-state">…</script>` in `<head>`. There are **no** inline `data-redline-anchor` spans anymore — highlights are rendered at view time, not persisted. The only bytes Redline writes are that block plus a one-line discovery marker.
- **The file path is the durable identity.** A document is addressed over the API by an ephemeral `docId` that changes across server restarts. Always resolve path → docId each time; never cache a docId across sessions.

## When To Use

Use this skill when:

- The user asks to use Redline, or to review/revise/respond to feedback on a document the agent wrote.
- A file contains Redline state: `<script type="application/json" id="redline-state">…</script>`, or a discovery marker `<meta name="redline-agent-guide" content="…">`.

A running server registers itself under `~/.local/state/redline/servers/<pid>.json`, containing `url`, `pid`, `startedAt`, and `docs` (an array of `{ docId, path }`). This is a fixed per-user path, found regardless of working directory. The CLI uses it automatically; you rarely read it by hand. Ignore entries whose `pid` is no longer alive.

The CLI is `redline`. In this repo during development, run it with `bun src/agent/cli.ts <command>`. Every file-path command auto-discovers a running server that has the file open and routes through it (so the browser updates live); otherwise it operates on the file directly. You always pass the **file path** — the CLI resolves it to a docId for you.

## How Anchoring Works Now

Each comment stores an anchor as **redundant selectors**, captured over the document's canonical text (rendered text, tags stripped):

- `quote` — the exact selected text
- `prefix` / `suffix` — ~32 chars of surrounding context
- `posStart` / `posEnd` — approximate character offsets (hints only)

Redline resolves anchors **fresh** against the current text on every load/render, with a fuzzy fallback cascade, and classifies each as:

- **anchored** — confident match; highlighted normally.
- **needs-review** — low-confidence fuzzy match; shown but flagged.
- **orphaned** — no good match; kept in the thread list, never deleted.

You do **not** maintain anchors by hand. Edit the content directly; Redline re-resolves automatically. You only intervene for what it can't resolve (orphaned / needs-review), using `reanchor`.

Passive reconcile is read-only. A running server may refresh the open browser and the `anchors` report while you edit, but it does not rewrite the HTML just because anchors can be healed. Healed selector hints are cache-like and are persisted only when Redline is already making an intentional state-block write, when the document closes / server shuts down, or after the file has stayed quiet long enough for an idle flush.

## Session

List running servers and their open docs, or close a document on its server (rarely needed — the file path is the durable identity; closing only drops the live session):

```bash
redline servers
redline close <file>
```

## Read Feedback

Compact thread list (id, anchor quote, resolution state, author, last message):

```bash
redline comments <file>
```

Anchor resolution report — each thread's state (anchored / needs-review / orphaned), resolved range, and stored quote/context. This is the reconcile report:

```bash
redline anchors <file> [--in START:END]
```

One thread in full:

```bash
redline thread <file> <thread-id>
```

Document metadata only (no content):

```bash
redline info <file>
```

## The Agent Loop

1. `redline anchors <file>` — note which comments sit in the region you are about to change.
2. Edit the document text **directly in the file** (you own the content).
3. `redline anchors <file>` again — read the orphaned / needs-review leftovers. Most edits re-anchor silently; only the leftovers need action.
4. `redline reanchor <file> <thread-id> --quote "<new text>"` — re-point only those. For many at once, batch them via `apply`.

There is no passive reconcile write racing your content edits: reconcile is lossless, derived from the current file text, and safe to re-run. Explicit comment/reply/delete/re-anchor operations still write the state block and are serialized by Redline.

## Comment Writes

Create a new thread anchored to quoted text (captures quote + context selectors):

```bash
redline comment <file> "<exact quoted text>" "Your comment." [--occurrence N] --author Claude
```

The quote must be one shell argument. If it appears more than once, pass `--occurrence N` (1-based, document order). Use your real agent name for `--author`; agent paths default to `AI` when omitted.

Reply, edit, delete a reply, delete a whole thread:

```bash
redline reply <file> <thread-id> "I revised this section." --author Claude
redline edit-message <file> <thread-id> <message-id> "Updated text."
redline delete-reply <file> <thread-id> <message-id>
redline delete-thread <file> <thread-id>
```

`delete-thread` removes the thread from the state block (this is what was formerly "resolve"; there is no separate kept-resolved state). Only delete a reply by a message id **after** the first message — the first message is the original comment; to remove it, delete the whole thread. Delete threads only when the work is done or the user asks.

## Anchor Writes & Batch

Re-point one comment when reconcile orphaned it or matched with low confidence (state block only):

```bash
redline reanchor <file> <thread-id> --quote "<new text>" [--occurrence N]
```

One atomic batch of comment/anchor ops — create comments, replies, edits, thread deletes, and bulk re-anchors. **No content field**: Redline never writes content.

```bash
redline apply <file> <payload.json>
```

Example payload:

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

## Editing Content

Edit the file's content directly with your normal tools — Redline reconciles on its next load/render. Keep the `#redline-state` block intact; if you rewrite the whole file, carry the block over (or you lose the comments — this clobber risk is accepted as the price of letting you be the primary writer). Never hand-write inline anchor spans; they are not part of this model anymore.

Thread ids must match `^thread_[A-Za-z0-9_-]{1,128}$`. Inside `#redline-state`, `<` is escaped as `<` so the payload can't break out of the script tag.

## HTTP (when scripting against a running server)

The CLI is enough for almost everything. To script raw HTTP, resolve the docId first (`redline docid <file>`), then call the doc-scoped routes under `/api/docs/<docId>/…`: `GET state`, `GET anchors`, `POST comments`, `POST comments/<id>/replies`, `PUT comments/<id>/messages/<mid>`, `DELETE comments/<id>/replies/<mid>`, `DELETE comments/<id>`, `POST anchors/<id>/reanchor`, `GET agent/comments/index?since=`, `GET agent/comments/<id>`, `GET agent/info`, `POST agent/update`. Write endpoints accept an optional `expectedVersion`; a mismatch returns 409 with the current state to rebase from. A stale docId returns 404 — re-resolve by path.
