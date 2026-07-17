/**
 * EPF2 — one order's money drawer: rollup figures, the display-only VAT/gross
 * line (P2 close — the rate was PDF/CSV-only before), invoices with Send /
 * Mark-paid (mark-paid goes through a consequence modal — D-09), payments
 * incl. REFUND rows, and the footer actions. Body shows a SKELETON while the
 * detail loads (D-08). Deep-linkable: the container owns `?o=` (pushState so
 * Back closes — the EPO.7 idiom); this component is purely presentational.
 */
"use client";

import { ArrowUpRight, CreditCard, FilePlus, Printer, Send } from "lucide-react";
import { Drawer, useToast } from "@/design-system/components";
import { Button, Pill, Skeleton } from "@/design-system/primitives";
import { eur } from "@/design-system/lib/format";
import { apiJson } from "@/lib/api-client";
import { vatDisplay } from "@/lib/financials/rollup";
import { money } from "./MoneyGrids";
import type { FinancialDetail, InvoiceRow, PaymentRow } from "./types";

const sub: React.CSSProperties = { fontSize: 11.5, color: "var(--h10-text-3)", marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.3 };
const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, padding: "7px 0", borderBottom: "1px solid var(--h10-border-subtle)", fontSize: 12.5 };
const miniBtn: React.CSSProperties = { border: "1px solid var(--h10-border)", borderRadius: 6, background: "var(--h10-surface)", cursor: "pointer", fontSize: 11, padding: "3px 7px", color: "var(--h10-text-2)", display: "inline-flex", gap: 4, alignItems: "center" };

function Fig({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div style={{ border: "1px solid var(--h10-border-subtle)", borderRadius: 8, padding: "8px 10px" }}>
      <div style={{ fontSize: 10.5, color: "var(--h10-text-3)", textTransform: "uppercase", letterSpacing: 0.3 }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: strong ? 700 : 600, fontVariantNumeric: "tabular-nums" }}>{value}</div>
    </div>
  );
}
function Empty({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 12, color: "var(--h10-text-3)", padding: "4px 0" }}>{children}</div>;
}

const KIND_TONE: Record<string, "success" | "info" | "neutral" | "danger"> = { DEPOSIT: "info", BALANCE: "success", OTHER: "neutral", REFUND: "danger" };

export function MoneyDrawer({
  open, detail, busy, canInvoice, canMargin, canPay,
  onNewInvoice, onMarkPaid, onPay, onChanged, onClose, setBusy,
}: {
  open: boolean;
  detail: FinancialDetail | null;
  busy: boolean;
  canInvoice: boolean;
  canMargin: boolean;
  canPay: boolean;
  onNewInvoice: () => void;
  onMarkPaid: (iv: InvoiceRow) => void;
  onPay: () => void;
  onChanged: () => void;
  onClose: () => void;
  setBusy: (b: boolean) => void;
}) {
  const { toast } = useToast();
  const d = detail;
  const roll = d?.rollup;

  const sendInvoice = async (invId: string) => {
    setBusy(true);
    try {
      await apiJson(`/api/invoices/${invId}`, { method: "PATCH", body: JSON.stringify({ action: "send" }) });
      toast("Marked sent", "success");
      onChanged();
    } catch (e) { toast((e as Error).message, "danger"); } finally { setBusy(false); }
  };

  const vat = roll?.quotedNetCents != null && d?.vatRatePct != null ? vatDisplay(roll.quotedNetCents, d.vatRatePct) : null;

  return (
    <Drawer open={open} onClose={onClose} title={d ? `Money · ${d.order.number}` : "Money"} subtitle={d ? d.order.partyName : undefined}
      footer={d ? (
        <div style={{ display: "flex", gap: 8, width: "100%", alignItems: "center" }}>
          {canInvoice && <Button variant="primary" onClick={onNewInvoice} disabled={busy}><FilePlus size={13} /> New invoice</Button>}
          {canPay && <Button onClick={onPay} disabled={busy}><CreditCard size={13} /> Record payment</Button>}
          <a href={`/orders?o=${d.order.id}`} className="h10-ds-btn" style={{ marginLeft: "auto", textDecoration: "none", display: "inline-flex", gap: 6, alignItems: "center" }}>Open order <ArrowUpRight size={13} /></a>
        </div>
      ) : undefined}>
      {!d || !roll ? (
        // EPF2 (D-08) — drawer body skeleton while the detail loads
        <div style={{ display: "grid", gap: 10 }} data-testid="drawer-skeleton">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} height={52} radius={8} />)}
          </div>
          <Skeleton height={14} width="60%" />
          <Skeleton height={80} radius={8} />
          <Skeleton height={80} radius={8} />
        </div>
      ) : (
        <div style={{ display: "grid", gap: 16 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <Fig label="Quoted" value={money(roll.quotedNetCents)} />
            <Fig label="Invoiced" value={money(roll.invoicedCents)} />
            <Fig label="Paid" value={money(roll.paidCents)} />
            <Fig label="Balance" value={money(roll.balanceCents)} strong={roll.balanceCents !== 0} />
            {canMargin && <Fig label={roll.actualIsPending ? "Margin (est)" : "Margin (actual)"} value={money(roll.actualIsPending ? roll.estMarginCents : roll.actualMarginCents)} />}
          </div>

          {/* EPF2 (P2/D-12) — VAT display line + currency caption; still not accounting */}
          <div style={{ fontSize: 11.5, color: "var(--h10-text-3)", lineHeight: 1.5 }}>
            {vat && (
              <div data-testid="vat-line">
                VAT {vat.ratePct}% (display only): net {eur(vat.netCents)} + VAT {eur(vat.vatCents)} = gross <b style={{ color: "var(--h10-text-2)" }}>{eur(vat.grossCents)}</b>
              </div>
            )}
            <div>All figures EUR · net unless labeled.</div>
          </div>

          <div>
            <div style={sub}>Invoices</div>
            {d.invoices.length === 0 ? <Empty>No invoices yet — "New invoice" defaults to what's still owed.</Empty> : d.invoices.map((iv: InvoiceRow) => (
              <div key={iv.id} style={row}>
                <a href={`/api/invoices/${iv.id}`} target="_blank" rel="noreferrer" style={{ color: "var(--h10-text-link)", fontWeight: 600, display: "inline-flex", gap: 4, alignItems: "center" }}><Printer size={12} /> {iv.number}</a>
                <span style={{ marginLeft: "auto", display: "inline-flex", gap: 8, alignItems: "center" }}>
                  <span style={{ fontVariantNumeric: "tabular-nums" }}>{money(iv.amountCents)}</span>
                  {iv.paidAt ? <Pill tone="success">paid</Pill> : iv.sentAt ? <Pill tone="info">sent</Pill> : <Pill tone="neutral">draft</Pill>}
                  {canInvoice && !iv.paidAt && (
                    <>
                      {!iv.sentAt && <button type="button" disabled={busy} onClick={() => void sendInvoice(iv.id)} style={miniBtn}><Send size={11} /> Send</button>}
                      <button type="button" disabled={busy} onClick={() => onMarkPaid(iv)} style={miniBtn}>Mark paid</button>
                    </>
                  )}
                </span>
              </div>
            ))}
          </div>

          <div>
            <div style={sub}>Payments</div>
            {d.payments.length === 0 ? <Empty>No payments yet.</Empty> : d.payments.map((p: PaymentRow) => (
              <div key={p.id} style={{ ...row, alignItems: "flex-start" }}>
                <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                  <Pill tone={KIND_TONE[p.kind] ?? "neutral"}>{p.kind.toLowerCase()}</Pill>
                  {p.method ? <span style={{ color: "var(--h10-text-3)" }}>{p.method}</span> : null}
                </span>
                <span style={{ marginLeft: "auto", display: "grid", justifyItems: "end", gap: 2 }}>
                  <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
                    <span style={{ fontVariantNumeric: "tabular-nums", color: (p.amountCents ?? 0) < 0 ? "var(--h10-danger)" : undefined }}>{money(p.amountCents)}</span>
                    <span style={{ fontSize: 11, color: "var(--h10-text-3)" }}>{new Date(p.receivedAt).toLocaleDateString()}</span>
                  </span>
                  {p.notes && <span style={{ fontSize: 11, color: "var(--h10-text-3)", maxWidth: 260, textAlign: "right" }}>{p.notes}</span>}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Drawer>
  );
}
