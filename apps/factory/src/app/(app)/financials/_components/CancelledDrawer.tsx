/**
 * EPF2 (D-04 surface) — the cancelled-with-money bucket, opened from its tile:
 * cancelled orders that still carry payments or invoices. They stay OUT of
 * every total (cancelled work is not revenue) but the money can't hide — each
 * row drills into the money drawer where a REFUND can settle it.
 */
"use client";

import { Drawer } from "@/design-system/components";
import { Pill } from "@/design-system/primitives";
import { money } from "./MoneyGrids";
import type { CancelledWithMoney } from "./types";

export function CancelledDrawer({ bucket, open, onClose, onOpenOrder }: { bucket: CancelledWithMoney | null; open: boolean; onClose: () => void; onOpenOrder: (id: string) => void }) {
  const b = bucket;
  return (
    <Drawer open={open} onClose={onClose} title="Cancelled orders with money" subtitle="Outside every total — visible so it can be settled">
      {b && (
        <div style={{ display: "grid", gap: 12 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12.5, color: "var(--h10-text-2)" }}>
            <Pill tone="warning">{b.count} order{b.count === 1 ? "" : "s"}</Pill>
            <span>paid {money(b.paidCents)} · invoiced {money(b.invoicedCents)}</span>
          </div>
          <div style={{ display: "grid" }}>
            {b.orders.map((o) => (
              <div key={o.orderId} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 0", borderBottom: "1px solid var(--h10-border-subtle)", fontSize: 12.5 }}>
                <button type="button" onClick={() => onOpenOrder(o.orderId)} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", font: "inherit", fontWeight: 700, color: "var(--h10-text-link)" }}>{o.number}</button>
                <span style={{ color: "var(--h10-text-3)" }}>{o.partyName}</span>
                <span style={{ marginLeft: "auto", fontVariantNumeric: "tabular-nums" }}>paid {money(o.paidCents)} · invoiced {money(o.invoicedCents)}</span>
              </div>
            ))}
          </div>
          {b.count > b.orders.length && (
            <div style={{ fontSize: 12, color: "var(--h10-text-3)" }}>Showing the first {b.orders.length} of {b.count} — the sums above cover all of them.</div>
          )}
          <div style={{ fontSize: 12, color: "var(--h10-text-3)", lineHeight: 1.5 }}>
            A paid deposit on a cancelled order usually ends as a REFUND (record it from the order's money drawer) or is kept per your agreement — either way it stays audited here until settled.
          </div>
        </div>
      )}
    </Drawer>
  );
}
