/**
 * FP4 — one order, the operator's home for it: the ONE-TIMELINE on the left,
 * a rail of money / deposit (FD13) / dates / work orders on the right, and the
 * lifecycle in the header. Start production + Record payment wire in FP4.3.
 * Centered (editor archetype) per the content-width convention.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { DetailHeader } from "@/design-system/patterns";
import { Card, DateField, Menu, Modal, useToast } from "@/design-system/components";
import { Button, Pill } from "@/design-system/primitives";
import { eur } from "@/design-system/lib/format";
import { apiJson } from "@/lib/api-client";
import { usePermission } from "@/lib/auth/client";
import { legalTargets, ORDER_STATE_LABEL, canTransition } from "@/lib/orders/transitions";
import { Timeline } from "./Timeline";
import { STATE_TONE, type OrderDetailResponse, type OrderState } from "./types";

const isoDate = (s: string | null | undefined) => (s ? new Date(s).toISOString().slice(0, 10) : "");

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
  const [d, setD] = useState<OrderDetailResponse | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setD(await apiJson<OrderDetailResponse>(`/api/orders/${orderId}`)); }
    catch (e) { toast((e as Error).message, "danger"); }
  }, [orderId, toast]);
  useEffect(() => { void load(); }, [load]);

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

  if (!d) return <div className="factory-page--centered"><Card padded><Button onClick={onBack}>Back</Button></Card></div>;
  const o = d.order;
  const m = d.money;

  const targets = legalTargets(o.state).filter((t) => !(o.state === "CONFIRMED" && t === "IN_PRODUCTION")).filter((t) => t !== "CANCELLED" || canCancel);
  const menuItems = targets.map((t) => ({ id: t, label: <>→ {ORDER_STATE_LABEL[t]}</>, onSelect: () => void transition(t) }));

  return (
    <div className="factory-page--centered">
      <DetailHeader
        backLabel="All orders"
        onBack={onBack}
        title={<span style={{ display: "inline-flex", gap: 10, alignItems: "center" }}>{o.number}<Pill tone={STATE_TONE[o.state]}>{ORDER_STATE_LABEL[o.state]}</Pill></span>}
        actions={canEdit && menuItems.length > 0 ? <Menu align="right" label="Change status" items={menuItems} triggerProps={{ className: "h10-ds-btn" }} /> : undefined}
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
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--h10-text-3)", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 }}>Money</div>
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
              <div style={{ fontSize: 12, color: "var(--h10-text-3)" }}>None yet — Start production creates them (FP4.3).</div>
            ) : (
              <div style={{ display: "grid", gap: 6 }}>
                {o.workOrders.map((w) => (
                  <div key={w.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12.5 }}>
                    <span style={{ fontWeight: 600 }}>{w.number}{w.label ? <span style={{ color: "var(--h10-text-3)", fontWeight: 400 }}> · {w.label}</span> : null}</span>
                    <span style={{ display: "inline-flex", gap: 5, alignItems: "center" }}>
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

      <Modal open={cancelling} onClose={() => setCancelling(false)} title={`Cancel ${o.number}?`} size="sm"
        footer={<><Button onClick={() => setCancelling(false)}>Keep order</Button><Button onClick={confirmCancel} disabled={!reason.trim() || busy} style={{ background: "var(--h10-danger)", color: "#fff", borderColor: "var(--h10-danger)" }}>Cancel order</Button></>}>
        <div style={{ display: "grid", gap: 8 }}>
          <div style={{ fontSize: 12.5, color: "var(--h10-text-2)" }}>A reason is required. Open work orders are cancelled with the order.</div>
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} placeholder="Why is this order being cancelled?" style={{ border: "1px solid var(--h10-border)", borderRadius: 8, padding: 9, fontSize: 12.5, fontFamily: "inherit", background: "var(--h10-surface)", color: "var(--h10-text)" }} />
        </div>
      </Modal>
    </div>
  );
}
