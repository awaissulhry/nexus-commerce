/**
 * W8.3 — Cannibalization detection.
 *
 * When a new SKU launches into a category, related SKUs (same
 * productType / brand) often see velocity drop because shoppers
 * substitute the new option. The forecast layer doesn't know this
 * happened — it just sees the related SKUs' velocity decline and
 * trims their reorder quantities, which is correct on the surface
 * but obscures the *cause*. Operators want to see the link so they
 * can decide whether to phase out the older SKU, reposition the
 * pricing, etc.
 *
 * Heuristic detector: for each SKU with a launch date in the recent
 * window, compare related SKUs' pre-launch velocity to post-launch
 * velocity. Flag related SKUs whose velocity dropped > thresholdPct
 * AND have enough samples on both sides to be statistically
 * non-trivial.
 *
 * Pure read. No correction applied — the engine just reports the
 * link. Wave 8.3b could feed this into the planner as a -multiplier
 * on the older SKU, or push a notification recommending a markdown.
 *
 * Inverse of R.17 substitution: R.17 boosts a SKU's velocity when
 * the substitute went out of stock; this detects when a new SKU
 * pulls demand away from a substitute.
 */

import prisma from '../db.js'

export interface CannibalizationCandidate {
  /** Related SKU whose velocity dropped after the new SKU launched. */
  sku: string
  productType: string | null
  brand: string | null
  /** Mean daily velocity in the windowDays leading up to newSkuLaunchDay. */
  preVelocityPerDay: number
  /** Mean daily velocity in the windowDays following newSkuLaunchDay. */
  postVelocityPerDay: number
  /** Absolute change (post - pre); negative when cannibalized. */
  velocityDelta: number
  /** Relative change as percentage; negative when cannibalized. */
  velocityDeltaPercent: number
  preSamples: number
  postSamples: number
}

export interface CannibalizationFinding {
  newSku: string
  newProductId: string | null
  newProductType: string | null
  newBrand: string | null
  launchDay: Date
  candidates: CannibalizationCandidate[]
}

export interface DetectCannibalizationArgs {
  /** Pre/post window length in days. Default 30. */
  windowDays?: number
  /** SKUs launched within this many days qualify. Default 90. */
  recentLaunchWindowDays?: number
  /** Velocity-drop threshold (percent, negative). Default -20. */
  thresholdPct?: number
  /** Min samples (selling days) on each side. Default 5. */
  minSamples?: number
  /** Cap. Default 20 new SKUs scanned. */
  maxNewSkus?: number
}

export async function detectCannibalization(
  args: DetectCannibalizationArgs = {},
): Promise<CannibalizationFinding[]> {
  const window = args.windowDays ?? 30
  const recent = args.recentLaunchWindowDays ?? 90
  const threshold = args.thresholdPct ?? -20
  const minSamples = args.minSamples ?? 5
  const maxNew = args.maxNewSkus ?? 20

  const recentCutoff = new Date()
  recentCutoff.setUTCDate(recentCutoff.getUTCDate() - recent)
  recentCutoff.setUTCHours(0, 0, 0, 0)

  // Step 1 — find recently-launched SKUs. Launch ≈ first DSA row.
  // Bounded: top maxNew by recency so we never scan the full catalog.
  const newLaunches = await prisma.$queryRaw<
    Array<{
      sku: string
      first_day: Date
    }>
  >`
    SELECT sku, MIN(day) AS first_day
    FROM "DailySalesAggregate"
    GROUP BY sku
    HAVING MIN(day) >= ${recentCutoff}::date
    ORDER BY MIN(day) DESC
    LIMIT ${maxNew}
  `
  if (newLaunches.length === 0) return []

  const newSkus = newLaunches.map((l) => l.sku)
  const products = await prisma.product.findMany({
    where: { sku: { in: newSkus } },
    select: { id: true, sku: true, productType: true, brand: true },
  })
  const productBySku = new Map(products.map((p) => [p.sku, p]))

  const findings: CannibalizationFinding[] = []

  for (const launch of newLaunches) {
    const newProduct = productBySku.get(launch.sku)
    if (!newProduct) continue
    if (!newProduct.productType && !newProduct.brand) continue

    const preStart = new Date(launch.first_day)
    preStart.setUTCDate(preStart.getUTCDate() - window)
    const postEnd = new Date(launch.first_day)
    postEnd.setUTCDate(postEnd.getUTCDate() + window)

    // Step 2 — find related SKUs in the same productType OR brand.
    const related = await prisma.product.findMany({
      where: {
        sku: { not: launch.sku },
        isParent: false,
        status: 'ACTIVE',
        OR: [
          newProduct.productType
            ? { productType: newProduct.productType }
            : { id: '__none__' },
          newProduct.brand ? { brand: newProduct.brand } : { id: '__none__' },
        ],
      },
      select: { sku: true, productType: true, brand: true },
      take: 100,
    })
    if (related.length === 0) continue
    const relatedSkus = related.map((r) => r.sku)

    // Step 3 — pre/post velocity per related SKU.
    const velocityRows = await prisma.$queryRaw<
      Array<{
        sku: string
        pre_units: bigint
        pre_days: bigint
        post_units: bigint
        post_days: bigint
      }>
    >`
      SELECT
        sku,
        SUM("unitsSold") FILTER (WHERE day >= ${preStart}::date AND day < ${launch.first_day}::date)::bigint AS pre_units,
        count(*) FILTER (WHERE day >= ${preStart}::date AND day < ${launch.first_day}::date AND "unitsSold" > 0)::bigint AS pre_days,
        SUM("unitsSold") FILTER (WHERE day >= ${launch.first_day}::date AND day < ${postEnd}::date)::bigint AS post_units,
        count(*) FILTER (WHERE day >= ${launch.first_day}::date AND day < ${postEnd}::date AND "unitsSold" > 0)::bigint AS post_days
      FROM "DailySalesAggregate"
      WHERE sku = ANY(${relatedSkus}::text[])
        AND day >= ${preStart}::date
        AND day < ${postEnd}::date
      GROUP BY sku
    `

    const relatedBySku = new Map(related.map((r) => [r.sku, r]))
    const candidates: CannibalizationCandidate[] = []
    for (const v of velocityRows) {
      const preSamples = Number(v.pre_days ?? 0)
      const postSamples = Number(v.post_days ?? 0)
      if (preSamples < minSamples || postSamples < minSamples) continue
      const preUnits = Number(v.pre_units ?? 0)
      const postUnits = Number(v.post_units ?? 0)
      const preVel = preUnits / window
      const postVel = postUnits / window
      const delta = postVel - preVel
      const deltaPct = preVel > 0 ? (delta / preVel) * 100 : 0
      if (deltaPct > threshold) continue // not cannibalized enough
      const r = relatedBySku.get(v.sku)
      candidates.push({
        sku: v.sku,
        productType: r?.productType ?? null,
        brand: r?.brand ?? null,
        preVelocityPerDay: Number(preVel.toFixed(3)),
        postVelocityPerDay: Number(postVel.toFixed(3)),
        velocityDelta: Number(delta.toFixed(3)),
        velocityDeltaPercent: Number(deltaPct.toFixed(1)),
        preSamples,
        postSamples,
      })
    }

    if (candidates.length === 0) continue
    candidates.sort((a, b) => a.velocityDeltaPercent - b.velocityDeltaPercent)

    findings.push({
      newSku: launch.sku,
      newProductId: newProduct.id,
      newProductType: newProduct.productType,
      newBrand: newProduct.brand,
      launchDay: launch.first_day,
      candidates,
    })
  }

  return findings
}
