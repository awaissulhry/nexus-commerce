/**
 * FC2 — the space view: header (name · member count · copy-deep-link ·
 * jump-to-order chip), the windowed message stream (WindowedList over the
 * FC1 ?before= pages, "Load earlier" at the top), and the Google-Chat
 * message anatomy (MessageParts.tsx — shared with the FC3 thread panel).
 * FC3 — the stream is roots-only; every MESSAGE row gains a hover
 * "Reply in thread" action, roots with replies wear the thread bar
 * (facepile · count · last activity), and bodies render mention chips.
 */
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, Link2 } from "lucide-react";
import { Modal } from "@/design-system/components";
import { Button, Skeleton } from "@/design-system/primitives";
import { WindowedList } from "@/components/WindowedList";
import { buildStream, entityHref, type MentionMember, type StreamMessage, type StreamRow } from "@/lib/chat/ui";
import { Composer } from "./Composer";
import { MessageRow, SystemRow } from "./MessageParts";
import type { SpaceItem } from "./types";

const NEAR_BOTTOM_PX = 80;

export function SpaceView({
  spaceId,
  space,
  messages,
  members,
  loading,
  notMember,
  hasEarlier,
  loadingEarlier,
  onLoadEarlier,
  meId,
  canPost,
  onSend,
  onEdit,
  onDelete,
  onCopyLink,
  onOpenThread,
}: {
  spaceId: string | null;
  space: SpaceItem | undefined;
  messages: StreamMessage[];
  members: MentionMember[];
  loading: boolean;
  notMember: boolean;
  hasEarlier: boolean;
  loadingEarlier: boolean;
  onLoadEarlier: () => void;
  meId: string | null;
  canPost: boolean;
  onSend: (body: string) => Promise<boolean>;
  onEdit: (id: string, body: string) => Promise<boolean>;
  onDelete: (id: string) => Promise<void>;
  onCopyLink: () => void;
  /** FC3 — open the right-side thread panel on this root message */
  onOpenThread: (rootId: string) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [editBusy, setEditBusy] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const wrapRef = useRef<HTMLDivElement>(null);
  const stickBottom = useRef(true);
  const prevHeightRef = useRef(0);

  const rows = useMemo<StreamRow[]>(() => buildStream(messages, Date.now()), [messages]);
  const newestId = messages.length ? messages[messages.length - 1].id : null;
  const oldestId = messages.length ? messages[0].id : null;
  const nowMs = Date.now();

  const scrollEl = () => wrapRef.current?.querySelector<HTMLElement>(".fc2-stream-scroll") ?? null;

  // new space or new tail → follow the bottom (unless the reader scrolled up)
  useEffect(() => {
    stickBottom.current = true;
    setEditingId(null);
  }, [spaceId]);
  // the reader's scroll position decides whether we keep following the tail
  // (scroll doesn't bubble — capture it on the wrapper)
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const onScroll = (e: Event) => {
      const el = e.target as HTMLElement;
      if (!el.classList?.contains("fc2-stream-scroll")) return;
      stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    };
    wrap.addEventListener("scroll", onScroll, true);
    return () => wrap.removeEventListener("scroll", onScroll, true);
  }, [spaceId, loading, notMember]);
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
  }, [newestId, spaceId, loading]);

  // "Load earlier" prepends — keep the reader anchored (approximate under
  // estimated row heights; the virtualizer settles as rows measure)
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

  if (!spaceId) {
    return (
      <div style={{ display: "grid", placeItems: "center", height: "100%", color: "var(--h10-text-3)", fontSize: 13, padding: 20, textAlign: "center" }}>
        Select a space — j/k or ↑/↓ to move, Enter to open.
      </div>
    );
  }
  if (notMember) {
    return (
      <div style={{ display: "grid", placeItems: "center", height: "100%", color: "var(--h10-text-3)", fontSize: 13, padding: 20, textAlign: "center" }}>
        You&apos;re not a member of this space. Ask the Owner or a space manager to add you.
      </div>
    );
  }

  const orderHref = space?.entityType && space.entityId ? entityHref(space.entityType, space.entityId) : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minWidth: 0 }}>
      <div className="fc2-space-head">
        <div className="fc2-space-title" title={space?.name}>
          {space?.name ?? "Space"}
        </div>
        {space && (
          <span className="fc2-space-meta">
            {space.memberCount} {space.memberCount === 1 ? "member" : "members"}
          </span>
        )}
        {orderHref && (
          <a href={orderHref} className="fc2-system-chip" style={{ marginLeft: 0 }}>
            Open order <ExternalLink size={10} />
          </a>
        )}
        <button type="button" className="fc2-icon-btn" onClick={onCopyLink} title="Copy link to this space" aria-label="Copy link to this space">
          <Link2 size={14} />
        </button>
      </div>

      {loading && messages.length === 0 ? (
        <div style={{ flex: 1, padding: 20, display: "grid", gap: 12, alignContent: "start" }}>
          <Skeleton />
          <Skeleton />
          <Skeleton />
        </div>
      ) : (
        <div ref={wrapRef} style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          {hasEarlier && (
            <div style={{ textAlign: "center", padding: "6px 0", borderBottom: "1px solid var(--h10-border-subtle)" }}>
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
                {loadingEarlier ? "Loading…" : "Load earlier messages"}
              </button>
            </div>
          )}
          <div style={{ flex: 1, minHeight: 0 }}>
            <WindowedList
              items={rows}
              itemKey={(r) => r.key}
              estimateSize={(i) => {
                const row = rows[i];
                if (row?.kind === "divider") return 36;
                if (row?.kind !== "message") return 26;
                const base = row.runStart ? 54 : 26;
                return row.message.thread?.replyCount ? base + 26 : base;
              }}
              height="100%"
              className="fc2-stream-scroll"
              style={{ padding: "8px 0" }}
              emptyState={
                <div style={{ padding: 24, fontSize: 12.5, color: "var(--h10-text-3)", textAlign: "center" }}>
                  This space is quiet. Say something — the team sees it instantly.
                </div>
              }
              renderItem={(row) =>
                row.kind === "divider" ? (
                  <div className="fc2-day">
                    <span className="fc2-day-chip">{row.label}</span>
                  </div>
                ) : row.message.kind === "SYSTEM" ? (
                  <SystemRow message={row.message} />
                ) : (
                  <MessageRow
                    message={row.message}
                    runStart={row.runStart}
                    own={!!meId && row.message.authorId === meId}
                    members={members}
                    nowMs={nowMs}
                    onStartEdit={() => startEdit(row.message)}
                    onAskDelete={() => setConfirmDeleteId(row.message.id)}
                    editing={editingId === row.message.id}
                    editText={editText}
                    setEditText={setEditText}
                    onSaveEdit={() => void saveEdit()}
                    onCancelEdit={() => setEditingId(null)}
                    editBusy={editBusy}
                    onReply={row.message.pending ? undefined : () => onOpenThread(row.message.id)}
                    onOpenThread={row.message.thread?.replyCount ? () => onOpenThread(row.message.id) : undefined}
                  />
                )
              }
            />
          </div>
        </div>
      )}

      <Composer canPost={canPost} onSend={onSend} composerKey={spaceId} />

      <Modal
        open={!!confirmDeleteId}
        onClose={() => setConfirmDeleteId(null)}
        title="Delete message?"
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
          <li>Everyone in the space sees a &quot;Message deleted&quot; tombstone instead.</li>
          <li>The audit log keeps the original text — deletion is soft, never silent.</li>
        </ul>
      </Modal>
    </div>
  );
}
