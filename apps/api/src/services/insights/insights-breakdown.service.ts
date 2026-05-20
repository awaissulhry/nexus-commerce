/**
 * IH.1 — per-channel + per-market breakdown.
 *
 * One query for the active window + one for the comparison window;
 * roll up into channel and market buckets with delta percentages so
 * the hub renders both BreakdownPie (channel) and HeatmapGrid
 * (channel × market) without two API round trips.
 */

import prisma from '../../db.js'
import {
  type InsightsFilters,
  resolveWindowRange,
  resolveCompareRange,
  deltaPct,
} from './index.js'

export interface BreakdownBucket {
  key: string
  label: string
  revenue: number
  orders: number
  units: number
  deltaPct: number | null
}

export interface ChannelMarketCell {
  channel: string
  market: string
  revenue: number
  orders: number
}

export interface InsightsBreakdown {
  byChannel: BreakdownBucket[]
  byMarket: BreakdownBucket[]
  matrix: ChannelMarketCell[]
  currency: string
}

const CHANNEL_LABELS: Record<string, string> = {
  AMAZON: 'Amazon',
  EBAY: 'eBay',
  SHOPIFY: 'Shopify',
  WOOCOMMERCE: 'WooCommerce',
  ETSY: 'Etsy',
  MANUAL: 'Manual',
}

interface RawSlot {
  revenue: number
  orders: number
  units: number
}

async function loadBuckets(
  from: Date,
  to: Date,
  filters: InsightsFilters,
): Promise<{
  byChannel: Map<string, RawSlot>
  byMarket: Map<string, RawSlot>
  matrix: Map<string, RawSlot>
  currencies: Map<string, number>
}> {
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
      channel: true,
      marketplace: true,
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

  const byChannel = new Map<string, RawSlot>()
  const byMarket = new Map<string, RawSlot>()
  const matrix = new Map<string, RawSlot>()
  const currencies = new Map<string, number>()

  for (const o of orders) {
    if (filters.brands.length) {
      const brandMatch = o.items.some(
        (it) =>
          it.product?.brand && filters.brands.includes(it.product.brand),
      )
      if (!brandMatch) continue
    }
    const revenue = Number(o.totalPrice ?? 0)
    const units = o.items.reduce((s, it) => s + (it.quantity ?? 0), 0)
    const ch = o.channel
    const mk = o.marketplace ?? 'GLOBAL'

    const cs = byChannel.get(ch) ?? { revenue: 0, orders: 0, units: 0 }
    cs.revenue += revenue
    cs.orders += 1
    cs.units += units
    byChannel.set(ch, cs)

    const ms = byMarket.get(mk) ?? { revenue: 0, orders: 0, units: 0 }
    ms.revenue += revenue
    ms.orders += 1
    ms.units += units
    byMarket.set(mk, ms)

    const matrixKey = `${ch}|${mk}`
    const xs = matrix.get(matrixKey) ?? { revenue: 0, orders: 0, units: 0 }
    xs.revenue += revenue
    xs.orders += 1
    xs.units += units
    matrix.set(matrixKey, xs)

    const code = o.currencyCode ?? 'EUR'
    currencies.set(code, (currencies.get(code) ?? 0) + revenue)
  }

  return { byChannel, byMarket, matrix, currencies }
}

export async function computeInsightsBreakdown(
  filters: InsightsFilters,
): Promise<InsightsBreakdown> {
  const current = resolveWindowRange(filters)
  const compare = resolveCompareRange(filters, current)

  const [currentData, compareData] = await Promise.all([
    loadBuckets(current.from, current.to, filters),
    compare
      ? loadBuckets(compare.from, compare.to, filters)
      : Promise.resolve({
          byChannel: new Map<string, RawSlot>(),
          byMarket: new Map<string, RawSlot>(),
          matrix: new Map<string, RawSlot>(),
          currencies: new Map<string, number>(),
        }),
  ])

  let primaryCurrency = 'EUR'
  let primaryAmount = 0
  for (const [code, amt] of currentData.currencies.entries()) {
    if (amt > primaryAmount) {
      primaryAmount = amt
      primaryCurrency = code
    }
  }

  const byChannel: BreakdownBucket[] = [...currentData.byChannel.entries()].map(
    ([key, slot]) => {
      const prev = compareData.byChannel.get(key)?.revenue ?? 0
      return {
        key,
        label: CHANNEL_LABELS[key] ?? key,
        revenue: Math.round(slot.revenue),
        orders: slot.orders,
        units: slot.units,
        deltaPct: deltaPct(slot.revenue, prev),
      }
    },
  )

  const byMarket: BreakdownBucket[] = [...currentData.byMarket.entries()].map(
    ([key, slot]) => {
      const prev = compareData.byMarket.get(key)?.revenue ?? 0
      return {
        key,
        label: key,
        revenue: Math.round(slot.revenue),
        orders: slot.orders,
        units: slot.units,
        deltaPct: deltaPct(slot.revenue, prev),
      }
    },
  )

  const matrix: ChannelMarketCell[] = [...currentData.matrix.entries()].map(
    ([key, slot]) => {
      const [channel, market] = key.split('|')
      return {
        channel: channel ?? '',
        market: market ?? '',
        revenue: Math.round(slot.revenue),
        orders: slot.orders,
      }
    },
  )

  return {
    byChannel,
    byMarket,
    matrix,
    currency: primaryCurrency,
  }
}
