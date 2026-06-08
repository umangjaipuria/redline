import { useEffect, useRef, useState } from "preact/hooks";
import type { AnchorStatus, Message, Thread } from "../core";
import type { DocumentStateResponse, SelectorInput } from "../shared";

interface RailProps {
  state: DocumentStateResponse;
  statusByThread: Map<string, AnchorStatus>;
  order: string[]; // thread ids in document (highlight) order
  author: string;
  activeThread: string | null;
  selection: SelectorInput | null;
  composerOpen: boolean;
  onDeselect: () => void;
  onSelectThread: (id: string) => void;
  onCreateComment: (text: string) => Promise<unknown>;
  onCancelComposer: () => void;
  onReply: (threadId: string, text: string) => Promise<unknown>;
  onEdit: (threadId: string, messageId: string, text: string) => Promise<unknown>;
  onDeleteReply: (threadId: string, messageId: string) => Promise<unknown>;
  onDeleteThread: (threadId: string) => Promise<unknown>;
  onReanchor: (threadId: string) => Promise<unknown>;
}

// Threads in document order; anchored first (by highlight order), orphaned last.
function orderThreads(threads: Thread[], order: string[]): Thread[] {
  const index = new Map(order.map((id, i) => [id, i]));
  return [...threads].sort((a, b) => {
    const ai = index.get(a.id) ?? Number.MAX_SAFE_INTEGER;
    const bi = index.get(b.id) ?? Number.MAX_SAFE_INTEGER;
    return ai - bi || String(a.createdAt).localeCompare(String(b.createdAt));
  });
}

export function Rail(props: RailProps) {
  const ordered = orderThreads(props.state.threads, props.order);

  return (
    <aside
      class="comment-rail"
      aria-label="Comment threads"
      onClick={(e) => {
        // A click on the rail background (not a card or the composer) clears the
        // active thread.
        if (!(e.target as HTMLElement).closest(".thread-card, .composer")) props.onDeselect();
      }}
    >
      <div class="comment-rail-inner">
        {props.composerOpen && (
          <Composer onCreate={props.onCreateComment} onCancel={props.onCancelComposer} />
        )}
        <div class="threads">
          {ordered.map((thread) => (
            <ThreadCard
              key={thread.id}
              {...props}
              thread={thread}
              status={props.statusByThread.get(thread.id)}
            />
          ))}
        </div>
      </div>
    </aside>
  );
}

function Composer(props: { onCreate: (text: string) => Promise<unknown>; onCancel: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);

  const submit = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      await props.onCreate(text.trim());
      setText("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section class="composer">
      <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <textarea
          ref={ref}
          rows={4}
          value={text}
          placeholder="Add a comment…"
          onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); submit(); }
            if (e.key === "Escape") props.onCancel();
          }}
        />
        <div class="composer-actions">
          <button type="button" class="icon-action" title="Discard comment" aria-label="Discard comment" onClick={props.onCancel}>
            <CloseIcon />
          </button>
          <button type="submit" class="icon-action primary" title="Post comment" aria-label="Post comment" disabled={!text.trim() || busy}>
            <SendIcon />
          </button>
        </div>
      </form>
    </section>
  );
}

function ThreadCard(props: RailProps & { thread: Thread; status?: AnchorStatus }) {
  const { thread, status, activeThread, author } = props;
  const active = thread.id === activeThread;
  const state = thread.anchor ? status?.state ?? "orphaned" : "general";
  const unanchored = state === "orphaned" || state === "needs-review";
  const [replyOpen, setReplyOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const lastMessage = thread.messages[thread.messages.length - 1];
  const canEditLast = !!lastMessage && lastMessage.author.trim() === author.trim();

  return (
    <article
      class={`thread-card ${active ? "active" : ""} ${unanchored ? "unanchored" : ""} ${editingId ? "editing-message" : ""}`}
      data-thread-id={thread.id}
      onClick={() => props.onSelectThread(thread.id)}
    >
      {unanchored && (
        <p class="thread-detached" role="note">
          <DetachedIcon />
          <span>
            {state === "orphaned" ? "Orphaned" : "Needs review"}
            <span class="detached-note"> · {state === "orphaned" ? "kept until you re-anchor" : "low-confidence match"}</span>
          </span>
        </p>
      )}

      {thread.messages.map((message, index) => (
        <MessageRow
          key={message.id}
          message={message}
          isReply={index > 0}
          editing={editingId === message.id}
          onCancelEdit={() => setEditingId(null)}
          onEdit={async (text) => {
            await props.onEdit(thread.id, message.id, text);
            setEditingId(null);
          }}
          onDelete={index === 0 ? undefined : () => props.onDeleteReply(thread.id, message.id)}
        />
      ))}

      {!editingId && (
        <div class="thread-foot" onClick={(e) => e.stopPropagation()}>
          <button type="button" class="icon-action" title="Reply" aria-label="Reply" onClick={() => setReplyOpen((v) => !v)}>
            <ReplyIcon />
          </button>
          {canEditLast && (
            <button type="button" class="icon-action" title="Edit comment" aria-label="Edit comment" onClick={() => setEditingId(lastMessage!.id)}>
              <EditIcon />
            </button>
          )}
          {unanchored && props.selection && (
            <button type="button" class="icon-action" title="Re-attach to the selected text" aria-label="Re-attach to selection" onClick={() => props.onReanchor(thread.id)}>
              <AnchorIcon />
            </button>
          )}
          <button type="button" class="icon-action danger" title="Delete comment" aria-label="Delete comment" onClick={() => props.onDeleteThread(thread.id)}>
            <TrashIcon />
          </button>
        </div>
      )}

      {replyOpen && !editingId && (
        <ReplyForm
          onCancel={() => setReplyOpen(false)}
          onReply={async (text) => {
            await props.onReply(thread.id, text);
            setReplyOpen(false);
          }}
        />
      )}
    </article>
  );
}

function MessageRow(props: {
  message: Message;
  isReply: boolean;
  editing: boolean;
  onCancelEdit: () => void;
  onEdit: (text: string) => Promise<unknown>;
  onDelete?: () => Promise<unknown>;
}) {
  const { message } = props;
  const [text, setText] = useState(message.body);
  const ref = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (props.editing) {
      setText(message.body);
      const el = ref.current;
      if (el) {
        el.focus({ preventScroll: true });
        el.setSelectionRange(el.value.length, el.value.length);
      }
    }
  }, [props.editing]);

  return (
    <div class="message" data-message-id={message.id}>
      <div class="message-meta">
        <span>{message.author}</span>
        <div class="message-meta-actions" onClick={(e) => e.stopPropagation()}>
          <time>{formatTime(message.createdAt)}</time>
          {props.isReply && props.onDelete && (
            <button type="button" class="message-delete-button" title="Delete reply" aria-label="Delete reply" onClick={() => props.onDelete!()}>
              <TrashIcon />
            </button>
          )}
        </div>
      </div>
      {props.editing ? (
        <form class="message-edit-form" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); if (text.trim()) props.onEdit(text.trim()); }}>
          <textarea
            ref={ref}
            rows={3}
            value={text}
            onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); if (text.trim()) props.onEdit(text.trim()); }
              if (e.key === "Escape") props.onCancelEdit();
            }}
          />
          <div class="message-edit-actions">
            <button type="button" class="message-edit-control" title="Cancel edit" aria-label="Cancel edit" onClick={props.onCancelEdit}>
              <CloseIcon />
            </button>
            <button type="submit" class="message-edit-control confirm" title="Save edit" aria-label="Save edit" disabled={!text.trim()}>
              <CheckIcon />
            </button>
          </div>
        </form>
      ) : (
        <p class="message-body">{message.body}</p>
      )}
    </div>
  );
}

function ReplyForm(props: { onReply: (text: string) => Promise<unknown>; onCancel: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);
  useEffect(() => { ref.current?.focus({ preventScroll: true }); }, []);
  const submit = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    try { await props.onReply(text.trim()); setText(""); } finally { setBusy(false); }
  };
  return (
    <form
      ref={formRef}
      class="reply-form"
      onClick={(e) => e.stopPropagation()}
      onSubmit={(e) => { e.preventDefault(); submit(); }}
      onBlur={(e) => {
        // Close an untouched reply box when focus leaves it (matches main).
        const next = e.relatedTarget as Node | null;
        if (!text.trim() && (!next || !formRef.current?.contains(next))) props.onCancel();
      }}
    >
      <textarea
        ref={ref}
        rows={2}
        value={text}
        placeholder="Reply…"
        onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); submit(); }
          if (e.key === "Escape") props.onCancel();
        }}
      />
      <div class="thread-actions">
        <button type="submit" class="icon-action primary" title="Send reply" aria-label="Send reply" disabled={!text.trim() || busy}>
          <SendIcon />
        </button>
      </div>
    </form>
  );
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

// ---- icons (exact paths from the main-branch markup) ----
const SendIcon = () => (
  <svg class="btn-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M4.5 11.5 19 5l-6 14-2.6-5.4z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" />
    <path d="m10.4 13.6 4.2-4.2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
  </svg>
);
const CloseIcon = () => (
  <svg class="btn-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M6.5 6.5 17.5 17.5M17.5 6.5 6.5 17.5" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" />
  </svg>
);
const ReplyIcon = () => (
  <svg class="btn-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M9.5 7 5 11.5 9.5 16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
    <path d="M5 11.5h8.5a5 5 0 0 1 5 5V18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
);
const EditIcon = () => (
  <svg class="btn-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M14.5 5.5 18.5 9.5 8.5 19.5 4 20.5 5 16z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" />
    <path d="M13 7 17 11" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
  </svg>
);
const TrashIcon = () => (
  <svg class="btn-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M5 7h14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
    <path d="M9.5 7V5.6a1.1 1.1 0 0 1 1.1-1.1h2.8a1.1 1.1 0 0 1 1.1 1.1V7" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" />
    <path d="M6.7 7.5 7.6 18.6A1.4 1.4 0 0 0 9 20h6a1.4 1.4 0 0 0 1.4-1.4L17.3 7.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
);
const CheckIcon = () => (
  <svg class="btn-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="m5 12.5 4.2 4.2L19 6.8" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
);
const AnchorIcon = () => (
  <svg class="btn-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle cx="12" cy="6" r="2.2" stroke="currentColor" stroke-width="1.7" />
    <path d="M12 8.2V20M6 12H4.5a7.5 7.5 0 0 0 15 0H18M9 11h6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
);
const DetachedIcon = () => (
  <svg class="detached-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M10.2 13.4 8.4 15.2a3.1 3.1 0 0 1-4.4-4.4l1.8-1.8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
    <path d="m13.8 10.6 1.8-1.8a3.1 3.1 0 0 1 4.4 4.4l-1.8 1.8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
    <path d="M8.5 7.2 7.1 5.8M16.9 18.2l-1.4-1.4M5.9 9.6 4 9.1M18.1 14.4l1.9.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
  </svg>
);
