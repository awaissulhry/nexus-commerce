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
import prisma from '../db.js'
import { resyncFleetSchedules } from '../jobs/fleet-sweep.job.js'
import { runStoredWorkflow } from '../services/agent-fleet/orchestrator.js'
import { slugifyWorkflowName } from '../services/agent-fleet/workflow-defs.js'
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

  // WF.6a — create a custom workflow. Born with no active revision, which
  // means honestly DISABLED: its floor is "nothing", never a code fallback.
  fastify.post<{ Body: { name?: string; description?: string } }>(
    '/agent/fleet/workflows',
    async (request, reply) => {
      const name = request.body?.name?.trim()
      if (!name) return reply.code(400).send({ error: 'a workflow needs a name' })
      const key = slugifyWorkflowName(name)
      if (!key) return reply.code(400).send({ error: 'that name leaves nothing usable for a key — use letters or digits' })
      if (builtinByKey(key)) {
        return reply.code(409).send({ error: `"${key}" is a built-in routine — pick another name` })
      }
      const existing = await prisma.agentWorkflow.findUnique({ where: { key } })
      if (existing) {
        return reply.code(409).send({ error: `a workflow named "${key}" already exists` })
      }
      const author = request.authUser?.email ?? request.authUser?.id ?? null
      const row = await prisma.agentWorkflow.create({
        data: {
          key,
          name,
          description: request.body?.description?.trim() || null,
          kind: 'custom',
          createdBy: author,
        },
      })
      return { workflow: row, note: 'created with no published wiring — compose and publish from its page' }
    },
  )

  fastify.get<{ Params: { key: string } }>(
    '/agent/fleet/workflows/:key/revisions',
    async (request, reply) => {
      const { key } = request.params
      const builtin = builtinByKey(key)
      const row = await prisma.agentWorkflow.findUnique({ where: { key } })
      // WF.6a — a custom exists the moment its row does, revisions or not;
      // a freshly created workflow must not 404 its own page.
      if (!builtin && !row) return reply.code(404).send({ error: 'workflow not found' })
      const effective = await getEffectiveDefinition(key)
      return {
        key,
        kind: builtin ? 'builtin' : 'custom',
        name: row?.name ?? builtin?.name ?? key,
        description: row?.description ?? builtin?.description ?? null,
        enabled: row?.enabled ?? true,
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
    // WF.6a — any workflow that exists may take revisions: built-ins and
    // customs alike. An orphan key still refuses.
    if (!builtinByKey(key) && !(await prisma.agentWorkflow.findUnique({ where: { key } }))) {
      return reply.code(404).send({ error: 'unknown workflow' })
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
        caveat: 'active — this is the wiring that runs from now on; every run stamps the revision that served it',
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
    // WF.6a — the test lane is key-generic, like the editor it serves.
    if (!builtinByKey(key) && !(await prisma.agentWorkflow.findUnique({ where: { key } }))) {
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

  // WF.6b — Run-now for CUSTOM workflows: a REAL run of the published
  // wiring. OFF workers still skip inside the executor; the fleet gates
  // bind. Built-ins are refused — their clocks and jobs own them. Responds
  // within ~8s: full counts when the walk finished, else "watch Runs".
  fastify.post<{ Params: { key: string } }>(
    '/agent/fleet/workflows/:key/run',
    async (request, reply) => {
      const { key } = request.params
      if (builtinByKey(key)) {
        return reply.code(400).send({ error: 'built-ins run on their own clocks and jobs — Run-now is for custom routines' })
      }
      const row = await prisma.agentWorkflow.findUnique({ where: { key } })
      if (!row) return reply.code(404).send({ error: 'unknown workflow' })
      if (isAiKillSwitchOn()) {
        return reply.code(503).send({ error: 'AI is temporarily disabled (kill switch).' })
      }
      const walk = runStoredWorkflow(key, { trigger: 'manual' })
      const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 8000))
      const result = await Promise.race([walk, timeout])
      // Never orphan the promise — its settlement is already handled.
      void walk.catch(() => {})
      if (result === null) {
        return { pending: true, note: 'running — watch the Runs section on this page' }
      }
      return result
    },
  )

  // WF.6d — the operator's off switch on a CUSTOM routine. Turning it off
  // disarms its clock the same moment (resync arms only enabled customs) and
  // makes runStoredWorkflow refuse with workflow_disabled; the wiring and its
  // revisions are untouched. Built-ins ride the fleet clock and the workers'
  // dials instead — refusing them here keeps this from becoming a second,
  // phantom kill switch.
  fastify.post<{ Params: { key: string }; Body: { enabled?: boolean } }>(
    '/agent/fleet/workflows/:key/enabled',
    async (request, reply) => {
      const { key } = request.params
      const enabled = request.body?.enabled
      if (typeof enabled !== 'boolean') {
        return reply.code(400).send({ error: 'body.enabled must be true or false' })
      }
      if (builtinByKey(key)) {
        return reply.code(400).send({ error: 'a built-in rides the fleet clock and its workers’ dials — this switch is for custom routines' })
      }
      const row = await prisma.agentWorkflow.findUnique({ where: { key } })
      if (!row) return reply.code(404).send({ error: 'unknown workflow' })
      if (row.enabled !== enabled) {
        await prisma.agentWorkflow.update({ where: { key }, data: { enabled } })
        void resyncFleetSchedules().catch(() => {})
      }
      return { key, enabled }
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
