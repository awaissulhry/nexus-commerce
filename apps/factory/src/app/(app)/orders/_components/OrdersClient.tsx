/**
 * FP4 → EPO1.4 — the orders operational board: three live counters, state
 * tabs, party filter, search, and two views. GRID: the state pill is a
 * transition menu (only legal edges, server-validated) with Undo. KANBAN:
 * drag between lanes = a validated command. SHIPPED is label-driven (C1):
 * moving there routes to the Shipping buy flow — the FP8-era manual modal is
 * gone. Transitions carry the row's read stamp (D-6): a 409 means the order
 * changed elsewhere. Clicking a number opens OrderDetail. Deep-link ?o=.
 */
"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { PageHeader, BulkActionBar } from "@/design-system/patterns";
import { Card, Menu, Modal, useToast } from "@/design-system/components";
import { Button, Pill, Skeleton } from "@/design-system/primitives";
import { VirtualDataGrid } from "@/components/VirtualDataGrid"; // FS3 — EPO.7 adoption (assigned)
import { AsyncCombobox, type SearchLoader } from "@/components/AsyncCombobox"; // FS3 — paged party filter
import { eur } from "@/design-system/lib/format";
import { apiJson } from "@/lib/api-client";
import { useFactoryEvents } from "@/lib/use-factory-events";
import { usePermission } from "@/lib/auth/client";
import { BOARD_LANES, canTransition, legalTargets, ORDER_STATE_LABEL } from "@/lib/orders/transitions";
import { paymentBadge } from "@/lib/orders/money";
import { OrderDetail } from "./OrderDetail";
import { KanbanBoard, type LaneData } from "./KanbanBoard";
import { STATE_TONE, type OrderRow, type OrdersResponse, type OrderState } from "./types";

const TABS: { id: string; label: string }[] = [
  { id: "attention", label: "Needs attention" }, // EPO.4 — the default: only actionable rows
  { id: "all", label: "All" },
  { id: "confirmed", label: "Confirmed" },
  { id: "in_production", label: "In production" },
  { id: "ready", label: "Ready" },
  { id: "shipped", label: "Shipped" },
  { id: "delivered", label: "Delivered" },
  { id: "cancelled", label: "Cancelled" },
];

/** EPO.4 — reason chips for the cockpit (M2: fulfillment-side vocabulary) */
const REASON_UI: Record<string, { label: string; tone: "danger" | "warning" | "info" }> = {
  late: { label: "late", tone: "danger" },
  "at-risk": { label: "at risk", tone: "warning" },
  "deposit-blocked": { label: "deposit blocking", tone: "warning" },
  stalled: { label: "stalled", tone: "info" },
};

// EPO.7 (FS3) — paged type-to-find party filter over /api/parties-lite?q=
const loadPartyOptions: SearchLoader = async (q, cursor) => {
  const usp = new URLSearchParams({ q });
  if (cursor) usp.set("cursor", cursor);
  const d = await apiJson<{ parties: { id: string; name: string }[]; nextCursor?: string | null }>(`/api/parties-lite?${usp}`);
  const options = d.parties.map((p) => ({ value: p.id, label: p.name }));
  return { options: !q && !cursor ? [{ value: "", label: "All parties" }, ...options] : options, nextCursor: d.nextCursor ?? null };
};

const undoBtn: React.CSSProperties = { background: "none", border: "none", padding: 0, color: "inherit", textDecoration: "underline", cursor: "pointer", font: "inherit" };
const toggleBtn = (active: boolean): React.CSSProperties => ({ border: "none", cursor: "pointer", fontSize: 12, fontWeight: 600, padding: "5px 12px", background: active ? "var(--h10-primary)" : "var(--h10-surface)", color: active ? "#fff" : "var(--h10-text-2)" });

function Counter({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div style={{ border: "1px solid var(--h10-border-subtle)", borderRadius: 10, padding: "8px 14px", minWidth: 120 }}>
      <div style={{ fontSize: 22, fontWeight: 800, color: tone }}>{value}</div>
      <div style={{ fontSize: 11.5, color: "var(--h10-text-3)" }}>{label}</div>
    </div>
  );
}

/** EPO.2 — ONE coarse payment word per row (NetSuite/ERPNext vocabulary); strip-blind callers get "—". */
const BADGE_UI: Record<string, { label: string; tone: "success" | "info" | "warning" | "neutral" }> = {
  paid: { label: "paid", tone: "success" },
  invoiced: { label: "invoiced", tone: "info" },
  "deposit-due": { label: "deposit due", tone: "warning" },
  "deposit-paid": { label: "deposit paid", tone: "success" },
  unpaid: { label: "unpaid", tone: "neutral" },
};

function PaymentChip({ r }: { r: OrderRow }) {
  const b = paymentBadge(r);
  if (!b) return <span style={{ color: "var(--h10-text-3)" }}>—</span>;
  const ui = BADGE_UI[b];
  return <Pill tone={ui.tone}>{ui.label}</Pill>;
}

function PipelineInner() {
  const params = useSearchParams();
  const { toast } = useToast();
  const canEdit = usePermission("orders.edit");
  const canCancel = usePermission("orders.cancel");
  const canMargin = usePermission("financials.margins.view");
  const [data, setData] = useState<OrdersResponse | null>(null);
  const [view, setView] = useState<"grid" | "kanban">("grid");
  const [state, setState] = useState("attention"); // EPO.4 — the cockpit is the default view
  const [q, setQ] = useState("");
  const [fromDate, setFromDate] = useState(""); // EPO.4 — created-at range
  const [toDate, setToDate] = useState("");
  // EPO.7 (D-5) — the party filter lives in the URL: /orders?party=<id> is the
  // brand-view contract other pages deep-link to; Back/Forward restore it.
  const partyId = params.get("party") ?? "";
  const [partyLabel, setPartyLabel] = useState("");
  const [gridExtra, setGridExtra] = useState<OrderRow[]>([]); // EPO.7 (C6) — cursor pages appended past the first
  const [gridCursor, setGridCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set()); // EPO.7 (E9) — bulk selection
  const [bulkCancelling, setBulkCancelling] = useState(false);
  const [cancelling, setCancelling] = useState<OrderRow | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const openId = params.get("o");
  const gridRows = [...(data?.orders ?? []), ...gridExtra]; // EPO.7 — first page + appended cursor pages
  const toggleSelected = (id: string) => setSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const clearSelection = () => setSelected(new Set());

  useEffect(() => { const v = localStorage.getItem("factory:orders:view"); if (v === "kanban" || v === "grid") setView(v); }, []);
  const switchView = (v: "grid" | "kanban") => { setView(v); localStorage.setItem("factory:orders:view", v); };

  const [lanes, setLanes] = useState<Record<string, LaneData>>({});

  const laneUrl = useCallback((laneState: string, cursor?: string) => {
    const usp = new URLSearchParams({ lane: laneState });
    if (q.trim()) usp.set("q", q.trim());
    if (partyId) usp.set("partyId", partyId);
    if (cursor) usp.set("cursor", cursor);
    return `/api/orders?${usp}`;
  }, [q, partyId]);

  const load = useCallback(async () => {
    try {
      if (view === "kanban") {
        // FS1 (C-1) — each lane fetched bounded + cursored, counters via
        // countsOnly; the old single state=all call dropped everything past 200.
        const usp = new URLSearchParams({ state: "all", countsOnly: "1" });
        if (q.trim()) usp.set("q", q.trim());
        if (partyId) usp.set("partyId", partyId);
        const [countsRes, ...laneRes] = await Promise.all([
          apiJson<OrdersResponse>(`/api/orders?${usp}`),
          ...BOARD_LANES.map((s) => apiJson<OrdersResponse>(laneUrl(s))),
        ]);
        setData(countsRes);
        setLanes(Object.fromEntries(BOARD_LANES.map((s, i) => [s, {
          rows: laneRes[i].orders,
          total: countsRes.counts?.[s] ?? laneRes[i].orders.length,
          nextCursor: laneRes[i].nextCursor ?? null,
        }])));
      } else {
        // EPO.4 — the cockpit is a mode, not a state filter
        const usp = state === "attention" ? new URLSearchParams({ attention: "1" }) : new URLSearchParams({ state });
        if (q.trim()) usp.set("q", q.trim());
        if (partyId) usp.set("partyId", partyId);
        if (fromDate) usp.set("from", fromDate);
        if (toDate) usp.set("to", toDate);
        const res = await apiJson<OrdersResponse>(`/api/orders?${usp}`);
        setData(res);
        setGridExtra([]); // EPO.7 — a fresh filter drops any appended cursor pages…
        setGridCursor(res.nextCursor ?? null);
        setSelected(new Set()); // …and any selection (the rows changed under it)
      }
    } catch (e) {
      toast((e as Error).message, "danger");
    }
  }, [view, state, q, partyId, fromDate, toDate, laneUrl, toast]);

  // EPO.7 (C6) — the grid no longer silently caps at 200: the API cursor is now
  // consumed. VirtualDataGrid windows the DOM, so appended pages stay cheap.
  const loadMoreGrid = useCallback(async () => {
    if (!gridCursor) return;
    const usp = state === "attention" ? new URLSearchParams({ attention: "1" }) : new URLSearchParams({ state });
    if (q.trim()) usp.set("q", q.trim());
    if (partyId) usp.set("partyId", partyId);
    if (fromDate) usp.set("from", fromDate);
    if (toDate) usp.set("to", toDate);
    usp.set("cursor", gridCursor);
    try {
      const res = await apiJson<OrdersResponse>(`/api/orders?${usp}`);
      setGridExtra((prev) => [...prev, ...res.orders]);
      setGridCursor(res.nextCursor ?? null);
    } catch (e) { toast((e as Error).message, "danger"); }
  }, [gridCursor, state, q, partyId, fromDate, toDate, toast]);

  const loadMoreLane = useCallback(async (laneState: string) => {
    const lane = lanes[laneState];
    if (!lane?.nextCursor) return;
    try {
      const res = await apiJson<OrdersResponse>(laneUrl(laneState, lane.nextCursor));
      setLanes((prev) => ({ ...prev, [laneState]: { ...lane, rows: [...lane.rows, ...res.orders], nextCursor: res.nextCursor ?? null } }));
    } catch (e) {
      toast((e as Error).message, "danger");
    }
  }, [lanes, laneUrl, toast]);
  useEffect(() => { const t = setTimeout(() => void load(), 200); return () => clearTimeout(t); }, [load]);
  // EPO.7 (D-5) — resolve the label for a party arriving via a bare ?party= deep
  // link (another page linked in) so the brand chip reads the name, not the id.
  useEffect(() => {
    if (!partyId) { setPartyLabel(""); return; }
    if (partyLabel) return;
    apiJson<{ parties: { id: string; name: string }[] }>(`/api/parties-lite`).then((d) => setPartyLabel(d.parties.find((p) => p.id === partyId)?.name ?? "")).catch(() => {});
  }, [partyId, partyLabel]);
  // EPO.3 (E11) — the board goes live: FS2's durable bus, 2s debounce; a
  // transition in another window/tab lands here without a manual refresh
  useFactoryEvents(["order.updated", "workorder.created", "workorder.updated", "shipment.updated", "payment.recorded"], load);

  // EPO.7 (D-5) — the party filter is URL state; other pages deep-link /orders?party=<id>
  const setPartyFilter = (id: string, label: string) => {
    const usp = new URLSearchParams(window.location.search);
    if (id) usp.set("party", id); else usp.delete("party");
    usp.delete("o"); // filtering closes any open detail
    setPartyLabel(id ? label : "");
    window.history.pushState(null, "", `/orders${usp.toString() ? `?${usp}` : ""}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  };

  // EPO.7 (E12) — pushState so the browser Back button closes the detail
  // (was replaceState — Back skipped it). The party filter is preserved.
  const openDetail = (id: string) => {
    const usp = new URLSearchParams(window.location.search);
    usp.set("o", id);
    window.history.pushState(null, "", `/orders?${usp}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  };
  const closeDetail = () => {
    const usp = new URLSearchParams(window.location.search);
    usp.delete("o");
    window.history.pushState(null, "", `/orders${usp.toString() ? `?${usp}` : ""}`);
    window.dispatchEvent(new PopStateEvent("popstate")); // onPop reloads the list
  };
  // returning to the list via the browser Back button reloads it
  useEffect(() => {
    const onPop = () => { if (!new URLSearchParams(window.location.search).get("o")) void load(); };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [load]);

  const transition = async (row: OrderRow, to: OrderState) => {
    if (to === "CANCELLED") { setCancelling(row); setReason(""); return; }
    // EPO1.4 (C1) — SHIPPED is label-driven: the buy flow flips the state
    if (to === "SHIPPED") { window.location.href = `/shipping?buy=${row.id}`; return; }
    const from = row.state;
    try {
      await apiJson(`/api/orders/${row.id}`, { method: "PATCH", body: JSON.stringify({ state: to, expectedUpdatedAt: row.updatedAt }) });
      void load();
      const canUndo = canTransition(to, from).ok;
      toast(<span>Moved to {ORDER_STATE_LABEL[to]}{canUndo ? <> · <button type="button" onClick={() => void undo(row.id, from)} style={undoBtn}>Undo</button></> : null}</span>, "success");
    } catch (e) {
      const msg = (e as Error).message;
      toast(/start production/i.test(msg) ? "Use Start production to begin — it creates the work order." : msg, "danger");
      if (/changed elsewhere/i.test(msg)) void load(); // D-6: refresh the stale row
    }
  };
  const undo = async (id: string, back: OrderState) => {
    try { await apiJson(`/api/orders/${id}`, { method: "PATCH", body: JSON.stringify({ state: back }) }); void load(); toast("Reverted", "info"); }
    catch (e) { toast((e as Error).message, "danger"); }
  };
  const startProduction = async (row: OrderRow) => {
    try {
      const r = await apiJson<{ workOrders: number; blocked: boolean }>(`/api/orders/${row.id}/start-production`, { method: "POST", body: "{}" });
      void load();
      toast(r.blocked ? `${r.workOrders} work order(s) created — blocked until deposit` : `Production started — ${r.workOrders} ready`, r.blocked ? "warning" : "success");
    } catch (e) { toast((e as Error).message, "danger"); }
  };
  // kanban drop: CONFIRMED→In production means Start production; else a plain transition
  const onMove = (row: OrderRow, to: OrderState) => {
    if (row.state === "CONFIRMED" && to === "IN_PRODUCTION") { void startProduction(row); return; }
    void transition(row, to);
  };

  const confirmCancel = async () => {
    if (!cancelling || !reason.trim()) return;
    setBusy(true);
    try { await apiJson(`/api/orders/${cancelling.id}/cancel`, { method: "POST", body: JSON.stringify({ reason: reason.trim() }) }); setCancelling(null); void load(); toast("Order cancelled", "info"); }
    catch (e) { toast((e as Error).message, "danger"); } finally { setBusy(false); }
  };

  // EPO.7 (E9) — bulk cancel: ONE reason for the selection, each order still
  // validated + audited server-side (no bulk endpoint that bypasses the guard).
  const bulkCancellable = gridRows.filter((r) => selected.has(r.id) && legalTargets(r.state).includes("CANCELLED"));
  const confirmBulkCancel = async () => {
    if (!reason.trim() || bulkCancellable.length === 0) return;
    setBusy(true);
    let ok = 0;
    for (const r of bulkCancellable) {
      try { await apiJson(`/api/orders/${r.id}/cancel`, { method: "POST", body: JSON.stringify({ reason: reason.trim() }) }); ok++; }
      catch { /* per-order failure surfaced in the count */ }
    }
    setBulkCancelling(false); setReason(""); clearSelection(); void load(); setBusy(false);
    toast(ok === bulkCancellable.length ? `${ok} order(s) cancelled` : `${ok} of ${bulkCancellable.length} cancelled — the rest couldn't be`, ok > 0 ? "info" : "danger");
  };

  // EPO.7 (E9) — the CSV export honors the active filters (mirror of the list query)
  const exportHref = () => {
    const usp = new URLSearchParams();
    if (state !== "attention" && state !== "all") usp.set("state", state);
    if (q.trim()) usp.set("q", q.trim());
    if (partyId) usp.set("partyId", partyId);
    if (fromDate) usp.set("from", fromDate);
    if (toDate) usp.set("to", toDate);
    return `/api/exports/orders${usp.toString() ? `?${usp}` : ""}`;
  };
  const stateCell = (r: OrderRow) => {
    const pill = <Pill tone={STATE_TONE[r.state]}>{ORDER_STATE_LABEL[r.state]}</Pill>;
    const targets = legalTargets(r.state).filter((t) => t !== "IN_PRODUCTION" || r.state !== "CONFIRMED");
    const items = targets.filter((t) => t !== "CANCELLED" || canCancel).map((t) => ({ id: t, label: t === "SHIPPED" ? <>→ Shipped — buy label</> : <>→ {ORDER_STATE_LABEL[t]}</>, onSelect: () => void transition(r, t) }));
    if (!canEdit || items.length === 0) return <span style={{ display: "inline-flex", gap: 5, alignItems: "center" }}>{pill}{r.woBlocked && <Pill tone="warning">blocked</Pill>}</span>;
    return (
      <span style={{ display: "inline-flex", gap: 5, alignItems: "center" }}>
        <Menu align="left" label={pill} items={items} triggerProps={{ style: { background: "none", border: "none", padding: 0, cursor: "pointer" }, title: "Change status" }} />
        {r.woBlocked && <Pill tone="warning">blocked</Pill>}
      </span>
    );
  };

  if (openId) return <OrderDetail orderId={openId} onBack={closeDetail} />;

  return (
    <div className="factory-page factory-grid-grow-2">
      <PageHeader eyebrow="Factory OS" title="Orders" subtitle="The operational board: every confirmed job, its lifecycle, its money, and one click to its whole story." />
      <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
        <Counter label="In production" value={data?.counters.inProduction ?? 0} tone="var(--h10-primary)" />
        <Counter label="Awaiting deposit" value={data?.counters.awaitingDeposit ?? 0} tone={data && data.counters.awaitingDeposit > 0 ? "var(--h10-warning)" : "var(--h10-text-3)"} />
        <Counter label="Overdue" value={data?.counters.overdue ?? 0} tone={data && data.counters.overdue > 0 ? "var(--h10-danger)" : "var(--h10-text-3)"} />
        <div style={{ marginLeft: "auto", alignSelf: "center", display: "flex", gap: 12, alignItems: "center" }}>
          <a href={exportHref()} style={{ fontSize: 12, color: "var(--h10-text-link)" }}>Export CSV</a>
          <div style={{ display: "flex", border: "1px solid var(--h10-border)", borderRadius: 8, overflow: "hidden" }}>
            <button type="button" onClick={() => switchView("grid")} style={toggleBtn(view === "grid")}>Grid</button>
            <button type="button" onClick={() => switchView("kanban")} style={toggleBtn(view === "kanban")}>Kanban</button>
          </div>
        </div>
      </div>
      <Card padded>
        <div style={{ display: "flex", gap: 8, marginBottom: 10, alignItems: "center", flexWrap: "wrap" }}>
          {view === "grid" && (
            <div style={{ display: "flex", gap: 4 }}>
              {TABS.map((t) => (
                <button key={t.id} type="button" onClick={() => setState(t.id)} style={{ border: "none", cursor: "pointer", fontSize: 12.5, fontWeight: 600, padding: "5px 10px", borderRadius: 8, background: state === t.id ? "var(--h10-primary)" : "transparent", color: state === t.id ? "#fff" : "var(--h10-text-2)" }}>
                  {t.label}{t.id !== "all" && data?.counts[t.id.toUpperCase()] ? <span style={{ marginLeft: 5, fontSize: 10.5, opacity: 0.85 }}>{data.counts[t.id.toUpperCase()]}</span> : null}
                </button>
              ))}
            </div>
          )}
          <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
            {/* EPO.7 (D-5) — the brand-view chip: a party arriving via ?party= (a
                deep link from Contacts/Financials) reads as a dismissible filter */}
            {partyId ? (
              <button type="button" onClick={() => setPartyFilter("", "")} title="Clear brand filter" style={{ display: "inline-flex", gap: 5, alignItems: "center", border: "1px solid var(--h10-primary)", background: "var(--h10-wash-primary, rgba(31,111,222,0.08))", color: "var(--h10-primary)", borderRadius: 999, padding: "4px 10px", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
                {partyLabel || "Brand"} <span aria-hidden style={{ fontSize: 14, lineHeight: 1 }}>×</span>
              </button>
            ) : (
              <div style={{ minWidth: 190 }}>
                {/* FS3 — paged type-to-find party filter (was a whole-list Listbox) */}
                <AsyncCombobox loader={loadPartyOptions} value={partyId} placeholder="All parties" ariaLabel="Filter by party" onChange={(v, opt) => setPartyFilter(v, opt.label)} />
              </div>
            )}
            {/* EPO.4 — created-at range */}
            {view === "grid" && (
              <span style={{ display: "inline-flex", gap: 4, alignItems: "center", fontSize: 11.5, color: "var(--h10-text-3)" }}>
                <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} aria-label="Created from" style={{ border: "1px solid var(--h10-border)", borderRadius: 8, padding: "4px 6px", fontSize: 11.5, background: "var(--h10-surface)", color: "var(--h10-text)" }} />
                –
                <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} aria-label="Created to" style={{ border: "1px solid var(--h10-border)", borderRadius: 8, padding: "4px 6px", fontSize: 11.5, background: "var(--h10-surface)", color: "var(--h10-text)" }} />
              </span>
            )}
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search number or party…" style={{ border: "1px solid var(--h10-border)", borderRadius: 8, padding: "5px 9px", fontSize: 12.5, outline: "none", background: "var(--h10-surface)", color: "var(--h10-text)", minWidth: 200 }} />
          </div>
        </div>
        {view === "grid" && data == null ? (
          // EPO.7 (E12) — skeleton on first load; no more empty-state flash
          <div style={{ display: "grid", gap: 8, padding: "4px 0" }}>{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} height={34} />)}</div>
        ) : view === "grid" ? (
          <VirtualDataGrid
            height="calc(100dvh - 340px)"
            columns={[
              // EPO.7 (E9) — bulk selection. (No client column sort: with cursor
              // pagination it would reorder only the LOADED rows — the server's
              // promise-asc sort stays the single truth across pages.)
              { key: "select", label: "", width: 34, render: (r: OrderRow) => <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggleSelected(r.id)} aria-label={`Select ${r.number}`} /> },
              { key: "number", label: "Order", render: (r: OrderRow) => <span style={{ display: "inline-flex", gap: 5, alignItems: "center" }}><button type="button" onClick={() => openDetail(r.id)} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", font: "inherit", fontWeight: 700, color: "var(--h10-text-link)" }}>{r.number}</button>{r.urgent && <Pill tone="danger">urgent</Pill>}</span> },
              // EPO.4 — cockpit mode leads with WHY the row needs attention
              ...(state === "attention" ? [{ key: "why", label: "Why", render: (r: OrderRow) => <span style={{ display: "inline-flex", gap: 4, flexWrap: "wrap" as const }}>{(r.attention ?? []).map((a) => { const ui = REASON_UI[a]; return ui ? <Pill key={a} tone={ui.tone}>{ui.label}</Pill> : null; })}</span> }] : []),
              { key: "party", label: "Party", render: (r: OrderRow) => <a href={`/contacts?c=${r.party.id}`} style={{ color: "inherit", textDecoration: "none" }} onMouseEnter={(e) => { (e.target as HTMLElement).style.color = "var(--h10-text-link)"; }} onMouseLeave={(e) => { (e.target as HTMLElement).style.color = "inherit"; }}>{r.party.name}</a> }, // EPO.3 (E2) — party hops to contacts
              { key: "state", label: "State", render: stateCell },
              // EPO.2 (C7) — stripped money renders "—", never a misleading €0,00
              { key: "net", label: "Net", align: "right" as const, render: (r: OrderRow) => (r.netCents != null && r.lineCount ? eur(r.netCents) : "—") },
              // EPO.2 — balance owed; red once the goods are delivered but unpaid
              { key: "balance", label: "Balance", align: "right" as const, render: (r: OrderRow) => (r.balanceCents != null && r.lineCount ? <span style={{ color: r.balanceCents > 0 && (r.state === "DELIVERED" || r.state === "CLOSED") ? "var(--h10-danger)" : undefined, fontWeight: r.balanceCents > 0 ? 600 : undefined }}>{eur(r.balanceCents)}</span> : "—") },
              ...(canMargin ? [{ key: "margin", label: "Margin", align: "right" as const, render: (r: OrderRow) => (r.lineCount && r.marginPct != null ? <Pill tone={(r.marginCents ?? 0) < 0 || (data?.marginFloorPct != null && r.marginPct < data.marginFloorPct) ? "danger" : "success"}>{r.marginPct.toFixed(0)}%</Pill> : "—") }] : []),
              { key: "payment", label: "Payment", render: (r: OrderRow) => <PaymentChip r={r} /> },
              // EPO.4 — the promise cell carries its integrity: slips + pre-late risk
              { key: "promise", label: "Promise", render: (r: OrderRow) => (r.promiseDateAt ? <span style={{ display: "inline-flex", gap: 5, alignItems: "center" }}><span style={{ color: r.overdue ? "var(--h10-danger)" : undefined, fontWeight: r.overdue ? 700 : undefined }}>{new Date(r.promiseDateAt).toLocaleDateString()}</span>{(r.promiseSlips ?? 0) > 0 && <Pill tone="warning">slipped ×{r.promiseSlips}</Pill>}{r.atRisk && !r.overdue && <Pill tone="warning">at risk</Pill>}</span> : "—") },
              { key: "wos", label: "WOs", align: "right" as const, render: (r: OrderRow) => (r.woCount ? r.woCount : "—") },
              { key: "updated", label: "Updated", render: (r: OrderRow) => new Date(r.updatedAt).toLocaleDateString() },
            ]}
            rows={gridRows}
            rowKey={(r: OrderRow) => r.id}
            emptyState={state === "attention" ? "Nothing needs attention — every promise is safe, no work is blocked or stalled." : "No orders yet — they arrive when you convert an accepted quote."}
          />
        ) : (
          <KanbanBoard lanes={lanes} onLoadMore={(s) => void loadMoreLane(s)} onMove={canEdit ? onMove : () => toast("You can't change order status", "danger")} onOpen={openDetail} />
        )}
        {/* EPO.7 (C6) — the grid consumes the cursor: no more silent 200-row cliff */}
        {view === "grid" && gridCursor && (
          <div style={{ display: "flex", justifyContent: "center", paddingTop: 10 }}>
            <button type="button" onClick={() => void loadMoreGrid()} style={{ border: "1px dashed var(--h10-border)", borderRadius: 8, background: "none", padding: "7px 16px", fontSize: 12, color: "var(--h10-text-2)", cursor: "pointer" }}>Load more orders</button>
          </div>
        )}
        {/* EPO.7 (E9) — bulk actions for the selection */}
        <BulkActionBar count={selected.size} onClear={clearSelection}>
          {canCancel && <Button onClick={() => { setReason(""); setBulkCancelling(true); }} disabled={bulkCancellable.length === 0} style={{ background: "var(--h10-danger)", color: "#fff", borderColor: "var(--h10-danger)" }}>Cancel {bulkCancellable.length || ""} selected</Button>}
          <a href={exportHref()} style={{ fontSize: 12.5, color: "var(--h10-text-link)", alignSelf: "center" }}>Export filtered CSV</a>
        </BulkActionBar>
      </Card>

      <Modal open={!!cancelling} onClose={() => setCancelling(null)} title={`Cancel ${cancelling?.number ?? ""}?`} size="sm"
        footer={<><Button onClick={() => setCancelling(null)}>Keep order</Button><Button onClick={confirmCancel} disabled={!reason.trim() || busy} style={{ background: "var(--h10-danger)", color: "#fff", borderColor: "var(--h10-danger)" }}>Cancel order</Button></>}>
        <div style={{ display: "grid", gap: 8 }}>
          <div style={{ fontSize: 12.5, color: "var(--h10-text-2)" }}>A reason is required. Open work orders are cancelled with the order.</div>
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} placeholder="Why is this order being cancelled?" style={{ border: "1px solid var(--h10-border)", borderRadius: 8, padding: 9, fontSize: 12.5, fontFamily: "inherit", background: "var(--h10-surface)", color: "var(--h10-text)" }} />
        </div>
      </Modal>

      {/* EPO.7 (E9) — one reason for the whole selection; each order still validated server-side */}
      <Modal open={bulkCancelling} onClose={() => !busy && setBulkCancelling(false)} title={`Cancel ${bulkCancellable.length} order${bulkCancellable.length === 1 ? "" : "s"}?`} size="sm"
        footer={<><Button onClick={() => setBulkCancelling(false)} disabled={busy}>Keep them</Button><Button onClick={confirmBulkCancel} disabled={!reason.trim() || busy} style={{ background: "var(--h10-danger)", color: "#fff", borderColor: "var(--h10-danger)" }}>{busy ? "Cancelling…" : "Cancel orders"}</Button></>}>
        <div style={{ display: "grid", gap: 8 }}>
          <div style={{ fontSize: 12.5, color: "var(--h10-text-2)" }}>The reason applies to all {bulkCancellable.length}. Open work orders are cancelled with each. {selected.size > bulkCancellable.length && <>({selected.size - bulkCancellable.length} of your selection can’t be cancelled from their state and will be skipped.)</>}</div>
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} placeholder="Why are these orders being cancelled?" style={{ border: "1px solid var(--h10-border)", borderRadius: 8, padding: 9, fontSize: 12.5, fontFamily: "inherit", background: "var(--h10-surface)", color: "var(--h10-text)" }} />
        </div>
      </Modal>

    </div>
  );
}

export function OrdersClient() {
  return <Suspense fallback={null}><PipelineInner /></Suspense>;
}
