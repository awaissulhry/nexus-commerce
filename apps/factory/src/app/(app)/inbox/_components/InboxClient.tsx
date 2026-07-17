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
import { ExternalLink, Pin, PinOff, PanelRightOpen, Sparkles } from "lucide-react";
import { Drawer, Modal, useToast } from "@/design-system/components";
import { Button } from "@/design-system/primitives";
import { PaneHandle } from "@/components/PaneHandle";
import { useResizablePanes, type PaneDef } from "@/components/useResizablePanes";
import { apiJson } from "@/lib/api-client";
import { usePermission } from "@/lib/auth/client";
import { useFactoryEvents } from "@/lib/use-factory-events";
import { ConversationList } from "./ConversationList";
import { ContextRail } from "./ContextRail";
import { RulesDrawer } from "./RulesDrawer";
import { ThreadPane } from "./ThreadPane";
import { ViewBuilder, type BuilderInitial } from "./ViewBuilder";
import { PointerMenu, PointerMenuItem, ViewsBar } from "./ViewsBar";
import type { ListItem, ListResponse, ThreadResponse, UserLite } from "./types";

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
  const fileId = params.get("file"); // EPI2.2 — lightbox deep link
  const viewId = params.get("view"); // EPI3.3 — active view deep link

  // EPI3.3 — views UI state
  const canViews = usePermission("inbox.views.manage");
  const [builderOpen, setBuilderOpen] = useState(false);
  const [builderInitial, setBuilderInitial] = useState<BuilderInitial | null>(null);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [deleteViewId, setDeleteViewId] = useState<string | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ item: ListItem; x: number; y: number } | null>(null);
  const [routePrompt, setRoutePrompt] = useState<{ viewId: string; viewName: string; domain: string } | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 250);
    return () => clearTimeout(t);
  }, [q]);

  // EPI1.2 — ONE url composer so open/Escape/filter changes all preserve each
  // other (the old open() dropped every filter).
  const urlFor = useCallback(
    (focus: string | null, file?: string | null, view: string | null = viewId) => {
      const usp = new URLSearchParams();
      if (view) usp.set("view", view); // EPI3.3 — the active section survives everything
      if (state !== "open") usp.set("state", state);
      if (mine) usp.set("mine", "1");
      if (unmatched) usp.set("unmatched", "1");
      if (debouncedQ) usp.set("q", debouncedQ);
      if (focus) usp.set("focus", focus);
      if (focus && file) usp.set("file", file); // EPI2.2 — lightbox rides the thread
      const qs = usp.toString();
      return qs ? `/inbox?${qs}` : "/inbox";
    },
    [state, mine, unmatched, debouncedQ, viewId],
  );

  // Shallow routing (documented Next interop: history.replaceState syncs with
  // useSearchParams) — router.replace to the bare pathname silently no-ops on
  // a fresh document load at ?focus=, and focus/filters are pure UI state.
  useEffect(() => {
    window.history.replaceState(null, "", urlFor(focusId, fileId));
  }, [urlFor, focusId, fileId]);

  const listUrl = useMemo(() => {
    const usp = new URLSearchParams({ state });
    if (mine) usp.set("mine", "1");
    if (unmatched) usp.set("unmatched", "1");
    if (debouncedQ) usp.set("q", debouncedQ);
    if (viewId) usp.set("view", viewId); // EPI3.3 — membership scopes rows + counts
    return `/api/inbox?${usp}`;
  }, [state, mine, unmatched, debouncedQ, viewId]);

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

  // EPI3.3 — view plumbing: select/cycle sections, builder + rules drawers,
  // pin/exclude overrides with the Gmail-tabs route-prompt.
  const selectView = useCallback(
    (id: string | null) => {
      window.history.replaceState(null, "", urlFor(focusId, fileId, id));
    },
    [urlFor, focusId, fileId],
  );
  const editView = useCallback(
    async (id: string) => {
      try {
        const d = await apiJson<{ views: (BuilderInitial & { id: string })[] }>("/api/inbox/views");
        const v = d.views.find((x) => x.id === id);
        if (!v) return;
        setBuilderInitial(v);
        setBuilderOpen(true);
      } catch (e) {
        toast((e as Error).message, "danger");
      }
    },
    [toast],
  );
  const moveView = useCallback(
    async (id: string, dir: -1 | 1) => {
      const ids = (list?.views ?? []).map((v) => v.id);
      const i = ids.indexOf(id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= ids.length) return;
      [ids[i], ids[j]] = [ids[j], ids[i]];
      try {
        await apiJson("/api/inbox/views/reorder", { method: "POST", body: JSON.stringify({ ids }) });
        refresh();
      } catch (e) {
        toast((e as Error).message, "danger");
      }
    },
    [list?.views, refresh, toast],
  );
  const pinToView = useCallback(
    async (item: ListItem, targetViewId: string, viewName: string) => {
      try {
        await apiJson(`/api/inbox/${item.id}/view-override`, {
          method: "POST",
          body: JSON.stringify({ viewId: targetViewId, mode: "pin" }),
        });
        toast(`Pinned to ${viewName}`, "success");
        refresh();
        const from = item.messages[0]?.fromAddress ?? "";
        const domain = from.includes("@") ? from.split("@")[1] : null;
        if (domain && canViews) setRoutePrompt({ viewId: targetViewId, viewName, domain });
      } catch (e) {
        toast((e as Error).message, "danger");
      }
    },
    [refresh, toast, canViews],
  );
  const addRouteCriterion = useCallback(async () => {
    if (!routePrompt) return;
    try {
      const d = await apiJson<{ views: { id: string; criteria: { all: unknown[]; any: unknown[] } }[] }>("/api/inbox/views");
      const v = d.views.find((x) => x.id === routePrompt.viewId);
      if (!v) return;
      const criteria = {
        all: v.criteria.all,
        any: [...v.criteria.any, { field: "senderDomain", op: "is", value: routePrompt.domain }],
      };
      await apiJson(`/api/inbox/views/${routePrompt.viewId}`, { method: "PATCH", body: JSON.stringify({ criteria }) });
      toast(`Future mail from @${routePrompt.domain} routes to ${routePrompt.viewName}`, "success");
      refresh();
    } catch (e) {
      toast((e as Error).message, "danger");
    } finally {
      setRoutePrompt(null);
    }
  }, [routePrompt, refresh, toast]);

  // keyboard grammar — inert while typing in any field
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable;
      // EPI1.5 (verify regression R2) — a focused pane separator owns its own
      // keyboard grammar; Enter there must not double as "open conversation".
      // EPI2.2 — same for the lightbox dialog (j/k/e/s must be inert inside).
      if (typing || e.metaKey || e.ctrlKey || e.altKey || target.closest?.('[role="separator"], [role="dialog"]')) return;
      // EPI3.3 — Tab cycles sections, but ONLY from the page background so
      // keyboard focus navigation (panes, buttons) stays intact.
      if (e.key === "Tab" && document.activeElement === document.body && (list?.views?.length ?? 0) > 0) {
        e.preventDefault();
        const ring: (string | null)[] = [null, ...(list?.views ?? []).map((v) => v.id)];
        const cur = ring.indexOf(viewId);
        const next = ring[(cur + (e.shiftKey ? -1 : 1) + ring.length) % ring.length];
        selectView(next);
        return;
      }
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
  }, [list, cursorIdx, focusId, open, refresh, thread, toast, urlFor, viewId, selectView]);

  const railCol = railShown ? `${panes.widths[1]}px` : `${RAIL_STRIP_W}px`;
  const activeViewMeta = viewId ? (list?.views ?? []).find((v) => v.id === viewId) ?? null : null;

  return (
    <div className="epi-inbox" style={{ height: "calc(100dvh - 52px)", display: "flex", flexDirection: "column" }}>
      <ViewsBar
        views={list?.views ?? []}
        inboxCount={list?.inboxCount ?? null}
        activeViewId={viewId}
        onSelect={selectView}
        canManage={canViews}
        onNewView={() => {
          setBuilderInitial(null);
          setBuilderOpen(true);
        }}
        onEditView={(id) => void editView(id)}
        onMoveView={(id, dir) => void moveView(id, dir)}
        onDeleteView={(id) => setDeleteViewId(id)}
        onOpenRules={() => setRulesOpen(true)}
      />
    <div
      style={{
        flex: 1,
        minHeight: 0,
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
          onRowMenu={(item, x, y) => setCtxMenu({ item, x, y })}
        />
      </div>
      <PaneHandle {...panes.handleProps(0)} label="Resize conversation list" />
      <div style={{ minWidth: 0, minHeight: 0, overflow: "hidden" }}>
        <ThreadPane
          thread={thread}
          loading={threadLoading}
          onMutated={refresh}
          composerRef={composerRef}
          fileId={fileId}
          onFileChange={(fid) => window.history.replaceState(null, "", urlFor(focusId, fid))}
        />
      </div>
      <PaneHandle
        {...panes.handleProps(1)}
        label="Resize context rail"
        onToggle={wide ? toggleRail : () => setRailDrawer(true)}
      />
      <div style={{ minWidth: 0, minHeight: 0, overflow: "hidden", background: "var(--h10-surface-raised)" }}>
        {railShown ? (
          <ContextRail thread={thread} onMutated={refresh} onFileOpen={(fid) => window.history.replaceState(null, "", urlFor(focusId, fid))} />
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
          <ContextRail
            thread={thread}
            onMutated={refresh}
            onFileOpen={(fid) => {
              setRailDrawer(false); // lightbox takes the stage
              window.history.replaceState(null, "", urlFor(focusId, fid));
            }}
          />
        </Drawer>
      )}
    </div>

      {/* EPI3.3 — row context menu: open / pin into sections / new view from sender */}
      {ctxMenu && (
        <PointerMenu x={ctxMenu.x} y={ctxMenu.y} onClose={() => setCtxMenu(null)}>
          <PointerMenuItem
            onSelect={() => {
              open(ctxMenu.item.id);
              setCtxMenu(null);
            }}
          >
            <ExternalLink size={13} /> Open
          </PointerMenuItem>
          {canAssign &&
            (list?.views ?? []).slice(0, 8).map((v) => (
              <PointerMenuItem
                key={v.id}
                onSelect={() => {
                  void pinToView(ctxMenu.item, v.id, v.name);
                  setCtxMenu(null);
                }}
              >
                <Pin size={13} /> Pin to {v.emoji ? `${v.emoji} ` : ""}{v.name}
              </PointerMenuItem>
            ))}
          {canAssign && activeViewMeta && (
            <PointerMenuItem
              onSelect={() => {
                void apiJson(`/api/inbox/${ctxMenu.item.id}/view-override`, {
                  method: "POST",
                  body: JSON.stringify({ viewId: activeViewMeta.id, mode: "exclude" }),
                })
                  .then(() => {
                    toast(`Excluded from ${activeViewMeta.name} — back in the Inbox`, "success");
                    refresh();
                  })
                  .catch((err: Error) => toast(err.message, "danger"));
                setCtxMenu(null);
              }}
            >
              <PinOff size={13} /> Exclude from {activeViewMeta.name}
            </PointerMenuItem>
          )}
          {canViews && (
            <PointerMenuItem
              onSelect={() => {
                const from = ctxMenu.item.messages[0]?.fromAddress ?? "";
                const domain = from.includes("@") ? from.split("@")[1] : "";
                setBuilderInitial({
                  name: ctxMenu.item.party?.name ?? domain,
                  criteria: {
                    all: [],
                    any: [
                      ...(from ? [{ field: "senderEmail", op: "is", value: from }] : []),
                      ...(domain ? [{ field: "senderDomain", op: "is", value: domain }] : []),
                    ],
                  },
                });
                setBuilderOpen(true);
                setCtxMenu(null);
              }}
            >
              <Sparkles size={13} /> New view from this sender…
            </PointerMenuItem>
          )}
        </PointerMenu>
      )}

      <ViewBuilder
        open={builderOpen}
        initial={builderInitial}
        onClose={() => setBuilderOpen(false)}
        onSaved={() => {
          setBuilderOpen(false);
          refresh();
        }}
      />
      <RulesDrawer open={rulesOpen} onClose={() => setRulesOpen(false)} onChanged={refresh} />

      <Modal
        open={deleteViewId != null}
        onClose={() => setDeleteViewId(null)}
        title="Delete this view?"
        footer={
          <>
            <Button onClick={() => setDeleteViewId(null)}>Cancel</Button>
            <Button
              variant="primary"
              onClick={() => {
                const id = deleteViewId!;
                setDeleteViewId(null);
                void apiJson(`/api/inbox/views/${id}`, { method: "DELETE" })
                  .then(() => {
                    if (viewId === id) selectView(null);
                    toast("View deleted — its conversations are back in the Inbox", "success");
                    refresh();
                  })
                  .catch((err: Error) => toast(err.message, "danger"));
              }}
            >
              Delete view
            </Button>
          </>
        }
      >
        <div style={{ fontSize: 12.5 }}>Its conversations return to the Inbox — nothing is deleted but the section definition.</div>
      </Modal>

      <Modal
        open={routePrompt != null}
        onClose={() => setRoutePrompt(null)}
        title={routePrompt ? `Route future mail from @${routePrompt.domain}?` : ""}
        footer={
          <>
            <Button onClick={() => setRoutePrompt(null)}>Just this pin</Button>
            <Button variant="primary" onClick={() => void addRouteCriterion()}>
              Route the whole domain here
            </Button>
          </>
        }
      >
        <div style={{ fontSize: 12.5 }}>
          Adds a visible condition to {routePrompt?.viewName} — every future email from @{routePrompt?.domain} lands there
          automatically (Gmail-tabs pattern; you can edit it any time).
        </div>
      </Modal>
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
