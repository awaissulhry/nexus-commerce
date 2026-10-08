/**
 * AD.5 — Cron tick for BudgetPool rebalances.
 *
 * Walks every enabled pool, calls rebalanceAndAudit() which respects
 * the per-pool cooldown. Pools in dryRun mode produce only the audit
 * row; pools flipped to live also enqueue the campaign mutations.
 *
 * Gated by NEXUS_ENABLE_AMAZON_ADS_CRON=1 alongside the other AD-series
 * crons.
 *
 * 1d — a live pool honours the account dial and this engine's caps (ads-engine-guard.ts), asked once
 * per pool, so a rebalance is never split (its cuts and raises go together):
 *   auto     applies while under the caps; a pool the cap holds back is not even audited, so its
 *            cool-down does not start and the next run applies it.
 *   suggest  the native dry run (forceDryRun): the audit row records what it would move.
 *   stopped  nothing — no audit, no cool-down — so the first run after Resume applies it. (A budget
 *            write is never a suppression, so the gate would refuse it after Nexus changed its copy.)
 */

import cron from '../lib/cron/clustered.js'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { BUDGET_POOL_CRON_ACTOR, computeRebalance, rebalanceAndAudit, type ProposedAllocation } from '../services/advertising/budget-pool-rebalancer.service.js'
import { engineGuardNote, nothingHeld, openEngineGuard, type EngineGuardReport } from '../services/advertising/ads-engine-guard.js'
import { addLeverSkipCounts, leverSkipNote, type LeverSkipCounts } from '../services/advertising/brain/engine-skips.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null
let lastRunAt: Date | null = null
let lastSummary: string | null = null

interface TickSummary {
  poolsConsidered: number
  poolsRebalanced: number
  poolsAppliedLive: number
  poolsSkipped: number
  totalShiftCents: number
  durationMs: number
  /** 1d — the dial posture and the caps this run ran under, and what they held back (live pools only). */
  guard?: EngineGuardReport
  /** ONE BRAIN AB-6 — campaigns the rebalances left at their budget: a product's brain owns it, or the Owner holds it. */
  leverHeld?: LeverSkipCounts
  leverHoldsUnread?: boolean
}

/** 1d — a rebalance writes one budget per allocation that has a campaign and a shift. */
const movesOf = (proposed: ProposedAllocation[]): number => proposed.filter((p) => p.campaignId && p.shiftCents !== 0).length

export async function runBudgetPoolRebalanceOnce(): Promise<TickSummary> {
  const startedAt = Date.now()
  const pools = await prisma.budgetPool.findMany({
    where: { enabled: true },
    select: { id: true, dryRun: true },
  })
  let rebalanced = 0
  let appliedLive = 0
  let skipped = 0
  let totalShiftCents = 0
  const leverHeld: LeverSkipCounts = {}
  let leverHoldsUnread = false
  const noteHeld = (o: { leverHeld?: { counts: LeverSkipCounts; unread?: true } }) => {
    addLeverSkipCounts(leverHeld, o.leverHeld?.counts)
    if (o.leverHeld?.unread) leverHoldsUnread = true
  }
  // 1d — only a live pool writes, so only then are the dial and the caps read.
  const guard = pools.some((p) => !p.dryRun) ? await openEngineGuard('budget-pools') : null
  for (const p of pools) {
    const permit = !p.dryRun && guard ? guard.permit() : null
    if (permit && !permit.forward) {
      const held = nothingHeld()
      if (guard!.posture === 'suggest') {
        // The native dry run: the audit row records what it would move (its cool-down starts, as for a dry-run pool).
        const dry = await rebalanceAndAudit({ poolId: p.id, triggeredBy: 'cron', actor: BUDGET_POOL_CRON_ACTOR, forceDryRun: true })
        noteHeld(dry)
        if (dry.skipped) skipped += 1
        else { rebalanced += 1; totalShiftCents += dry.totalShiftCents }
        held.forward = dry.ok && !dry.skipped && movesOf(dry.proposed) > 0
      } else {
        // Capped or stopped: computed only (computeRebalance writes nothing), so no audit row and no cool-down.
        const would = await computeRebalance({ poolId: p.id, triggeredBy: 'cron' })
        skipped += 1
        held.forward = would.ok && !would.skipped && movesOf(would.proposed) > 0
      }
      guard!.settle(permit, 0, held)
      continue
    }
    const outcome = await rebalanceAndAudit({
      poolId: p.id,
      triggeredBy: 'cron',
      actor: BUDGET_POOL_CRON_ACTOR,
    })
    if (permit) guard!.settle(permit, outcome.applied?.applied ?? 0, nothingHeld())
    noteHeld(outcome)
    if (outcome.skipped) {
      skipped += 1
      continue
    }
    rebalanced += 1
    totalShiftCents += outcome.totalShiftCents
    if (outcome.applied && outcome.applied.applied > 0) appliedLive += 1
  }
  const summary: TickSummary = {
    poolsConsidered: pools.length,
    poolsRebalanced: rebalanced,
    poolsAppliedLive: appliedLive,
    poolsSkipped: skipped,
    totalShiftCents,
    durationMs: Date.now() - startedAt,
    ...(guard ? { guard: guard.report() } : {}),
    ...(Object.keys(leverHeld).length ? { leverHeld } : {}),
    ...(leverHoldsUnread ? { leverHoldsUnread } : {}),
  }
  lastRunAt = new Date()
  lastSummary = `pools=${pools.length} rebalanced=${rebalanced} live=${appliedLive} skipped=${skipped} shift=${totalShiftCents}¢ ${summary.durationMs}ms${engineGuardNote(summary.guard, {
    suggest: 'each due rebalance of a live pool is recorded as a dry run; nothing is written',
    stopped: 'nothing is written; rebalances wait for Resume',
  })}${leverSkipNote(leverHeld, leverHoldsUnread)}`
  return summary
}

export async function runBudgetPoolRebalanceCron(): Promise<void> {
  try {
    await recordCronRun('budget-pool-rebalance', async () => {
      const s = await runBudgetPoolRebalanceOnce()
      logger.info('budget-pool-rebalance cron: completed', { summary: s })
      return lastSummary ?? 'no-summary'
    })
  } catch (err) {
    logger.error('budget-pool-rebalance cron: failure', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export function startBudgetPoolRebalanceCron(): void {
  if (scheduledTask) {
    logger.warn('budget-pool-rebalance cron already started')
    return
  }
  // Every 15 min — the pool's own coolDownMinutes is the real gate.
  // 15 min is just the responsiveness floor (gives the worker a chance
  // to react quickly when an operator manually flips dryRun=false).
  const schedule = process.env.NEXUS_BUDGET_POOL_REBALANCE_SCHEDULE ?? '*/15 * * * *'
  if (!cron.validate(schedule)) {
    logger.error('budget-pool-rebalance cron: invalid schedule', { schedule })
    return
  }
  scheduledTask = cron.schedule(schedule, async () => {
    await runBudgetPoolRebalanceCron()
  })
  logger.info('budget-pool-rebalance cron: scheduled', { schedule })
}

export function stopBudgetPoolRebalanceCron(): void {
  if (scheduledTask) {
    scheduledTask.stop()
    scheduledTask = null
  }
}

export function getBudgetPoolRebalanceStatus(): {
  scheduled: boolean
  lastRunAt: Date | null
  lastSummary: string | null
} {
  return { scheduled: scheduledTask != null, lastRunAt, lastSummary }
}
