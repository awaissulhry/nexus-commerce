/**
 * NAF.B — the nightly analyst sweep (docs/2026-08-06-naf-b-analysts.md D8).
 *
 * Double-dark by construction: this cron self-gates on
 * NEXUS_ENABLE_FLEET_SWEEP_CRON (independent of the ads write-engine flag —
 * the fleet is read-only), and even when scheduled, charters born OFF make
 * every agent a no-op inside the orchestrator. 04:45 UTC default sits after
 * the nightly ads report ingest and before auto-harvest's 06:30, so the
 * analysts read the same morning data the deterministic cron acts on —
 * which is exactly what shadow-grading compares.
 *
 * Registered in CRON_REGISTRY as the *Once function (never the *Cron
 * wrapper — that double-writes CronRun, see cron-registry.ts:234).
 */
import cron from '../lib/cron/clustered.js'
import prisma from '../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace, workspaceContext } from '../lib/workspace-context.js'
import { visitActiveWorkspaces } from '../lib/workspace-sweep.js'
import { executeCharter } from '../services/agent-fleet/agent-executor.js'
import { runFleetCouncilOnce } from '../services/agent-fleet/fleet-council.service.js'
import { reclaimStuckRuns, runFleet, runStoredWorkflow } from '../services/agent-fleet/orchestrator.js'
import { evaluateDemotions } from '../services/agent-fleet/promotion.service.js'
import { computeScorecards } from '../services/agent-fleet/scorecard.service.js'
import { gradeFindings } from '../services/agent-fleet/shadow-grade.service.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { logger } from '../utils/logger.js'

let running = false

export async function runFleetSweepOnce(): Promise<string> {
  if (running) return 'skipped=overlap'
  running = true
  try {
    // Pre-F hardening: close fleet runs orphaned by a hang or process
    // death before starting new ones (there is no executor timeout).
    const reclaimed = await reclaimStuckRuns().catch(() => 0)
    const fleet = await runFleet('sweep')
    const runs = await prisma.agentRun.findMany({
      where: { orchestrationId: fleet.orchestrationId },
      select: { id: true, costUSD: true },
    })
    const grade = await gradeFindings(runs.map((r) => r.id))
    const costUSD = runs.reduce((sum, r) => sum + Number(r.costUSD), 0)
    // NAF.E — nightly scorecards ride the sweep: deterministic, $0, and
    // computed even for dark charters (an empty window is evidence too).
    // A scorecard failure must never fail the sweep it rides on.
    const scorecards = await computeScorecards().catch((err) => {
      logger.error('[fleet-sweep] scorecard computation failed', { error: String(err) })
      return { upserted: 0 }
    })
    // NAF.H — nightly entity-graph derivation: deterministic, read-only
    // over the substrate, reconciled idempotently. Runs even while the
    // fleet is dark — the graph serves the critic whenever it wakes.
    const graph = await import('../services/agent-fleet/graph-derivation.service.js')
      .then((m) => m.deriveAllEdges())
      .catch((err) => {
        logger.error('[fleet-sweep] graph derivation failed', { error: String(err) })
        return []
      })
    const graphSummary = graph.map((g) => `${g.relation}:${g.upserted}/${g.closed}`).join(' ')
    // NAF.E — Part 7's automatic demotions, evaluated on fresh scorecard
    // inputs. Dark fleet ⇒ nothing above OFF ⇒ no-op.
    const demotions = await evaluateDemotions().catch((err) => {
      logger.error('[fleet-sweep] demotion evaluation failed', { error: String(err) })
      return []
    })
    for (const d of demotions) {
      logger.warn('[fleet-sweep] DEMOTED', { ...d })
    }
    // NAF.E — the auditor runs AFTER scorecards so its brief reads
    // tonight's numbers. Standalone in the graph; honours enabled/OFF
    // like every scheduled run (born dark ⇒ skipped).
    const audit = await executeCharter('fleet-auditor', {
      trigger: 'schedule',
      mode: 'sweep',
    }).catch((err) => {
      logger.error('[fleet-sweep] auditor failed', { error: String(err) })
      return { runId: null, ok: false as const }
    })
    return (
      `started=${fleet.started} ok=${fleet.succeeded} failed=${fleet.failed} ` +
      `skipped=${fleet.skipped} reclaimed=${reclaimed} graded=${grade.graded} scorecards=${scorecards.upserted} ` +
      `graph[${graphSummary}] ` +
      `demoted=${demotions.length} audit=${audit.runId ? (audit.ok ? 'ok' : 'failed') : 'skipped'} ` +
      `cost=$${costUSD.toFixed(4)}` +
      (fleet.haltedReason ? ` halted=${fleet.haltedReason}` : '')
    )
  } finally {
    running = false
  }
}

export async function runFleetSweepCron(): Promise<void> {
  await recordCronRun('fleet-sweep', async () => {
    // R16 — this business's own switch, under the env that armed the cron. The sweep writes findings only (OBSERVE).
    const { engineMode } = await import('../services/automation/engine-switch.service.js')
    const gate = await engineMode('fleet-analysts', 'OBSERVE')
    if (gate.mode === 'OFF') return `skipped: ${gate.note}`
    return runFleetSweepOnce()
  }).catch(
    (err) => logger.error('[fleet-sweep] cron failed', { error: String(err) }),
  )
}

type Clock = ReturnType<typeof cron.schedule>

/** One business's fleet clocks: the sweep, the council, and one per custom
 *  routine with a stored schedule trigger. */
interface BusinessClocks {
  sweep: Clock | null
  council: Clock | null
  customs: Map<string, Clock>
}

/** Keyed by business (the legacy id while business profiles are off). */
const clocksByBusiness = new Map<string, BusinessClocks>()

function stopClocks(clocks: BusinessClocks): void {
  clocks.sweep?.stop()
  clocks.council?.stop()
  for (const t of clocks.customs.values()) t.stop()
}

/** A clock for ONE business, armed inside it as the system: clustered.ts
 *  keeps a schedule made inside a business there, so its tick runs in that
 *  business only, and never as the person whose click re-armed it. Legacy
 *  mode (no business selected) arms one plain clock, as before. */
function armClock(workspaceId: string | null, expression: string, tick: () => Promise<void>): Clock {
  const arm = () =>
    cron.schedule(expression, async () => {
      await tick()
    })
  return workspaceId
    ? withWorkspace({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] }, arm)
    : arm()
}

/** WF.4c — the cron a job should actually fire on: the stored trigger when
 *  one is active (null = stored `manual`, do not arm), else the env/code
 *  default. An unreadable stored layer means the env cron stands — the same
 *  fail-to-code law the walk itself follows. Read in the business being
 *  armed: the stored trigger is that business's own. */
async function resolveJobCron(
  key: 'fleet-sweep' | 'fleet-council',
  envDefault: string,
): Promise<string | null> {
  try {
    const { getEffectiveDefinition } = await import(
      '../services/agent-fleet/workflow-registry.service.js'
    )
    const trig = (await getEffectiveDefinition(key)).definition?.trigger
    if (trig?.type === 'manual') return null
    if (trig?.type === 'schedule' && typeof trig.cron === 'string' && cron.validate(trig.cron)) {
      return trig.cron
    }
  } catch (err) {
    // Stored layer unreadable ⇒ env cron — said in the log, never silently.
    logger.warn(`[${key}] stored trigger unreadable — the env schedule stands`, {
      workspaceId: workspaceContext()?.workspaceId ?? LEGACY_WORKSPACE_ID,
      error: String(err),
    })
  }
  return cron.validate(envDefault) ? envDefault : null
}

/* ── WF.6c — custom workflows' clocks ─────────────────────────────────── */

async function runCustomWorkflowCron(key: string): Promise<void> {
  await recordCronRun(`workflow:${key}`, async () => {
    // A custom routine runs the same analysts as the sweep, so this
    // business's own switch (R16) stands it down the same way.
    const { engineMode } = await import('../services/automation/engine-switch.service.js')
    const gate = await engineMode('fleet-analysts', 'OBSERVE')
    if (gate.mode === 'OFF') return `skipped: ${gate.note}`
    const r = await runStoredWorkflow(key, { trigger: 'schedule' })
    return (
      `started=${r.started} ok=${r.succeeded} failed=${r.failed} skipped=${r.skipped}` +
      (r.haltedReason ? ` halted=${r.haltedReason}` : '')
    )
  }).catch((err) =>
    logger.error(`[fleet-workflow] ${key} cron failed`, { error: String(err) }),
  )
}

/** One business's clocks, re-derived from ITS effective definitions. Runs
 *  inside that business (workflows and their triggers are per business);
 *  `workspaceId` is null only in legacy mode. Everything is read first and
 *  the clocks are swapped in one synchronous step, so two resyncs of the
 *  same business can never both leave clocks armed. */
async function resyncBusinessClocks(workspaceId: string | null): Promise<void> {
  const business = workspaceId ?? LEGACY_WORKSPACE_ID
  const sweepCron = await resolveJobCron(
    'fleet-sweep',
    process.env.NEXUS_FLEET_SWEEP_SCHEDULE ?? '45 4 * * *',
  )
  const councilCron = await resolveJobCron(
    'fleet-council',
    process.env.NEXUS_FLEET_COUNCIL_SCHEDULE ?? '15 5 * * 1',
  )

  // WF.6c — one clock per enabled custom with a stored schedule trigger.
  // A failure here must never take the built-in clocks down with it.
  const customs: Array<{ key: string; cron: string }> = []
  try {
    const rows = await prisma.agentWorkflow.findMany({
      where: { kind: 'custom', enabled: true },
      select: { key: true },
      orderBy: { key: 'asc' },
    })
    const { getEffectiveDefinition } = await import(
      '../services/agent-fleet/workflow-registry.service.js'
    )
    for (const row of rows) {
      const trig = (await getEffectiveDefinition(row.key)).definition?.trigger
      if (trig?.type !== 'schedule' || typeof trig.cron !== 'string' || !cron.validate(trig.cron)) {
        continue
      }
      customs.push({ key: row.key, cron: trig.cron })
    }
  } catch (err) {
    logger.error('[fleet-workflow] custom clock resync failed', { workspaceId: business, error: String(err) })
  }

  const previous = clocksByBusiness.get(business)
  if (previous) stopClocks(previous)
  const next: BusinessClocks = { sweep: null, council: null, customs: new Map() }
  clocksByBusiness.set(business, next)
  if (sweepCron) {
    next.sweep = armClock(workspaceId, sweepCron, runFleetSweepCron)
    logger.info(`[fleet-sweep] nightly analyst sweep scheduled (${sweepCron})`, { workspaceId: business })
  } else {
    logger.info('[fleet-sweep] stored trigger is manual — clock not armed', { workspaceId: business })
  }
  if (councilCron) {
    next.council = armClock(workspaceId, councilCron, runFleetCouncilCron)
    logger.info(`[fleet-council] weekly council scheduled (${councilCron})`, { workspaceId: business })
  } else {
    logger.info('[fleet-council] stored trigger is manual — clock not armed', { workspaceId: business })
  }
  for (const c of customs) {
    next.customs.set(c.key, armClock(workspaceId, c.cron, () => runCustomWorkflowCron(c.key)))
    logger.info(`[fleet-workflow] ${c.key} scheduled (${c.cron})`, { workspaceId: business })
  }
}

/** WF.4c/6c — (re)arm every fleet clock from the effective definitions:
 *  the two built-ins AND one clock per enabled custom with a stored
 *  schedule trigger, per business. Called at boot (no business selected:
 *  every active business is re-armed, each inside its own context) and by
 *  the workflow routes after activate / revert (only the request's business
 *  re-arms; the others keep their clocks), so a published trigger change
 *  takes effect the moment it is published — no restart, no drift between
 *  the page and the firing. One business failing never stops the next.
 *  No-op while the master env gate is off. */
export async function resyncFleetSchedules(): Promise<void> {
  if (process.env.NEXUS_ENABLE_FLEET_SWEEP_CRON !== '1') return

  if (!workspaceContext()) {
    for (const clocks of clocksByBusiness.values()) stopClocks(clocks)
    clocksByBusiness.clear()
  }
  await visitActiveWorkspaces(async () => {
    const workspaceId = workspaceContext()?.workspaceId ?? null
    try {
      await resyncBusinessClocks(workspaceId)
    } catch (err) {
      logger.error('[fleet-workflow] clock resync failed for one business', {
        workspaceId: workspaceId ?? LEGACY_WORKSPACE_ID,
        error: String(err),
      })
    }
  })
}

export function startFleetSweepCron(): void {
  if (process.env.NEXUS_ENABLE_FLEET_SWEEP_CRON !== '1') {
    logger.info('[fleet-sweep] cron disabled (NEXUS_ENABLE_FLEET_SWEEP_CRON != 1)')
    return
  }
  // WF.4c — one resync arms every business's clocks from its effective definitions.
  void resyncFleetSchedules().catch((err) =>
    logger.error('[fleet-sweep] schedule resync failed', { error: String(err) }),
  )
}

/* ── NAF.C — the weekly council (analysts → director → critic → queue) ── */

let councilRunning = false

export async function runFleetCouncilJobOnce(): Promise<string> {
  if (councilRunning) return 'skipped=overlap'
  councilRunning = true
  try {
    await reclaimStuckRuns().catch(() => 0)
    const r = await runFleetCouncilOnce()
    return (
      `fleet(started=${r.fleet.started} ok=${r.fleet.succeeded} failed=${r.fleet.failed} skipped=${r.fleet.skipped}) ` +
      `plan=${r.planId ?? 'none'} verdict=${r.finalVerdict ?? 'n/a'} queued=${r.queued} blocked=${r.blocked} expired=${r.expired}` +
      (r.haltedReason ? ` halted=${r.haltedReason}` : '')
    )
  } finally {
    councilRunning = false
  }
}

export async function runFleetCouncilCron(): Promise<void> {
  await recordCronRun('fleet-council', async () => runFleetCouncilJobOnce()).catch(
    (err) => logger.error('[fleet-council] cron failed', { error: String(err) }),
  )
}

export function startFleetCouncilCron(): void {
  // WF.4c — kept for boot-call compatibility (index.ts calls both starters);
  // startFleetSweepCron's resync arms the council clock too.
}
