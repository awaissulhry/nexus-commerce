/**
 * EPF2 (D-09 close) — the invoice consequence dialogs. New invoice previews
 * the number-to-be (INV-<Rome year>-…), defaults the amount to net − paid
 * (editable → partial invoices land here; EU-safe parse) and states the
 * consequence; 400s (nothing invoiceable / cap exceeded) render INLINE with
 * the remaining-invoiceable figure. Mark-paid states the BALANCE payment it
 * records; a 409 {overpayCents} escalates to an explicit overpay confirm that
 * re-sends allowOverpay: true — overpaying is a decision, never an accident.
 */
"use client";

import { useEffect, useState } from "react";
import { Modal, useToast } from "@/design-system/components";
import { Button, Input } from "@/design-system/primitives";
import { eur } from "@/design-system/lib/format";
import { apiFetch } from "@/lib/api-client";
import { parseAmountToCents } from "@/lib/financials/money-ux";
import { romeYear } from "@/lib/financials/rome-time";
import type { FinancialDetail, InvoiceRow } from "./types";

const lbl: React.CSSProperties = { fontSize: 11.5, color: "var(--h10-text-3)", marginBottom: 3 };
const consequence: React.CSSProperties = { fontSize: 12.5, color: "var(--h10-text-2)", lineHeight: 1.5 };
const errBox: React.CSSProperties = { fontSize: 12.5, color: "var(--h10-danger)", background: "var(--h10-wash-danger, rgba(220,38,38,0.06))", border: "1px solid var(--h10-danger)", borderRadius: 8, padding: "8px 10px", lineHeight: 1.5 };

export function NewInvoiceModal({ detail, open, onClose, onDone }: { detail: FinancialDetail | null; open: boolean; onClose: () => void; onDone: (number: string) => void }) {
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<{ message: string; remainingInvoiceableCents?: number } | null>(null);
  const [busy, setBusy] = useState(false);

  const roll = detail?.rollup;
  const defaultCents = roll?.quotedNetCents != null && roll.paidCents != null ? Math.max(0, roll.quotedNetCents - roll.paidCents) : null;
  useEffect(() => {
    if (open) {
      setAmount(defaultCents != null ? (defaultCents / 100).toFixed(2) : "");
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset on open only
  }, [open, detail?.order.id]);

  if (!detail || !roll) return null;
  const cents = parseAmountToCents(amount);
  const numberPreview = `INV-${romeYear(new Date().toISOString())}-…`;

  const submit = async () => {
    if (cents == null || cents <= 0) { setError({ message: "Enter a positive amount." }); return; }
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch("/api/invoices", { method: "POST", body: JSON.stringify({ orderId: detail.order.id, netCents: cents }) });
      const body = (await res.json().catch(() => ({}))) as { error?: string; remainingInvoiceableCents?: number; invoice?: { number: string } };
      if (!res.ok) {
        setError({ message: body.error ?? `HTTP ${res.status}`, remainingInvoiceableCents: body.remainingInvoiceableCents });
        return;
      }
      onDone(body.invoice?.number ?? numberPreview);
    } catch (e) {
      setError({ message: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={`New invoice — ${detail.order.number}`} size="sm"
      footer={<><Button onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" onClick={() => void submit()} disabled={busy || cents == null || cents <= 0}>Create invoice</Button></>}>
      <div style={{ display: "grid", gap: 10 }}>
        <div style={consequence}>
          Creates <b>{numberPreview}</b> for {detail.order.partyName} — the number is minted atomically on create and the PDF is generated immediately.
          {defaultCents != null && <> Default is what's still owed: net {eur(roll.quotedNetCents ?? 0)} − paid {eur(roll.paidCents ?? 0)} = <b>{eur(defaultCents)}</b>.</>}
          {" "}Edit the amount for a partial invoice; Σ invoices stays ≤ order net.
        </div>
        <div>
          <div style={lbl}>Amount (€)</div>
          <Input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0,00" aria-label="Invoice amount in EUR" />
          {cents != null && <div style={{ fontSize: 11, color: "var(--h10-text-3)", marginTop: 3 }}>= {eur(cents)}</div>}
        </div>
        {error && (
          <div style={errBox} data-testid="invoice-error">
            {error.message}
            {error.remainingInvoiceableCents != null && <div>Remaining invoiceable on this order: <b>{eur(error.remainingInvoiceableCents)}</b>.</div>}
          </div>
        )}
      </div>
    </Modal>
  );
}

export function MarkPaidModal({ target, open, onClose, onDone }: { target: { inv: InvoiceRow; orderNumber: string } | null; open: boolean; onClose: () => void; onDone: () => void }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [overpay, setOverpay] = useState<{ overpayCents: number; message: string } | null>(null);
  useEffect(() => { if (open) setOverpay(null); }, [open, target?.inv.id]);

  if (!target) return null;
  const { inv, orderNumber } = target;

  const send = async (allowOverpay: boolean) => {
    setBusy(true);
    try {
      const res = await apiFetch(`/api/invoices/${inv.id}`, { method: "PATCH", body: JSON.stringify({ action: "paid", ...(allowOverpay ? { allowOverpay: true } : {}) }) });
      const body = (await res.json().catch(() => ({}))) as { error?: string; overpayCents?: number };
      if (res.status === 409 && body.overpayCents != null) {
        // EPF1's guard: escalate to the explicit overpay confirm
        setOverpay({ overpayCents: body.overpayCents, message: body.error ?? "" });
        return;
      }
      if (!res.ok) { toast(body.error ?? `HTTP ${res.status}`, "danger"); return; }
      toast(`${inv.number} marked paid — a balance payment was recorded`, "success");
      onDone();
    } catch (e) {
      toast((e as Error).message, "danger");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={overpay ? `Overpay ${orderNumber}?` : `Mark ${inv.number} paid?`} size="sm"
      footer={overpay ? (
        <><Button onClick={onClose} disabled={busy}>Cancel</Button><Button onClick={() => void send(true)} disabled={busy} style={{ background: "var(--h10-danger)", color: "#fff", borderColor: "var(--h10-danger)" }}>Record overpayment</Button></>
      ) : (
        <><Button onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" onClick={() => void send(false)} disabled={busy}>Mark paid</Button></>
      )}>
      {overpay ? (
        <div style={{ display: "grid", gap: 8 }}>
          <div style={errBox} data-testid="overpay-confirm">
            {overpay.message || `Marking ${inv.number} paid would overpay ${orderNumber}.`}
          </div>
          <div style={consequence}>
            Recording it anyway overpays by <b>{eur(overpay.overpayCents)}</b>. This is an explicit, audited decision — refunds can correct it later.
          </div>
        </div>
      ) : (
        <div style={consequence}>
          Records a <b>BALANCE payment of {inv.amountCents != null ? eur(inv.amountCents) : "the invoice amount"}</b> against {orderNumber} and stamps {inv.number} paid.
          The payment lands in the order's money history and rings the bell.
        </div>
      )}
    </Modal>
  );
}
