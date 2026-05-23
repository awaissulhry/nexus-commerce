/**
 * PB.10 — Scheduled image-publish CRUD.
 *
 *   POST   /api/products/:productId/scheduled-image-publishes
 *     body: { channel, marketplace?, scheduledFor (ISO) }
 *     → { id, status: 'PENDING', scheduledFor, channel, marketplace }
 *
 *   GET    /api/products/:productId/scheduled-image-publishes
 *     query: ?status=PENDING (default) | FIRED | FAILED | CANCELLED | ALL
 *     → { rows: ScheduledImagePublish[] }
 *
 *   DELETE /api/scheduled-image-publishes/:id
 *     Cancels a PENDING row. FIRED/FAILED/CANCELLED rows can't be
 *     cancelled (already settled).
 *     → { id, status: 'CANCELLED', cancelledAt }
 */

import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'

const VALID_CHANNELS = new Set(['AMAZON', 'EBAY', 'SHOPIFY'])
const VALID_AMAZON_MARKETS = new Set(['IT', 'DE', 'FR', 'ES', 'UK', 'ALL'])

const scheduledImagePublishesRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{
    Params: { productId: string }
    Body: { channel?: string; marketplace?: string | null; scheduledFor?: string }
  }>(
    '/products/:productId/scheduled-image-publishes',
    async (req, reply) => {
      const { productId } = req.params
      const channel = (req.body?.channel ?? '').toUpperCase()
      const marketplace = req.body?.marketplace
        ? req.body.marketplace.toUpperCase()
        : null
      const scheduledForRaw = req.body?.scheduledFor

      if (!VALID_CHANNELS.has(channel)) {
        return reply.code(400).send({ error: 'INVALID_CHANNEL', message: `channel must be one of ${[...VALID_CHANNELS].join(', ')}` })
      }
      if (channel === 'AMAZON') {
        if (!marketplace || !VALID_AMAZON_MARKETS.has(marketplace)) {
          return reply.code(400).send({ error: 'INVALID_MARKETPLACE', message: `Amazon marketplace must be one of ${[...VALID_AMAZON_MARKETS].join(', ')}` })
        }
      }
      if (!scheduledForRaw) {
        return reply.code(400).send({ error: 'SCHEDULED_FOR_REQUIRED' })
      }
      const scheduledFor = new Date(scheduledForRaw)
      if (Number.isNaN(scheduledFor.getTime())) {
        return reply.code(400).send({ error: 'INVALID_SCHEDULED_FOR', message: 'scheduledFor must be an ISO date string' })
      }
      // Minimum future buffer — 30 seconds. Avoids races between
      // submit + cron tick where the operator picks "now" and the
      // cron fires before the FE renders the new row.
      if (scheduledFor.getTime() < Date.now() + 30_000) {
        return reply.code(400).send({ error: 'TOO_SOON', message: 'scheduledFor must be at least 30 seconds in the future' })
      }

      const product = await prisma.product.findUnique({
        where: { id: productId },
        select: { id: true },
      })
      if (!product) return reply.code(404).send({ error: 'Product not found' })

      const row = await prisma.scheduledImagePublish.create({
        data: {
          productId,
          channel,
          marketplace: channel === 'AMAZON' ? marketplace : null,
          scheduledFor,
          status: 'PENDING',
        },
      })
      return reply.send(row)
    },
  )

  fastify.get<{
    Params: { productId: string }
    Querystring: { status?: string }
  }>(
    '/products/:productId/scheduled-image-publishes',
    async (req, reply) => {
      const { productId } = req.params
      const status = (req.query?.status ?? 'PENDING').toUpperCase()
      const where: { productId: string; status?: string } = { productId }
      if (status !== 'ALL') where.status = status

      const rows = await prisma.scheduledImagePublish.findMany({
        where,
        orderBy: [{ scheduledFor: 'asc' }],
        take: 100,
      })
      return reply.send({ rows })
    },
  )

  fastify.delete<{ Params: { id: string } }>(
    '/scheduled-image-publishes/:id',
    async (req, reply) => {
      const { id } = req.params
      const row = await prisma.scheduledImagePublish.findUnique({ where: { id } })
      if (!row) return reply.code(404).send({ error: 'Schedule not found' })
      if (row.status !== 'PENDING') {
        return reply.code(409).send({
          error: 'NOT_CANCELLABLE',
          message: `Schedule is ${row.status}; only PENDING rows can be cancelled.`,
        })
      }
      const updated = await prisma.scheduledImagePublish.update({
        where: { id },
        data: { status: 'CANCELLED', cancelledAt: new Date() },
      })
      return reply.send(updated)
    },
  )
}

export default scheduledImagePublishesRoutes
