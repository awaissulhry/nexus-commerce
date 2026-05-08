/**
 * S.16 — ABC classification service.
 *
 * Computes the Pareto-band class for every active buyable product and
 * persists it to Product.abcClass + abcClassUpdatedAt. A weekly cron
 * (apps/api/src/jobs/abc-classification.job) calls recompute(); the
 * /api/stock/analytics/abc endpoint reads the materialized column for
 * O(1) response.
 *
 * Bands (defaults; configurable via args):
 *   A — top 80% cumulative metric
 *   B — next 15% (≤ 95% cumulative)
 *   C — remaining sales-active items
 *   D — zero sales in window
 *
 * Metric: 'revenue' (default), 'units', or 'margin'. Revenue is the
 * standard "follow the money" Pareto signal. Margin requires costPrice
 * to be populated; falls back to 0 contribution when costPrice is null.
 */

import prisma from '../db.js'
import { logger } from '../utils/logger.js'

export type AbcMetric = 'revenue' | 'units' | 'margin'

export interface RecomputeArgs {
  windowDays?: number       // default 90
  metric?: AbcMetric        // default 'revenue'
  bandA?: number            // default 0.80
  bandB?: number            // default 0.15
  // bandC implicit = remaining sales-active
}

export interface RecomputeResult {
  generatedAt: Date
  windowDays: number
  metric: AbcMetric
  bandA: number
  bandB: number
  totals: {
    productsTracked: number
    skusInA: number
    skusInB: number
    skusInC: number
    skusInD: number
    metricTotal: number  // total revenue cents / units / margin cents (in metric units)
  }
  durationMs: number
}

/**
 * Compute and persist the ABC class for every buyable product. Runs
 * inside a transaction so partial classification can't leak.
 */
export async function recompute(args: RecomputeArgs = {}): Promise<RecomputeResult> {
  const startedAt = Date.now()
  const windowDays = Math.min(365, Math.max(7, Math.floor(args.windowDays ?? 90)))
  const metric: AbcMetric = args.metric ?? 'revenue'
  const bandA = args.bandA ?? 0.80
  const bandB = args.bandB ?? 0.15
  if (bandA <= 0 || bandA >= 1 || bandB <= 0 || bandA + bandB >= 1) {
    throw new Error(`recompute: invalid bands (bandA=${bandA}, bandB=${bandB}); both >0 and bandA+bandB<1`)
  }

  const cutoff = new Date()
  cutoff.setUTCDate(cutoff.getUTCDate() - windowDays)
  cutoff.setUTCHours(0, 0, 0, 0)

  // Pull active buyables. Variants are addressed per-SKU below; both
  // parents and standalone products go through the same path.
  const products = await prisma.product.findMany({
    where: { isParent: false },
    select: { id: true, sku: true, costPrice: true },
  })
  if (products.length === 0) {
    return {
      generatedAt: new Date(),
      windowDays, metric, bandA, bandB,
      totals: { productsTracked: 0, skusInA: 0, skusInB: 0, skusInC: 0, skusInD: 0, metricTotal: 0 },
      durationMs: Date.now() - startedAt,
    }
  }

  // Aggregate sales over the window grouped by SKU. Single query.
  const skus = products.map((p) => p.sku)
  const sales = await prisma.dailySalesAggregate.findMany({
    where: { sku: { in: skus }, day: { gte: cutoff } },
    select: { sku: true, unitsSold: true, grossRevenue: true },
  })
  const unitsBySku = new Map<string, number>()
  const revenueCentsBySku = new Map<string, number>()
  for (const s of sales) {
    unitsBySku.set(s.sku, (unitsBySku.get(s.sku) ?? 0) + s.unitsSold)
    revenueCentsBySku.set(
      s.sku,
      (revenueCentsBySku.get(s.sku) ?? 0) + Math.round(Number(s.grossRevenue) * 100),
    )
  }

  // Build the metric value per product.
  type Row = { id: string; sku: string; metricValue: number }
  const rows: Row[] = products.map((p) => {
    const units = unitsBySku.get(p.sku) ?? 0
    const revenueCents = revenueCentsBySku.get(p.sku) ?? 0
    let metricValue: number
    if (metric === 'units') {
      metricValue = units
    } else if (metric === 'margin') {
      const costCents = p.costPrice == null ? 0 : Math.round(Number(p.costPrice) * 100)
      metricValue = Math.max(0, revenueCents - units * costCents)
    } else {
      metricValue = revenueCents
    }
    return { id: p.id, sku: p.sku, metricValue }
  })

  // Sort DESC by metric. Items with metricValue=0 are D (zero-sales),
  // bucketed below; we still walk them through sort for stability.
  rows.sort((a, b) => b.metricValue - a.metricValue)

  const total = rows.reduce((acc, r) => acc + r.metricValue, 0)
  const aThreshold = total * bandA
  const bThreshold = total * (bandA + bandB)

  let classified: Array<{ id: string; class: 'A' | 'B' | 'C' | 'D' }> = []
  let cumulative = 0
  for (const r of rows) {
    if (r.metricValue === 0) {
      classified.push({ id: r.id, class: 'D' })
      continue
    }
    cumulative += r.metricValue
    const cls: 'A' | 'B' | 'C' = cumulative <= aThreshold
      ? 'A'
      : cumulative <= bThreshold ? 'B' : 'C'
    classified.push({ id: r.id, class: cls })
  }

  // Persist. Single transaction; per-class updateMany so we issue 4
  // statements instead of 264 individual writes.
  const generatedAt = new Date()
  const idsByClass: Record<'A' | 'B' | 'C' | 'D', string[]> = { A: [], B: [], C: [], D: [] }
  for (const c of classified) idsByClass[c.class].push(c.id)

  await prisma.$transaction(async (tx) => {
    for (const cls of ['A', 'B', 'C', 'D'] as const) {
      const ids = idsByClass[cls]
      if (ids.length === 0) continue
      await tx.product.updateMany({
        where: { id: { in: ids } },
        data: { abcClass: cls, abcClassUpdatedAt: generatedAt },
      })
    }
  })

  const result: RecomputeResult = {
    generatedAt,
    windowDays, metric, bandA, bandB,
    totals: {
      productsTracked: rows.length,
      skusInA: idsByClass.A.length,
      skusInB: idsByClass.B.length,
      skusInC: idsByClass.C.length,
      skusInD: idsByClass.D.length,
      metricTotal: total,
    },
    durationMs: Date.now() - startedAt,
  }

  logger.info('abc-classification: recompute complete', result)
  return result
}

/**
 * Fetch the materialized snapshot — used by the GET endpoint. Returns
 * the band counts plus a sample of top SKUs per band for the UI.
 */
export async function getSnapshot(opts: { perBandLimit?: number } = {}) {
  const perBandLimit = Math.max(1, Math.min(50, opts.perBandLimit ?? 10))

  const products = await prisma.product.findMany({
    where: { isParent: false, abcClass: { not: null } },
    select: {
      id: true, sku: true, name: true, abcClass: true, abcClassUpdatedAt: true,
      totalStock: true, costPrice: true,
      images: { select: { url: true }, take: 1 },
    },
  })

  const counts: Record<string, number> = { A: 0, B: 0, C: 0, D: 0 }
  const samples: Record<'A' | 'B' | 'C' | 'D', Array<{
    productId: string; sku: string; name: string; thumbnailUrl: string | null
    totalStock: number; inventoryValueCents: number
  }>> = { A: [], B: [], C: [], D: [] }

  for (const p of products) {
    const cls = (p.abcClass ?? '') as 'A' | 'B' | 'C' | 'D'
    if (counts[cls] == null) continue
    counts[cls] = (counts[cls] ?? 0) + 1
    if (samples[cls].length < perBandLimit) {
      const costCents = p.costPrice == null ? 0 : Math.round(Number(p.costPrice) * 100)
      samples[cls].push({
        productId: p.id,
        sku: p.sku,
        name: p.name,
        thumbnailUrl: p.images?.[0]?.url ?? null,
        totalStock: p.totalStock,
        inventoryValueCents: p.totalStock * costCents,
      })
    }
  }

  // Latest abcClassUpdatedAt across the catalog == "snapshot freshness".
  const latest = products.reduce<Date | null>((acc, p) => {
    if (!p.abcClassUpdatedAt) return acc
    return acc == null || p.abcClassUpdatedAt > acc ? p.abcClassUpdatedAt : acc
  }, null)

  return {
    snapshotAt: latest,
    productsClassified: products.length,
    counts,
    samples,
  }
}
