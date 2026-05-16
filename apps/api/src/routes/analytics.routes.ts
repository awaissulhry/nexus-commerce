/**
 * PA.4 — Portfolio Intelligence API routes.
 *
 *   GET /api/analytics/portfolio — cross-catalog health ranking
 *     Computes health score per product from DailySalesAggregate +
 *     StockLevel + ListingQualitySnapshot. Returns sorted by health
 *     score ascending (worst first) so the "needs attention" view is
 *     immediately actionable.
 *
 *   Query params:
 *     attention=true — filter products with healthScore < 60
 *     channel        — filter sales data to a specific channel
 *     limit          — max rows (default 200, max 500)
 *     format=csv     — stream as CSV instead of JSON
 */

import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'
import { Prisma } from '@prisma/client'
import { computeHealthScore, stockoutRisk } from '../services/product-analytics.service.js'

interface PortfolioRow {
  id: string
  sku: string
  name: string
  brand: string | null
  healthScore: number
  salesIndex: number
  stockScore: number
  qualityScore: number | null
  totalUnits30d: number
  totalRevenue30d: number
  avgDailyUnits: number
  totalAvailable: number
  daysOfInventory: number | null
  stockoutRisk: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN'
  channelCount: number
  actionTags: string[]
}

const analyticsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/analytics/portfolio', async (request, reply) => {
    const {
      attention,
      channel,
      limit = '200',
      format,
    } = request.query as {
      attention?: string
      channel?: string
      limit?: string
      format?: string
    }

    const maxRows = Math.min(parseInt(limit, 10) || 200, 500)
    const days = 30
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - days)

    // ── Load products ──────────────────────────────────────────────────────
    const products = await prisma.product.findMany({
      where: { status: 'ACTIVE', deletedAt: null } as never,
      select: {
        id: true,
        sku: true,
        name: true,
        brand: true,
        channelListings: {
          select: { channel: true },
          where: { status: 'ACTIVE' } as never,
          take: 10,
        },
      },
      take: maxRows,
      orderBy: { updatedAt: 'desc' },
    })

    const productIds = products.map((p) => p.id)
    const skus = products.map((p) => p.sku)

    // ── Load sales aggregates (30d) ──────────────────────────────────────
    const salesWhere: Record<string, unknown> = {
      sku: { in: skus },
      day: { gte: cutoff },
    }
    if (channel) salesWhere.channel = channel.toUpperCase()

    const salesRows = await prisma.dailySalesAggregate.groupBy({
      by: ['sku'],
      where: salesWhere,
      _sum: { unitsSold: true, grossRevenue: true },
    })
    const salesBySku = new Map(
      salesRows.map((r) => [r.sku, { units: r._sum.unitsSold ?? 0, revenue: Number(r._sum.grossRevenue ?? 0) }]),
    )

    // ── Load stock ────────────────────────────────────────────────────────
    const stockRows = await prisma.stockLevel.groupBy({
      by: ['productId'],
      where: { productId: { in: productIds } },
      _sum: { available: true },
    })
    const stockByProduct = new Map(
      stockRows.map((r) => [r.productId, r._sum.available ?? 0]),
    )

    // ── Load latest quality snapshots ─────────────────────────────────────
    const snapshots = await prisma.listingQualitySnapshot.findMany({
      where: { productId: { in: productIds } },
      orderBy: { createdAt: 'desc' },
      select: { productId: true, overallScore: true },
    })
    const qualityByProduct = new Map<string, number>()
    for (const snap of snapshots) {
      if (!qualityByProduct.has(snap.productId)) {
        qualityByProduct.set(snap.productId, snap.overallScore)
      }
    }

    // ── Load ad spend (30d) from AdMetrics if available ──────────────────
    // Join DailySalesAggregate revenue with AdMetrics spend per SKU
    let adSpendBySku = new Map<string, number>()
    try {
      const adRows = await prisma.$queryRaw<Array<{ sku: string; totalSpend: number }>>`
        SELECT am."productSku" AS sku, SUM(am."spendCents") / 100.0 AS "totalSpend"
        FROM "AdMetrics" am
        WHERE am."date" >= ${cutoff}
          AND am."productSku" = ANY(${skus})
        GROUP BY am."productSku"
      `
      adSpendBySku = new Map(adRows.map((r) => [r.sku, Number(r.totalSpend)]))
    } catch {
      // AdMetrics may not exist in all envs — non-fatal
    }

    // ── Compute median daily units (benchmark) ────────────────────────────
    const allDailyUnits = products.map((p) => {
      const s = salesBySku.get(p.sku)
      return s ? s.units / days : 0
    }).filter((u) => u > 0).sort((a, b) => a - b)
    const median = allDailyUnits.length
      ? allDailyUnits[Math.floor(allDailyUnits.length / 2)]
      : 5

    // ── Build portfolio rows ──────────────────────────────────────────────
    const rows: PortfolioRow[] = products.map((p) => {
      const sales = salesBySku.get(p.sku) ?? { units: 0, revenue: 0 }
      const available = stockByProduct.get(p.id) ?? 0
      const qualityScore = qualityByProduct.get(p.id) ?? null
      const avgDailyUnits = sales.units / days
      const doi = avgDailyUnits > 0 ? Math.round(available / avgDailyUnits) : null
      const risk = stockoutRisk(doi)

      const fakeAnalytics = {
        productId: p.id,
        sku: p.sku,
        days,
        sales: { totalUnits: sales.units, totalRevenue: sales.revenue, totalOrders: 0, avgDailyUnits, stockoutDays: 0, byChannel: [] },
        inventory: { totalAvailable: available, daysOfInventory: doi, stockoutRisk: risk },
        pricing: { currentPrices: [], latestBuyBoxPrices: [], latestRepricingDecision: null },
        quality: { latestScore: qualityScore, latestScoreAt: null, byChannel: [] },
        reviews: { avgRating: null, reviewCount: 0, recentSpikeCount: 0 },
      }
      const healthScore = computeHealthScore(fakeAnalytics, median)
      const salesIndex = Math.round(Math.min(avgDailyUnits / Math.max(median, 0.1), 1) * 100)
      const stockScore = doi == null ? 50 : Math.round(Math.min(doi / 60, 1) * 100)

      const actionTags: string[] = []
      if (qualityScore != null && qualityScore < 60) actionTags.push('low_quality')
      if (risk === 'HIGH') actionTags.push('stockout_risk')
      if (sales.units === 0) actionTags.push('no_recent_sales')

      return {
        id: p.id,
        sku: p.sku,
        name: p.name,
        brand: p.brand,
        healthScore,
        salesIndex,
        stockScore,
        qualityScore,
        totalUnits30d: sales.units,
        totalRevenue30d: sales.revenue,
        avgDailyUnits,
        totalAvailable: available,
        daysOfInventory: doi,
        stockoutRisk: risk,
        channelCount: new Set(p.channelListings.map((l) => l.channel)).size,
        actionTags,
      }
    })

    // Sort: worst health first
    rows.sort((a, b) => a.healthScore - b.healthScore)

    // Filter "needs attention"
    const filtered = attention === 'true'
      ? rows.filter((r) => r.healthScore < 60)
      : rows

    // ── ROAS table: join ad spend ──────────────────────────────────────────
    const roasRows = filtered.map((r) => ({
      sku: r.sku,
      revenue30d: r.totalRevenue30d,
      adSpend30d: adSpendBySku.get(r.sku) ?? 0,
      roas: adSpendBySku.get(r.sku)
        ? r.totalRevenue30d / (adSpendBySku.get(r.sku)!)
        : null,
    })).filter((r) => r.adSpend30d > 0)

    // ── CSV export ────────────────────────────────────────────────────────
    if (format === 'csv') {
      const header = 'sku,name,brand,healthScore,qualityScore,units30d,revenue30d,available,daysOnHand,stockoutRisk,actionTags'
      const lines = [
        header,
        ...filtered.map((r) =>
          [
            r.sku,
            `"${r.name.replace(/"/g, '""')}"`,
            r.brand ?? '',
            r.healthScore,
            r.qualityScore ?? '',
            r.totalUnits30d,
            r.totalRevenue30d.toFixed(2),
            r.totalAvailable,
            r.daysOfInventory ?? '',
            r.stockoutRisk,
            r.actionTags.join('|'),
          ].join(','),
        ),
      ]
      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', 'attachment; filename="portfolio.csv"')
        .send(lines.join('\n'))
    }

    return { products: filtered, roasTable: roasRows, total: filtered.length }
  })
}

export default analyticsRoutes
