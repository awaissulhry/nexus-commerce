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
  revenue: { current: number; previous: number; deltaPct: number | null }
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
}

function dayKey(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Rome',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d)
}

async function aggregateRange(
  from: Date,
  to: Date,
  filters: InsightsFilters,
): Promise<OrderAggregate> {
  const whereChannel =
    filters.channels.length > 0
      ? { in: filters.channels as Array<'AMAZON' | 'EBAY' | 'SHOPIFY'> }
      : undefined
  const whereMarket =
    filters.markets.length > 0 ? { in: filters.markets } : undefined

  const orders = await prisma.order.findMany({
    where: {
      purchaseDate: { gte: from, lt: to },
      deletedAt: null,
      ...(whereChannel ? { channel: whereChannel as never } : {}),
      ...(whereMarket ? { marketplace: whereMarket } : {}),
    },
    select: {
      id: true,
      channel: true,
      marketplace: true,
      purchaseDate: true,
      createdAt: true,
      totalPrice: true,
      currencyCode: true,
      items: {
        select: {
          quantity: true,
          product: { select: { brand: true } },
        },
      },
    },
    take: 50_000,
  })

  const result: OrderAggregate = {
    total: 0,
    orders: 0,
    units: 0,
    byDay: new Map(),
    currencies: new Map(),
    byMarketplace: new Map(),
  }

  for (const o of orders) {
    if (filters.brands.length) {
      const brandMatch = o.items.some(
        (it) =>
          it.product?.brand && filters.brands.includes(it.product.brand),
      )
      if (!brandMatch) continue
    }
    const amount = Number(o.totalPrice ?? 0)
    const units = o.items.reduce((s, it) => s + (it.quantity ?? 0), 0)
    const key = dayKey(o.purchaseDate ?? o.createdAt)
    const slot = result.byDay.get(key) ?? { revenue: 0, orders: 0 }
    slot.revenue += amount
    slot.orders += 1
    result.byDay.set(key, slot)
    result.total += amount
    result.orders += 1
    result.units += units
    const code = o.currencyCode ?? 'EUR'
    result.currencies.set(code, (result.currencies.get(code) ?? 0) + amount)
    // I3 — per-(channel, marketplace, currency) bucketing for native-
    // currency rollup. We never mix currencies; each marketplace stands
    // alone in its own currency.
    const channel = String(o.channel)
    const marketplace = o.marketplace ?? 'GLOBAL'
    const mkKey = `${channel}|${marketplace}|${code}`
    const mkSlot = result.byMarketplace.get(mkKey) ?? {
      channel,
      marketplace,
      currency: code,
      revenue: 0,
      orders: 0,
      units: 0,
    }
    mkSlot.revenue += amount
    mkSlot.orders += 1
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

  // I3 — assemble per-marketplace metrics with native-currency current vs
  // previous. Each marketplace stands alone in its own currency.
  const byMarketplace: MarketplaceMetrics[] = []
  for (const [key, cur] of currentAgg.byMarketplace.entries()) {
    const prev = compareAgg.byMarketplace.get(key)
    const prevRev = prev?.revenue ?? 0
    const prevOrders = prev?.orders ?? 0
    const prevUnits = prev?.units ?? 0
    const aovCur = cur.orders > 0 ? cur.revenue / cur.orders : 0
    const aovPr = prevOrders > 0 ? prevRev / prevOrders : 0
    byMarketplace.push({
      channel: cur.channel,
      marketplace: cur.marketplace,
      currency: cur.currency,
      revenue: {
        current: Math.round(cur.revenue * 100) / 100,
        previous: Math.round(prevRev * 100) / 100,
        deltaPct: deltaPct(cur.revenue, prevRev),
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
