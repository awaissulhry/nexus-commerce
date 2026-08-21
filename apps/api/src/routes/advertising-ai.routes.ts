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
    const KINDS = ['approve', 'dismiss', 'restore', 'mute']
    const body = (request.body ?? {}) as { ops?: Array<{ id?: unknown; kind?: unknown }> }
    const ops = (body.ops ?? []).filter(
      (o): o is { id: string; kind: 'approve' | 'dismiss' | 'restore' | 'mute' } =>
        typeof o?.id === 'string' && typeof o?.kind === 'string' && KINDS.includes(o.kind),
    )
    if (!ops.length) { reply.status(400); return { error: 'ops[] with {id, kind: approve|dismiss|restore|mute} required' } }
    const { bulkDecide } = await import('../services/advertising/autopilot/decisions.js')
    return bulkDecide(ops)
  })

  /**
   * SG.9 — the A.I. Muted view: campaigns the plans have been told to stop proposing for.
   * The campaigns keep running; only the proposing stopped (H10's "Pausing Suggestions").
   */
  fastify.get('/advertising/ai-decisions/mutes', async () => {
    const { listAiMutes } = await import('../services/advertising/autopilot/decisions.js')
    return listAiMutes()
  })

  fastify.delete('/advertising/ai-decisions/mutes/:campaignId', async (request, reply) => {
    const { campaignId } = request.params as { campaignId: string }
    const { unmuteAiCampaign } = await import('../services/advertising/autopilot/decisions.js')
    const res = await unmuteAiCampaign(campaignId)
    if (!res.ok) reply.status(409)
    return res
  })

  /**
   * SG.9 — the Recommendations tab's third verb. The feed is COMPUTED, so there is no row to
   * mark: the mute is keyed on the recommendation's deterministic id and `buildRecommendations`
   * drops it from the feed (and from the counts, so the totals describe what is on screen).
   */
  fastify.post('/advertising/recommendation-mutes', async (request, reply) => {
    const b = (request.body ?? {}) as { id?: unknown; label?: unknown }
    if (typeof b.id !== 'string' || !b.id) { reply.status(400); return { error: 'id required' } }
    const prisma = (await import('../db.js')).default
    await prisma.adsSuggestionMute.upsert({
      where: { scope_entityType_entityId: { scope: 'recommendations', entityType: 'RECOMMENDATION', entityId: b.id } },
      create: {
        scope: 'recommendations', entityType: 'RECOMMENDATION', entityId: b.id,
        entityName: typeof b.label === 'string' ? b.label.slice(0, 300) : null,
        reason: 'muted from the Recommendations tab', createdBy: 'operator',
      },
      update: {},
    })
    return { ok: true }
  })

  /** The Recommendations Muted view — the same feed, filtered to what was silenced. */
  fastify.get('/advertising/recommendations-muted', async (request, reply) => {
    const { buildRecommendations } = await import('../services/advertising/ads-recommendations.service.js')
    reply.header('Cache-Control', 'private, max-age=30')
    return buildRecommendations({ includeMuted: true })
  })

  fastify.delete('/advertising/recommendation-mutes/:id', async (request) => {
    const { id } = request.params as { id: string }
    const prisma = (await import('../db.js')).default
    const { count } = await prisma.adsSuggestionMute.deleteMany({
      where: { scope: 'recommendations', entityType: 'RECOMMENDATION', entityId: decodeURIComponent(id) },
    })
    return { ok: count > 0, removed: count }
  })
}

export default advertisingAiRoutes
