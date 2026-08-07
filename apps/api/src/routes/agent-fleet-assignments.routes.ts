/**
 * NAF.SB.AS — assignments: one worker, one target, one job.
 *
 * Its own file, not `agent-fleet.routes.ts`, per the session-locks protocol:
 * that file is 771 lines and shared, a duplicate route path there is a boot
 * crash, and one-line conflicts in `index.ts` merge where 771-line ones do
 * not.
 *
 * RBAC: everything under `/api/agent/` is already covered by the manifest's
 * prefix rule (`RW(F.aiView, F.aiRun, pfx('/api/agent/'))`), so these routes
 * inherit ai.view / ai.run with no manifest change.
 *
 * Start deliberately calls `executeCharter` DIRECTLY rather than reusing
 * `POST /agent/fleet/run/:key`: that route gates on `FLEET_CHARTERS[key]` and
 * therefore 404s for every W.8 worker instance — exactly the workers an
 * operator most recently created.
 */
import type { FastifyPluginAsync } from 'fastify'
import {
  createAssignment,
  deleteAssignment,
  getAssignment,
  listAssignableWorkers,
  listAssignablePortfolios,
  listAssignments,
  setAssignmentState,
  startAssignment,
} from '../services/agent-fleet/assignment.service.js'
import {
  measurePreflight,
  staticPreflight,
} from '../services/agent-fleet/assignment-preflight.service.js'
import type { AssignmentTarget } from '../services/agent-fleet/assignment-scope.js'

interface CreateBody {
  charterKey?: string
  targetKind?: 'CAMPAIGN' | 'MARKETPLACE' | 'PORTFOLIO' | null
  targetIds?: string[]
  targetLabels?: string[]
  wantBack?: string | null
  dueAt?: string | null
  title?: string
}

const agentFleetAssignmentRoutes: FastifyPluginAsync = async (fastify) => {
  /** Who may be assigned, to what, and — when they may not — why not. */
  fastify.get('/agent/fleet/assignable-workers', async () => {
    return { workers: await listAssignableWorkers() }
  })

  fastify.get<{ Querystring: { charterKey?: string } }>(
    '/agent/fleet/assignments',
    async (req) => {
      return { assignments: await listAssignments({ charterKey: req.query.charterKey }) }
    },
  )

  /**
   * NAF.SB.AS.2 — portfolios that can actually be assigned.
   *
   * Derived from `Campaign.portfolioId` rather than proxying
   * `/advertising/portfolios`, for two reasons: that route calls Amazon live
   * on every request, and it lists portfolios that may hold no campaigns —
   * which the picker would offer and `resolveAssignmentScope` would then
   * refuse with `target_gone`. Offering only what resolves is the same
   * discipline as the worker picker.
   *
   * The path is `assignment-portfolios`, NOT `assignments/portfolios`: the
   * latter would match `/assignments/:id` and be read as an assignment whose
   * id is the word "portfolios".
   */
  fastify.get('/agent/fleet/assignment-portfolios', async () => {
    return { portfolios: await listAssignablePortfolios() }
  })

  /**
   * NAF.SB.AS.3 — the pre-flight, in two halves that are honest about cost.
   *
   * GET (static): no scans, no model, no writes. Safe on every keystroke.
   * POST (measured): builds real evidence through the SHARED cache — no model
   * and no run row, but it does real database work, which is why it is a
   * deliberate button rather than something that happens while you type.
   *
   * Paths avoid `assignments/...` on purpose: that prefix would match
   * `/assignments/:id` and be read as an assignment whose id is "preflight".
   */
  fastify.get<{
    Querystring: { charterKey?: string; targetKind?: string; targetIds?: string; targetLabels?: string }
  }>('/agent/fleet/assignment-preflight', async (req, reply) => {
    const q = req.query
    if (!q.charterKey) return reply.code(400).send({ error: 'charterKey is required' })
    const out = await staticPreflight(q.charterKey, parseTarget(q))
    if (!out) return reply.code(404).send({ error: 'unknown worker' })
    return out
  })

  fastify.post<{
    Body: { charterKey?: string; targetKind?: string; targetIds?: string[]; targetLabels?: string[] }
  }>('/agent/fleet/assignment-preflight-measure', async (req, reply) => {
    const b = req.body ?? {}
    if (!b.charterKey) return reply.code(400).send({ error: 'charterKey is required' })
    const target =
      b.targetKind && b.targetIds?.length
        ? ({
            kind: b.targetKind as AssignmentTarget['kind'],
            ids: b.targetIds,
            labels: b.targetLabels ?? [],
          } satisfies AssignmentTarget)
        : null
    return await measurePreflight(b.charterKey, target)
  })

  /**
   * NAF.SB.AS — the label endpoint the Approvals stream consumes so its cards
   * can read "From your assignment: …" in OUR words. Contract settled
   * 2026-08-07 (study §10.2): they never read AgentAssignment directly, and
   * `href` is returned so their card does not hardcode our route shape.
   */
  fastify.get<{ Querystring: { ids?: string } }>(
    '/agent/fleet/assignments/labels',
    async (req, reply) => {
      const ids = (req.query.ids ?? '').split(',').map((s) => s.trim()).filter(Boolean)
      if (ids.length === 0) return { labels: {} }
      if (ids.length > 100) {
        // Rejected, never truncated — a silently short answer is a wrong
        // answer on a surface that gates writes.
        return reply.code(400).send({ error: 'at most 100 ids per call' })
      }
      const rows = await listAssignments()
      const wanted = new Set(ids)
      const labels: Record<string, unknown> = {}
      for (const a of rows) {
        if (!wanted.has(a.id)) continue
        labels[a.id] = {
          label: a.title,
          targetLabel: a.targetLabels.join(', ') || null,
          dueAt: a.dueAt,
          state: a.state,
          href: `/fleet/assignments/${a.id}`,
        }
      }
      return { labels }
    },
  )

  fastify.get<{ Params: { id: string } }>(
    '/agent/fleet/assignments/:id',
    async (req, reply) => {
      const a = await getAssignment(req.params.id)
      if (!a) return reply.code(404).send({ error: 'assignment not found' })
      return a
    },
  )

  fastify.post<{ Body: CreateBody }>('/agent/fleet/assignments', async (req, reply) => {
    const b = req.body ?? {}
    if (!b.charterKey) return reply.code(400).send({ error: 'charterKey is required' })
    const res = await createAssignment({
      charterKey: b.charterKey,
      targetKind: b.targetKind ?? null,
      targetIds: b.targetIds ?? [],
      targetLabels: b.targetLabels ?? [],
      wantBack: b.wantBack ?? null,
      dueAt: b.dueAt ?? null,
      title: b.title,
      createdBy: req.authUser?.email ?? req.authUser?.id ?? null,
    })
    if (!res.ok) return reply.code(400).send({ error: res.error })
    return { id: res.id }
  })

  /** Idempotent: an assignment with a run already open returns that run. */
  fastify.post<{ Params: { id: string } }>(
    '/agent/fleet/assignments/:id/start',
    async (req, reply) => {
      const res = await startAssignment(
        req.params.id,
        req.authUser?.email ?? req.authUser?.id ?? null,
      )
      if (!res.ok && res.error === 'assignment not found') {
        return reply.code(404).send({ error: res.error })
      }
      if (!res.ok && res.error) return reply.code(400).send({ error: res.error })
      return res
    },
  )

  fastify.post<{ Params: { id: string }; Body: { note?: string } }>(
    '/agent/fleet/assignments/:id/close',
    async (req, reply) => {
      const res = await setAssignmentState(req.params.id, 'closed', {
        note: req.body?.note ?? null,
        userId: req.authUser?.email ?? req.authUser?.id ?? null,
      })
      if (!res.ok) return reply.code(400).send({ error: res.error })
      return { ok: true }
    },
  )

  fastify.post<{ Params: { id: string } }>(
    '/agent/fleet/assignments/:id/cancel',
    async (req, reply) => {
      const res = await setAssignmentState(req.params.id, 'cancelled', {
        userId: req.authUser?.email ?? req.authUser?.id ?? null,
      })
      if (!res.ok) return reply.code(400).send({ error: res.error })
      return { ok: true }
    },
  )

  /** Close and Cancel are reversible — which is what lets them apply with no
   *  confirmation dialog without being a trap for a first-time user. */
  fastify.post<{ Params: { id: string } }>(
    '/agent/fleet/assignments/:id/reopen',
    async (req, reply) => {
      const res = await setAssignmentState(req.params.id, 'not_started', {
        userId: req.authUser?.email ?? req.authUser?.id ?? null,
      })
      if (!res.ok) return reply.code(400).send({ error: res.error })
      return { ok: true }
    },
  )

  fastify.delete<{ Params: { id: string } }>(
    '/agent/fleet/assignments/:id',
    async (req, reply) => {
      const res = await deleteAssignment(req.params.id)
      if (!res.ok) return reply.code(400).send({ error: res.error })
      return { ok: true }
    },
  )
}

export default agentFleetAssignmentRoutes

/** Query-string form of a target, shared by the static pre-flight route. */
function parseTarget(q: {
  targetKind?: string
  targetIds?: string
  targetLabels?: string
}): AssignmentTarget | null {
  if (!q.targetKind || !q.targetIds) return null
  const ids = q.targetIds.split(',').map((s) => s.trim()).filter(Boolean)
  if (ids.length === 0) return null
  return {
    kind: q.targetKind as AssignmentTarget['kind'],
    ids,
    labels: (q.targetLabels ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  }
}
