import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'

const fulfillmentRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/fulfillment/stock-overview
  // Real data: top-level products with stock + fulfillment channel.
  // Optional filters: ?fulfillment=FBA|FBM, ?lowStock=1, ?q=search
  // 30s cache.
  fastify.get('/fulfillment/stock-overview', async (request, reply) => {
    try {
      reply.header('Cache-Control', 'private, max-age=30')

      const q = request.query as {
        fulfillment?: string
        lowStock?: string
        q?: string
        limit?: string
      }
      const limit = Math.min(parseInt(q.limit ?? '500', 10) || 500, 1000)

      const where: any = { parentId: null }
      if (q.fulfillment === 'FBA' || q.fulfillment === 'FBM') {
        where.fulfillmentChannel = q.fulfillment
      }
      if (q.lowStock === '1' || q.lowStock === 'true') {
        where.totalStock = { lte: 5 }
      }
      if (q.q && q.q.trim()) {
        const search = q.q.trim()
        where.OR = [
          { sku: { contains: search, mode: 'insensitive' } },
          { name: { contains: search, mode: 'insensitive' } },
        ]
      }

      const rows = await prisma.product.findMany({
        where,
        select: {
          id: true,
          sku: true,
          name: true,
          totalStock: true,
          lowStockThreshold: true,
          fulfillmentChannel: true,
          amazonAsin: true,
          isParent: true,
        },
        orderBy: { totalStock: 'asc' },
        take: limit,
      })

      return { items: rows, count: rows.length }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[fulfillment/stock-overview] failed')
      return reply
        .code(500)
        .send({ error: error?.message ?? String(error) })
    }
  })

  // ── Placeholder endpoints (return empty arrays) ────────────────────
  // Cached for 5 minutes since the underlying tables don't exist yet.

  fastify.get('/fulfillment/inbound', async (_request, reply) => {
    reply.header('Cache-Control', 'private, max-age=300')
    return { items: [], count: 0 }
  })

  fastify.get('/fulfillment/outbound', async (_request, reply) => {
    reply.header('Cache-Control', 'private, max-age=300')
    return { items: [], count: 0 }
  })

  fastify.get('/fulfillment/replenishment', async (_request, reply) => {
    reply.header('Cache-Control', 'private, max-age=300')
    return { items: [], count: 0 }
  })

  fastify.get('/fulfillment/carriers', async (_request, reply) => {
    reply.header('Cache-Control', 'private, max-age=300')
    return { items: [], count: 0 }
  })

  fastify.get('/fulfillment/returns', async (_request, reply) => {
    reply.header('Cache-Control', 'private, max-age=300')
    return { items: [], count: 0 }
  })
}

export default fulfillmentRoutes
