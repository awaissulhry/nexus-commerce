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
import prisma from '../db.js'
import { listCharters } from '../services/agent-fleet/charter-registry.js'
import { getFleetSchedule } from '../services/agent-fleet/fleet-schedule.service.js'
import { FLEET_TOOLS } from '../services/agent-fleet/approval-inbox.service.js'
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
}

export default agentFleetApprovalRoutes
