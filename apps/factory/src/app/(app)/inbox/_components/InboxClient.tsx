/**
 * FP1.3 — the inbox workspace container: three panes, URL ?focus deep-link,
 * SSE-driven refresh (worker events arrive via the outbox bridge), keyboard
 * grammar (j/k move · Enter open · e close · s snooze · r reply · Esc back).
 * Post-arc fix: pinned grid row (minmax(0,1fr)) so pane scrolling works, and
 * drag-resizable pane widths (persisted; double-click a handle to reset).
 */
"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useToast } from "@/design-system/components";
import { apiJson } from "@/lib/api-client";
import { useFactoryEvents } from "@/lib/use-factory-events";
import { ConversationList } from "./ConversationList";
import { ContextRail } from "./ContextRail";
import { ThreadPane } from "./ThreadPane";
import type { ListResponse, ThreadResponse } from "./types";

// Resizable pane geometry — Owner-adjustable, persisted per browser.
const PANES_KEY = "factory.inbox.paneWidths";
const LIST_DEFAULT = 360;
const RAIL_DEFAULT = 300;
const LIST_MIN = 280;
const LIST_MAX = 640;
const RAIL_MIN = 240;
const RAIL_MAX = 520;
const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);

function PaneHandle({
  onDelta,
  onCommit,
  onReset,
  label,
}: {
  onDelta: (deltaX: number) => void;
  onCommit: () => void;
  onReset: () => void;
  label: string;
}) {
  const drag = useRef<{ pointerId: number; lastX: number } | null>(null);
  const [active, setActive] = useState(false);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      title="Drag to resize · double-click to reset"
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { pointerId: e.pointerId, lastX: e.clientX };
        setActive(true);
      }}
      onPointerMove={(e) => {
        if (drag.current?.pointerId !== e.pointerId) return;
        const delta = e.clientX - drag.current.lastX;
        if (delta !== 0) {
          drag.current.lastX = e.clientX;
          onDelta(delta);
        }
      }}
      onPointerUp={(e) => {
        if (drag.current?.pointerId !== e.pointerId) return;
        drag.current = null;
        setActive(false);
        onCommit();
      }}
      onPointerCancel={() => {
        drag.current = null;
        setActive(false);
        onCommit();
      }}
      onDoubleClick={onReset}
      style={{
        cursor: "col-resize",
        touchAction: "none",
        display: "flex",
        justifyContent: "center",
        background: "transparent",
      }}
    >
      <div
        style={{
          width: active ? 3 : 1,
          height: "100%",
          borderRadius: 2,
          background: active ? "var(--h10-primary)" : "var(--h10-border-subtle)",
          transition: "background 120ms",
        }}
      />
    </div>
  );
}

function InboxInner() {
  const params = useSearchParams();
  const { toast } = useToast();

  const [state, setState] = useState("open");
  const [mine, setMine] = useState(false);
  const [unmatched, setUnmatched] = useState(false);
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [list, setList] = useState<ListResponse | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [thread, setThread] = useState<ThreadResponse | null>(null);
  const [threadLoading, setThreadLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busyBulk, setBusyBulk] = useState(false);
  const [cursorIdx, setCursorIdx] = useState(0);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const [listW, setListW] = useState(LIST_DEFAULT);
  const [railW, setRailW] = useState(RAIL_DEFAULT);
  const widthsRef = useRef({ list: LIST_DEFAULT, rail: RAIL_DEFAULT });

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(PANES_KEY) ?? "{}") as { list?: unknown; rail?: unknown };
      const list = typeof saved.list === "number" ? clamp(saved.list, LIST_MIN, LIST_MAX) : LIST_DEFAULT;
      const rail = typeof saved.rail === "number" ? clamp(saved.rail, RAIL_MIN, RAIL_MAX) : RAIL_DEFAULT;
      widthsRef.current = { list, rail };
      setListW(list);
      setRailW(rail);
    } catch {
      /* defaults stand */
    }
  }, []);

  const persistWidths = useCallback(() => {
    try {
      localStorage.setItem(PANES_KEY, JSON.stringify(widthsRef.current));
    } catch {
      /* private mode etc. — resizing still works for the session */
    }
  }, []);

  const resizeList = useCallback((delta: number) => {
    widthsRef.current.list = clamp(widthsRef.current.list + delta, LIST_MIN, LIST_MAX);
    setListW(widthsRef.current.list);
  }, []);

  const resizeRail = useCallback((delta: number) => {
    // rail handle sits to its LEFT: dragging right shrinks the rail
    widthsRef.current.rail = clamp(widthsRef.current.rail - delta, RAIL_MIN, RAIL_MAX);
    setRailW(widthsRef.current.rail);
  }, []);

  const resetWidths = useCallback(() => {
    widthsRef.current = { list: LIST_DEFAULT, rail: RAIL_DEFAULT };
    setListW(LIST_DEFAULT);
    setRailW(RAIL_DEFAULT);
    persistWidths();
  }, [persistWidths]);

  const focusId = params.get("focus");

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 250);
    return () => clearTimeout(t);
  }, [q]);

  const listUrl = useMemo(() => {
    const usp = new URLSearchParams({ state });
    if (mine) usp.set("mine", "1");
    if (unmatched) usp.set("unmatched", "1");
    if (debouncedQ) usp.set("q", debouncedQ);
    return `/api/inbox?${usp}`;
  }, [state, mine, unmatched, debouncedQ]);

  const loadList = useCallback(
    async (opts?: { append?: boolean; quiet?: boolean }) => {
      if (!opts?.quiet) setListLoading(true);
      try {
        const url = opts?.append && list?.nextCursor ? `${listUrl}&cursor=${list.nextCursor}` : listUrl;
        const data = await apiJson<ListResponse>(url);
        setList((prev) =>
          opts?.append && prev ? { ...data, items: [...prev.items, ...data.items] } : data,
        );
      } catch {
        /* keep last */
      } finally {
        setListLoading(false);
      }
    },
    [listUrl, list?.nextCursor],
  );

  useEffect(() => {
    setCursorIdx(0);
    void loadList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listUrl]);

  const loadThread = useCallback(
    async (id: string, quiet = false) => {
      if (!quiet) setThreadLoading(true);
      try {
        setThread(await apiJson<ThreadResponse>(`/api/inbox/${id}`));
      } catch (e) {
        toast((e as Error).message, "danger");
      } finally {
        setThreadLoading(false);
      }
    },
    [toast],
  );

  useEffect(() => {
    if (focusId) void loadThread(focusId);
    else setThread(null);
  }, [focusId, loadThread]);

  const refresh = useCallback(() => {
    void loadList({ quiet: true });
    if (focusId) void loadThread(focusId, true);
  }, [loadList, loadThread, focusId]);

  useFactoryEvents(["conversation.synced", "conversation.updated", "comment.created"], refresh, {
    debounceMs: 1500,
  });

  // Shallow routing (documented Next interop: history.replaceState syncs with
  // useSearchParams) — router.replace to the bare pathname silently no-ops on
  // a fresh document load at ?focus=, and focus is pure UI state anyway.
  const open = useCallback((id: string) => {
    window.history.replaceState(null, "", `/inbox?focus=${id}`);
  }, []);

  const bulk = async (action: "close" | "open") => {
    setBusyBulk(true);
    try {
      const res = await apiJson<{ ok: number; failed: number }>("/api/inbox/bulk", {
        method: "POST",
        body: JSON.stringify({ ids: [...selected], action }),
      });
      toast(`${res.ok} ${action === "close" ? "closed" : "reopened"}${res.failed ? ` · ${res.failed} failed` : ""}`, res.failed ? "warning" : "success");
      setSelected(new Set());
      refresh();
    } catch (e) {
      toast((e as Error).message, "danger");
    } finally {
      setBusyBulk(false);
    }
  };

  // keyboard grammar — inert while typing in any field
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable;
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      const items = list?.items ?? [];
      if (e.key === "j" || e.key === "k") {
        e.preventDefault();
        setCursorIdx((i) => {
          const next = Math.min(Math.max(i + (e.key === "j" ? 1 : -1), 0), Math.max(items.length - 1, 0));
          document.querySelector(`[data-row="${items[next]?.id}"]`)?.scrollIntoView({ block: "nearest" });
          return next;
        });
      } else if (e.key === "Enter" && items[cursorIdx]) {
        e.preventDefault();
        open(items[cursorIdx].id);
      } else if (e.key === "Escape" && focusId) {
        window.history.replaceState(null, "", "/inbox");
      } else if (e.key === "e" && focusId) {
        e.preventDefault();
        void apiJson(`/api/inbox/${focusId}`, { method: "PATCH", body: JSON.stringify({ state: thread?.conversation.state === "CLOSED" ? "OPEN" : "CLOSED" }) }).then(refresh);
      } else if (e.key === "s" && focusId) {
        e.preventDefault();
        const tomorrow8 = new Date();
        tomorrow8.setDate(tomorrow8.getDate() + 1);
        tomorrow8.setHours(8, 0, 0, 0);
        void apiJson(`/api/inbox/${focusId}`, { method: "PATCH", body: JSON.stringify({ snoozeUntil: tomorrow8.toISOString() }) })
          .then(() => {
            toast("Snoozed until tomorrow 08:00 — replies un-snooze it", "info");
            refresh();
          });
      } else if (e.key === "r" && focusId) {
        e.preventDefault();
        composerRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [list, cursorIdx, focusId, open, refresh, thread?.conversation.state, toast]);

  return (
    <div
      style={{
        height: "calc(100dvh - 52px)",
        display: "grid",
        gridTemplateColumns: `${listW}px 6px minmax(0, 1fr) 6px ${railW}px`,
        gridTemplateRows: "minmax(0, 1fr)",
        border: "1px solid var(--h10-border)",
        borderRadius: 12,
        background: "var(--h10-surface)",
        overflow: "hidden",
      }}
    >
      <div style={{ minWidth: 0, minHeight: 0, overflow: "hidden" }}>
        <ConversationList
          data={list}
          loading={listLoading}
          state={state}
          setState={setState}
          mine={mine}
          setMine={setMine}
          unmatched={unmatched}
          setUnmatched={setUnmatched}
          q={q}
          setQ={setQ}
          focusId={focusId}
          cursorId={list?.items[cursorIdx]?.id ?? null}
          onOpen={open}
          selected={selected}
          setSelected={setSelected}
          onBulk={(a) => void bulk(a)}
          onLoadMore={() => void loadList({ append: true })}
          busyBulk={busyBulk}
        />
      </div>
      <PaneHandle onDelta={resizeList} onCommit={persistWidths} onReset={resetWidths} label="Resize conversation list" />
      <div style={{ minWidth: 0, minHeight: 0, overflow: "hidden" }}>
        <ThreadPane thread={thread} loading={threadLoading} onMutated={refresh} composerRef={composerRef} />
      </div>
      <PaneHandle onDelta={resizeRail} onCommit={persistWidths} onReset={resetWidths} label="Resize context rail" />
      <div style={{ minWidth: 0, minHeight: 0, overflow: "hidden", background: "var(--h10-surface-raised)" }}>
        <ContextRail thread={thread} onMutated={refresh} />
      </div>
    </div>
  );
}

export function InboxClient() {
  return (
    <Suspense fallback={null}>
      <InboxInner />
    </Suspense>
  );
}
