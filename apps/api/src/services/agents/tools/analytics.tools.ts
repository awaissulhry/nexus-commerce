/**
 * ACP.1b — analytics / insight tools (low risk, read-only; + one AI
 * draft). Deferred from ACP.1 because they touch more of the domain;
 * implemented here as thin, self-contained reads in the same style as
 * read.tools.ts (no heavy service coupling), plus draft-alt-text via the
 * shared AI-2 aiDraft helper. They make the copilot — and the autonomous
 * agents that share this registry — meaningfully smarter.
 */

import prisma from '../../../db.js'
import type { AgentTool } from '../tool-types.js'
import { aiDraft } from './draft.tools.js'

const DAY = 86_400_000
const round2 = (n: number) => Math.round(n * 100) / 100

const productAnalytics: AgentTool = {
  name: 'product-analytics',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  description:
    'Units sold, revenue, and order count for a product over a recent window (default 30 days).',
  async handler(args) {
    const id = String(args.productId ?? '')
    if (!id) return { ok: false, error: 'productId is required' }
    const days = Math.min(Math.max(Number(args.days) || 30, 1), 365)
    const since = new Date(Date.now() - days * DAY)
    const p = await prisma.product.findUnique({
      where: { id },
      select: { sku: true, totalStock: true },
    })
    if (!p) return { ok: false, error: 'Product not found' }
    const items = await prisma.orderItem.findMany({
      where: {
        productId: id,
        order: { purchaseDate: { gte: since }, cancelledAt: null },
      },
      select: { quantity: true, price: true, orderId: true },
    })
    const unitsSold = items.reduce((s, i) => s + i.quantity, 0)
    const revenue = items.reduce((s, i) => s + Number(i.price) * i.quantity, 0)
    const orderCount = new Set(items.map((i) => i.orderId)).size
    return {
      ok: true,
      data: {
        sku: p.sku,
        periodDays: days,
        unitsSold,
        revenue: round2(revenue),
        orderCount,
        avgUnitsPerDay: round2(unitsSold / days),
        currentStock: p.totalStock,
      },
    }
  },
}

const channelStockDrift: AgentTool = {
  name: 'channel-stock-drift',
  category: 'fulfillment',
  riskTier: 'low',
  readOnly: true,
  description:
    'Unresolved channel stock drift (channel-reported qty vs local), optionally for one product.',
  async handler(args) {
    const id = args.productId ? String(args.productId) : null
    const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100)
    const rows = await prisma.channelStockEvent.findMany({
      where: {
        status: { in: ['PENDING', 'REVIEW_NEEDED'] },
        ...(id ? { productId: id } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        channel: true,
        sku: true,
        channelReportedQty: true,
        localQtyAtObservation: true,
        drift: true,
        status: true,
        createdAt: true,
      },
    })
    return { ok: true, data: { count: rows.length, drifts: rows } }
  },
}

const replenishmentForecast: AgentTool = {
  name: 'replenishment-forecast',
  category: 'fulfillment',
  riskTier: 'low',
  readOnly: true,
  description:
    'Latest replenishment recommendation for a product: velocity, days of stock left, reorder point/qty, urgency.',
  async handler(args) {
    const id = String(args.productId ?? '')
    if (!id) return { ok: false, error: 'productId is required' }
    const rec = await prisma.replenishmentRecommendation.findFirst({
      where: { productId: id },
      orderBy: { generatedAt: 'desc' },
      select: {
        sku: true,
        velocity: true,
        velocitySource: true,
        leadTimeDays: true,
        effectiveStock: true,
        reorderPoint: true,
        reorderQuantity: true,
        daysOfStockLeft: true,
        urgency: true,
        needsReorder: true,
        generatedAt: true,
      },
    })
    if (!rec)
      return {
        ok: true,
        data: { note: 'no replenishment recommendation generated yet for this product' },
      }
    return { ok: true, data: { ...rec, velocity: Number(rec.velocity) } }
  },
}

const insightsMetric: AgentTool = {
  name: 'insights-metric',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  description:
    'Headline sales metrics over a window (default 30 days): orders, units, revenue by currency, top marketplaces.',
  async handler(args) {
    const days = Math.min(Math.max(Number(args.days) || 30, 1), 365)
    const since = new Date(Date.now() - days * DAY)
    const orders = await prisma.order.findMany({
      where: { purchaseDate: { gte: since }, cancelledAt: null },
      select: { totalPrice: true, currencyCode: true, marketplace: true },
    })
    const revenueByCurrency: Record<string, number> = {}
    const byMarket: Record<string, number> = {}
    for (const o of orders) {
      const c = o.currencyCode || 'EUR'
      revenueByCurrency[c] = (revenueByCurrency[c] ?? 0) + Number(o.totalPrice)
      byMarket[o.marketplace] = (byMarket[o.marketplace] ?? 0) + 1
    }
    for (const k of Object.keys(revenueByCurrency))
      revenueByCurrency[k] = round2(revenueByCurrency[k])
    const units = await prisma.orderItem.aggregate({
      _sum: { quantity: true },
      where: { order: { purchaseDate: { gte: since }, cancelledAt: null } },
    })
    const topMarketplaces = Object.entries(byMarket)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([marketplace, orderCount]) => ({ marketplace, orderCount }))
    return {
      ok: true,
      data: {
        periodDays: days,
        orderCount: orders.length,
        unitsSold: units._sum.quantity ?? 0,
        revenueByCurrency,
        topMarketplaces,
      },
    }
  },
}

const detectAnomalies: AgentTool = {
  name: 'detect-anomalies',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  description:
    'Recently triggered alert/anomaly events (metric, threshold, observed value).',
  async handler(args) {
    const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100)
    const rows = await prisma.alertEvent.findMany({
      where: { status: 'TRIGGERED' },
      orderBy: { triggeredAt: 'desc' },
      take: limit,
      select: {
        value: true,
        status: true,
        triggeredAt: true,
        rule: {
          select: {
            name: true,
            metric: true,
            operator: true,
            threshold: true,
          },
        },
      },
    })
    const anomalies = rows.map((r) => ({
      rule: r.rule?.name ?? '(rule deleted)',
      metric: r.rule?.metric ?? null,
      operator: r.rule?.operator ?? null,
      threshold: r.rule?.threshold ?? null,
      value: r.value,
      triggeredAt: r.triggeredAt,
    }))
    return { ok: true, data: { count: anomalies.length, anomalies } }
  },
}

const draftAltText: AgentTool = {
  name: 'draft-alt-text',
  category: 'products',
  riskTier: 'low',
  readOnly: true,
  description:
    'Draft concise, descriptive image alt-text for a product (suggestion only).',
  async handler(args) {
    const id = String(args.productId ?? '')
    if (!id) return { ok: false, error: 'productId is required' }
    const p = await prisma.product.findUnique({
      where: { id },
      select: { name: true, brand: true, productType: true, keywords: true },
    })
    if (!p) return { ok: false, error: 'Product not found' }
    const out = await aiDraft(
      'alt-text',
      [
        'Write 3 concise, descriptive image alt-text options (max 125 chars each).',
        'Describe what is visibly shown; include brand + product type; no marketing fluff.',
        'Write in the product\'s language. Suggestion only.',
        '',
        JSON.stringify(p),
      ].join('\n'),
      'Product',
      id,
    )
    return { ok: true, data: out }
  },
}

export const ANALYTICS_TOOLS: AgentTool[] = [
  productAnalytics,
  channelStockDrift,
  replenishmentForecast,
  insightsMetric,
  detectAnomalies,
  draftAltText,
]
