/**
 * IH-series — /api/insights/* route namespace.
 *
 * IH.0 registers:
 *   GET  /api/insights/summary   — KPI strip backing /insights landing
 *   GET  /api/insights/ping      — wiring smoke test
 *
 * Subsequent phases (IH.2 sales, IH.3 profit, IH.4 ads, …) layer
 * additional endpoints onto this namespace. Cache headers mirror the
 * dashboard route family: 30s private cache + 60s stale-while-revalidate
 * so quick navigation between insight tabs feels instant while real
 * mutations propagate within ~2s via SSE.
 */

import type { FastifyPluginAsync } from 'fastify'
import { parseInsightsFilters } from '../services/insights/index.js'
import { computeInsightsSummary } from '../services/insights/insights-summary.service.js'

const insightsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/insights/ping', async (_request, reply) => {
    reply.header('Cache-Control', 'private, max-age=5')
    return { ok: true, ts: new Date().toISOString() }
  })

  fastify.get('/insights/summary', async (request, reply) => {
    reply.header(
      'Cache-Control',
      'private, max-age=30, stale-while-revalidate=60',
    )
    const filters = parseInsightsFilters(request)
    try {
      const summary = await computeInsightsSummary(filters)
      return summary
    } catch (err) {
      request.log.error({ err }, 'insights.summary failed')
      reply.code(500)
      return { error: 'insights_summary_failed' }
    }
  })
}

export default insightsRoutes
