/**
 * CE.4 — Smart Order Routing routes.
 *
 *   POST /api/orders/simulate-routing — dry-run routing for an order
 *     payload without committing; returns decision + score breakdown.
 *
 *   GET /api/orders/routing-log — recent RoutingDecision rows with method
 *     + score breakdown for operator visibility.
 */

import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'
import {
  resolveWarehouseForOrder,
  type RouteOrderInput,
} from '../services/order-routing.service.js'

const ordersRoutingRoutes: FastifyPluginAsync = async (fastify) => {
  // ── Simulate routing ───────────────────────────────────────────────────────
  fastify.post('/orders/simulate-routing', async (req, reply) => {
    const body = req.body as {
      channel?: string | null
      marketplace?: string | null
      shippingCountry?: string | null
    }

    const input: RouteOrderInput = {
      channel: body.channel ?? null,
      marketplace: body.marketplace ?? null,
      shippingCountry: body.shippingCountry ?? null,
    }

    const result = await resolveWarehouseForOrder(input)

    // Resolve warehouse name for display
    let warehouseName: string | null = null
    if (result.warehouseId) {
      const wh = await prisma.warehouse.findUnique({
        where: { id: result.warehouseId },
        select: { name: true, code: true, country: true },
      })
      warehouseName = wh ? `${wh.name} (${wh.code})` : null
    }

    return {
      simulation: true,
      input,
      warehouseId: result.warehouseId,
      warehouseName,
      method: result.source,
      ruleId: result.ruleId,
      ruleName: result.ruleName,
      scoreSummary: result.scoreSummary ?? null,
    }
  })

  // ── Routing log ────────────────────────────────────────────────────────────
  fastify.get('/orders/routing-log', async (req) => {
    const { limit = '50', method } = req.query as {
      limit?: string
      method?: string
    }

    const where = method ? { method } : {}

    const decisions = await prisma.routingDecision.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(parseInt(limit, 10) || 50, 200),
      select: {
        id: true,
        orderId: true,
        warehouseId: true,
        method: true,
        ruleId: true,
        scoreSummary: true,
        createdAt: true,
        order: {
          select: {
            channel: true,
            marketplace: true,
            channelOrderId: true,
            customerName: true,
            shippingAddress: true,
          },
        },
      },
    })

    return { decisions }
  })
}

export default ordersRoutingRoutes
