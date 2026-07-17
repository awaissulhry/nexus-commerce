/**
 * FP4 — one order, the operator's home for it: the ONE-TIMELINE on the left,
 * a rail of money / deposit (FD13) / dates / work orders on the right, the
 * lifecycle in the header. One-click Start production explodes the work orders
 * (deposit-gated); Record payment unblocks them when the deposit lands.
 * Centered (editor archetype) per the content-width convention.
 */
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowUpRight, Hammer, PenLine, Truck, Undo2 } from "lucide-react";
import { DetailHeader } from "@/design-system/patterns";
import { Banner, Card, DateField, Listbox, Menu, Modal, useToast } from "@/design-system/components";
import { Button, Pill } from "@/design-system/primitives";
import { eur, formatDate } from "@/design-system/lib/format";
import { apiJson } from "@/lib/api-client";
import { useFactoryEvents } from "@/lib/use-factory-events";
import { usePermission } from "@/lib/auth/client";
import { legalTargets, ORDER_STATE_LABEL, canTransition } from "@/lib/orders/transitions";
import { parseSizeRun } from "@/lib/orders/production";
import { Timeline } from "./Timeline";
import { OrderItems } from "./OrderItems";
import { STATE_TONE, type OrderDetailResponse, type OrderState } from "./types";

const isoDate = (s: string | null | undefined) => (s ? new Date(s).toISOString().slice(0, 10) : "");
const dangerBtn: React.CSSProperties = { background: "var(--h10-danger)", color: "#fff", borderColor: "var(--h10-danger)" };

function RailRow({ label, children, tone }: { label: string; children: React.ReactNode; tone?: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", fontSize: 12.5, padding: "3px 0" }}>
      <span style={{ color: "var(--h10-text-3)" }}>{label}</span>
      <span style={{ fontWeight: 600, color: tone ?? "var(--h10-text)", fontFamily: "ui-monospace, monospace" }}>{children}</span>
    </div>
  );
}

/**
 * EPO.3 — the created-from chain as chips (Odoo smart-buttons × ERPNext
 * Connections, per the teardown verdicts): each linked document family with
 * its count, each a hop. Zero-count chips stay visible (the chain IS the
 * page's mental model) but muted.
 */
function ChainChip({ href, label, count }: { href: string; label: string; count?: number }) {
  const muted = count === 0;
  return (
    <a
      href={href}
      style={{
        display: "inline-flex", gap: 5, alignItems: "center", padding: "3px 10px", borderRadius: 999,
        border: "1px solid var(--h10-border-subtle)", background: "var(--h10-surface)", textDecoration: "none",
        fontSize: 11.5, fontWeight: 600, color: muted ? "var(--h10-text-3)" : "var(--h10-text-2)",
      }}
    >
      {label}
      {count != null && <span style={{ fontWeight: 800, color: muted ? "var(--h10-text-3)" : "var(--h10-primary)" }}>{count}</span>}
    </a>
  );
}

export function OrderDetail({ orderId, onBack }: { orderId: string; onBack: () => void }) {
  const { toast } = useToast();
  const canEdit = usePermission("orders.edit");
  const canCancel = usePermission("orders.cancel");
  const canMargin = usePermission("financials.margins.view");
  const canPay = usePermission("payments.record");
  const canBuyLabel = usePermission("labels.purchase");
  const canInvoice = usePermission("invoices.manage"); // EPO.2 — FP9 actions consumed on the order
  const [d, setD] = useState<OrderDetailResponse | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState("");
  const [starting, setStarting] = useState(false);
  const [paying, setPaying] = useState(false);
  const [payKind, setPayKind] = useState("DEPOSIT");
  const [payEuros, setPayEuros] = useState("");
  const [payMethod, setPayMethod] = useState("");
  const [payKey, setPayKey] = useState(""); // EPO1.4 (C4) — minted per modal-open; a double-click can't record twice
  const [busy, setBusy] = useState(false);
  // EPO.5 — amendment + return modals
  const [amending, setAmending] = useState(false);
  const [amendEdits, setAmendEdits] = useState<Record<string, { qty: string; price: string }>>({});
  const [amendReason, setAmendReason] = useState("");
  const [returning, setReturning] = useState(false);
  const [returnLines, setReturnLines] = useState<Record<string, { qty: string; outcome: string; note: string }>>({});

  const load = useCallback(async () => {
    try { setD(await apiJson<OrderDetailResponse>(`/api/orders/${orderId}`)); }
    catch (e) { toast((e as Error).message, "danger"); }
  }, [orderId, toast]);
  useEffect(() => { void load(); }, [load]);
  // EPO.3 (E11) — the open order stays live: FS2's durable bus, 2s debounce
  useFactoryEvents(["order.updated", "workorder.created", "workorder.updated", "shipment.updated", "payment.recorded"], load);

  const plannedCount = useMemo(() => (d?.order.lines ?? []).reduce((n, l) => n + Math.max(1, parseSizeRun(l.sizeRun).length), 0), [d]);

  const patch = async (body: Record<string, unknown>) => {
    // EPO1.4 (D-6) — every edit carries the read stamp; a 409 means someone
    // else changed the order first, so refresh instead of overwriting them.
    try { setD(await apiJson<OrderDetailResponse>(`/api/orders/${orderId}`, { method: "PATCH", body: JSON.stringify({ expectedUpdatedAt: d?.order.updatedAt, ...body }) })); }
    catch (e) {
      toast((e as Error).message, "danger");
      if (/changed elsewhere/i.test((e as Error).message)) void load();
    }
  };
  const transition = async (to: OrderState) => {
    if (to === "CANCELLED") { setCancelling(true); setReason(""); return; }
    // EPO1.4 (C1) — SHIPPED is label-driven: the buy flow flips the state
    if (to === "SHIPPED") { window.location.href = `/shipping?buy=${orderId}`; return; }
    const from = d!.order.state;
    try {
      await patch({ state: to });
      const canUndo = canTransition(to, from).ok;
      // Undo skips the read stamp (stale by design); the service's state guard still applies
      toast(<span>Moved to {ORDER_STATE_LABEL[to]}{canUndo ? <> · <button type="button" onClick={() => void patch({ state: from, expectedUpdatedAt: undefined })} style={{ background: "none", border: "none", padding: 0, color: "inherit", textDecoration: "underline", cursor: "pointer", font: "inherit" }}>Undo</button></> : null}</span>, "success");
    } catch (e) { toast((e as Error).message, "danger"); }
  };
  const confirmCancel = async () => {
    if (!reason.trim()) return;
    setBusy(true);
    try { await apiJson(`/api/orders/${orderId}/cancel`, { method: "POST", body: JSON.stringify({ reason: reason.trim() }) }); setCancelling(false); await load(); toast("Order cancelled", "info"); }
    catch (e) { toast((e as Error).message, "danger"); } finally { setBusy(false); }
  };
  const startProduction = async () => {
    setBusy(true);
    try {
      const r = await apiJson<{ workOrders: number; blocked: boolean }>(`/api/orders/${orderId}/start-production`, { method: "POST", body: "{}" });
      setStarting(false); await load();
      toast(r.blocked ? `${r.workOrders} work order(s) created — blocked until the deposit is recorded` : `Production started — ${r.workOrders} work order(s) ready`, r.blocked ? "warning" : "success");
    } catch (e) { toast((e as Error).message, "danger"); } finally { setBusy(false); }
  };
  // EPO.5 — submit an amendment: server freezes the revision, applies edits,
  // voids acceptance when the net changed (D-4)
  const submitAmendment = async () => {
    const edits = Object.entries(amendEdits)
      .map(([lineId, v]) => {
        const e: { lineId: string; qty?: number; netPriceCents?: number } = { lineId };
        const qn = parseInt(v.qty, 10);
        if (v.qty !== "" && Number.isFinite(qn) && qn > 0) e.qty = qn;
        const pn = Math.round(parseFloat(v.price) * 100);
        if (v.price !== "" && Number.isFinite(pn) && pn >= 0) e.netPriceCents = pn;
        return e;
      })
      .filter((e) => e.qty !== undefined || e.netPriceCents !== undefined);
    if (edits.length === 0 || !amendReason.trim()) { toast("Change at least one line and give a reason", "danger"); return; }
    setBusy(true);
    try {
      const r = await apiJson<{ rev: number; netDeltaCents?: number; reapprovalNeeded: boolean; workOrdersUntouched: boolean }>(`/api/orders/${orderId}/amend`, { method: "POST", body: JSON.stringify({ reason: amendReason.trim(), edits }) });
      setAmending(false); setAmendEdits({}); setAmendReason(""); await load();
      toast(
        `Amended (rev ${r.rev})${r.reapprovalNeeded ? " — total changed, customer re-approval needed" : ""}${r.workOrdersUntouched ? " — work orders NOT changed, reconcile the floor" : ""}`,
        r.reapprovalNeeded || r.workOrdersUntouched ? "warning" : "success",
      );
    } catch (e) { toast((e as Error).message, "danger"); } finally { setBusy(false); }
  };

  // EPO.5 — record a return: repair/remake spawn rework WOs; credit → REFUND hint
  const submitReturn = async () => {
    const lines = Object.entries(returnLines)
      .map(([orderLineId, v]) => ({ orderLineId, qty: parseInt(v.qty, 10), outcome: v.outcome, note: v.note.trim() || undefined }))
      .filter((l) => Number.isFinite(l.qty) && l.qty > 0);
    if (lines.length === 0) { toast("Enter a quantity for at least one line", "danger"); return; }
    setBusy(true);
    try {
      const r = await apiJson<{ number: string; reworkWos: string[]; creditHint?: string }>(`/api/orders/${orderId}/returns`, { method: "POST", body: JSON.stringify({ lines }) });
      setReturning(false); setReturnLines({}); await load();
      toast(`${r.number} recorded${r.reworkWos.length ? ` — rework ${r.reworkWos.join(", ")} on the floor` : ""}${r.creditHint ? ` · ${r.creditHint}` : ""}`, "success");
    } catch (e) { toast((e as Error).message, "danger"); } finally { setBusy(false); }
  };

  // EPO.2 — send / mark-paid ride the FP9 invoice route (consume, never rebuild)
  const invoiceAction = async (invoiceId: string, action: "send" | "paid") => {
    try {
      await apiJson(`/api/invoices/${invoiceId}`, { method: "PATCH", body: JSON.stringify({ action }) });
      await load();
      toast(action === "send" ? "Invoice sent" : "Invoice marked paid", "success");
    } catch (e) { toast((e as Error).message, "danger"); }
  };
  const openPayment = (prefillDeposit: boolean) => {
    const remaining = (d?.money.depositRequiredCents ?? 0) - (d?.money.depositPaidCents ?? 0);
    setPayKind(prefillDeposit ? "DEPOSIT" : "BALANCE");
    setPayEuros(prefillDeposit && remaining > 0 ? (remaining / 100).toFixed(2) : "");
    setPayMethod("");
    setPayKey(crypto.randomUUID()); // C4 — one key per modal-open; retries reuse it
    setPaying(true);
  };
  const recordPayment = async () => {
    const amountCents = Math.round(parseFloat(payEuros) * 100);
    if (!Number.isFinite(amountCents) || amountCents <= 0) { toast("Enter an amount", "danger"); return; }
    setBusy(true);
    try {
      const r = await apiJson<{ unblocked: number; duplicate?: boolean }>(`/api/orders/${orderId}/payments`, { method: "POST", body: JSON.stringify({ kind: payKind, amountCents, method: payMethod.trim() || undefined, idempotencyKey: payKey || undefined }) });
      setPaying(false); await load();
      if (r.duplicate) toast("Already recorded — this was a duplicate submit", "info");
      else toast(r.unblocked > 0 ? `Payment recorded — deposit met, ${r.unblocked} work order(s) unblocked` : "Payment recorded", "success");
    } catch (e) { toast((e as Error).message, "danger"); } finally { setBusy(false); }
  };

  if (!d) return <div className="factory-page--centered"><Card padded><Button onClick={onBack}>Back</Button></Card></div>;
  const o = d.order;
  const m = d.money;
  const depositDue = m.depositRequiredCents != null && m.depositRequiredCents > 0 && !m.depositMet;

  const targets = legalTargets(o.state).filter((t) => !(o.state === "CONFIRMED" && t === "IN_PRODUCTION")).filter((t) => t !== "CANCELLED" || canCancel);
  const menuItems = targets.map((t) => ({ id: t, label: t === "SHIPPED" ? <>→ Shipped — buy label</> : <>→ {ORDER_STATE_LABEL[t]}</>, onSelect: () => void transition(t) }));

  return (
    <div className="factory-page--centered">
      <DetailHeader
        backLabel="All orders"
        onBack={onBack}
        title={<span style={{ display: "inline-flex", gap: 10, alignItems: "center" }}>{o.number}<Pill tone={STATE_TONE[o.state]}>{ORDER_STATE_LABEL[o.state]}</Pill>{o.urgent && <Pill tone="danger">urgent</Pill>}</span>}
        actions={
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {canEdit && o.state === "CONFIRMED" && <Button variant="primary" onClick={() => setStarting(true)}><Hammer size={13} /> Start production</Button>}
            {canBuyLabel && o.state === "READY" && <Button variant="primary" onClick={() => { window.location.href = `/shipping?buy=${o.id}`; }}><Truck size={13} /> Buy label</Button>}
            {/* EPO.5 — amend while work still makes sense; return once goods left */}
            {canEdit && ["CONFIRMED", "IN_PRODUCTION", "READY"].includes(o.state) && <Button onClick={() => { setAmendEdits({}); setAmendReason(""); setAmending(true); }}><PenLine size={13} /> Amend</Button>}
            {canEdit && ["SHIPPED", "DELIVERED", "CLOSED"].includes(o.state) && <Button onClick={() => { setReturnLines({}); setReturning(true); }}><Undo2 size={13} /> Record return</Button>}
            {canEdit && menuItems.length > 0 && <Menu align="right" label="Change status" items={menuItems} triggerProps={{ className: "h10-ds-btn" }} />}
          </div>
        }
      />
      <div style={{ fontSize: 12, color: "var(--h10-text-3)", marginBottom: 8 }}>
        <a href={`/contacts?c=${o.party.id}`} style={{ color: "var(--h10-text-link)" }}>{o.party.name}</a>
        {o.bornFromQuote ? <> · from <a href={`/quotes?q=${o.bornFromQuote.id}`} style={{ color: "var(--h10-text-link)" }}>{o.bornFromQuote.number}</a></> : null}
        {o.conversation ? <> · <a href={`/inbox?focus=${o.conversation.id}`} style={{ color: "var(--h10-text-link)" }}>thread</a></> : null}
      </div>

      {/* EPO.3 (E2) — the created-from chain: quote → WOs → shipments → invoices → payments */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
        {o.bornFromQuote && <ChainChip href={`/quotes?q=${o.bornFromQuote.id}`} label={`Quote ${o.bornFromQuote.number}`} />}
        <ChainChip href={o.workOrders.length === 1 && o.workOrders[0] ? `/production?wo=${o.workOrders[0].id}` : "/production"} label="Work orders" count={o.workOrders.length} />
        <ChainChip href="/shipping" label="Shipments" count={o.shipments?.length ?? 0} />
        <ChainChip href="/financials" label="Invoices" count={o.invoices?.length ?? 0} />
        <ChainChip href="/financials" label="Payments" count={o.payments.length} />
      </div>

      {/* EPO.7b — DS Banner replaces the hand-rolled wash */}
      {o.state === "CANCELLED" && o.cancelReason && (
        <div style={{ marginBottom: 12 }}><Banner tone="danger" title="Cancelled">{o.cancelReason}</Banner></div>
      )}

      {/* EPO.5 — a net-changing amendment voided the acceptance; never silent */}
      {o.reapprovalNeededAt && (
        <div style={{ marginBottom: 12 }}>
          <Banner
            tone="warning"
            title="An amendment changed the total — the customer's acceptance no longer covers it"
            action={canEdit ? <Button onClick={() => void (async () => { try { await apiJson(`/api/orders/${orderId}/amend`, { method: "PATCH", body: JSON.stringify({ reapproved: true }) }); await load(); toast("Re-approval recorded", "success"); } catch (e) { toast((e as Error).message, "danger"); } })()}>Mark re-approved</Button> : undefined}
          >
            Confirm the new total with them (the thread is one click up), then record it here. Sending the re-approval request automatically arrives with the notifications phase.
          </Banner>
        </div>
      )}

      {/* EPO.2 — credit AWARENESS, never a hold: this party still owes elsewhere */}
      {(m.partyOutstandingCents ?? 0) > 0 && (
        <div style={{ marginBottom: 12 }}>
          <Banner tone="warning" title={`${o.party.name} has ${eur(m.partyOutstandingCents!)} outstanding on ${m.partyOutstandingOrders} delivered order${m.partyOutstandingOrders === 1 ? "" : "s"}`}>
            Information, not a block — <a href={`/contacts?c=${o.party.id}`} style={{ color: "inherit" }}>their history</a> has the detail.
          </Banner>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 340px", gap: 16 }}>
        <div style={{ display: "grid", gap: 12, alignContent: "start" }}>
          <Card padded>
            <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 8 }}>Timeline</div>
            <Timeline events={d.timeline} />
          </Card>
          <OrderItems orderId={o.id} state={o.state} lines={o.lines} canEdit={canEdit} onChanged={load} />
        </div>

        <div style={{ display: "grid", gap: 12, alignContent: "start" }}>
          {(m.netCents != null || m.marginCents != null) && (
            <Card padded>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: "var(--h10-text-3)", textTransform: "uppercase", letterSpacing: 0.4 }}>Money</span>
                {canPay && <button type="button" onClick={() => openPayment(false)} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontSize: 11.5, color: "var(--h10-text-link)" }}>+ Record payment</button>}
              </div>
              {/* EPO.2 (E1) — the order-to-cash strip: the FP9 fold, re-surfaced */}
              {m.netCents != null && <RailRow label="Quoted">{eur(m.netCents)}</RailRow>}
              {m.invoicedCents != null && <RailRow label="Invoiced">{eur(m.invoicedCents)}</RailRow>}
              {m.paidCents != null && <RailRow label="Paid">{eur(m.paidCents)}</RailRow>}
              {m.balanceCents != null && <RailRow label="Balance" tone={m.balanceCents > 0 ? "var(--h10-warning, #9a6700)" : "var(--h10-success)"}>{eur(m.balanceCents)}</RailRow>}
              {m.costCents != null && <RailRow label={m.actualIsPending === false ? "Cost (actual)" : "Cost (est)"}>{m.actualIsPending === false && m.actualCostCents != null ? eur(m.actualCostCents) : eur(m.costCents)}</RailRow>}
              {canMargin && m.marginCents != null && (
                <RailRow label={m.actualIsPending === false ? "Margin (actual)" : "Margin (est)"} tone={(m.actualIsPending === false ? (m.actualMarginCents ?? 0) : m.marginCents) < 0 ? "var(--h10-danger)" : "var(--h10-success)"}>
                  {m.actualIsPending === false && m.actualMarginCents != null
                    ? <>{eur(m.actualMarginCents)} · {(m.actualMarginPct ?? 0).toFixed(0)}%</>
                    : <>{eur(m.marginCents)} · {(m.marginPct ?? 0).toFixed(0)}%</>}
                </RailRow>
              )}
            </Card>
          )}

          {/* EPO.2 — invoices ON the order, actions via the FP9 endpoints (consumed, not rebuilt) */}
          {(o.invoices?.length ?? 0) > 0 && (
            <Card padded>
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--h10-text-3)", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 }}>Invoices</div>
              <div style={{ display: "grid", gap: 6 }}>
                {o.invoices.map((iv) => (
                  <div key={iv.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12.5, gap: 6 }}>
                    <a href={`/api/invoices/${iv.id}`} target="_blank" rel="noreferrer" style={{ fontWeight: 600, color: "var(--h10-text-link)", textDecoration: "none" }} title="Open PDF">{iv.number}</a>
                    <span style={{ display: "inline-flex", gap: 5, alignItems: "center" }}>
                      {iv.amountCents != null && <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }}>{eur(iv.amountCents)}</span>}
                      <Pill tone={iv.paidAt ? "success" : iv.sentAt ? "info" : "neutral"}>{iv.paidAt ? "paid" : iv.sentAt ? "sent" : "draft"}</Pill>
                      {canInvoice && !iv.paidAt && (
                        <button type="button" onClick={() => void invoiceAction(iv.id, iv.sentAt ? "paid" : "send")} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontSize: 11.5, color: "var(--h10-text-link)" }}>
                          {iv.sentAt ? "Mark paid" : "Send"}
                        </button>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {m.depositRequiredCents != null && m.depositRequiredCents > 0 && (
            <Card padded>
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--h10-text-3)", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6, display: "flex", justifyContent: "space-between" }}>
                <span>Deposit (FD13)</span><Pill tone={m.depositMet ? "success" : "warning"}>{m.depositMet ? "paid" : "due"}</Pill>
              </div>
              <RailRow label="Required">{eur(m.depositRequiredCents)}</RailRow>
              <RailRow label="Paid">{eur(m.depositPaidCents ?? 0)}</RailRow>
              {depositDue && canPay && <Button variant="primary" onClick={() => openPayment(true)} style={{ width: "100%", marginTop: 8 }}>Record deposit</Button>}
            </Card>
          )}

          {/* EPO1.3 (C8) — the gate being OFF is said out loud, never silent */}
          {m.depositTermsMissing && (
            <Card padded>
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--h10-text-3)", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 }}>Deposit (FD13)</div>
              <div style={{ fontSize: 12, color: "var(--h10-text-3)" }}>No deposit terms — this order has no originating quote, so the deposit gate is off and work orders start unblocked.</div>
            </Card>
          )}

          <Card padded>
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--h10-text-3)", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span>Dates</span>
              {/* EPO.4 — promise integrity at a glance */}
              <span style={{ display: "inline-flex", gap: 4 }}>
                {d.promise.slips > 0 && <Pill tone="warning">slipped ×{d.promise.slips}</Pill>}
                {d.promise.atRisk && <Pill tone="warning">at risk</Pill>}
                {d.promise.late && <Pill tone="danger">late</Pill>}
              </span>
            </div>
            <div style={{ display: "grid", gap: 4 }}>
              <div style={{ fontSize: 11.5, color: "var(--h10-text-3)" }}>Promise date</div>
              <DateField ariaLabel="Promise date" value={isoDate(o.promiseDateAt)} onChange={(v) => void patch({ promiseDateAt: v ? new Date(`${v}T12:00:00`).toISOString() : null })} disabled={!canEdit} />
              {/* the FIRST promise never disappears — shown whenever it differs */}
              {d.promise.originalPromiseDateAt && isoDate(d.promise.originalPromiseDateAt) !== isoDate(o.promiseDateAt) && (
                <RailRow label="Originally">{formatDate(d.promise.originalPromiseDateAt)}</RailRow>
              )}
              {d.promise.atRisk && d.promise.neededDays != null && d.promise.daysLeft != null && (
                <div style={{ fontSize: 11.5, color: "var(--h10-warning, #9a6700)" }}>Remaining stages need ~{Math.ceil(d.promise.neededDays)}d at recent pace; {Math.floor(d.promise.daysLeft)}d left.</div>
              )}
              <RailRow label="Confirmed">{formatDate(o.createdAt)}</RailRow>
            </div>
          </Card>

          {/* EPO.4 (EPF D-9) — reference + urgency, owner-editable */}
          <Card padded>
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--h10-text-3)", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span>Details</span>
              {canEdit && (
                <button type="button" onClick={() => void patch({ urgent: !o.urgent })} style={{ background: "none", border: "none", padding: 0, cursor: "pointer" }} title={o.urgent ? "Clear urgent" : "Mark urgent"}>
                  <Pill tone={o.urgent ? "danger" : "neutral"}>{o.urgent ? "urgent" : "mark urgent"}</Pill>
                </button>
              )}
            </div>
            <div style={{ fontSize: 11.5, color: "var(--h10-text-3)", marginBottom: 3 }}>Customer reference</div>
            <input
              defaultValue={o.clientRef ?? ""}
              onBlur={(e) => { const v = e.target.value.trim(); if (v !== (o.clientRef ?? "")) void patch({ clientRef: v || null }); }}
              placeholder="Their PO / reference…"
              disabled={!canEdit}
              style={{ width: "100%", border: "1px solid var(--h10-border)", borderRadius: 8, padding: "6px 9px", fontSize: 12.5, background: "var(--h10-surface)", color: "var(--h10-text)" }}
            />
          </Card>

          <Card padded>
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--h10-text-3)", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 }}>Work orders</div>
            {o.workOrders.length === 0 ? (
              <div style={{ fontSize: 12, color: "var(--h10-text-3)" }}>{o.state === "CONFIRMED" ? "None yet — Start production creates them." : "None."}</div>
            ) : (
              <div style={{ display: "grid", gap: 6 }}>
                {o.workOrders.map((w) => (
                  <div key={w.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12.5 }}>
                    {/* EPO.3 (E2) — every WO row hops to its drawer on the floor */}
                    <a href={`/production?wo=${w.id}`} style={{ fontWeight: 600, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", color: "var(--h10-text-link)", textDecoration: "none" }} title={w.number}>
                      {w.number}{w.label ? <span style={{ color: "var(--h10-text-3)", fontWeight: 400 }}> · {w.label}</span> : null}
                    </a>
                    <span style={{ display: "inline-flex", gap: 5, alignItems: "center", flex: "0 0 auto" }}>
                      <span style={{ color: "var(--h10-text-3)", fontSize: 11 }}>{w.stages.length} stages</span>
                      <Pill tone={w.state === "BLOCKED" ? "warning" : w.state === "DONE" ? "success" : "info"}>{w.state === "BLOCKED" ? (w.blockedReason ?? "blocked") : w.state.toLowerCase()}</Pill>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Card>

          {o.bornFromQuote && (
            <a href={`/quotes?q=${o.bornFromQuote.id}`} style={{ fontSize: 12, color: "var(--h10-text-link)", display: "inline-flex", gap: 4, alignItems: "center" }}>Open quote {o.bornFromQuote.number} <ArrowUpRight size={12} /></a>
          )}
        </div>
      </div>

      {/* Start production */}
      <Modal open={starting} onClose={() => setStarting(false)} title={`Start production for ${o.number}?`} size="sm"
        footer={<><Button onClick={() => setStarting(false)}>Not yet</Button><Button variant="primary" onClick={startProduction} disabled={busy}>Start production</Button></>}>
        <div style={{ display: "grid", gap: 8, fontSize: 13 }}>
          <div>This creates <b>{plannedCount} work order{plannedCount === 1 ? "" : "s"}</b>, each with the configured production stages, and moves the order to <b>In production</b>.</div>
          {depositDue ? (
            <div style={{ padding: 10, background: "var(--h10-wash-warning, #fdf3d3)", borderRadius: 8, color: "var(--h10-warning, #9a6700)" }}>The deposit isn’t recorded yet — the work order{plannedCount === 1 ? "" : "s"} will be <b>blocked from cutting</b> until you record it.</div>
          ) : (
            <div style={{ padding: 10, background: "var(--h10-wash-success, #eaf7ee)", borderRadius: 8, color: "var(--h10-success)" }}>Deposit is satisfied — work will be ready to start.</div>
          )}
        </div>
      </Modal>

      {/* Record payment */}
      <Modal open={paying} onClose={() => setPaying(false)} title="Record a payment" size="sm"
        footer={<><Button onClick={() => setPaying(false)}>Cancel</Button><Button variant="primary" onClick={recordPayment} disabled={busy}>Record</Button></>}>
        <div style={{ display: "grid", gap: 10 }}>
          <div>
            <div style={{ fontSize: 11.5, color: "var(--h10-text-3)", marginBottom: 3 }}>Kind</div>
            <Listbox ariaLabel="Payment kind" options={[{ value: "DEPOSIT", label: "Deposit" }, { value: "BALANCE", label: "Balance" }, { value: "OTHER", label: "Other" }]} value={payKind} onChange={setPayKind} />
          </div>
          <div>
            <div style={{ fontSize: 11.5, color: "var(--h10-text-3)", marginBottom: 3 }}>Amount (€)</div>
            <input type="number" step="0.01" min="0" value={payEuros} onChange={(e) => setPayEuros(e.target.value)} placeholder="0,00" style={{ width: "100%", border: "1px solid var(--h10-border)", borderRadius: 8, padding: "7px 9px", fontSize: 13, fontFamily: "ui-monospace, monospace", background: "var(--h10-surface)", color: "var(--h10-text)" }} />
          </div>
          <div>
            <div style={{ fontSize: 11.5, color: "var(--h10-text-3)", marginBottom: 3 }}>Method (optional)</div>
            <input value={payMethod} onChange={(e) => setPayMethod(e.target.value)} placeholder="bank transfer, card…" style={{ width: "100%", border: "1px solid var(--h10-border)", borderRadius: 8, padding: "7px 9px", fontSize: 13, background: "var(--h10-surface)", color: "var(--h10-text)" }} />
          </div>
        </div>
      </Modal>

      {/* EPO.5 — amend: per-line qty/price edits + one reason; the server freezes the revision */}
      <Modal open={amending} onClose={() => !busy && setAmending(false)} title={`Amend ${o.number}`} size="sm"
        footer={<><Button onClick={() => setAmending(false)} disabled={busy}>Cancel</Button><Button variant="primary" onClick={submitAmendment} disabled={busy || !amendReason.trim()}>{busy ? "Amending…" : "Amend order"}</Button></>}>
        <div style={{ display: "grid", gap: 10 }}>
          <div style={{ fontSize: 12.5, color: "var(--h10-text-2)" }}>
            Changes create an audited revision — the original lines are kept forever. A changed total voids the customer’s acceptance until you record their re-approval.
            {o.state !== "CONFIRMED" && <b> Work orders are NOT re-exploded — reconcile the floor yourself.</b>}
          </div>
          {o.lines.map((l) => (
            <div key={l.id} style={{ display: "grid", gridTemplateColumns: "1fr 64px 88px", gap: 6, alignItems: "center", fontSize: 12.5 }}>
              <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }} title={l.description}>{l.description}</span>
              <input type="number" min="1" placeholder={String(l.qty)} value={amendEdits[l.id]?.qty ?? ""} onChange={(e) => setAmendEdits((p) => ({ ...p, [l.id]: { qty: e.target.value, price: p[l.id]?.price ?? "" } }))} aria-label={`New quantity for ${l.description}`} style={{ border: "1px solid var(--h10-border)", borderRadius: 8, padding: "5px 7px", fontSize: 12.5, fontFamily: "ui-monospace, monospace", background: "var(--h10-surface)", color: "var(--h10-text)" }} />
              <input type="number" min="0" step="0.01" placeholder={l.netPriceCents != null ? (l.netPriceCents / 100).toFixed(2) : "€"} value={amendEdits[l.id]?.price ?? ""} onChange={(e) => setAmendEdits((p) => ({ ...p, [l.id]: { qty: p[l.id]?.qty ?? "", price: e.target.value } }))} aria-label={`New unit price for ${l.description}`} style={{ border: "1px solid var(--h10-border)", borderRadius: 8, padding: "5px 7px", fontSize: 12.5, fontFamily: "ui-monospace, monospace", background: "var(--h10-surface)", color: "var(--h10-text)" }} />
            </div>
          ))}
          <textarea value={amendReason} onChange={(e) => setAmendReason(e.target.value)} rows={2} placeholder="Why is this order changing? (required)" style={{ border: "1px solid var(--h10-border)", borderRadius: 8, padding: 9, fontSize: 12.5, fontFamily: "inherit", background: "var(--h10-surface)", color: "var(--h10-text)" }} />
        </div>
      </Modal>

      {/* EPO.5 — return: per-line qty + outcome; repair/remake spawn rework WOs */}
      <Modal open={returning} onClose={() => !busy && setReturning(false)} title={`Record a return for ${o.number}`} size="sm"
        footer={<><Button onClick={() => setReturning(false)} disabled={busy}>Cancel</Button><Button variant="primary" onClick={submitReturn} disabled={busy}>{busy ? "Recording…" : "Record return"}</Button></>}>
        <div style={{ display: "grid", gap: 10 }}>
          <div style={{ fontSize: 12.5, color: "var(--h10-text-2)" }}>Repair and remake put a rework work order on the floor (full stage flow, QC gate included). Credit is recorded afterwards as a refund payment so the balance stays true.</div>
          {o.lines.map((l) => (
            <div key={l.id} style={{ display: "grid", gap: 4 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600 }}>{l.description} <span style={{ color: "var(--h10-text-3)", fontWeight: 400 }}>×{l.qty}</span></div>
              <div style={{ display: "grid", gridTemplateColumns: "64px 1fr 1fr", gap: 6 }}>
                <input type="number" min="0" max={l.qty} placeholder="0" value={returnLines[l.id]?.qty ?? ""} onChange={(e) => setReturnLines((p) => ({ ...p, [l.id]: { qty: e.target.value, outcome: p[l.id]?.outcome ?? "REPAIR", note: p[l.id]?.note ?? "" } }))} aria-label={`Return quantity for ${l.description}`} style={{ border: "1px solid var(--h10-border)", borderRadius: 8, padding: "5px 7px", fontSize: 12.5, fontFamily: "ui-monospace, monospace", background: "var(--h10-surface)", color: "var(--h10-text)" }} />
                <Listbox ariaLabel={`Outcome for ${l.description}`} options={[{ value: "REPAIR", label: "Repair" }, { value: "REMAKE", label: "Remake" }, { value: "CREDIT", label: "Credit" }]} value={returnLines[l.id]?.outcome ?? "REPAIR"} onChange={(v) => setReturnLines((p) => ({ ...p, [l.id]: { qty: p[l.id]?.qty ?? "", outcome: v, note: p[l.id]?.note ?? "" } }))} />
                <input placeholder="Note (optional)" value={returnLines[l.id]?.note ?? ""} onChange={(e) => setReturnLines((p) => ({ ...p, [l.id]: { qty: p[l.id]?.qty ?? "", outcome: p[l.id]?.outcome ?? "REPAIR", note: e.target.value } }))} aria-label={`Note for ${l.description}`} style={{ border: "1px solid var(--h10-border)", borderRadius: 8, padding: "5px 7px", fontSize: 12.5, background: "var(--h10-surface)", color: "var(--h10-text)" }} />
              </div>
            </div>
          ))}
        </div>
      </Modal>

      <Modal open={cancelling} onClose={() => setCancelling(false)} title={`Cancel ${o.number}?`} size="sm"
        footer={<><Button onClick={() => setCancelling(false)}>Keep order</Button><Button onClick={confirmCancel} disabled={!reason.trim() || busy} style={dangerBtn}>Cancel order</Button></>}>
        <div style={{ display: "grid", gap: 8 }}>
          <div style={{ fontSize: 12.5, color: "var(--h10-text-2)" }}>A reason is required. Open work orders are cancelled with the order.</div>
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} placeholder="Why is this order being cancelled?" style={{ border: "1px solid var(--h10-border)", borderRadius: 8, padding: 9, fontSize: 12.5, fontFamily: "inherit", background: "var(--h10-surface)", color: "var(--h10-text)" }} />
        </div>
      </Modal>
    </div>
  );
}
