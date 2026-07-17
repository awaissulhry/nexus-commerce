/**
 * FC2 — the left rail (Google-Chat "Spaces" anatomy): client-side search,
 * activity-sorted rows on WindowedList (windowed from day one — the harness
 * seeds 200 spaces), each row = name (bold while unread) + last-message
 * snippet + relative time + unread badge; ORDER spaces wear a small package
 * icon. Keyboard when the rail is focused: j/k or ↑/↓ move the selection,
 * Enter opens it. Fixed 64px rows keep the keyboard scroll math exact.
 * FC3 — a compact "Threads" section above Spaces (Google's Home-ish):
 * followed threads with unread activity, newest first, bounded 20 by the
 * server; clicking one deep-links space + thread panel.
 */
"use client";

import { useMemo, useRef, useState } from "react";
import { MessageCircle, MessageSquareText, Package, Plus, RefreshCw } from "lucide-react";
import { EmptyState } from "@/design-system/components";
import { Button, Input, Skeleton } from "@/design-system/primitives";
import { WindowedList } from "@/components/WindowedList";
import { clampMove, filterSpaces, formatUnread, railSnippet, relTime, type FollowedThread } from "@/lib/chat/ui";
import type { SpaceItem } from "./types";

const ROW_H = 64;

export function SpaceRail({
  railRef,
  spaces,
  threads,
  error,
  onRetry,
  activeId,
  onOpen,
  onOpenThread,
  canCreate,
  onCreate,
}: {
  railRef: React.RefObject<HTMLDivElement>;
  spaces: SpaceItem[] | null;
  /** FC3 — followed threads with unread activity (server-bounded to 20) */
  threads: FollowedThread[];
  error: string | null;
  onRetry: () => void;
  activeId: string | null;
  onOpen: (id: string) => void;
  onOpenThread: (spaceId: string, rootId: string) => void;
  canCreate: boolean;
  onCreate: () => void;
}) {
  const [q, setQ] = useState("");
  const [cursorIdx, setCursorIdx] = useState(0);
  const listWrapRef = useRef<HTMLDivElement>(null);

  const visible = useMemo(() => filterSpaces(spaces ?? [], q), [spaces, q]);

  const scrollCursorIntoView = (idx: number) => {
    const el = listWrapRef.current?.querySelector<HTMLElement>(".fc2-rail-scroll");
    if (!el) return;
    const top = idx * ROW_H;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight;
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName)) return; // typing in search
    const down = e.key === "j" || e.key === "ArrowDown";
    const up = e.key === "k" || e.key === "ArrowUp";
    if (down || up) {
      e.preventDefault();
      setCursorIdx((i) => {
        const next = clampMove(i, down ? 1 : -1, visible.length);
        if (next >= 0) scrollCursorIntoView(next);
        return next < 0 ? 0 : next;
      });
    } else if (e.key === "Enter" && visible[cursorIdx]) {
      e.preventDefault();
      onOpen(visible[cursorIdx].id);
    }
  };

  const now = Date.now();

  return (
    <div
      ref={railRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      aria-label="Spaces"
      style={{ display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0, outline: "none", borderRight: "0" }}
    >
      <div style={{ padding: "10px 12px 8px", display: "grid", gap: 8, borderBottom: "1px solid var(--h10-border-subtle)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ fontSize: 14.5, fontWeight: 700, flex: 1 }}>Spaces</div>
          {canCreate && (
            <Button onClick={onCreate} aria-label="New space" title="New space">
              <Plus size={14} /> New
            </Button>
          )}
        </div>
        <Input
          value={q}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
            setQ(e.target.value);
            setCursorIdx(0);
          }}
          placeholder="Search spaces…"
          aria-label="Search spaces"
        />
      </div>

      {threads.length > 0 && (
        <div className="fc3-rail-threads">
          <div className="fc3-rail-threads-head">
            <MessageSquareText size={12} /> Threads
          </div>
          <div className="fc3-rail-threads-list">
            {threads.map((t) => (
              <button key={t.rootId} type="button" className="fc3-rail-thread" onClick={() => onOpenThread(t.spaceId, t.rootId)}>
                <span className="fc3-rail-thread-top">
                  <span className="fc3-rail-thread-space">{t.spaceName}</span>
                  <span className="fc2-rail-time">{relTime(t.lastReplyAt, now)}</span>
                </span>
                <span className="fc3-rail-thread-snippet">
                  {t.rootAuthorName ? `${t.rootAuthorName.split(/\s+/)[0]}: ` : ""}
                  {t.snippet}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div ref={listWrapRef} style={{ flex: 1, minHeight: 0 }}>
        {error ? (
          <div style={{ padding: 16, display: "grid", gap: 8, justifyItems: "start" }}>
            <div style={{ fontSize: 12.5, color: "var(--h10-danger, #b42318)" }}>{error}</div>
            <Button onClick={onRetry}>
              <RefreshCw size={13} /> Retry
            </Button>
          </div>
        ) : spaces === null ? (
          <div style={{ padding: 14, display: "grid", gap: 10 }}>
            <Skeleton />
            <Skeleton />
            <Skeleton />
          </div>
        ) : (
          <WindowedList
            items={visible}
            itemKey={(s) => s.id}
            estimateSize={ROW_H}
            height="100%"
            className="fc2-rail-scroll"
            emptyState={
              q.trim() ? (
                <div style={{ padding: 20, fontSize: 12.5, color: "var(--h10-text-3)", textAlign: "center" }}>
                  No spaces match — clear the search.
                </div>
              ) : (
                <EmptyState
                  icon={<MessageCircle size={22} />}
                  title="No spaces yet"
                  description="Order spaces appear here the moment an order is born — or start a custom room."
                  action={canCreate ? <Button variant="primary" onClick={onCreate}>New space</Button> : undefined}
                />
              )
            }
            renderItem={(s, i) => {
              const unread = formatUnread(s.unread);
              const active = s.id === activeId;
              const cursor = i === cursorIdx;
              return (
                <button
                  type="button"
                  className={`fc2-rail-row${active ? " is-active" : ""}${cursor ? " is-cursor" : ""}`}
                  onClick={() => onOpen(s.id)}
                  style={{ height: ROW_H }}
                >
                  <span className="fc2-rail-top">
                    {s.kind === "ORDER" && <Package size={13} className="fc2-rail-kind" aria-label="Order space" />}
                    <span className="fc2-rail-name" style={{ fontWeight: s.unread > 0 ? 700 : 600 }}>
                      {s.name}
                    </span>
                    {/* FC4 — presence: another member of this space is online now */}
                    {s.onlineOthers > 0 && (
                      <span
                        className="fc4-online-dot"
                        title={`${s.onlineOthers} ${s.onlineOthers === 1 ? "member" : "members"} online`}
                        aria-label={`${s.onlineOthers} online`}
                      />
                    )}
                    <span className="fc2-rail-time">{relTime(s.lastMessage?.createdAt ?? s.updatedAt, now)}</span>
                  </span>
                  <span className="fc2-rail-bottom">
                    <span className="fc2-rail-snippet" style={s.unread > 0 ? { color: "var(--h10-text)", fontWeight: 500 } : undefined}>
                      {railSnippet(s.lastMessage)}
                    </span>
                    {unread && <span className="fc2-rail-badge">{unread}</span>}
                  </span>
                </button>
              );
            }}
          />
        )}
      </div>
    </div>
  );
}
