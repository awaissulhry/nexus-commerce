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
import { decimalToCents, centsToMajor } from './money.js'

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
  /** I7 — unit price in integer cents (native currency). */
  priceCents: number
  /** I7 — unit cost in integer cents, or null if not set. */
  costPriceCents: number | null
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
        // DA-RT.7 — exclude CANCELLED. Profit on cancelled orders is
        // 0 (no revenue, no fulfilment cost incurred). Including them
        // inflates orderItem count + skews per-SKU averages. The
        // marketing dashboard tile uses "Amazon Sales" semantic which
        // includes cancelled — that's deliberate parity with Seller
        // Central's UI; profit math here uses the realized-revenue
        // semantic instead.
        status: { notIn: ['CANCELLED'] as any },
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
      priceCents: decimalToCents(it.price),
      costPriceCents:
        it.product?.costPrice == null
          ? null
          : decimalToCents(it.product.costPrice),
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
  /** I7 — all money fields in integer cents. Convert with centsToMajor()
   *  only at the response boundary. */
  revenueCents: number
  cogsCents: number
  feesCents: number
  units: number
  orders: Set<string>
}

function emptyAcc(): Acc {
  return { revenueCents: 0, cogsCents: 0, feesCents: 0, units: 0, orders: new Set() }
}

/** I7 — fees computed in cents. pct math is exact when applied to integer
 *  cents and rounded at the end. */
function computeFeeCents(channel: string, revenueCents: number, orders: number): number {
  const pct = CHANNEL_FEE_PCT[channel] ?? 0.1
  const fixedCents = CHANNEL_FEE_FIXED_CENTS[channel] ?? 0
  return Math.round(revenueCents * pct) + fixedCents * orders
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
    // I7 — all line math in integer cents. priceCents × quantity stays
    // exact (both are integers); cogsCents likewise. No float drift.
    const lineCents = it.priceCents * it.quantity
    const cogsLineCents = (it.costPriceCents ?? 0) * it.quantity
    total.revenueCents += lineCents
    total.cogsCents += cogsLineCents
    total.units += it.quantity
    total.orders.add(it.orderId)

    const chSlot = byChannel.get(it.channel) ?? emptyAcc()
    chSlot.revenueCents += lineCents
    chSlot.cogsCents += cogsLineCents
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
    mkSlot.revenueCents += lineCents
    mkSlot.cogsCents += cogsLineCents
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
    skuSlot.revenueCents += lineCents
    skuSlot.cogsCents += cogsLineCents
    skuSlot.units += it.quantity
    skuSlot.orders.add(it.orderId)
    bySku.set(it.sku, skuSlot)
  }

  for (const [ch, slot] of byChannel.entries()) {
    slot.feesCents = computeFeeCents(ch, slot.revenueCents, slot.orders.size)
  }
  for (const [, slot] of byMarketplace.entries()) {
    slot.feesCents = computeFeeCents(slot.channel, slot.revenueCents, slot.orders.size)
  }
  total.feesCents = [...byChannel.values()].reduce((s, a) => s + a.feesCents, 0)
  for (const [, slot] of bySku.entries()) {
    slot.feesCents = computeFeeCents(slot.channel, slot.revenueCents, slot.orders.size)
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

  // I7 — convert ad-spend + refunds (loaded as major units from micros÷1e6
  // and refundCents÷100) into cents once, do all arithmetic in cents, then
  // convert at the response boundary. Eliminates the float drift that used
  // to compound across thousands of order lines.
  const adSpendCents = Math.round(adSpend * 100)
  const refundsCents = Math.round(refunds * 100)
  const adSpendPrevCents = Math.round(adSpendPrev * 100)
  const refundsPrevCents = Math.round(refundsPrev * 100)

  const grossCurrentCents = currentAgg.total.revenueCents - currentAgg.total.cogsCents
  const netCurrentCents =
    grossCurrentCents - currentAgg.total.feesCents - adSpendCents - refundsCents
  const grossPrevCents = compareAgg.total.revenueCents - compareAgg.total.cogsCents
  const netPrevCents =
    grossPrevCents - compareAgg.total.feesCents - adSpendPrevCents - refundsPrevCents

  const marginCurrent =
    currentAgg.total.revenueCents > 0
      ? (netCurrentCents / currentAgg.total.revenueCents) * 100
      : null
  const marginPrev =
    compareAgg.total.revenueCents > 0
      ? (netPrevCents / compareAgg.total.revenueCents) * 100
      : null

  const byChannel: ProfitBreakdownEntry[] = [...currentAgg.byChannel.entries()].map(
    ([ch, slot]) => {
      const grossCents = slot.revenueCents - slot.cogsCents
      const netCents = grossCents - slot.feesCents
      return {
        key: ch,
        label: CHANNEL_LABELS[ch] ?? ch,
        revenue: centsToMajor(slot.revenueCents),
        cogs: centsToMajor(slot.cogsCents),
        fees: centsToMajor(slot.feesCents),
        refunds: 0,
        grossProfit: centsToMajor(grossCents),
        netProfit: centsToMajor(netCents),
        marginPct: slot.revenueCents > 0 ? (netCents / slot.revenueCents) * 100 : null,
        unitsSold: slot.units,
      }
    },
  )

  const bySku: ProfitSkuRow[] = [...currentAgg.bySku.entries()]
    .map(([sku, slot]) => {
      const grossCents = slot.revenueCents - slot.cogsCents - slot.feesCents
      return {
        sku,
        productName: slot.productName,
        brand: slot.brand,
        revenue: centsToMajor(slot.revenueCents),
        cogs: centsToMajor(slot.cogsCents),
        fees: centsToMajor(slot.feesCents),
        grossProfit: centsToMajor(grossCents),
        marginPct: slot.revenueCents > 0 ? (grossCents / slot.revenueCents) * 100 : null,
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
      value: centsToMajor(currentAgg.total.revenueCents),
      kind: 'start',
    },
    {
      key: 'cogs',
      label: 'COGS',
      value: centsToMajor(currentAgg.total.cogsCents),
      kind: 'sub',
    },
    {
      key: 'fees',
      label: 'Channel fees',
      value: centsToMajor(currentAgg.total.feesCents),
      kind: 'sub',
    },
    {
      key: 'ads',
      label: 'Ad spend',
      value: centsToMajor(adSpendCents),
      kind: 'sub',
    },
    {
      key: 'refunds',
      label: 'Refunds',
      value: centsToMajor(refundsCents),
      kind: 'sub',
    },
    {
      key: 'net',
      label: 'Net profit',
      value: centsToMajor(netCurrentCents),
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
      revenue: centsToMajor(currentAgg.total.revenueCents),
      cogs: centsToMajor(currentAgg.total.cogsCents),
      fees: centsToMajor(currentAgg.total.feesCents),
      adSpend: centsToMajor(adSpendCents),
      refunds: centsToMajor(refundsCents),
      grossProfit: centsToMajor(grossCurrentCents),
      netProfit: centsToMajor(netCurrentCents),
      marginPct: marginCurrent,
    },
    totalsPrev: {
      revenue: centsToMajor(compareAgg.total.revenueCents),
      cogs: centsToMajor(compareAgg.total.cogsCents),
      fees: centsToMajor(compareAgg.total.feesCents),
      adSpend: centsToMajor(adSpendPrevCents),
      refunds: centsToMajor(refundsPrevCents),
      grossProfit: centsToMajor(grossPrevCents),
      netProfit: centsToMajor(netPrevCents),
      marginPct: marginPrev,
    },
    deltas: {
      revenue: deltaPct(currentAgg.total.revenueCents, compareAgg.total.revenueCents),
      cogs: deltaPct(currentAgg.total.cogsCents, compareAgg.total.cogsCents),
      fees: deltaPct(currentAgg.total.feesCents, compareAgg.total.feesCents),
      adSpend: deltaPct(adSpendCents, adSpendPrevCents),
      refunds: deltaPct(refundsCents, refundsPrevCents),
      grossProfit: deltaPct(grossCurrentCents, grossPrevCents),
      netProfit: deltaPct(netCurrentCents, netPrevCents),
    },
    waterfall,
    byChannel,
    // I6 — per-(channel, marketplace, currency) P&L. Each row in native
    // currency; no implicit conversion. Sorted by current revenue desc.
    // I7 — composed from integer cents; centsToMajor gives exact 2dp.
    byMarketplace: [...currentAgg.byMarketplace.values()]
      .map((slot) => {
        const grossCents = slot.revenueCents - slot.cogsCents
        const netCents = grossCents - slot.feesCents
        return {
          channel: slot.channel,
          marketplace: slot.marketplace,
          currency: slot.currency,
          revenue: centsToMajor(slot.revenueCents),
          cogs: centsToMajor(slot.cogsCents),
          fees: centsToMajor(slot.feesCents),
          grossProfit: centsToMajor(grossCents),
          netProfit: centsToMajor(netCents),
          marginPct:
            slot.revenueCents > 0
              ? Math.round((netCents / slot.revenueCents) * 10000) / 100
              : null,
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
