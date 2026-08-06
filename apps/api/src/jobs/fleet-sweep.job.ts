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
import cron from 'node-cron'
import prisma from '../db.js'
import { executeCharter } from '../services/agent-fleet/agent-executor.js'
import { runFleetCouncilOnce } from '../services/agent-fleet/fleet-council.service.js'
import { runFleet } from '../services/agent-fleet/orchestrator.js'
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
      `skipped=${fleet.skipped} graded=${grade.graded} scorecards=${scorecards.upserted} ` +
      `demoted=${demotions.length} audit=${audit.runId ? (audit.ok ? 'ok' : 'failed') : 'skipped'} ` +
      `cost=$${costUSD.toFixed(4)}` +
      (fleet.haltedReason ? ` halted=${fleet.haltedReason}` : '')
    )
  } finally {
    running = false
  }
}

export async function runFleetSweepCron(): Promise<void> {
  await recordCronRun('fleet-sweep', async () => runFleetSweepOnce()).catch(
    (err) => logger.error('[fleet-sweep] cron failed', { error: String(err) }),
  )
}

let task: ReturnType<typeof cron.schedule> | null = null

export function startFleetSweepCron(): void {
  if (process.env.NEXUS_ENABLE_FLEET_SWEEP_CRON !== '1') {
    logger.info('[fleet-sweep] cron disabled (NEXUS_ENABLE_FLEET_SWEEP_CRON != 1)')
    return
  }
  if (task) return
  const schedule = process.env.NEXUS_FLEET_SWEEP_SCHEDULE ?? '45 4 * * *'
  if (!cron.validate(schedule)) {
    logger.error(`[fleet-sweep] invalid schedule "${schedule}" — cron not started`)
    return
  }
  task = cron.schedule(schedule, () => {
    void runFleetSweepCron()
  })
  logger.info(`[fleet-sweep] nightly analyst sweep scheduled (${schedule})`)
}

/* ── NAF.C — the weekly council (analysts → director → critic → queue) ── */

let councilRunning = false

export async function runFleetCouncilJobOnce(): Promise<string> {
  if (councilRunning) return 'skipped=overlap'
  councilRunning = true
  try {
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

let councilTask: ReturnType<typeof cron.schedule> | null = null

export function startFleetCouncilCron(): void {
  if (process.env.NEXUS_ENABLE_FLEET_SWEEP_CRON !== '1') {
    logger.info('[fleet-council] cron disabled (NEXUS_ENABLE_FLEET_SWEEP_CRON != 1)')
    return
  }
  if (councilTask) return
  const schedule = process.env.NEXUS_FLEET_COUNCIL_SCHEDULE ?? '15 5 * * 1'
  if (!cron.validate(schedule)) {
    logger.error(`[fleet-council] invalid schedule "${schedule}" — cron not started`)
    return
  }
  councilTask = cron.schedule(schedule, () => {
    void runFleetCouncilCron()
  })
  logger.info(`[fleet-council] weekly council scheduled (${schedule})`)
}
