/**
 * Phase 26: Orders API Routes
 * Cross-channel order management endpoints
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { logger } from '../utils/logger.js'
import {
  ingestMockOrders,
  getOrders,
  shipOrder,
} from '../services/order-ingestion.service.js'
import prisma from '../db.js'

export async function ordersRoutes(app: FastifyInstance) {
  /**
   * POST /api/orders/ingest
   * Trigger mock order ingestion from multiple channels
   */
  app.post('/api/orders/ingest', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      logger.info('[ORDERS API] Ingesting mock orders...')

      const stats = await ingestMockOrders()

      reply.status(200).send({
        success: true,
        message: 'Mock orders ingested successfully',
        data: stats,
      })
    } catch (error: any) {
      logger.error('[ORDERS API] Error ingesting orders', { message: error.message, code: error.code, meta: error.meta })
      reply.status(500).send({
        success: false,
        error: error.message,
        code: error.code,
        meta: error.meta,
      })
    }
  })

  /**
   * GET /api/orders
   * Fetch all orders with pagination
   */
  /**
   * GET /api/orders/stats
   * Counts grouped by status — used by the orders StatsBar.
   * 30s cache.
   */
  app.get('/api/orders/stats', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      reply.header('Cache-Control', 'private, max-age=30')
      const [total, pending, shipped, cancelled, delivered] = await Promise.all([
        prisma.order.count(),
        prisma.order.count({ where: { status: 'PENDING' } }),
        prisma.order.count({ where: { status: 'SHIPPED' } }),
        prisma.order.count({ where: { status: 'CANCELLED' } }),
        prisma.order.count({ where: { status: 'DELIVERED' } }),
      ])
      const last = await prisma.order.findFirst({
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      })
      reply.send({
        total,
        pending,
        shipped,
        cancelled,
        delivered,
        lastOrderAt: last?.createdAt ?? null,
      })
    } catch (error: any) {
      logger.error('[ORDERS API] stats failed', { message: error.message })
      reply
        .status(500)
        .send({ success: false, error: error?.message ?? 'Unknown error' })
    }
  })

  app.get('/api/orders', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const page = parseInt((request.query as any).page as string) || 1
      const limit = parseInt((request.query as any).limit as string) || 20

      logger.info('[ORDERS API] Fetching orders', { page, limit })

      const result = await getOrders(page, limit)

      reply.status(200).send({
        success: true,
        data: result,
      })
    } catch (error: any) {
      logger.error('[ORDERS API] Error fetching orders', { message: error.message, code: error.code, meta: error.meta })
      reply.status(500).send({
        success: false,
        error: error.message,
        code: error.code,
        meta: error.meta,
      })
    }
  })

  /**
   * PATCH /api/orders/:id/ship
   * Update order status to SHIPPED
   */
  app.patch('/api/orders/:id/ship', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { id } = request.params as { id: string }

      logger.info('[ORDERS API] Shipping order', { orderId: id })

      const order = await shipOrder(id)

      reply.status(200).send({
        success: true,
        message: 'Order marked as shipped',
        data: order,
      })
    } catch (error: any) {
      logger.error('[ORDERS API] Error shipping order:', error.message)
      reply.status(500).send({
        success: false,
        error: error.message,
      })
    }
  })
}
