/**
 * FP9.1 — the money page's data: headline tiles + a per-order rollup. Actual
 * cost is the FP6 number (Σ OUT movements × material cost across the order's work
 * orders); an order that hasn't consumed yet shows its estimate, flagged. Money
 * grain-stripped at the edge (defence in depth — the page itself is the gate).
 */
import { guarded, jsonStripped } from "@/lib/auth/guard";
import { PAGES } from "@/lib/auth/permissions";
import { prisma } from "@/lib/db";
import { orderFinancials, tiles, type FinOrder } from "@/lib/financials/rollup";
import { actualCostByOrder } from "@/lib/financials/actual-cost";

export const permission = PAGES.financials;

export const GET = guarded(PAGES.financials, async (req, { resolved }) => {
  const url = new URL(req.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const createdAt = from || to ? { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) } : undefined;

  const orders = await prisma.order.findMany({
    where: { state: { not: "CANCELLED" }, ...(createdAt ? { createdAt } : {}) },
    orderBy: { createdAt: "desc" },
    select: {
      id: true, number: true, state: true, createdAt: true,
      party: { select: { id: true, name: true } },
      lines: { select: { netPriceCents: true, costCents: true, qty: true } },
      payments: { select: { kind: true, amountCents: true } },
      invoices: { select: { amountCents: true, paidAt: true } },
      bornFromQuote: { select: { depositPct: true } },
      workOrders: { select: { id: true } },
    },
  });

  // actual cost per order = Σ OUT (qty × material cost) across its work orders (FP6)
  const actualByOrder = await actualCostByOrder(orders.map((o) => ({ id: o.id, woIds: o.workOrders.map((w) => w.id) })));

  const fins = orders.map((o) =>
    orderFinancials({
      id: o.id, number: o.number, partyId: o.party.id, partyName: o.party.name, state: o.state, createdAtISO: o.createdAt.toISOString(),
      lines: o.lines,
      payments: o.payments,
      invoices: o.invoices.map((i) => ({ amountCents: i.amountCents, paidAt: i.paidAt ? i.paidAt.toISOString() : null })),
      depositPct: o.bornFromQuote?.depositPct,
      actualCostCents: actualByOrder.get(o.id) ?? null,
    } satisfies FinOrder),
  );

  const monthKey = new Date().toISOString().slice(0, 7);
  return jsonStripped({ monthKey, tiles: tiles(fins, monthKey), orders: fins }, resolved);
});
