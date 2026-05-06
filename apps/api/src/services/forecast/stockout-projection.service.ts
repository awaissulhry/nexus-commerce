/**
 * H.12 — stock-out projection from ReplenishmentForecast rows.
 *
 *   projectStockout(prisma, productId, opts?)
 *     → { daysOfCover, stockoutDate, velocity, urgency, basis }
 *
 * The existing F.4 forecaster generates per-day demand at the
 * (sku, channel, marketplace) granularity. This service rolls those
 * up to per-product daily demand, then walks the forecast forward
 * subtracting from current stock until it hits zero — that day is
 * the stockoutDate.
 *
 * `urgency` decision tree (default leadTimeDays = 30):
 *   stockoutDate <= today + 7              → 'critical'
 *   stockoutDate <= today + leadTimeDays   → 'warn'
 *   anything else                          → 'ok'
 *   no forecast signal + stock=0           → 'critical'
 *   no forecast signal + stock>0           → 'unknown'
 *
 * `basis` tells the caller which signal carried the projection so the
 * UI can show "based on 90-day forecast" vs "based on current stock
 * threshold (no demand signal yet)" — useful in pre-launch phase
 * where the forecast table is sparse.
 *
 * NOT cached: the cron updates ReplenishmentForecast nightly and
 * stock changes intra-day; pinning this on a 30s ETag in the route
 * is sufficient.
 */

import type { PrismaClient } from '@prisma/client'

export interface StockoutProjectionOpts {
  /** How many days of forecast to consider. Default 90 (matches the
   *  cron's horizon). Beyond that the forecast confidence collapses. */
  horizonDays?: number
  /** Reorder lead time. Used to bucket urgency. Default 30. */
  leadTimeDays?: number
  /** Whether the forecast already accounts for safety stock. Today
   *  no — leave at false. */
  includesSafetyStock?: boolean
}

export type Urgency = 'critical' | 'warn' | 'ok' | 'unknown'

export interface StockoutProjection {
  productId: string
  sku: string
  totalStock: number
  /** Average daily demand in units, computed as sum(forecast) /
   *  horizonDays. null when no forecast rows exist. */
  velocity: number | null
  /** Days until projected stock-out. null when no forecast or stock
   *  outlasts the forecast horizon. */
  daysOfCover: number | null
  /** Calendar date of projected stock-out (UTC). null when daysOfCover
   *  is null. */
  stockoutDate: Date | null
  urgency: Urgency
  /** 'forecast' | 'threshold' | 'none'. */
  basis: 'forecast' | 'threshold' | 'none'
  /** Used by callers that want to show "based on N days of demand
   *  data". Drops to 0 for cold-start products. */
  forecastDays: number
}

const DAY_MS = 24 * 60 * 60 * 1000

function daysBetween(a: Date, b: Date): number {
  const ms = b.getTime() - a.getTime()
  return Math.floor(ms / DAY_MS)
}

function startOfUtcDay(d: Date): Date {
  const x = new Date(d)
  x.setUTCHours(0, 0, 0, 0)
  return x
}

function urgencyFor(
  stockoutDate: Date | null,
  totalStock: number,
  hasSignal: boolean,
  leadTimeDays: number,
): Urgency {
  if (stockoutDate) {
    const today = startOfUtcDay(new Date())
    const days = daysBetween(today, stockoutDate)
    if (days <= 7) return 'critical'
    if (days <= leadTimeDays) return 'warn'
    return 'ok'
  }
  if (!hasSignal) {
    if (totalStock === 0) return 'critical'
    return 'unknown'
  }
  // Has signal but no projected stockout within horizon → ok.
  return 'ok'
}

/**
 * Project stockout for one product.
 *
 * Forecast rows are read across every (channel, marketplace) for the
 * product's SKU. We sum them per horizonDay so the projection
 * reflects total cross-channel demand the master stock has to cover.
 */
export async function projectStockout(
  prisma: PrismaClient,
  productId: string,
  opts: StockoutProjectionOpts = {},
): Promise<StockoutProjection | null> {
  const horizonDays = opts.horizonDays ?? 90
  const leadTimeDays = opts.leadTimeDays ?? 30

  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { id: true, sku: true, totalStock: true, lowStockThreshold: true },
  })
  if (!product) return null

  const today = startOfUtcDay(new Date())
  const horizonEnd = new Date(today.getTime() + horizonDays * DAY_MS)

  // Pull all forecasts from today onward, across channels.
  const forecasts = await prisma.replenishmentForecast.findMany({
    where: {
      sku: product.sku,
      horizonDay: { gte: today, lte: horizonEnd },
    },
    select: { horizonDay: true, forecastUnits: true },
    orderBy: { horizonDay: 'asc' },
  })

  // Collapse to daily demand: Map<dayKey, units>.
  const dailyDemand = new Map<string, number>()
  for (const f of forecasts) {
    const key = startOfUtcDay(f.horizonDay).toISOString()
    const u = Number(f.forecastUnits)
    dailyDemand.set(key, (dailyDemand.get(key) ?? 0) + u)
  }

  const totalStock = product.totalStock ?? 0
  const totalForecast = Array.from(dailyDemand.values()).reduce(
    (a, b) => a + b,
    0,
  )

  // No forecast signal at all → fall back to threshold heuristic.
  if (forecasts.length === 0 || totalForecast === 0) {
    return {
      productId: product.id,
      sku: product.sku,
      totalStock,
      velocity: null,
      daysOfCover: null,
      stockoutDate: null,
      urgency: urgencyFor(null, totalStock, false, leadTimeDays),
      basis: totalStock === 0 ? 'threshold' : 'none',
      forecastDays: 0,
    }
  }

  // Walk forward day-by-day, decrementing stock. The first day after
  // we cross zero is the stockoutDate.
  let stockOnHand = totalStock
  let stockoutDate: Date | null = null
  for (let i = 0; i <= horizonDays; i++) {
    const day = new Date(today.getTime() + i * DAY_MS)
    const key = startOfUtcDay(day).toISOString()
    const demand = dailyDemand.get(key) ?? 0
    stockOnHand -= demand
    if (stockOnHand < 0) {
      // Stockout happens *during* this day — surface this day as the
      // stockoutDate (operator interprets as "won't make it through
      // this date").
      stockoutDate = day
      break
    }
  }

  // velocity = average daily demand over the populated horizon. We
  // divide by the actual count of forecast days, not horizonDays
  // total, so missing-day rows don't drag the average down.
  const velocity = totalForecast / Math.max(1, forecasts.length)
  const daysOfCover = stockoutDate ? daysBetween(today, stockoutDate) : null

  return {
    productId: product.id,
    sku: product.sku,
    totalStock,
    velocity,
    daysOfCover,
    stockoutDate,
    urgency: urgencyFor(stockoutDate, totalStock, true, leadTimeDays),
    basis: 'forecast',
    forecastDays: forecasts.length,
  }
}

/**
 * Batch variant. Same projection per product, but in two queries
 * total (one for products, one for all forecasts) instead of N pairs.
 */
export async function projectStockoutBatch(
  prisma: PrismaClient,
  productIds: string[],
  opts: StockoutProjectionOpts = {},
): Promise<StockoutProjection[]> {
  if (productIds.length === 0) return []
  const horizonDays = opts.horizonDays ?? 90
  const leadTimeDays = opts.leadTimeDays ?? 30
  const today = startOfUtcDay(new Date())
  const horizonEnd = new Date(today.getTime() + horizonDays * DAY_MS)

  const products = await prisma.product.findMany({
    where: { id: { in: productIds } },
    select: { id: true, sku: true, totalStock: true },
  })
  const skus = products.map((p) => p.sku)
  const skuToProduct = new Map(products.map((p) => [p.sku, p]))

  const forecasts = await prisma.replenishmentForecast.findMany({
    where: {
      sku: { in: skus },
      horizonDay: { gte: today, lte: horizonEnd },
    },
    select: { sku: true, horizonDay: true, forecastUnits: true },
    orderBy: [{ sku: 'asc' }, { horizonDay: 'asc' }],
  })

  // Group: sku → Map<dayKey, units>
  const bySku = new Map<string, Map<string, number>>()
  const countBySku = new Map<string, number>()
  for (const f of forecasts) {
    let m = bySku.get(f.sku)
    if (!m) {
      m = new Map()
      bySku.set(f.sku, m)
    }
    const key = startOfUtcDay(f.horizonDay).toISOString()
    m.set(key, (m.get(key) ?? 0) + Number(f.forecastUnits))
    countBySku.set(f.sku, (countBySku.get(f.sku) ?? 0) + 1)
  }

  const results: StockoutProjection[] = []
  for (const p of products) {
    const dailyDemand = bySku.get(p.sku)
    const totalStock = p.totalStock ?? 0
    if (!dailyDemand || dailyDemand.size === 0) {
      results.push({
        productId: p.id,
        sku: p.sku,
        totalStock,
        velocity: null,
        daysOfCover: null,
        stockoutDate: null,
        urgency: urgencyFor(null, totalStock, false, leadTimeDays),
        basis: totalStock === 0 ? 'threshold' : 'none',
        forecastDays: 0,
      })
      continue
    }
    let stockOnHand = totalStock
    let stockoutDate: Date | null = null
    for (let i = 0; i <= horizonDays; i++) {
      const day = new Date(today.getTime() + i * DAY_MS)
      const key = startOfUtcDay(day).toISOString()
      const demand = dailyDemand.get(key) ?? 0
      stockOnHand -= demand
      if (stockOnHand < 0) {
        stockoutDate = day
        break
      }
    }
    const totalForecast = Array.from(dailyDemand.values()).reduce(
      (a, b) => a + b,
      0,
    )
    const fdays = countBySku.get(p.sku) ?? 0
    const velocity = totalForecast / Math.max(1, fdays)
    const daysOfCover = stockoutDate ? daysBetween(today, stockoutDate) : null
    results.push({
      productId: p.id,
      sku: p.sku,
      totalStock,
      velocity,
      daysOfCover,
      stockoutDate,
      urgency: urgencyFor(stockoutDate, totalStock, true, leadTimeDays),
      basis: 'forecast',
      forecastDays: fdays,
    })
  }
  return results
}
