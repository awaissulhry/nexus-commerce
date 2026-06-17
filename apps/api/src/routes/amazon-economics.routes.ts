/**
 * R1 — Amazon economics endpoints (docs/AMAZON_DATA_STRATEGY.md).
 *
 *   GET /api/amazon/economics/fee-rates?days=90
 *     — the REAL Amazon fee rate from financial events (vs the assumed 15%).
 *
 * Read-only. R1.2–R1.4 add per-SKU attribution + settlement storage fees.
 */

import type { FastifyPluginAsync } from 'fastify'
import {
  getRealAmazonFeeRates,
  getRealFeeRatesBySku,
} from '../services/amazon-real-fees.service.js'

const clampDays = (raw?: string) =>
  raw ? Math.min(Math.max(parseInt(raw, 10) || 90, 1), 365) : 90

const amazonEconomicsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Querystring: { days?: string } }>(
    '/amazon/economics/fee-rates',
    async (request) => getRealAmazonFeeRates(clampDays(request.query?.days)),
  )

  // R1.2 — per-SKU real fee rate (allocated from each order's actual fees).
  fastify.get<{
    Querystring: { days?: string; limit?: string; productId?: string }
  }>('/amazon/economics/fee-rates/by-sku', async (request) =>
    getRealFeeRatesBySku(clampDays(request.query?.days), {
      productId: request.query?.productId,
      limit: request.query?.limit
        ? Math.min(Math.max(parseInt(request.query.limit, 10) || 50, 1), 500)
        : 50,
    }),
  )
}

export default amazonEconomicsRoutes
