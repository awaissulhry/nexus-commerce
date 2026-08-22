/**
 * ADM-P6 — the budget-usage sampler.
 *
 * Every five minutes, ask Amazon what fraction of each Sponsored Products campaign's
 * daily budget it has consumed, and write down what changed. Five API calls a tick
 * covers the whole account (100 campaign ids per call; IT needs two).
 *
 * 🔴 Why a sampler and not a read-through. Neither source of this figure has any
 * history: Amazon's stream is never backfilled and the pull API answers only for
 * NOW. So "Out-of-Budget Hours" and "Actively Bidding Hours" can only ever count
 * hours somebody was watching — and every hour not sampled is a hole that cannot be
 * filled in later. The sampler is the measurement; the column is just its display.
 *
 * Read-only against Amazon (a POST, but a query endpoint — no entity is written),
 * so there are no write-gate or autonomy concerns.
 *
 * Default ON: a sampler that has to be switched on is a sampler that spends its
 * first week not measuring. `NEXUS_DISABLE_BUDGET_USAGE_CRON=1` stops it.
 */

import cron from 'node-cron'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { envEnabled } from '../utils/env-flag.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null

export const BUDGET_USAGE_SCHEDULE = '*/5 * * * *'

export async function runBudgetUsageSample(): Promise<void> {
  try {
    await recordCronRun('budget-usage-sample', async () => {
      const { sampleBudgetUsage } = await import('../services/advertising/ads-budget-usage.service.js')
      const r = await sampleBudgetUsage()
      const head = `profiles=${r.profiles} asked=${r.asked} answered=${r.answered} refused=${r.refused} new=${r.newReadings} refreshed=${r.refreshed}`
      // ACR.0.2's lesson, applied here: a tick where every profile failed must not
      // read as SUCCESS. A green row over a dead sampler is how a column goes quietly
      // stale for a month while its cron history looks perfect.
      if (r.errors.length && r.answered === 0) {
        throw new Error(`${head} — nothing answered: ${r.errors.slice(0, 3).join(' | ')}`)
      }
      return r.errors.length ? `${head} — ${r.errors.slice(0, 3).join(' | ')}` : head
    })
  } catch (err) {
    logger.error('budget-usage-sample cron: failure', { error: err instanceof Error ? err.message : String(err) })
  }
}

export function startBudgetUsageCron(): void {
  if (scheduledTask) { logger.warn('budget-usage-sample cron already started'); return }
  if (envEnabled('NEXUS_DISABLE_BUDGET_USAGE_CRON')) {
    logger.info('budget-usage-sample cron NOT scheduled (NEXUS_DISABLE_BUDGET_USAGE_CRON set) — manual trigger still available')
    return
  }
  scheduledTask = cron.schedule(BUDGET_USAGE_SCHEDULE, () => void runBudgetUsageSample())
  logger.info(`budget-usage-sample cron scheduled (${BUDGET_USAGE_SCHEDULE})`)
}

export function stopBudgetUsageCron(): void {
  scheduledTask?.stop(); scheduledTask = null
}
