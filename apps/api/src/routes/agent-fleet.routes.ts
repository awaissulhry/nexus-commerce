/**
 * NAF.A — fleet routes (docs/AGENT_FLEET.md Part 12 § A). Mounted under
 * /api/agent/fleet/* so the existing permissions-manifest entry for
 * `/api/agent/` (ai.view / ai.run) covers them with zero manifest changes
 * (plan D4). Thin by design — the services carry the logic and the tests.
 *
 * Read-only except: the halt toggle, the charter seed, and the manual
 * run-now (which deliberately ignores `enabled`, mirroring the existing
 * autonomous agents' Run-now).
 */
import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'
import { isAiKillSwitchOn } from '../services/ai/providers/index.js'
import { isAutonomyLevel, AUTONOMY_LEVELS } from '../services/advertising/ads-autonomy.js'
import { decideApproval } from '../services/agents/approval-gate.service.js'
import { executeCharter } from '../services/agent-fleet/agent-executor.js'
import { mintExemplarFromDecision } from '../services/agent-fleet/exemplar.service.js'
import { isAutoPromotionAllowed } from '../services/agent-fleet/promotion.service.js'
import {
  bustCharterCache,
  FLEET_CHARTERS,
  listCharters,
  seedCharters,
} from '../services/agent-fleet/charter-registry.js'
import { FLEET_GRAPH } from '../services/agent-fleet/fleet-graph.js'
import {
  getFleetState,
  haltFleet,
  resumeFleet,
} from '../services/agent-fleet/fleet-state.service.js'
import { collectRefs, resolveFleetLabels } from '../services/agent-fleet/fleet-labels.service.js'
import { getFleetSchedule } from '../services/agent-fleet/fleet-schedule.service.js'
import { getRunTrace } from '../services/agent-fleet/fleet-trace.service.js'
import { getSweepReport } from '../services/agent-fleet/sweep-report.service.js'

const agentFleetRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/agent/fleet/charters', async () => {
    return { charters: await listCharters() }
  })

  fastify.get<{
    Querystring: { charterKey?: string; mode?: string; limit?: string }
  }>('/agent/fleet/runs', async (request) => {
    const { charterKey, mode, limit } = request.query
    const take = Math.min(Number(limit) || 50, 100)
    const runs = await prisma.agentRun.findMany({
      where: {
        mode: mode ? mode : { not: null }, // fleet runs are mode NOT NULL
        ...(charterKey ? { agentKey: charterKey } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take,
    })
    return { runs }
  })

  fastify.get<{
    Querystring: {
      status?: string
      domain?: string
      charterKey?: string
      limit?: string
    }
  }>('/agent/fleet/findings', async (request) => {
    const { status, domain, charterKey, limit } = request.query
    const take = Math.min(Number(limit) || 100, 200)
    const findings = await prisma.agentFinding.findMany({
      where: {
        ...(status ? { status } : {}),
        ...(domain ? { domain } : {}),
        ...(charterKey ? { charterKey } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take,
    })
    // FX.1 — names, not IDs: one label map for the whole page load.
    const labels = await resolveFleetLabels(collectRefs({ findings }))
    return { findings, labels }
  })

  fastify.get('/agent/fleet/plans', async () => {
    const plans = await prisma.agentPlan.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
    })
    // FX.1 — one label map covering every item and dropped item across the
    // returned plans, resolved server-side.
    const allItems = plans.flatMap((p) => [
      ...((p.items as Array<{ args?: unknown }> | null) ?? []),
      ...((p.droppedItems as Array<{ args?: unknown }> | null) ?? []),
    ])
    const labels = await resolveFleetLabels(collectRefs({ items: allItems }))
    return { plans, labels }
  })

  fastify.get('/agent/fleet/graph', async () => {
    const charters = await listCharters()
    const byKey = new Map(charters.map((c) => [c.key, c]))
    return {
      nodes: FLEET_GRAPH.nodes.map((n) => {
        const c = byKey.get(n.key)
        return {
          ...n,
          enabled: c?.enabled ?? false,
          autonomyLevel: c?.autonomyLevel ?? 'OFF',
          degraded: c?.degraded ?? true,
        }
      }),
      edges: FLEET_GRAPH.edges,
    }
  })

  fastify.get('/agent/fleet/state', async () => {
    return getFleetState()
  })

  // NAF.D — the run's step trace, reading BOTH shapes (the recorded D12
  // obligation): AgentStep rows for fleet runs, the legacy steps Json for
  // ACP copilot runs.
  fastify.get<{ Params: { id: string } }>(
    '/agent/fleet/runs/:id/steps',
    async (request, reply) => {
      const run = await prisma.agentRun.findUnique({
        where: { id: request.params.id },
        select: { id: true, mode: true, steps: true },
      })
      if (!run) return reply.code(404).send({ error: 'run not found' })
      if (run.mode != null) {
        const steps = await prisma.agentStep.findMany({
          where: { agentRunId: run.id },
          orderBy: { seq: 'asc' },
        })
        return { shape: 'agent-step', steps }
      }
      return { shape: 'legacy-json', steps: run.steps ?? [] }
    },
  )

  // FX.1 — the run told as a story: labelled steps, evidence previews,
  // the validated output, the findings written, tokens and cost per step.
  fastify.get<{ Params: { id: string } }>(
    '/agent/fleet/runs/:id/trace',
    async (request, reply) => {
      const trace = await getRunTrace(request.params.id)
      if (!trace) return reply.code(404).send({ error: 'run not found' })
      return trace
    },
  )

  // FX.1 — E1's nightly scorecards, queryable per charter.
  fastify.get<{ Querystring: { charterKey?: string; limit?: string } }>(
    '/agent/fleet/scorecards',
    async (request) => {
      const take = Math.min(Number(request.query.limit) || 60, 200)
      const scorecards = await prisma.agentScorecard.findMany({
        where: request.query.charterKey ? { charterKey: request.query.charterKey } : {},
        orderBy: { periodEnd: 'desc' },
        take,
      })
      return {
        scorecards: scorecards.map((s) => ({
          ...s,
          windowDays: Math.round(
            (s.periodEnd.getTime() - s.periodStart.getTime()) / (24 * 3600_000),
          ),
        })),
      }
    },
  )

  // FX.1 — when does the fleet run next, and how did the last runs go.
  fastify.get('/agent/fleet/schedule', async () => {
    return getFleetSchedule()
  })

  // NAF.B — the 14-sweep acceptance evidence: per-sweep validation/cost
  // stats, dedupeKey stability, agent-vs-engine agreement.
  fastify.get<{ Querystring: { limit?: string } }>(
    '/agent/fleet/sweeps',
    async (request) => {
      const limit = Math.min(Number(request.query.limit) || 30, 60)
      return getSweepReport(limit)
    },
  )

  fastify.post<{ Body: { reason?: string } }>(
    '/agent/fleet/state/halt',
    async (request, reply) => {
      const reason = (request.body?.reason ?? '').trim()
      if (!reason) return reply.code(400).send({ error: 'reason is required' })
      return haltFleet(reason, 'operator')
    },
  )

  fastify.post('/agent/fleet/state/resume', async () => {
    return resumeFleet('operator')
  })

  fastify.post('/agent/fleet/charters/seed', async () => {
    return seedCharters()
  })

  // NAF.D — the operator's charter policy control (dial #4, cap #5).
  // The cap is enforced HERE, server-side: a request above the code
  // charter's autonomyCap is refused, not clamped — the operator should
  // know the ceiling exists, not silently get less than they asked.
  fastify.patch<{
    Params: { key: string }
    Body: { enabled?: boolean; autonomyLevel?: string }
  }>('/agent/fleet/charters/:key', async (request, reply) => {
    const { key } = request.params
    const def = FLEET_CHARTERS[key]
    if (!def) return reply.code(404).send({ error: `unknown charter: ${key}` })
    const data: Record<string, unknown> = {}
    if (request.body?.enabled !== undefined) data.enabled = !!request.body.enabled
    if (request.body?.autonomyLevel !== undefined) {
      const level = request.body.autonomyLevel
      if (!isAutonomyLevel(level)) {
        return reply.code(400).send({ error: `invalid autonomyLevel "${level}"` })
      }
      const capIdx = AUTONOMY_LEVELS.indexOf(def.autonomyCap)
      if (AUTONOMY_LEVELS.indexOf(level) > capIdx) {
        return reply.code(400).send({
          error: `autonomyLevel ${level} exceeds this charter's cap (${def.autonomyCap})`,
        })
      }
      // NAF.E — the promotion gate is server-side (spec acceptance): AUTO
      // requires an eligible latest scorecard. The PATCH itself is the
      // operator sign-off; eligibility is the earned half.
      if (level === 'AUTO' && !(await isAutoPromotionAllowed(key))) {
        return reply.code(403).send({
          error:
            `${key} has not earned AUTO — the latest scorecard is not promotion-eligible ` +
            `(Part 7: 30 days + acceptance ≥70% + calibration ≤0.15 + zero rollbacks)`,
        })
      }
      data.autonomyLevel = level
    }
    if (Object.keys(data).length === 0) {
      return reply.code(400).send({ error: 'nothing to update' })
    }
    const updated = await prisma.agentCharter.updateMany({
      where: { key, version: def.version },
      data,
    })
    if (updated.count === 0) {
      return reply.code(404).send({ error: `charter ${key} v${def.version} not seeded — POST /agent/fleet/charters/seed first` })
    }
    bustCharterCache()
    return { ok: true, charters: await listCharters() }
  })

  // NAF.D — the fleet approval inbox (control #15).
  const FLEET_TOOLS = ['create-negative-keyword', 'graduate-keyword', 'set-target-bid']

  fastify.get<{ Querystring: { status?: string } }>(
    '/agent/fleet/approvals',
    async (request) => {
      const status = request.query.status ?? 'pending'
      const approvals = await prisma.agentApproval.findMany({
        where: { toolName: { in: FLEET_TOOLS }, ...(status ? { status } : {}) },
        orderBy: { requestedAt: 'desc' },
        take: 100,
      })
      const runs = await prisma.agentRun.findMany({
        where: { id: { in: approvals.map((a) => a.agentRunId) } },
        select: { id: true, agentKey: true, orchestrationId: true },
      })
      const runById = new Map(runs.map((r) => [r.id, r]))
      // FX.1 — resolve the entities each approval touches.
      const labels = await resolveFleetLabels(
        collectRefs({ items: approvals.map((a) => ({ args: a.args })) }),
      )
      return {
        approvals: approvals.map((a) => ({
          ...a,
          charterKey: runById.get(a.agentRunId)?.agentKey ?? null,
          orchestrationId: runById.get(a.agentRunId)?.orchestrationId ?? null,
        })),
        labels,
      }
    },
  )

  fastify.post<{
    Params: { id: string }
    Body: { decision: 'approve' | 'reject'; reason?: string }
  }>('/agent/fleet/approvals/:id/decide', async (request, reply) => {
    const decision = request.body?.decision
    const reason = (request.body?.reason ?? '').trim()
    if (decision !== 'approve' && decision !== 'reject') {
      return reply.code(400).send({ error: 'decision must be approve or reject' })
    }
    // A rejection without a reason is a wasted datapoint — the reject
    // reason is the highest-value exemplar input (spec Part 10).
    if (decision === 'reject' && !reason) {
      return reply.code(400).send({ error: 'a one-line reason is required to reject' })
    }
    const out = await decideApproval(request.params.id, decision, 'operator', reason || undefined)
    if (!out.ok) return reply.code(409).send(out)
    // NAF.E — every decision becomes a precedent. A minting failure must
    // not fail the decision that already committed.
    await mintExemplarFromDecision(request.params.id, decision, reason || undefined).catch(
      (err) => fastify.log.error({ err }, 'exemplar minting failed'),
    )
    return out
  })

  fastify.post<{ Body: { charterKey?: string; reason?: string } }>(
    '/agent/fleet/approvals/reject-all',
    async (request, reply) => {
      const charterKey = (request.body?.charterKey ?? '').trim()
      const reason = (request.body?.reason ?? '').trim()
      if (!charterKey || !reason) {
        return reply.code(400).send({ error: 'charterKey and reason are required' })
      }
      const runs = await prisma.agentRun.findMany({
        where: { agentKey: charterKey },
        select: { id: true },
      })
      const pending = await prisma.agentApproval.findMany({
        where: {
          status: 'pending',
          toolName: { in: FLEET_TOOLS },
          agentRunId: { in: runs.map((r) => r.id) },
        },
        select: { id: true },
      })
      let rejected = 0
      for (const p of pending) {
        const out = await decideApproval(p.id, 'reject', 'operator', reason)
        if (out.ok) {
          rejected++
          await mintExemplarFromDecision(p.id, 'reject', reason).catch((err) =>
            fastify.log.error({ err }, 'exemplar minting failed'),
          )
        }
      }
      return { ok: true, rejected, of: pending.length }
    },
  )

  fastify.post<{ Params: { key: string } }>(
    '/agent/fleet/run/:key',
    async (request, reply) => {
      const { key } = request.params
      if (isAiKillSwitchOn()) {
        return reply
          .code(503)
          .send({ error: 'AI is temporarily disabled (kill switch).' })
      }
      if (!FLEET_CHARTERS[key]) {
        return reply.code(404).send({ error: `unknown charter: ${key}` })
      }
      const result = await executeCharter(key, {
        trigger: 'manual',
        mode: 'ask',
        ignoreEnabled: true,
      })
      if (!result.ok && result.error) {
        return reply.code(500).send(result)
      }
      return result
    },
  )
}

export default agentFleetRoutes
