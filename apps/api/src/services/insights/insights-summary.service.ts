/**
 * IH.0 — `/api/insights/summary` aggregator.
 *
 * Returns the headline KPI strip used by the /insights landing page:
 * revenue / orders / units / AOV in both window and comparison
 * window, plus a daily revenue+orders spark series. Sources Order +
 * OrderItem directly so the result reflects the operator's filters
 * (channel × market × brand) — `DailySalesAggregate` is pre-bucketed
 * per channel/marketplace/SKU and would need extra joins for brand
 * filtering; we revisit if the live query becomes hot.
 */

import prisma from '../../db.js'
import {
  type InsightsFilters,
  resolveWindowRange,
  resolveCompareRange,
  deltaPct,
} from './index.js'

/** I3 — per-marketplace × per-currency revenue. We never mix currencies.
 *  One entry per (channel, marketplace, currency) tuple. Operators see
 *  exact native values per market — same shape as Amazon Seller Central.
 */
export interface MarketplaceMetrics {
  channel: string         // 'AMAZON' | 'EBAY' | 'SHOPIFY' | ...
  marketplace: string     // 'IT' | 'DE' | 'GLOBAL' | ...
  currency: string        // 'EUR' | 'GBP' | 'USD' | ...
  /** Gross revenue (sum of order totalPrice). Excludes cancelled orders
   *  (DailySalesAggregate already filters status != CANCELLED). */
  revenue: { current: number; previous: number; deltaPct: number | null }
  /** I5 — refunds issued in this window (Return.refundCents grouped by
   *  the order's channel+marketplace). Subtract from revenue for net. */
  refunds: { current: number; previous: number; deltaPct: number | null }
  /** I5 — net revenue = revenue − refunds. */
  netRevenue: { current: number; previous: number; deltaPct: number | null }
  orders: { current: number; previous: number; deltaPct: number | null }
  units: { current: number; previous: number; deltaPct: number | null }
  aov: { current: number; previous: number; deltaPct: number | null }
}

export interface InsightsSummary {
  window: { from: string; to: string }
  compare: { from: string; to: string } | null
  /** PRIMARY revenue currency (largest single-currency revenue contributor
   *  in the window). Drives the headline KPI when a single-currency view
   *  fits. Multi-currency operators should read `byMarketplace` instead. */
  currency: string
  /** Aggregate counts that ARE currency-agnostic (orders, units). Revenue
   *  here is the PRIMARY-CURRENCY-ONLY subset to avoid the mixed-currency
   *  arithmetic that was previously summed as if all currencies were equal. */
  totals: {
    revenue: { current: number; previous: number; deltaPct: number | null }
    /** I5 — refunds (primary-currency-only subset; full breakdown in byMarketplace) */
    refunds: { current: number; previous: number; deltaPct: number | null }
    /** I5 — net = revenue − refunds (primary-currency-only) */
    netRevenue: { current: number; previous: number; deltaPct: number | null }
    orders: { current: number; previous: number; deltaPct: number | null }
    units: { current: number; previous: number; deltaPct: number | null }
    aov: { current: number; previous: number; deltaPct: number | null }
  }
  /** Canonical per-marketplace × per-currency breakdown — use this for
   *  any multi-marketplace seller. Native currency per row; no implicit
   *  conversion. */
  byMarketplace: MarketplaceMetrics[]
  spark: Array<{ date: string; revenue: number; orders: number }>
  filterEcho: {
    channels: string[]
    markets: string[]
    brands: string[]
  }
}

interface OrderAggregate {
  total: number
  orders: number
  units: number
  byDay: Map<string, { revenue: number; orders: number }>
  currencies: Map<string, number>
  /** I3 — per-(channel, marketplace, currency) bucket. Key is
   *  `${channel}|${marketplace}|${currency}`. */
  byMarketplace: Map<string, { channel: string; marketplace: string; currency: string; revenue: number; orders: number; units: number }>
  /** I5 — refunds issued in window, per (channel, marketplace) in
   *  marketplace native currency (matches DailySalesAggregate convention). */
  refundsByMarketplace: Map<string, number>
}

function dayKey(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Rome',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d)
}

/**
 * I4 — Marketplace.currency lookup. Cached after first call; small
 * fixed set (≤30 marketplaces total). Returns code (e.g. 'EUR') for
 * a (channel, marketplaceCode) pair. Falls back to EUR for unknown.
 */
let marketplaceCurrencyCache: Map<string, string> | null = null
async function getMarketplaceCurrencyMap(): Promise<Map<string, string>> {
  if (marketplaceCurrencyCache) return marketplaceCurrencyCache
  const rows = await prisma.marketplace.findMany({
    select: { channel: true, code: true, currency: true },
  })
  const map = new Map<string, string>()
  for (const r of rows) map.set(`${r.channel}|${r.code}`, r.currency)
  marketplaceCurrencyCache = map
  return map
}

async function aggregateRange(
  from: Date,
  to: Date,
  filters: InsightsFilters,
): Promise<OrderAggregate> {
  // I4 — Read from DailySalesAggregate (pre-bucketed per
  // sku/channel/marketplace/day) instead of live-scanning Order +
  // OrderItem. 10-100× faster at scale; preserves per-channel and
  // per-marketplace breakdowns inherently.
  //
  // Brand filter requires a Product subquery (DailySalesAggregate
  // doesn't store brand). Handled with a JOIN via raw SQL when needed.
  //
  // Currency: DailySalesAggregate.grossRevenue is implicitly in the
  // marketplace's native currency (Amazon.it is always EUR, .uk always
  // GBP). Resolved via Marketplace.currency lookup.

  // Build dynamic WHERE clauses with parameter binding.
  const params: unknown[] = [from, to]
  let paramIdx = 3
  const conditions: string[] = ['d.day >= $1::date', 'd.day < $2::date']

  if (filters.channels.length > 0) {
    const placeholders = filters.channels.map(() => `$${paramIdx++}`).join(',')
    conditions.push(`d.channel IN (${placeholders})`)
    params.push(...filters.channels)
  }
  if (filters.markets.length > 0) {
    const placeholders = filters.markets.map(() => `$${paramIdx++}`).join(',')
    conditions.push(`d.marketplace IN (${placeholders})`)
    params.push(...filters.markets)
  }
  if (filters.brands.length > 0) {
    const placeholders = filters.brands.map(() => `$${paramIdx++}`).join(',')
    conditions.push(
      `d.sku IN (SELECT sku FROM "Product" WHERE brand IN (${placeholders}))`,
    )
    params.push(...filters.brands)
  }

  const where = conditions.join(' AND ')

  const rows = await prisma.$queryRawUnsafe<
    Array<{
      channel: string
      marketplace: string
      day: Date
      revenue: number
      units: number
      orders: number
    }>
  >(
    `SELECT d.channel,
            d.marketplace,
            d.day,
            SUM(d."grossRevenue")::float8 AS revenue,
            SUM(d."unitsSold")::int       AS units,
            SUM(d."ordersCount")::int     AS orders
     FROM "DailySalesAggregate" d
     WHERE ${where}
     GROUP BY d.channel, d.marketplace, d.day`,
    ...params,
  )

  const currencyMap = await getMarketplaceCurrencyMap()

  // I5 — refunds in window, per (channel, marketplace). Return.refundCents
  // grouped by parent Order's channel+marketplace. We use Return.createdAt
  // (Amazon's report sets this to the actual return date; correct).
  const refundRows = await prisma.$queryRawUnsafe<
    Array<{ channel: string; marketplace: string; refund_cents: bigint }>
  >(
    `SELECT o.channel::text AS channel,
            COALESCE(o.marketplace, 'GLOBAL') AS marketplace,
            COALESCE(SUM(r."refundCents"), 0)::bigint AS refund_cents
     FROM "Return" r
     JOIN "Order" o ON o.id = r."orderId"
     WHERE r."createdAt" >= $1 AND r."createdAt" < $2
       AND o."deletedAt" IS NULL
     GROUP BY o.channel, COALESCE(o.marketplace, 'GLOBAL')`,
    from,
    to,
  )

  const result: OrderAggregate = {
    total: 0,
    orders: 0,
    units: 0,
    byDay: new Map(),
    currencies: new Map(),
    byMarketplace: new Map(),
    refundsByMarketplace: new Map(),
  }
  for (const rr of refundRows) {
    const key = `${rr.channel}|${rr.marketplace}`
    result.refundsByMarketplace.set(key, Number(rr.refund_cents) / 100)
  }

  for (const r of rows) {
    const amount = Number(r.revenue ?? 0)
    const units = Number(r.units ?? 0)
    const orders = Number(r.orders ?? 0)
    const key = dayKey(r.day)
    const slot = result.byDay.get(key) ?? { revenue: 0, orders: 0 }
    slot.revenue += amount
    slot.orders += orders
    result.byDay.set(key, slot)
    result.total += amount
    result.orders += orders
    result.units += units
    const code = currencyMap.get(`${r.channel}|${r.marketplace}`) ?? 'EUR'
    result.currencies.set(code, (result.currencies.get(code) ?? 0) + amount)
    const mkKey = `${r.channel}|${r.marketplace}|${code}`
    const mkSlot = result.byMarketplace.get(mkKey) ?? {
      channel: r.channel,
      marketplace: r.marketplace,
      currency: code,
      revenue: 0,
      orders: 0,
      units: 0,
    }
    mkSlot.revenue += amount
    mkSlot.orders += orders
    mkSlot.units += units
    result.byMarketplace.set(mkKey, mkSlot)
  }
  return result
}

export async function computeInsightsSummary(
  filters: InsightsFilters,
): Promise<InsightsSummary> {
  const current = resolveWindowRange(filters)
  const compare = resolveCompareRange(filters, current)

  const [currentAgg, compareAgg] = await Promise.all([
    aggregateRange(current.from, current.to, filters),
    compare
      ? aggregateRange(compare.from, compare.to, filters)
      : Promise.resolve<OrderAggregate>({
          total: 0,
          orders: 0,
          units: 0,
          byDay: new Map(),
          currencies: new Map(),
          byMarketplace: new Map(),
          refundsByMarketplace: new Map(),
        }),
  ])

  // I2 — primary currency = single-currency contributor with the largest
  // revenue. Drives the headline KPI when one currency dominates. For
  // multi-currency sellers, the per-marketplace breakdown is the source
  // of truth — we never blend currencies.
  let primaryCurrency = 'EUR'
  let primaryAmount = 0
  for (const [code, amt] of currentAgg.currencies.entries()) {
    if (amt > primaryAmount) {
      primaryAmount = amt
      primaryCurrency = code
    }
  }
  const primaryAmountPrev = compareAgg.currencies.get(primaryCurrency) ?? 0

  const spark: Array<{ date: string; revenue: number; orders: number }> = []
  const dayMs = 24 * 3600_000
  for (let t = current.from.getTime(); t < current.to.getTime(); t += dayMs) {
    const d = new Date(t)
    const key = dayKey(d)
    const slot = currentAgg.byDay.get(key)
    spark.push({
      date: key,
      revenue: Math.round(slot?.revenue ?? 0),
      orders: slot?.orders ?? 0,
    })
  }

  // I2 — totals.revenue is restricted to the primary currency to avoid
  // the previous bug of mixed-currency summation. Orders + units are
  // currency-agnostic and stay as totals across the whole window.
  const aovCurrent = currentAgg.orders ? primaryAmount / currentAgg.orders : 0
  const aovPrev = compareAgg.orders ? primaryAmountPrev / compareAgg.orders : 0

  // I3 + I5 — assemble per-marketplace metrics with native-currency current
  // vs previous + refunds + net revenue. Each marketplace stands alone in
  // its own currency.
  const byMarketplace: MarketplaceMetrics[] = []
  for (const [key, cur] of currentAgg.byMarketplace.entries()) {
    const prev = compareAgg.byMarketplace.get(key)
    const prevRev = prev?.revenue ?? 0
    const prevOrders = prev?.orders ?? 0
    const prevUnits = prev?.units ?? 0
    const aovCur = cur.orders > 0 ? cur.revenue / cur.orders : 0
    const aovPr = prevOrders > 0 ? prevRev / prevOrders : 0
    // Refund lookup uses (channel|marketplace) key — refunds attribute to
    // the parent order's marketplace regardless of currency.
    const refundKey = `${cur.channel}|${cur.marketplace}`
    const refundsCur = currentAgg.refundsByMarketplace.get(refundKey) ?? 0
    const refundsPrev = compareAgg.refundsByMarketplace.get(refundKey) ?? 0
    const netCur = cur.revenue - refundsCur
    const netPrev = prevRev - refundsPrev
    byMarketplace.push({
      channel: cur.channel,
      marketplace: cur.marketplace,
      currency: cur.currency,
      revenue: {
        current: Math.round(cur.revenue * 100) / 100,
        previous: Math.round(prevRev * 100) / 100,
        deltaPct: deltaPct(cur.revenue, prevRev),
      },
      refunds: {
        current: Math.round(refundsCur * 100) / 100,
        previous: Math.round(refundsPrev * 100) / 100,
        deltaPct: deltaPct(refundsCur, refundsPrev),
      },
      netRevenue: {
        current: Math.round(netCur * 100) / 100,
        previous: Math.round(netPrev * 100) / 100,
        deltaPct: deltaPct(netCur, netPrev),
      },
      orders: {
        current: cur.orders,
        previous: prevOrders,
        deltaPct: deltaPct(cur.orders, prevOrders),
      },
      units: {
        current: cur.units,
        previous: prevUnits,
        deltaPct: deltaPct(cur.units, prevUnits),
      },
      aov: {
        current: Math.round(aovCur * 100) / 100,
        previous: Math.round(aovPr * 100) / 100,
        deltaPct: deltaPct(aovCur, aovPr),
      },
    })
  }
  // Sort descending by current-period revenue so the biggest market is first
  byMarketplace.sort((a, b) => b.revenue.current - a.revenue.current)

  return {
    window: {
      from: current.from.toISOString(),
      to: current.to.toISOString(),
    },
    compare: compare
      ? { from: compare.from.toISOString(), to: compare.to.toISOString() }
      : null,
    currency: primaryCurrency,
    totals: {
      revenue: {
        // Restricted to primary currency — see I2 note above.
        current: Math.round(primaryAmount * 100) / 100,
        previous: Math.round(primaryAmountPrev * 100) / 100,
        deltaPct: deltaPct(primaryAmount, primaryAmountPrev),
      },
      refunds: (() => {
        // I5 — refunds totals restricted to primary currency's marketplaces.
        // For multi-currency, byMarketplace[].refunds is the canonical view.
        let cur = 0, prv = 0
        for (const m of byMarketplace) {
          if (m.currency !== primaryCurrency) continue
          cur += m.refunds.current
          prv += m.refunds.previous
        }
        return {
          current: Math.round(cur * 100) / 100,
          previous: Math.round(prv * 100) / 100,
          deltaPct: deltaPct(cur, prv),
        }
      })(),
      netRevenue: (() => {
        let cur = 0, prv = 0
        for (const m of byMarketplace) {
          if (m.currency !== primaryCurrency) continue
          cur += m.netRevenue.current
          prv += m.netRevenue.previous
        }
        return {
          current: Math.round(cur * 100) / 100,
          previous: Math.round(prv * 100) / 100,
          deltaPct: deltaPct(cur, prv),
        }
      })(),
      orders: {
        current: currentAgg.orders,
        previous: compareAgg.orders,
        deltaPct: deltaPct(currentAgg.orders, compareAgg.orders),
      },
      units: {
        current: currentAgg.units,
        previous: compareAgg.units,
        deltaPct: deltaPct(currentAgg.units, compareAgg.units),
      },
      aov: {
        current: Math.round(aovCurrent * 100) / 100,
        previous: Math.round(aovPrev * 100) / 100,
        deltaPct: deltaPct(aovCurrent, aovPrev),
      },
    },
    byMarketplace,
    spark,
    filterEcho: {
      channels: filters.channels,
      markets: filters.markets,
      brands: filters.brands,
    },
  }
}
