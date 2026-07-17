/**
 * FC3 — the right-side thread panel (Google's in-line threading, faithful):
 * root message pinned at the top, replies windowed below (WindowedList over
 * the ?before= pages, "Load earlier" on top), its own composer, and a
 * Follow/Following toggle in the header (followers join the reply-notify
 * audience). Rows are the shared MessageParts anatomy — own replies get
 * inline edit/delete; one level deep, so no reply-in-thread inside the panel.
 * FC4 — reaction pills + picker on the root and every reply, presence dots,
 * and the reply composer publishes typing (space-level indicator).
 */
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Bell, BellOff, X } from "lucide-react";
import { Modal } from "@/design-system/components";
import { Button, Skeleton } from "@/design-system/primitives";
import { WindowedList } from "@/components/WindowedList";
import { buildStream, threadRepliesLabel, type MentionMember, type StreamMessage, type StreamRow } from "@/lib/chat/ui";
import { Composer } from "./Composer";
import { MessageRow } from "./MessageParts";

const NEAR_BOTTOM_PX = 60;

export function ThreadPanel({
  spaceId,
  rootId,
  root,
  replies,
  replyCount,
  loading,
  hasEarlier,
  loadingEarlier,
  onLoadEarlier,
  following,
  followBusy,
  onToggleFollow,
  onClose,
  meId,
  members,
  canPost,
  onSendReply,
  onEdit,
  onDelete,
  onToggleReaction,
  onlineIds,
  onTyping,
}: {
  spaceId: string;
  rootId: string;
  root: StreamMessage | null;
  replies: StreamMessage[];
  replyCount: number;
  loading: boolean;
  hasEarlier: boolean;
  loadingEarlier: boolean;
  onLoadEarlier: () => void;
  following: boolean;
  followBusy: boolean;
  onToggleFollow: () => void;
  onClose: () => void;
  meId: string | null;
  members: MentionMember[];
  canPost: boolean;
  onSendReply: (body: string) => Promise<boolean>;
  onEdit: (id: string, body: string) => Promise<boolean>;
  onDelete: (id: string) => Promise<void>;
  /** FC4 — toggle a reaction (message id + emoji); routes live in ChatClient */
  onToggleReaction: (messageId: string, emoji: string) => void;
  /** FC4 — online userIds for presence dots */
  onlineIds: ReadonlySet<string>;
  /** FC4 — the reply composer's throttled typing publisher */
  onTyping: () => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [editBusy, setEditBusy] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const wrapRef = useRef<HTMLDivElement>(null);
  const stickBottom = useRef(true);
  const prevHeightRef = useRef(0);

  const rows = useMemo<StreamRow[]>(() => buildStream(replies, Date.now()), [replies]);
  const newestId = replies.length ? replies[replies.length - 1].id : null;
  const oldestId = replies.length ? replies[0].id : null;
  const nowMs = Date.now();

  const scrollEl = () => wrapRef.current?.querySelector<HTMLElement>(".fc3-thread-scroll") ?? null;

  // a fresh thread follows the bottom; the reader's scroll decides after that
  useEffect(() => {
    stickBottom.current = true;
    setEditingId(null);
  }, [rootId]);
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const onScroll = (e: Event) => {
      const el = e.target as HTMLElement;
      if (!el.classList?.contains("fc3-thread-scroll")) return;
      stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    };
    wrap.addEventListener("scroll", onScroll, true);
    return () => wrap.removeEventListener("scroll", onScroll, true);
  }, [rootId, loading]);
  useEffect(() => {
    if (!stickBottom.current) return;
    const settle = () => {
      const el = scrollEl();
      if (el) el.scrollTop = el.scrollHeight;
    };
    requestAnimationFrame(() => {
      settle();
      requestAnimationFrame(settle);
    });
  }, [newestId, rootId, loading]);
  useEffect(() => {
    const el = scrollEl();
    if (!el) return;
    if (prevHeightRef.current && !stickBottom.current) {
      const delta = el.scrollHeight - prevHeightRef.current;
      if (delta > 0) el.scrollTop += delta;
    }
    prevHeightRef.current = 0;
  }, [oldestId]);

  const startEdit = (m: StreamMessage) => {
    setEditingId(m.id);
    setEditText(m.body);
  };
  const saveEdit = async () => {
    if (!editingId || editBusy || !editText.trim()) return;
    setEditBusy(true);
    const ok = await onEdit(editingId, editText.trim());
    setEditBusy(false);
    if (ok) setEditingId(null);
  };
  const confirmDelete = async () => {
    if (!confirmDeleteId || deleteBusy) return;
    setDeleteBusy(true);
    await onDelete(confirmDeleteId);
    setDeleteBusy(false);
    setConfirmDeleteId(null);
  };

  const rowFor = (message: StreamMessage, runStart: boolean) => (
    <MessageRow
      message={message}
      runStart={runStart}
      own={!!meId && message.authorId === meId}
      meId={meId}
      members={members}
      nowMs={nowMs}
      onStartEdit={() => startEdit(message)}
      onAskDelete={() => setConfirmDeleteId(message.id)}
      editing={editingId === message.id}
      editText={editText}
      setEditText={setEditText}
      onSaveEdit={() => void saveEdit()}
      onCancelEdit={() => setEditingId(null)}
      editBusy={editBusy}
      onToggleReaction={canPost && !message.pending ? (emoji) => onToggleReaction(message.id, emoji) : undefined}
      onlineIds={onlineIds}
    />
  );

  return (
    <div className="fc3-thread-pane">
      <div className="fc3-thread-head">
        <div style={{ minWidth: 0 }}>
          <div className="fc3-thread-title">Thread</div>
          <div className="fc3-thread-sub">{threadRepliesLabel(replyCount)}</div>
        </div>
        <button
          type="button"
          className={`fc3-follow-btn${following ? " is-following" : ""}`}
          onClick={onToggleFollow}
          disabled={followBusy}
          title={following ? "Following — new replies notify you. Click to unfollow." : "Follow — get notified about new replies."}
          aria-label={following ? "Unfollow thread" : "Follow thread"}
        >
          {following ? <Bell size={13} /> : <BellOff size={13} />}
          {following ? "Following" : "Follow"}
        </button>
        <button type="button" className="fc2-icon-btn" style={{ marginLeft: 0 }} onClick={onClose} title="Close thread" aria-label="Close thread">
          <X size={14} />
        </button>
      </div>

      {loading && !root ? (
        <div style={{ flex: 1, padding: 16, display: "grid", gap: 10, alignContent: "start" }}>
          <Skeleton />
          <Skeleton />
        </div>
      ) : !root ? (
        <div style={{ flex: 1, display: "grid", placeItems: "center", padding: 16, fontSize: 12.5, color: "var(--h10-text-3)", textAlign: "center" }}>
          This thread is gone — its message may have been removed.
        </div>
      ) : (
        <>
          {/* the root message, pinned (its own scroll if very long) */}
          <div className="fc3-thread-root">{rowFor(root, true)}</div>
          <div className="fc3-thread-divider">
            <span>{threadRepliesLabel(replyCount)}</span>
          </div>

          <div ref={wrapRef} style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
            {hasEarlier && (
              <div style={{ textAlign: "center", padding: "4px 0", borderBottom: "1px solid var(--h10-border-subtle)" }}>
                <button
                  type="button"
                  className="fc2-load-earlier"
                  disabled={loadingEarlier}
                  onClick={() => {
                    const el = scrollEl();
                    prevHeightRef.current = el?.scrollHeight ?? 0;
                    stickBottom.current = false;
                    onLoadEarlier();
                  }}
                >
                  {loadingEarlier ? "Loading…" : "Load earlier replies"}
                </button>
              </div>
            )}
            <div style={{ flex: 1, minHeight: 0 }}>
              <WindowedList
                items={rows}
                itemKey={(r) => r.key}
                estimateSize={(i) => (rows[i]?.kind === "divider" ? 36 : rows[i]?.kind === "message" && rows[i].runStart ? 54 : 26)}
                height="100%"
                className="fc3-thread-scroll"
                style={{ padding: "6px 0" }}
                emptyState={
                  <div style={{ padding: 20, fontSize: 12.5, color: "var(--h10-text-3)", textAlign: "center" }}>
                    No replies yet — start the thread.
                  </div>
                }
                renderItem={(row) =>
                  row.kind === "divider" ? (
                    <div className="fc2-day">
                      <span className="fc2-day-chip">{row.label}</span>
                    </div>
                  ) : (
                    rowFor(row.message, row.runStart)
                  )
                }
              />
            </div>
          </div>

          <Composer canPost={canPost} onSend={onSendReply} composerKey={`${spaceId}:${rootId}`} placeholder="Reply in thread — @ to mention…" onTyping={onTyping} />
        </>
      )}

      <Modal
        open={!!confirmDeleteId}
        onClose={() => setConfirmDeleteId(null)}
        title="Delete reply?"
        size="sm"
        footer={
          <>
            <Button onClick={() => setConfirmDeleteId(null)}>Cancel</Button>
            {/* no danger Button variant in the DS — the PO-cancel house pattern */}
            <Button
              onClick={() => void confirmDelete()}
              disabled={deleteBusy}
              style={{ color: "var(--h10-danger)", borderColor: "var(--h10-danger)" }}
            >
              {deleteBusy ? "Deleting…" : "Delete"}
            </Button>
          </>
        }
      >
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: "var(--h10-text-2)", display: "grid", gap: 4 }}>
          <li>Everyone in the thread sees a &quot;Message deleted&quot; tombstone instead.</li>
          <li>The audit log keeps the original text — deletion is soft, never silent.</li>
        </ul>
      </Modal>
    </div>
  );
}
