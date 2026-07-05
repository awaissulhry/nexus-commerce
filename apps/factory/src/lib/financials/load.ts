/**
 * FP9.4 — fetch orders and fold them to per-order financials, once. The by-order,
 * by-party, by-month and export routes all build on this so the numbers can never
 * disagree between views. Reads the DB (actual cost from the ledger), then hands
 * off to the pure rollup.
 */
import { prisma } from "../db";
import { orderFinancials, type OrderFinancials, type FinOrder } from "./rollup";
import { actualCostByOrder } from "./actual-cost";

export async function loadOrderFinancials(createdAt?: { gte?: Date; lte?: Date }): Promise<OrderFinancials[]> {
  const hasRange = !!createdAt && (!!createdAt.gte || !!createdAt.lte);
  const orders = await prisma.order.findMany({
    where: { state: { not: "CANCELLED" }, ...(hasRange ? { createdAt } : {}) },
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
  const actual = await actualCostByOrder(orders.map((o) => ({ id: o.id, woIds: o.workOrders.map((w) => w.id) })));
  return orders.map((o) =>
    orderFinancials({
      id: o.id, number: o.number, partyId: o.party.id, partyName: o.party.name, state: o.state, createdAtISO: o.createdAt.toISOString(),
      lines: o.lines,
      payments: o.payments,
      invoices: o.invoices.map((i) => ({ amountCents: i.amountCents, paidAt: i.paidAt ? i.paidAt.toISOString() : null })),
      depositPct: o.bornFromQuote?.depositPct,
      actualCostCents: actual.get(o.id) ?? null,
    } satisfies FinOrder),
  );
}
