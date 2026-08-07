/**
 * NAF.AQ — the Approvals page's own routes.
 *
 * Its own file, not `agent-fleet.routes.ts`, per the session-locks protocol:
 * that file is 771 lines and shared, a duplicate path there is a Fastify boot
 * crash, and one-line conflicts in `index.ts` merge where 771-line ones do not.
 * The AP.1–AP.8 read/decide routes stay where they are; nothing here replaces
 * them.
 *
 * AQ.1 ships exactly one endpoint, and it exists because of the finding that
 * reorganised the whole page (docs/2026-08-07-naf-aq-approvals-page.md §1.1):
 * the queue cannot fill, for three independent reasons, and no surface in the
 * product says so. An empty approvals queue and a broken approvals pipe look
 * identical, and today it is the pipe.
 *
 *   1. The three fleet propose-tools are preview-only. `runOrQueueTool`
 *      returns `mode:'preview'` and creates NO row when a tool has no
 *      `execute()`, so an approve could never reach Amazon either.
 *   2. Six of seven charters cap at OBSERVE; only `amazon-ads-director` could
 *      ever reach PROPOSE, which is the only dial position that queues.
 *   3. `executeCharter` never calls the queueing path at all — so a sweep run,
 *      an `ask` run and an assignment run cannot queue. Only the weekly
 *      council cron can. (Found by the SB.AS stream, verified here.)
 *
 * Everything below is READ-ONLY and derived from the same code the executor
 * uses — never a copy of it. The executability flag is `typeof tool.execute
 * === 'function'` off the live registry, not a list maintained by hand, because
 * a hand-maintained list is exactly the stale constant this page exists to
 * stop rendering.
 */
import type { FastifyPluginAsync } from 'fastify'
import { Prisma } from '@nexus/database'
import prisma from '../db.js'
import { recordControlChange } from '../services/agent-fleet/control-audit.service.js'
import { listCharters } from '../services/agent-fleet/charter-registry.js'
import { getFleetSchedule } from '../services/agent-fleet/fleet-schedule.service.js'
import {
  checkStaleness,
  FLEET_TOOLS,
  resolveActor,
} from '../services/agent-fleet/approval-inbox.service.js'
import { EXPIRY_HOURS } from '../services/agents/approval-gate.service.js'
import { getTool } from '../services/agents/tool-registry.js'
import { resolveToolPolicy } from '../services/agents/tool-policy.service.js'

/** The cadence `jobs/approval-maintenance.job.ts` runs at. */
const MAINTENANCE_SECONDS = 30

/** Only PROPOSE queues. OFF and OBSERVE cannot; AUTO acts without asking. */
const QUEUEING_LEVEL = 'PROPOSE'

export interface GateWorker {
  key: string
  name: string
  autonomyLevel: string
  autonomyCap: string
  enabled: boolean
  provisioned: boolean
  /** Could this worker EVER queue an approval, at any dial the UI allows? */
  couldEverPropose: boolean
  /** Is it queueing right now? */
  proposesNow: boolean
}

export interface GateTool {
  name: string
  /** True when the tool has an `execute()` — i.e. an approve can do something. */
  canExecute: boolean
  requiresApproval: boolean
  riskTier: string
  /** One of the three the Waiting view filters to. */
  isFleetTool: boolean
}

const agentFleetApprovalRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * AQ-S2 — "can anything reach this queue?"
   *
   * Joins three facts that live on three different pages — the dials
   * (Controls), the schedule (Overview) and executability (nowhere at all) —
   * into the one answer an empty queue needs.
   */
  fastify.get('/agent/fleet/approvals/gate-state', async () => {
    const [state, charters, schedule] = await Promise.all([
      prisma.agentFleetState.findUnique({ where: { id: 'singleton' } }),
      listCharters(),
      getFleetSchedule(),
    ])

    const workers: GateWorker[] = charters.map((c) => ({
      key: c.key,
      name: c.name,
      autonomyLevel: c.autonomyLevel,
      autonomyCap: c.autonomyCap,
      enabled: c.enabled,
      provisioned: c.provisioned !== false,
      // The cap is a code ceiling the UI cannot exceed, so a worker capped at
      // OBSERVE can never queue no matter what the operator does.
      couldEverPropose: c.autonomyCap === QUEUEING_LEVEL || c.autonomyCap === 'AUTO',
      proposesNow: c.enabled && c.autonomyLevel === QUEUEING_LEVEL,
    }))

    // Every tool that can reach this queue at all — the fleet's three, plus
    // the four legacy ones that DO have executors and are therefore the only
    // rows on the page with real consequences.
    const toolNames = [
      ...FLEET_TOOLS,
      'apply-content',
      'set-price',
      'publish-listing',
      'send-customer-message',
    ]
    const tools: GateTool[] = []
    for (const name of toolNames) {
      const tool = getTool(name)
      if (!tool) continue
      const policy = await resolveToolPolicy(name).catch(() => null)
      tools.push({
        name,
        canExecute: typeof tool.execute === 'function',
        requiresApproval: policy?.requiresApproval ?? tool.requiresApprovalDefault ?? false,
        riskTier: policy?.riskTier ?? tool.riskTier,
        isFleetTool: FLEET_TOOLS.includes(name),
      })
    }

    const council = schedule.jobs.find((j) => j.key === 'fleet-council') ?? null
    const sweep = schedule.jobs.find((j) => j.key === 'fleet-sweep') ?? null

    /**
     * The reasons nothing can arrive, in the order an operator would hit them.
     * Empty array = the pipe is open. Each string is rendered verbatim, so it
     * is written as a sentence, not a code.
     */
    const blockers: string[] = []
    if (state?.halted) {
      blockers.push(
        `The whole fleet is halted${state.haltReason ? ` — ${state.haltReason}` : ''}, so no worker runs at all.`,
      )
    }
    if (!workers.some((w) => w.proposesNow)) {
      const ceiling = workers.filter((w) => w.couldEverPropose).length
      blockers.push(
        ceiling === 0
          ? 'No worker is allowed to ask for anything. Every worker is capped below PROPOSE in code, which is the only setting that puts a request here.'
          : `No worker is set to PROPOSE, the only setting that puts a request here. ${ceiling} of ${workers.length} could be — the rest are capped below it in code.`,
      )
    }
    const fleetToolsExecutable = tools.filter((t) => t.isFleetTool && t.canExecute).length
    if (fleetToolsExecutable === 0) {
      blockers.push(
        'None of the actions the fleet can propose is able to run yet. They produce a preview only, so nothing can be queued for you — and approving one would record your decision and change nothing on Amazon.',
      )
    }
    if (!council || !council.enabled) {
      blockers.push(
        'The weekly council is not scheduled, and it is the only thing that can put a request here — a nightly sweep cannot, and neither can a one-off run.',
      )
    }

    // What the sweep would delete if a request DID arrive from outside the
    // fleet's three tools: the AP.5 sweep filters by no tool, while the
    // Waiting view filters to three, so those rows are invisible and mortal.
    const outsidePending = await prisma.agentApproval.groupBy({
      by: ['toolName'],
      where: { status: { in: ['pending', 'scheduled'] }, toolName: { notIn: FLEET_TOOLS } },
      _count: true,
    })

    const lastMaintenance = await prisma.cronRun
      .findFirst({
        where: { jobName: 'approval-maintenance' },
        select: { startedAt: true, status: true, outputSummary: true },
        orderBy: { startedAt: 'desc' },
      })
      .catch(() => null)

    return {
      halted: Boolean(state?.halted),
      haltReason: state?.haltReason ?? null,
      /** True only when nothing at all stands in the way. */
      canAnythingArrive: blockers.length === 0,
      blockers,
      workers,
      tools,
      arrival: {
        // Named deliberately: the council is the ONLY producer. Saying "the
        // next sweep" here would be this page's own stale constant.
        councilNext: council?.nextFireAt ?? null,
        councilEnabled: council?.enabled ?? false,
        councilSchedule: council?.schedule ?? null,
        sweepNext: sweep?.nextFireAt ?? null,
        sweepEnabled: sweep?.enabled ?? false,
        sweepCanQueue: false,
      },
      expiry: {
        hours: EXPIRY_HOURS,
        maintenanceSeconds: MAINTENANCE_SECONDS,
        // The expiry sweep is deliberately NOT gated on the fleet flags: those
        // keep agents dark, while this is what makes an operator's own decision
        // actually happen (AP.5).
        runsWhileFleetIsOff: true,
        lastMaintenance,
      },
      outside: {
        pending: outsidePending.reduce((n, r) => n + r._count, 0),
        byTool: outsidePending.map((r) => ({ toolName: r.toolName, count: r._count })),
      },
    }
  })

  /**
   * AQ-S5 — the requests waiting from OUTSIDE the fleet.
   *
   * These are the only rows on the page that can reach the outside world.
   * `whereFor('waiting')` filters the queue to the three fleet tools while
   * `runApprovalMaintenance` filters by no tool at all, so a `set-price` /
   * `publish-listing` / `send-customer-message` / `apply-content` request is
   * created, appears in NO view, and is expired unseen after 24 hours. Not a
   * visibility gap — a silent terminal failure.
   *
   * Kept a separate endpoint (and a separate section) rather than widened into
   * the fleet queue on purpose: different producer, thinner payload — no
   * worker join, no track record, no resolved entity names — and the opposite
   * consequence. Putting two qualities of attribution under one count is how a
   * queue starts lying to the person who trusts it.
   *
   * Decisions on these go through the SAME fleet decide route, so they get
   * attribution, the 20-second park, the audit row and the AP.6 staleness
   * re-check — never the legacy path, which records no name and skips all four.
   */
  /**
   * AQ.3 — "check this is still true", on demand.
   *
   * `checkStaleness` already runs automatically at commit, which is the safety
   * property. But an operator reading a card has no way to ask *now* whether
   * the facts still hold, and the study rejected running it on every list
   * render for cost: it re-runs each tool's database-backed dry-run.
   *
   * So: on demand, one approval at a time. Read-only — the handlers it calls
   * are all reads (verified in `mutate.tools.ts` and `ads-propose.tools.ts`),
   * and nothing here writes to the approval. Answering "has anything moved?"
   * must never itself move anything.
   */
  fastify.post<{ Params: { id: string } }>(
    '/agent/fleet/approvals/:id/recheck',
    async (request) => {
      const verdict = await checkStaleness(request.params.id)
      return {
        stale: verdict.stale,
        why: verdict.why,
        checkedAt: new Date().toISOString(),
      }
    },
  )

  /**
   * AQ.8 — edit-then-approve. The one thing the industry standard has that we
   * did not, and named in the parent page map as the single highest-value gap.
   *
   * The operator's most common real verdict on a proposal is not "no" — it is
   * *"right idea, wrong number"*. Without this, every near-miss becomes a
   * reject plus a wait for the worker to propose again, which costs a model
   * call and lets the auction move in between.
   *
   * Three decisions, each taken against the research rather than for
   * convenience:
   *
   * **1. Supersede, never mutate.** The edit expires the original and mints a
   * NEW approval. Mutating in place is how the number approved and the number
   * written come apart — and it destroys the record of what the worker
   * actually proposed, which is the thing you want six months later when
   * asking whether the worker or the operator was wrong.
   *
   * **2. The tool's own handler is the validator.** We do not copy the bid
   * floor, the authority pins or the protected-term rules into a second place
   * where they can drift; we re-run `tool.handler(editedArgs)` and take its
   * refusal verbatim. That is the same code that produced the preview the
   * operator read, so the check cannot disagree with what they were shown.
   * A free-text box over a money field with no server re-validation is a hole
   * straight through the bid rails — an operator typing 4.2 for 0.42 gets a
   * ten-times bid — and this is what closes it.
   *
   * **3. The preview is regenerated, not patched.** The new row carries a
   * preview built from the edited args by the same handler, so the card the
   * operator sees next describes their number, not the worker's.
   */
  fastify.post<{ Params: { id: string }; Body: { args?: Record<string, unknown> } }>(
    '/agent/fleet/approvals/:id/amend',
    async (request, reply) => {
      const patch = request.body?.args ?? {}
      if (Object.keys(patch).length === 0) {
        return reply.code(400).send({ error: 'nothing to change' })
      }

      const original = await prisma.agentApproval.findUnique({
        where: { id: request.params.id },
      })
      if (!original) return reply.code(404).send({ error: 'approval not found' })
      if (original.status !== 'pending') {
        // A parked approve must be taken back first. Amending something the
        // operator has already said yes to would silently change what they
        // agreed, which is the opposite of the point.
        return reply
          .code(409)
          .send({ error: `only a waiting request can be edited (this one is ${original.status})` })
      }

      const tool = getTool(original.toolName)
      if (!tool?.handler) {
        return reply.code(400).send({ error: 'this action cannot be edited' })
      }

      const editedArgs = { ...(original.args as Record<string, unknown>), ...patch }
      if (JSON.stringify(editedArgs) === JSON.stringify(original.args)) {
        return reply.code(400).send({ error: 'that is the same as what was proposed' })
      }

      // THE validation. Whatever the tool refuses, we refuse, in its words.
      const fresh = await tool.handler(editedArgs, { userId: null }).catch((err: unknown) => ({
        ok: false as const,
        error: `could not be checked: ${String(err)}`,
      }))
      if (!fresh.ok) {
        return reply.code(400).send({ error: fresh.error ?? 'that change is not allowed' })
      }

      const actor = resolveActor(
        (request as { authUser?: { id?: string; email?: string; displayName?: string } }).authUser,
      )

      const created = await prisma.$transaction(async (tx) => {
        await tx.agentApproval.update({
          where: { id: original.id },
          data: {
            status: 'superseded',
            decidedBy: actor.label,
            decidedAt: new Date(),
            reason: 'superseded — you edited this before approving',
          },
        })
        return tx.agentApproval.create({
          data: {
            agentRunId: original.agentRunId,
            toolName: original.toolName,
            riskTier: original.riskTier,
            args: editedArgs as Prisma.InputJsonValue,
            preview: (fresh.preview ?? fresh.data ?? {}) as Prisma.InputJsonValue,
            status: 'pending',
            // A fresh clock: it describes a decision taken now, not one
            // inherited from a proposal the operator declined to take.
            expiresAt: new Date(Date.now() + EXPIRY_HOURS * 3600 * 1000),
          },
        })
      })

      await recordControlChange({
        charterKey: 'operator-edit',
        action: 'amend_action',
        from: { approvalId: original.id, args: original.args },
        to: { approvalId: created.id, args: editedArgs },
        note: 'operator edited a proposal before approving it',
        actor: actor.label,
      }).catch(() => undefined)

      return { ok: true, supersededId: original.id, approvalId: created.id, preview: created.preview }
    },
  )

  fastify.get('/agent/fleet/approvals/outside', async () => {
    const rows = await prisma.agentApproval.findMany({
      where: {
        status: { in: ['pending', 'scheduled'] },
        toolName: { notIn: FLEET_TOOLS },
      },
      orderBy: { requestedAt: 'asc' },
      take: 100,
    })

    // Origin, said honestly. These hang off pre-fleet runs (`manual-action`,
    // `listing-quality-keeper`), so there is no worker to name — and inventing
    // one would be the exact anti-pattern FX.1 exists to prevent.
    const runs = await prisma.agentRun.findMany({
      where: { id: { in: rows.map((r) => r.agentRunId) } },
      select: { id: true, agentKey: true, mode: true },
    })
    const runById = new Map(runs.map((r) => [r.id, r]))

    return {
      approvals: rows.map((a) => {
        const run = runById.get(a.agentRunId)
        const tool = getTool(a.toolName)
        return {
          id: a.id,
          toolName: a.toolName,
          riskTier: a.riskTier,
          status: a.status,
          args: a.args,
          preview: a.preview,
          requestedAt: a.requestedAt,
          expiresAt: a.expiresAt,
          executeAfter: a.executeAfter,
          reason: a.reason,
          decidedBy: a.decidedBy,
          /** Where it came from, verbatim. Never a fabricated worker name. */
          originKey: run?.agentKey ?? null,
          /** True for all of these — it is why they matter. */
          canExecute: typeof tool?.execute === 'function',
          /** No `charterKey`, so no per-worker history exists for these. */
          trackRecord: null,
        }
      }),
      count: rows.length,
      /** The list is capped; say so rather than silently truncating. */
      cap: 100,
    }
  })
}

export default agentFleetApprovalRoutes
