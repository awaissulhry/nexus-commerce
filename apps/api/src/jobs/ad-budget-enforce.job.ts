/**
 * BM.B3 — Budget Manager enforcement cron. Every 30 min, evaluate every
 * autoPacing / stopOverSpend plan and (dry-run by default) compute the budget
 * + suppression moves. Applies only when NEXUS_BUDGET_ENFORCE_APPLY=1 — and
 * even then the ads-mutation layer short-circuits outside live mode, so this
 * is safe to schedule alongside the other AD-series crons.
 * Gated by NEXUS_ENABLE_AMAZON_ADS_CRON=1 (registered in index.ts).
 */
import cron from 'node-cron'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { applyBudgetEnforcement } from '../services/advertising/ads-budget-enforce.service.js'

let task: ReturnType<typeof cron.schedule> | null = null
let running = false

export async function runBudgetEnforceOnce(): Promise<string> {
  const apply = process.env.NEXUS_BUDGET_ENFORCE_APPLY === '1'
  const r = await applyBudgetEnforcement({ dryRun: !apply, actor: 'automation:budget-manager-cron' })
  return `plans=${r.result.totals.plans} budgetChanges=${r.result.totals.budgetChanges} applied=${r.budgetApplied} suppress=${r.suppressed} restore=${r.restored} failed=${r.failed} ${r.dryRun ? '(dry-run)' : '(LIVE)'}`
}

export async function runBudgetEnforceCron(): Promise<void> {
  try { await recordCronRun('ad-budget-enforce', runBudgetEnforceOnce) }
  catch (err) { logger.error('ad-budget-enforce cron failure', { error: err instanceof Error ? err.message : String(err) }) }
}

export function startBudgetEnforceCron(): void {
  if (task) return
  const schedule = process.env.NEXUS_BUDGET_ENFORCE_SCHEDULE ?? '*/30 * * * *'
  if (!cron.validate(schedule)) { logger.error('ad-budget-enforce cron: invalid schedule', { schedule }); return }
  task = cron.schedule(schedule, () => {
    if (running) { logger.warn('[ad-budget-enforce] previous tick still in flight — skipping'); return }
    running = true
    void runBudgetEnforceCron().finally(() => { running = false })
  })
  logger.info('ad-budget-enforce cron scheduled', { schedule, apply: process.env.NEXUS_BUDGET_ENFORCE_APPLY === '1' })
}
