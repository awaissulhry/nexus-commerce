/**
 * Listing Reconciliation API (Phase RECON)
 *
 * POST /api/reconciliation/run                   — trigger a run; marketplace='ALL' fans out
 * GET  /api/reconciliation/stats                 — status counts for a channel+marketplace
 * GET  /api/reconciliation/items                 — paginated list with filters
 * POST /api/reconciliation/items/:id/confirm     — confirm a single match
 * POST /api/reconciliation/items/:id/link        — override match to a specific product
 * POST /api/reconciliation/items/:id/status      — set CONFLICT / IGNORE / CREATE_NEW
 * POST /api/reconciliation/bulk/confirm          — confirm multiple rows at once
 * POST /api/reconciliation/bulk/status           — set status on multiple rows
 * POST /api/reconciliation/bulk/confirm-all-high — confirm all high-confidence pending rows
 */

import type { FastifyInstance } from 'fastify'
import {
  runAmazonReconciliation,
  runAmazonReconciliationAllMarkets,
  runEbayReconciliation,
  confirmReconRow,
  linkReconRow,
  setReconRowStatus,
  listReconRows,
  getReconStats,
  bulkConfirmReconRows,
  bulkSetReconRowStatus,
  type ReconStatus,
} from '../services/listing-reconciliation.service.js'
import {
  startPullJob, getJobStatus,
  startAllMarketsPullJob, getAllMarketsPullJobStatus,
} from '../services/amazon/flat-file-pull.service.js'
import { startPropagateJob, getPropagateJobStatus } from '../services/amazon/flat-file-propagate.service.js'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'

export default async function reconciliationRoutes(fastify: FastifyInstance) {
  // ── Trigger a run ────────────────────────────────────────────────────────
  // marketplace='ALL' fans out across all active markets (sequential, ~25 min)
  fastify.post('/reconciliation/run', async (req, reply) => {
    const { channel = 'AMAZON', marketplace = 'IT' } = req.body as Record<string, string> ?? {}

    if (channel !== 'AMAZON' && channel !== 'EBAY') {
      return reply.code(400).send({ error: 'channel must be AMAZON or EBAY' })
    }

    try {
      if (channel === 'EBAY') {
        const summary = await runEbayReconciliation(marketplace)
        return reply.code(200).send({ ok: true, summary })
      }

      if (marketplace === 'ALL') {
        logger.info('[recon] All-markets run triggered')
        const result = await runAmazonReconciliationAllMarkets()
        return reply.code(200).send({ ok: true, allMarkets: true, ...result })
      }

      const summary = await runAmazonReconciliation(marketplace)
      return reply.code(200).send({ ok: true, summary })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error('[recon] Run failed', { error: msg })
      return reply.code(500).send({ error: msg })
    }
  })

  // ── Stats ─────────────────────────────────────────────────────────────────
  fastify.get('/reconciliation/stats', async (req, reply) => {
    const { channel = 'AMAZON', marketplace } = req.query as Record<string, string>
    // If no marketplace specified or 'ALL', aggregate across all markets
    if (!marketplace || marketplace === 'ALL') {
      const rows = await prisma.listingReconciliation.groupBy({
        by: ['channel', 'marketplace', 'reconciliationStatus'],
        where: channel ? { channel } : undefined,
        _count: { _all: true },
      })
      const byMarket: Record<string, Record<string, number>> = {}
      let totalByStatus: Record<string, number> = {}
      for (const r of rows) {
        const mp = r.marketplace
        byMarket[mp] = byMarket[mp] ?? {}
        byMarket[mp][r.reconciliationStatus] = r._count._all
        totalByStatus[r.reconciliationStatus] = (totalByStatus[r.reconciliationStatus] ?? 0) + r._count._all
      }
      return reply.send({
        byMarket,
        byStatus: totalByStatus,
        total: Object.values(totalByStatus).reduce((a, b) => a + b, 0),
      })
    }
    return reply.send(await getReconStats(channel, marketplace))
  })

  // ── List rows ─────────────────────────────────────────────────────────────
  fastify.get('/reconciliation/items', async (req, reply) => {
    const q = req.query as Record<string, string>
    const result = await listReconRows({
      channel: q.channel,
      // marketplace='ALL' → no filter (shows all markets together)
      marketplace: q.marketplace && q.marketplace !== 'ALL' ? q.marketplace : undefined,
      status: q.status,
      runId: q.runId,
      page: q.page ? parseInt(q.page, 10) : 1,
      pageSize: q.pageSize ? Math.min(parseInt(q.pageSize, 10), 200) : 100,
    })
    return reply.send(result)
  })

  // ── Single-row actions ────────────────────────────────────────────────────
  fastify.post('/reconciliation/items/:id/confirm', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { reviewedBy = 'operator' } = req.body as Record<string, string> ?? {}
    try {
      await confirmReconRow(id, reviewedBy)
      return reply.send({ ok: true })
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  fastify.post('/reconciliation/items/:id/link', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { productId, variationId = null, reviewedBy = 'operator' } = req.body as Record<string, string | null> ?? {}
    if (!productId) return reply.code(400).send({ error: 'productId required' })
    try {
      await linkReconRow(id, productId as string, variationId, reviewedBy as string)
      return reply.send({ ok: true })
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  fastify.post('/reconciliation/items/:id/status', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { status, reviewedBy = 'operator', notes } = req.body as Record<string, string> ?? {}
    const allowed: ReconStatus[] = ['PENDING', 'CONFLICT', 'IGNORE', 'CREATE_NEW']
    if (!allowed.includes(status as ReconStatus)) {
      return reply.code(400).send({ error: `status must be one of: ${allowed.join(', ')}` })
    }
    try {
      await setReconRowStatus(id, status as ReconStatus, reviewedBy, notes)
      return reply.send({ ok: true })
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  // ── Bulk actions ──────────────────────────────────────────────────────────

  // Confirm multiple specific rows
  fastify.post('/reconciliation/bulk/confirm', async (req, reply) => {
    const { ids, reviewedBy = 'operator' } = req.body as { ids?: string[]; reviewedBy?: string } ?? {}
    if (!Array.isArray(ids) || ids.length === 0) {
      return reply.code(400).send({ error: 'ids[] required' })
    }
    try {
      const result = await bulkConfirmReconRows(ids, reviewedBy)
      return reply.send({ ok: true, ...result })
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  // Set status on multiple rows
  fastify.post('/reconciliation/bulk/status', async (req, reply) => {
    const { ids, status, reviewedBy = 'operator', notes } = req.body as {
      ids?: string[]
      status?: string
      reviewedBy?: string
      notes?: string
    } ?? {}
    const allowed: ReconStatus[] = ['PENDING', 'CONFLICT', 'IGNORE', 'CREATE_NEW']
    if (!Array.isArray(ids) || ids.length === 0) return reply.code(400).send({ error: 'ids[] required' })
    if (!allowed.includes(status as ReconStatus)) {
      return reply.code(400).send({ error: `status must be one of: ${allowed.join(', ')}` })
    }
    try {
      const result = await bulkSetReconRowStatus(ids, status as ReconStatus, reviewedBy, notes)
      return reply.send({ ok: true, ...result })
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  // Confirm ALL high-confidence pending rows for a channel+marketplace in one click.
  // "High confidence" = matchConfidence >= 0.95 (SKU exact match).
  // This is the main bulk-approval path: run reconciliation → review low-confidence
  // rows manually → confirm-all-high to sweep the rest.
  fastify.post('/reconciliation/bulk/confirm-all-high', async (req, reply) => {
    const { channel = 'AMAZON', marketplace, reviewedBy = 'operator', minConfidence = 0.95 } =
      req.body as { channel?: string; marketplace?: string; reviewedBy?: string; minConfidence?: number } ?? {}

    try {
      const where: any = {
        channel,
        reconciliationStatus: 'PENDING',
        matchConfidence: { gte: minConfidence },
        matchedProductId: { not: null },
        externalListingId: { not: null },
      }
      if (marketplace && marketplace !== 'ALL') where.marketplace = marketplace

      const pendingHighConf = await prisma.listingReconciliation.findMany({
        where,
        select: { id: true, marketplace: true, matchConfidence: true },
      })

      logger.info('[recon] bulk confirm-all-high', {
        channel, marketplace, minConfidence, count: pendingHighConf.length,
      })

      const result = await bulkConfirmReconRows(pendingHighConf.map(r => r.id), reviewedBy)
      return reply.send({
        ok: true,
        eligible: pendingHighConf.length,
        ...result,
      })
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  // ── POST /api/reconciliation/flat-file-pull/start ────────────────────────
  // Kick off a background job that calls getListingsItem for every product
  // SKU in the given marketplace + productType, writes full attributes to
  // ChannelListing.platformAttributes, and returns a jobId to poll.
  fastify.post<{
    Body: { marketplace?: string; productType?: string }
  }>('/reconciliation/flat-file-pull/start', async (request, reply) => {
    const { marketplace = 'IT', productType = '' } = request.body ?? {}
    if (!productType?.trim()) {
      return reply.code(400).send({ error: 'productType is required' })
    }
    const jobId = startPullJob(marketplace, productType)
    return reply.send({ jobId })
  })

  // ── GET /api/reconciliation/flat-file-pull/status/:jobId ─────────────────
  fastify.get<{ Params: { jobId: string } }>(
    '/reconciliation/flat-file-pull/status/:jobId',
    async (request, reply) => {
      const job = getJobStatus(request.params.jobId)
      if (!job) return reply.code(404).send({ error: 'Job not found or expired' })
      return reply.send(job)
    },
  )

  // ── POST /api/reconciliation/flat-file-pull/start-all ────────────────────
  // Pull all markets sequentially for the given product type.
  fastify.post<{ Body: { productType?: string; markets?: string[] } }>(
    '/reconciliation/flat-file-pull/start-all',
    async (request, reply) => {
      const { productType = '', markets = ['IT', 'DE', 'FR', 'ES', 'UK'] } = request.body ?? {}
      if (!productType.trim()) return reply.code(400).send({ error: 'productType is required' })
      const jobId = startAllMarketsPullJob(productType, markets)
      return reply.send({ jobId })
    },
  )

  // ── GET /api/reconciliation/flat-file-pull/status-all/:jobId ─────────────
  fastify.get<{ Params: { jobId: string } }>(
    '/reconciliation/flat-file-pull/status-all/:jobId',
    async (request, reply) => {
      const job = getAllMarketsPullJobStatus(request.params.jobId)
      if (!job) return reply.code(404).send({ error: 'Job not found or expired' })
      return reply.send(job)
    },
  )

  // ── POST /api/reconciliation/propagate/start ──────────────────────────────
  // Copy + translate flat-file data from a source market to target markets.
  fastify.post<{
    Body: {
      sourceMarket?: string
      targetMarkets?: string[]
      productType?: string
      translateText?: boolean
      translateEnums?: boolean
    }
  }>('/reconciliation/propagate/start', async (request, reply) => {
    const {
      sourceMarket = 'IT',
      targetMarkets = [],
      productType = '',
      translateText = true,
      translateEnums = true,
    } = request.body ?? {}
    if (!productType.trim()) return reply.code(400).send({ error: 'productType is required' })
    if (!targetMarkets.length) return reply.code(400).send({ error: 'targetMarkets must be non-empty' })
    const jobId = startPropagateJob(sourceMarket, targetMarkets, productType, { translateText, translateEnums })
    return reply.send({ jobId })
  })

  // ── GET /api/reconciliation/propagate/status/:jobId ───────────────────────
  fastify.get<{ Params: { jobId: string } }>(
    '/reconciliation/propagate/status/:jobId',
    async (request, reply) => {
      const job = getPropagateJobStatus(request.params.jobId)
      if (!job) return reply.code(404).send({ error: 'Job not found or expired' })
      return reply.send(job)
    },
  )

  // ── GET /api/reconciliation/product-types ────────────────────────────────
  // Distinct product types from the products table — drives dropdowns on
  // the Pull and Propagate tabs.
  fastify.get('/reconciliation/product-types', async (_request, reply) => {
    const rows = await prisma.product.findMany({
      where: { deletedAt: null, productType: { not: null } },
      select: { productType: true },
      distinct: ['productType'],
      orderBy: { productType: 'asc' },
    })
    const types = rows.map((r) => r.productType).filter(Boolean) as string[]
    return reply.send({ types })
  })
}
