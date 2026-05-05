/**
 * G.1 + G.2 — Pricing engine read + recompute endpoints.
 *
 *   GET  /api/pricing/explain?sku=&channel=&marketplace=&fulfillmentMethod=
 *        Returns the engine's resolution chain + final price + breakdown
 *        + reasoning. Used by the matrix UI's row-detail drawer.
 *
 *   GET  /api/pricing/matrix
 *        Reads PricingSnapshot for the matrix UI; supports filter, paginate.
 *
 *   POST /api/pricing/refresh-snapshots
 *        Body { skus?: string[] } — refresh specific SKUs or omit for all.
 *        Useful after manual data corrections; nightly cron handles the
 *        rest automatically.
 *
 *   POST /api/pricing/refresh-fx
 *        Pulls latest rates from frankfurter.app. Daily cron runs this
 *        too; manual trigger is a debugging convenience.
 */
import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'
import { resolvePrice } from '../services/pricing-engine.service.js'
import {
  refreshSnapshotsForSkus,
  refreshAllSnapshots,
} from '../services/pricing-snapshot.service.js'
import { refreshFxRates } from '../services/fx-rate.service.js'
import {
  refreshFeeEstimates,
  refreshCompetitivePricing,
} from '../services/sp-api-pricing.service.js'
import { pushPriceUpdate } from '../services/pricing-outbound.service.js'
import { runPromotionScheduler } from '../services/promotion-scheduler.service.js'
import { Prisma } from '@prisma/client'

const pricingRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/pricing/explain', async (request, reply) => {
    try {
      const q = request.query as Record<string, string | undefined>
      if (!q.sku || !q.channel || !q.marketplace) {
        return reply.code(400).send({
          error: 'sku, channel, marketplace are all required',
        })
      }
      const fm =
        q.fulfillmentMethod === 'FBA' || q.fulfillmentMethod === 'FBM'
          ? q.fulfillmentMethod
          : null
      const result = await resolvePrice(prisma, {
        sku: q.sku,
        channel: q.channel.toUpperCase(),
        marketplace: q.marketplace.toUpperCase(),
        fulfillmentMethod: fm,
      })
      return result
    } catch (error: any) {
      fastify.log.error({ err: error }, '[pricing/explain] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // G.4.2 — Outlier alerts. Surfaces SKUs that need the user's attention:
  // clamped to a floor (margin / MAP), no master price, FX-stale, etc.
  // Reads from PricingSnapshot.warnings + flags.
  fastify.get('/pricing/alerts', async (_request, reply) => {
    try {
      const where: Prisma.PricingSnapshotWhereInput = {
        OR: [
          { isClamped: true },
          { warnings: { isEmpty: false } },
          { source: 'FALLBACK' },
        ],
      }
      const rows = await prisma.pricingSnapshot.findMany({
        where,
        orderBy: [{ source: 'asc' }, { sku: 'asc' }],
        take: 500,
      })
      // Group by category for the UI banners.
      const buckets = {
        fallback: rows.filter((r) => r.source === 'FALLBACK'),
        clamped: rows.filter((r) => r.isClamped),
        warningsOnly: rows.filter(
          (r) => !r.isClamped && r.source !== 'FALLBACK' && r.warnings.length > 0,
        ),
      }
      return {
        total: rows.length,
        counts: {
          fallback: buckets.fallback.length,
          clamped: buckets.clamped.length,
          warnings: buckets.warningsOnly.length,
        },
        rows,
      }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[pricing/alerts] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  fastify.get('/pricing/matrix', async (request, reply) => {
    try {
      const q = request.query as Record<string, string | undefined>
      const channel = q.channel?.toUpperCase()
      const marketplace = q.marketplace?.toUpperCase()
      const sourceFilter = q.source
      const isClampedFilter = q.isClamped === 'true' ? true : q.isClamped === 'false' ? false : undefined
      const search = q.search?.trim()
      const page = Math.max(0, parseInt(q.page ?? '0', 10) || 0)
      const limit = Math.min(500, Math.max(1, parseInt(q.limit ?? '50', 10) || 50))

      const where: any = {}
      if (channel) where.channel = channel
      if (marketplace) where.marketplace = marketplace
      if (sourceFilter) where.source = sourceFilter
      if (isClampedFilter !== undefined) where.isClamped = isClampedFilter
      if (search) where.sku = { contains: search, mode: 'insensitive' }

      const [rows, total] = await Promise.all([
        prisma.pricingSnapshot.findMany({
          where,
          orderBy: [{ sku: 'asc' }, { channel: 'asc' }, { marketplace: 'asc' }],
          skip: page * limit,
          take: limit,
        }),
        prisma.pricingSnapshot.count({ where }),
      ])

      return { rows, total, page, limit }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[pricing/matrix] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  fastify.post('/pricing/refresh-snapshots', async (request, reply) => {
    try {
      const body = (request.body ?? {}) as { skus?: string[] }
      const result = body.skus && body.skus.length > 0
        ? await refreshSnapshotsForSkus(prisma, body.skus)
        : await refreshAllSnapshots(prisma)
      return { ok: true, ...result }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[pricing/refresh-snapshots] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  fastify.post('/pricing/refresh-fx', async (_request, reply) => {
    try {
      const result = await refreshFxRates(prisma)
      return { ok: true, ...result }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[pricing/refresh-fx] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // G.3.1 — Manual fee-estimate refresh per marketplace.
  fastify.post('/pricing/refresh-fees', async (request, reply) => {
    try {
      const body = (request.body ?? {}) as { marketplace?: string }
      if (!body.marketplace) {
        return reply.code(400).send({ error: 'marketplace required (e.g. "IT")' })
      }
      const result = await refreshFeeEstimates(prisma, body.marketplace)
      return { ok: true, ...result }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[pricing/refresh-fees] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // G.5.2 — Manual promotion scheduler tick (enter/exit + snapshot refresh).
  fastify.post('/pricing/run-promotions', async (_request, reply) => {
    try {
      const result = await runPromotionScheduler(prisma)
      return { ok: true, ...result }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[pricing/run-promotions] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // G.5.1 — Push the latest snapshot price to the marketplace API.
  fastify.post('/pricing/push', async (request, reply) => {
    try {
      const body = (request.body ?? {}) as {
        sku?: string
        channel?: string
        marketplace?: string
        fulfillmentMethod?: 'FBA' | 'FBM'
      }
      if (!body.sku || !body.channel || !body.marketplace) {
        return reply
          .code(400)
          .send({ error: 'sku, channel, marketplace are all required' })
      }
      const result = await pushPriceUpdate(prisma, {
        sku: body.sku,
        channel: body.channel,
        marketplace: body.marketplace,
        fulfillmentMethod: body.fulfillmentMethod ?? null,
      })
      return result
    } catch (error: any) {
      fastify.log.error({ err: error }, '[pricing/push] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // G.3.2 — Manual competitive-pricing refresh per marketplace.
  fastify.post('/pricing/refresh-competitive', async (request, reply) => {
    try {
      const body = (request.body ?? {}) as { marketplace?: string }
      if (!body.marketplace) {
        return reply.code(400).send({ error: 'marketplace required (e.g. "IT")' })
      }
      const result = await refreshCompetitivePricing(prisma, body.marketplace)
      return { ok: true, ...result }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[pricing/refresh-competitive] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })
}

export default pricingRoutes
