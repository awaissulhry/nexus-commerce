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

/**
 * AQ-S2R (study Part 13) — one enumerated precondition.
 *
 * This replaces `blockers: string[]`, and the reason is a defect rather than a
 * preference. The old shape sent **only the failures, as prose**, so the client
 * had to re-compose sentences for the conditions that PASS in order to render
 * them at all — and two composers over one set of facts is how twenty-two words
 * ended up verbatim identical between this file and `ApprovalsClient.tsx`.
 * Enumerating every condition, composed once, here, is the fix at the root.
 *
 * Modelled on Kubernetes Pod conditions, which are the same problem solved
 * properly: conditions are listed whether or not they pass, and the
 * human-readable message is a field rather than something to be reverse-
 * engineered from a failure string.
 *
 * `owner` is the organising idea of the whole section and the one genuinely new
 * field: it says WHO can change this. Two of the three conditions are not the
 * operator's to act on — setting a worker to PROPOSE arms a fleet that is off
 * by deliberate constraint, and the missing executors are Phase F work — so a
 * surface that reads as a to-do list would be actively dangerous.
 */
export interface GateCondition {
  key: 'worker-may-ask' | 'action-can-run' | 'something-scheduled'
  met: boolean
  /** The precondition itself, in the operator's words. Rendered verbatim. */
  requirement: string
  /** Why it is or is not met, with the numbers already inside the sentence. */
  detail: string
  /** Who can change it: the operator, us, or nobody (it just happens). */
  owner: 'operator' | 'engineering' | 'automatic'
  /** Where the operator would go, when it is theirs. Null otherwise. */
  href: string | null
  /**
   * An instant this condition refers to, ISO, or null.
   *
   * Deliberately NOT baked into `detail` as "in 43 hours": a relative time
   * composed on the server is stale the moment it is serialised, and this page
   * exists because of stale constants. The client renders it from the instant.
   */
  at: string | null
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
     * AQ-S2R — the three preconditions, ENUMERATED, met or not.
     *
     * All three must be true before a request can exist. Composed here and
     * rendered verbatim, so the sentence the operator reads cannot drift from
     * the condition that produced it — and, unlike the `blockers[]` this
     * replaces, a condition that PASSES has a sentence too.
     *
     * The halt is deliberately NOT one of these. A halt is a fault, not an
     * unmet precondition, and it gets its own treatment above the readout; it
     * still forces `canAnythingArrive` false below.
     */
    const proposingCount = workers.filter((w) => w.proposesNow).length
    const ceiling = workers.filter((w) => w.couldEverPropose).length
    const fleetTools = tools.filter((t) => t.isFleetTool)
    const fleetToolsExecutable = fleetTools.filter((t) => t.canExecute).length
    const councilScheduled = Boolean(council?.enabled)

    const conditions: GateCondition[] = [
      {
        key: 'worker-may-ask',
        met: proposingCount > 0,
        requirement: 'A worker has to be allowed to ask',
        detail:
          proposingCount > 0
            ? `${proposingCount} of your ${workers.length} workers ${proposingCount === 1 ? 'is' : 'are'} set to PROPOSE, which is the setting that puts a request here.`
            : ceiling === 0
              ? `None of your ${workers.length} workers is set to PROPOSE, and none of them ever could be — every one is capped below it in code.`
              : `None of your ${workers.length} workers is set to PROPOSE. Only ${ceiling} ever could be — the other ${workers.length - ceiling} are capped lower in code.`,
        owner: 'operator',
        href: '/fleet/controls',
        at: null,
      },
      {
        key: 'action-can-run',
        met: fleetToolsExecutable > 0,
        requirement: 'What it proposes has to be able to run',
        detail:
          fleetToolsExecutable > 0
            ? `${fleetToolsExecutable} of the fleet's ${fleetTools.length} actions can actually run.`
            : `All ${fleetTools.length} of the fleet's actions can describe what they would do and stop there. Approving one would record your decision and teach the fleet, and change nothing on Amazon.`,
        // Not the operator's, at any dial: this is a missing executor, which is
        // a deploy. Saying so is the difference between an answer and a chore.
        owner: 'engineering',
        href: null,
        at: null,
      },
      {
        key: 'something-scheduled',
        met: councilScheduled,
        requirement: 'Something has to be scheduled to ask',
        detail: councilScheduled
          ? 'The weekly council, and nothing else. A nightly sweep cannot queue a request, and neither can a one-off run.'
          : 'The weekly council is not scheduled, and it is the only thing that can put a request here — a nightly sweep cannot, and neither can a one-off run.',
        owner: 'automatic',
        href: null,
        // Serialised explicitly. `nextFireAt` is a `Date`, and the neighbouring
        // `arrival.councilNext` has always shipped one — it only ever looked
        // like a string because that object is inferred and Fastify serialises
        // on the way out. Annotating this field is what surfaced it.
        at: council?.nextFireAt ? new Date(council.nextFireAt).toISOString() : null,
      },
    ]

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
      /**
       * True only when nothing at all stands in the way. The halt is not one of
       * the conditions — it is a fault laid over them — so it is ANDed here
       * explicitly rather than smuggled in as a fourth precondition.
       */
      canAnythingArrive: !state?.halted && conditions.every((c) => c.met),
      conditions,
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

  /**
   * NAF.AQ — "not now" (operator decision Q6).
   *
   * Without a snooze the only way to clear a badge is to approve, which is the
   * one failure a spend queue cannot afford. The research calls the counter
   * "keeping state so 'later' does not become 'never'" — so it is a column,
   * not client state: a snooze held in a browser dies on reload, is invisible
   * to the rail badge, and lets the count disagree with the queue.
   *
   * **A snooze can never outlive the request.** `expiresAt` still owns its
   * life. Waking something after it has already been refused would be worse
   * than not deferring it at all, so a snooze past expiry is refused here
   * rather than silently clamped — silently clamping would tell the operator
   * they had until Friday when they had until tomorrow.
   */
  fastify.post<{ Params: { id: string }; Body: { until?: string } }>(
    '/agent/fleet/approvals/:id/snooze',
    async (request, reply) => {
      const until = request.body?.until ? new Date(request.body.until) : null
      if (!until || Number.isNaN(until.getTime())) {
        return reply.code(400).send({ error: 'a valid "until" timestamp is required' })
      }
      if (until.getTime() <= Date.now()) {
        return reply.code(400).send({ error: 'that time has already passed' })
      }

      const ap = await prisma.agentApproval.findUnique({
        where: { id: request.params.id },
        select: { status: true, expiresAt: true },
      })
      if (!ap) return reply.code(404).send({ error: 'approval not found' })
      if (ap.status !== 'pending') {
        return reply
          .code(409)
          .send({ error: `only a waiting request can be set aside (this one is ${ap.status})` })
      }
      if (ap.expiresAt && until >= ap.expiresAt) {
        return reply.code(400).send({
          error: `this request expires ${ap.expiresAt.toISOString()} — it cannot be set aside past that, or it would be refused while you were not looking`,
        })
      }

      await prisma.agentApproval.update({
        where: { id: request.params.id },
        data: { snoozedUntil: until },
      })
      return { ok: true, snoozedUntil: until.toISOString() }
    },
  )

  /** Bring a set-aside request back now. */
  fastify.post<{ Params: { id: string } }>(
    '/agent/fleet/approvals/:id/unsnooze',
    async (request) => {
      await prisma.agentApproval.updateMany({
        where: { id: request.params.id },
        data: { snoozedUntil: null },
      })
      return { ok: true }
    },
  )

  /**
   * The rollup contracted with the Assignments stream (`SB.AS`), 2026-08-07.
   *
   * They asked for it so their lifecycle never counts `AgentApproval` itself —
   * because "waiting on you" is not `status = 'pending'`, and two of the ways
   * it is not are non-obvious enough that any second implementation would get
   * them wrong:
   *
   *   · a PARKED row (`scheduled`) is approved and counting down — the
   *     operator has answered it, so it is not waiting on them;
   *   · a row returned by a FAILED execution is `pending` **with `decidedBy`
   *     still set**, so counting pending naively strands an assignment in
   *     "awaiting your approval" for something already answered.
   *
   * Both exclusions live INSIDE this function, not in a comment beside it,
   * which is what they asked for and the right call.
   *
   * Keyed by assignment via `AgentRun.assignmentId` — their column, their
   * migration. This route never reads `AgentAssignment`.
   */
  fastify.get<{ Querystring: { assignmentIds?: string } }>(
    '/agent/fleet/approvals/rollup',
    async (request, reply) => {
      const ids = (request.query.assignmentIds ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      if (ids.length === 0) return { rollup: {} }
      // Rejected over the cap, never truncated: a silently short answer is a
      // wrong count on a queue that gates every write.
      if (ids.length > 100) {
        return reply
          .code(400)
          .send({ error: `at most 100 assignmentIds per call (received ${ids.length})` })
      }

      const runs = await prisma.agentRun.findMany({
        where: { assignmentId: { in: ids } },
        select: { id: true, assignmentId: true },
      })
      const assignmentOfRun = new Map(runs.map((r) => [r.id, r.assignmentId!]))

      const rows = await prisma.agentApproval.findMany({
        where: { agentRunId: { in: runs.map((r) => r.id) } },
        select: { agentRunId: true, status: true, decidedBy: true },
      })

      const rollup: Record<
        string,
        { waiting: number; parked: number; returned: number; decided: number; expired: number }
      > = {}
      for (const id of ids) {
        rollup[id] = { waiting: 0, parked: 0, returned: 0, decided: 0, expired: 0 }
      }
      for (const r of rows) {
        const a = assignmentOfRun.get(r.agentRunId)
        if (!a || !rollup[a]) continue
        const bucket = rollup[a]!
        if (r.status === 'scheduled') bucket.parked++
        else if (r.status === 'expired') bucket.expired++
        else if (r.status === 'pending') {
          // The exclusion they asked for: `decidedBy` set on a pending row
          // means it came BACK, not that it is waiting.
          if (r.decidedBy) bucket.returned++
          else bucket.waiting++
        } else bucket.decided++
      }
      return { rollup }
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
