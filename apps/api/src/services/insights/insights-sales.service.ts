/**
 * IH.2 — comprehensive sales report aggregator.
 *
 * One endpoint backs the /insights/sales surface: revenue + units +
 * orders + AOV over time (with overlay series for the comparison
 * window), splits by channel / market / brand / productType /
 * fulfillment method, Pareto curve for SKU concentration, and the
 * refunds/returns gross-up so the operator sees the cash that didn't
 * stick.
 *
 * Brand + productType joins happen here rather than via separate
 * endpoints because the slices share the same OrderItem scan; doing
 * them once is dramatically cheaper than five separate queries.
 */

import prisma from '../../db.js'
import {
  type InsightsFilters,
  resolveWindowRange,
  resolveCompareRange,
  deltaPct,
} from './index.js'
import { decimalToCents, centsToMajor } from './money.js'

export interface SalesTrendPoint {
  date: string
  revenue: number
  ordersCount: number
  units: number
  revenuePrev?: number
}

export interface SalesBucket {
  key: string
  label: string
  revenue: number
  orders: number
  units: number
  share: number
  deltaPct: number | null
}

export interface ParetoPoint {
  rank: number
  sku: string
  cumulativeRevenue: number
  cumulativeShare: number
}

export interface SalesReport {
  window: { from: string; to: string }
  compare: { from: string; to: string } | null
  currency: string
  totals: {
    revenue: number
    orders: number
    units: number
    aov: number
    refundsValue: number
    returnsCount: number
    discountValue: number
  }
  totalsPrev: {
    revenue: number
    orders: number
    units: number
    aov: number
    refundsValue: number
    returnsCount: number
  }
  trend: SalesTrendPoint[]
  byChannel: SalesBucket[]
  byMarket: SalesBucket[]
  byBrand: SalesBucket[]
  byProductType: SalesBucket[]
  byFulfillment: SalesBucket[]
  matrix: Array<{ channel: string; market: string; revenue: number; orders: number }>
  /** I3 — per-(channel, marketplace, currency) breakdown in native
   *  currency. No mixing — each row stands alone. Sorted by current
   *  revenue desc. */
  byMarketplaceNative: Array<{
    channel: string
    marketplace: string
    currency: string
    revenue: number
    orders: number
    units: number
    aov: number
  }>
  pareto: ParetoPoint[]
  paretoSummary: {
    topNCount: number
    topNShare: number
    skuCount: number
  }
}

const CHANNEL_LABELS: Record<string, string> = {
  AMAZON: 'Amazon',
  EBAY: 'eBay',
  SHOPIFY: 'Shopify',
  WOOCOMMERCE: 'WooCommerce',
  ETSY: 'Etsy',
  MANUAL: 'Manual',
}

const FULFILLMENT_LABELS: Record<string, string> = {
  AFN: 'FBA (Amazon)',
  MFN: 'FBM / Self-shipped',
  FBA: 'FBA (Amazon)',
  FBM: 'FBM / Self-shipped',
}

function dayKey(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Rome',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d)
}

interface OrderRow {
  id: string
  channel: string
  marketplace: string | null
  fulfillmentMethod: string | null
  /** I7 — order total in integer cents (native currency). */
  totalPriceCents: number
  currencyCode: string | null
  createdAt: Date
  items: Array<{
    sku: string
    quantity: number
    /** I7 — unit price in integer cents (native currency). */
    priceCents: number
    productBrand: string | null
    productType: string | null
  }>
}

async function loadOrders(
  from: Date,
  to: Date,
  filters: InsightsFilters,
): Promise<OrderRow[]> {
  const whereChannel =
    filters.channels.length > 0
      ? { in: filters.channels as Array<'AMAZON' | 'EBAY' | 'SHOPIFY'> }
      : undefined
  const whereMarket =
    filters.markets.length > 0 ? { in: filters.markets } : undefined

  const orders = await prisma.order.findMany({
    where: {
      // Filter by purchaseDate (real order placement); see I1 audit
      purchaseDate: { gte: from, lt: to },
      deletedAt: null,
      ...(whereChannel ? { channel: whereChannel as never } : {}),
      ...(whereMarket ? { marketplace: whereMarket } : {}),
    },
    select: {
      id: true,
      channel: true,
      marketplace: true,
      fulfillmentMethod: true,
      totalPrice: true,
      currencyCode: true,
      purchaseDate: true,
      createdAt: true,
      items: {
        select: {
          sku: true,
          quantity: true,
          price: true,
          product: { select: { brand: true, productType: true } },
        },
      },
    },
    take: 100_000,
  })

  return orders
    .map((o) => ({
      id: o.id,
      channel: o.channel,
      marketplace: o.marketplace,
      fulfillmentMethod: o.fulfillmentMethod,
      totalPriceCents: decimalToCents(o.totalPrice),
      currencyCode: o.currencyCode,
      // Surface the event date (purchaseDate) as createdAt to downstream
      // bucketing; fall back to ingestion createdAt for legacy rows.
      createdAt: o.purchaseDate ?? o.createdAt,
      items: o.items.map((it) => ({
        sku: it.sku,
        quantity: it.quantity ?? 0,
        priceCents: decimalToCents(it.price),
        productBrand: it.product?.brand ?? null,
        productType: it.product?.productType ?? null,
      })),
    }))
    .filter((o) => {
      if (!filters.brands.length) return true
      return o.items.some(
        (it) => it.productBrand && filters.brands.includes(it.productBrand),
      )
    })
}

async function loadRefundsValue(
  from: Date,
  to: Date,
  filters: InsightsFilters,
): Promise<{ refundsCents: number; returnsCount: number }> {
  const whereChannel =
    filters.channels.length > 0
      ? { in: filters.channels as Array<'AMAZON' | 'EBAY' | 'SHOPIFY'> }
      : undefined
  const whereMarket =
    filters.markets.length > 0 ? { in: filters.markets } : undefined

  const returns = await prisma.return.findMany({
    where: {
      createdAt: { gte: from, lt: to },
      ...(whereChannel
        ? {
            order: {
              channel: whereChannel as never,
              ...(whereMarket ? { marketplace: whereMarket } : {}),
            },
          }
        : whereMarket
          ? { order: { marketplace: whereMarket } }
          : {}),
    },
    select: {
      refundCents: true,
    },
    take: 50_000,
  })

  const refundsCents = returns.reduce((s, r) => s + (r.refundCents ?? 0), 0)
  return { refundsCents, returnsCount: returns.length }
}

interface Slot {
  /** I7 — integer cents. Convert with centsToMajor() at response boundary. */
  revenueCents: number
  orders: Set<string>
  units: number
}

function emptySlot(): Slot {
  return { revenueCents: 0, orders: new Set(), units: 0 }
}

function bucketize(
  current: Map<string, Slot>,
  previous: Map<string, Slot>,
  totalCents: number,
  labelFor: (key: string) => string,
): SalesBucket[] {
  return [...current.entries()].map(([key, slot]) => {
    const prevCents = previous.get(key)?.revenueCents ?? 0
    return {
      key,
      label: labelFor(key),
      revenue: Math.round(centsToMajor(slot.revenueCents)),
      orders: slot.orders.size,
      units: slot.units,
      share: totalCents > 0 ? slot.revenueCents / totalCents : 0,
      deltaPct: deltaPct(slot.revenueCents, prevCents),
    }
  })
}

function aggregateOrders(orders: OrderRow[]): {
  trend: Map<string, { revenueCents: number; orders: Set<string>; units: number }>
  byChannel: Map<string, Slot>
  byMarket: Map<string, Slot>
  byBrand: Map<string, Slot>
  byProductType: Map<string, Slot>
  byFulfillment: Map<string, Slot>
  matrix: Map<string, Slot>
  bySku: Map<string, Slot>
  /** I7 — currencies map values in integer cents. */
  currencies: Map<string, number>
  /** I3 — per-(channel, marketplace, currency) native rollup, cents. */
  byMarketplaceNative: Map<string, {
    channel: string
    marketplace: string
    currency: string
    revenueCents: number
    orders: Set<string>
    units: number
  }>
  /** I7 — totalCents in integer cents. */
  totalCents: number
} {
  const trend = new Map<
    string,
    { revenueCents: number; orders: Set<string>; units: number }
  >()
  const byChannel = new Map<string, Slot>()
  const byMarket = new Map<string, Slot>()
  const byBrand = new Map<string, Slot>()
  const byProductType = new Map<string, Slot>()
  const byFulfillment = new Map<string, Slot>()
  const matrix = new Map<string, Slot>()
  const bySku = new Map<string, Slot>()
  /** I7 — currencies map values are integer cents per code. */
  const currencies = new Map<string, number>()
  // I3 — per-(channel, marketplace, currency) tuple. Each row stands
  // alone in its native currency; no implicit conversion.
  // I7 — revenueCents = integer cents native to each currency.
  const byMarketplaceNative = new Map<
    string,
    {
      channel: string
      marketplace: string
      currency: string
      revenueCents: number
      orders: Set<string>
      units: number
    }
  >()
  let totalCents = 0

  for (const o of orders) {
    const units = o.items.reduce((s, it) => s + it.quantity, 0)
    // I7 — line math entirely in integer cents (priceCents × quantity).
    const lineCents = o.items.reduce(
      (s, it) => s + it.priceCents * it.quantity,
      0,
    )
    const orderCents = o.totalPriceCents > 0 ? o.totalPriceCents : lineCents
    totalCents += orderCents

    const dk = dayKey(o.createdAt)
    const ts = trend.get(dk) ?? {
      revenueCents: 0,
      orders: new Set<string>(),
      units: 0,
    }
    ts.revenueCents += orderCents
    ts.orders.add(o.id)
    ts.units += units
    trend.set(dk, ts)

    const push = (map: Map<string, Slot>, key: string, addUnits = units) => {
      const slot = map.get(key) ?? emptySlot()
      slot.revenueCents += orderCents
      slot.orders.add(o.id)
      slot.units += addUnits
      map.set(key, slot)
    }
    push(byChannel, o.channel)
    const market = o.marketplace ?? 'GLOBAL'
    push(byMarket, market)
    push(matrix, `${o.channel}|${market}`)
    push(
      byFulfillment,
      o.fulfillmentMethod ?? (o.channel === 'AMAZON' ? 'MFN' : 'OTHER'),
    )
    const brandSet = new Set<string>()
    const typeSet = new Set<string>()
    for (const it of o.items) {
      const slot = bySku.get(it.sku) ?? emptySlot()
      slot.revenueCents += it.priceCents * it.quantity
      slot.orders.add(o.id)
      slot.units += it.quantity
      bySku.set(it.sku, slot)
      if (it.productBrand) brandSet.add(it.productBrand)
      if (it.productType) typeSet.add(it.productType)
    }
    for (const b of brandSet) push(byBrand, b, 0)
    for (const t of typeSet) push(byProductType, t, 0)

    const code = o.currencyCode ?? 'EUR'
    currencies.set(code, (currencies.get(code) ?? 0) + orderCents)
    // I3 — per-(channel, marketplace, currency) bucketing for native-
    // currency rollup. Mirrors the summary service pattern.
    const mkKey = `${o.channel}|${market}|${code}`
    const mkSlot = byMarketplaceNative.get(mkKey) ?? {
      channel: o.channel,
      marketplace: market,
      currency: code,
      revenueCents: 0,
      orders: new Set<string>(),
      units: 0,
    }
    mkSlot.revenueCents += orderCents
    mkSlot.orders.add(o.id)
    mkSlot.units += units
    byMarketplaceNative.set(mkKey, mkSlot)
  }

  return {
    trend,
    byChannel,
    byMarket,
    byBrand,
    byProductType,
    byFulfillment,
    matrix,
    bySku,
    currencies,
    byMarketplaceNative,
    totalCents,
  }
}

export async function computeSalesReport(
  filters: InsightsFilters,
): Promise<SalesReport> {
  const current = resolveWindowRange(filters)
  const compare = resolveCompareRange(filters, current)

  const [currentOrders, compareOrders, refunds, refundsPrev] = await Promise.all([
    loadOrders(current.from, current.to, filters),
    compare ? loadOrders(compare.from, compare.to, filters) : Promise.resolve([]),
    loadRefundsValue(current.from, current.to, filters),
    compare
      ? loadRefundsValue(compare.from, compare.to, filters)
      : Promise.resolve({ refundsCents: 0, returnsCount: 0 }),
  ])

  const currentAgg = aggregateOrders(currentOrders)
  const compareAgg = aggregateOrders(compareOrders)

  // I7 — currencies values are integer cents; comparison is exact.
  let primaryCurrency = 'EUR'
  let primaryAmountCents = 0
  for (const [code, cents] of currentAgg.currencies.entries()) {
    if (cents > primaryAmountCents) {
      primaryAmountCents = cents
      primaryCurrency = code
    }
  }

  const dayMs = 24 * 3600_000
  const days: string[] = []
  for (let t = current.from.getTime(); t < current.to.getTime(); t += dayMs) {
    days.push(dayKey(new Date(t)))
  }
  const prevDays: string[] = compare
    ? (() => {
        const arr: string[] = []
        for (let t = compare.from.getTime(); t < compare.to.getTime(); t += dayMs) {
          arr.push(dayKey(new Date(t)))
        }
        return arr
      })()
    : []
  const trend: SalesTrendPoint[] = days.map((d, i) => {
    const slot = currentAgg.trend.get(d)
    const prevKey = prevDays[i]
    const prevSlot = prevKey ? compareAgg.trend.get(prevKey) : undefined
    return {
      date: d,
      revenue: Math.round(centsToMajor(slot?.revenueCents ?? 0)),
      ordersCount: slot?.orders.size ?? 0,
      units: slot?.units ?? 0,
      revenuePrev: prevSlot
        ? Math.round(centsToMajor(prevSlot.revenueCents))
        : undefined,
    }
  })

  // I7 — Pareto math stays in cents until the final cumulativeRevenue
  // emission. Share is a ratio so cents/cents is dimensionless.
  const skuEntries = [...currentAgg.bySku.entries()]
    .map(([sku, slot]) => ({ sku, revenueCents: slot.revenueCents }))
    .sort((a, b) => b.revenueCents - a.revenueCents)
  let cumulativeCents = 0
  const pareto: ParetoPoint[] = skuEntries.map((row, i) => {
    cumulativeCents += row.revenueCents
    return {
      rank: i + 1,
      sku: row.sku,
      cumulativeRevenue: Math.round(centsToMajor(cumulativeCents)),
      cumulativeShare:
        currentAgg.totalCents > 0 ? cumulativeCents / currentAgg.totalCents : 0,
    }
  })
  let topNCount = 0
  for (const point of pareto) {
    topNCount = point.rank
    if (point.cumulativeShare >= 0.8) break
  }
  const paretoSummary = {
    topNCount,
    topNShare: pareto[topNCount - 1]?.cumulativeShare ?? 0,
    skuCount: skuEntries.length,
  }

  const ordersCount = currentOrders.length
  const ordersPrevCount = compareOrders.length

  return {
    window: { from: current.from.toISOString(), to: current.to.toISOString() },
    compare: compare
      ? { from: compare.from.toISOString(), to: compare.to.toISOString() }
      : null,
    currency: primaryCurrency,
    totals: {
      revenue: Math.round(centsToMajor(currentAgg.totalCents)),
      orders: ordersCount,
      units: [...currentAgg.bySku.values()].reduce((s, x) => s + x.units, 0),
      // I7 — AOV computed in cents then converted; exact 2dp.
      aov: ordersCount
        ? Math.round(centsToMajor(currentAgg.totalCents / ordersCount))
        : 0,
      refundsValue: Math.round(refunds.refundsCents / 100),
      returnsCount: refunds.returnsCount,
      discountValue: 0,
    },
    totalsPrev: {
      revenue: Math.round(centsToMajor(compareAgg.totalCents)),
      orders: ordersPrevCount,
      units: [...compareAgg.bySku.values()].reduce((s, x) => s + x.units, 0),
      aov: ordersPrevCount
        ? Math.round(centsToMajor(compareAgg.totalCents / ordersPrevCount))
        : 0,
      refundsValue: Math.round(refundsPrev.refundsCents / 100),
      returnsCount: refundsPrev.returnsCount,
    },
    trend,
    byChannel: bucketize(
      currentAgg.byChannel,
      compareAgg.byChannel,
      currentAgg.totalCents,
      (k) => CHANNEL_LABELS[k] ?? k,
    ),
    byMarket: bucketize(
      currentAgg.byMarket,
      compareAgg.byMarket,
      currentAgg.totalCents,
      (k) => k,
    ),
    byBrand: bucketize(
      currentAgg.byBrand,
      compareAgg.byBrand,
      currentAgg.totalCents,
      (k) => k,
    ),
    byProductType: bucketize(
      currentAgg.byProductType,
      compareAgg.byProductType,
      currentAgg.totalCents,
      (k) => k,
    ),
    byFulfillment: bucketize(
      currentAgg.byFulfillment,
      compareAgg.byFulfillment,
      currentAgg.totalCents,
      (k) => FULFILLMENT_LABELS[k] ?? k,
    ),
    matrix: [...currentAgg.matrix.entries()].map(([key, slot]) => {
      const [channel, market] = key.split('|')
      return {
        channel: channel ?? '',
        market: market ?? '',
        revenue: Math.round(centsToMajor(slot.revenueCents)),
        orders: slot.orders.size,
      }
    }),
    // I3 — per-(channel, marketplace, currency) native-currency rollup.
    // Sorted by current revenue desc. Each row stands alone in its
    // own currency; no implicit conversion. Use this for the
    // operator-facing per-marketplace KPI strip.
    // I7 — composed from integer cents; centsToMajor gives exact 2dp.
    byMarketplaceNative: [...currentAgg.byMarketplaceNative.values()]
      .map((s) => ({
        channel: s.channel,
        marketplace: s.marketplace,
        currency: s.currency,
        revenue: centsToMajor(s.revenueCents),
        orders: s.orders.size,
        units: s.units,
        aov:
          s.orders.size > 0
            ? centsToMajor(Math.round(s.revenueCents / s.orders.size))
            : 0,
      }))
      .sort((a, b) => b.revenue - a.revenue),
    pareto,
    paretoSummary,
  }
}

export function salesReportToCsv(report: SalesReport): string {
  const rows: string[] = []
  rows.push(
    ['section', 'key', 'label', 'revenue', 'orders', 'units', 'share', 'delta_pct'].join(','),
  )
  function push(section: string, b: SalesBucket) {
    rows.push(
      [
        section,
        JSON.stringify(b.key),
        JSON.stringify(b.label),
        b.revenue.toString(),
        b.orders.toString(),
        b.units.toString(),
        (b.share * 100).toFixed(2),
        b.deltaPct == null ? '' : b.deltaPct.toFixed(2),
      ].join(','),
    )
  }
  for (const b of report.byChannel) push('channel', b)
  for (const b of report.byMarket) push('market', b)
  for (const b of report.byBrand) push('brand', b)
  for (const b of report.byProductType) push('productType', b)
  for (const b of report.byFulfillment) push('fulfillment', b)
  rows.push('')
  rows.push(['date', 'revenue', 'orders', 'units', 'revenue_prev'].join(','))
  for (const p of report.trend) {
    rows.push(
      [
        p.date,
        p.revenue.toString(),
        p.ordersCount.toString(),
        p.units.toString(),
        p.revenuePrev?.toString() ?? '',
      ].join(','),
    )
  }
  return rows.join('\n')
}
