/**
 * FP10 — the analytics dashboard data: every panel folded server-side from
 * records that already exist. Throughput + lead-time from work-order stages,
 * on-time from shipments vs promise, margin (by customer/month/product) reusing
 * the FP9 rollup, win/loss from quotes. Money grain-stripped at the edge. The
 * date range (FP10.4) scopes the order-derived panels.
 */
import { guarded, jsonStripped } from "@/lib/auth/guard";
import { PAGES } from "@/lib/auth/permissions";
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { throughputByWeek } from "@/lib/analytics/throughput";
import { stageLeadTimes, bottleneck, type StageRow } from "@/lib/analytics/lead-time";
import { onTimeRate } from "@/lib/analytics/on-time";
import { quoteWinLossFromGroups } from "@/lib/analytics/win-loss";
import { marginByProductFromAggregates } from "@/lib/analytics/margin-by-product";
import { partyRollup, periodRollup } from "@/lib/financials/rollup";
import { loadOrderFinancials } from "@/lib/financials/load";

export const permission = PAGES.analytics;

export const GET = guarded(PAGES.analytics, async (req, { resolved }) => {
  const url = new URL(req.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const range = from || to ? { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) } : undefined;
  const nowMs = Date.now();

  // ── throughput + stage lead-time (from work-order stages) ──
  // FS1 — the old path hydrated EVERY work order with all its stages (250k rows
  // at scale) and applied the date range in JS. Lead-time input is now a flat
  // finished-stages-only select with the range in the WHERE (the same rows the
  // JS filter kept: stageLeadTimes ignores unfinished stages); throughput's
  // "fully finished WO" fold moves to SQL GROUP BY … HAVING.
  // raw select measured ~2× faster than findMany hydration at 235k rows;
  // Dates are re-materialized so stageLeadTimes' elapsedMs math is unchanged.
  const stageRows = await prisma.$queryRaw<{ stage: string; startedAt: string | Date | null; finishedAt: string | Date; pausedMs: number }[]>(Prisma.sql`
    SELECT s."stage", s."startedAt", s."finishedAt", s."pausedMs" FROM "WorkOrderStage" s
    WHERE s."finishedAt" IS NOT NULL ${
      range?.gte ? Prisma.sql`AND substr(s."finishedAt",1,23) >= ${range.gte.toISOString().slice(0, 23)}` : Prisma.empty
    } ${range?.lte ? Prisma.sql`AND substr(s."finishedAt",1,23) <= ${range.lte.toISOString().slice(0, 23)}` : Prisma.empty}`);
  const toDate = (v: string | Date | null) => (v == null ? null : v instanceof Date ? v : new Date(v));
  const finishedStages = stageRows.map((s) => ({ stage: s.stage, startedAt: toDate(s.startedAt), finishedAt: toDate(s.finishedAt), pausedMs: s.pausedMs, pausedAt: null }));
  const leadTimes = stageLeadTimes(finishedStages as StageRow[], nowMs);

  const finRows = await prisma.$queryRaw<{ mf: string | Date }[]>`
    SELECT MAX(s."finishedAt") AS mf FROM "WorkOrderStage" s
    GROUP BY s."workOrderId" HAVING COUNT(*) = COUNT(s."finishedAt")`;
  const inRange = (d: Date) => (!range?.gte || d >= range.gte) && (!range?.lte || d <= range.lte);
  const finishes: string[] = [];
  for (const r of finRows) {
    const d = r.mf instanceof Date ? r.mf : new Date(r.mf);
    if (inRange(d)) finishes.push(d.toISOString());
  }

  // ── on-time vs promise (shipped orders) ── first shipment via correlated
  // MIN instead of a per-row relation include (the N-1 P2029 shape).
  const shippedOrders = (
    await prisma.$queryRaw<{ p: string | Date; sh: string | Date | null }[]>(Prisma.sql`
      SELECT o."promiseDateAt" AS p,
             (SELECT MIN(s."createdAt") FROM "Shipment" s WHERE s."orderId" = o."id") AS sh
      FROM "Order" o
      WHERE o."state" IN ('SHIPPED','DELIVERED') AND o."promiseDateAt" IS NOT NULL ${
        range?.gte ? Prisma.sql`AND substr(o."createdAt",1,23) >= ${range.gte.toISOString().slice(0, 23)}` : Prisma.empty
      } ${range?.lte ? Prisma.sql`AND substr(o."createdAt",1,23) <= ${range.lte.toISOString().slice(0, 23)}` : Prisma.empty}`)
  ).map((r) => ({
    promiseDateAt: r.p instanceof Date ? r.p : new Date(r.p),
    shipments: r.sh ? [{ createdAt: r.sh instanceof Date ? r.sh : new Date(r.sh) }] : [],
  }));

  // ── margin: by customer / month (FP9 rollup, FS1 SQL-aggregated) + by product ──
  const fins = await loadOrderFinancials(range, { sorted: false });
  const productAggs = await prisma.$queryRaw<{ product: string | null; n: number | bigint; net: number | bigint; cost: number | bigint }[]>(Prisma.sql`
    SELECT l."description" AS product, COUNT(*) AS n, SUM(l."netPriceCents" * l."qty") AS net, SUM(l."costCents" * l."qty") AS cost
    FROM "OrderLine" l JOIN "Order" o ON o."id" = l."orderId"
    WHERE o."state" <> 'CANCELLED' ${
      range?.gte ? Prisma.sql`AND substr(o."createdAt",1,23) >= ${range.gte.toISOString().slice(0, 23)}` : Prisma.empty
    } ${range?.lte ? Prisma.sql`AND substr(o."createdAt",1,23) <= ${range.lte.toISOString().slice(0, 23)}` : Prisma.empty}
    GROUP BY l."description"`);

  // ── quote win/loss ── groupBy instead of hydrating every quote
  const quoteGroups = await prisma.quote.groupBy({ by: ["state", "lostReason"], where: range ? { createdAt: range } : {}, _count: { _all: true } });

  return jsonStripped(
    {
      throughput: throughputByWeek(finishes),
      leadTimes,
      bottleneckStage: bottleneck(leadTimes)?.stage ?? null,
      onTime: onTimeRate(shippedOrders.map((o) => ({ promiseISO: o.promiseDateAt ? o.promiseDateAt.toISOString() : null, shippedISO: o.shipments[0] ? o.shipments[0].createdAt.toISOString() : null }))),
      marginByParty: partyRollup(fins),
      marginByMonth: periodRollup(fins),
      marginByProduct: marginByProductFromAggregates(
        productAggs.map((r) => ({ product: r.product, lines: Number(r.n), netCents: Number(r.net ?? 0), costCents: Number(r.cost ?? 0) })),
      ),
      winLoss: quoteWinLossFromGroups(quoteGroups.map((g) => ({ state: g.state, lostReason: g.lostReason, count: g._count._all }))),
    },
    resolved,
  );
});
