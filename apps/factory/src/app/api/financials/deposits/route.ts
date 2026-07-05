/**
 * FP9.3 — deposits outstanding (FD13): orders whose required deposit isn't in,
 * with the count of work orders BLOCKED waiting on it — the money that's holding
 * up the floor. Drills to the order (record the deposit there and FP4 unblocks).
 */
import { guarded, jsonStripped } from "@/lib/auth/guard";
import { PAGES } from "@/lib/auth/permissions";
import { prisma } from "@/lib/db";
import { orderFinancials, depositsOutstanding, type FinOrder } from "@/lib/financials/rollup";

export const permission = PAGES.financials;

export const GET = guarded(PAGES.financials, async (_req, { resolved }) => {
  const orders = await prisma.order.findMany({
    where: { state: { notIn: ["CANCELLED", "CLOSED"] } },
    select: {
      id: true, number: true, state: true, createdAt: true,
      party: { select: { id: true, name: true } },
      lines: { select: { netPriceCents: true, costCents: true, qty: true } },
      payments: { select: { kind: true, amountCents: true } },
      bornFromQuote: { select: { depositPct: true } },
      workOrders: { select: { state: true } },
    },
  });

  const blockedByOrder = new Map(orders.map((o) => [o.id, o.workOrders.filter((w) => w.state === "BLOCKED").length]));
  const fins = orders.map((o) =>
    orderFinancials({
      id: o.id, number: o.number, partyId: o.party.id, partyName: o.party.name, state: o.state, createdAtISO: o.createdAt.toISOString(),
      lines: o.lines, payments: o.payments, invoices: [], depositPct: o.bornFromQuote?.depositPct, actualCostCents: null,
    } satisfies FinOrder),
  );

  const deposits = depositsOutstanding(fins).map((d) => ({ ...d, blockedWorkOrders: blockedByOrder.get(d.orderId) ?? 0 }));
  return jsonStripped({ deposits }, resolved);
});
