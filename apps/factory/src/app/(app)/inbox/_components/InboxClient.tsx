/**
 * FP1.3 — the inbox workspace container: three panes, URL ?focus deep-link,
 * SSE-driven refresh (worker events arrive via the outbox bridge), keyboard
 * grammar (j/k move · Enter open · e close · s snooze · r reply · Esc back).
 */
"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useToast } from "@/design-system/components";
import { apiJson } from "@/lib/api-client";
import { useFactoryEvents } from "@/lib/use-factory-events";
import { ConversationList } from "./ConversationList";
import { ContextRail } from "./ContextRail";
import { ThreadPane } from "./ThreadPane";
import type { ListResponse, ThreadResponse } from "./types";

function InboxInner() {
  const router = useRouter();
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

  const open = useCallback(
    (id: string) => {
      router.replace(`/inbox?focus=${id}`, { scroll: false });
    },
    [router],
  );

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
        router.replace("/inbox", { scroll: false });
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
  }, [list, cursorIdx, focusId, open, refresh, router, thread?.conversation.state, toast]);

  return (
    <div
      style={{
        height: "calc(100dvh - 52px)",
        display: "grid",
        gridTemplateColumns: "360px minmax(0, 1fr) 300px",
        border: "1px solid var(--h10-border)",
        borderRadius: 12,
        background: "var(--h10-surface)",
        overflow: "hidden",
      }}
    >
      <div style={{ borderRight: "1px solid var(--h10-border-subtle)", minWidth: 0 }}>
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
      <ThreadPane thread={thread} loading={threadLoading} onMutated={refresh} composerRef={composerRef} />
      <div style={{ borderLeft: "1px solid var(--h10-border-subtle)", background: "var(--h10-surface-raised)" }}>
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
