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

export interface InsightsSummary {
  window: { from: string; to: string }
  compare: { from: string; to: string } | null
  currency: string
  totals: {
    revenue: { current: number; previous: number; deltaPct: number | null }
    orders: { current: number; previous: number; deltaPct: number | null }
    units: { current: number; previous: number; deltaPct: number | null }
    aov: { current: number; previous: number; deltaPct: number | null }
  }
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
      createdAt: { gte: from, lt: to },
      deletedAt: null,
      ...(whereChannel ? { channel: whereChannel as never } : {}),
      ...(whereMarket ? { marketplace: whereMarket } : {}),
    },
    select: {
      id: true,
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
    const key = dayKey(o.createdAt)
    const slot = result.byDay.get(key) ?? { revenue: 0, orders: 0 }
    slot.revenue += amount
    slot.orders += 1
    result.byDay.set(key, slot)
    result.total += amount
    result.orders += 1
    result.units += units
    const code = o.currencyCode ?? 'EUR'
    result.currencies.set(code, (result.currencies.get(code) ?? 0) + amount)
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
        }),
  ])

  let primaryCurrency = 'EUR'
  let primaryAmount = 0
  for (const [code, amt] of currentAgg.currencies.entries()) {
    if (amt > primaryAmount) {
      primaryAmount = amt
      primaryCurrency = code
    }
  }

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

  const aovCurrent = currentAgg.orders ? currentAgg.total / currentAgg.orders : 0
  const aovPrev = compareAgg.orders ? compareAgg.total / compareAgg.orders : 0

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
        current: Math.round(currentAgg.total),
        previous: Math.round(compareAgg.total),
        deltaPct: deltaPct(currentAgg.total, compareAgg.total),
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
        current: Math.round(aovCurrent),
        previous: Math.round(aovPrev),
        deltaPct: deltaPct(aovCurrent, aovPrev),
      },
    },
    spark,
    filterEcho: {
      channels: filters.channels,
      markets: filters.markets,
      brands: filters.brands,
    },
  }
}
