import { useState } from "preact/hooks";
import type { AnchorStatus, Message, Thread } from "../core";
import type { DocumentStateResponse, SelectorInput } from "../shared";

interface RailProps {
  state: DocumentStateResponse;
  statusByThread: Map<string, AnchorStatus>;
  order: string[]; // thread ids in document (highlight) order
  author: string;
  activeThread: string | null;
  selection: SelectorInput | null;
  onSelectThread: (id: string) => void;
  onCreateComment: (text: string, withSelection: boolean) => Promise<unknown>;
  onReply: (threadId: string, text: string) => Promise<unknown>;
  onEdit: (threadId: string, messageId: string, text: string) => Promise<unknown>;
  onDeleteReply: (threadId: string, messageId: string) => Promise<unknown>;
  onDeleteThread: (threadId: string) => Promise<unknown>;
  onReanchor: (threadId: string) => Promise<unknown>;
}

export function Rail(props: RailProps) {
  const { state, statusByThread, order } = props;
  const threadsById = new Map(state.threads.map((t) => [t.id, t]));

  const orderIndex = new Map(order.map((id, i) => [id, i]));
  const located: Thread[] = [];
  const unanchored: Thread[] = [];
  for (const thread of state.threads) {
    if (orderIndex.has(thread.id)) located.push(thread);
    else unanchored.push(thread);
  }
  located.sort((a, b) => (orderIndex.get(a.id)! - orderIndex.get(b.id)!));

  return (
    <aside class="comment-rail">
      <Composer
        selection={props.selection}
        onCreate={props.onCreateComment}
      />

      <div class="threads">
        {located.length === 0 && unanchored.length === 0 && (
          <p class="rail-empty">No comments yet. Select text in the document to add one.</p>
        )}
        {located.map((thread) => (
          <ThreadCard {...props} thread={thread} status={statusByThread.get(thread.id)} />
        ))}

        {unanchored.length > 0 && (
          <div class="unanchored-section">
            <h3 class="unanchored-heading">Unanchored</h3>
            <p class="unanchored-hint">
              These comments lost their place in the text. Select the new text, then “Re-attach”.
            </p>
            {unanchored.map((thread) => (
              <ThreadCard {...props} thread={thread} status={statusByThread.get(thread.id)} unanchored />
            ))}
          </div>
        )}
      </div>
      {threadsById.size === 0 ? null : null}
    </aside>
  );
}

function Composer(props: {
  selection: SelectorInput | null;
  onCreate: (text: string, withSelection: boolean) => Promise<unknown>;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const hasSelection = !!props.selection;

  const submit = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      await props.onCreate(text.trim(), hasSelection);
      setText("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section class="composer">
      {hasSelection ? (
        <p class="composer-target">
          Commenting on “<span class="composer-quote">{truncate(props.selection!.quote, 60)}</span>”
        </p>
      ) : (
        <p class="composer-target muted">Select text in the document, or add a general comment.</p>
      )}
      <textarea
        rows={3}
        value={text}
        placeholder={hasSelection ? "Add a comment…" : "Add a general comment…"}
        onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit();
        }}
      />
      <div class="composer-actions">
        <button type="button" class="primary-button" disabled={!text.trim() || busy} onClick={submit}>
          {hasSelection ? "Comment" : "Add general comment"}
        </button>
      </div>
    </section>
  );
}

function ThreadCard(
  props: RailProps & { thread: Thread; status?: AnchorStatus; unanchored?: boolean },
) {
  const { thread, status, activeThread } = props;
  const active = thread.id === activeThread;
  const stateLabel = thread.anchor ? status?.state ?? "orphaned" : "general";

  return (
    <article
      class={`thread-card ${active ? "active" : ""} state-${stateLabel}`}
      onClick={() => props.onSelectThread(thread.id)}
    >
      <header class="thread-head">
        <span class={`badge badge-${stateLabel}`}>{badgeText(stateLabel)}</span>
        {thread.anchor?.quote && <span class="thread-quote">“{truncate(status?.quote || thread.anchor.quote, 48)}”</span>}
      </header>
      <div class="messages">
        {thread.messages.map((message, index) => (
          <MessageRow
            message={message}
            isOriginal={index === 0}
            onEdit={(text) => props.onEdit(thread.id, message.id, text)}
            onDelete={index === 0 ? undefined : () => props.onDeleteReply(thread.id, message.id)}
          />
        ))}
      </div>

      {active && (
        <div class="thread-actions" onClick={(e) => e.stopPropagation()}>
          <ReplyBox onReply={(text) => props.onReply(thread.id, text)} />
          <div class="thread-buttons">
            {props.unanchored && (
              <button
                type="button"
                class="ghost-button"
                disabled={!props.selection}
                title={props.selection ? "Re-attach to the selected text" : "Select text in the document first"}
                onClick={() => props.onReanchor(thread.id)}
              >
                Re-attach to selection
              </button>
            )}
            <button type="button" class="danger-button" onClick={() => props.onDeleteThread(thread.id)}>
              Delete thread
            </button>
          </div>
        </div>
      )}
    </article>
  );
}

function MessageRow(props: {
  message: Message;
  isOriginal: boolean;
  onEdit: (text: string) => Promise<unknown>;
  onDelete?: () => Promise<unknown>;
}) {
  const { message } = props;
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(message.body);

  return (
    <div class="message">
      <div class="message-meta">
        <span class="message-author">{message.author}</span>
        {message.updatedAt && <span class="message-edited">edited</span>}
      </div>
      {editing ? (
        <div class="message-edit" onClick={(e) => e.stopPropagation()}>
          <textarea rows={2} value={text} onInput={(e) => setText((e.target as HTMLTextAreaElement).value)} />
          <div class="message-edit-actions">
            <button
              type="button"
              class="primary-button"
              onClick={async () => {
                await props.onEdit(text.trim());
                setEditing(false);
              }}
            >
              Save
            </button>
            <button type="button" class="ghost-button" onClick={() => { setText(message.body); setEditing(false); }}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <p class="message-body">{message.body}</p>
      )}
      <div class="message-actions" onClick={(e) => e.stopPropagation()}>
        <button type="button" class="link-button" onClick={() => setEditing(true)}>Edit</button>
        {props.onDelete && (
          <button type="button" class="link-button danger" onClick={() => props.onDelete!()}>Delete</button>
        )}
      </div>
    </div>
  );
}

function ReplyBox(props: { onReply: (text: string) => Promise<unknown> }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      await props.onReply(text.trim());
      setText("");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="reply-box">
      <textarea
        rows={2}
        value={text}
        placeholder="Reply…"
        onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit();
        }}
      />
      <button type="button" class="ghost-button" disabled={!text.trim() || busy} onClick={submit}>
        Reply
      </button>
    </div>
  );
}

function badgeText(state: string): string {
  switch (state) {
    case "anchored":
      return "Anchored";
    case "needs-review":
      return "Needs review";
    case "orphaned":
      return "Orphaned";
    default:
      return "General";
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
