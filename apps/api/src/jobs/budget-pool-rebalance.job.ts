/**
 * AD.5 — Cron tick for BudgetPool rebalances.
 *
 * Walks every enabled pool, calls rebalanceAndAudit() which respects
 * the per-pool cooldown. Pools in dryRun mode produce only the audit
 * row; pools flipped to live also enqueue the campaign mutations.
 *
 * Gated by NEXUS_ENABLE_AMAZON_ADS_CRON=1 alongside the other AD-series
 * crons.
 */

import cron from 'node-cron'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { rebalanceAndAudit } from '../services/advertising/budget-pool-rebalancer.service.js'

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
}

export async function runBudgetPoolRebalanceOnce(): Promise<TickSummary> {
  const startedAt = Date.now()
  const pools = await prisma.budgetPool.findMany({
    where: { enabled: true },
    select: { id: true },
  })
  let rebalanced = 0
  let appliedLive = 0
  let skipped = 0
  let totalShiftCents = 0
  for (const p of pools) {
    const outcome = await rebalanceAndAudit({
      poolId: p.id,
      triggeredBy: 'cron',
      actor: 'user:cron-budget-pool',
    })
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
  }
  lastRunAt = new Date()
  lastSummary = `pools=${pools.length} rebalanced=${rebalanced} live=${appliedLive} skipped=${skipped} shift=${totalShiftCents}¢ ${summary.durationMs}ms`
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
  scheduledTask = cron.schedule(schedule, () => {
    void runBudgetPoolRebalanceCron()
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
