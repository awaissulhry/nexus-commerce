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
  // FS1 (C-1) — lane mode: the kanban fetches each lane bounded + cursored so
  // nothing past the page cap silently vanishes; countsOnly serves the board's
  // counters without hydrating rows. Cursor ordering gets an id tiebreaker
  // (promiseDateAt/updatedAt are not unique).
  const lane = (p.get("lane") ?? "").toUpperCase();
  const cursor = p.get("cursor") ?? "";
  const countsOnly = p.get("countsOnly") === "1";
  const q = (p.get("q") ?? "").trim();
  const partyId = p.get("partyId") ?? "";
  const where = {
    ...(lane ? { state: lane as never } : state !== "ALL" ? { state: state as never } : {}),
    ...(partyId ? { partyId } : {}),
    ...(q ? { OR: [{ number: { contains: q } }, { party: { name: { contains: q } } }] } : {}),
  };
  const now = new Date();
  const TAKE = lane ? 100 : 200;

  if (countsOnly) {
    const [inProduction, awaitingDeposit, overdue, counts] = await Promise.all([
      prisma.order.count({ where: { state: "IN_PRODUCTION" } }),
      prisma.order.count({ where: { workOrders: { some: { state: "BLOCKED" } } } }),
      prisma.order.count({ where: { state: { in: OVERDUE_STATES as never[] }, promiseDateAt: { lt: now } } }),
      prisma.order.groupBy({ by: ["state"], _count: { _all: true } }),
    ]);
    return jsonStripped(
      { orders: [], counters: { inProduction, awaitingDeposit, overdue }, counts: Object.fromEntries(counts.map((c) => [c.state, c._count._all])) },
      resolved,
    );
  }

  const [orders, inProduction, awaitingDeposit, overdue, counts] = await Promise.all([
    prisma.order.findMany({
      where,
      orderBy: [{ promiseDateAt: "asc" }, { updatedAt: "desc" }, { id: "asc" }],
      take: TAKE + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: {
        party: { select: { id: true, name: true, kind: true } },
        lines: { select: { netPriceCents: true, costCents: true, qty: true } },
        payments: { select: { kind: true, amountCents: true } },
        invoices: { select: { amountCents: true } }, // EPO.2 — per-row invoiced/balance
        workOrders: { select: { state: true } },
        bornFromQuote: { select: { depositPct: true } },
      },
    }),
    prisma.order.count({ where: { state: "IN_PRODUCTION" } }),
    prisma.order.count({ where: { workOrders: { some: { state: "BLOCKED" } } } }),
    prisma.order.count({ where: { state: { in: OVERDUE_STATES as never[] }, promiseDateAt: { lt: now } } }),
    prisma.order.groupBy({ by: ["state"], _count: { _all: true } }),
  ]);
  const hasMore = orders.length > TAKE;
  if (hasMore) orders.pop();

  // EPO.2 — the margin floor (pricing.defaults) powers the low-margin flag;
  // key starts with "margin" so the strip hides it from margin-blind callers
  const defaultsRow = await prisma.appSetting.findUnique({ where: { key: "pricing.defaults" } });
  const marginFloorPct = (defaultsRow?.value as { marginFloorPct?: number } | null)?.marginFloorPct ?? null;

  const rows = orders.map((o) => {
    const totals = orderTotals(o.lines);
    // EPO.2 — per-row order-to-cash truth: same arithmetic as the FP9 fold
    // (Σ payments / Σ invoices / net − paid), never a re-typed figure
    const paidCents = o.payments.reduce((s, p) => s + (p.amountCents ?? 0), 0);
    const invoicedCents = o.invoices.reduce((s, i) => s + (i.amountCents ?? 0), 0);
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
      paidCents,
      invoicedCents,
      balanceCents: totals.netCents - paidCents,
    };
  });

  return jsonStripped(
    {
      orders: rows,
      nextCursor: hasMore ? rows[rows.length - 1]?.id ?? null : null,
      counters: { inProduction, awaitingDeposit, overdue },
      counts: Object.fromEntries(counts.map((c) => [c.state, c._count._all])),
      marginFloorPct,
    },
    resolved,
  );
});
