/**
 * FP4 — the orders operational board: three live counters, state tabs, party
 * filter, search, and two views. GRID: the state pill is a transition menu
 * (only legal edges, server-validated) with Undo. KANBAN: drag between lanes =
 * a validated command. Marking SHIPPED prompts a tracking note (manual until
 * FP8). Clicking a number opens the OrderDetail one-timeline. Deep-link ?o=.
 */
"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { PageHeader } from "@/design-system/patterns";
import { Card, DataGrid, Menu, Modal, useToast, Listbox } from "@/design-system/components";
import { Button, Pill } from "@/design-system/primitives";
import { eur } from "@/design-system/lib/format";
import { apiJson } from "@/lib/api-client";
import { usePermission } from "@/lib/auth/client";
import { canTransition, legalTargets, ORDER_STATE_LABEL } from "@/lib/orders/transitions";
import { OrderDetail } from "./OrderDetail";
import { KanbanBoard } from "./KanbanBoard";
import { STATE_TONE, type OrderRow, type OrdersResponse, type OrderState } from "./types";

const TABS: { id: string; label: string }[] = [
  { id: "all", label: "All" },
  { id: "confirmed", label: "Confirmed" },
  { id: "in_production", label: "In production" },
  { id: "ready", label: "Ready" },
  { id: "shipped", label: "Shipped" },
  { id: "delivered", label: "Delivered" },
  { id: "cancelled", label: "Cancelled" },
];

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

function DepositChip({ r }: { r: OrderRow }) {
  if (r.depositRequiredCents == null || r.depositRequiredCents === 0) return <span style={{ color: "var(--h10-text-3)" }}>—</span>;
  const met = (r.depositPaidCents ?? 0) >= r.depositRequiredCents;
  return <Pill tone={met ? "success" : "warning"}>{met ? "deposit paid" : "deposit due"}</Pill>;
}

function PipelineInner() {
  const params = useSearchParams();
  const { toast } = useToast();
  const canEdit = usePermission("orders.edit");
  const canCancel = usePermission("orders.cancel");
  const canMargin = usePermission("financials.margins.view");
  const [data, setData] = useState<OrdersResponse | null>(null);
  const [view, setView] = useState<"grid" | "kanban">("grid");
  const [state, setState] = useState("all");
  const [q, setQ] = useState("");
  const [partyId, setPartyId] = useState("");
  const [parties, setParties] = useState<{ id: string; name: string }[]>([]);
  const [cancelling, setCancelling] = useState<OrderRow | null>(null);
  const [reason, setReason] = useState("");
  const [shipping, setShipping] = useState<OrderRow | null>(null);
  const [trackingNote, setTrackingNote] = useState("");
  const [busy, setBusy] = useState(false);

  const openId = params.get("o");

  useEffect(() => { const v = localStorage.getItem("factory:orders:view"); if (v === "kanban" || v === "grid") setView(v); }, []);
  const switchView = (v: "grid" | "kanban") => { setView(v); localStorage.setItem("factory:orders:view", v); };

  const load = useCallback(async () => {
    try {
      const usp = new URLSearchParams({ state: view === "kanban" ? "all" : state });
      if (q.trim()) usp.set("q", q.trim());
      if (partyId) usp.set("partyId", partyId);
      setData(await apiJson<OrdersResponse>(`/api/orders?${usp}`));
    } catch (e) {
      toast((e as Error).message, "danger");
    }
  }, [view, state, q, partyId, toast]);
  useEffect(() => { const t = setTimeout(() => void load(), 200); return () => clearTimeout(t); }, [load]);
  useEffect(() => { apiJson<{ parties: { id: string; name: string }[] }>("/api/parties-lite").then((d) => setParties(d.parties)).catch(() => {}); }, []);

  const openDetail = (id: string) => { window.history.replaceState(null, "", `/orders?o=${id}`); window.dispatchEvent(new PopStateEvent("popstate")); };
  const closeDetail = () => { window.history.replaceState(null, "", "/orders"); window.dispatchEvent(new PopStateEvent("popstate")); void load(); };

  const transition = async (row: OrderRow, to: OrderState) => {
    if (to === "CANCELLED") { setCancelling(row); setReason(""); return; }
    if (to === "SHIPPED") { setShipping(row); setTrackingNote(""); return; } // stopgap: manual until FP8
    const from = row.state;
    try {
      await apiJson(`/api/orders/${row.id}`, { method: "PATCH", body: JSON.stringify({ state: to }) });
      void load();
      const canUndo = canTransition(to, from).ok;
      toast(<span>Moved to {ORDER_STATE_LABEL[to]}{canUndo ? <> · <button type="button" onClick={() => void undo(row.id, from)} style={undoBtn}>Undo</button></> : null}</span>, "success");
    } catch (e) {
      const msg = (e as Error).message;
      toast(/start production/i.test(msg) ? "Use Start production to begin — it creates the work order." : msg, "danger");
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
  const confirmShip = async () => {
    if (!shipping) return;
    setBusy(true);
    try { await apiJson(`/api/orders/${shipping.id}`, { method: "PATCH", body: JSON.stringify({ state: "SHIPPED", note: trackingNote.trim() || undefined }) }); setShipping(null); void load(); toast("Marked shipped", "success"); }
    catch (e) { toast((e as Error).message, "danger"); } finally { setBusy(false); }
  };

  const stateCell = (r: OrderRow) => {
    const pill = <Pill tone={STATE_TONE[r.state]}>{ORDER_STATE_LABEL[r.state]}</Pill>;
    const targets = legalTargets(r.state).filter((t) => t !== "IN_PRODUCTION" || r.state !== "CONFIRMED");
    const items = targets.filter((t) => t !== "CANCELLED" || canCancel).map((t) => ({ id: t, label: <>→ {ORDER_STATE_LABEL[t]}</>, onSelect: () => void transition(r, t) }));
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
          <a href="/api/exports/orders" style={{ fontSize: 12, color: "var(--h10-text-link)" }}>Export CSV</a>
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
            {parties.length > 0 && (
              <div style={{ minWidth: 190 }}>
                <Listbox ariaLabel="Party" options={[{ value: "", label: "All parties" }, ...parties.map((p) => ({ value: p.id, label: p.name }))]} value={partyId} onChange={setPartyId} />
              </div>
            )}
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search number or party…" style={{ border: "1px solid var(--h10-border)", borderRadius: 8, padding: "5px 9px", fontSize: 12.5, outline: "none", background: "var(--h10-surface)", color: "var(--h10-text)", minWidth: 200 }} />
          </div>
        </div>
        {view === "grid" ? (
          <DataGrid
            columns={[
              { key: "number", label: "Order", render: (r: OrderRow) => <button type="button" onClick={() => openDetail(r.id)} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", font: "inherit", fontWeight: 700, color: "var(--h10-text-link)" }}>{r.number}</button> },
              { key: "party", label: "Party", render: (r: OrderRow) => r.party.name },
              { key: "state", label: "State", render: stateCell },
              { key: "net", label: "Net", align: "right" as const, render: (r: OrderRow) => (r.lineCount ? eur(r.netCents ?? 0) : "—") },
              ...(canMargin ? [{ key: "margin", label: "Margin", align: "right" as const, render: (r: OrderRow) => (r.lineCount ? <Pill tone={(r.marginCents ?? 0) < 0 ? "danger" : "success"}>{(r.marginPct ?? 0).toFixed(0)}%</Pill> : "—") }] : []),
              { key: "deposit", label: "Deposit", render: (r: OrderRow) => <DepositChip r={r} /> },
              { key: "promise", label: "Promise", render: (r: OrderRow) => (r.promiseDateAt ? <span style={{ color: r.overdue ? "var(--h10-danger)" : undefined, fontWeight: r.overdue ? 700 : undefined }}>{new Date(r.promiseDateAt).toLocaleDateString()}</span> : "—") },
              { key: "wos", label: "WOs", align: "right" as const, render: (r: OrderRow) => (r.woCount ? r.woCount : "—") },
              { key: "updated", label: "Updated", render: (r: OrderRow) => new Date(r.updatedAt).toLocaleDateString() },
            ]}
            rows={data?.orders ?? []}
            rowKey={(r: OrderRow) => r.id}
            emptyState="No orders yet — they arrive when you convert an accepted quote."
          />
        ) : (
          <KanbanBoard orders={data?.orders ?? []} onMove={canEdit ? onMove : () => toast("You can't change order status", "danger")} onOpen={openDetail} />
        )}
      </Card>

      <Modal open={!!cancelling} onClose={() => setCancelling(null)} title={`Cancel ${cancelling?.number ?? ""}?`} size="sm"
        footer={<><Button onClick={() => setCancelling(null)}>Keep order</Button><Button onClick={confirmCancel} disabled={!reason.trim() || busy} style={{ background: "var(--h10-danger)", color: "#fff", borderColor: "var(--h10-danger)" }}>Cancel order</Button></>}>
        <div style={{ display: "grid", gap: 8 }}>
          <div style={{ fontSize: 12.5, color: "var(--h10-text-2)" }}>A reason is required. Open work orders are cancelled with the order.</div>
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} placeholder="Why is this order being cancelled?" style={{ border: "1px solid var(--h10-border)", borderRadius: 8, padding: 9, fontSize: 12.5, fontFamily: "inherit", background: "var(--h10-surface)", color: "var(--h10-text)" }} />
        </div>
      </Modal>

      <Modal open={!!shipping} onClose={() => setShipping(null)} title={`Mark ${shipping?.number ?? ""} shipped?`} size="sm"
        footer={<><Button onClick={() => setShipping(null)}>Cancel</Button><Button variant="primary" onClick={confirmShip} disabled={busy}>Mark shipped</Button></>}>
        <div style={{ display: "grid", gap: 8 }}>
          <div style={{ fontSize: 12.5, color: "var(--h10-text-2)" }}>Shipments &amp; labels arrive in FP8 — for now this records the shipped state manually. Add a tracking note if you have one.</div>
          <input value={trackingNote} onChange={(e) => setTrackingNote(e.target.value)} placeholder="Tracking number / carrier (optional)" style={{ border: "1px solid var(--h10-border)", borderRadius: 8, padding: "7px 9px", fontSize: 12.5, background: "var(--h10-surface)", color: "var(--h10-text)" }} />
        </div>
      </Modal>
    </div>
  );
}

export function OrdersClient() {
  return <Suspense fallback={null}><PipelineInner /></Suspense>;
}
