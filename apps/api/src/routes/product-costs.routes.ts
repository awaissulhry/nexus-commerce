/**
 * R4.1 — bulk cost-entry endpoints (docs/AMAZON_DATA_STRATEGY.md).
 *
 *   GET   /api/products/costs   — the cost grid (SKUs + current cost + fee rate)
 *   PATCH /api/products/costs   — bulk-write entered costs
 */

import type { FastifyPluginAsync } from 'fastify'
import { getCostGrid, bulkSetCosts } from '../services/product-costs.service.js'

const productCostsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/products/costs', async () => getCostGrid())

  fastify.patch<{
    Body: { updates?: { productId: string; costPrice: number | null }[] }
  }>('/products/costs', async (request, reply) => {
    const updates = request.body?.updates
    if (!Array.isArray(updates))
      return reply.code(400).send({ error: 'updates[] is required' })
    return bulkSetCosts(updates.slice(0, 5000))
  })
}

export default productCostsRoutes
