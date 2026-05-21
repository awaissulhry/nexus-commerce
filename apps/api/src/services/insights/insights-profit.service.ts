/**
 * IH.3 — profit & cost analysis with P&L waterfall.
 *
 * Constructs a defensible income statement from the data we hold:
 *   Revenue
 *   − COGS                  (OrderItem.quantity × Product.costPrice)
 *   − Channel fees           (estimated via per-channel rate table —
 *                              Amazon 15%, eBay 12%, Shopify 2.9% +
 *                              €0.30/transaction)
 *   − Ad spend               (AmazonAdsDailyPerformance.costMicros
 *                              summed across the window)
 *   − Refunds                (Return.refundCents)
 *   = Net profit
 *
 * Per-SKU contribution margin uses the same recipe applied to that
 * SKU's revenue + units (fees allocated proportionally to revenue).
 * Ad spend isn't currently allocated per SKU here — that lands in
 * IH.4 advertising deep dive.
 *
 * The fee rate table is intentionally simple and tunable. Real-world
 * Amazon fees vary by category (referral 8-15%, FBA fulfillment
 * tiers); a per-product fee schedule lives in TECH_DEBT and would
 * back this calc once we ingest it. The current rates are an honest
 * floor: net-profit estimates are conservative (slight over-fee bias).
 */

import prisma from '../../db.js'
import {
  type InsightsFilters,
  resolveWindowRange,
  resolveCompareRange,
  deltaPct,
} from './index.js'

const CHANNEL_FEE_PCT: Record<string, number> = {
  AMAZON: 0.15,
  EBAY: 0.12,
  SHOPIFY: 0.029,
  WOOCOMMERCE: 0.029,
  ETSY: 0.065,
  MANUAL: 0,
}

const CHANNEL_FEE_FIXED_CENTS: Record<string, number> = {
  SHOPIFY: 30,
  WOOCOMMERCE: 30,
}

const CHANNEL_LABELS: Record<string, string> = {
  AMAZON: 'Amazon',
  EBAY: 'eBay',
  SHOPIFY: 'Shopify',
  WOOCOMMERCE: 'WooCommerce',
  ETSY: 'Etsy',
  MANUAL: 'Manual',
}

export interface WaterfallStep {
  key: string
  label: string
  value: number
  kind: 'start' | 'add' | 'sub' | 'total'
}

export interface ProfitBreakdownEntry {
  key: string
  label: string
  revenue: number
  cogs: number
  fees: number
  refunds: number
  grossProfit: number
  netProfit: number
  marginPct: number | null
  unitsSold: number
}

export interface ProfitSkuRow {
  sku: string
  productName: string | null
  brand: string | null
  revenue: number
  cogs: number
  fees: number
  grossProfit: number
  marginPct: number | null
  unitsSold: number
}

export interface ProfitReport {
  window: { from: string; to: string }
  compare: { from: string; to: string } | null
  currency: string
  totals: {
    revenue: number
    cogs: number
    fees: number
    adSpend: number
    refunds: number
    grossProfit: number
    netProfit: number
    marginPct: number | null
  }
  totalsPrev: {
    revenue: number
    cogs: number
    fees: number
    adSpend: number
    refunds: number
    grossProfit: number
    netProfit: number
    marginPct: number | null
  }
  deltas: {
    revenue: number | null
    cogs: number | null
    fees: number | null
    adSpend: number | null
    refunds: number | null
    grossProfit: number | null
    netProfit: number | null
  }
  waterfall: WaterfallStep[]
  byChannel: ProfitBreakdownEntry[]
  /** I6 — per-(channel, marketplace, currency) P&L in native currency.
   *  Each row stands alone — no implicit conversion across marketplaces. */
  byMarketplace: Array<{
    channel: string
    marketplace: string
    currency: string
    revenue: number
    cogs: number
    fees: number
    grossProfit: number
    netProfit: number
    marginPct: number | null
    unitsSold: number
  }>
  bySku: ProfitSkuRow[]
  lossMakers: ProfitSkuRow[]
  feeNotes: { label: string; detail: string }[]
}

interface RawOrderItem {
  orderId: string
  channel: string
  marketplace: string
  currency: string
  sku: string
  quantity: number
  price: number
  costPrice: number | null
  brand: string | null
  productName: string | null
}

async function loadOrderItems(
  from: Date,
  to: Date,
  filters: InsightsFilters,
): Promise<RawOrderItem[]> {
  const whereChannel =
    filters.channels.length > 0
      ? { in: filters.channels as Array<'AMAZON' | 'EBAY' | 'SHOPIFY'> }
      : undefined
  const whereMarket =
    filters.markets.length > 0 ? { in: filters.markets } : undefined

  const items = await prisma.orderItem.findMany({
    where: {
      order: {
        // Filter by parent order's purchaseDate, not createdAt (I1)
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
      product: { select: { name: true, brand: true, costPrice: true } },
      order: { select: { channel: true, marketplace: true, currencyCode: true } },
    },
    take: 200_000,
  })

  return items
    .map((it) => ({
      orderId: it.orderId,
      channel: it.order.channel as string,
      marketplace: it.order.marketplace ?? 'GLOBAL',
      currency: it.order.currencyCode ?? 'EUR',
      sku: it.sku,
      quantity: it.quantity ?? 0,
      price: Number(it.price ?? 0),
      costPrice:
        it.product?.costPrice == null ? null : Number(it.product.costPrice),
      brand: it.product?.brand ?? null,
      productName: it.product?.name ?? null,
    }))
    .filter((it) =>
      !filters.brands.length
        ? true
        : it.brand && filters.brands.includes(it.brand),
    )
}

async function loadAdSpend(
  from: Date,
  to: Date,
  filters: InsightsFilters,
): Promise<number> {
  if (filters.channels.length > 0 && !filters.channels.includes('AMAZON')) {
    return 0
  }
  const rows = await prisma.amazonAdsDailyPerformance.findMany({
    where: {
      date: { gte: from, lt: to },
      ...(filters.markets.length > 0
        ? { marketplace: { in: filters.markets } }
        : {}),
    },
    select: { costMicros: true },
    take: 500_000,
  })
  let totalMicros = 0n
  for (const r of rows) totalMicros += r.costMicros
  return Number(totalMicros) / 1_000_000
}

async function loadRefunds(
  from: Date,
  to: Date,
  filters: InsightsFilters,
): Promise<number> {
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
    select: { refundCents: true },
    take: 50_000,
  })
  return returns.reduce((s, r) => s + (r.refundCents ?? 0), 0) / 100
}

interface Acc {
  revenue: number
  cogs: number
  fees: number
  units: number
  orders: Set<string>
}

function emptyAcc(): Acc {
  return { revenue: 0, cogs: 0, fees: 0, units: 0, orders: new Set() }
}

function computeFee(channel: string, revenue: number, orders: number): number {
  const pct = CHANNEL_FEE_PCT[channel] ?? 0.1
  const fixedCents = CHANNEL_FEE_FIXED_CENTS[channel] ?? 0
  return revenue * pct + (fixedCents / 100) * orders
}

function aggregate(items: RawOrderItem[]): {
  total: Acc
  byChannel: Map<string, Acc>
  /** I6 — per-(channel, marketplace, currency) P&L bucket. */
  byMarketplace: Map<string, Acc & { channel: string; marketplace: string; currency: string }>
  bySku: Map<
    string,
    Acc & { productName: string | null; brand: string | null; channel: string }
  >
} {
  const total = emptyAcc()
  const byChannel = new Map<string, Acc>()
  const byMarketplace = new Map<
    string,
    Acc & { channel: string; marketplace: string; currency: string }
  >()
  const bySku = new Map<
    string,
    Acc & { productName: string | null; brand: string | null; channel: string }
  >()

  for (const it of items) {
    const line = it.price * it.quantity
    const cogsLine = (it.costPrice ?? 0) * it.quantity
    total.revenue += line
    total.cogs += cogsLine
    total.units += it.quantity
    total.orders.add(it.orderId)

    const chSlot = byChannel.get(it.channel) ?? emptyAcc()
    chSlot.revenue += line
    chSlot.cogs += cogsLine
    chSlot.units += it.quantity
    chSlot.orders.add(it.orderId)
    byChannel.set(it.channel, chSlot)

    const mkKey = `${it.channel}|${it.marketplace}|${it.currency}`
    const mkSlot =
      byMarketplace.get(mkKey) ??
      ({
        ...emptyAcc(),
        channel: it.channel,
        marketplace: it.marketplace,
        currency: it.currency,
      } as Acc & { channel: string; marketplace: string; currency: string })
    mkSlot.revenue += line
    mkSlot.cogs += cogsLine
    mkSlot.units += it.quantity
    mkSlot.orders.add(it.orderId)
    byMarketplace.set(mkKey, mkSlot)

    const skuSlot =
      bySku.get(it.sku) ??
      ({
        ...emptyAcc(),
        productName: it.productName,
        brand: it.brand,
        channel: it.channel,
      } as Acc & {
        productName: string | null
        brand: string | null
        channel: string
      })
    skuSlot.revenue += line
    skuSlot.cogs += cogsLine
    skuSlot.units += it.quantity
    skuSlot.orders.add(it.orderId)
    bySku.set(it.sku, skuSlot)
  }

  for (const [ch, slot] of byChannel.entries()) {
    slot.fees = computeFee(ch, slot.revenue, slot.orders.size)
  }
  for (const [, slot] of byMarketplace.entries()) {
    slot.fees = computeFee(slot.channel, slot.revenue, slot.orders.size)
  }
  total.fees = [...byChannel.values()].reduce((s, a) => s + a.fees, 0)
  for (const [, slot] of bySku.entries()) {
    slot.fees = computeFee(slot.channel, slot.revenue, slot.orders.size)
  }
  return { total, byChannel, byMarketplace, bySku }
}

export async function computeProfitReport(
  filters: InsightsFilters,
): Promise<ProfitReport> {
  const current = resolveWindowRange(filters)
  const compare = resolveCompareRange(filters, current)

  const [currentItems, compareItems, adSpend, adSpendPrev, refunds, refundsPrev] =
    await Promise.all([
      loadOrderItems(current.from, current.to, filters),
      compare ? loadOrderItems(compare.from, compare.to, filters) : Promise.resolve([]),
      loadAdSpend(current.from, current.to, filters),
      compare ? loadAdSpend(compare.from, compare.to, filters) : Promise.resolve(0),
      loadRefunds(current.from, current.to, filters),
      compare ? loadRefunds(compare.from, compare.to, filters) : Promise.resolve(0),
    ])

  const currentAgg = aggregate(currentItems)
  const compareAgg = aggregate(compareItems)

  const grossCurrent = currentAgg.total.revenue - currentAgg.total.cogs
  const netCurrent =
    grossCurrent - currentAgg.total.fees - adSpend - refunds
  const grossPrev = compareAgg.total.revenue - compareAgg.total.cogs
  const netPrev = grossPrev - compareAgg.total.fees - adSpendPrev - refundsPrev

  const marginCurrent =
    currentAgg.total.revenue > 0
      ? (netCurrent / currentAgg.total.revenue) * 100
      : null
  const marginPrev =
    compareAgg.total.revenue > 0
      ? (netPrev / compareAgg.total.revenue) * 100
      : null

  const byChannel: ProfitBreakdownEntry[] = [...currentAgg.byChannel.entries()].map(
    ([ch, slot]) => {
      const gross = slot.revenue - slot.cogs
      const net = gross - slot.fees
      return {
        key: ch,
        label: CHANNEL_LABELS[ch] ?? ch,
        revenue: Math.round(slot.revenue),
        cogs: Math.round(slot.cogs),
        fees: Math.round(slot.fees),
        refunds: 0,
        grossProfit: Math.round(gross),
        netProfit: Math.round(net),
        marginPct: slot.revenue > 0 ? (net / slot.revenue) * 100 : null,
        unitsSold: slot.units,
      }
    },
  )

  const bySku: ProfitSkuRow[] = [...currentAgg.bySku.entries()]
    .map(([sku, slot]) => {
      const gross = slot.revenue - slot.cogs - slot.fees
      return {
        sku,
        productName: slot.productName,
        brand: slot.brand,
        revenue: Math.round(slot.revenue),
        cogs: Math.round(slot.cogs),
        fees: Math.round(slot.fees),
        grossProfit: Math.round(gross),
        marginPct: slot.revenue > 0 ? (gross / slot.revenue) * 100 : null,
        unitsSold: slot.units,
      }
    })
    .sort((a, b) => b.grossProfit - a.grossProfit)

  const lossMakers = bySku
    .filter((r) => r.grossProfit < 0)
    .sort((a, b) => a.grossProfit - b.grossProfit)
    .slice(0, 20)

  const waterfall: WaterfallStep[] = [
    {
      key: 'revenue',
      label: 'Revenue',
      value: Math.round(currentAgg.total.revenue),
      kind: 'start',
    },
    {
      key: 'cogs',
      label: 'COGS',
      value: Math.round(currentAgg.total.cogs),
      kind: 'sub',
    },
    {
      key: 'fees',
      label: 'Channel fees',
      value: Math.round(currentAgg.total.fees),
      kind: 'sub',
    },
    {
      key: 'ads',
      label: 'Ad spend',
      value: Math.round(adSpend),
      kind: 'sub',
    },
    {
      key: 'refunds',
      label: 'Refunds',
      value: Math.round(refunds),
      kind: 'sub',
    },
    {
      key: 'net',
      label: 'Net profit',
      value: Math.round(netCurrent),
      kind: 'total',
    },
  ]

  const currency = 'EUR'

  return {
    window: { from: current.from.toISOString(), to: current.to.toISOString() },
    compare: compare
      ? { from: compare.from.toISOString(), to: compare.to.toISOString() }
      : null,
    currency,
    totals: {
      revenue: Math.round(currentAgg.total.revenue),
      cogs: Math.round(currentAgg.total.cogs),
      fees: Math.round(currentAgg.total.fees),
      adSpend: Math.round(adSpend),
      refunds: Math.round(refunds),
      grossProfit: Math.round(grossCurrent),
      netProfit: Math.round(netCurrent),
      marginPct: marginCurrent,
    },
    totalsPrev: {
      revenue: Math.round(compareAgg.total.revenue),
      cogs: Math.round(compareAgg.total.cogs),
      fees: Math.round(compareAgg.total.fees),
      adSpend: Math.round(adSpendPrev),
      refunds: Math.round(refundsPrev),
      grossProfit: Math.round(grossPrev),
      netProfit: Math.round(netPrev),
      marginPct: marginPrev,
    },
    deltas: {
      revenue: deltaPct(currentAgg.total.revenue, compareAgg.total.revenue),
      cogs: deltaPct(currentAgg.total.cogs, compareAgg.total.cogs),
      fees: deltaPct(currentAgg.total.fees, compareAgg.total.fees),
      adSpend: deltaPct(adSpend, adSpendPrev),
      refunds: deltaPct(refunds, refundsPrev),
      grossProfit: deltaPct(grossCurrent, grossPrev),
      netProfit: deltaPct(netCurrent, netPrev),
    },
    waterfall,
    byChannel,
    // I6 — per-(channel, marketplace, currency) P&L. Each row in native
    // currency; no implicit conversion. Sorted by current revenue desc.
    byMarketplace: [...currentAgg.byMarketplace.values()]
      .map((slot) => {
        const gross = slot.revenue - slot.cogs
        const net = gross - slot.fees
        return {
          channel: slot.channel,
          marketplace: slot.marketplace,
          currency: slot.currency,
          revenue: Math.round(slot.revenue * 100) / 100,
          cogs: Math.round(slot.cogs * 100) / 100,
          fees: Math.round(slot.fees * 100) / 100,
          grossProfit: Math.round(gross * 100) / 100,
          netProfit: Math.round(net * 100) / 100,
          marginPct: slot.revenue > 0 ? Math.round((net / slot.revenue) * 10000) / 100 : null,
          unitsSold: slot.units,
        }
      })
      .sort((a, b) => b.revenue - a.revenue),
    bySku: bySku.slice(0, 100),
    lossMakers,
    feeNotes: [
      {
        label: 'Amazon',
        detail: '15% referral + variable FBA (not yet ingested); estimate is conservative',
      },
      { label: 'eBay', detail: '12% final-value fee estimate' },
      { label: 'Shopify', detail: '2.9% + €0.30 per transaction' },
    ],
  }
}

export function profitReportToCsv(report: ProfitReport): string {
  const lines: string[] = []
  lines.push(
    ['section', 'key', 'label', 'revenue', 'cogs', 'fees', 'gross_profit', 'net_profit', 'margin_pct', 'units'].join(','),
  )
  for (const c of report.byChannel) {
    lines.push(
      [
        'channel',
        c.key,
        JSON.stringify(c.label),
        c.revenue,
        c.cogs,
        c.fees,
        c.grossProfit,
        c.netProfit,
        c.marginPct?.toFixed(2) ?? '',
        c.unitsSold,
      ].join(','),
    )
  }
  for (const s of report.bySku) {
    lines.push(
      [
        'sku',
        s.sku,
        JSON.stringify(s.productName ?? ''),
        s.revenue,
        s.cogs,
        s.fees,
        s.grossProfit,
        s.grossProfit,
        s.marginPct?.toFixed(2) ?? '',
        s.unitsSold,
      ].join(','),
    )
  }
  lines.push('')
  lines.push('Totals')
  lines.push(`revenue,${report.totals.revenue}`)
  lines.push(`cogs,${report.totals.cogs}`)
  lines.push(`fees,${report.totals.fees}`)
  lines.push(`ad_spend,${report.totals.adSpend}`)
  lines.push(`refunds,${report.totals.refunds}`)
  lines.push(`gross_profit,${report.totals.grossProfit}`)
  lines.push(`net_profit,${report.totals.netProfit}`)
  lines.push(`margin_pct,${report.totals.marginPct?.toFixed(2) ?? ''}`)
  return lines.join('\n')
}
