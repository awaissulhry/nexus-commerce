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

  // AIAD.4 — evidence for the builder: real converting terms (with metrics + starting bids)
  // and history-backed budget ranges for the selected ASINs.
  fastify.get('/advertising/ai-goals/suggest', async (request, reply) => {
    const q = request.query as { asins?: string; marketplace?: string; limit?: string }
    const { suggestForGoal } = await import('../services/advertising/ai-goal-suggest.service.js')
    reply.header('Cache-Control', 'private, max-age=120')
    return suggestForGoal({
      asins: (q.asins ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      marketplace: q.marketplace ?? null,
      limit: q.limit ? Number(q.limit) : undefined,
    })
  })

  // AIAD.4 — "what will be built": the pure scaffold plan for a builder payload. No writes —
  // materialize executes this same plan (same bid evidence), so the preview cannot drift.
  fastify.post('/advertising/ai-goals/preview', async (request, reply) => {
    const { planGoalScaffold, MaterializeError } = await import('../services/advertising/ai-goal-materialize.service.js')
    const { resolveGoalBids } = await import('../services/advertising/ai-goal-suggest.service.js')
    const body = (request.body ?? {}) as { seedKeywords?: string[]; marketplace?: string | null }
    try {
      const bidOpts = await resolveGoalBids(body.seedKeywords ?? [], body.marketplace)
      return { ok: true, scaffold: planGoalScaffold(request.body as never, bidOpts) }
    } catch (e) {
      if (e instanceof MaterializeError) { reply.status(e.statusCode); return { ok: false, error: e.message } }
      reply.status(500); return { ok: false, error: (e as Error)?.message }
    }
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

  // ── SG.8 — the A.I. Bids tab's verbs (operator ask 2026-08-21) ───────────────────────────
  // The tab was read-only because no decision route existed; these are those routes. Approve
  // executes through applyPlanActions — the SAME engine an AUTO plan uses (write-gated,
  // audited) — so operator approval and autonomy share one implementation. The old list route
  // GET /advertising/suggestions/ai-bids (advertising.routes.ts) is superseded by the list
  // here and is retired by its owning block; /suggestions/count keeps serving the tab pill.

  // status: proposed (default) | applied (incl. the executor's DENIED/SKIPPED history) | dismissed
  fastify.get('/advertising/ai-decisions', async (request) => {
    const q = request.query as { status?: string }
    const { listAiDecisions } = await import('../services/advertising/autopilot/decisions.js')
    return listAiDecisions(q.status ?? 'proposed')
  })

  fastify.post('/advertising/ai-decisions/:id/approve', async (request, reply) => {
    const { id } = request.params as { id: string }
    const { approveDecision } = await import('../services/advertising/autopilot/decisions.js')
    const res = await approveDecision(id)
    if (!res.ok && !res.refused) reply.status(409)
    return res
  })

  fastify.post('/advertising/ai-decisions/:id/dismiss', async (request, reply) => {
    const { id } = request.params as { id: string }
    const { dismissDecision } = await import('../services/advertising/autopilot/decisions.js')
    const res = await dismissDecision(id)
    if (!res.ok) reply.status(409)
    return res
  })

  fastify.post('/advertising/ai-decisions/:id/restore', async (request, reply) => {
    const { id } = request.params as { id: string }
    const { restoreDecision } = await import('../services/advertising/autopilot/decisions.js')
    const res = await restoreDecision(id)
    if (!res.ok) reply.status(409)
    return res
  })

  // The staging bar's [Apply N Changes] — one round trip, per-row outcomes (the W2 lesson:
  // a partial result must name which rows were refused and why, not dissolve into a count).
  fastify.post('/advertising/ai-decisions/bulk', async (request, reply) => {
    const body = (request.body ?? {}) as { ops?: Array<{ id?: unknown; kind?: unknown }> }
    const ops = (body.ops ?? []).filter(
      (o): o is { id: string; kind: 'approve' | 'dismiss' | 'restore' } =>
        typeof o?.id === 'string' && (o?.kind === 'approve' || o?.kind === 'dismiss' || o?.kind === 'restore'),
    )
    if (!ops.length) { reply.status(400); return { error: 'ops[] with {id, kind: approve|dismiss|restore} required' } }
    const { bulkDecide } = await import('../services/advertising/autopilot/decisions.js')
    return bulkDecide(ops)
  })
}

export default advertisingAiRoutes
