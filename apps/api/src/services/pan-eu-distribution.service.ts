/**
 * W7.1 — Pan-EU FBA distribution recommender.
 *
 * Aggregates FbaInventoryDetail (S.25) by (sku, marketplaceId) and
 * cross-references DailySalesAggregate for per-marketplace velocity.
 * Flags imbalances where one marketplace has surplus (>60d cover)
 * while another is running low (<7d cover) and computes a suggested
 * transfer quantity that brings both toward a target 30d cover.
 *
 * Pure analytical layer — does NOT trigger MCF or new inbound
 * shipments. Output is the recommendation list + totals; the
 * operator decides whether to act via /fulfillment/inbound (create
 * a multi-FC reshipment) or by reducing the surplus marketplace's
 * outbound until it organically draws down.
 *
 * Why surplus + shortage rather than just shortage: Pan-EU is a
 * zero-sum game across marketplaces (the same physical SKU on the
 * same Amazon EU storage shelves). Recommending "ship more to ES"
 * without showing "DE has 6 months of cover" misses the point —
 * the cheapest fix is typically to redistribute, not to procure.
 *
 * Velocity defaults to 0 for marketplaces with no recent sales.
 * Cover for zero-velocity marketplaces is treated as "infinite" —
 * displayed as null, not a divide-by-zero number.
 */

import prisma from '../db.js'

export interface PanEuRecommendation {
  productId: string | null
  sku: string
  productName: string | null
  surplus: {
    marketplaceId: string
    sellableUnits: number
    velocityPerDay: number
    daysOfCover: number | null
  }
  shortage: {
    marketplaceId: string
    sellableUnits: number
    velocityPerDay: number
    daysOfCover: number | null
  }
  /** Suggested transfer quantity from surplus → shortage. */
  transferUnits: number
  /** Resulting cover (units / velocity) at each marketplace after transfer. */
  newDaysOfCoverSurplus: number | null
  newDaysOfCoverShortage: number | null
  /** W7.3 — Multi-Channel Fulfillment velocity for this SKU. MCF orders
   *  consume FBA stock but originate from non-Amazon channels (Shopify,
   *  eBay manual, etc.). Reported separately so the operator sees the
   *  full draw on Amazon's storage shelves, not just Amazon-channel sales. */
  mcfVelocityPerDay?: number
}

export interface DetectImbalancesArgs {
  /** Days of cover below which a marketplace is treated as "shortage".
   *  Default 7 — 1 week of stock left. */
  shortageDaysCover?: number
  /** Days of cover above which a marketplace is "surplus". Default 60. */
  surplusDaysCover?: number
  /** Target days of cover after rebalance. Default 30. */
  targetDaysCover?: number
  /** Velocity lookback window in days. Default 30. */
  velocityWindowDays?: number
  /** Only consider these marketplaces (skip 'GLOBAL', etc). */
  marketplaceFilter?: string[]
  /** Limit on recommendations returned. Default 200. */
  limit?: number
}

interface InventoryByMarket {
  sku: string
  productId: string | null
  productName: string | null
  marketplaceId: string
  sellable: number
}

interface VelocityByMarket {
  sku: string
  marketplaceId: string
  unitsSoldInWindow: number
  velocityPerDay: number
}

const DEFAULT_FILTER = ['IT', 'DE', 'FR', 'ES', 'NL']

export async function detectPanEuImbalances(
  args: DetectImbalancesArgs = {},
): Promise<{
  totals: {
    skusFlagged: number
    totalTransferUnits: number
    totalSurplusUnits: number
    totalShortageMarketplaces: number
  }
  recommendations: PanEuRecommendation[]
}> {
  const shortageDays = args.shortageDaysCover ?? 7
  const surplusDays = args.surplusDaysCover ?? 60
  const targetDays = args.targetDaysCover ?? 30
  const window = args.velocityWindowDays ?? 30
  const filter = args.marketplaceFilter ?? DEFAULT_FILTER
  const limit = args.limit ?? 200

  // Inventory: aggregate SELLABLE rows per (sku, marketplaceId).
  // Skips marketplaces outside the filter so 'GLOBAL'-tagged legacy
  // rows don't cross-pollute the recommendation set.
  const inventoryRows = await prisma.$queryRaw<InventoryByMarket[]>`
    SELECT
      d.sku,
      d."productId",
      MAX(p.name) AS "productName",
      d."marketplaceId",
      SUM(d.quantity)::int AS sellable
    FROM "FbaInventoryDetail" d
    LEFT JOIN "Product" p ON p.id = d."productId"
    WHERE d.condition = 'SELLABLE'
      AND d."marketplaceId" = ANY(${filter}::text[])
    GROUP BY d.sku, d."productId", d."marketplaceId"
    HAVING SUM(d.quantity) > 0
  `

  if (inventoryRows.length === 0) {
    return {
      totals: {
        skusFlagged: 0,
        totalTransferUnits: 0,
        totalSurplusUnits: 0,
        totalShortageMarketplaces: 0,
      },
      recommendations: [],
    }
  }

  // Velocity per (sku, marketplaceId) over the window. AMAZON channel
  // only — we're rebalancing FBA, not all channels.
  const windowStart = new Date()
  windowStart.setUTCDate(windowStart.getUTCDate() - window)
  windowStart.setUTCHours(0, 0, 0, 0)

  const velocityRows = await prisma.$queryRaw<
    Array<{ sku: string; marketplace: string; units: bigint }>
  >`
    SELECT
      sku,
      marketplace,
      SUM("unitsSold")::bigint AS units
    FROM "DailySalesAggregate"
    WHERE channel = 'AMAZON'
      AND day >= ${windowStart}::date
      AND marketplace = ANY(${filter}::text[])
    GROUP BY sku, marketplace
  `

  const velocityByKey = new Map<string, VelocityByMarket>()
  for (const row of velocityRows) {
    const key = `${row.sku}:${row.marketplace}`
    const units = Number(row.units ?? 0)
    velocityByKey.set(key, {
      sku: row.sku,
      marketplaceId: row.marketplace,
      unitsSoldInWindow: units,
      velocityPerDay: units / window,
    })
  }

  // W7.3 — MCF (Multi-Channel Fulfillment) velocity. MCF orders
  // consume FBA stock but originate from non-Amazon channels
  // (Shopify storefront orders fulfilled by FBA, manual MCF
  // submissions, etc.). Without this, FBA inventory looks
  // under-utilised because the velocity query only counts AMAZON-
  // channel sales.
  //
  // We aggregate Order rows directly (DSA doesn't track
  // fulfillmentMethod). One query, grouped by SKU; not by
  // marketplace because MCF orders don't carry an Amazon
  // marketplace tag — they're consumed from the regional FBA pool
  // closest to the customer. The recommender allocates this MCF
  // demand evenly across marketplaces that have non-zero AMAZON
  // velocity for the same SKU (proxy for "where FBA likely picked
  // the units").
  const mcfRows = await prisma.$queryRaw<
    Array<{ sku: string; units: bigint }>
  >`
    SELECT
      oi.sku,
      SUM(oi.quantity)::bigint AS units
    FROM "OrderItem" oi
    JOIN "Order" o ON o.id = oi."orderId"
    WHERE o."fulfillmentMethod" = 'FBA'
      AND o.channel::text != 'AMAZON'
      AND o.status != 'CANCELLED'
      AND COALESCE(o."purchaseDate", o."createdAt") >= ${windowStart}
    GROUP BY oi.sku
  `
  const mcfVelocityBySku = new Map<string, number>()
  for (const row of mcfRows) {
    const units = Number(row.units ?? 0)
    if (units > 0) mcfVelocityBySku.set(row.sku, units / window)
  }

  // Group inventory rows by SKU for the per-SKU rebalance pass.
  const bySku = new Map<
    string,
    {
      productId: string | null
      productName: string | null
      perMarket: Array<{
        marketplaceId: string
        sellable: number
        velocity: number
        daysOfCover: number | null
      }>
    }
  >()

  for (const inv of inventoryRows) {
    const v = velocityByKey.get(`${inv.sku}:${inv.marketplaceId}`)
    const amazonVelocity = v?.velocityPerDay ?? 0
    if (!bySku.has(inv.sku)) {
      bySku.set(inv.sku, {
        productId: inv.productId,
        productName: inv.productName,
        perMarket: [],
      })
    }
    bySku.get(inv.sku)!.perMarket.push({
      marketplaceId: inv.marketplaceId,
      sellable: inv.sellable,
      velocity: amazonVelocity, // W7.3 — MCF added below after we know N_markets per SKU
      daysOfCover: null, // recomputed after MCF apportionment
    })
  }

  // W7.3 — apportion MCF velocity across marketplaces that have
  // non-zero Amazon velocity (proxy for "where FBA likely picked
  // the units"). When NO marketplace has Amazon velocity, MCF is
  // split evenly across all marketplaces with stock — a fallback
  // that prefers under-attribution to over-attribution.
  for (const [sku, ctx] of bySku) {
    const mcf = mcfVelocityBySku.get(sku) ?? 0
    if (mcf <= 0) {
      // Still compute daysOfCover.
      for (const m of ctx.perMarket) {
        m.daysOfCover = m.velocity > 0 ? m.sellable / m.velocity : null
      }
      continue
    }
    const withVelocity = ctx.perMarket.filter((m) => m.velocity > 0)
    const splitTargets = withVelocity.length > 0 ? withVelocity : ctx.perMarket
    const totalAmazonVelocity = withVelocity.reduce((s, m) => s + m.velocity, 0)

    for (const m of splitTargets) {
      const share =
        totalAmazonVelocity > 0
          ? m.velocity / totalAmazonVelocity
          : 1 / splitTargets.length
      m.velocity += mcf * share
    }
    for (const m of ctx.perMarket) {
      m.daysOfCover = m.velocity > 0 ? m.sellable / m.velocity : null
    }
  }

  // Per-SKU rebalance pass. For each SKU:
  //   - find surplus markets (daysOfCover > surplusDays)
  //   - find shortage markets (daysOfCover < shortageDays AND velocity > 0)
  //   - greedily pair the biggest surplus with the biggest shortage
  //     and propose a transfer that brings both toward targetDays
  //
  // Only one recommendation per SKU is emitted in v0 (the most
  // urgent pair). Multi-pair output is W7.1b.
  const recommendations: PanEuRecommendation[] = []
  let totalSurplusUnits = 0
  const shortageMarketsSeen = new Set<string>()

  for (const [sku, ctx] of bySku) {
    const surplus = ctx.perMarket
      .filter((m) => m.daysOfCover != null && m.daysOfCover > surplusDays)
      .sort((a, b) => (b.daysOfCover ?? 0) - (a.daysOfCover ?? 0))
    const shortage = ctx.perMarket
      .filter(
        (m) =>
          m.daysOfCover != null &&
          m.daysOfCover < shortageDays &&
          m.velocity > 0,
      )
      .sort((a, b) => (a.daysOfCover ?? 0) - (b.daysOfCover ?? 0))

    if (surplus.length === 0 || shortage.length === 0) continue

    const src = surplus[0]
    const dst = shortage[0]

    // Transfer enough to bring shortage to targetDays cover, capped
    // at the surplus that exceeds targetDays.
    const dstNeed = Math.max(
      0,
      Math.round(dst.velocity * targetDays) - dst.sellable,
    )
    const srcSpare = Math.max(
      0,
      src.sellable - Math.round(src.velocity * targetDays),
    )
    const transferUnits = Math.min(dstNeed, srcSpare)

    if (transferUnits <= 0) continue

    const newDoCsrc =
      src.velocity > 0 ? (src.sellable - transferUnits) / src.velocity : null
    const newDoCdst =
      dst.velocity > 0 ? (dst.sellable + transferUnits) / dst.velocity : null

    const mcfForSku = mcfVelocityBySku.get(sku) ?? 0
    recommendations.push({
      productId: ctx.productId,
      sku,
      productName: ctx.productName,
      surplus: {
        marketplaceId: src.marketplaceId,
        sellableUnits: src.sellable,
        velocityPerDay: Number(src.velocity.toFixed(3)),
        daysOfCover:
          src.daysOfCover != null ? Number(src.daysOfCover.toFixed(1)) : null,
      },
      shortage: {
        marketplaceId: dst.marketplaceId,
        sellableUnits: dst.sellable,
        velocityPerDay: Number(dst.velocity.toFixed(3)),
        daysOfCover:
          dst.daysOfCover != null ? Number(dst.daysOfCover.toFixed(1)) : null,
      },
      transferUnits,
      newDaysOfCoverSurplus:
        newDoCsrc != null ? Number(newDoCsrc.toFixed(1)) : null,
      newDaysOfCoverShortage:
        newDoCdst != null ? Number(newDoCdst.toFixed(1)) : null,
      mcfVelocityPerDay: mcfForSku > 0 ? Number(mcfForSku.toFixed(3)) : undefined,
    })

    totalSurplusUnits += src.sellable
    shortageMarketsSeen.add(dst.marketplaceId)

    if (recommendations.length >= limit) break
  }

  // Sort by transferUnits desc so the biggest impact rises to the top.
  recommendations.sort((a, b) => b.transferUnits - a.transferUnits)

  return {
    totals: {
      skusFlagged: recommendations.length,
      totalTransferUnits: recommendations.reduce(
        (s, r) => s + r.transferUnits,
        0,
      ),
      totalSurplusUnits,
      totalShortageMarketplaces: shortageMarketsSeen.size,
    },
    recommendations,
  }
}
