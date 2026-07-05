/**
 * FP3.3 — the send confirm: states the customer, the net total, the deposit,
 * and — below the margin floor — a red bullet that must be acknowledged before
 * the quote can go out (CPQ margin-floor speed bump; no approval chains).
 */
"use client";

import { useState } from "react";
import { Send } from "lucide-react";
import { Banner, Modal, useToast } from "@/design-system/components";
import { Button, Checkbox } from "@/design-system/primitives";
import { eur } from "@/design-system/lib/format";
import { apiJson } from "@/lib/api-client";
import type { QuoteDetail } from "./types";

export function SendModal({ quote, totals, floorPct, belowFloor, onClose, onSent }: {
  quote: QuoteDetail;
  totals: { netCents: number; marginPct: number } | null;
  floorPct: number;
  belowFloor: boolean;
  onClose: () => void;
  onSent: () => void;
}) {
  const { toast } = useToast();
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const depositCents = totals && quote.depositPct ? Math.round((totals.netCents * quote.depositPct) / 100) : 0;

  const send = async () => {
    setBusy(true);
    try {
      await apiJson(`/api/quotes/${quote.id}/send`, { method: "POST", body: JSON.stringify({ acknowledgeFloor: ack }) });
      toast(quote.conversation ? "Quote sent into the thread" : "Quote sent", "success");
      onSent();
    } catch (e) {
      toast((e as Error).message, "danger");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Send ${quote.number}`}
      size="sm"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={send} disabled={busy || (belowFloor && !ack)}><Send size={13} /> {busy ? "Sending…" : "Send quote"}</Button></>}
    >
      <div style={{ display: "grid", gap: 10, fontSize: 13 }}>
        <div>To <b>{quote.party.name}</b>{quote.conversation ? <> — replies into the thread “{quote.conversation.subject ?? ""}”.</> : <> — a new email (no linked thread).</>}</div>
        <div style={{ display: "flex", justifyContent: "space-between" }}><span style={{ color: "var(--h10-text-2)" }}>Net total</span><b>{totals ? eur(totals.netCents) : "—"}</b></div>
        {quote.depositPct ? <div style={{ display: "flex", justifyContent: "space-between" }}><span style={{ color: "var(--h10-text-2)" }}>Deposit ({quote.depositPct}%)</span><b>{eur(depositCents)}</b></div> : null}
        <div style={{ fontSize: 12, color: "var(--h10-text-3)" }}>A PDF is attached; the customer can accept it with a link. This send is frozen as a version.</div>
        {belowFloor && (
          <Banner tone="danger" title={`Below your ${floorPct}% margin floor`}>
            <label style={{ display: "flex", gap: 7, alignItems: "center", marginTop: 4, fontSize: 12.5 }}>
              <Checkbox checked={ack} onChange={(e) => setAck(e.target.checked)} aria-label="Acknowledge margin floor" />
              Send anyway — I've reviewed the margin ({totals?.marginPct.toFixed(1)}%).
            </label>
          </Banner>
        )}
      </div>
    </Modal>
  );
}
