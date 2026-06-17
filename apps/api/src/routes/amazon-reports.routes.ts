/**
 * R0.2 — Amazon Reports registry endpoints (docs/AMAZON_DATA_STRATEGY.md).
 *
 *   GET  /api/amazon/reports          — freshness overview (catalog ⨝ latest run)
 *   GET  /api/amazon/reports/runs     — recent pull history (optional ?reportType=)
 *   POST /api/amazon/reports/backfill — seed day-one freshness from cron history
 *
 * Feeds the Reports hub UI (R0.3). All read-only except backfill, which is
 * idempotent.
 */

import type { FastifyPluginAsync } from 'fastify'
import {
  getReportFreshnessOverview,
  listReportRuns,
  backfillRegistry,
} from '../services/amazon-report-registry.service.js'

const amazonReportsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/amazon/reports', async () => ({
    reports: await getReportFreshnessOverview(),
  }))

  fastify.get<{ Querystring: { reportType?: string; limit?: string } }>(
    '/amazon/reports/runs',
    async (request) => ({
      runs: await listReportRuns({
        reportType: request.query?.reportType,
        limit: request.query?.limit
          ? parseInt(request.query.limit, 10)
          : undefined,
      }),
    }),
  )

  fastify.post('/amazon/reports/backfill', async () => backfillRegistry())
}

export default amazonReportsRoutes
