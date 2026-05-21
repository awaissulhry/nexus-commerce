/**
 * IH.1 — top SKUs by revenue, units, and loss (return rate).
 *
 * Aggregates OrderItem.price * quantity per SKU within the window,
 * with per-SKU delta vs comparison window. "Loss" surface lets the
 * operator spot SKUs whose returns ate the margin — refunds/returns
 * not yet joined here (deferred to IH.3 profit) so we ship the
 * straightforward revenue/units leaderboard now.
 */

import prisma from '../../db.js'
import {
  type InsightsFilters,
  resolveWindowRange,
  resolveCompareRange,
  deltaPct,
} from './index.js'
import { decimalToCents, centsToMajor } from './money.js'

export interface TopSKURow {
  sku: string
  productName: string | null
  brand: string | null
  revenue: number
  units: number
  orders: number
  deltaPct: number | null
  series: number[]
}

interface RawSku {
  /** I7 — integer cents to avoid float drift across many lines. */
  revenueCents: number
  units: number
  orderIds: Set<string>
  /** I7 — per-day revenue in cents (matches outer accumulator). */
  byDay: Map<string, number>
}

function dayKey(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Rome',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d)
}

async function loadSkus(
  from: Date,
  to: Date,
  filters: InsightsFilters,
): Promise<Map<string, RawSku>> {
  const whereChannel =
    filters.channels.length > 0
      ? { in: filters.channels as Array<'AMAZON' | 'EBAY' | 'SHOPIFY'> }
      : undefined
  const whereMarket =
    filters.markets.length > 0 ? { in: filters.markets } : undefined

  const items = await prisma.orderItem.findMany({
    where: {
      order: {
        purchaseDate: { gte: from, lt: to },
        deletedAt: null,
        ...(whereChannel ? { channel: whereChannel as never } : {}),
        ...(whereMarket ? { marketplace: whereMarket } : {}),
      },
    },
    select: {
      orderId: true,
      sku: true,
      quantity: true,
      price: true,
      product: { select: { brand: true } },
      order: { select: { purchaseDate: true, createdAt: true } },
    },
    take: 200_000,
  })

  const map = new Map<string, RawSku>()
  for (const it of items) {
    if (filters.brands.length) {
      if (!it.product?.brand || !filters.brands.includes(it.product.brand))
        continue
    }
    const slot = map.get(it.sku) ?? {
      revenueCents: 0,
      units: 0,
      orderIds: new Set(),
      byDay: new Map(),
    }
    // I7 — priceCents × quantity is integer math; no float drift.
    const lineCents = decimalToCents(it.price) * (it.quantity ?? 0)
    slot.revenueCents += lineCents
    slot.units += it.quantity ?? 0
    slot.orderIds.add(it.orderId)
    const dk = dayKey(it.order.purchaseDate ?? it.order.createdAt)
    slot.byDay.set(dk, (slot.byDay.get(dk) ?? 0) + lineCents)
    map.set(it.sku, slot)
  }
  return map
}

export async function computeTopSKUs(
  filters: InsightsFilters,
  limit = 10,
): Promise<TopSKURow[]> {
  const current = resolveWindowRange(filters)
  const compare = resolveCompareRange(filters, current)

  const [currentMap, compareMap] = await Promise.all([
    loadSkus(current.from, current.to, filters),
    compare
      ? loadSkus(compare.from, compare.to, filters)
      : Promise.resolve(new Map<string, RawSku>()),
  ])

  const skus = [...currentMap.keys()]
  const products = await prisma.product.findMany({
    where: { sku: { in: skus } },
    select: { sku: true, name: true, brand: true },
  })
  const productMap = new Map(products.map((p) => [p.sku, p]))

  const rows: TopSKURow[] = skus.map((sku) => {
    const slot = currentMap.get(sku)!
    const prevCents = compareMap.get(sku)?.revenueCents ?? 0
    const product = productMap.get(sku)
    const days: string[] = []
    const dayMs = 24 * 3600_000
    for (let t = current.from.getTime(); t < current.to.getTime(); t += dayMs) {
      days.push(dayKey(new Date(t)))
    }
    // I7 — series stored in cents; convert each daily bucket to major.
    const series = days.map((d) => Math.round(centsToMajor(slot.byDay.get(d) ?? 0)))
    return {
      sku,
      productName: product?.name ?? null,
      brand: product?.brand ?? null,
      revenue: Math.round(centsToMajor(slot.revenueCents)),
      units: slot.units,
      orders: slot.orderIds.size,
      deltaPct: deltaPct(slot.revenueCents, prevCents),
      series,
    }
  })

  rows.sort((a, b) => b.revenue - a.revenue)
  return rows.slice(0, limit)
}
