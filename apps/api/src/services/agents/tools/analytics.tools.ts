/**
 * ACP.1b — analytics / insight tools (low risk, read-only; + one AI
 * draft). Deferred from ACP.1 because they touch more of the domain;
 * implemented here as thin, self-contained reads in the same style as
 * read.tools.ts (no heavy service coupling), plus draft-alt-text via the
 * shared AI-2 aiDraft helper. They make the copilot — and the autonomous
 * agents that share this registry — meaningfully smarter.
 */

import prisma from '../../../db.js'
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import type { AgentTool } from '../tool-types.js'
import { AI_DRAFT_SURFACES, aiDraft } from './draft.tools.js'
import { isLiveProduct, liveProduct, PRODUCT_NOT_FOUND } from './live-product.js'

const DAY = 86_400_000
const round2 = (n: number) => Math.round(n * 100) / 100

const productAnalytics: AgentTool = {
  name: 'product-analytics',
  title: 'Product sales',
  input: z.object({ productId: z.string().min(1).describe('Nexus product id'), days: z.coerce.number().int().min(1).max(365).optional().describe('window in days (default 30)') }),
  requires: [F.analyticsView],
  restrictedFields: { revenueByCurrency: FIELDS.financialsRevenueView },
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  description:
    'Units sold, revenue by currency, and order count for a product over a recent window (default 30 days). '
    + 'A parent product counts the sales of its variations.',
  async handler(args) {
    const id = String(args.productId ?? '')
    if (!id) return { ok: false, error: 'productId is required' }
    const days = Math.min(Math.max(Number(args.days) || 30, 1), 365)
    const since = new Date(Date.now() - days * DAY)
    const p = await prisma.product.findFirst({
      where: liveProduct(id),
      select: { sku: true, totalStock: true, isParent: true },
    })
    if (!p) return { ok: false, error: 'Product not found' }
    // Orders name the variation sold, never its parent: a parent's sales are its variations' (a variation
    // deleted since still sold what it sold).
    const variations = p.isParent
      ? (await prisma.product.findMany({ where: { parentId: id }, select: { id: true } })).map((child) => child.id)
      : []
    const items = await prisma.orderItem.findMany({
      where: {
        productId: { in: [id, ...variations] },
        order: { purchaseDate: { gte: since }, cancelledAt: null },
      },
      select: { quantity: true, price: true, orderId: true, order: { select: { currencyCode: true } } },
    })
    const unitsSold = items.reduce((s, i) => s + i.quantity, 0)
    // Never one sum across currencies: an Amazon SE sale is SEK, an IT sale EUR.
    const revenueByCurrency: Record<string, number> = {}
    for (const i of items) {
      const c = i.order.currencyCode || 'EUR'
      revenueByCurrency[c] = (revenueByCurrency[c] ?? 0) + Number(i.price) * i.quantity
    }
    for (const c of Object.keys(revenueByCurrency)) revenueByCurrency[c] = round2(revenueByCurrency[c])
    const orderCount = new Set(items.map((i) => i.orderId)).size
    return {
      ok: true,
      data: {
        sku: p.sku,
        periodDays: days,
        ...(p.isParent ? { variationsCounted: variations.length } : {}),
        unitsSold,
        revenueByCurrency,
        orderCount,
        avgUnitsPerDay: round2(unitsSold / days),
        currentStock: p.totalStock,
      },
    }
  },
}

const channelStockDrift: AgentTool = {
  name: 'channel-stock-drift',
  title: 'Channel stock drift',
  input: z.object({
    productId: z.string().min(1).optional().describe('omit for all products'),
    limit: z.coerce.number().int().min(1).max(100).optional().describe('max rows (default 20)'),
  }),
  requires: [F.inventoryView],
  category: 'fulfillment',
  riskTier: 'low',
  readOnly: true,
  description:
    'Unresolved channel stock drift (channel-reported qty vs local), optionally for one product.',
  async handler(args) {
    const id = args.productId ? String(args.productId) : null
    const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100)
    // MCP.12 — a deleted product is not found, and its drift is never a row; a row whose SKU matched no product stays.
    if (id && !(await isLiveProduct(id))) return { ok: false, error: PRODUCT_NOT_FOUND }
    const rows = await prisma.channelStockEvent.findMany({
      where: {
        status: { in: ['PENDING', 'REVIEW_NEEDED'] },
        ...(id ? { productId: id } : { OR: [{ productId: null }, { product: { deletedAt: null } }] }),
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
  title: 'Replenishment forecast',
  input: z.object({ productId: z.string().min(1).describe('Nexus product id') }),
  requires: [F.replenishmentView],
  category: 'fulfillment',
  riskTier: 'low',
  readOnly: true,
  description:
    'Latest replenishment recommendation for a product: velocity, days of stock left, reorder point/qty, urgency.',
  async handler(args) {
    const id = String(args.productId ?? '')
    if (!id) return { ok: false, error: 'productId is required' }
    // MCP.12 — a deleted product is not found; its last recommendation is not read.
    if (!(await isLiveProduct(id))) return { ok: false, error: PRODUCT_NOT_FOUND }
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
  title: 'Sales metrics',
  input: z.object({ days: z.coerce.number().int().min(1).max(365).optional().describe('window in days (default 30)') }),
  requires: [F.insightsView],
  restrictedFields: { revenueByCurrency: FIELDS.financialsRevenueView },
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  description:
    'Headline sales metrics over a window (default 30 days): orders, units, revenue by currency, top marketplaces.',
  async handler(args) {
    const days = Math.min(Math.max(Number(args.days) || 30, 1), 365)
    const since = new Date(Date.now() - days * DAY)
    const inWindow = { purchaseDate: { gte: since }, cancelledAt: null }
    // Summed by the database, not row by row here: a year of orders is never loaded to add it up.
    const [byCurrency, byMarketRows, units] = await Promise.all([
      prisma.order.groupBy({ by: ['currencyCode'], where: inWindow, _sum: { totalPrice: true }, _count: { _all: true } }),
      prisma.order.groupBy({ by: ['marketplace'], where: inWindow, _count: { _all: true } }),
      prisma.orderItem.aggregate({ _sum: { quantity: true }, where: { order: inWindow } }),
    ])
    const revenueByCurrency: Record<string, number> = {}
    let orderCount = 0
    for (const row of byCurrency) {
      const c = row.currencyCode || 'EUR'
      revenueByCurrency[c] = (revenueByCurrency[c] ?? 0) + Number(row._sum.totalPrice ?? 0)
      orderCount += row._count._all
    }
    for (const k of Object.keys(revenueByCurrency))
      revenueByCurrency[k] = round2(revenueByCurrency[k])
    const topMarketplaces = byMarketRows
      .map((row) => ({ marketplace: row.marketplace ?? 'unknown', orderCount: row._count._all }))
      .sort((a, b) => b.orderCount - a.orderCount)
      .slice(0, 6)
    return {
      ok: true,
      data: {
        periodDays: days,
        orderCount,
        unitsSold: units._sum.quantity ?? 0,
        revenueByCurrency,
        topMarketplaces,
      },
    }
  },
}

/** Meta ads step 44 — which signals detect-anomalies answers. */
const ANOMALY_CHANNELS = ['all', 'alerts', 'meta'] as const
const lowerText = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : v)
const ADSPEND = FIELDS.financialsAdspendView

const detectAnomalies: AgentTool = {
  name: 'detect-anomalies',
  title: 'Triggered alerts',
  input: z.object({
    limit: z.coerce.number().int().min(1).max(100).optional().describe('max events (default 20)'),
    // Meta ads step 44 (master IN-102) — the Meta signal, computed from Nexus's daily read.
    channel: z.preprocess(lowerText, z.enum(ANOMALY_CHANNELS)).default('all')
      .describe('all (default): the triggered alerts and, when Meta is connected, the Meta signal; alerts: only the triggered alerts; meta: only the Meta signal'),
    days: z.coerce.number().int().min(1).max(14).optional()
      .describe('Meta: how many recent days to check, ending yesterday in the ad account\'s time zone (default 7); the up to 56 read days before them are the history'),
    connectionId: z.string().trim().min(1).max(64).optional().describe('Meta: the Meta connection (from meta-connection); default: this business\'s one'),
  }),
  requires: [F.insightsView],
  // Meta ads step 44 — the Meta signal's amounts (each day's or days' value and what is usual) sit under these keys.
  restrictedFields: { spendCents: ADSPEND, costPerPurchaseCents: ADSPEND, roas: ADSPEND },
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  description:
    'Recently triggered alert/anomaly events (metric, threshold, observed value). '
    + 'Meta (channel all or meta, with the ads view permission): unusual swings in the business\'s OWN Meta ads numbers, '
    + 'computed by Nexus from its daily read — no Meta call (Meta has no public API for its anomaly signal). Each of the '
    + 'last days (default 7, ending yesterday in the ad account\'s time zone) is compared with the up to 56 read days '
    + 'before them, for spend, click-through rate, cost per purchase and ROAS: a day 2 standard deviations or more away '
    + '(and 20 % or more), and the checked days together moving 25 % or more; each says up or down, worse, better or '
    + 'changed (spend), its severity, and whether Meta can still restate it (the last 28 days: late purchases). A day '
    + 'Nexus did not read is named and left out, never a zero; a metric with too little history says so (notChecked). '
    + 'metaSaid adds what Meta itself pushed in those days (creative fatigue, the ad account\'s status, an object with a '
    + 'problem). Amounts are minor units of the ad account\'s currency; a person without the ad-spend money permission '
    + 'gets the same answer without them. Read only.',
  async handler(args, ctx) {
    const channel = (args.channel ?? 'all') as (typeof ANOMALY_CHANNELS)[number]
    const out: Record<string, unknown> = {}
    if (channel !== 'meta') {
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
      out.count = anomalies.length
      out.anomalies = anomalies
    }
    if (channel !== 'alerts') {
      // Meta numbers are ad data: shown with the ads view permission, as every Meta read tool requires it.
      if (!ctx.can(F.adsView)) {
        if (channel === 'meta') return { ok: false, error: 'The Meta signal reads ad numbers: it needs the ads view permission.' }
        out.meta = { shown: false, sentence: 'The Meta signal is left out: it needs the ads view permission.' }
      } else {
        const { metaAnomalySignal } = await import('../../marketing/meta-ads/anomaly-signal.js')
        const { MetaAdsReadError } = await import('../../marketing/meta-ads/read.service.js')
        try {
          out.meta = await metaAnomalySignal({ connectionId: typeof args.connectionId === 'string' ? args.connectionId : null, days: typeof args.days === 'number' ? args.days : null })
        } catch (err) {
          if (!(err instanceof MetaAdsReadError)) throw err
          if (channel === 'meta') return { ok: false, error: err.message }
          out.meta = { shown: false, sentence: err.message }
        }
      }
    }
    return { ok: true, data: out }
  },
}

const draftAltText: AgentTool = {
  name: 'draft-alt-text',
  title: 'Draft image alt text',
  input: z.object({ productId: z.string().min(1).describe('Nexus product id') }),
  requires: [F.productsView],
  surfaces: AI_DRAFT_SURFACES,
  category: 'products',
  riskTier: 'low',
  readOnly: true,
  description:
    'Draft concise, descriptive image alt-text for a product (suggestion only).',
  async handler(args) {
    const id = String(args.productId ?? '')
    if (!id) return { ok: false, error: 'productId is required' }
    const p = await prisma.product.findFirst({
      where: liveProduct(id),
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
