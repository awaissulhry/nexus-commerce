/**
 * Phase 3: eBay Listing Gap + Bulk Schedule API
 *
 * GET  /api/ebay/phase3/gap?marketplace=IT         — gap analysis
 * GET  /api/ebay/phase3/progress?marketplace=IT    — schedule progress
 * POST /api/ebay/phase3/schedule                   — bulk schedule
 * DELETE /api/ebay/phase3/schedule                 — cancel pending schedules
 */

import type { FastifyInstance } from 'fastify'
import {
  getEbayListingGap,
  scheduleBulkEbayListings,
  getPhase3Progress,
} from '../services/ebay-listing-gap.service.js'
import { logger } from '../utils/logger.js'

export default async function ebayPhase3Routes(fastify: FastifyInstance) {
  // Gap analysis
  fastify.get('/ebay/phase3/gap', async (req, reply) => {
    const { marketplace = 'IT', includeTest } = req.query as Record<string, string>
    try {
      const result = await getEbayListingGap(marketplace, { includeTest: includeTest === '1' })
      return reply.send(result)
    } catch (err) {
      logger.error('[phase3/gap] failed', { error: err instanceof Error ? err.message : String(err) })
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  // Progress
  fastify.get('/ebay/phase3/progress', async (req, reply) => {
    const { marketplace = 'IT' } = req.query as Record<string, string>
    try {
      return reply.send(await getPhase3Progress(marketplace))
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  // Bulk schedule — operator selects products and sets pace
  fastify.post<{
    Body: {
      marketplace?: string
      productIds?: string[]
      dailyLimit?: number
      startDate?: string
      scheduleAll?: boolean
    }
  }>('/ebay/phase3/schedule', async (req, reply) => {
    const body = req.body ?? {}
    const marketplace = body.marketplace ?? 'IT'
    const dailyLimit = Math.min(body.dailyLimit ?? 50, 200) // hard cap at 200/day
    const startDate = body.startDate ? new Date(body.startDate) : undefined

    try {
      let productIds: string[]
      if (body.scheduleAll) {
        // Schedule all gap products (operator confirmed)
        const gap = await getEbayListingGap(marketplace, { limit: 1000 })
        productIds = gap.products.map(p => p.id)
      } else if (Array.isArray(body.productIds) && body.productIds.length > 0) {
        productIds = body.productIds
      } else {
        return reply.code(400).send({ error: 'Provide productIds[] or set scheduleAll=true' })
      }

      if (productIds.length === 0) {
        return reply.send({ message: 'No gap products to schedule', totalScheduled: 0 })
      }

      const result = await scheduleBulkEbayListings({ marketplace, productIds, dailyLimit, startDate })
      return reply.send({ ok: true, ...result })
    } catch (err) {
      logger.error('[phase3/schedule] failed', { error: err instanceof Error ? err.message : String(err) })
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  // Cancel all pending schedules for a marketplace
  fastify.delete('/ebay/phase3/schedule', async (req, reply) => {
    const { marketplace = 'IT' } = req.query as Record<string, string>
    try {
      const db = (await import('../db.js')).default
      const updated = await db.scheduledWizardPublish.updateMany({
        where: {
          status: 'PENDING',
          scheduledFor: { gt: new Date() },
          wizard: { channels: { path: ['$[*].marketplace'], array_contains: marketplace } },
        },
        data: { status: 'CANCELLED', cancelledAt: new Date() },
      })
      return reply.send({ ok: true, cancelled: updated.count })
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })
}
