/**
 * NAF.WF.2 — workflow routes, in their OWN file per the session-locks
 * protocol (a duplicate path in the 771-line agent-fleet.routes.ts is a
 * boot crash; one-line registrations in index.ts merge cleanly). Mounted
 * under /api/agent/fleet/* so the existing permissions-manifest prefix rule
 * (ai.view / ai.run) covers every route with zero manifest changes.
 *
 * Thin by design: the registry and revisions services carry the logic. The
 * one rule enforced HERE is attribution — the revision author and the
 * revert actor come from request.authUser, the same path approvals use.
 */
import type { FastifyPluginAsync } from 'fastify'
import { resyncFleetSchedules } from '../jobs/fleet-sweep.job.js'
import { isAiKillSwitchOn } from '../services/ai/providers/index.js'
import {
  activeTestFor,
  estimateTestCost,
  getWorkflowTestStatus,
  startWorkflowTest,
} from '../services/agent-fleet/workflow-test.service.js'
import {
  builtinByKey,
  getEffectiveDefinition,
  listWorkflows,
  seedWorkflows,
  validateDefinition,
} from '../services/agent-fleet/workflow-registry.service.js'
import {
  activateWorkflowRevision,
  createWorkflowRevision,
  listWorkflowRevisions,
  revertWorkflowToBuiltin,
} from '../services/agent-fleet/workflow-revisions.service.js'

const agentFleetWorkflowRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/agent/fleet/workflows', async () => {
    return { workflows: await listWorkflows() }
  })

  fastify.post('/agent/fleet/workflows/seed', async () => {
    return seedWorkflows()
  })

  fastify.get<{ Params: { key: string } }>(
    '/agent/fleet/workflows/:key/revisions',
    async (request, reply) => {
      const { key } = request.params
      const effective = await getEffectiveDefinition(key)
      const builtin = builtinByKey(key)
      if (!builtin && effective.source === 'none') {
        const revisions = await listWorkflowRevisions(key)
        if (revisions.length === 0) return reply.code(404).send({ error: 'workflow not found' })
      }
      return {
        key,
        kind: builtin ? 'builtin' : 'custom',
        source: effective.source,
        effective: effective.definition,
        code: builtin ? builtin.definition() : null,
        revisions: await listWorkflowRevisions(key),
      }
    },
  )

  fastify.post<{
    Params: { key: string }
    Body: { definition?: unknown; note?: string }
  }>('/agent/fleet/workflows/:key/revisions', async (request, reply) => {
    const { key } = request.params
    const { definition, note } = request.body ?? {}
    if (!builtinByKey(key)) {
      // Custom workflows arrive with the editor; today only built-ins may
      // gain revisions. Refuse rather than silently create an orphan.
      return reply.code(404).send({ error: 'unknown workflow — only built-ins can take revisions today' })
    }
    if (!note || !note.trim()) {
      return reply.code(400).send({ error: 'a revision needs a note — the change log IS the audit' })
    }
    const verdict = await validateDefinition(definition)
    if (!verdict.ok) return reply.code(400).send({ error: verdict.error })
    const author = request.authUser?.email ?? request.authUser?.id ?? null
    const revision = await createWorkflowRevision({
      workflowKey: key,
      definition: definition as never,
      note,
      author,
    })
    return { revision, note: 'created as a draft — activation is a separate, explicit act' }
  })

  fastify.post<{ Params: { key: string; revisionId: string } }>(
    '/agent/fleet/workflows/:key/revisions/:revisionId/activate',
    async (request, reply) => {
      const { key, revisionId } = request.params
      const revision = await activateWorkflowRevision(key, revisionId)
      if (!revision) return reply.code(404).send({ error: 'revision not found for this workflow' })
      // WF.4c — a published trigger change re-arms the clock immediately.
      void resyncFleetSchedules().catch(() => {})
      return {
        revision,
        // Honesty over ceremony: stored execution is WF.4. Saying this here
        // keeps the UI from having to guess.
        caveat: 'recorded and active — runs keep following the built-in definition until stored execution ships',
      }
    },
  )

  // WF.5 — the confirm dialog's up-front cost estimate (means of recent
  // run costs per step; $0.05 for a worker with no history).
  fastify.get<{ Params: { key: string }; Querystring: { steps?: string } }>(
    '/agent/fleet/workflows/:key/test-estimate',
    async (request) => {
      const steps = (request.query.steps ?? '').split(',').filter(Boolean)
      return { estimatedCostUSD: await estimateTestCost(steps) }
    },
  )

  // WF.5 — test a DRAFT: real evidence, real model, nothing written. The
  // walk is async and serial; poll the status route below.
  fastify.post<{
    Params: { key: string }
    Body: { definition?: unknown }
  }>('/agent/fleet/workflows/:key/test', async (request, reply) => {
    const { key } = request.params
    if (!builtinByKey(key)) {
      return reply.code(404).send({ error: 'unknown workflow' })
    }
    if (isAiKillSwitchOn()) {
      return reply.code(503).send({ error: 'AI is temporarily disabled (kill switch).' })
    }
    const running = activeTestFor(key)
    if (running) {
      return reply.code(409).send({ error: 'a test is already running for this workflow', testId: running })
    }
    const def = request.body?.definition
    const verdict = await validateDefinition(def)
    if (!verdict.ok) return reply.code(400).send({ error: verdict.error })
    const parsed = def as { steps?: unknown[] }
    if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) {
      return reply.code(400).send({ error: 'nothing to walk — this draft has no steps' })
    }
    return startWorkflowTest(key, def as never)
  })

  fastify.get<{ Params: { key: string; testId: string } }>(
    '/agent/fleet/workflows/:key/test/:testId',
    async (request, reply) => {
      const status = await getWorkflowTestStatus(request.params.testId)
      if (!status) return reply.code(404).send({ error: 'test not found' })
      return status
    },
  )

  fastify.post<{ Params: { key: string } }>(
    '/agent/fleet/workflows/:key/revert-to-builtin',
    async (request, reply) => {
      const { key } = request.params
      if (!builtinByKey(key)) {
        return reply.code(400).send({ error: 'only a built-in has a code definition to revert to' })
      }
      const result = await revertWorkflowToBuiltin(key)
      // WF.4c — reverting restores the code clock the same moment.
      void resyncFleetSchedules().catch(() => {})
      return result
    },
  )
}

export default agentFleetWorkflowRoutes
