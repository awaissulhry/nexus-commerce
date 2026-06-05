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
import { logger } from '../utils/logger.js'
import { sendEmail } from '../services/email/transport.js'
import {
  runReviewIngestOnce,
  summarizeReviewIngest,
} from '../services/reviews/review-ingest.service.js'
import {
  runSpikeDetectorOnce,
  summarizeSpikeDetector,
} from '../services/reviews/spike-detector.service.js'
import { seedReviewTemplates } from '../services/reviews/review-templates.js'
import {
  previewReviewImport,
  applyReviewImport,
  type CanonicalField,
} from '../services/reviews/review-import.service.js'
import { draftReviewReply } from '../services/reviews/review-reply.service.js'
import { sendReviewDigestOnce } from '../services/reviews/review-digest.service.js'
import { generateSpotlight, getLatestSpotlight } from '../services/reviews/review-spotlight.service.js'
import { generateActionItemsForSpike } from '../services/reviews/review-actions.service.js'
import { respondToEbayFeedback } from '../services/reviews/adapters/ebay-feedback.adapter.js'
import { sseResponseHeaders } from '../lib/sse.js'
import { publishReviewEvent } from '../services/review-events.service.js'
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
      channel?: string
      triageStatus?: string
      assignee?: string
    }
    const where: Record<string, unknown> = {}
    if (q.marketplace) where.marketplace = q.marketplace
    if (q.channel) where.channel = q.channel
    if (q.productId) where.productId = q.productId
    if (q.assignee) where.assignee = q.assignee
    if (q.triageStatus) {
      // null triageStatus is treated as NEW.
      where.triageStatus =
        q.triageStatus === 'NEW' ? { in: ['NEW', null] } : q.triageStatus
    }
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
        _count: { select: { responses: true } },
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

  // ── GET /reviews/ratings (RX.0) ─────────────────────────────────────
  // Star-rating distribution (1–5) + period average + daily average
  // trend. The one basic analytics surface the SR dashboards lacked —
  // every review tool leads with average rating + a 1–5 histogram.
  fastify.get('/reviews/ratings', async (request, reply) => {
    const q = request.query as { sinceDays?: string; marketplace?: string }
    const sinceDays = Math.min(Math.max(Number(q.sinceDays) || 30, 7), 365)
    const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000)
    const where: Record<string, unknown> = {
      postedAt: { gte: since },
      rating: { not: null },
    }
    if (q.marketplace) where.marketplace = q.marketplace

    const rows = await prisma.review.findMany({
      where,
      select: { rating: true, postedAt: true },
      orderBy: { postedAt: 'asc' },
    })

    const distribution: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
    let sum = 0
    let count = 0
    const dayMap = new Map<string, { sum: number; count: number }>()
    for (const r of rows) {
      if (r.rating == null) continue
      const star = Math.min(5, Math.max(1, Math.round(r.rating)))
      distribution[star] = (distribution[star] ?? 0) + 1
      sum += r.rating
      count += 1
      const day = r.postedAt.toISOString().slice(0, 10)
      const d = dayMap.get(day) ?? { sum: 0, count: 0 }
      d.sum += r.rating
      d.count += 1
      dayMap.set(day, d)
    }
    const trend = Array.from(dayMap.entries())
      .map(([date, v]) => ({ date, avg: v.count > 0 ? v.sum / v.count : null, count: v.count }))
      .sort((a, b) => a.date.localeCompare(b.date))

    reply.header('Cache-Control', 'private, max-age=60')
    return {
      sinceDays,
      marketplace: q.marketplace ?? null,
      average: count > 0 ? sum / count : null,
      count,
      distribution,
      trend,
    }
  })

  // ── GET /reviews/ingest-health (RX.1) ───────────────────────────────
  // Per-channel ingestion provenance: how many reviews per channel, by
  // source (fixture vs real import/API), last ingest + last review date,
  // plus the most-recent review-ingest cron run. Powers the dashboard
  // ingest-health tile so operators can see real data is flowing in.
  fastify.get('/reviews/ingest-health', async (_request, reply) => {
    const CHANNELS = ['AMAZON', 'EBAY', 'SHOPIFY']
    // Counts by (channel, source) — kept free of _max to dodge a known
    // Prisma groupBy circular-type issue; last-dates come from cheap
    // per-channel aggregates below.
    const grouped = await prisma.review.groupBy({
      by: ['channel', 'ingestSource'],
      _count: { _all: true },
    })
    const allChannels = Array.from(new Set([...CHANNELS, ...grouped.map((g) => g.channel)]))
    const [maxByChannel, lastCron] = await Promise.all([
      Promise.all(
        allChannels.map(async (channel) => ({
          channel,
          agg: await prisma.review.aggregate({
            where: { channel },
            _max: { ingestedAt: true, postedAt: true },
          }),
        })),
      ),
      prisma.cronRun.findFirst({
        where: { jobName: 'review-ingest' },
        orderBy: { startedAt: 'desc' },
        select: { startedAt: true, finishedAt: true, status: true, outputSummary: true },
      }),
    ])
    const maxMap = new Map(maxByChannel.map((m) => [m.channel, m.agg._max]))

    const byChannel = allChannels.map((channel) => {
      const rows = grouped.filter((g) => g.channel === channel)
      const total = rows.reduce((a, r) => a + r._count._all, 0)
      const bySource: Record<string, number> = {}
      for (const r of rows) {
        const src = r.ingestSource ?? 'UNKNOWN'
        bySource[src] = (bySource[src] ?? 0) + r._count._all
      }
      // "Live" = anything that isn't fixture/seed data.
      const realCount = Object.entries(bySource)
        .filter(([src]) => src !== 'FIXTURE')
        .reduce((a, [, n]) => a + n, 0)
      const max = maxMap.get(channel)
      return {
        channel,
        total,
        realCount,
        fixtureCount: bySource.FIXTURE ?? 0,
        bySource,
        lastIngestedAt: max?.ingestedAt ?? null,
        lastReviewAt: max?.postedAt ?? null,
        hasRealData: realCount > 0,
        isCanonical: CHANNELS.includes(channel),
      }
    })

    // D.5 — Amazon official Customer Feedback API status (distinct from the
    // feed/import path above). OK once any insight resolves; NEEDS_ROLE when the
    // Brand Analytics role is missing; PENDING when enabled but not yet fetched.
    const [insightsAgg, insightsOk, insightsNeedsRole] = await Promise.all([
      prisma.amazonReviewInsight.aggregate({ _count: { _all: true }, _max: { fetchedAt: true } }),
      prisma.amazonReviewInsight.count({ where: { accessStatus: 'OK' } }),
      prisma.amazonReviewInsight.count({ where: { accessStatus: 'NEEDS_BRAND_ANALYTICS_ROLE' } }),
    ])
    const insightsEnabled = process.env.NEXUS_ENABLE_AMAZON_REVIEW_INSIGHTS === '1'
    const amazonInsights = insightsOk > 0 ? 'OK' : insightsNeedsRole > 0 ? 'NEEDS_ROLE' : insightsAgg._count._all > 0 ? 'ERROR' : insightsEnabled ? 'PENDING' : 'OFF'

    reply.header('Cache-Control', 'private, max-age=30')
    return {
      channels: byChannel,
      lastIngestCron: lastCron,
      config: {
        mode: process.env.NEXUS_REVIEW_INGEST_MODE === 'live' ? 'live' : 'sandbox',
        ebayLiveEnabled: process.env.NEXUS_EBAY_REAL_API === 'true',
        amazonFeedConfigured: Boolean(process.env.NEXUS_AMAZON_REVIEW_FEED_URL),
        amazonInsights,
        lastInsightsSync: insightsAgg._max.fetchedAt ?? null,
      },
      generatedAt: new Date().toISOString(),
    }
  })

  // ── POST /reviews/import/preview (RX.1) ─────────────────────────────
  // Parse a pasted/uploaded CSV/JSON/XLSX, auto-detect the column
  // mapping, validate + dedup-check — without writing anything.
  fastify.post<{
    Body: {
      text?: string
      bytesBase64?: string
      fileKind?: 'csv' | 'json' | 'xlsx'
      channel?: string
      marketplace?: string | null
      columnMapping?: Partial<Record<CanonicalField, string>>
    }
  }>('/reviews/import/preview', async (request, reply) => {
    const b = request.body ?? {}
    if (!b.text && !b.bytesBase64) {
      reply.code(400)
      return { error: 'no_input', message: 'Provide text or bytesBase64.' }
    }
    try {
      const preview = await previewReviewImport({
        text: b.text,
        bytesBase64: b.bytesBase64,
        fileKind: b.fileKind,
        channel: b.channel ?? 'AMAZON',
        marketplace: b.marketplace ?? null,
        columnMapping: b.columnMapping,
      })
      return { ok: true, preview }
    } catch (err) {
      reply.code(400)
      return { error: 'parse_failed', message: err instanceof Error ? err.message : String(err) }
    }
  })

  // ── POST /reviews/import/apply (RX.1) ───────────────────────────────
  // Ingest the validated rows through the shared sentiment pipeline.
  fastify.post<{
    Body: {
      text?: string
      bytesBase64?: string
      fileKind?: 'csv' | 'json' | 'xlsx'
      channel?: string
      marketplace?: string | null
      columnMapping?: Partial<Record<CanonicalField, string>>
      force?: boolean
    }
  }>('/reviews/import/apply', async (request, reply) => {
    const b = request.body ?? {}
    if (!b.text && !b.bytesBase64) {
      reply.code(400)
      return { error: 'no_input', message: 'Provide text or bytesBase64.' }
    }
    try {
      const result = await applyReviewImport({
        text: b.text,
        bytesBase64: b.bytesBase64,
        fileKind: b.fileKind,
        channel: b.channel ?? 'AMAZON',
        marketplace: b.marketplace ?? null,
        columnMapping: b.columnMapping,
        force: b.force,
      })
      return { ok: true, result }
    } catch (err) {
      reply.code(400)
      return { error: 'import_failed', message: err instanceof Error ? err.message : String(err) }
    }
  })

  // ── GET /reviews/events (RX.3) — SSE live stream ────────────────────
  fastify.get('/reviews/events', async (request, reply) => {
    reply.raw.writeHead(200, sseResponseHeaders(request.headers.origin as string | undefined))
    reply.raw.write(`event: ping\ndata: ${JSON.stringify({ ts: Date.now(), connected: true })}\n\n`)

    const { subscribeReviewEvents, replayReviewEventsSince } = await import(
      '../services/review-events.service.js'
    )
    const send = (event: { type: string; ts: number }) => {
      try {
        reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      } catch {
        // connection dead — close handler cleans up
      }
    }

    const sinceRaw = (request.query as { since?: string })?.since
    const sinceMs = sinceRaw ? Number(sinceRaw) : NaN
    if (Number.isFinite(sinceMs) && sinceMs > 0) {
      const replayed = replayReviewEventsSince(sinceMs)
      for (const event of replayed) send(event)
      if (replayed.length > 0) {
        reply.raw.write(
          `event: replay.done\ndata: ${JSON.stringify({ ts: Date.now(), count: replayed.length })}\n\n`,
        )
      }
    }

    const unsubscribe = subscribeReviewEvents(send)
    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(`: heartbeat ${Date.now()}\n\n`)
      } catch {
        // ignore
      }
    }, 25_000)

    request.raw.on('close', () => {
      clearInterval(heartbeat)
      unsubscribe()
    })

    await new Promise(() => {})
  })

  // ── GET /reviews/desk/stats (RX.2) ──────────────────────────────────
  // Triage workqueue counters. null triageStatus counts as NEW.
  fastify.get('/reviews/desk/stats', async (request, reply) => {
    const q = request.query as { channel?: string; marketplace?: string }
    const base: Record<string, unknown> = {}
    if (q.channel) base.channel = q.channel
    if (q.marketplace) base.marketplace = q.marketplace
    const grouped = await prisma.review.groupBy({
      by: ['triageStatus'],
      where: base,
      _count: { _all: true },
    })
    const counts: Record<string, number> = {
      NEW: 0,
      IN_PROGRESS: 0,
      RESPONDED: 0,
      RESOLVED: 0,
      IGNORED: 0,
    }
    for (const g of grouped) {
      const key = g.triageStatus ?? 'NEW'
      counts[key] = (counts[key] ?? 0) + g._count._all
    }
    const open = counts.NEW + counts.IN_PROGRESS
    reply.header('Cache-Control', 'private, max-age=15')
    return { counts, open, total: Object.values(counts).reduce((a, b) => a + b, 0) }
  })

  // ── PATCH /reviews/:id/triage (RX.2) ────────────────────────────────
  fastify.patch<{
    Params: { id: string }
    Body: { status?: string; assignee?: string | null; tags?: string[]; note?: string | null }
  }>('/reviews/:id/triage', async (request, reply) => {
    const { id } = request.params
    const b = request.body ?? {}
    const VALID = ['NEW', 'IN_PROGRESS', 'RESPONDED', 'RESOLVED', 'IGNORED']
    if (b.status && !VALID.includes(b.status)) {
      reply.code(400)
      return { error: 'invalid_status' }
    }
    const existing = await prisma.review.findUnique({ where: { id }, select: { id: true } })
    if (!existing) {
      reply.code(404)
      return { error: 'not_found' }
    }
    const data: Record<string, unknown> = { triageUpdatedAt: new Date() }
    if (b.status !== undefined) data.triageStatus = b.status
    if (b.assignee !== undefined) data.assignee = b.assignee
    if (b.tags !== undefined) data.triageTags = b.tags
    if (b.note !== undefined) data.triageNote = b.note
    const review = await prisma.review.update({ where: { id }, data })
    return { review }
  })

  // ── GET /reviews/:id/responses (RX.2) ───────────────────────────────
  fastify.get<{ Params: { id: string } }>('/reviews/:id/responses', async (request) => {
    const { id } = request.params
    const items = await prisma.reviewResponse.findMany({
      where: { reviewId: id },
      orderBy: { createdAt: 'desc' },
    })
    return { items, count: items.length }
  })

  // ── POST /reviews/:id/reply/draft (RX.2) ────────────────────────────
  // AI-draft a reply and persist it as a DRAFT ReviewResponse.
  fastify.post<{
    Params: { id: string }
    Body: { locale?: 'it' | 'de' | 'fr' | 'es' | 'en'; tone?: string; instructions?: string }
  }>('/reviews/:id/reply/draft', async (request, reply) => {
    const { id } = request.params
    const b = request.body ?? {}
    const review = await prisma.review.findUnique({ where: { id }, select: { id: true, channel: true } })
    if (!review) {
      reply.code(404)
      return { error: 'not_found' }
    }
    try {
      const draft = await draftReviewReply({
        reviewId: id,
        locale: b.locale,
        tone: (b.tone as 'auto' | 'apologetic' | 'appreciative' | 'neutral') ?? 'auto',
        instructions: b.instructions,
      })
      const row = await prisma.reviewResponse.create({
        data: {
          reviewId: id,
          channel: review.channel,
          locale: draft.locale,
          body: draft.text,
          status: 'DRAFT',
          isAiDrafted: draft.usedAi,
          model: draft.model,
        },
      })
      return { ok: true, response: row, usedAi: draft.usedAi, tone: draft.tone }
    } catch (err) {
      reply.code(500)
      return { error: 'draft_failed', message: err instanceof Error ? err.message : String(err) }
    }
  })

  // ── POST /reviews/:id/reply/send (RX.2) ─────────────────────────────
  // eBay → real RespondToFeedback. Amazon/Shopify → no public reply API,
  // so the operator posts manually and this records it (MANUAL) and
  // marks the review RESPONDED.
  fastify.post<{
    Params: { id: string }
    Body: { body?: string; responseId?: string; actor?: string }
  }>('/reviews/:id/reply/send', async (request, reply) => {
    const { id } = request.params
    const b = request.body ?? {}
    const review = await prisma.review.findUnique({
      where: { id },
      select: { id: true, channel: true, externalReviewId: true },
    })
    if (!review) {
      reply.code(404)
      return { error: 'not_found' }
    }
    const text = (b.body ?? '').trim()
    if (!text) {
      reply.code(400)
      return { error: 'empty_body' }
    }

    let code = 'MANUAL'
    let ok = true
    let errorMessage: string | null = null

    if (review.channel === 'EBAY') {
      const res = await respondToEbayFeedback(review.externalReviewId, text)
      ok = res.ok
      code = res.code
      errorMessage = res.error ?? null
    }
    // Amazon/Shopify: no public reply API — stored as MANUAL (operator
    // posts on-platform and confirms here).

    // Upsert the response row.
    const baseData = {
      channel: review.channel,
      body: text,
      status: ok ? 'SENT' : 'FAILED',
      providerResponseCode: code,
      errorMessage,
      sentAt: ok ? new Date() : null,
      createdBy: b.actor ?? 'user:anonymous',
    }
    let row
    if (b.responseId) {
      row = await prisma.reviewResponse.update({ where: { id: b.responseId }, data: baseData })
    } else {
      row = await prisma.reviewResponse.create({ data: { reviewId: id, ...baseData } })
    }

    if (ok) {
      await prisma.review.update({
        where: { id },
        data: { triageStatus: 'RESPONDED', triageUpdatedAt: new Date() },
      })
      publishReviewEvent({
        type: 'review.responded',
        reviewId: id,
        channel: review.channel,
        ts: Date.now(),
      })
    }

    if (!ok) reply.code(502)
    return { ok, response: row, code, error: errorMessage }
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

  // RX.3 — manual digest trigger (also previews the digest payload).
  fastify.post('/reviews/cron/digest/trigger', async (_request, _reply) => {
    const r = await sendReviewDigestOnce()
    return { ok: true, sent: r.sent, skipped: r.skipped, digest: r.digest }
  })

  // ── Review Spotlight (RX.4) ─────────────────────────────────────────
  fastify.get<{
    Querystring: { productId?: string; marketplace?: string }
  }>('/reviews/spotlight', async (request, reply) => {
    const q = request.query ?? {}
    const latest = await getLatestSpotlight({
      productId: q.productId ?? null,
      marketplace: q.marketplace ?? null,
    })
    reply.header('Cache-Control', 'private, max-age=60')
    return { spotlight: latest }
  })

  // ── Review action items (RX.5) — closed SR.3 loop ───────────────────
  fastify.get<{
    Querystring: { status?: string; spikeId?: string; productId?: string; limit?: string }
  }>('/reviews/action-items', async (request, reply) => {
    const q = request.query ?? {}
    const where: Record<string, unknown> = {}
    if (q.status) where.status = q.status
    if (q.spikeId) where.spikeId = q.spikeId
    if (q.productId) where.productId = q.productId
    const items = await prisma.reviewActionItem.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(Number(q.limit) || 100, 300),
    })
    reply.header('Cache-Control', 'private, max-age=15')
    return { items, count: items.length }
  })

  fastify.post<{ Params: { id: string }; Body: { actor?: string } }>(
    '/reviews/spikes/:id/generate-actions',
    async (request, reply) => {
      const { id } = request.params
      try {
        const result = await generateActionItemsForSpike(id, request.body?.actor ?? 'user:anonymous')
        return { ok: true, ...result }
      } catch (err) {
        reply.code(err instanceof Error && err.message === 'spike not found' ? 404 : 500)
        return { error: 'generate_failed', message: err instanceof Error ? err.message : String(err) }
      }
    },
  )

  fastify.patch<{ Params: { id: string }; Body: { status?: string } }>(
    '/reviews/action-items/:id',
    async (request, reply) => {
      const { id } = request.params
      const status = request.body?.status
      if (!status || !['OPEN', 'APPLIED', 'DISMISSED'].includes(status)) {
        reply.code(400)
        return { error: 'invalid_status' }
      }
      const existing = await prisma.reviewActionItem.findUnique({ where: { id }, select: { id: true } })
      if (!existing) {
        reply.code(404)
        return { error: 'not_found' }
      }
      const item = await prisma.reviewActionItem.update({ where: { id }, data: { status } })
      return { ok: true, item }
    },
  )

  fastify.post<{
    Body: { productId?: string | null; marketplace?: string | null; windowDays?: number }
  }>('/reviews/spotlight/generate', async (request, reply) => {
    const b = request.body ?? {}
    try {
      const spotlight = await generateSpotlight({
        productId: b.productId ?? null,
        marketplace: b.marketplace ?? null,
        windowDays: b.windowDays,
      })
      return { ok: true, spotlight }
    } catch (err) {
      reply.code(500)
      return { error: 'generate_failed', message: err instanceof Error ? err.message : String(err) }
    }
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

  // RV.9.6 — End-to-end test mode. Three actions an operator can run
  // from the dashboard without touching real customer state:
  //
  //   action='preview-html'  — render the localized sentiment-check
  //                            email HTML so the operator can eyeball
  //                            it. No send, no DB write.
  //   action='send-test'     — send a real sentiment-check email to
  //                            `recipient` (an operator-controlled
  //                            address) with /r/__test__/* URLs that
  //                            land on the public pages without
  //                            mutating ReviewRequest. Tagged
  //                            'review-test' so it doesn't pollute
  //                            normal logs.
  //   action='dry-tick'      — run the mailer's tick logic over the
  //                            current queue, but with sendEmail()
  //                            replaced by a logging stub. Returns
  //                            the counters that a real tick would
  //                            have produced.
  fastify.post<{
    Body: {
      action: 'preview-html' | 'send-test' | 'dry-tick'
      recipient?: string
      locale?: 'it' | 'de' | 'fr' | 'es' | 'en'
      productName?: string | null
    }
  }>('/reviews/test', async (request, reply) => {
    const body = request.body
    if (!body?.action) return reply.code(400).send({ error: 'action required' })

    const webBase = (process.env.NEXUS_WEB_URL ?? 'https://nexus-commerce-three.vercel.app').replace(/\/$/, '')
    const testBaseUrl = `${webBase}/r/__test__`

    if (body.action === 'preview-html') {
      const { renderSentimentCheckPreview } = await import(
        '../services/reviews/sentiment-check-email.service.js'
      )
      const html = renderSentimentCheckPreview({
        locale: body.locale ?? 'it',
        productName: body.productName ?? null,
      })
      reply.header('content-type', 'text/html; charset=utf-8')
      return reply.send(html)
    }

    if (body.action === 'send-test') {
      if (!body.recipient) return reply.code(400).send({ error: 'recipient required' })
      const { sendSentimentCheckEmail } = await import(
        '../services/reviews/sentiment-check-email.service.js'
      )
      const result = await sendSentimentCheckEmail({
        to: body.recipient,
        customerName: 'Test Operator',
        productName: body.productName ?? 'Casco Xavia Carbon',
        baseUrl: testBaseUrl,
        channelOrderId: 'TEST-' + Date.now().toString(36),
        locale: body.locale ?? 'it',
      })
      return { ok: result.ok, dryRun: result.dryRun, error: result.error, suppressed: result.suppressed }
    }

    if (body.action === 'dry-tick') {
      // Count what a real tick would do without actually doing it.
      // We replicate the mailer's status filter + window logic but stop
      // short of any side effect.
      const now = new Date()
      const dueScheduled = await prisma.reviewRequest.count({
        where: { status: 'SCHEDULED', scheduledFor: { lte: now } },
      })
      const dueRetries = await prisma.reviewRequest.count({
        where: { status: 'FAILED', nextRetryAt: { not: null, lte: now }, attemptCount: { lt: 3 } },
      })
      const mailerState = await prisma.reviewMailerState.findUnique({ where: { id: 'default' } })
      return {
        ok: true,
        wouldProcess: dueScheduled + dueRetries,
        breakdown: { dueScheduled, dueRetries },
        mailerPaused: mailerState?.isPaused ?? false,
        envEnabled: process.env.NEXUS_ENABLE_REVIEW_INGEST === '1',
        outboundEnabled: process.env.NEXUS_ENABLE_OUTBOUND_EMAILS === 'true',
      }
    }

    return reply.code(400).send({ error: 'unknown action' })
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
    // RV.3.3 — surface "retrying" count (FAILED rows scheduled for re-attempt)
    const retrying = await prisma.reviewRequest.count({
      where: { status: 'FAILED', nextRetryAt: { not: null }, attemptCount: { lt: 3 } },
    })
    // RV.6.5 — sentiment-check counts for the diversion funnel.
    const [sentimentPending, sentimentPositive, sentimentNegative] = await Promise.all([
      prisma.reviewSentimentCheck.count({ where: { response: 'NONE', sentimentEmailSentAt: { not: null } } }),
      prisma.reviewSentimentCheck.count({ where: { response: 'POSITIVE' } }),
      prisma.reviewSentimentCheck.count({ where: { response: 'NEGATIVE' } }),
    ])
    // RV.4.2 — include the mailer pause state so the dashboard renders the toggle correctly
    const mailerState = await prisma.reviewMailerState.upsert({
      where: { id: 'default' },
      update: {},
      create: { id: 'default' },
    })

    // RV.9.2 — pipeline health: surface stale/stuck cron rows + age of
    // the most recent successful mailer tick. Used by the dashboard
    // banner to warn the operator when automation has silently broken.
    const watchedCrons = ['review-request-mailer', 'orders-delivered-backfill', 'review-rule-evaluator', 'review-attribution']
    const recentCrons = await prisma.cronRun.findMany({
      where: { jobName: { in: watchedCrons } },
      orderBy: { startedAt: 'desc' },
      take: 30,
      select: { jobName: true, status: true, startedAt: true, finishedAt: true, errorMessage: true },
    })
    type CronSummary = {
      jobName: string
      lastRunAt: Date | null
      lastSuccessAt: Date | null
      lastFailureAt: Date | null
      lastError: string | null
      stuckRunning: boolean
    }
    const summaries: CronSummary[] = watchedCrons.map((name) => {
      const rows = recentCrons.filter((r) => r.jobName === name)
      const lastRun = rows[0] ?? null
      const lastSuccess = rows.find((r) => r.status === 'SUCCESS') ?? null
      const lastFailure = rows.find((r) => r.status === 'FAILED') ?? null
      // Stuck = current run started >2h ago and still RUNNING. The
      // separate orphan-sweeper cron should clean it up within 30 min,
      // but surface it here in the meantime.
      const stuckRunning =
        !!lastRun &&
        lastRun.status === 'RUNNING' &&
        Date.now() - lastRun.startedAt.getTime() > 2 * 60 * 60 * 1000
      return {
        jobName: name,
        lastRunAt: lastRun?.startedAt ?? null,
        lastSuccessAt: lastSuccess?.startedAt ?? null,
        lastFailureAt: lastFailure?.startedAt ?? null,
        lastError: lastFailure?.errorMessage ?? null,
        stuckRunning,
      }
    })
    const mailerSummary = summaries.find((s) => s.jobName === 'review-request-mailer')!
    // Healthy = mailer ran successfully in the last 8h (cron is every
    // 4h, so >8h means it has missed at least one tick).
    const mailerHealthy =
      !!mailerSummary.lastSuccessAt &&
      Date.now() - mailerSummary.lastSuccessAt.getTime() < 8 * 60 * 60 * 1000
    const pipelineHealth = {
      mailerHealthy,
      hasStuckCron: summaries.some((s) => s.stuckRunning),
      crons: summaries,
    }
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
    return {
      scheduled, sent, failed, skipped, due, retrying, upcoming,
      sentiment: {
        pending: sentimentPending,
        positive: sentimentPositive,
        negative: sentimentNegative,
      },
      mailer: {
        isPaused: mailerState.isPaused,
        pausedReason: mailerState.pausedReason,
        pausedAt: mailerState.pausedAt,
        pausedBy: mailerState.pausedBy,
      },
      pipelineHealth,
    }
  })

  // RV.4.2 — pause + resume endpoints for the mailer kill switch.
  fastify.post<{ Body: { reason?: string; pausedBy?: string } }>(
    '/reviews/mailer/pause',
    async (request) => {
      const body = (request.body ?? {}) as { reason?: string; pausedBy?: string }
      const state = await prisma.reviewMailerState.upsert({
        where: { id: 'default' },
        update: {
          isPaused: true,
          pausedReason: body.reason ?? null,
          pausedAt: new Date(),
          pausedBy: body.pausedBy ?? 'default-user',
        },
        create: {
          id: 'default',
          isPaused: true,
          pausedReason: body.reason ?? null,
          pausedAt: new Date(),
          pausedBy: body.pausedBy ?? 'default-user',
        },
      })
      return { ok: true, state }
    },
  )

  fastify.post('/reviews/mailer/resume', async (_request) => {
    const state = await prisma.reviewMailerState.upsert({
      where: { id: 'default' },
      update: {
        isPaused: false,
        pausedReason: null,
        pausedAt: null,
        pausedBy: null,
      },
      create: { id: 'default', isPaused: false },
    })
    return { ok: true, state }
  })

  // RV.9.2 — manual cron-orphan sweep trigger. The cron runs every 30
  // min on its own, but operators can poke it from the health banner.
  fastify.post('/reviews/pipeline/sweep-stuck-crons', async () => {
    const { runCronOrphanSweepOnce } = await import('../jobs/cron-orphan-sweeper.job.js')
    const result = await runCronOrphanSweepOnce()
    return { ok: true, ...result }
  })

  // RV.9.7 — manual review-attribution trigger.
  fastify.post<{ Body: { windowDays?: number; attributionWindowDays?: number; limit?: number } }>(
    '/reviews/attribution/run',
    async (request) => {
      const { runReviewAttributionOnce } = await import('../services/reviews/review-attribution.service.js')
      const result = await runReviewAttributionOnce(request.body ?? {})
      return { ok: true, ...result }
    },
  )

  // RV.9.5 — Public unsubscribe endpoint (no auth — token authenticates
  // intent). Supports GET (the link in the email; renders a confirmation
  // page) and POST (RFC 8058 one-click). Both honor the request
  // immediately by inserting an EmailSuppression row.
  fastify.get<{ Querystring: { token?: string; channel?: string; email?: string } }>(
    '/email/unsubscribe',
    async (request, reply) => {
      const { token, channel, email } = request.query
      // Look up the email: token-derived (preferred) OR querystring fallback.
      const { emailFromUnsubscribeToken, addSuppression } = await import(
        '../services/reviews/email-suppression.service.js'
      )
      let resolvedEmail: string | null = null
      if (email) {
        // Validate token matches the email if both provided.
        const { unsubscribeTokenFor } = await import(
          '../services/reviews/email-suppression.service.js'
        )
        if (token && unsubscribeTokenFor(email) !== token) {
          return reply.code(400).send({ error: 'token / email mismatch' })
        }
        resolvedEmail = email.trim().toLowerCase()
      } else if (token) {
        // Walk recent ReviewSentimentCheck rows + ReviewRequest rows for
        // candidate emails. Caps at 1000 to keep latency bounded.
        const candidates = await prisma.order.findMany({
          where: { customerEmail: { not: null } },
          select: { customerEmail: true },
          orderBy: { createdAt: 'desc' },
          take: 1000,
          distinct: ['customerEmail'],
        })
        const emails = candidates.map((c) => c.customerEmail!).filter(Boolean)
        resolvedEmail = emailFromUnsubscribeToken(token, emails)
      }
      if (!resolvedEmail) {
        return reply.code(400).send({ error: 'invalid or expired unsubscribe link' })
      }
      const ch = channel ?? null
      const ipAddress = request.headers['x-forwarded-for']
        ? String(request.headers['x-forwarded-for']).split(',')[0].trim()
        : request.ip
      await addSuppression({
        email: resolvedEmail,
        channel: ch,
        source: 'UNSUBSCRIBE_LINK',
        ipAddress,
        userAgent: request.headers['user-agent'] ?? null,
      })
      // Redirect the GET to a friendly confirmation page on the web app.
      const webBase = (process.env.NEXUS_WEB_URL ?? 'https://nexus-commerce-three.vercel.app').replace(/\/$/, '')
      reply.code(302).header(
        'location',
        `${webBase}/unsubscribed?channel=${encodeURIComponent(ch ?? 'all')}`,
      )
      return reply.send()
    },
  )

  fastify.post<{ Body: { token?: string; email?: string; channel?: string } }>(
    '/email/unsubscribe',
    async (request) => {
      // RFC 8058 one-click — same logic as GET, returns JSON.
      const body = request.body ?? {}
      const channel = body.channel ?? null
      const { emailFromUnsubscribeToken, addSuppression, unsubscribeTokenFor } = await import(
        '../services/reviews/email-suppression.service.js'
      )
      let resolvedEmail: string | null = null
      if (body.email) {
        if (body.token && unsubscribeTokenFor(body.email) !== body.token) {
          return { ok: false, error: 'token / email mismatch' }
        }
        resolvedEmail = body.email.trim().toLowerCase()
      } else if (body.token) {
        const candidates = await prisma.order.findMany({
          where: { customerEmail: { not: null } },
          select: { customerEmail: true },
          orderBy: { createdAt: 'desc' },
          take: 1000,
          distinct: ['customerEmail'],
        })
        const emails = candidates.map((c) => c.customerEmail!).filter(Boolean)
        resolvedEmail = emailFromUnsubscribeToken(body.token, emails)
      }
      if (!resolvedEmail) return { ok: false, error: 'invalid or expired unsubscribe link' }
      await addSuppression({
        email: resolvedEmail,
        channel,
        source: 'UNSUBSCRIBE_LINK',
      })
      return { ok: true }
    },
  )

  // RV.9.5 — Admin list + manual add/remove for the suppression table.
  fastify.get<{ Querystring: { search?: string } }>(
    '/email/suppressions',
    async (request) => {
      const search = request.query.search?.trim().toLowerCase()
      const rows = await prisma.emailSuppression.findMany({
        where: search ? { email: { contains: search } } : undefined,
        orderBy: { createdAt: 'desc' },
        take: 200,
      })
      return { rows }
    },
  )

  fastify.post<{ Body: { email: string; channel?: string | null; reason?: string } }>(
    '/email/suppressions',
    async (request, reply) => {
      const body = request.body
      if (!body?.email) return reply.code(400).send({ error: 'email required' })
      const { addSuppression } = await import('../services/reviews/email-suppression.service.js')
      const result = await addSuppression({
        email: body.email,
        channel: body.channel ?? null,
        source: 'MANUAL',
        reason: body.reason ?? null,
      })
      return { ok: true, ...result }
    },
  )

  fastify.delete<{ Body: { email: string; channel?: string | null } }>(
    '/email/suppressions',
    async (request, reply) => {
      const body = request.body
      if (!body?.email) return reply.code(400).send({ error: 'email required' })
      const { removeSuppression } = await import('../services/reviews/email-suppression.service.js')
      const result = await removeSuppression({
        email: body.email,
        channel: body.channel ?? null,
      })
      return { ok: true, ...result }
    },
  )

  // RV.4.3 — per-request unsuppress + snooze controls.
  fastify.post<{ Params: { id: string } }>(
    '/review-requests/:id/unsuppress',
    async (request, reply) => {
      try {
        const { id } = request.params
        const updated = await prisma.reviewRequest.update({
          where: { id },
          data: {
            status: 'SCHEDULED',
            scheduledFor: new Date(),
            suppressedReason: null,
            errorMessage: null,
            providerResponseCode: null,
            // Reset attempt counter so the row gets a fresh shot (operator
            // explicitly chose to re-queue — don't penalize prior failures).
            attemptCount: 0,
            lastAttemptAt: null,
            nextRetryAt: null,
          },
        })
        return { ok: true, request: updated }
      } catch (error: any) {
        if (error.code === 'P2025') return reply.code(404).send({ error: 'Request not found' })
        return reply.code(500).send({ error: error.message })
      }
    },
  )

  fastify.post<{ Params: { id: string }; Body: { hours?: number } }>(
    '/review-requests/:id/snooze',
    async (request, reply) => {
      try {
        const { id } = request.params
        const body = (request.body ?? {}) as { hours?: number }
        const hours = Math.min(Math.max(body.hours ?? 24, 1), 24 * 14) // 1h to 14d
        const current = await prisma.reviewRequest.findUnique({ where: { id } })
        if (!current) return reply.code(404).send({ error: 'Request not found' })
        // Snooze pushes scheduledFor forward from now (not from existing
        // scheduledFor, which may already be in the past). Caller intent
        // is "don't try this for the next N hours", regardless of history.
        const newScheduledFor = new Date(Date.now() + hours * 60 * 60 * 1000)
        const updated = await prisma.reviewRequest.update({
          where: { id },
          data: {
            // If currently FAILED → re-queue. If currently SCHEDULED → just defer.
            status: 'SCHEDULED',
            scheduledFor: newScheduledFor,
            // Clear retry state — operator explicitly took control.
            nextRetryAt: null,
          },
        })
        return { ok: true, request: updated, snoozedUntil: newScheduledFor }
      } catch (error: any) {
        if (error.code === 'P2025') return reply.code(404).send({ error: 'Request not found' })
        return reply.code(500).send({ error: error.message })
      }
    },
  )

  // RV.8.1 — Conversion-rate + per-mp + per-productType analytics.
  fastify.get<{ Querystring: { windowDays?: string; attributionWindowDays?: string } }>(
    '/reviews/analytics',
    async (request, reply) => {
      const q = request.query
      const windowDays = q.windowDays ? Math.max(7, Math.min(180, parseInt(q.windowDays, 10))) : 30
      const attributionWindowDays = q.attributionWindowDays
        ? Math.max(7, Math.min(60, parseInt(q.attributionWindowDays, 10)))
        : 21
      const { computeReviewAnalytics } = await import('../services/reviews/review-analytics.service.js')
      try {
        const result = await computeReviewAnalytics({ windowDays, attributionWindowDays })
        reply.header('Cache-Control', 'private, max-age=300')
        return result
      } catch (err: any) {
        return reply.code(500).send({ error: err.message })
      }
    },
  )

  // ────────────────────────────────────────────────────────────────────
  // RV.6.2 — Customer-facing sentiment check landing endpoints.
  //
  // These are public (token = authentication). The token is a 32-char
  // URL-safe cryptographically random string — not the row id, never
  // includes orderId. The frontend pages live at:
  //   /r/[token]/positive
  //   /r/[token]/negative
  //
  // Idempotent: re-clicking the same link after a response returns the
  // existing outcome instead of re-firing.
  // ────────────────────────────────────────────────────────────────────

  // GET — state lookup for the landing page render
  fastify.get<{ Params: { token: string } }>(
    '/r/:token',
    async (request, reply) => {
      const { token } = request.params
      // RV.9.6 — Test-mode short-circuit. The token '__test__' is used
      // by the dashboard's "send-test" action; render demo state.
      if (token === '__test__') {
        return {
          token,
          response: 'NONE',
          respondedAt: null,
          order: { customerName: 'Test Operator', channelOrderId: 'TEST', marketplace: 'IT' },
          testMode: true,
        }
      }
      const check = await prisma.reviewSentimentCheck.findUnique({
        where: { token },
        include: {
          order: { select: { customerName: true, channelOrderId: true, marketplace: true } },
        },
      })
      if (!check) return reply.code(404).send({ error: 'Not found' })
      return {
        token,
        response: check.response,
        respondedAt: check.respondedAt,
        order: {
          customerName: check.order.customerName,
          channelOrderId: check.order.channelOrderId,
          marketplace: check.order.marketplace,
        },
      }
    },
  )

  // POST positive — happy customer; fire downstream Solicitations.
  fastify.post<{ Params: { token: string } }>(
    '/r/:token/positive',
    async (request, reply) => {
      const { token } = request.params
      // RV.9.6 — Test-mode short-circuit: no DB writes, no Solicitations fire.
      if (token === '__test__') {
        return { ok: true, response: 'POSITIVE', testMode: true }
      }
      const ip = (request.headers['x-forwarded-for']?.toString().split(',')[0] ?? request.ip ?? '').slice(0, 64)
      const ua = (request.headers['user-agent'] ?? '').slice(0, 256)

      const check = await prisma.reviewSentimentCheck.findUnique({
        where: { token },
        include: {
          order: { select: { id: true, channel: true, channelOrderId: true, marketplace: true, deliveredAt: true } },
          reviewRequest: true,
        },
      })
      if (!check) return reply.code(404).send({ error: 'Not found' })
      // Idempotent — re-clicks just return the existing response.
      if (check.response !== 'NONE') {
        return { ok: true, response: check.response, alreadyResponded: true }
      }

      await prisma.reviewSentimentCheck.update({
        where: { id: check.id },
        data: {
          response: 'POSITIVE',
          respondedAt: new Date(),
          respondedFromIp: ip,
          respondedFromUserAgent: ua,
        },
      })

      // If the order is Amazon AND we have a linked ReviewRequest AND it's
      // still inside the 4-30d window, fire Solicitations now. Otherwise
      // mark SCHEDULED+now so the next mailer tick handles it.
      if (check.reviewRequest && check.order.channel === 'AMAZON') {
        await prisma.reviewRequest.update({
          where: { id: check.reviewRequest.id },
          data: { status: 'SCHEDULED', scheduledFor: new Date(), suppressedReason: null, errorMessage: null, attemptCount: 0, nextRetryAt: null },
        })
      }
      return { ok: true, response: 'POSITIVE' }
    },
  )

  // POST negative — unhappy customer; capture feedback, route to support.
  fastify.post<{ Params: { token: string }; Body: { feedback?: string; name?: string } }>(
    '/r/:token/negative',
    async (request, reply) => {
      const { token } = request.params
      // RV.9.6 — Test-mode short-circuit: no DB writes, no support email.
      if (token === '__test__') {
        return { ok: true, response: 'NEGATIVE', testMode: true }
      }
      const body = (request.body ?? {}) as { feedback?: string; name?: string }
      const feedback = (body.feedback ?? '').toString().slice(0, 4000)
      const ip = (request.headers['x-forwarded-for']?.toString().split(',')[0] ?? request.ip ?? '').slice(0, 64)
      const ua = (request.headers['user-agent'] ?? '').slice(0, 256)

      const check = await prisma.reviewSentimentCheck.findUnique({
        where: { token },
        include: {
          order: { select: { id: true, channel: true, channelOrderId: true, marketplace: true, customerName: true, customerEmail: true } },
          reviewRequest: true,
        },
      })
      if (!check) return reply.code(404).send({ error: 'Not found' })
      if (check.response !== 'NONE') {
        return { ok: true, response: check.response, alreadyResponded: true }
      }

      await prisma.reviewSentimentCheck.update({
        where: { id: check.id },
        data: {
          response: 'NEGATIVE',
          respondedAt: new Date(),
          respondedFromIp: ip,
          respondedFromUserAgent: ua,
          feedback: feedback || null,
        },
      })

      // Mark the downstream ReviewRequest as SKIPPED with a clear reason —
      // the operator can see in the dashboard why this order was diverted.
      if (check.reviewRequest) {
        await prisma.reviewRequest.update({
          where: { id: check.reviewRequest.id },
          data: {
            status: 'SKIPPED',
            suppressedReason: 'Diverted to support (negative sentiment check)',
            providerResponseCode: 'DIVERTED_NEGATIVE',
            errorMessage: null,
          },
        })
      }

      // Email the support inbox with the order context + customer feedback.
      // Best-effort; failure here doesn't block the response.
      try {
        const supportEmail = process.env.NEXUS_SUPPORT_INBOX ?? 'support@xavia.it'
        const subject = `[Reviews] Negative sentiment — order ${check.order.channelOrderId ?? check.order.id}`
        const html = `
          <h2>Negative sentiment check</h2>
          <p>Customer flagged an issue via the post-purchase review-funnel email.</p>
          <ul>
            <li><b>Order:</b> ${check.order.channelOrderId ?? check.order.id}</li>
            <li><b>Channel:</b> ${check.order.channel} ${check.order.marketplace ? `· ${check.order.marketplace}` : ''}</li>
            <li><b>Customer:</b> ${(check.order.customerName ?? '—').replace(/</g, '&lt;')} &lt;${check.order.customerEmail ?? '—'}&gt;</li>
          </ul>
          <h3>Customer feedback:</h3>
          <blockquote style="border-left:3px solid #ccc;padding-left:12px;color:#444;">
            ${feedback ? feedback.replace(/</g, '&lt;').replace(/\n/g, '<br>') : '<i>(no feedback text — they clicked the negative button without typing)</i>'}
          </blockquote>
          <p>Reach out to resolve <b>before</b> they leave a public review.</p>
        `
        await sendEmail({
          to: supportEmail,
          subject,
          html,
          tag: 'review-diversion-support',
        })
      } catch (err) {
        logger.warn('[review-diversion] failed to email support', {
          orderId: check.order.id,
          error: err instanceof Error ? err.message : String(err),
        })
      }

      return { ok: true, response: 'NEGATIVE' }
    },
  )

  // ── D.3 — Amazon official Customer Feedback API: access probe + debug ──
  // The honest gate: does the SP-API app hold the Brand Analytics / Selling
  // Partner Insights role? Mirrors /advertising/sqp/probe.
  fastify.post('/reviews/insights/probe', async (request, reply) => {
    const b = (request.body ?? {}) as { marketplace?: string }
    if (!b.marketplace) { reply.status(400); return { error: 'marketplace required' } }
    const { probeAmazonReviewInsightsAccess } = await import('../services/reviews/amazon-review-insights.service.js')
    reply.header('Cache-Control', 'no-store')
    return probeAmazonReviewInsightsAccess(b.marketplace)
  })

  // Last raw API shapes (topics/trends) — finalise the defensive parsers against
  // Amazon's real fields without needing Railway log access.
  fastify.get('/reviews/insights/debug', async (_request, reply) => {
    const { insightsDebugState } = await import('../services/reviews/amazon-review-insights.service.js')
    reply.header('Cache-Control', 'no-store')
    return insightsDebugState
  })

  // ── D.4 — Amazon insights: read + rollup + manual ingest ──
  // GET /api/reviews/insights?productId&marketplace&asin — raw insight rows.
  fastify.get('/reviews/insights', async (request, reply) => {
    const q = request.query as { productId?: string; marketplace?: string; asin?: string }
    const where: Record<string, unknown> = {}
    if (q.productId) where.productId = q.productId
    if (q.marketplace) where.marketplace = q.marketplace
    if (q.asin) where.asin = q.asin
    reply.header('Cache-Control', 'private, max-age=120')
    const items = await prisma.amazonReviewInsight.findMany({ where, orderBy: { fetchedAt: 'desc' }, take: 300 })
    return { items, count: items.length }
  })

  // GET /api/reviews/insights/rollup?marketplace — merged Overview signal:
  // review-weighted avg rating + total count + merged top topics + worst access.
  fastify.get('/reviews/insights/rollup', async (request, reply) => {
    const q = request.query as { marketplace?: string }
    const rows = await prisma.amazonReviewInsight.findMany({ where: q.marketplace ? { marketplace: q.marketplace } : {} })
    type Topic = { topic: string; mentionCount: number | null; ratingImpact: number | null; snippets: string[] }
    const mergeTopics = (key: 'positiveTopics' | 'negativeTopics') => {
      const m = new Map<string, Topic>()
      for (const r of rows) {
        for (const t of (r[key] as unknown as Topic[]) ?? []) {
          if (!t?.topic) continue
          const e = m.get(t.topic) ?? { topic: t.topic, mentionCount: 0, ratingImpact: null, snippets: [] }
          e.mentionCount = (e.mentionCount ?? 0) + (t.mentionCount ?? 0)
          if (t.ratingImpact != null && (e.ratingImpact == null || Math.abs(t.ratingImpact) > Math.abs(e.ratingImpact))) e.ratingImpact = t.ratingImpact
          for (const s of t.snippets ?? []) if (e.snippets.length < 4 && !e.snippets.includes(s)) e.snippets.push(s)
          m.set(t.topic, e)
        }
      }
      return [...m.values()].sort((a, b) => (b.mentionCount ?? 0) - (a.mentionCount ?? 0)).slice(0, 6)
    }
    let weightedSum = 0, weight = 0, totalReviews = 0
    for (const r of rows) {
      if (r.starRating != null) { const w = r.reviewCount ?? 1; weightedSum += r.starRating * w; weight += w }
      totalReviews += r.reviewCount ?? 0
    }
    const anyOk = rows.some((r) => r.accessStatus === 'OK')
    const accessStatus = rows.length === 0 ? 'NO_DATA' : anyOk ? 'OK' : rows.some((r) => r.accessStatus === 'NEEDS_BRAND_ANALYTICS_ROLE') ? 'NEEDS_BRAND_ANALYTICS_ROLE' : rows[0].accessStatus
    reply.header('Cache-Control', 'private, max-age=120')
    return {
      marketplace: q.marketplace ?? null,
      asins: rows.length,
      starRating: weight > 0 ? Math.round((weightedSum / weight) * 100) / 100 : null,
      reviewCount: totalReviews,
      positiveTopics: mergeTopics('positiveTopics'),
      negativeTopics: mergeTopics('negativeTopics'),
      accessStatus,
      lastFetchedAt: rows.reduce<string | null>((acc, r) => (!acc || r.fetchedAt > new Date(acc) ? r.fetchedAt.toISOString() : acc), null),
    }
  })

  // POST /api/reviews/insights/ingest { marketplace, limit } — fire-and-forget.
  fastify.post('/reviews/insights/ingest', async (request, reply) => {
    const b = (request.body ?? {}) as { marketplace?: string; limit?: number }
    if (!b.marketplace) { reply.status(400); return { error: 'marketplace required' } }
    const { ingestAmazonReviewInsights } = await import('../services/reviews/amazon-review-insights.service.js')
    void ingestAmazonReviewInsights({ marketplaceCode: b.marketplace, limit: b.limit })
      .then((r) => fastify.log.info({ insights: r }, '[review-insights] manual ingest complete'))
      .catch((e) => fastify.log.error({ err: e }, '[review-insights] manual ingest failed'))
    reply.header('Cache-Control', 'no-store')
    return { ok: true, started: true, marketplace: b.marketplace, note: 'ingest running in background; poll GET /reviews/insights for results' }
  })

  // ── D.5 — Overview blend: ONE call for the kid-simple Tab 1, channel+market scoped.
  // Amazon → official insights (themes/rating, no per-review text); eBay/import →
  // individual reviews (rating + recent list). 'ALL' merges both.
  fastify.get('/reviews/overview', async (request, reply) => {
    const q = request.query as { channel?: string; marketplace?: string }
    const channel = q.channel && q.channel !== 'ALL' ? q.channel : null
    const marketplace = q.marketplace && q.marketplace !== 'ALL' ? q.marketplace : null
    const wantAmazon = !channel || channel === 'AMAZON'

    type Topic = { topic: string; mentionCount: number | null; ratingImpact: number | null; snippets: string[] }
    let insights: { starRating: number | null; reviewCount: number; positiveTopics: Topic[]; negativeTopics: Topic[]; accessStatus: string; asins: number } | null = null
    if (wantAmazon) {
      const rows = await prisma.amazonReviewInsight.findMany({ where: marketplace ? { marketplace } : {} })
      const merge = (key: 'positiveTopics' | 'negativeTopics') => {
        const m = new Map<string, Topic>()
        for (const r of rows) for (const t of (r[key] as unknown as Topic[]) ?? []) {
          if (!t?.topic) continue
          const e = m.get(t.topic) ?? { topic: t.topic, mentionCount: 0, ratingImpact: null, snippets: [] }
          e.mentionCount = (e.mentionCount ?? 0) + (t.mentionCount ?? 0)
          for (const s of t.snippets ?? []) if (e.snippets.length < 4 && !e.snippets.includes(s)) e.snippets.push(s)
          m.set(t.topic, e)
        }
        return [...m.values()].sort((a, b) => (b.mentionCount ?? 0) - (a.mentionCount ?? 0)).slice(0, 6)
      }
      let ws = 0, w = 0, tot = 0
      for (const r of rows) { if (r.starRating != null) { const ww = r.reviewCount ?? 1; ws += r.starRating * ww; w += ww } tot += r.reviewCount ?? 0 }
      const anyOk = rows.some((r) => r.accessStatus === 'OK')
      const accessStatus = rows.length === 0 ? (process.env.NEXUS_ENABLE_AMAZON_REVIEW_INSIGHTS === '1' ? 'PENDING' : 'OFF') : anyOk ? 'OK' : rows.some((r) => r.accessStatus === 'NEEDS_BRAND_ANALYTICS_ROLE') ? 'NEEDS_BRAND_ANALYTICS_ROLE' : rows[0].accessStatus
      insights = { starRating: w > 0 ? Math.round((ws / w) * 100) / 100 : null, reviewCount: tot, positiveTopics: merge('positiveTopics'), negativeTopics: merge('negativeTopics'), accessStatus, asins: rows.length }
    }

    const rw: Record<string, unknown> = {}
    if (channel) rw.channel = channel
    if (marketplace) rw.marketplace = marketplace
    const since = new Date(Date.now() - 90 * 86_400_000)
    const [ratingRows, recent, total] = await Promise.all([
      prisma.review.findMany({ where: { ...rw, rating: { not: null }, postedAt: { gte: since } }, select: { rating: true, postedAt: true }, orderBy: { postedAt: 'asc' } }),
      prisma.review.findMany({ where: rw, orderBy: { postedAt: 'desc' }, take: 20, include: { sentiment: true, product: { select: { id: true, sku: true, name: true } } } }),
      prisma.review.count({ where: rw }),
    ])
    const distribution: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
    let sum = 0, count = 0
    const dayMap = new Map<string, { sum: number; count: number }>()
    for (const r of ratingRows) {
      if (r.rating == null) continue
      const star = Math.min(5, Math.max(1, Math.round(r.rating)))
      distribution[star] += 1; sum += r.rating; count += 1
      const day = r.postedAt.toISOString().slice(0, 10)
      const d = dayMap.get(day) ?? { sum: 0, count: 0 }; d.sum += r.rating; d.count += 1; dayMap.set(day, d)
    }
    const trend = [...dayMap.entries()].map(([date, v]) => ({ date, avg: v.count > 0 ? v.sum / v.count : null, count: v.count })).sort((a, b) => a.date.localeCompare(b.date))

    reply.header('Cache-Control', 'private, max-age=60')
    return {
      channel: channel ?? 'ALL',
      marketplace: marketplace ?? 'ALL',
      insights,
      reviews: { average: count > 0 ? sum / count : null, count, distribution, trend, recent, total },
      status: {
        amazonInsights: insights?.accessStatus ?? null,
        ebayLiveEnabled: process.env.NEXUS_EBAY_REAL_API === 'true',
        mode: process.env.NEXUS_REVIEW_INGEST_MODE === 'live' ? 'live' : 'sandbox',
      },
    }
  })
}

export default reviewsRoutes
