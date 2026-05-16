/**
 * PA.1 — Product Analytics service.
 *
 * Aggregates all available signals for a product into a unified intelligence
 * object: sales velocity, inventory health, pricing context, listing quality,
 * and review signals. Powers the per-SKU analytics tab (PA.3) and the
 * portfolio intelligence view (PA.4).
 *
 * Data sources:
 *   - Sales:     DailySalesAggregate (grouped by channel/marketplace)
 *   - Inventory: StockLevel.available (sum)
 *   - Pricing:   ChannelListing + BuyBoxHistory + RepricingDecision
 *   - Quality:   ListingQualitySnapshot (latest per channel, from PA.2)
 *   - Reviews:   ReviewSpike (OPEN count)
 */

import type { PrismaClient } from '@nexus/database'
import { Prisma } from '@prisma/client'

// ── Types ──────────────────────────────────────────────────────────────────

export interface SalesChannel {
  channel: string
  marketplace: string | null
  units: number
  revenue: number
  orders: number
  avgConversionRate: number
  avgBuyBoxPct: number
  avgSessionCount: number
}

export type StockoutRisk = 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN'

export interface ProductAnalytics {
  productId: string
  sku: string
  days: number
  sales: {
    totalUnits: number
    totalRevenue: number
    totalOrders: number
    avgDailyUnits: number
    stockoutDays: number
    byChannel: SalesChannel[]
  }
  inventory: {
    totalAvailable: number
    daysOfInventory: number | null
    stockoutRisk: StockoutRisk
  }
  pricing: {
    currentPrices: Array<{ channel: string; marketplace: string | null; price: number }>
    latestBuyBoxPrices: Array<{ channel: string; marketplace: string | null; buyBoxPrice: number | null }>
    latestRepricingDecision: { newPrice: number; reason: string; applied: boolean } | null
  }
  quality: {
    latestScore: number | null
    latestScoreAt: string | null
    byChannel: Array<{ channel: string; score: number; dimensions: Record<string, number> }>
  }
  reviews: {
    avgRating: number | null
    reviewCount: number
    recentSpikeCount: number
  }
}

export interface TrendPoint {
  day: string        // ISO date string
  units: number
  revenue: number
  sessions: number | null
  conversionRate: number | null
  buyBoxPct: number | null
}

// ── Health score ───────────────────────────────────────────────────────────

export function computeHealthScore(analytics: ProductAnalytics, benchmarkDailyUnits = 5): number {
  const qualityScore = analytics.quality.latestScore ?? 50
  const salesIndex = Math.min(analytics.sales.avgDailyUnits / Math.max(benchmarkDailyUnits, 0.1), 1) * 100
  const stockScore = analytics.inventory.daysOfInventory == null
    ? 50
    : Math.min(analytics.inventory.daysOfInventory / 60, 1) * 100
  return Math.round(qualityScore * 0.4 + salesIndex * 0.4 + stockScore * 0.2)
}

export function stockoutRisk(daysOfInventory: number | null): StockoutRisk {
  if (daysOfInventory == null) return 'UNKNOWN'
  if (daysOfInventory < 14) return 'HIGH'
  if (daysOfInventory < 30) return 'MEDIUM'
  return 'LOW'
}

// ── Main aggregator ────────────────────────────────────────────────────────

export async function getProductAnalytics(
  prisma: PrismaClient,
  productId: string,
  days = 30,
): Promise<ProductAnalytics | null> {
  // Load product (for sku lookup)
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { id: true, sku: true },
  })
  if (!product) return null

  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - days)

  // ── Sales aggregation ────────────────────────────────────────────────────
  // Group by channel+marketplace. Prisma doesn't support groupBy with
  // conditional sums (isStockOut=true count) natively, so we run two queries.
  const [salesRows, stockoutRows] = await Promise.all([
    prisma.dailySalesAggregate.groupBy({
      by: ['channel', 'marketplace'],
      where: { sku: product.sku, day: { gte: cutoff } },
      _sum: { unitsSold: true, grossRevenue: true, ordersCount: true, sessions: true },
      _avg: { conversionRate: true, buyBoxPct: true },
    }),
    prisma.dailySalesAggregate.count({
      where: { sku: product.sku, day: { gte: cutoff }, isStockOut: true },
    }),
  ])

  const byChannel: SalesChannel[] = salesRows.map((r) => ({
    channel: r.channel,
    marketplace: r.marketplace,
    units: r._sum.unitsSold ?? 0,
    revenue: Number(r._sum.grossRevenue ?? 0),
    orders: r._sum.ordersCount ?? 0,
    avgConversionRate: Number(r._avg.conversionRate ?? 0),
    avgBuyBoxPct: Number(r._avg.buyBoxPct ?? 0),
    avgSessionCount: Math.round((r._sum.sessions ?? 0) / days),
  }))

  const totalUnits = byChannel.reduce((s, c) => s + c.units, 0)
  const totalRevenue = byChannel.reduce((s, c) => s + c.revenue, 0)
  const totalOrders = byChannel.reduce((s, c) => s + c.orders, 0)
  const avgDailyUnits = totalUnits / days

  // ── Inventory ────────────────────────────────────────────────────────────
  const stockAgg = await prisma.stockLevel.aggregate({
    where: { productId },
    _sum: { available: true },
  })
  const totalAvailable = stockAgg._sum.available ?? 0
  const daysOfInventory = avgDailyUnits > 0
    ? Math.round(totalAvailable / avgDailyUnits)
    : null

  // ── Pricing ──────────────────────────────────────────────────────────────
  const [listings, latestRepricingRule] = await Promise.all([
    prisma.channelListing.findMany({
      where: { productId },
      select: { channel: true, marketplace: true, price: true, priceOverride: true },
    }),
    prisma.repricingRule.findFirst({
      where: { productId },
      select: { id: true },
      orderBy: { updatedAt: 'desc' },
    }),
  ])

  const currentPrices = listings.map((l) => ({
    channel: l.channel,
    marketplace: l.marketplace,
    price: Number((l.priceOverride ?? l.price) as unknown as Prisma.Decimal),
  }))

  // Latest buy box price per channel (last 7 days)
  const bbCutoff = new Date()
  bbCutoff.setDate(bbCutoff.getDate() - 7)
  const bbHistories = await Promise.all(
    [...new Set(listings.map((l) => `${l.channel}:${l.marketplace ?? ''}`))]
      .map(async (key) => {
        const [channel, marketplace] = key.split(':')
        const obs = await prisma.buyBoxHistory.findFirst({
          where: { productId, channel, marketplace: marketplace || undefined, observedAt: { gte: bbCutoff } },
          orderBy: { observedAt: 'desc' },
          select: { buyBoxPrice: true },
        })
        return { channel, marketplace: marketplace || null, buyBoxPrice: obs ? Number(obs.buyBoxPrice as unknown as Prisma.Decimal) : null }
      }),
  )

  let latestRepricingDecision = null
  if (latestRepricingRule) {
    const dec = await prisma.repricingDecision.findFirst({
      where: { ruleId: latestRepricingRule.id },
      orderBy: { createdAt: 'desc' },
      select: { newPrice: true, reason: true, applied: true },
    })
    if (dec) {
      latestRepricingDecision = {
        newPrice: Number(dec.newPrice as unknown as Prisma.Decimal),
        reason: dec.reason,
        applied: dec.applied,
      }
    }
  }

  // ── Quality ──────────────────────────────────────────────────────────────
  const qualitySnapshots = await prisma.listingQualitySnapshot.findMany({
    where: { productId },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: { channel: true, overallScore: true, dimensions: true, createdAt: true },
  })

  const latestPerChannel = new Map<string, typeof qualitySnapshots[0]>()
  for (const snap of qualitySnapshots) {
    if (!latestPerChannel.has(snap.channel)) latestPerChannel.set(snap.channel, snap)
  }

  const qualityByChannel = [...latestPerChannel.values()].map((s) => ({
    channel: s.channel,
    score: s.overallScore,
    dimensions: s.dimensions as Record<string, number>,
  }))

  const latestSnap = qualitySnapshots[0] ?? null
  const overallQuality = latestSnap
    ? Math.round(qualityByChannel.reduce((s, c) => s + c.score, 0) / qualityByChannel.length)
    : null

  // ── Reviews ──────────────────────────────────────────────────────────────
  const [spikeCount] = await Promise.all([
    prisma.reviewSpike.count({
      where: { productId, status: 'OPEN' },
    }),
  ])

  return {
    productId,
    sku: product.sku,
    days,
    sales: { totalUnits, totalRevenue, totalOrders, avgDailyUnits, stockoutDays: stockoutRows, byChannel },
    inventory: { totalAvailable, daysOfInventory, stockoutRisk: stockoutRisk(daysOfInventory) },
    pricing: { currentPrices, latestBuyBoxPrices: bbHistories, latestRepricingDecision },
    quality: {
      latestScore: overallQuality,
      latestScoreAt: latestSnap?.createdAt.toISOString() ?? null,
      byChannel: qualityByChannel,
    },
    reviews: { avgRating: null, reviewCount: 0, recentSpikeCount: spikeCount },
  }
}

// ── Trend time series ──────────────────────────────────────────────────────

export async function getProductTrend(
  prisma: PrismaClient,
  productId: string,
  days = 30,
): Promise<TrendPoint[]> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { sku: true },
  })
  if (!product) return []

  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - days)

  // Group by day, sum across all channels
  const rows = await prisma.dailySalesAggregate.groupBy({
    by: ['day'],
    where: { sku: product.sku, day: { gte: cutoff } },
    _sum: { unitsSold: true, grossRevenue: true, sessions: true },
    _avg: { conversionRate: true, buyBoxPct: true },
    orderBy: { day: 'asc' },
  })

  return rows.map((r) => ({
    day: r.day.toISOString().slice(0, 10),
    units: r._sum.unitsSold ?? 0,
    revenue: Number(r._sum.grossRevenue ?? 0),
    sessions: r._sum.sessions,
    conversionRate: r._avg.conversionRate ? Number(r._avg.conversionRate) : null,
    buyBoxPct: r._avg.buyBoxPct ? Number(r._avg.buyBoxPct) : null,
  }))
}

// ── Quality history ────────────────────────────────────────────────────────

export async function getQualityHistory(
  prisma: PrismaClient,
  productId: string,
  channel: string,
  days = 90,
): Promise<Array<{ createdAt: string; overallScore: number; dimensions: Record<string, number> }>> {
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - days)

  const snaps = await prisma.listingQualitySnapshot.findMany({
    where: { productId, channel: channel.toUpperCase(), createdAt: { gte: cutoff } },
    orderBy: { createdAt: 'asc' },
    select: { createdAt: true, overallScore: true, dimensions: true },
  })

  return snaps.map((s) => ({
    createdAt: s.createdAt.toISOString(),
    overallScore: s.overallScore,
    dimensions: s.dimensions as Record<string, number>,
  }))
}
