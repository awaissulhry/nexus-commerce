/**
 * FP1.3 → EPI1 — the inbox workspace container: three panes, URL deep-links,
 * SSE-driven refresh (worker events arrive via the outbox bridge), keyboard
 * grammar (j/k move · Enter open · e close · s snooze · r reply · Esc back).
 * EPI1.2: filters live in the URL (?state=&mine=1&unmatched=1&q=) so views
 * survive reload and deep-link; list failures surface with Retry; bulk gains
 * Assign. EPI1.4: panes ride the FS3 substrate (shared PaneHandle +
 * useResizablePanes — keyboard ←→/Home/End resize, Enter collapses the rail),
 * and below 1280px the rail folds into a strip that opens as a Drawer.
 */
"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { PanelRightOpen } from "lucide-react";
import { Drawer, useToast } from "@/design-system/components";
import { PaneHandle } from "@/components/PaneHandle";
import { useResizablePanes, type PaneDef } from "@/components/useResizablePanes";
import { apiJson } from "@/lib/api-client";
import { usePermission } from "@/lib/auth/client";
import { useFactoryEvents } from "@/lib/use-factory-events";
import { ConversationList } from "./ConversationList";
import { ContextRail } from "./ContextRail";
import { ThreadPane } from "./ThreadPane";
import type { ListResponse, ThreadResponse, UserLite } from "./types";

// Pane geometry — Owner-adjustable, persisted per browser (FS3 substrate).
const PANES_KEY = "factory.inbox.paneWidths";
const RAIL_COLLAPSED_KEY = "factory.inbox.railCollapsed";
const PANE_DEFS: PaneDef[] = [
  { min: 280, max: 640, defaultSize: 360 }, // conversation list
  { min: 240, max: 520, defaultSize: 300, invert: true }, // context rail (handle sits on its left)
];
const RAIL_STRIP_W = 36;

function InboxInner() {
  const params = useSearchParams();
  const { toast } = useToast();
  const canAssign = usePermission("inbox.assign");

  // EPI1.2 — filters initialize FROM the URL and write back to it (G16).
  const [state, setState] = useState(() => params.get("state") ?? "open");
  const [mine, setMine] = useState(() => params.get("mine") === "1");
  const [unmatched, setUnmatched] = useState(() => params.get("unmatched") === "1");
  const [q, setQ] = useState(() => params.get("q") ?? "");
  const [debouncedQ, setDebouncedQ] = useState(q);
  const [list, setList] = useState<ListResponse | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [thread, setThread] = useState<ThreadResponse | null>(null);
  const [threadLoading, setThreadLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busyBulk, setBusyBulk] = useState(false);
  const [cursorIdx, setCursorIdx] = useState(0);
  const [users, setUsers] = useState<UserLite[]>([]);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  // EPI1.4 — migrate the pre-EPI {list,rail} object payload to the FS3 array
  // format ONCE, before the hook's hydrate effect reads the key (effects run
  // in registration order, so this effect is declared first).
  useEffect(() => {
    try {
      const raw = localStorage.getItem(PANES_KEY);
      if (!raw) return;
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const legacy = parsed as { list?: unknown; rail?: unknown };
        const listW = typeof legacy.list === "number" ? legacy.list : PANE_DEFS[0].defaultSize;
        const railW = typeof legacy.rail === "number" ? legacy.rail : PANE_DEFS[1].defaultSize;
        localStorage.setItem(PANES_KEY, JSON.stringify([Math.round(listW), Math.round(railW)]));
      }
    } catch {
      /* hook falls back to defaults */
    }
  }, []);
  const panes = useResizablePanes(PANES_KEY, PANE_DEFS);

  // EPI1.4 — rail collapse: explicit (Enter / chevron, persisted) or implied
  // by a narrow window (<1280px folds the rail into a strip + Drawer, D10).
  const [wide, setWide] = useState(true);
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [railDrawer, setRailDrawer] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1280px)");
    const apply = () => setWide(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    try {
      const stored = localStorage.getItem(RAIL_COLLAPSED_KEY);
      if (stored != null) setRailCollapsed(stored === "1");
    } catch {
      /* default stands */
    }
    return () => mq.removeEventListener("change", apply);
  }, []);
  const toggleRail = useCallback(() => {
    setRailCollapsed((v) => {
      try {
        localStorage.setItem(RAIL_COLLAPSED_KEY, v ? "0" : "1");
      } catch {
        /* session-only */
      }
      return !v;
    });
  }, []);
  const railShown = wide && !railCollapsed;

  const focusId = params.get("focus");

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 250);
    return () => clearTimeout(t);
  }, [q]);

  // EPI1.2 — ONE url composer so open/Escape/filter changes all preserve each
  // other (the old open() dropped every filter).
  const urlFor = useCallback(
    (focus: string | null) => {
      const usp = new URLSearchParams();
      if (state !== "open") usp.set("state", state);
      if (mine) usp.set("mine", "1");
      if (unmatched) usp.set("unmatched", "1");
      if (debouncedQ) usp.set("q", debouncedQ);
      if (focus) usp.set("focus", focus);
      const qs = usp.toString();
      return qs ? `/inbox?${qs}` : "/inbox";
    },
    [state, mine, unmatched, debouncedQ],
  );

  // Shallow routing (documented Next interop: history.replaceState syncs with
  // useSearchParams) — router.replace to the bare pathname silently no-ops on
  // a fresh document load at ?focus=, and focus/filters are pure UI state.
  useEffect(() => {
    window.history.replaceState(null, "", urlFor(focusId));
  }, [urlFor, focusId]);

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
        setListError(null);
      } catch (e) {
        // EPI1.2 (G9) — failures used to keep the stale page silently
        setListError((e as Error).message || "Couldn't load the inbox");
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

  useEffect(() => {
    if (!canAssign) return;
    apiJson<{ users: UserLite[] }>("/api/users-lite")
      .then((d) => setUsers(d.users))
      .catch(() => {});
  }, [canAssign]);

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

  // pricing.updated added in EPI1.1 — quote creation refreshes the rail card
  useFactoryEvents(
    ["conversation.synced", "conversation.updated", "comment.created", "pricing.updated"],
    refresh,
    { debounceMs: 1500 },
  );

  const open = useCallback(
    (id: string) => {
      window.history.replaceState(null, "", urlFor(id));
    },
    [urlFor],
  );

  const bulk = async (action: "close" | "open" | "assign", assigneeId?: string | null) => {
    setBusyBulk(true);
    try {
      const res = await apiJson<{ ok: number; failed: number }>("/api/inbox/bulk", {
        method: "POST",
        body: JSON.stringify({ ids: [...selected], action, ...(action === "assign" ? { assigneeId } : {}) }),
      });
      const verb = action === "close" ? "closed" : action === "open" ? "reopened" : "assigned";
      toast(`${res.ok} ${verb}${res.failed ? ` · ${res.failed} failed` : ""}`, res.failed ? "warning" : "success");
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
      // EPI1.5 (verify regression R2) — a focused pane separator owns its own
      // keyboard grammar; Enter there must not double as "open conversation".
      if (typing || e.metaKey || e.ctrlKey || e.altKey || target.closest?.('[role="separator"]')) return;
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
        window.history.replaceState(null, "", urlFor(null));
      } else if (e.key === "e" && focusId) {
        e.preventDefault();
        // EPI1.1 (G6) — refuse to toggle until the focused thread has loaded:
        // the old code read a null thread as CLOSED and mis-toggled.
        if (!thread || thread.conversation.id !== focusId) return;
        const next = thread.conversation.state === "CLOSED" ? "OPEN" : "CLOSED";
        void apiJson(`/api/inbox/${focusId}`, { method: "PATCH", body: JSON.stringify({ state: next }) })
          .then(() => {
            toast(next === "CLOSED" ? "Closed — work done" : "Reopened", "success");
            refresh();
          })
          .catch((err: Error) => toast(err.message, "danger")); // G5 — no more silent failures
      } else if (e.key === "s" && focusId) {
        e.preventDefault();
        const tomorrow8 = new Date();
        tomorrow8.setDate(tomorrow8.getDate() + 1);
        tomorrow8.setHours(8, 0, 0, 0);
        void apiJson(`/api/inbox/${focusId}`, { method: "PATCH", body: JSON.stringify({ snoozeUntil: tomorrow8.toISOString() }) })
          .then(() => {
            toast("Snoozed until tomorrow 08:00 — replies un-snooze it", "info");
            refresh();
          })
          .catch((err: Error) => toast(err.message, "danger")); // G5
      } else if (e.key === "r" && focusId) {
        e.preventDefault();
        composerRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [list, cursorIdx, focusId, open, refresh, thread, toast, urlFor]);

  const railCol = railShown ? `${panes.widths[1]}px` : `${RAIL_STRIP_W}px`;

  return (
    <div
      className="epi-inbox"
      style={{
        height: "calc(100dvh - 52px)",
        display: "grid",
        gridTemplateColumns: `${panes.widths[0]}px 6px minmax(0, 1fr) 6px ${railCol}`,
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
          error={listError}
          onRetry={() => void loadList()}
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
          onBulk={(a, assigneeId) => void bulk(a, assigneeId)}
          onLoadMore={() => void loadList({ append: true })}
          busyBulk={busyBulk}
          canAssign={canAssign}
          users={users}
        />
      </div>
      <PaneHandle {...panes.handleProps(0)} label="Resize conversation list" />
      <div style={{ minWidth: 0, minHeight: 0, overflow: "hidden" }}>
        <ThreadPane thread={thread} loading={threadLoading} onMutated={refresh} composerRef={composerRef} />
      </div>
      <PaneHandle
        {...panes.handleProps(1)}
        label="Resize context rail"
        onToggle={wide ? toggleRail : () => setRailDrawer(true)}
      />
      <div style={{ minWidth: 0, minHeight: 0, overflow: "hidden", background: "var(--h10-surface-raised)" }}>
        {railShown ? (
          <ContextRail thread={thread} onMutated={refresh} />
        ) : (
          <div style={{ display: "grid", justifyItems: "center", paddingTop: 10 }}>
            <button
              type="button"
              onClick={() => (wide ? toggleRail() : setRailDrawer(true))}
              title="Show details"
              aria-label="Show details"
              style={{ background: "none", border: "none", cursor: "pointer", color: "var(--h10-text-2)", padding: 6 }}
            >
              <PanelRightOpen size={16} />
            </button>
          </div>
        )}
      </div>
      {!railShown && (
        <Drawer open={railDrawer} onClose={() => setRailDrawer(false)} title="Details" width={340}>
          <ContextRail thread={thread} onMutated={refresh} />
        </Drawer>
      )}
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
