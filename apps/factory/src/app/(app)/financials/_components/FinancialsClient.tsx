/**
 * FP9.1 — the money page: headline tiles (outstanding / deposits due / this
 * month) over a per-order rollup — quoted → invoiced → paid → balance, and the
 * margin sliding from estimate to actual as the floor consumes material. Every
 * order number drills to /orders. This whole page is behind pages.financials,
 * so a worker never reaches it.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { Euro, FilePlus, Send, ArrowUpRight, Printer } from "lucide-react";
import { Card, DataGrid, Drawer, useToast } from "@/design-system/components";
import { Button, Pill } from "@/design-system/primitives";
import { eur } from "@/design-system/lib/format";
import { apiJson } from "@/lib/api-client";
import { usePermission } from "@/lib/auth/client";
import { type FinancialDetail, type FinancialsResponse, type InvoiceRow, type OrderFin, type PaymentRow } from "./types";

const money = (c?: number) => (c == null ? "—" : eur(c));

export function FinancialsClient() {
  const { toast } = useToast();
  const canMargin = usePermission("financials.margins.view");
  const canInvoice = usePermission("invoices.manage");
  const [data, setData] = useState<FinancialsResponse | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<FinancialDetail | null>(null);

  const load = useCallback(async () => {
    try { setData(await apiJson<FinancialsResponse>("/api/financials")); }
    catch (e) { toast((e as Error).message, "danger"); }
  }, [toast]);
  useEffect(() => { void load(); }, [load]);

  const loadDetail = useCallback(async (id: string) => {
    try { setDetail(await apiJson<FinancialDetail>(`/api/financials/order/${id}`)); }
    catch (e) { toast((e as Error).message, "danger"); }
  }, [toast]);
  const openDetail = (id: string) => { setDetailId(id); setDetail(null); void loadDetail(id); };

  const t = data?.tiles;
  return (
    <div className="factory-page factory-grid-grow-1">
      <div style={{ marginBottom: 14 }}>
        <h1 style={{ fontSize: 18, fontWeight: 700, margin: 0, display: "flex", alignItems: "center", gap: 8 }}><Euro size={18} /> Financials</h1>
        <div style={{ fontSize: 12.5, color: "var(--h10-text-2)", marginTop: 2 }}>Order-level money truth — who owes what, and what each order really made. Not accounting.</div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12, marginBottom: 20 }}>
        <Tile label="Outstanding balance" value={money(t?.outstandingCents)} tone="warning" />
        <Tile label="Deposits due" value={money(t?.depositsDueCents)} tone="danger" />
        <Tile label="Invoiced this month" value={money(t?.monthInvoicedCents)} />
        <Tile label="Paid this month" value={money(t?.monthPaidCents)} tone="success" />
      </div>

      <DataGrid
        columns={[
          { key: "number", label: "Order", render: (r: OrderFin) => <button type="button" onClick={() => openDetail(r.orderId)} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", font: "inherit", fontWeight: 700, color: "var(--h10-text-link)" }}>{r.number}</button> },
          { key: "party", label: "Customer", render: (r: OrderFin) => r.partyName },
          { key: "state", label: "State", render: (r: OrderFin) => <span style={{ fontSize: 12, color: "var(--h10-text-3)" }}>{r.state.replace("_", " ").toLowerCase()}</span> },
          { key: "quoted", label: "Quoted", align: "right" as const, render: (r: OrderFin) => money(r.quotedNetCents) },
          { key: "invoiced", label: "Invoiced", align: "right" as const, render: (r: OrderFin) => money(r.invoicedCents) },
          { key: "paid", label: "Paid", align: "right" as const, render: (r: OrderFin) => money(r.paidCents) },
          { key: "balance", label: "Balance", align: "right" as const, render: (r: OrderFin) => (r.balanceCents === 0 ? <Pill tone="success">paid</Pill> : <span style={{ color: (r.balanceCents ?? 0) > 0 ? "var(--h10-warning-text, var(--h10-text))" : "var(--h10-text)", fontWeight: 600 }}>{money(r.balanceCents)}</span>) },
          ...(canMargin ? [{ key: "margin", label: "Margin", align: "right" as const, render: (r: OrderFin) => <MarginCell r={r} /> }] : []),
        ]}
        rows={data?.orders ?? []}
        rowKey={(r: OrderFin) => r.orderId}
        emptyState="No orders yet — money lands here as quotes convert."
      />

      <MoneyDrawer id={detailId} detail={detail} canInvoice={canInvoice} canMargin={canMargin} onClose={() => setDetailId(null)} onChanged={() => { void load(); if (detailId) void loadDetail(detailId); }} />
    </div>
  );
}

function MoneyDrawer({ id, detail, canInvoice, canMargin, onClose, onChanged }: { id: string | null; detail: FinancialDetail | null; canInvoice: boolean; canMargin: boolean; onClose: () => void; onChanged: () => void }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);

  const createInvoice = async () => {
    if (!detail) return;
    setBusy(true);
    try {
      const r = await apiJson<{ invoice: { number: string } }>("/api/invoices", { method: "POST", body: JSON.stringify({ orderId: detail.order.id }) });
      toast(`Invoice ${r.invoice.number} created`, "success");
      onChanged();
    } catch (e) { toast((e as Error).message, "danger"); } finally { setBusy(false); }
  };
  const invAction = async (invId: string, action: "send" | "paid") => {
    setBusy(true);
    try {
      await apiJson(`/api/invoices/${invId}`, { method: "PATCH", body: JSON.stringify({ action }) });
      toast(action === "paid" ? "Marked paid — a balance payment was recorded" : "Marked sent", "success");
      onChanged();
    } catch (e) { toast((e as Error).message, "danger"); } finally { setBusy(false); }
  };

  const d = detail;
  const roll = d?.rollup;
  return (
    <Drawer open={!!id} onClose={onClose} title={d ? `Money · ${d.order.number}` : "Money"} footer={d ? (
      <div style={{ display: "flex", gap: 8, width: "100%", alignItems: "center" }}>
        {canInvoice && <Button variant="primary" onClick={createInvoice} disabled={busy}><FilePlus size={13} /> New invoice</Button>}
        <a href={`/orders?o=${d.order.id}`} className="h10-ds-btn" style={{ marginLeft: "auto", textDecoration: "none", display: "inline-flex", gap: 6, alignItems: "center" }}>Open order <ArrowUpRight size={13} /></a>
      </div>
    ) : undefined}>
      {d && roll && (
        <div style={{ display: "grid", gap: 16 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <Fig label="Quoted" value={money(roll.quotedNetCents)} />
            <Fig label="Invoiced" value={money(roll.invoicedCents)} />
            <Fig label="Paid" value={money(roll.paidCents)} />
            <Fig label="Balance" value={money(roll.balanceCents)} strong={roll.balanceCents !== 0} />
            {canMargin && <Fig label={roll.actualIsPending ? "Margin (est)" : "Margin (actual)"} value={money(roll.actualIsPending ? roll.estMarginCents : roll.actualMarginCents)} />}
          </div>

          <div>
            <div style={sub}>Invoices</div>
            {d.invoices.length === 0 ? <Empty>No invoices yet.</Empty> : d.invoices.map((iv: InvoiceRow) => (
              <div key={iv.id} style={row}>
                <a href={`/api/invoices/${iv.id}`} target="_blank" rel="noreferrer" style={{ color: "var(--h10-text-link)", fontWeight: 600, display: "inline-flex", gap: 4, alignItems: "center" }}><Printer size={12} /> {iv.number}</a>
                <span style={{ marginLeft: "auto", display: "inline-flex", gap: 8, alignItems: "center" }}>
                  <span style={{ fontVariantNumeric: "tabular-nums" }}>{money(iv.amountCents)}</span>
                  {iv.paidAt ? <Pill tone="success">paid</Pill> : iv.sentAt ? <Pill tone="info">sent</Pill> : <Pill tone="neutral">draft</Pill>}
                  {canInvoice && !iv.paidAt && (
                    <>
                      {!iv.sentAt && <button type="button" disabled={busy} onClick={() => invAction(iv.id, "send")} style={miniBtn}><Send size={11} /> Send</button>}
                      <button type="button" disabled={busy} onClick={() => invAction(iv.id, "paid")} style={miniBtn}>Mark paid</button>
                    </>
                  )}
                </span>
              </div>
            ))}
          </div>

          <div>
            <div style={sub}>Payments</div>
            {d.payments.length === 0 ? <Empty>No payments yet.</Empty> : d.payments.map((p: PaymentRow) => (
              <div key={p.id} style={row}>
                <span style={{ fontSize: 12.5 }}>{p.kind.toLowerCase()}{p.method ? <span style={{ color: "var(--h10-text-3)" }}> · {p.method}</span> : null}</span>
                <span style={{ marginLeft: "auto", display: "inline-flex", gap: 8, alignItems: "center" }}>
                  <span style={{ fontVariantNumeric: "tabular-nums" }}>{money(p.amountCents)}</span>
                  <span style={{ fontSize: 11, color: "var(--h10-text-3)" }}>{new Date(p.receivedAt).toLocaleDateString()}</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Drawer>
  );
}

const sub: React.CSSProperties = { fontSize: 11.5, color: "var(--h10-text-3)", marginBottom: 6 };
const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, padding: "7px 0", borderBottom: "1px solid var(--h10-border-subtle)", fontSize: 12.5 };
const miniBtn: React.CSSProperties = { border: "1px solid var(--h10-border)", borderRadius: 6, background: "var(--h10-surface)", cursor: "pointer", fontSize: 11, padding: "3px 7px", color: "var(--h10-text-2)", display: "inline-flex", gap: 4, alignItems: "center" };
function Fig({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return <div style={{ border: "1px solid var(--h10-border-subtle)", borderRadius: 8, padding: "8px 10px" }}><div style={{ fontSize: 10.5, color: "var(--h10-text-3)", textTransform: "uppercase", letterSpacing: 0.3 }}>{label}</div><div style={{ fontSize: 15, fontWeight: strong ? 700 : 600, fontVariantNumeric: "tabular-nums" }}>{value}</div></div>;
}
function Empty({ children }: { children: React.ReactNode }) { return <div style={{ fontSize: 12, color: "var(--h10-text-3)", padding: "4px 0" }}>{children}</div>; }

function Tile({ label, value, tone }: { label: string; value: string; tone?: "warning" | "danger" | "success" }) {
  const color = tone === "warning" ? "var(--h10-text)" : tone === "danger" ? "var(--h10-danger)" : tone === "success" ? "var(--h10-success-text, var(--h10-text))" : "var(--h10-text)";
  return (
    <Card>
      <div style={{ padding: "14px 16px" }}>
        <div style={{ fontSize: 11.5, color: "var(--h10-text-3)", textTransform: "uppercase", letterSpacing: 0.3, marginBottom: 6 }}>{label}</div>
        <div style={{ fontSize: 22, fontWeight: 700, color, fontVariantNumeric: "tabular-nums" }}>{value}</div>
      </div>
    </Card>
  );
}

function MarginCell({ r }: { r: OrderFin }) {
  const cents = r.actualIsPending ? r.estMarginCents : r.actualMarginCents;
  const pctv = r.actualIsPending ? r.estMarginPct : r.actualMarginPct;
  if (cents == null) return <>—</>;
  return (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "center", justifyContent: "flex-end" }}>
      <span style={{ fontVariantNumeric: "tabular-nums" }}>{eur(cents)} <span style={{ color: "var(--h10-text-3)" }}>{pctv != null ? `${pctv.toFixed(0)}%` : ""}</span></span>
      <Pill tone={r.actualIsPending ? "neutral" : "info"}>{r.actualIsPending ? "est" : "actual"}</Pill>
    </span>
  );
}
