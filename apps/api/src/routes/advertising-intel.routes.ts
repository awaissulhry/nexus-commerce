/**
 * Apex C.2 — advertising intelligence routes (profit-native target ACOS).
 *
 * Kept in a SEPARATE plugin from advertising.routes.ts on purpose: that file
 * carries a € literal that trips plain grep into binary mode, and it sees heavy
 * concurrent edits — new read-only intel endpoints are safer here. Registered
 * under the same /api prefix.
 */

import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'
import { computeProductTargetAcos, computeFleetTargetAcos, type AcosMode } from '../services/advertising/ads-target-acos.service.js'
import { simulateAutopilot, applyAutopilot } from '../services/advertising/ads-autopilot.service.js'
import { envEnabled } from '../utils/env-flag.js'
import { cronStartupState } from '../jobs/cron-startup-state.js'
import { amsQueueUrl, isAmsSqsConfigured, sqsUrlFromArn } from '../services/ams-sqs.service.js'

const advertisingIntelRoutes: FastifyPluginAsync = async (fastify) => {
  // Apex — diagnostic probe for the ads-cron gate. Reads the SAME process.env
  // the boot-time cron block reads (single process serves HTTP + crons), so this
  // definitively shows whether the running process sees the flag as enabled and
  // what raw value was set. processUptimeSec confirms whether a recent deploy
  // actually restarted the container.
  fastify.get('/advertising/cron-status', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store')
    return {
      adsCronEnabled: envEnabled('NEXUS_ENABLE_AMAZON_ADS_CRON'),
      adsCronRaw: process.env.NEXUS_ENABLE_AMAZON_ADS_CRON ?? null,
      cronStartupStep: cronStartupState.step,
      cronStartupAt: cronStartupState.updatedAt,
      adsMode: process.env.NEXUS_AMAZON_ADS_MODE ?? null,
      queueWorkersRaw: process.env.ENABLE_QUEUE_WORKERS ?? null,
      hasRedisUrl: !!process.env.REDIS_URL,
      // Apex B.1 — why the AMS poller is/ isn't active. amsQueueUrlResolved=true
      // means we derived a pollable SQS URL (from NEXUS_AMS_SQS_QUEUE_URL or an
      // SQS NEXUS_AMS_DESTINATION_ARN). pollerActive requires that + AWS creds.
      ams: {
        destinationArnSet: !!process.env.NEXUS_AMS_DESTINATION_ARN,
        destinationArnIsSqs: process.env.NEXUS_AMS_DESTINATION_ARN ? !!sqsUrlFromArn(process.env.NEXUS_AMS_DESTINATION_ARN) : false,
        explicitQueueUrlSet: !!process.env.NEXUS_AMS_SQS_QUEUE_URL,
        queueUrlResolved: !!amsQueueUrl(),
        hasAwsAccessKey: !!process.env.AWS_ACCESS_KEY_ID,
        hasAwsSecret: !!process.env.AWS_SECRET_ACCESS_KEY,
        pollerActive: isAmsSqsConfigured(),
      },
      processUptimeSec: Math.round(process.uptime()),
      nowUtc: new Date().toISOString(),
    }
  })

  // Per-product profit-native target ACOS + break-even + TACOS/TACoP.
  fastify.get('/advertising/target-acos', async (request, reply) => {
    const q = request.query as { productId?: string; marketplace?: string; windowDays?: string; mode?: string }
    if (!q.productId) { reply.status(400); return { error: 'productId required' } }
    const result = await computeProductTargetAcos({
      productId: q.productId,
      marketplace: q.marketplace ?? null,
      windowDays: q.windowDays ? Number(q.windowDays) : undefined,
      mode: (q.mode as AcosMode) ?? undefined,
    })
    reply.header('Cache-Control', 'private, max-age=120')
    return result
  })

  // Apex F.1 — beginner autopilot: simulate (read-only) the full plan one north
  // star drives (profit-native bids + Bayesian sparse handling + ToS defense),
  // as a plain-language list. Nothing is applied.
  fastify.get('/advertising/autopilot/simulate', async (request, reply) => {
    const q = request.query as { campaignId?: string; marketplace?: string; mode?: string; bayesian?: string; targetAcos?: string }
    const plan = await simulateAutopilot({
      campaignId: q.campaignId,
      marketplace: q.marketplace,
      mode: q.mode === 'profit' || q.mode === 'balanced' || q.mode === 'growth' ? q.mode : undefined,
      bayesian: q.bayesian == null ? true : q.bayesian === '1' || q.bayesian === 'true',
      targetAcos: q.targetAcos ? Number(q.targetAcos) : undefined,
    })
    reply.header('Cache-Control', 'private, max-age=30')
    return plan
  })

  // Apex F.2 — apply the autopilot plan (operator-triggered). Allowlist-gated end
  // to end: bid changes filtered to liveBidWritesEnabled campaigns before write;
  // ToS pass allowlistedOnly. Returns applied vs skipped counts.
  fastify.post('/advertising/autopilot/apply', async (request, reply) => {
    const b = (request.body ?? {}) as { campaignId?: string; marketplace?: string; mode?: string; bayesian?: boolean; targetAcos?: number }
    try {
      const result = await applyAutopilot({
        campaignId: b.campaignId,
        marketplace: b.marketplace,
        mode: b.mode === 'profit' || b.mode === 'balanced' || b.mode === 'growth' ? b.mode : undefined,
        bayesian: b.bayesian !== false,
        targetAcos: typeof b.targetAcos === 'number' ? b.targetAcos : undefined,
        actor: (() => { const a = (request.headers as Record<string, unknown>)['x-actor-id']; return typeof a === 'string' && a ? `user:${a}` : 'autopilot' })(),
      })
      return { ok: true, ...result }
    } catch (e) {
      reply.status(500)
      return { ok: false, error: (e as Error)?.message }
    }
  })

  // Apex E.1 — competitive intel: our SHARE per search query (Brand Analytics SQP).
  // Read the ingested SearchQueryPerformance, newest period first, biggest-volume
  // queries first. Optional minShare / asin filters surface where we under-index.
  fastify.get('/advertising/search-query-performance', async (request, reply) => {
    const q = request.query as { marketplace?: string; asin?: string; minImpressionShare?: string; limit?: string; days?: string }
    const since = new Date(); since.setUTCDate(since.getUTCDate() - (q.days ? Number(q.days) : 90)); since.setUTCHours(0, 0, 0, 0)
    const rows = await prisma.searchQueryPerformance.findMany({
      where: {
        startDate: { gte: since },
        ...(q.marketplace ? { marketplace: q.marketplace } : {}),
        ...(q.asin ? { asin: q.asin } : {}),
        ...(q.minImpressionShare ? { impressionShare: { gte: Number(q.minImpressionShare) } } : {}),
      },
      orderBy: [{ startDate: 'desc' }, { searchQueryVolume: 'desc' }],
      take: Math.min(2000, q.limit ? Number(q.limit) : 500),
    })
    reply.header('Cache-Control', 'private, max-age=120')
    return { items: rows, count: rows.length }
  })

  // Probe whether the account has Brand Analytics SQP access (resolves the
  // gating dependency without committing to ingestion).
  fastify.post('/advertising/sqp/probe', async (request, reply) => {
    const b = (request.body ?? {}) as { marketplace?: string; period?: string }
    if (!b.marketplace) { reply.status(400); return { error: 'marketplace required' } }
    const { probeSqpAccess } = await import('../services/advertising/sqp.service.js')
    return probeSqpAccess(b.marketplace, (b.period as 'WEEK' | 'MONTH' | 'QUARTER') ?? 'WEEK')
  })

  // Manual SQP ingest trigger (for one marketplace/period).
  fastify.post('/advertising/sqp/ingest', async (request, reply) => {
    const b = (request.body ?? {}) as { marketplace?: string; period?: string }
    if (!b.marketplace) { reply.status(400); return { error: 'marketplace required' } }
    const { ingestSqp } = await import('../services/advertising/sqp.service.js')
    try {
      return await ingestSqp({ marketplaceCode: b.marketplace, period: (b.period as 'WEEK' | 'MONTH' | 'QUARTER') ?? 'WEEK' })
    } catch (e) { reply.status(500); return { error: (e as Error)?.message } }
  })

  // Fleet view — every advertised product's target ACOS, revenue-ranked.
  fastify.get('/advertising/target-acos/fleet', async (request, reply) => {
    const q = request.query as { marketplace?: string; windowDays?: string; mode?: string }
    const items = await computeFleetTargetAcos({
      marketplace: q.marketplace ?? null,
      windowDays: q.windowDays ? Number(q.windowDays) : undefined,
      mode: (q.mode as AcosMode) ?? undefined,
    })
    reply.header('Cache-Control', 'private, max-age=120')
    return { items, count: items.length }
  })
}

export default advertisingIntelRoutes
