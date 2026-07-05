/**
 * FP4 — the orders board list: state filter, party filter, search, and the
 * three live counters (In production · Awaiting deposit · Overdue). Money folds
 * per row (net/cost/margin + deposit required-vs-paid) go through the grain
 * strip. Promise-date ascending so the most urgent jobs surface first.
 */
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { guarded, jsonStripped } from "@/lib/auth/guard";
import { PAGES } from "@/lib/auth/permissions";
import { orderTotals, depositRequiredCents, depositPaidCents } from "@/lib/orders/money";

export const permission = PAGES.orders;

const OVERDUE_STATES = ["CONFIRMED", "IN_PRODUCTION", "READY"];

export const GET = guarded(PAGES.orders, async (req: NextRequest, { resolved }) => {
  const p = req.nextUrl.searchParams;
  const state = (p.get("state") ?? "all").toUpperCase();
  const q = (p.get("q") ?? "").trim();
  const partyId = p.get("partyId") ?? "";
  const where = {
    ...(state !== "ALL" ? { state: state as never } : {}),
    ...(partyId ? { partyId } : {}),
    ...(q ? { OR: [{ number: { contains: q } }, { party: { name: { contains: q } } }] } : {}),
  };
  const now = new Date();

  const [orders, inProduction, awaitingDeposit, overdue, counts] = await Promise.all([
    prisma.order.findMany({
      where,
      orderBy: [{ promiseDateAt: "asc" }, { updatedAt: "desc" }],
      take: 200,
      include: {
        party: { select: { id: true, name: true, kind: true } },
        lines: { select: { netPriceCents: true, costCents: true, qty: true } },
        payments: { select: { kind: true, amountCents: true } },
        workOrders: { select: { state: true } },
        bornFromQuote: { select: { depositPct: true } },
      },
    }),
    prisma.order.count({ where: { state: "IN_PRODUCTION" } }),
    prisma.order.count({ where: { workOrders: { some: { state: "BLOCKED" } } } }),
    prisma.order.count({ where: { state: { in: OVERDUE_STATES as never[] }, promiseDateAt: { lt: now } } }),
    prisma.order.groupBy({ by: ["state"], _count: { _all: true } }),
  ]);

  const rows = orders.map((o) => {
    const totals = orderTotals(o.lines);
    return {
      id: o.id,
      number: o.number,
      state: o.state,
      party: o.party,
      promiseDateAt: o.promiseDateAt,
      updatedAt: o.updatedAt,
      lineCount: o.lines.length,
      woCount: o.workOrders.length,
      woBlocked: o.workOrders.some((w) => w.state === "BLOCKED"),
      overdue: o.promiseDateAt != null && o.promiseDateAt < now && OVERDUE_STATES.includes(o.state),
      netCents: totals.netCents,
      costCents: totals.costCents,
      marginCents: totals.marginCents,
      marginPct: totals.marginPct,
      depositRequiredCents: depositRequiredCents(totals.netCents, o.bornFromQuote?.depositPct),
      depositPaidCents: depositPaidCents(o.payments),
    };
  });

  return jsonStripped(
    {
      orders: rows,
      counters: { inProduction, awaitingDeposit, overdue },
      counts: Object.fromEntries(counts.map((c) => [c.state, c._count._all])),
    },
    resolved,
  );
});
