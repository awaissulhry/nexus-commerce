/**
 * FP3.4 — accepted quotes convert to an Order. Shows the accept state and the
 * Convert action (creates a minimal Order — the board is FP4). Quotes never
 * reserve stock here (Katana verdict): reservation happens at production.
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
  const [busy, setBusy] = useState(false);

  if (quote.convertedOrderId) {
    return <div style={{ marginBottom: 12 }}><Banner tone="success" title="Converted to an order">This quote became an order. The Orders board arrives in FP4; the record exists now.</Banner></div>;
  }
  if (quote.state !== "ACCEPTED") return null;

  const convert = async () => {
    setBusy(true);
    try {
      const d = await apiJson<{ order: { number: string } }>(`/api/quotes/${quote.id}/convert`, { method: "POST" });
      toast(`${d.order.number} created — the Orders board arrives in FP4`, "success");
      onChanged();
    } catch (e) {
      toast((e as Error).message, "danger");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ marginBottom: 12 }}>
      <Banner tone="success" title="Accepted by the customer">
        <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 4 }}>
          <span style={{ fontSize: 12.5 }}>Turn it into an order{quote.depositPct ? ` (a ${quote.depositPct}% deposit is recorded as due)` : ""}.</span>
          {canConvert && <Button variant="primary" onClick={convert} disabled={busy}>Convert to order</Button>}
        </div>
      </Banner>
    </div>
  );
}
