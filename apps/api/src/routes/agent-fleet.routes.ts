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
import {
  getEntityGraphOverview,
  getEntityNeighborhood,
} from '../services/agent-fleet/entity-graph.service.js'
import { evaluateRevision, latestEvalFor } from '../services/agent-fleet/charter-eval.service.js'
import {
  activateRevision,
  compareAbArms,
  createRevision,
  diffPrompts,
  getActiveRevision,
  listRevisions,
  revertToCode,
} from '../services/agent-fleet/charter-revisions.service.js'
import {
  listControlAudit,
  recordControlChange,
} from '../services/agent-fleet/control-audit.service.js'
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

  // FX.10 — the entity graph (Phase H), explorable. The bare route is the
  // campaign↔campaign overview; ?type=&id= focuses one entity and walks
  // its neighbourhood through the frontier CTE.
  fastify.get<{
    Querystring: {
      type?: string
      id?: string
      depth?: string
      relations?: string
      limit?: string
    }
  }>('/agent/fleet/entity-graph', async (request) => {
    const { type, id, depth, relations, limit } = request.query
    const take = Math.min(Number(limit) || 120, 400)
    if (type && id) {
      return getEntityNeighborhood(type, id, {
        depth: Math.min(Math.max(Number(depth) || 2, 1), 3),
        relations: relations ? relations.split(',').filter(Boolean) : undefined,
        limit: take,
      })
    }
    return getEntityGraphOverview(take)
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
    Body: {
      enabled?: boolean
      autonomyLevel?: string
      // AC.4 — policy the operator may TIGHTEN (the code value is the ceiling)
      dailyBudgetUSD?: number
      maxTokensPerRun?: number
      maxFindingsPerRun?: number
      modelProvider?: string | null
      modelName?: string | null
      // AC.5 / AC.4 — tool policy and scope
      toolNames?: string[]
      scopeMarketplaces?: string[]
    }
  }>('/agent/fleet/charters/:key', async (request, reply) => {
    const { key } = request.params
    const def = FLEET_CHARTERS[key]
    if (!def) return reply.code(404).send({ error: `unknown charter: ${key}` })
    const before = (await listCharters()).find((c) => c.key === key)
    const data: Record<string, unknown> = {}
    if (request.body?.enabled !== undefined) data.enabled = !!request.body.enabled
    // AC.4 — numbers are stored as given; the registry clamps them DOWN
    // against the code ceiling on every read, so a too-generous value can
    // never take effect.
    const nums: Array<['dailyBudgetUSD' | 'maxTokensPerRun' | 'maxFindingsPerRun', number | undefined]> = [
      ['dailyBudgetUSD', request.body?.dailyBudgetUSD],
      ['maxTokensPerRun', request.body?.maxTokensPerRun],
      ['maxFindingsPerRun', request.body?.maxFindingsPerRun],
    ]
    for (const [field, value] of nums) {
      if (value === undefined) continue
      if (!Number.isFinite(value) || value <= 0) {
        return reply.code(400).send({ error: `${field} must be a positive number` })
      }
      data[field] = value
    }
    if (request.body?.modelProvider !== undefined) {
      data.modelProviderOverride = request.body.modelProvider || null
    }
    if (request.body?.modelName !== undefined) {
      data.modelNameOverride = request.body.modelName || null
    }
    if (request.body?.toolNames !== undefined) {
      const unknownTools = request.body.toolNames.filter((t) => !def.toolNames.includes(t))
      if (unknownTools.length > 0) {
        return reply.code(400).send({
          error: `these tools are not in this worker's code charter and cannot be granted: ${unknownTools.join(', ')}`,
        })
      }
      data.toolNames = request.body.toolNames
    }
    if (request.body?.scopeMarketplaces !== undefined) {
      // Only a SINGLE-marketplace scope is enforced end-to-end today, and
      // this series' rule is that an unenforced control is never offered.
      if (request.body.scopeMarketplaces.length > 1) {
        return reply.code(400).send({
          error:
            'only one marketplace can be scoped today — multi-market scope is not enforced yet, so it is refused rather than ignored',
        })
      }
      data.scopeMarketplaces = request.body.scopeMarketplaces
    }
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
    await recordControlChange({
      charterKey: key,
      action:
        request.body?.autonomyLevel !== undefined
          ? 'dial'
          : request.body?.enabled !== undefined
            ? 'enable'
            : request.body?.toolNames !== undefined
              ? 'tools'
              : request.body?.scopeMarketplaces !== undefined
                ? 'scope'
                : 'policy',
      from: before
        ? {
            enabled: before.enabled,
            autonomyLevel: before.autonomyLevel,
            dailyBudgetUSD: before.dailyBudgetUSD,
            maxTokensPerRun: before.maxTokensPerRun,
            maxFindingsPerRun: before.maxFindingsPerRun,
            toolNames: before.toolNames,
            scopeMarketplaces: before.scopeMarketplaces,
          }
        : null,
      to: data,
    })
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


  /* ── NAF.AC — Agent Control ─────────────────────────────────────────
     Charter Studio (revisions), preview, evals, policy, pause, audit.
     All under the existing /api/agent/ RBAC mapping. */

  // AC.1 — revision history + the prompt that is actually running.
  fastify.get<{ Params: { key: string } }>(
    '/agent/fleet/charters/:key/revisions',
    async (request, reply) => {
      const { key } = request.params
      const def = FLEET_CHARTERS[key]
      if (!def) return reply.code(404).send({ error: `unknown charter: ${key}` })
      const [revisions, active] = await Promise.all([
        listRevisions(key),
        getActiveRevision(key),
      ])
      const running = active?.systemPrompt ?? def.systemPrompt
      return {
        codePrompt: def.systemPrompt,
        runningPrompt: running,
        source: active ? 'revision' : 'code',
        activeRevisionId: active?.id ?? null,
        revisions,
        // the diff a reviewer actually wants: code → what is running
        diffFromCode: diffPrompts(def.systemPrompt, running),
      }
    },
  )

  // AC.1 — save a draft revision (never auto-activates).
  fastify.post<{
    Params: { key: string }
    Body: { systemPrompt?: string; note?: string; policy?: Record<string, number | string | null> }
  }>('/agent/fleet/charters/:key/revisions', async (request, reply) => {
    const { key } = request.params
    if (!FLEET_CHARTERS[key]) return reply.code(404).send({ error: `unknown charter: ${key}` })
    try {
      const rev = await createRevision({
        charterKey: key,
        systemPrompt: request.body?.systemPrompt ?? '',
        note: request.body?.note ?? '',
        policy: request.body?.policy as never,
        author: 'operator',
      })
      return { ok: true, revision: rev }
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  // AC.1 + AC.3 — activate, gated on the eval verdict.
  fastify.post<{
    Params: { key: string; revisionId: string }
    Body: { overrideReason?: string }
  }>('/agent/fleet/charters/:key/revisions/:revisionId/activate', async (request, reply) => {
    const { key, revisionId } = request.params
    if (!FLEET_CHARTERS[key]) return reply.code(404).send({ error: `unknown charter: ${key}` })
    const override = (request.body?.overrideReason ?? '').trim()
    const evaluation = await latestEvalFor(revisionId)
    // The operator decision (AC §6.3): a regression BLOCKS, and the
    // override is recorded rather than silent.
    if (evaluation?.verdict === 'worse' && !override) {
      return reply.code(409).send({
        error:
          'this revision measured WORSE than the charter it would replace — activate it with an overrideReason if you still want it live',
        verdict: evaluation.verdict,
      })
    }
    const before = await getActiveRevision(key)
    const activated = await activateRevision(key, revisionId)
    if (!activated) return reply.code(404).send({ error: 'revision not found for this charter' })
    bustCharterCache()
    await recordControlChange({
      charterKey: key,
      action: override ? 'eval_override' : 'activate_revision',
      from: before ? { revision: before.revision, id: before.id } : { source: 'code' },
      to: { revision: activated.revision, id: activated.id },
      note: override || activated.note,
    })
    return { ok: true, revision: activated }
  })

  // AC.1 — back to the charter that ships in the code.
  fastify.post<{ Params: { key: string } }>(
    '/agent/fleet/charters/:key/revert-to-code',
    async (request, reply) => {
      const { key } = request.params
      if (!FLEET_CHARTERS[key]) return reply.code(404).send({ error: `unknown charter: ${key}` })
      const before = await getActiveRevision(key)
      const out = await revertToCode(key)
      bustCharterCache()
      await recordControlChange({
        charterKey: key,
        action: 'revert_to_code',
        from: before ? { revision: before.revision, id: before.id } : null,
        to: { source: 'code' },
      })
      return { ok: true, ...out }
    },
  )

  // AC.2 — try a charter against real evidence; writes nothing.
  fastify.post<{
    Params: { key: string }
    Body: { systemPrompt?: string }
  }>('/agent/fleet/charters/:key/preview', async (request, reply) => {
    const { key } = request.params
    if (!FLEET_CHARTERS[key]) return reply.code(404).send({ error: `unknown charter: ${key}` })
    if (isAiKillSwitchOn()) {
      return reply.code(503).send({ error: 'AI is temporarily disabled (kill switch).' })
    }
    const result = await executeCharter(key, {
      trigger: 'manual',
      mode: 'ask',
      preview: true,
      promptOverride: request.body?.systemPrompt?.trim() || undefined,
    })
    return result
  })

  // AC.3 — score a draft against what is running, on the same evidence.
  fastify.post<{
    Params: { key: string }
    Body: { systemPrompt?: string; revisionId?: string; cases?: number }
  }>('/agent/fleet/charters/:key/evaluate', async (request, reply) => {
    const { key } = request.params
    if (!FLEET_CHARTERS[key]) return reply.code(404).send({ error: `unknown charter: ${key}` })
    if (isAiKillSwitchOn()) {
      return reply.code(503).send({ error: 'AI is temporarily disabled (kill switch).' })
    }
    let prompt = request.body?.systemPrompt?.trim()
    if (!prompt && request.body?.revisionId) {
      const revs = await listRevisions(key)
      prompt = revs.find((r) => r.id === request.body!.revisionId)?.systemPrompt
    }
    if (!prompt) return reply.code(400).send({ error: 'a prompt or a revisionId is required' })
    const result = await evaluateRevision({
      charterKey: key,
      candidatePrompt: prompt,
      revisionId: request.body?.revisionId ?? null,
      cases: request.body?.cases,
    })
    return result
  })

  // AC.6 — pause with an expiry; resume clears it.
  fastify.post<{
    Params: { key: string }
    Body: { until?: string; reason?: string }
  }>('/agent/fleet/charters/:key/pause', async (request, reply) => {
    const { key } = request.params
    if (!FLEET_CHARTERS[key]) return reply.code(404).send({ error: `unknown charter: ${key}` })
    const untilRaw = request.body?.until
    const until = untilRaw ? new Date(untilRaw) : null
    if (!until || Number.isNaN(until.getTime()) || until.getTime() <= Date.now()) {
      return reply.code(400).send({ error: 'until must be a future date — a pause always expires' })
    }
    await prisma.agentCharter.updateMany({
      where: { key },
      data: { pausedUntil: until, pausedReason: request.body?.reason?.trim() || null },
    })
    bustCharterCache()
    await recordControlChange({
      charterKey: key,
      action: 'pause',
      to: { until: until.toISOString() },
      note: request.body?.reason ?? null,
    })
    return { ok: true, pausedUntil: until }
  })

  fastify.post<{ Params: { key: string } }>(
    '/agent/fleet/charters/:key/resume',
    async (request, reply) => {
      const { key } = request.params
      if (!FLEET_CHARTERS[key]) return reply.code(404).send({ error: `unknown charter: ${key}` })
      await prisma.agentCharter.updateMany({
        where: { key },
        data: { pausedUntil: null, pausedReason: null },
      })
      bustCharterCache()
      await recordControlChange({ charterKey: key, action: 'resume' })
      return { ok: true }
    },
  )

  // AC.8 — start or stop a split test, and read how the arms compare.
  fastify.post<{
    Params: { key: string }
    Body: { candidateRevisionId?: string | null; enabled?: boolean }
  }>('/agent/fleet/charters/:key/ab', async (request, reply) => {
    const { key } = request.params
    if (!FLEET_CHARTERS[key]) return reply.code(404).send({ error: `unknown charter: ${key}` })
    const enabled = request.body?.enabled !== false
    const candidateRevisionId = request.body?.candidateRevisionId ?? null
    if (enabled && !candidateRevisionId) {
      return reply.code(400).send({ error: 'a split needs a candidate revision' })
    }
    await prisma.agentCharter.updateMany({
      where: { key },
      data: { abEnabled: enabled, candidateRevisionId: enabled ? candidateRevisionId : null },
    })
    bustCharterCache()
    await recordControlChange({
      charterKey: key,
      action: 'policy',
      to: { abEnabled: enabled, candidateRevisionId },
      note: enabled ? 'split test started' : 'split test stopped',
    })
    return { ok: true }
  })

  fastify.get<{ Params: { key: string } }>(
    '/agent/fleet/charters/:key/ab',
    async (request) => compareAbArms(request.params.key),
  )

  // AC.7 — the control history for one worker.
  fastify.get<{ Params: { key: string } }>(
    '/agent/fleet/charters/:key/audit',
    async (request) => {
      return { audit: await listControlAudit(request.params.key) }
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
