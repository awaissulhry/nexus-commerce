/**
 * R1 — Amazon economics endpoints (docs/AMAZON_DATA_STRATEGY.md).
 *
 *   GET /api/amazon/economics/fee-rates?days=90
 *     — the REAL Amazon fee rate from financial events (vs the assumed 15%).
 *
 * Read-only. R1.2–R1.4 add per-SKU attribution + settlement storage fees.
 */

import type { FastifyPluginAsync } from 'fastify'
import { getRealAmazonFeeRates } from '../services/amazon-real-fees.service.js'

const amazonEconomicsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Querystring: { days?: string } }>(
    '/amazon/economics/fee-rates',
    async (request) => {
      const days = request.query?.days
        ? Math.min(Math.max(parseInt(request.query.days, 10) || 90, 1), 365)
        : 90
      return getRealAmazonFeeRates(days)
    },
  )
}

export default amazonEconomicsRoutes
