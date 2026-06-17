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
  getFeeImpact,
  getRealReferralRateResolver,
  getRealCombinedRateByMarketplace,
} from '../services/amazon-real-fees.service.js'
import { runTrueProfitRollupOnce } from '../services/advertising/true-profit-rollup.service.js'
import { logger } from '../utils/logger.js'

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

  // R1.4a — read-only before/after: profit-fees at the assumed 15% vs the
  // real per-SKU rate. Shows the impact before R1.4b flips the live calc.
  fastify.get<{ Querystring: { days?: string; limit?: string } }>(
    '/amazon/economics/fee-impact',
    async (request) =>
      getFeeImpact(
        clampDays(request.query?.days),
        request.query?.limit
          ? Math.min(Math.max(parseInt(request.query.limit, 10) || 15, 1), 100)
          : 15,
      ),
  )

  // R1.4b — the real referral rate the profit rollup now uses (resolver).
  fastify.get<{ Querystring: { days?: string } }>(
    '/amazon/economics/referral-rates',
    async (request) => {
      const r = await getRealReferralRateResolver(clampDays(request.query?.days))
      return {
        overallPct: r.overallPct,
        byMarketplace: r.byMarketplace,
        sampleSkus: r.sampleSkus,
      }
    },
  )

  // R1.4c — the real combined Amazon fee rate the P&L (insights-profit) uses.
  fastify.get<{ Querystring: { days?: string } }>(
    '/amazon/economics/combined-rates',
    async (request) => {
      const r = await getRealCombinedRateByMarketplace(
        clampDays(request.query?.days),
      )
      return { blendedPct: r.blendedPct, byMarketplace: r.byMarketplace }
    },
  )

  // R1.4b-backfill — re-roll historical ProductProfitDaily so PAST profit
  // numbers pick up the real fees (the daily cron only does yesterday).
  // Fire-and-forget: a wide range takes a while; returns immediately.
  fastify.post<{ Querystring: { days?: string } }>(
    '/amazon/economics/profit-backfill',
    async (request) => {
      const days = clampDays(request.query?.days)
      const today = new Date()
      today.setUTCHours(0, 0, 0, 0)
      const fromDate = new Date(today.getTime() - days * 86_400_000)
      const toDate = new Date(today.getTime() - 1)
      void runTrueProfitRollupOnce({ fromDate, toDate })
        .then((s) =>
          logger.info('profit-backfill done', {
            rows: s.rowsUpserted,
            dates: s.datesProcessed.length,
          }),
        )
        .catch((err) =>
          logger.error('profit-backfill failed', {
            err: err instanceof Error ? err.message : String(err),
          }),
        )
      return {
        started: true,
        days,
        fromDate: fromDate.toISOString().slice(0, 10),
        toDate: toDate.toISOString().slice(0, 10),
      }
    },
  )
}

export default amazonEconomicsRoutes
