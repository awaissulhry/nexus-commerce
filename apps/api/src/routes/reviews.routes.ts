/**
 * SR.1 — Sentient Review Loop routes.
 *
 *   GET  /api/reviews                      ?marketplace, ?category, ?label, ?productId, ?limit
 *   GET  /api/reviews/:id                  drawer w/ sentiment + linked product
 *   GET  /api/reviews/summary              dashboard KPIs (counts by label, top categories)
 *   GET  /api/reviews/spikes               open spike feed
 *   PATCH /api/reviews/spikes/:id          acknowledge / resolve
 *   POST /api/reviews/cron/ingest/trigger          manual trigger
 *   POST /api/reviews/cron/spike-detector/trigger  manual trigger
 */

import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'
import {
  runReviewIngestOnce,
  summarizeReviewIngest,
} from '../services/reviews/review-ingest.service.js'
import {
  runSpikeDetectorOnce,
  summarizeSpikeDetector,
} from '../services/reviews/spike-detector.service.js'
import { seedReviewTemplates } from '../services/reviews/review-templates.js'
import { runReviewRuleEvaluatorOnce } from '../jobs/review-rule-evaluator.job.js'
import { runReviewMailerOnce } from '../jobs/review-request-mailer.job.js'

// SR.3 — register review action handlers (side-effect import)
import '../services/reviews/review-action-handlers.js'

const reviewsRoutes: FastifyPluginAsync = async (fastify) => {
  // ── GET /reviews ────────────────────────────────────────────────────
  fastify.get('/reviews', async (request, reply) => {
    const q = request.query as {
      marketplace?: string
      category?: string
      label?: 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE'
      productId?: string
      sinceDays?: string
      search?: string
      limit?: string
    }
    const where: Record<string, unknown> = {}
    if (q.marketplace) where.marketplace = q.marketplace
    if (q.productId) where.productId = q.productId
    if (q.sinceDays) {
      const d = Number(q.sinceDays)
      if (Number.isFinite(d) && d > 0) {
        where.postedAt = { gte: new Date(Date.now() - d * 24 * 60 * 60 * 1000) }
      }
    }
    if (q.search) {
      where.OR = [
        { title: { contains: q.search, mode: 'insensitive' } },
        { body: { contains: q.search, mode: 'insensitive' } },
      ]
    }
    if (q.label || q.category) {
      where.sentiment = {
        is: {
          ...(q.label ? { label: q.label } : {}),
          ...(q.category ? { categories: { has: q.category } } : {}),
        },
      }
    }
    const limit = Math.min(Number(q.limit) || 100, 500)
    const items = await prisma.review.findMany({
      where,
      orderBy: { postedAt: 'desc' },
      take: limit,
      include: {
        sentiment: true,
        product: { select: { id: true, sku: true, name: true, productType: true } },
      },
    })
    reply.header('Cache-Control', 'private, max-age=30')
    return { items, count: items.length }
  })

  fastify.get('/reviews/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const review = await prisma.review.findUnique({
      where: { id },
      include: {
        sentiment: true,
        product: { select: { id: true, sku: true, name: true, productType: true } },
      },
    })
    if (!review) {
      reply.code(404)
      return { error: 'not_found' }
    }
    return { review }
  })

  // ── GET /reviews/summary ────────────────────────────────────────────
  fastify.get('/reviews/summary', async (request, reply) => {
    const q = request.query as { sinceDays?: string; marketplace?: string }
    const sinceDays = Math.min(Number(q.sinceDays) || 30, 365)
    const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000)
    const baseWhere: Record<string, unknown> = { postedAt: { gte: since } }
    if (q.marketplace) baseWhere.marketplace = q.marketplace

    const byLabel = await prisma.review.findMany({
      where: { ...baseWhere, sentiment: { isNot: null } },
      select: { sentiment: { select: { label: true, categories: true } } },
    })
    const counts: Record<string, number> = { POSITIVE: 0, NEUTRAL: 0, NEGATIVE: 0 }
    const categoryNegatives: Record<string, number> = {}
    let total = 0
    for (const r of byLabel) {
      if (!r.sentiment) continue
      counts[r.sentiment.label] = (counts[r.sentiment.label] ?? 0) + 1
      total += 1
      if (r.sentiment.label === 'NEGATIVE') {
        for (const c of r.sentiment.categories) {
          categoryNegatives[c] = (categoryNegatives[c] ?? 0) + 1
        }
      }
    }
    const topCategories = Object.entries(categoryNegatives)
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)

    const [pendingExtract, openSpikes, totalReviews] = await Promise.all([
      prisma.review.count({
        where: { ...baseWhere, sentiment: { is: null } },
      }),
      prisma.reviewSpike.count({ where: { status: 'OPEN' } }),
      prisma.review.count({ where: baseWhere }),
    ])

    reply.header('Cache-Control', 'private, max-age=60')
    return {
      sinceDays,
      marketplace: q.marketplace ?? null,
      totalReviews,
      pendingExtract,
      counts,
      negativePct: total > 0 ? counts.NEGATIVE / total : null,
      topCategories,
      openSpikes,
    }
  })

  // ── GET /reviews/spikes ─────────────────────────────────────────────
  fastify.get('/reviews/spikes', async (request, reply) => {
    const q = request.query as {
      status?: 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED'
      marketplace?: string
      limit?: string
    }
    const where: Record<string, unknown> = {}
    if (q.status) where.status = q.status
    if (q.marketplace) where.marketplace = q.marketplace
    const limit = Math.min(Number(q.limit) || 50, 200)
    const items = await prisma.reviewSpike.findMany({
      where,
      orderBy: { detectedAt: 'desc' },
      take: limit,
      include: {
        product: { select: { id: true, sku: true, name: true } },
      },
    })
    reply.header('Cache-Control', 'private, max-age=15')
    return { items, count: items.length }
  })

  fastify.patch('/reviews/spikes/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = request.body as {
      status?: 'ACKNOWLEDGED' | 'RESOLVED'
      actor?: string
    }
    const existing = await prisma.reviewSpike.findUnique({ where: { id } })
    if (!existing) {
      reply.code(404)
      return { error: 'not_found' }
    }
    const data: Record<string, unknown> = {}
    if (body.status === 'ACKNOWLEDGED') {
      data.status = 'ACKNOWLEDGED'
      data.acknowledgedAt = new Date()
      data.acknowledgedBy = body.actor ?? 'user:anonymous'
    } else if (body.status === 'RESOLVED') {
      data.status = 'RESOLVED'
      data.resolvedAt = new Date()
    }
    const spike = await prisma.reviewSpike.update({ where: { id }, data })
    return { spike }
  })

  // ── GET /reviews/heatmap (SR.2) ─────────────────────────────────────
  // Day × category cube. Each cell carries total + per-label counts so
  // the UI can render either "volume" or "negative rate" without a
  // second round-trip.
  fastify.get('/reviews/heatmap', async (request, reply) => {
    const q = request.query as { sinceDays?: string; marketplace?: string }
    const sinceDays = Math.min(Math.max(Number(q.sinceDays) || 30, 7), 90)
    const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000)
    const where: Record<string, unknown> = { date: { gte: since } }
    if (q.marketplace) where.marketplace = q.marketplace

    // ReviewCategoryRate is already day-aggregated; sum across products
    // to get the cube the UI needs.
    const rows = await prisma.reviewCategoryRate.findMany({
      where,
      orderBy: [{ date: 'asc' }, { category: 'asc' }],
      select: {
        category: true,
        date: true,
        total: true,
        positive: true,
        neutral: true,
        negative: true,
      },
    })

    // Aggregate per (date × category) — sum across product rows.
    const cellMap = new Map<
      string,
      { date: string; category: string; total: number; positive: number; neutral: number; negative: number }
    >()
    for (const r of rows) {
      const day = r.date.toISOString().slice(0, 10)
      const key = `${day}::${r.category}`
      const cell = cellMap.get(key) ?? {
        date: day,
        category: r.category,
        total: 0,
        positive: 0,
        neutral: 0,
        negative: 0,
      }
      cell.total += r.total
      cell.positive += r.positive
      cell.neutral += r.neutral
      cell.negative += r.negative
      cellMap.set(key, cell)
    }
    const cells = Array.from(cellMap.values())
    const dates: string[] = []
    {
      const d = new Date(since)
      const end = new Date()
      while (d <= end) {
        dates.push(d.toISOString().slice(0, 10))
        d.setUTCDate(d.getUTCDate() + 1)
      }
    }
    const categories = Array.from(new Set(cells.map((c) => c.category))).sort()
    reply.header('Cache-Control', 'private, max-age=120')
    return { dates, categories, cells, sinceDays, marketplace: q.marketplace ?? null }
  })

  // ── GET /reviews/by-product (SR.2) ──────────────────────────────────
  fastify.get('/reviews/by-product', async (request, reply) => {
    const q = request.query as {
      marketplace?: string
      sinceDays?: string
      sort?: 'negativePct' | 'totalReviews' | 'lastReview'
      limit?: string
    }
    const sinceDays = Math.min(Math.max(Number(q.sinceDays) || 30, 1), 365)
    const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000)

    const where: Record<string, unknown> = {
      productId: { not: null },
      postedAt: { gte: since },
    }
    if (q.marketplace) where.marketplace = q.marketplace

    const reviews = await prisma.review.findMany({
      where,
      select: {
        productId: true,
        marketplace: true,
        postedAt: true,
        sentiment: { select: { label: true, categories: true } },
      },
    })

    interface Bucket {
      productId: string
      marketplaces: Set<string>
      total: number
      positive: number
      neutral: number
      negative: number
      categoryNegatives: Record<string, number>
      lastReviewAt: Date | null
    }
    const buckets = new Map<string, Bucket>()
    for (const r of reviews) {
      if (!r.productId) continue
      const b = buckets.get(r.productId) ?? {
        productId: r.productId,
        marketplaces: new Set<string>(),
        total: 0,
        positive: 0,
        neutral: 0,
        negative: 0,
        categoryNegatives: {},
        lastReviewAt: null,
      }
      b.total += 1
      if (r.marketplace) b.marketplaces.add(r.marketplace)
      if (r.sentiment?.label === 'POSITIVE') b.positive += 1
      else if (r.sentiment?.label === 'NEGATIVE') {
        b.negative += 1
        for (const c of r.sentiment.categories) {
          b.categoryNegatives[c] = (b.categoryNegatives[c] ?? 0) + 1
        }
      } else b.neutral += 1
      if (!b.lastReviewAt || r.postedAt > b.lastReviewAt) b.lastReviewAt = r.postedAt
      buckets.set(r.productId, b)
    }

    const productIds = Array.from(buckets.keys())
    const products = await prisma.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, sku: true, name: true, productType: true },
    })
    const productById = new Map(products.map((p) => [p.id, p]))

    let items = Array.from(buckets.values()).map((b) => {
      const negativePct = b.total > 0 ? b.negative / b.total : 0
      const topCategories = Object.entries(b.categoryNegatives)
        .map(([category, count]) => ({ category, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 3)
      const product = productById.get(b.productId) ?? null
      return {
        productId: b.productId,
        product,
        marketplaces: Array.from(b.marketplaces).sort(),
        total: b.total,
        positive: b.positive,
        neutral: b.neutral,
        negative: b.negative,
        negativePct,
        topCategories,
        lastReviewAt: b.lastReviewAt?.toISOString() ?? null,
      }
    })

    const sortKey = q.sort ?? 'negativePct'
    items = items.sort((a, b) => {
      if (sortKey === 'totalReviews') return b.total - a.total
      if (sortKey === 'lastReview') {
        if (!a.lastReviewAt && !b.lastReviewAt) return 0
        if (!a.lastReviewAt) return 1
        if (!b.lastReviewAt) return -1
        return new Date(b.lastReviewAt).getTime() - new Date(a.lastReviewAt).getTime()
      }
      // default: negativePct desc, tiebreak total desc
      if (b.negativePct === a.negativePct) return b.total - a.total
      return b.negativePct - a.negativePct
    })
    const limit = Math.min(Number(q.limit) || 100, 500)
    items = items.slice(0, limit)

    reply.header('Cache-Control', 'private, max-age=120')
    return { items, count: items.length, sinceDays, marketplace: q.marketplace ?? null }
  })

  // ── GET /reviews/products/:productId/timeline (SR.2) ────────────────
  fastify.get('/reviews/products/:productId/timeline', async (request, reply) => {
    const { productId } = request.params as { productId: string }
    const q = request.query as { sinceDays?: string; marketplace?: string }
    const sinceDays = Math.min(Math.max(Number(q.sinceDays) || 90, 7), 365)
    const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000)
    const where: Record<string, unknown> = { productId, date: { gte: since } }
    if (q.marketplace) where.marketplace = q.marketplace

    const rates = await prisma.reviewCategoryRate.findMany({
      where,
      orderBy: { date: 'asc' },
    })
    // Per-day rollup across categories.
    const dayMap = new Map<
      string,
      { date: string; total: number; positive: number; neutral: number; negative: number }
    >()
    for (const r of rates) {
      const day = r.date.toISOString().slice(0, 10)
      const cell = dayMap.get(day) ?? {
        date: day,
        total: 0,
        positive: 0,
        neutral: 0,
        negative: 0,
      }
      cell.total += r.total
      cell.positive += r.positive
      cell.neutral += r.neutral
      cell.negative += r.negative
      dayMap.set(day, cell)
    }

    // Per-category 30d totals.
    const catMap = new Map<
      string,
      { category: string; total: number; positive: number; neutral: number; negative: number }
    >()
    const last30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    for (const r of rates) {
      if (r.date < last30) continue
      const cell = catMap.get(r.category) ?? {
        category: r.category,
        total: 0,
        positive: 0,
        neutral: 0,
        negative: 0,
      }
      cell.total += r.total
      cell.positive += r.positive
      cell.neutral += r.neutral
      cell.negative += r.negative
      catMap.set(r.category, cell)
    }

    const recent = await prisma.review.findMany({
      where: { productId, postedAt: { gte: since }, ...(q.marketplace ? { marketplace: q.marketplace } : {}) },
      orderBy: { postedAt: 'desc' },
      take: 30,
      include: { sentiment: true },
    })

    const product = await prisma.product.findUnique({
      where: { id: productId },
      select: { id: true, sku: true, name: true, productType: true },
    })

    reply.header('Cache-Control', 'private, max-age=60')
    return {
      product,
      timeline: Array.from(dayMap.values()).sort((a, b) => a.date.localeCompare(b.date)),
      categories: Array.from(catMap.values()).sort((a, b) => b.negative - a.negative),
      recent,
      sinceDays,
      marketplace: q.marketplace ?? null,
    }
  })

  // ── SR.3 — review-domain automation rules ──────────────────────────
  fastify.get('/reviews/automation-rules', async (request, _reply) => {
    const q = request.query as { limit?: string }
    const limit = Math.min(Number(q.limit) || 100, 500)
    const items = await prisma.automationRule.findMany({
      where: { domain: 'reviews' },
      orderBy: { createdAt: 'desc' },
      take: limit,
    })
    return { items, count: items.length }
  })

  fastify.post('/reviews/automation-rules/seed-templates', async (_request, _reply) => {
    const result = await seedReviewTemplates()
    return { ok: true, ...result }
  })

  // ── Manual cron triggers ────────────────────────────────────────────
  fastify.post('/reviews/cron/ingest/trigger', async (_request, _reply) => {
    const s = await runReviewIngestOnce()
    return { ok: true, summary: summarizeReviewIngest(s), detail: s }
  })

  fastify.post('/reviews/cron/spike-detector/trigger', async (_request, _reply) => {
    const s = await runSpikeDetectorOnce()
    return { ok: true, summary: summarizeSpikeDetector(s), detail: s }
  })

  fastify.post('/reviews/cron/review-rule-evaluator/trigger', async (_request, _reply) => {
    const summary = await runReviewRuleEvaluatorOnce()
    return { ok: true, summary }
  })

  // ── SR.4 — review request mailer endpoints ──────────────────────────
  fastify.post('/reviews/cron/review-request-mailer/trigger', async (_request, _reply) => {
    const result = await runReviewMailerOnce()
    return { ok: true, result }
  })

  fastify.get('/reviews/requests/stats', async (_request, reply) => {
    const [scheduled, sent, failed, skipped] = await Promise.all([
      prisma.reviewRequest.count({ where: { status: 'SCHEDULED' } }),
      prisma.reviewRequest.count({ where: { status: 'SENT' } }),
      prisma.reviewRequest.count({ where: { status: 'FAILED' } }),
      prisma.reviewRequest.count({ where: { status: 'SKIPPED' } }),
    ])
    const due = await prisma.reviewRequest.count({
      where: { status: 'SCHEDULED', scheduledFor: { lte: new Date() } },
    })
    const upcoming = await prisma.reviewRequest.findMany({
      where: { status: 'SCHEDULED', scheduledFor: { gt: new Date() } },
      orderBy: { scheduledFor: 'asc' },
      take: 20,
      include: {
        order: {
          select: {
            channelOrderId: true,
            channel: true,
            marketplace: true,
            customerName: true,
            items: {
              take: 1,
              select: { product: { select: { name: true, productType: true } } },
            },
          },
        },
      },
    })
    reply.header('Cache-Control', 'private, max-age=30')
    return { scheduled, sent, failed, skipped, due, upcoming }
  })
}

export default reviewsRoutes
