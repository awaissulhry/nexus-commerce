/**
 * FP4 — one order, the operator's home for it: the ONE-TIMELINE on the left,
 * a rail of money / deposit (FD13) / dates / work orders on the right, the
 * lifecycle in the header. One-click Start production explodes the work orders
 * (deposit-gated); Record payment unblocks them when the deposit lands.
 * Centered (editor archetype) per the content-width convention.
 */
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowUpRight, Hammer } from "lucide-react";
import { DetailHeader } from "@/design-system/patterns";
import { Card, DateField, Listbox, Menu, Modal, useToast } from "@/design-system/components";
import { Button, Pill } from "@/design-system/primitives";
import { eur } from "@/design-system/lib/format";
import { apiJson } from "@/lib/api-client";
import { usePermission } from "@/lib/auth/client";
import { legalTargets, ORDER_STATE_LABEL, canTransition } from "@/lib/orders/transitions";
import { parseSizeRun } from "@/lib/orders/production";
import { Timeline } from "./Timeline";
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

export function OrderDetail({ orderId, onBack }: { orderId: string; onBack: () => void }) {
  const { toast } = useToast();
  const canEdit = usePermission("orders.edit");
  const canCancel = usePermission("orders.cancel");
  const canMargin = usePermission("financials.margins.view");
  const canPay = usePermission("payments.record");
  const [d, setD] = useState<OrderDetailResponse | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState("");
  const [starting, setStarting] = useState(false);
  const [paying, setPaying] = useState(false);
  const [payKind, setPayKind] = useState("DEPOSIT");
  const [payEuros, setPayEuros] = useState("");
  const [payMethod, setPayMethod] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setD(await apiJson<OrderDetailResponse>(`/api/orders/${orderId}`)); }
    catch (e) { toast((e as Error).message, "danger"); }
  }, [orderId, toast]);
  useEffect(() => { void load(); }, [load]);

  const plannedCount = useMemo(() => (d?.order.lines ?? []).reduce((n, l) => n + Math.max(1, parseSizeRun(l.sizeRun).length), 0), [d]);

  const patch = async (body: Record<string, unknown>) => {
    try { setD(await apiJson<OrderDetailResponse>(`/api/orders/${orderId}`, { method: "PATCH", body: JSON.stringify(body) })); }
    catch (e) { toast((e as Error).message, "danger"); }
  };
  const transition = async (to: OrderState) => {
    if (to === "CANCELLED") { setCancelling(true); setReason(""); return; }
    const from = d!.order.state;
    try {
      await patch({ state: to });
      const canUndo = canTransition(to, from).ok;
      toast(<span>Moved to {ORDER_STATE_LABEL[to]}{canUndo ? <> · <button type="button" onClick={() => void patch({ state: from })} style={{ background: "none", border: "none", padding: 0, color: "inherit", textDecoration: "underline", cursor: "pointer", font: "inherit" }}>Undo</button></> : null}</span>, "success");
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
  const openPayment = (prefillDeposit: boolean) => {
    const remaining = (d?.money.depositRequiredCents ?? 0) - (d?.money.depositPaidCents ?? 0);
    setPayKind(prefillDeposit ? "DEPOSIT" : "BALANCE");
    setPayEuros(prefillDeposit && remaining > 0 ? (remaining / 100).toFixed(2) : "");
    setPayMethod("");
    setPaying(true);
  };
  const recordPayment = async () => {
    const amountCents = Math.round(parseFloat(payEuros) * 100);
    if (!Number.isFinite(amountCents) || amountCents <= 0) { toast("Enter an amount", "danger"); return; }
    setBusy(true);
    try {
      const r = await apiJson<{ unblocked: number }>(`/api/orders/${orderId}/payments`, { method: "POST", body: JSON.stringify({ kind: payKind, amountCents, method: payMethod.trim() || undefined }) });
      setPaying(false); await load();
      toast(r.unblocked > 0 ? `Payment recorded — deposit met, ${r.unblocked} work order(s) unblocked` : "Payment recorded", "success");
    } catch (e) { toast((e as Error).message, "danger"); } finally { setBusy(false); }
  };

  if (!d) return <div className="factory-page--centered"><Card padded><Button onClick={onBack}>Back</Button></Card></div>;
  const o = d.order;
  const m = d.money;
  const depositDue = m.depositRequiredCents != null && m.depositRequiredCents > 0 && !m.depositMet;

  const targets = legalTargets(o.state).filter((t) => !(o.state === "CONFIRMED" && t === "IN_PRODUCTION")).filter((t) => t !== "CANCELLED" || canCancel);
  const menuItems = targets.map((t) => ({ id: t, label: <>→ {ORDER_STATE_LABEL[t]}</>, onSelect: () => void transition(t) }));

  return (
    <div className="factory-page--centered">
      <DetailHeader
        backLabel="All orders"
        onBack={onBack}
        title={<span style={{ display: "inline-flex", gap: 10, alignItems: "center" }}>{o.number}<Pill tone={STATE_TONE[o.state]}>{ORDER_STATE_LABEL[o.state]}</Pill></span>}
        actions={
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {canEdit && o.state === "CONFIRMED" && <Button variant="primary" onClick={() => setStarting(true)}><Hammer size={13} /> Start production</Button>}
            {canEdit && menuItems.length > 0 && <Menu align="right" label="Change status" items={menuItems} triggerProps={{ className: "h10-ds-btn" }} />}
          </div>
        }
      />
      <div style={{ fontSize: 12, color: "var(--h10-text-3)", marginBottom: 10 }}>
        {o.party.name}
        {o.bornFromQuote ? <> · from <a href={`/quotes?q=${o.bornFromQuote.id}`} style={{ color: "var(--h10-text-link)" }}>{o.bornFromQuote.number}</a></> : null}
        {o.conversation ? <> · <a href={`/inbox?focus=${o.conversation.id}`} style={{ color: "var(--h10-text-link)" }}>thread</a></> : null}
      </div>

      {o.state === "CANCELLED" && o.cancelReason && (
        <div style={{ marginBottom: 12, padding: 10, background: "var(--h10-wash-danger, #fdecec)", borderRadius: 8, fontSize: 12.5, color: "var(--h10-danger)" }}>Cancelled — {o.cancelReason}</div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 340px", gap: 16 }}>
        <Card padded>
          <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 8 }}>Timeline</div>
          <Timeline events={d.timeline} />
        </Card>

        <div style={{ display: "grid", gap: 12, alignContent: "start" }}>
          {(m.netCents != null || m.marginCents != null) && (
            <Card padded>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: "var(--h10-text-3)", textTransform: "uppercase", letterSpacing: 0.4 }}>Money</span>
                {canPay && <button type="button" onClick={() => openPayment(false)} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontSize: 11.5, color: "var(--h10-text-link)" }}>+ Record payment</button>}
              </div>
              {m.netCents != null && <RailRow label="Net">{eur(m.netCents)}</RailRow>}
              {m.costCents != null && <RailRow label="Cost">{eur(m.costCents)}</RailRow>}
              {canMargin && m.marginCents != null && <RailRow label="Margin" tone={m.marginCents < 0 ? "var(--h10-danger)" : "var(--h10-success)"}>{eur(m.marginCents)} · {(m.marginPct ?? 0).toFixed(0)}%</RailRow>}
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

          <Card padded>
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--h10-text-3)", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 }}>Dates</div>
            <div style={{ display: "grid", gap: 4 }}>
              <div style={{ fontSize: 11.5, color: "var(--h10-text-3)" }}>Promise date</div>
              <DateField ariaLabel="Promise date" value={isoDate(o.promiseDateAt)} onChange={(v) => void patch({ promiseDateAt: v ? new Date(`${v}T12:00:00`).toISOString() : null })} disabled={!canEdit} />
              <RailRow label="Confirmed">{new Date(o.createdAt).toLocaleDateString()}</RailRow>
            </div>
          </Card>

          <Card padded>
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--h10-text-3)", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 }}>Work orders</div>
            {o.workOrders.length === 0 ? (
              <div style={{ fontSize: 12, color: "var(--h10-text-3)" }}>{o.state === "CONFIRMED" ? "None yet — Start production creates them." : "None."}</div>
            ) : (
              <div style={{ display: "grid", gap: 6 }}>
                {o.workOrders.map((w) => (
                  <div key={w.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12.5 }}>
                    <span style={{ fontWeight: 600, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{w.number}{w.label ? <span style={{ color: "var(--h10-text-3)", fontWeight: 400 }}> · {w.label}</span> : null}</span>
                    <span style={{ display: "inline-flex", gap: 5, alignItems: "center", flex: "0 0 auto" }}>
                      <span style={{ color: "var(--h10-text-3)", fontSize: 11 }}>{w.stages.length} stages</span>
                      <Pill tone={w.state === "BLOCKED" ? "warning" : w.state === "DONE" ? "success" : "info"}>{w.state === "BLOCKED" ? (w.blockedReason ?? "blocked") : w.state.toLowerCase()}</Pill>
                    </span>
                  </div>
                ))}
                <div style={{ fontSize: 11, color: "var(--h10-text-3)", marginTop: 2 }}>The production floor (running these stages) arrives in FP6.</div>
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
