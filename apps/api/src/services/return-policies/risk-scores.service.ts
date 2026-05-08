/**
 * R7.2 — per-SKU return-rate risk scoring.
 *
 * Goal: surface SKUs with abnormally high return rates so PIM can
 * flag them for content review (wrong size chart, bad photos,
 * misleading title, defective batch). The math is deliberately
 * conservative — we'd rather miss a few real outliers than spam
 * the PIM page with false positives.
 *
 * Per SKU, in the configurable window (default 90 days):
 *   returnRate = returns / orders
 *
 * Within each productType bucket:
 *   z = (returnRate - mean) / stddev
 *   flagged = z > 2  AND  returns ≥ 3   AND  bucket size ≥ 3
 *
 * The two extra gates exist because:
 *   - returns < 3   →  the SKU's rate is too noisy to claim "high
 *                       return rate" (a single defective unit
 *                       inflates the rate from 0.1% to 10%).
 *   - bucket < 3 SKUs → stddev is meaningless. Skip the bucket.
 *
 * SKUs with productType=null are pooled into a synthetic '_unbucketed'
 * group so they still get scored against each other.
 */

import prisma from '../../db.js'

export interface RiskScore {
  sku: string
  productName: string | null
  productType: string | null
  returnCount: number
  orderCount: number
  ratePct: number
  bucketMeanPct: number
  bucketStdDev: number
  z: number
  flagged: boolean
}

export interface RiskScoreResult {
  windowDays: number
  generatedAt: string
  /** All SKUs with at least one order in the window. */
  scored: RiskScore[]
  /** SKUs that crossed the flag threshold (subset of scored). */
  flagged: RiskScore[]
  /** Summary counts for the analytics page. */
  summary: {
    skusScored: number
    bucketsAnalyzed: number
    flaggedCount: number
  }
}

export async function computeReturnRiskScores(opts?: {
  windowDays?: number
}): Promise<RiskScoreResult> {
  const windowDays = opts?.windowDays ?? 90
  const since = new Date(Date.now() - windowDays * 86_400_000)

  // Pull per-SKU returns in window. ReturnItem is the row-level
  // table; one row per (return, sku) so summing _all is the right
  // count for "how many distinct returns touched this SKU".
  const returnsBySku = await prisma.returnItem.groupBy({
    by: ['sku'],
    _count: { _all: true },
    where: { return: { createdAt: { gte: since } } },
  })

  // Pull per-SKU orders in window. OrderItem mirrors the shape.
  const ordersBySku = await prisma.orderItem.groupBy({
    by: ['sku'],
    _count: { _all: true },
    where: { order: { createdAt: { gte: since } } },
  })

  // Build per-SKU row — only keep SKUs with at least one order in
  // window (rate denominator). SKUs with returns but no orders are
  // a data-integrity oddity (returns predating order ingest); skip.
  type Row = {
    sku: string
    returnCount: number
    orderCount: number
    productName: string | null
    productType: string | null
  }
  const orderMap = new Map<string, number>()
  for (const r of ordersBySku) orderMap.set(r.sku, r._count._all)
  const returnMap = new Map<string, number>()
  for (const r of returnsBySku) returnMap.set(r.sku, r._count._all)

  // Hydrate productType + name for the SKUs we have data for.
  const candidateSkus = [...orderMap.keys()]
  const products = candidateSkus.length > 0
    ? await prisma.product.findMany({
        where: { sku: { in: candidateSkus } },
        select: { sku: true, name: true, productType: true },
      })
    : []
  const productMap = new Map(products.map((p) => [p.sku, p]))

  const rows: Row[] = []
  for (const sku of candidateSkus) {
    const orderCount = orderMap.get(sku) ?? 0
    if (orderCount <= 0) continue
    const product = productMap.get(sku)
    rows.push({
      sku,
      returnCount: returnMap.get(sku) ?? 0,
      orderCount,
      productName: product?.name ?? null,
      productType: product?.productType ?? null,
    })
  }

  // Bucket by productType (null → '_unbucketed' synthetic group).
  const buckets = new Map<string, Row[]>()
  for (const r of rows) {
    const key = r.productType ?? '_unbucketed'
    const arr = buckets.get(key) ?? []
    arr.push(r)
    buckets.set(key, arr)
  }

  const scored: RiskScore[] = []
  let bucketsAnalyzed = 0
  for (const [bucketKey, bucketRows] of buckets) {
    if (bucketRows.length < 3) {
      // Bucket too small for stddev to be meaningful. Still emit
      // unflagged scores so the analytics page can show context.
      for (const r of bucketRows) {
        const ratePct = (r.returnCount / r.orderCount) * 100
        scored.push({
          sku: r.sku,
          productName: r.productName,
          productType: r.productType,
          returnCount: r.returnCount,
          orderCount: r.orderCount,
          ratePct,
          bucketMeanPct: ratePct,
          bucketStdDev: 0,
          z: 0,
          flagged: false,
        })
      }
      continue
    }
    bucketsAnalyzed++
    const rates = bucketRows.map((r) => (r.returnCount / r.orderCount) * 100)
    const mean = rates.reduce((acc, v) => acc + v, 0) / rates.length
    const variance = rates.reduce((acc, v) => acc + (v - mean) ** 2, 0) / rates.length
    const stdDev = Math.sqrt(variance)

    for (const r of bucketRows) {
      const ratePct = (r.returnCount / r.orderCount) * 100
      const z = stdDev > 0 ? (ratePct - mean) / stdDev : 0
      const flagged =
        z > 2 &&
        r.returnCount >= 3 &&
        bucketRows.length >= 3
      scored.push({
        sku: r.sku,
        productName: r.productName,
        productType: r.productType,
        returnCount: r.returnCount,
        orderCount: r.orderCount,
        ratePct,
        bucketMeanPct: mean,
        bucketStdDev: stdDev,
        z,
        flagged,
      })
    }
  }

  scored.sort((a, b) => b.ratePct - a.ratePct)
  const flagged = scored.filter((s) => s.flagged)

  return {
    windowDays,
    generatedAt: new Date().toISOString(),
    scored,
    flagged,
    summary: {
      skusScored: scored.length,
      bucketsAnalyzed,
      flaggedCount: flagged.length,
    },
  }
}
