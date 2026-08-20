/**
 * AIAD — AI Advertising routes: goal materialization + the dashboard metrics rollup.
 * 🔴 A NEW FILE, not `advertising.routes.ts`, on purpose (same reason as
 * keyword-actions.routes.ts): that file carries a parallel session's uncommitted work,
 * and these routes must be committable on their own.
 */
import type { FastifyPluginAsync } from 'fastify'

const advertisingAiRoutes: FastifyPluginAsync = async (fastify) => {
  // AIAD.0 — per-goal + account-level performance rollup for the AI Advertising dashboard.
  fastify.get('/advertising/ai-goals/summary', async (request, reply) => {
    const q = request.query as { start?: string; end?: string; marketplace?: string }
    const { productGoalSummary } = await import('../services/advertising/ai-product-goal.service.js')
    reply.header('Cache-Control', 'private, max-age=60')
    return productGoalSummary({ start: q.start, end: q.end, marketplace: q.marketplace ?? null })
  })

  // AIAD.3 — one goal fully resolved for the drawer (config + campaigns by role + plan).
  fastify.get('/advertising/ai-goals/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const { getProductGoalDetail } = await import('../services/advertising/ai-product-goal.service.js')
    const detail = await getProductGoalDetail(id)
    if (!detail) { reply.status(404); return { error: 'not found' } }
    reply.header('Cache-Control', 'private, max-age=15')
    return detail
  })

  // AIAD.1 — materialize a goal: campaign scaffold + harvest/negate rules + AutopilotPlan.
  fastify.post('/advertising/ai-goals/:id/materialize', async (request, reply) => {
    const { id } = request.params as { id: string }
    const raw = request.headers['x-actor-id']
    const userId = typeof raw === 'string' && raw.length > 0 ? `user:${raw}` : undefined
    const { materializeProductGoal, MaterializeError } = await import('../services/advertising/ai-goal-materialize.service.js')
    try {
      const result = await materializeProductGoal(id, userId)
      return { ok: true, ...result }
    } catch (e) {
      if (e instanceof MaterializeError) { reply.status(e.statusCode); return { ok: false, error: e.message } }
      reply.status(500); return { ok: false, error: (e as Error)?.message }
    }
  })
}

export default advertisingAiRoutes
