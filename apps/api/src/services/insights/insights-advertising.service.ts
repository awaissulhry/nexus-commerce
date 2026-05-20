/**
 * IH.4 — advertising deep dive.
 *
 * Sources from `AmazonAdsDailyPerformance` (per-day, per-entity rows
 * across SP/SB/SD/STV) and joins to total orders revenue from the
 * sales report's recipe for TACoS calculation. Returns metrics
 * grouped at four levels: totals, ad-product (SP/SB/SD/STV),
 * marketplace, and top-N campaigns.
 *
 * Currencies: AmazonAdsDailyPerformance.currencyCode is per-row; we
 * sum by currency and report whichever has the largest spend as
 * primary (mirrors the rest of the insights surface). Cross-currency
 * sums would need FX conversion; deferred until IH.8 fiscal builds
 * the conversion plumbing.
 */

import prisma from '../../db.js'
import {
  type InsightsFilters,
  resolveWindowRange,
  resolveCompareRange,
  deltaPct,
} from './index.js'

export interface AdBucket {
  key: string
  label: string
  spend: number
  sales: number
  impressions: number
  clicks: number
  orders: number
  ctr: number | null
  cpc: number | null
  acos: number | null
  roas: number | null
  deltaSpendPct: number | null
}

export interface AdCampaignRow {
  campaignId: string
  campaignName: string | null
  adProduct: string
  marketplace: string
  spend: number
  sales: number
  impressions: number
  clicks: number
  orders: number
  acos: number | null
  roas: number | null
  ctr: number | null
  cpc: number | null
}

export interface AdTrendPoint {
  date: string
  spend: number
  sales: number
  impressions: number
  clicks: number
  acos: number | null
}

export interface AdReport {
  window: { from: string; to: string }
  compare: { from: string; to: string } | null
  currency: string
  totals: {
    spend: number
    sales: number
    impressions: number
    clicks: number
    orders: number
    ctr: number | null
    cpc: number | null
    acos: number | null
    roas: number | null
    tacos: number | null
    ntbOrders: number
  }
  totalsPrev: {
    spend: number
    sales: number
    impressions: number
    clicks: number
    orders: number
    acos: number | null
    roas: number | null
  }
  deltas: {
    spend: number | null
    sales: number | null
    impressions: number | null
    clicks: number | null
    orders: number | null
  }
  trend: AdTrendPoint[]
  byAdProduct: AdBucket[]
  byMarketplace: AdBucket[]
  topCampaigns: AdCampaignRow[]
}

const AD_PRODUCT_LABELS: Record<string, string> = {
  SPONSORED_PRODUCTS: 'Sponsored Products',
  SPONSORED_BRANDS: 'Sponsored Brands',
  SPONSORED_DISPLAY: 'Sponsored Display',
  SPONSORED_TELEVISION: 'Sponsored TV',
}

function dayKey(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Rome',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d)
}

function ratio(num: number, den: number): number | null {
  if (den === 0) return null
  return num / den
}

async function loadAdRows(
  from: Date,
  to: Date,
  filters: InsightsFilters,
): Promise<
  Array<{
    date: Date
    profileId: string
    marketplace: string
    adProduct: string
    entityType: string
    entityId: string
    localEntityId: string | null
    impressions: number
    clicks: number
    costMicros: bigint
    sales7dCents: number | null
    orders7d: number | null
    ntbOrders14d: number | null
    currencyCode: string
  }>
> {
  if (filters.channels.length > 0 && !filters.channels.includes('AMAZON')) {
    return []
  }
  return prisma.amazonAdsDailyPerformance.findMany({
    where: {
      date: { gte: from, lt: to },
      ...(filters.markets.length > 0
        ? { marketplace: { in: filters.markets } }
        : {}),
    },
    select: {
      date: true,
      profileId: true,
      marketplace: true,
      adProduct: true,
      entityType: true,
      entityId: true,
      localEntityId: true,
      impressions: true,
      clicks: true,
      costMicros: true,
      sales7dCents: true,
      orders7d: true,
      ntbOrders14d: true,
      currencyCode: true,
    },
    take: 500_000,
  })
}

async function loadTotalRevenue(
  from: Date,
  to: Date,
  filters: InsightsFilters,
): Promise<number> {
  const whereMarket =
    filters.markets.length > 0 ? { in: filters.markets } : undefined
  const orders = await prisma.order.findMany({
    where: {
      createdAt: { gte: from, lt: to },
      deletedAt: null,
      channel: 'AMAZON',
      ...(whereMarket ? { marketplace: whereMarket } : {}),
    },
    select: { totalPrice: true },
    take: 100_000,
  })
  return orders.reduce((s, o) => s + Number(o.totalPrice ?? 0), 0)
}

interface Slot {
  spend: number
  sales: number
  impressions: number
  clicks: number
  orders: number
}

function emptySlot(): Slot {
  return { spend: 0, sales: 0, impressions: 0, clicks: 0, orders: 0 }
}

function aggregate(rows: Awaited<ReturnType<typeof loadAdRows>>): {
  total: Slot & { ntbOrders: number }
  byDay: Map<string, Slot>
  byAdProduct: Map<string, Slot>
  byMarketplace: Map<string, Slot>
  byCampaign: Map<
    string,
    Slot & { campaignId: string; adProduct: string; marketplace: string }
  >
  primaryCurrency: string
} {
  const total: Slot & { ntbOrders: number } = { ...emptySlot(), ntbOrders: 0 }
  const byDay = new Map<string, Slot>()
  const byAdProduct = new Map<string, Slot>()
  const byMarketplace = new Map<string, Slot>()
  const byCampaign = new Map<
    string,
    Slot & { campaignId: string; adProduct: string; marketplace: string }
  >()
  const byCurrency = new Map<string, number>()

  for (const r of rows) {
    const spend = Number(r.costMicros) / 1_000_000
    const sales = (r.sales7dCents ?? 0) / 100
    const slot = {
      spend,
      sales,
      impressions: r.impressions,
      clicks: r.clicks,
      orders: r.orders7d ?? 0,
    }

    total.spend += spend
    total.sales += sales
    total.impressions += r.impressions
    total.clicks += r.clicks
    total.orders += r.orders7d ?? 0
    total.ntbOrders += r.ntbOrders14d ?? 0

    byCurrency.set(
      r.currencyCode,
      (byCurrency.get(r.currencyCode) ?? 0) + spend,
    )

    const dk = dayKey(r.date)
    const day = byDay.get(dk) ?? emptySlot()
    day.spend += spend
    day.sales += sales
    day.impressions += r.impressions
    day.clicks += r.clicks
    day.orders += r.orders7d ?? 0
    byDay.set(dk, day)

    const ap = byAdProduct.get(r.adProduct) ?? emptySlot()
    ap.spend += spend
    ap.sales += sales
    ap.impressions += r.impressions
    ap.clicks += r.clicks
    ap.orders += r.orders7d ?? 0
    byAdProduct.set(r.adProduct, ap)

    const mk = byMarketplace.get(r.marketplace) ?? emptySlot()
    mk.spend += spend
    mk.sales += sales
    mk.impressions += r.impressions
    mk.clicks += r.clicks
    mk.orders += r.orders7d ?? 0
    byMarketplace.set(r.marketplace, mk)

    if (r.entityType === 'CAMPAIGN' || r.entityType === 'PRODUCT_AD') {
      const campaignId = r.localEntityId ?? r.entityId
      const cmp = byCampaign.get(campaignId) ?? {
        ...emptySlot(),
        campaignId,
        adProduct: r.adProduct,
        marketplace: r.marketplace,
      }
      cmp.spend += spend
      cmp.sales += sales
      cmp.impressions += r.impressions
      cmp.clicks += r.clicks
      cmp.orders += r.orders7d ?? 0
      byCampaign.set(campaignId, cmp)
    }
  }

  let primaryCurrency = 'EUR'
  let primaryAmount = 0
  for (const [c, amt] of byCurrency.entries()) {
    if (amt > primaryAmount) {
      primaryAmount = amt
      primaryCurrency = c
    }
  }

  return { total, byDay, byAdProduct, byMarketplace, byCampaign, primaryCurrency }
}

export async function computeAdvertisingReport(
  filters: InsightsFilters,
): Promise<AdReport> {
  const current = resolveWindowRange(filters)
  const compare = resolveCompareRange(filters, current)

  const [currentRows, compareRows, totalRevenue] = await Promise.all([
    loadAdRows(current.from, current.to, filters),
    compare ? loadAdRows(compare.from, compare.to, filters) : Promise.resolve([]),
    loadTotalRevenue(current.from, current.to, filters),
  ])

  const currentAgg = aggregate(currentRows)
  const compareAgg = aggregate(compareRows)

  const dayMs = 24 * 3600_000
  const days: string[] = []
  for (let t = current.from.getTime(); t < current.to.getTime(); t += dayMs) {
    days.push(dayKey(new Date(t)))
  }
  const trend: AdTrendPoint[] = days.map((d) => {
    const slot = currentAgg.byDay.get(d)
    return {
      date: d,
      spend: Math.round((slot?.spend ?? 0) * 100) / 100,
      sales: Math.round((slot?.sales ?? 0) * 100) / 100,
      impressions: slot?.impressions ?? 0,
      clicks: slot?.clicks ?? 0,
      acos: slot ? ratio(slot.spend, slot.sales)
        ? (slot.spend / slot.sales) * 100
        : null
        : null,
    }
  })

  function bucketsFrom(
    current: Map<string, Slot>,
    previous: Map<string, Slot>,
    labelFor: (k: string) => string,
  ): AdBucket[] {
    return [...current.entries()].map(([k, slot]) => {
      const prev = previous.get(k)?.spend ?? 0
      return {
        key: k,
        label: labelFor(k),
        spend: Math.round(slot.spend * 100) / 100,
        sales: Math.round(slot.sales * 100) / 100,
        impressions: slot.impressions,
        clicks: slot.clicks,
        orders: slot.orders,
        ctr: ratio(slot.clicks, slot.impressions) ?? null,
        cpc: ratio(slot.spend, slot.clicks) ?? null,
        acos: slot.sales > 0 ? (slot.spend / slot.sales) * 100 : null,
        roas: slot.spend > 0 ? slot.sales / slot.spend : null,
        deltaSpendPct: deltaPct(slot.spend, prev),
      }
    })
  }

  const campaignIds = [...currentAgg.byCampaign.keys()]
  const campaigns = await prisma.campaign.findMany({
    where: { id: { in: campaignIds } },
    select: { id: true, name: true },
  })
  const campaignNameMap = new Map(campaigns.map((c) => [c.id, c.name]))

  const topCampaigns: AdCampaignRow[] = [...currentAgg.byCampaign.values()]
    .map((c) => ({
      campaignId: c.campaignId,
      campaignName: campaignNameMap.get(c.campaignId) ?? null,
      adProduct: c.adProduct,
      marketplace: c.marketplace,
      spend: Math.round(c.spend * 100) / 100,
      sales: Math.round(c.sales * 100) / 100,
      impressions: c.impressions,
      clicks: c.clicks,
      orders: c.orders,
      acos: c.sales > 0 ? (c.spend / c.sales) * 100 : null,
      roas: c.spend > 0 ? c.sales / c.spend : null,
      ctr: ratio(c.clicks, c.impressions),
      cpc: ratio(c.spend, c.clicks),
    }))
    .sort((a, b) => b.spend - a.spend)
    .slice(0, 50)

  const acos =
    currentAgg.total.sales > 0
      ? (currentAgg.total.spend / currentAgg.total.sales) * 100
      : null
  const acosPrev =
    compareAgg.total.sales > 0
      ? (compareAgg.total.spend / compareAgg.total.sales) * 100
      : null
  const roas =
    currentAgg.total.spend > 0
      ? currentAgg.total.sales / currentAgg.total.spend
      : null
  const roasPrev =
    compareAgg.total.spend > 0
      ? compareAgg.total.sales / compareAgg.total.spend
      : null
  const tacos =
    totalRevenue > 0 ? (currentAgg.total.spend / totalRevenue) * 100 : null

  return {
    window: { from: current.from.toISOString(), to: current.to.toISOString() },
    compare: compare
      ? { from: compare.from.toISOString(), to: compare.to.toISOString() }
      : null,
    currency: currentAgg.primaryCurrency,
    totals: {
      spend: Math.round(currentAgg.total.spend * 100) / 100,
      sales: Math.round(currentAgg.total.sales * 100) / 100,
      impressions: currentAgg.total.impressions,
      clicks: currentAgg.total.clicks,
      orders: currentAgg.total.orders,
      ctr: ratio(currentAgg.total.clicks, currentAgg.total.impressions),
      cpc: ratio(currentAgg.total.spend, currentAgg.total.clicks),
      acos,
      roas,
      tacos,
      ntbOrders: currentAgg.total.ntbOrders,
    },
    totalsPrev: {
      spend: Math.round(compareAgg.total.spend * 100) / 100,
      sales: Math.round(compareAgg.total.sales * 100) / 100,
      impressions: compareAgg.total.impressions,
      clicks: compareAgg.total.clicks,
      orders: compareAgg.total.orders,
      acos: acosPrev,
      roas: roasPrev,
    },
    deltas: {
      spend: deltaPct(currentAgg.total.spend, compareAgg.total.spend),
      sales: deltaPct(currentAgg.total.sales, compareAgg.total.sales),
      impressions: deltaPct(
        currentAgg.total.impressions,
        compareAgg.total.impressions,
      ),
      clicks: deltaPct(currentAgg.total.clicks, compareAgg.total.clicks),
      orders: deltaPct(currentAgg.total.orders, compareAgg.total.orders),
    },
    trend,
    byAdProduct: bucketsFrom(
      currentAgg.byAdProduct,
      compareAgg.byAdProduct,
      (k) => AD_PRODUCT_LABELS[k] ?? k,
    ),
    byMarketplace: bucketsFrom(
      currentAgg.byMarketplace,
      compareAgg.byMarketplace,
      (k) => k,
    ),
    topCampaigns,
  }
}

export function advertisingReportToCsv(report: AdReport): string {
  const lines: string[] = []
  lines.push(
    [
      'section',
      'key',
      'label',
      'spend',
      'sales',
      'impressions',
      'clicks',
      'orders',
      'ctr_pct',
      'cpc',
      'acos_pct',
      'roas',
    ].join(','),
  )
  function buck(section: string, b: AdBucket) {
    lines.push(
      [
        section,
        b.key,
        JSON.stringify(b.label),
        b.spend,
        b.sales,
        b.impressions,
        b.clicks,
        b.orders,
        b.ctr == null ? '' : (b.ctr * 100).toFixed(2),
        b.cpc?.toFixed(2) ?? '',
        b.acos?.toFixed(2) ?? '',
        b.roas?.toFixed(2) ?? '',
      ].join(','),
    )
  }
  for (const b of report.byAdProduct) buck('adProduct', b)
  for (const b of report.byMarketplace) buck('marketplace', b)
  for (const c of report.topCampaigns) {
    lines.push(
      [
        'campaign',
        c.campaignId,
        JSON.stringify(c.campaignName ?? ''),
        c.spend,
        c.sales,
        c.impressions,
        c.clicks,
        c.orders,
        c.ctr == null ? '' : (c.ctr * 100).toFixed(2),
        c.cpc?.toFixed(2) ?? '',
        c.acos?.toFixed(2) ?? '',
        c.roas?.toFixed(2) ?? '',
      ].join(','),
    )
  }
  return lines.join('\n')
}
