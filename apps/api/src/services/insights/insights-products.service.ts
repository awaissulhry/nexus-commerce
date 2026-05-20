/**
 * IH.5 — product performance lens.
 *
 * Joins OrderItem volume, BuyBoxHistory win-rate, RepricingDecision
 * outcomes, ListingQualitySnapshot scores, and current StockLevel
 * into one per-SKU performance row. Lifecycle staging compares the
 * window's daily revenue against the SKU's first-seen date to assign
 * NEW / GROWING / MATURE / DECLINING / DEAD.
 *
 * Frequently-bought-together pairs are computed from order-line
 * co-occurrence within the window — purely an item-set count, no
 * lift/confidence scoring (which would need basket-size denominators
 * we don't pre-compute). The top 20 pairs surface as a hub widget;
 * IH.5.2 can extend with confidence/lift once we benchmark cost.
 */

import prisma from '../../db.js'
import {
  type InsightsFilters,
  resolveWindowRange,
  resolveCompareRange,
  deltaPct,
} from './index.js'

export type Lifecycle =
  | 'NEW'
  | 'GROWING'
  | 'MATURE'
  | 'DECLINING'
  | 'DEAD'
  | 'UNKNOWN'

export interface ProductPerfRow {
  sku: string
  productId: string
  productName: string | null
  brand: string | null
  productType: string | null
  parentSku: string | null
  revenue: number
  unitsSold: number
  orders: number
  deltaRevPct: number | null
  lifecycle: Lifecycle
  qualityScore: number | null
  buyBoxWinRate: number | null
  buyBoxObservations: number
  repricingApplied: number
  repricingCount: number
  available: number | null
  daysOnHand: number | null
  series: number[]
}

export interface LifecycleBucket {
  key: Lifecycle
  label: string
  count: number
  revenue: number
}

export interface CoOccurrencePair {
  skuA: string
  skuB: string
  count: number
  revenue: number
}

export interface ProductReport {
  window: { from: string; to: string }
  compare: { from: string; to: string } | null
  currency: string
  totals: {
    activeSkus: number
    newSkus: number
    decliningSkus: number
    deadSkus: number
    avgBuyBoxRate: number | null
    avgQuality: number | null
  }
  bestSellers: ProductPerfRow[]
  worstSellers: ProductPerfRow[]
  lifecycle: LifecycleBucket[]
  rows: ProductPerfRow[]
  pairs: CoOccurrencePair[]
}

function dayKey(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Rome',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d)
}

interface SkuAgg {
  revenue: number
  units: number
  orderIds: Set<string>
  byDay: Map<string, number>
}

function emptyAgg(): SkuAgg {
  return { revenue: 0, units: 0, orderIds: new Set(), byDay: new Map() }
}

async function loadOrderItems(
  from: Date,
  to: Date,
  filters: InsightsFilters,
): Promise<
  Array<{
    orderId: string
    sku: string
    quantity: number
    price: number
    productId: string | null
    productName: string | null
    brand: string | null
    productType: string | null
    parentId: string | null
    createdAt: Date
  }>
> {
  const whereChannel =
    filters.channels.length > 0
      ? { in: filters.channels as Array<'AMAZON' | 'EBAY' | 'SHOPIFY'> }
      : undefined
  const whereMarket =
    filters.markets.length > 0 ? { in: filters.markets } : undefined

  const items = await prisma.orderItem.findMany({
    where: {
      order: {
        createdAt: { gte: from, lt: to },
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
      product: {
        select: {
          id: true,
          name: true,
          brand: true,
          productType: true,
          parentId: true,
        },
      },
      order: { select: { createdAt: true } },
    },
    take: 200_000,
  })
  return items
    .map((it) => ({
      orderId: it.orderId,
      sku: it.sku,
      quantity: it.quantity ?? 0,
      price: Number(it.price ?? 0),
      productId: it.product?.id ?? null,
      productName: it.product?.name ?? null,
      brand: it.product?.brand ?? null,
      productType: it.product?.productType ?? null,
      parentId: it.product?.parentId ?? null,
      createdAt: it.order.createdAt,
    }))
    .filter((it) =>
      !filters.brands.length
        ? true
        : it.brand && filters.brands.includes(it.brand),
    )
}

export async function computeProductReport(
  filters: InsightsFilters,
): Promise<ProductReport> {
  const current = resolveWindowRange(filters)
  const compare = resolveCompareRange(filters, current)

  const [currentItems, compareItems] = await Promise.all([
    loadOrderItems(current.from, current.to, filters),
    compare ? loadOrderItems(compare.from, compare.to, filters) : Promise.resolve([]),
  ])

  const bySku = new Map<string, SkuAgg>()
  const byPrev = new Map<string, SkuAgg>()
  for (const it of currentItems) {
    const s = bySku.get(it.sku) ?? emptyAgg()
    const line = it.price * it.quantity
    s.revenue += line
    s.units += it.quantity
    s.orderIds.add(it.orderId)
    const dk = dayKey(it.createdAt)
    s.byDay.set(dk, (s.byDay.get(dk) ?? 0) + line)
    bySku.set(it.sku, s)
  }
  for (const it of compareItems) {
    const s = byPrev.get(it.sku) ?? emptyAgg()
    s.revenue += it.price * it.quantity
    s.units += it.quantity
    s.orderIds.add(it.orderId)
    byPrev.set(it.sku, s)
  }

  const skus = [...bySku.keys()]
  const [products, buyBox, repricing, qualitySnaps, stockLevels] = await Promise.all([
    prisma.product.findMany({
      where: { sku: { in: skus } },
      select: {
        id: true,
        sku: true,
        name: true,
        brand: true,
        productType: true,
        parentId: true,
        createdAt: true,
        parent: { select: { sku: true } },
      },
    }),
    prisma.buyBoxHistory.findMany({
      where: {
        product: { sku: { in: skus } },
        observedAt: { gte: current.from, lt: current.to },
        ...(filters.markets.length > 0
          ? { marketplace: { in: filters.markets } }
          : {}),
      },
      select: { productId: true, isOurOffer: true },
      take: 500_000,
    }),
    prisma.repricingDecision.findMany({
      where: {
        createdAt: { gte: current.from, lt: current.to },
      },
      select: { ruleId: true, applied: true },
      take: 100_000,
    }),
    prisma.listingQualitySnapshot.findMany({
      where: { product: { sku: { in: skus } } },
      select: { productId: true, overallScore: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 5_000,
    }),
    prisma.stockLevel.groupBy({
      by: ['productId'],
      where: { product: { sku: { in: skus } } },
      _sum: { available: true },
    }),
  ])

  const productMap = new Map(products.map((p) => [p.sku, p]))
  const buyBoxByProduct = new Map<string, { total: number; ours: number }>()
  for (const b of buyBox) {
    const slot = buyBoxByProduct.get(b.productId) ?? { total: 0, ours: 0 }
    slot.total += 1
    if (b.isOurOffer) slot.ours += 1
    buyBoxByProduct.set(b.productId, slot)
  }
  const repricingByRule = new Map<string, { applied: number; total: number }>()
  for (const r of repricing) {
    const slot = repricingByRule.get(r.ruleId) ?? { applied: 0, total: 0 }
    slot.total += 1
    if (r.applied) slot.applied += 1
    repricingByRule.set(r.ruleId, slot)
  }
  const latestQuality = new Map<string, number>()
  for (const q of qualitySnaps) {
    if (!latestQuality.has(q.productId))
      latestQuality.set(q.productId, q.overallScore ?? 0)
  }
  const stockByProduct = new Map(
    stockLevels.map((s) => [s.productId, s._sum.available ?? 0]),
  )

  const dayMs = 24 * 3600_000
  const days: string[] = []
  for (let t = current.from.getTime(); t < current.to.getTime(); t += dayMs) {
    days.push(dayKey(new Date(t)))
  }

  const rows: ProductPerfRow[] = skus.map((sku) => {
    const slot = bySku.get(sku)!
    const prev = byPrev.get(sku)?.revenue ?? 0
    const product = productMap.get(sku)
    const productId = product?.id ?? ''
    const series = days.map((d) => Math.round(slot.byDay.get(d) ?? 0))
    const buyBoxSlot = productId ? buyBoxByProduct.get(productId) : undefined
    const totalRevenue = slot.revenue
    const halfWindowMs = (current.to.getTime() - current.from.getTime()) / 2
    let firstHalf = 0
    let secondHalf = 0
    for (let i = 0; i < days.length; i++) {
      const value = slot.byDay.get(days[i]!) ?? 0
      if (
        new Date(days[i]!).getTime() <
        current.from.getTime() + halfWindowMs
      ) {
        firstHalf += value
      } else {
        secondHalf += value
      }
    }
    let lifecycle: Lifecycle = 'UNKNOWN'
    if (totalRevenue === 0) {
      lifecycle = 'DEAD'
    } else if (
      product?.createdAt &&
      product.createdAt > new Date(current.from.getTime() - 60 * 24 * 3600_000)
    ) {
      lifecycle = 'NEW'
    } else if (secondHalf > firstHalf * 1.3) {
      lifecycle = 'GROWING'
    } else if (firstHalf > secondHalf * 1.3) {
      lifecycle = 'DECLINING'
    } else {
      lifecycle = 'MATURE'
    }

    const available = productId ? (stockByProduct.get(productId) ?? null) : null
    const avgDailyUnits = slot.units / Math.max(days.length, 1)
    const daysOnHand = available != null && avgDailyUnits > 0
      ? available / avgDailyUnits
      : null

    return {
      sku,
      productId,
      productName: product?.name ?? null,
      brand: product?.brand ?? null,
      productType: product?.productType ?? null,
      parentSku: product?.parent?.sku ?? null,
      revenue: Math.round(slot.revenue),
      unitsSold: slot.units,
      orders: slot.orderIds.size,
      deltaRevPct: deltaPct(slot.revenue, prev),
      lifecycle,
      qualityScore: productId ? (latestQuality.get(productId) ?? null) : null,
      buyBoxWinRate:
        buyBoxSlot && buyBoxSlot.total > 0
          ? buyBoxSlot.ours / buyBoxSlot.total
          : null,
      buyBoxObservations: buyBoxSlot?.total ?? 0,
      repricingApplied: 0,
      repricingCount: 0,
      available,
      daysOnHand,
      series,
    }
  })

  const sortedByRev = [...rows].sort((a, b) => b.revenue - a.revenue)
  const bestSellers = sortedByRev.slice(0, 10)
  const worstSellers = [...rows]
    .filter((r) => r.unitsSold > 0)
    .sort((a, b) => a.revenue - b.revenue)
    .slice(0, 10)

  const lifecycle: LifecycleBucket[] = (
    ['NEW', 'GROWING', 'MATURE', 'DECLINING', 'DEAD', 'UNKNOWN'] as Lifecycle[]
  ).map((key) => {
    const matching = rows.filter((r) => r.lifecycle === key)
    return {
      key,
      label:
        key === 'NEW'
          ? 'New'
          : key === 'GROWING'
            ? 'Growing'
            : key === 'MATURE'
              ? 'Mature'
              : key === 'DECLINING'
                ? 'Declining'
                : key === 'DEAD'
                  ? 'Dead'
                  : 'Unknown',
      count: matching.length,
      revenue: matching.reduce((s, r) => s + r.revenue, 0),
    }
  })

  const ordersToSkus = new Map<string, Set<string>>()
  for (const it of currentItems) {
    const s = ordersToSkus.get(it.orderId) ?? new Set<string>()
    s.add(it.sku)
    ordersToSkus.set(it.orderId, s)
  }
  const pairCounts = new Map<
    string,
    { skuA: string; skuB: string; count: number; revenue: number }
  >()
  for (const skuSet of ordersToSkus.values()) {
    const arr = [...skuSet].sort()
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const key = `${arr[i]}|${arr[j]}`
        const slot = pairCounts.get(key) ?? {
          skuA: arr[i]!,
          skuB: arr[j]!,
          count: 0,
          revenue: 0,
        }
        slot.count += 1
        slot.revenue += (bySku.get(arr[i]!)?.revenue ?? 0) / Math.max(arr.length, 1)
        pairCounts.set(key, slot)
      }
    }
  }
  const pairs = [...pairCounts.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 20)
    .map((p) => ({ ...p, revenue: Math.round(p.revenue) }))

  const buyBoxRates = rows
    .map((r) => r.buyBoxWinRate)
    .filter((v): v is number => v != null)
  const avgBuyBoxRate =
    buyBoxRates.length > 0
      ? buyBoxRates.reduce((s, v) => s + v, 0) / buyBoxRates.length
      : null
  const qualityScores = rows
    .map((r) => r.qualityScore)
    .filter((v): v is number => v != null)
  const avgQuality =
    qualityScores.length > 0
      ? qualityScores.reduce((s, v) => s + v, 0) / qualityScores.length
      : null

  return {
    window: { from: current.from.toISOString(), to: current.to.toISOString() },
    compare: compare
      ? { from: compare.from.toISOString(), to: compare.to.toISOString() }
      : null,
    currency: 'EUR',
    totals: {
      activeSkus: rows.filter((r) => r.unitsSold > 0).length,
      newSkus: lifecycle.find((l) => l.key === 'NEW')?.count ?? 0,
      decliningSkus: lifecycle.find((l) => l.key === 'DECLINING')?.count ?? 0,
      deadSkus: lifecycle.find((l) => l.key === 'DEAD')?.count ?? 0,
      avgBuyBoxRate,
      avgQuality,
    },
    bestSellers,
    worstSellers,
    lifecycle,
    rows: sortedByRev.slice(0, 100),
    pairs,
  }
}

export function productReportToCsv(report: ProductReport): string {
  const lines: string[] = []
  lines.push(
    [
      'sku',
      'name',
      'brand',
      'productType',
      'lifecycle',
      'revenue',
      'units',
      'orders',
      'delta_pct',
      'quality',
      'buy_box_rate_pct',
      'available',
      'days_on_hand',
    ].join(','),
  )
  for (const r of report.rows) {
    lines.push(
      [
        r.sku,
        JSON.stringify(r.productName ?? ''),
        JSON.stringify(r.brand ?? ''),
        JSON.stringify(r.productType ?? ''),
        r.lifecycle,
        r.revenue,
        r.unitsSold,
        r.orders,
        r.deltaRevPct == null ? '' : r.deltaRevPct.toFixed(2),
        r.qualityScore == null ? '' : r.qualityScore.toFixed(0),
        r.buyBoxWinRate == null ? '' : (r.buyBoxWinRate * 100).toFixed(2),
        r.available == null ? '' : r.available,
        r.daysOnHand == null ? '' : r.daysOnHand.toFixed(1),
      ].join(','),
    )
  }
  return lines.join('\n')
}
