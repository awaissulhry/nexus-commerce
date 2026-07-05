/**
 * FP3.4 — the quote decision bar. SENT: awaiting the customer, with manual
 * Mark-accepted / Mark-rejected (for a reply in the thread, or when the public
 * accept link isn't reachable). ACCEPTED: Convert to an Order (minimal record —
 * the board is FP4). Quotes never reserve stock here (Katana verdict).
 */
"use client";

import { useState } from "react";
import { Banner, useToast } from "@/design-system/components";
import { Button } from "@/design-system/primitives";
import { apiJson } from "@/lib/api-client";
import { usePermission } from "@/lib/auth/client";
import type { QuoteDetail } from "./types";

export function ConvertBar({ quote, onChanged }: { quote: QuoteDetail; onChanged: () => void }) {
  const { toast } = useToast();
  const canConvert = usePermission("quotes.convert");
  const canCreate = usePermission("quotes.create");
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");

  const patchState = async (state: string, lostReason?: string) => {
    setBusy(true);
    try { await apiJson(`/api/quotes/${quote.id}`, { method: "PATCH", body: JSON.stringify({ state, ...(lostReason !== undefined ? { lostReason } : {}) }) }); onChanged(); }
    catch (e) { toast((e as Error).message, "danger"); } finally { setBusy(false); setRejecting(false); }
  };

  const convert = async () => {
    setBusy(true);
    try { const d = await apiJson<{ order: { number: string } }>(`/api/quotes/${quote.id}/convert`, { method: "POST" }); toast(`${d.order.number} created — the Orders board arrives in FP4`, "success"); onChanged(); }
    catch (e) { toast((e as Error).message, "danger"); } finally { setBusy(false); }
  };

  if (quote.convertedOrderId) {
    return <div style={{ marginBottom: 12 }}><Banner tone="success" title="Converted to an order">This quote became an order. The Orders board arrives in FP4; the record exists now.</Banner></div>;
  }
  if (quote.state === "ACCEPTED") {
    return (
      <div style={{ marginBottom: 12 }}>
        <Banner tone="success" title="Accepted by the customer">
          <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 4 }}>
            <span style={{ fontSize: 12.5 }}>Turn it into an order{quote.depositPct ? ` (a ${quote.depositPct}% deposit is due per the quote)` : ""}.</span>
            {canConvert && <Button variant="primary" onClick={convert} disabled={busy}>Convert to order</Button>}
          </div>
        </Banner>
      </div>
    );
  }
  if (quote.state === "REJECTED") {
    return <div style={{ marginBottom: 12 }}><Banner tone="danger" title="Declined / changes requested">{quote.lostReason ? `“${quote.lostReason}”` : "The customer didn't proceed."} {canCreate && <button type="button" onClick={() => patchState("DRAFT")} style={{ background: "none", border: "none", color: "var(--h10-text-link)", cursor: "pointer" }}>Revise</button>}</Banner></div>;
  }
  if (quote.state === "SENT" && canCreate) {
    return (
      <div style={{ marginBottom: 12 }}>
        <Banner tone="info" title="Sent — awaiting the customer">
          {rejecting ? (
            <div style={{ display: "grid", gap: 8, marginTop: 4 }}>
              <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="What did they want changed? (optional)" style={{ border: "1px solid var(--h10-border)", borderRadius: 7, padding: "5px 9px", fontSize: 12.5, background: "var(--h10-surface)", color: "var(--h10-text)" }} />
              <div style={{ display: "flex", gap: 8 }}><Button onClick={() => patchState("REJECTED", reason || undefined)} disabled={busy}>Mark rejected</Button><Button onClick={() => setRejecting(false)}>Cancel</Button></div>
            </div>
          ) : (
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 4 }}>
              <span style={{ fontSize: 12.5 }}>They accept from the email link — or record it here if they replied.</span>
              <Button variant="primary" onClick={() => patchState("ACCEPTED")} disabled={busy}>Mark accepted</Button>
              <Button onClick={() => setRejecting(true)} disabled={busy}>Mark rejected</Button>
            </div>
          )}
        </Banner>
      </div>
    );
  }
  return null;
}
