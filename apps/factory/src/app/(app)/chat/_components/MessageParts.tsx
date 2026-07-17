/**
 * FC3 — the shared message anatomy (extracted from SpaceView so the thread
 * panel renders the EXACT same rows): author runs, tombstones, money chip
 * (€ ONLY when moneyCents survived the grain strip), inline edit, own-message
 * hover actions + the new "Reply in thread" hover action, mention chips
 * (@handle → displayName pill via the server's own grammar; @all always
 * chips), and the root-message thread bar — facepile (≤3 repliers) · reply
 * count · last-reply time — that opens the panel.
 */
"use client";

import { ExternalLink, MessageSquareText, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/design-system/primitives";
import { eur } from "@/design-system/lib/format";
import {
  avatarHue,
  initialsOf,
  metaChip,
  relTime,
  resolveHandleDisplay,
  splitMentionTokens,
  threadRepliesLabel,
  timeOfDay,
  type MentionMember,
  type StreamMessage,
} from "@/lib/chat/ui";

/** € appears ONLY when the grain strip left moneyCents in the payload */
export function MoneyChip({ message }: { message: StreamMessage }) {
  if (message.moneyCents == null) return null;
  return (
    <span className="fc2-money">
      {message.moneyLabel ? `${message.moneyLabel}: ` : ""}
      {eur(message.moneyCents)}
    </span>
  );
}

/** FC3 — body text with mention chips (server-grammar tokens; unmatched handles stay plain) */
export function MessageBody({ body, members }: { body: string; members: MentionMember[] }) {
  const tokens = splitMentionTokens(body);
  if (!tokens.some((t) => t.kind === "mention")) return <>{body}</>;
  return (
    <>
      {tokens.map((t, i) => {
        if (t.kind === "text") return <span key={i}>{t.text}</span>;
        if (t.all) {
          return (
            <span key={i} className="fc3-mention is-all" title="Notifies everyone in this space">
              @all
            </span>
          );
        }
        const display = resolveHandleDisplay(t.handle, members);
        if (!display) return <span key={i}>{t.raw}</span>;
        return (
          <span key={i} className="fc3-mention" title={t.raw}>
            @{display}
          </span>
        );
      })}
    </>
  );
}

export function SystemRow({ message }: { message: StreamMessage }) {
  const chip = metaChip(message.meta);
  return (
    <div className="fc2-system">
      <span>
        {message.deletedAt ? "Message deleted" : message.body}
        <MoneyChip message={message} />
        {chip && (
          <a href={chip.href} className="fc2-system-chip">
            {chip.label} <ExternalLink size={10} />
          </a>
        )}
        <span className="fc2-system-time">{timeOfDay(message.createdAt)}</span>
      </span>
    </div>
  );
}

/** FC3 — the root message's thread affordance: facepile · count · last activity */
export function ThreadBar({ message, nowMs, onOpen }: { message: StreamMessage; nowMs: number; onOpen: () => void }) {
  const t = message.thread;
  if (!t || t.replyCount === 0) return null;
  return (
    <button type="button" className="fc3-thread-bar" onClick={onOpen} aria-label={`Open thread — ${threadRepliesLabel(t.replyCount)}`}>
      <span className="fc3-facepile">
        {t.participants.slice(0, 3).map((p) => (
          <span key={p.id} className="fc3-face" style={{ background: `hsl(${avatarHue(p.id)} 45% 45%)` }}>
            {initialsOf(p.name)}
          </span>
        ))}
      </span>
      <span className="fc3-thread-count">{threadRepliesLabel(t.replyCount)}</span>
      <span className="fc3-thread-time">{relTime(t.lastReplyAt, nowMs)}</span>
    </button>
  );
}

export function MessageRow({
  message,
  runStart,
  own,
  members,
  onStartEdit,
  onAskDelete,
  editing,
  editText,
  setEditText,
  onSaveEdit,
  onCancelEdit,
  editBusy,
  onReply,
  onOpenThread,
  nowMs,
}: {
  message: StreamMessage;
  runStart: boolean;
  own: boolean;
  members: MentionMember[];
  onStartEdit: () => void;
  onAskDelete: () => void;
  editing: boolean;
  editText: string;
  setEditText: (v: string) => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  editBusy: boolean;
  /** FC3 — hover "Reply in thread" (main stream only; absent in the panel) */
  onReply?: () => void;
  /** FC3 — click the thread bar (present when the message has replies) */
  onOpenThread?: () => void;
  nowMs?: number;
}) {
  const deleted = !!message.deletedAt;
  const name = message.authorName ?? "Someone";
  const showActions = !deleted && !editing && !message.pending && (own || !!onReply);
  return (
    <div className={`fc2-msg-row${runStart ? " is-run-start" : ""}`}>
      <div className="fc2-msg-gutter">
        {runStart && (
          <span className="fc2-avatar" style={{ background: `hsl(${avatarHue(message.authorId ?? "?")} 45% 45%)` }}>
            {initialsOf(name)}
          </span>
        )}
      </div>
      <div className="fc2-msg-main">
        {runStart && (
          <div className="fc2-msg-head">
            <b>{name}</b>
            <span className="fc2-msg-time">{timeOfDay(message.createdAt)}</span>
          </div>
        )}
        {editing ? (
          <div style={{ display: "grid", gap: 6 }}>
            <textarea
              className="fc2-edit-box"
              value={editText}
              autoFocus
              rows={Math.min(6, Math.max(2, editText.split("\n").length))}
              onChange={(e) => setEditText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  onSaveEdit();
                } else if (e.key === "Escape") {
                  e.preventDefault(); // keep focus flow local — Esc here means "stop editing"
                  onCancelEdit();
                }
              }}
            />
            <div style={{ display: "flex", gap: 6, fontSize: 11.5, color: "var(--h10-text-3)", alignItems: "center" }}>
              Enter saves · Esc cancels
              <span style={{ marginLeft: "auto", display: "inline-flex", gap: 6 }}>
                <Button onClick={onCancelEdit}>Cancel</Button>
                <Button variant="primary" onClick={onSaveEdit} disabled={editBusy || !editText.trim()}>
                  {editBusy ? "Saving…" : "Save"}
                </Button>
              </span>
            </div>
          </div>
        ) : (
          <div className={`fc2-msg-body${deleted ? " is-deleted" : ""}${message.pending ? " is-pending" : ""}`}>
            {deleted ? "Message deleted" : <MessageBody body={message.body} members={members} />}
            {!deleted && message.editedAt && <span className="fc2-edited">(edited)</span>}
            {!deleted && <MoneyChip message={message} />}
          </div>
        )}
        {!editing && onOpenThread && <ThreadBar message={message} nowMs={nowMs ?? Date.now()} onOpen={onOpenThread} />}
        {showActions && (
          <span className="fc2-msg-actions">
            {onReply && (
              <button type="button" onClick={onReply} title="Reply in thread" aria-label="Reply in thread">
                <MessageSquareText size={13} />
              </button>
            )}
            {own && (
              <>
                <button type="button" onClick={onStartEdit} title="Edit" aria-label="Edit message">
                  <Pencil size={13} />
                </button>
                <button type="button" onClick={onAskDelete} title="Delete" aria-label="Delete message">
                  <Trash2 size={13} />
                </button>
              </>
            )}
          </span>
        )}
      </div>
    </div>
  );
}
