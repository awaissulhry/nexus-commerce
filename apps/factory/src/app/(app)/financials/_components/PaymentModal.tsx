/**
 * EPF2 (P2 hygiene + D-09/D-11) — the payment modal on DS inputs. Kind
 * defaults CONTEXT-SENSITIVELY (DEPOSIT while the FD13 gate is open, else
 * BALANCE); the amount parse is EU-safe (`1.234,56` and `1,234.56` both
 * correct); a DateField carries the value date (receivedAt, defaults today);
 * REFUND is a first-class kind (negative amount sent, mandatory note, its own
 * consequence line). A 409 {overpayCents} escalates to the explicit overpay
 * confirm re-sending allowOverpay: true. The idempotency key is minted once
 * per open — retries and double-clicks land the money exactly once.
 */
"use client";

import { useEffect, useMemo, useState } from "react";
import { DateField, Listbox, Modal, useToast } from "@/design-system/components";
import { Button, Input, Textarea } from "@/design-system/primitives";
import { eur } from "@/design-system/lib/format";
import { apiFetch } from "@/lib/api-client";
import { defaultPaymentKind, parseAmountToCents } from "@/lib/financials/money-ux";
import { romeDayKey } from "@/lib/financials/rome-time";
import type { FinancialDetail } from "./types";

const lbl: React.CSSProperties = { fontSize: 11.5, color: "var(--h10-text-3)", marginBottom: 3 };
const consequence: React.CSSProperties = { fontSize: 12.5, color: "var(--h10-text-2)", lineHeight: 1.5 };
const errBox: React.CSSProperties = { fontSize: 12.5, color: "var(--h10-danger)", background: "var(--h10-wash-danger, rgba(220,38,38,0.06))", border: "1px solid var(--h10-danger)", borderRadius: 8, padding: "8px 10px", lineHeight: 1.5 };

const KIND_OPTIONS = [
  { value: "DEPOSIT", label: "Deposit" },
  { value: "BALANCE", label: "Balance" },
  { value: "OTHER", label: "Other" },
  { value: "REFUND", label: "Refund (money back)" },
];

export function PaymentModal({ detail, open, onClose, onDone }: { detail: FinancialDetail | null; open: boolean; onClose: () => void; onDone: (unblocked: number) => void }) {
  const { toast } = useToast();
  const [kind, setKind] = useState("BALANCE");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState("");
  const [method, setMethod] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [overpay, setOverpay] = useState<{ overpayCents: number; message: string } | null>(null);
  // EPO1.3 (C4) — minted once per open; the overpay retry reuses it
  const idempotencyKey = useMemo(() => (open ? crypto.randomUUID() : ""), [open]);

  useEffect(() => {
    if (open && detail) {
      setKind(defaultPaymentKind(detail.rollup)); // FD13: DEPOSIT while the gate is open
      setAmount("");
      setDate(romeDayKey(new Date().toISOString())); // value date defaults today (Rome)
      setMethod("");
      setNotes("");
      setOverpay(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset on open only
  }, [open, detail?.order.id]);

  if (!detail) return null;
  const isRefund = kind === "REFUND";
  const cents = parseAmountToCents(amount);
  const magnitude = cents == null ? null : Math.abs(cents);
  const valid = magnitude != null && magnitude > 0 && (!isRefund || notes.trim().length > 0);

  const submit = async (allowOverpay: boolean) => {
    if (!valid || magnitude == null) return;
    setBusy(true);
    try {
      const body = {
        kind,
        amountCents: isRefund ? -magnitude : magnitude, // REFUND is negative on the wire
        method: method.trim() || undefined,
        notes: notes.trim() || undefined,
        receivedAt: date || undefined,
        idempotencyKey,
        ...(allowOverpay ? { allowOverpay: true } : {}),
      };
      const res = await apiFetch(`/api/orders/${detail.order.id}/payments`, { method: "POST", body: JSON.stringify(body) });
      const data = (await res.json().catch(() => ({}))) as { error?: string; overpayCents?: number; unblocked?: number; duplicate?: boolean };
      if (res.status === 409 && data.overpayCents != null) {
        setOverpay({ overpayCents: data.overpayCents, message: data.error ?? "" });
        return;
      }
      if (!res.ok) { toast(data.error ?? `HTTP ${res.status}`, "danger"); return; }
      const unblocked = data.unblocked ?? 0;
      toast(
        data.duplicate ? "Already recorded — this payment had landed on a previous attempt"
          : isRefund ? `Refund of ${eur(magnitude)} recorded`
          : unblocked > 0 ? `Payment recorded — ${unblocked} work order(s) unblocked`
          : "Payment recorded",
        "success",
      );
      onDone(unblocked);
    } catch (e) {
      toast((e as Error).message, "danger");
    } finally {
      setBusy(false);
    }
  };

  const gateOpen = (detail.rollup.depositRequiredCents ?? 0) > 0 && detail.rollup.depositMet !== true;

  return (
    <Modal open={open} onClose={onClose} title={overpay ? `Overpay ${detail.order.number}?` : `Record payment — ${detail.order.number}`} size="sm"
      footer={overpay ? (
        <><Button onClick={() => setOverpay(null)} disabled={busy}>Back</Button><Button onClick={() => void submit(true)} disabled={busy} style={{ background: "var(--h10-danger)", color: "#fff", borderColor: "var(--h10-danger)" }}>Record overpayment</Button></>
      ) : (
        <><Button onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" onClick={() => void submit(false)} disabled={busy || !valid}>{isRefund ? "Record refund" : "Record"}</Button></>
      )}>
      {overpay ? (
        <div style={{ display: "grid", gap: 8 }}>
          <div style={errBox} data-testid="overpay-confirm">{overpay.message || "This would overpay the order."}</div>
          <div style={consequence}>Recording it anyway overpays by <b>{eur(overpay.overpayCents)}</b> — explicit and audited. Refunds can correct it later.</div>
        </div>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          <div>
            <div style={lbl}>Kind</div>
            <Listbox ariaLabel="Payment kind" options={KIND_OPTIONS} value={kind} onChange={setKind} />
            {gateOpen && !isRefund && <div style={{ fontSize: 11, color: "var(--h10-text-3)", marginTop: 3 }}>A deposit is still owed on this order — DEPOSIT payments unblock the floor.</div>}
          </div>
          <div>
            <div style={lbl}>Amount (€)</div>
            <Input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0,00" aria-label="Amount in EUR" autoFocus />
            {magnitude != null && magnitude > 0 && <div style={{ fontSize: 11, color: "var(--h10-text-3)", marginTop: 3 }}>= {isRefund ? `−${eur(magnitude)}` : eur(magnitude)}</div>}
          </div>
          <div>
            <div style={lbl}>Received on</div>
            <DateField value={date} onChange={setDate} ariaLabel="Payment date" clearable={false} />
          </div>
          <div>
            <div style={lbl}>Method (optional)</div>
            <Input value={method} onChange={(e) => setMethod(e.target.value)} placeholder="bank transfer, card…" aria-label="Payment method" />
          </div>
          <div>
            <div style={lbl}>{isRefund ? "Why is this refunded? (required)" : "Note (optional)"}</div>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder={isRefund ? "Reason for the refund — it is audited" : "Anything worth remembering"} aria-label="Payment note" />
          </div>
          <div style={consequence} data-testid="payment-consequence">
            {isRefund ? (
              <>Records <b>−{magnitude != null ? eur(magnitude) : "the amount"} as a REFUND</b> — it lowers the order's paid total and is audited with your note. Formal credit notes arrive in EPF.4.</>
            ) : (
              <>Records a <b>{kind}</b> payment{magnitude != null ? <> of <b>{eur(magnitude)}</b></> : null} dated {date || "today"}. Payments over the order's net are refused unless you explicitly confirm the overpay.</>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
