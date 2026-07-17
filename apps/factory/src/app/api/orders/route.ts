/**
 * FP4 — the orders board list: state filter, party filter, search, and the
 * three live counters (In production · Awaiting deposit · Overdue). Money folds
 * per row (net/cost/margin + deposit required-vs-paid) go through the grain
 * strip. Promise-date ascending so the most urgent jobs surface first.
 */
import { NextRequest } from "next/server";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { guarded, jsonStripped } from "@/lib/auth/guard";
import { PAGES } from "@/lib/auth/permissions";
import { orderTotals, depositRequiredCents, depositPaidCents } from "@/lib/orders/money";
import { attentionReasons, countSlips, promiseRisk } from "@/lib/orders/promise";

export const permission = PAGES.orders;

const OVERDUE_STATES = ["CONFIRMED", "IN_PRODUCTION", "READY"];
/** EPO.4 — states the Needs-attention cockpit scans (fulfillment-side, per cross-review M2) */
const ATTENTION_STATES = ["CONFIRMED", "IN_PRODUCTION", "READY"];

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
  // EPO.4 — the cockpit (attention=1) + created-at range filter
  const attention = p.get("attention") === "1";
  const fromStr = p.get("from") ?? "";
  const toStr = p.get("to") ?? "";
  const createdRange = {
    ...(fromStr ? { gte: new Date(`${fromStr}T00:00:00`) } : {}),
    ...(toStr ? { lte: new Date(`${toStr}T23:59:59`) } : {}),
  };
  const where = {
    ...(attention
      ? { state: { in: ATTENTION_STATES as never[] } }
      : lane ? { state: lane as never } : state !== "ALL" ? { state: state as never } : {}),
    ...(partyId ? { partyId } : {}),
    ...(q ? { OR: [{ number: { contains: q } }, { party: { name: { contains: q } } }] } : {}),
    ...(fromStr || toStr ? { createdAt: createdRange } : {}),
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

  // EPO.4 — page-scoped promise data: slips from the audit VALUES (a change
  // that moved the date later), stage progress + last activity per order, and
  // the global historical per-stage pace. All bounded to the fetched page.
  const pageIds = orders.map((o) => o.id);
  const now2 = Date.now();
  const [promiseAudits, stageAgg, paceRow] = await Promise.all([
    pageIds.length
      ? prisma.auditLog.findMany({
          where: { entityType: "order", action: "promise-changed", entityId: { in: pageIds } }, // bounded: page ids
          orderBy: { createdAt: "asc" },
          select: { entityId: true, after: true },
        })
      : Promise.resolve([]),
    pageIds.length
      ? prisma.$queryRaw<{ orderId: string; rem: number | bigint; lastAct: string | null }[]>(Prisma.sql`
          SELECT w."orderId" AS "orderId",
                 SUM(CASE WHEN s."finishedAt" IS NULL THEN 1 ELSE 0 END) AS "rem",
                 MAX(COALESCE(s."finishedAt", s."startedAt")) AS "lastAct"
          FROM "WorkOrder" w
          LEFT JOIN "WorkOrderStage" s ON s."workOrderId" = w."id"
          WHERE w."orderId" IN (${Prisma.join(pageIds)}) AND w."state" NOT IN ('CANCELLED', 'DONE')
          GROUP BY w."orderId"`)
      : Promise.resolve([]),
    prisma.$queryRaw<{ pace: number | null }[]>(Prisma.sql`
      SELECT AVG((julianday("finishedAt") - julianday("startedAt")) * 86400000.0) AS "pace"
      FROM "WorkOrderStage" WHERE "finishedAt" IS NOT NULL AND "startedAt" IS NOT NULL`),
  ]);
  const slipsByOrder = new Map<string, (string | null)[]>();
  for (const a of promiseAudits) {
    const v = (a.after as { promiseDateAt?: string | null } | null)?.promiseDateAt ?? null;
    const arr = slipsByOrder.get(a.entityId) ?? [];
    arr.push(v);
    slipsByOrder.set(a.entityId, arr);
  }
  const stageByOrder = new Map(stageAgg.map((s) => [s.orderId, { rem: Number(s.rem ?? 0), lastAct: s.lastAct }]));
  const perStageMs = paceRow[0]?.pace ?? null;

  const rows = orders.map((o) => {
    const totals = orderTotals(o.lines);
    // EPO.2 — per-row order-to-cash truth: same arithmetic as the FP9 fold
    // (Σ payments / Σ invoices / net − paid), never a re-typed figure
    const paidCents = o.payments.reduce((s, p) => s + (p.amountCents ?? 0), 0);
    const invoicedCents = o.invoices.reduce((s, i) => s + (i.amountCents ?? 0), 0);
    // EPO.4 — promise integrity per row
    const st = stageByOrder.get(o.id);
    const risk = promiseRisk({
      promiseAtISO: o.promiseDateAt ? o.promiseDateAt.toISOString() : null,
      state: o.state,
      remainingStages: st?.rem ?? 0,
      perStageMs,
      now: now2,
    });
    const woBlocked = o.workOrders.some((w) => w.state === "BLOCKED");
    return {
      id: o.id,
      number: o.number,
      state: o.state,
      party: o.party,
      promiseDateAt: o.promiseDateAt,
      updatedAt: o.updatedAt,
      lineCount: o.lines.length,
      woCount: o.workOrders.length,
      woBlocked,
      overdue: o.promiseDateAt != null && o.promiseDateAt < now && OVERDUE_STATES.includes(o.state),
      // EPO.4 — promise integrity + D-9 fields on the row
      originalPromiseDateAt: o.originalPromiseDateAt,
      urgent: o.urgent,
      promiseSlips: countSlips(o.originalPromiseDateAt ? o.originalPromiseDateAt.toISOString() : null, slipsByOrder.get(o.id) ?? []),
      atRisk: risk.atRisk,
      ...(attention
        ? {
            attention: attentionReasons({
              state: o.state,
              promiseAtISO: o.promiseDateAt ? o.promiseDateAt.toISOString() : null,
              woBlocked,
              lastStageActivityISO: st?.lastAct ?? null,
              risk,
              now: now2,
            }),
          }
        : {}),
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

  // EPO.4 — the cockpit shows ONLY actionable rows
  const outRows = attention ? rows.filter((r) => (r.attention?.length ?? 0) > 0) : rows;

  return jsonStripped(
    {
      orders: outRows,
      nextCursor: hasMore ? rows[rows.length - 1]?.id ?? null : null,
      counters: { inProduction, awaitingDeposit, overdue },
      counts: Object.fromEntries(counts.map((c) => [c.state, c._count._all])),
      marginFloorPct,
    },
    resolved,
  );
});
