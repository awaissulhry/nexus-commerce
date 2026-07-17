/**
 * EPQ.4 — quote-vs-actual: what a produced order REALLY cost, surfaced beside
 * the estimate. CONSUMES the EPF financials lib (actual-cost.ts — the FP6
 * ledger fold; read-only import, never modified here). "Actual" is only
 * claimed once the order has SHIPPED (or later) — before that the ledger is
 * still moving and the number would be a lie. All queries bounded: callers
 * pass explicit id lists (≤5 similar rows, 1 converted order, 1 recall row).
 */
import { prisma } from "@/lib/db";
import { actualCostByOrder } from "@/lib/financials/actual-cost";

/** An order counts as produced-and-shipped from SHIPPED onward. */
export const SHIPPED_STATES = ["SHIPPED", "DELIVERED", "CLOSED"] as const;

export type OrderActual = {
  orderId: string;
  orderNumber: string;
  /** frozen at convert: Σ line costCents × qty (what production planned against) */
  estCostCents: number;
  /** the FP6 ledger truth: Σ OUT movements × material cost */
  actualCostCents: number;
  /** Σ line netPriceCents × qty — what the job sold for */
  soldNetCents: number;
};

/**
 * Actuals for the given orders — SHIPPED+ only (a map entry exists only when
 * the order is far enough along to have an honest actual). Bounded by the
 * caller's id list.
 */
export async function orderActuals(orderIds: string[]): Promise<Map<string, OrderActual>> {
  const out = new Map<string, OrderActual>();
  if (orderIds.length === 0) return out;
  const orders = await prisma.order.findMany({
    where: { id: { in: orderIds }, state: { in: [...SHIPPED_STATES] } },
    // bounded: caller passes an explicit id list (≤5 rows on every call path)
    select: {
      id: true,
      number: true,
      lines: { select: { netPriceCents: true, costCents: true, qty: true } },
      workOrders: { select: { id: true } },
    },
  });
  if (orders.length === 0) return out;
  const actualByOrder = await actualCostByOrder(orders.map((o) => ({ id: o.id, woIds: o.workOrders.map((w) => w.id) })));
  for (const o of orders) {
    out.set(o.id, {
      orderId: o.id,
      orderNumber: o.number,
      estCostCents: o.lines.reduce((s, l) => s + l.costCents * l.qty, 0),
      actualCostCents: actualByOrder.get(o.id) ?? 0,
      soldNetCents: o.lines.reduce((s, l) => s + l.netPriceCents * l.qty, 0),
    });
  }
  return out;
}
