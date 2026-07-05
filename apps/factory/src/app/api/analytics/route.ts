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
import { throughputByWeek } from "@/lib/analytics/throughput";
import { stageLeadTimes, bottleneck, type StageRow } from "@/lib/analytics/lead-time";
import { onTimeRate } from "@/lib/analytics/on-time";
import { quoteWinLoss } from "@/lib/analytics/win-loss";
import { marginByProduct } from "@/lib/analytics/margin-by-product";
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
  const wos = await prisma.workOrder.findMany({
    select: { stages: { select: { stage: true, sort: true, startedAt: true, finishedAt: true, pausedMs: true, pausedAt: true } } },
  });
  const allStages: StageRow[] = [];
  const finishes: string[] = [];
  for (const wo of wos) {
    for (const s of wo.stages) allStages.push({ stage: s.stage, startedAt: s.startedAt, finishedAt: s.finishedAt, pausedMs: s.pausedMs, pausedAt: s.pausedAt });
    if (wo.stages.length > 0 && wo.stages.every((s) => s.finishedAt)) {
      const maxFin = wo.stages.reduce((mx, s) => Math.max(mx, s.finishedAt!.getTime()), 0);
      finishes.push(new Date(maxFin).toISOString());
    }
  }
  const leadTimes = stageLeadTimes(allStages, nowMs);

  // ── on-time vs promise (shipped orders) ──
  const shippedOrders = await prisma.order.findMany({
    where: { state: { in: ["SHIPPED", "DELIVERED"] }, promiseDateAt: { not: null }, ...(range ? { createdAt: range } : {}) },
    select: { promiseDateAt: true, shipments: { orderBy: { createdAt: "asc" }, take: 1, select: { createdAt: true } } },
  });

  // ── margin: by customer / month (FP9 rollup) + by product (order lines) ──
  const fins = await loadOrderFinancials(range);
  const lines = await prisma.orderLine.findMany({
    where: { order: { state: { not: "CANCELLED" }, ...(range ? { createdAt: range } : {}) } },
    select: { description: true, netPriceCents: true, costCents: true, qty: true },
  });

  // ── quote win/loss ──
  const quotes = await prisma.quote.findMany({ where: range ? { createdAt: range } : {}, select: { state: true, lostReason: true } });

  return jsonStripped(
    {
      throughput: throughputByWeek(finishes),
      leadTimes,
      bottleneckStage: bottleneck(leadTimes)?.stage ?? null,
      onTime: onTimeRate(shippedOrders.map((o) => ({ promiseISO: o.promiseDateAt ? o.promiseDateAt.toISOString() : null, shippedISO: o.shipments[0] ? o.shipments[0].createdAt.toISOString() : null }))),
      marginByParty: partyRollup(fins),
      marginByMonth: periodRollup(fins),
      marginByProduct: marginByProduct(lines.map((l) => ({ product: l.description, netPriceCents: l.netPriceCents, costCents: l.costCents, qty: l.qty }))),
      winLoss: quoteWinLoss(quotes),
    },
    resolved,
  );
});
