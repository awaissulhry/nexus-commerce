/**
 * Listing Reconciliation API (Phase RECON)
 *
 * POST /api/reconciliation/run           — trigger a run (returns runId + summary)
 * GET  /api/reconciliation/stats         — status counts for a channel+marketplace
 * GET  /api/reconciliation/items         — paginated list with filters
 * POST /api/reconciliation/items/:id/confirm — operator confirms a match
 * POST /api/reconciliation/items/:id/link    — override match to a specific product
 * POST /api/reconciliation/items/:id/status  — set CONFLICT / IGNORE / CREATE_NEW
 */

import type { FastifyInstance } from 'fastify'
import {
  runAmazonReconciliation,
  runEbayReconciliation,
  confirmReconRow,
  linkReconRow,
  setReconRowStatus,
  listReconRows,
  getReconStats,
  type ReconStatus,
} from '../services/listing-reconciliation.service.js'
import { logger } from '../utils/logger.js'

export default async function reconciliationRoutes(fastify: FastifyInstance) {
  // ── Trigger a reconciliation run ─────────────────────────────────────
  fastify.post('/reconciliation/run', async (req, reply) => {
    const { channel = 'AMAZON', marketplace = 'IT' } = req.body as Record<string, string> ?? {}

    if (channel !== 'AMAZON' && channel !== 'EBAY') {
      return reply.code(400).send({ error: 'channel must be AMAZON or EBAY' })
    }

    try {
      logger.info('[recon] Manual run triggered', { channel, marketplace })
      const summary = channel === 'EBAY'
        ? await runEbayReconciliation(marketplace)
        : await runAmazonReconciliation(marketplace)
      return reply.code(200).send({ ok: true, summary })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error('[recon] Run failed', { error: msg })
      return reply.code(500).send({ error: msg })
    }
  })

  // ── Stats (status breakdown) ──────────────────────────────────────────
  fastify.get('/reconciliation/stats', async (req, reply) => {
    const { channel = 'AMAZON', marketplace = 'IT' } = req.query as Record<string, string>
    const stats = await getReconStats(channel, marketplace)
    return reply.send(stats)
  })

  // ── List rows with filters ────────────────────────────────────────────
  fastify.get('/reconciliation/items', async (req, reply) => {
    const q = req.query as Record<string, string>
    const result = await listReconRows({
      channel: q.channel,
      marketplace: q.marketplace,
      status: q.status,
      runId: q.runId,
      page: q.page ? parseInt(q.page, 10) : 1,
      pageSize: q.pageSize ? Math.min(parseInt(q.pageSize, 10), 200) : 50,
    })
    return reply.send(result)
  })

  // ── Confirm a match ───────────────────────────────────────────────────
  fastify.post('/reconciliation/items/:id/confirm', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { reviewedBy = 'operator' } = req.body as Record<string, string> ?? {}
    try {
      await confirmReconRow(id, reviewedBy)
      return reply.send({ ok: true })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return reply.code(400).send({ error: msg })
    }
  })

  // ── Manual link to a product ──────────────────────────────────────────
  fastify.post('/reconciliation/items/:id/link', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { productId, variationId = null, reviewedBy = 'operator' } = req.body as Record<string, string | null> ?? {}
    if (!productId) return reply.code(400).send({ error: 'productId required' })
    try {
      await linkReconRow(id, productId as string, variationId, reviewedBy as string)
      return reply.send({ ok: true })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return reply.code(400).send({ error: msg })
    }
  })

  // ── Set status (CONFLICT / IGNORE / CREATE_NEW) ───────────────────────
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
      const msg = err instanceof Error ? err.message : String(err)
      return reply.code(400).send({ error: msg })
    }
  })
}
