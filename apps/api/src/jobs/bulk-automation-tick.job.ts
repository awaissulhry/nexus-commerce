/**
 * W7.2 — Bulk-ops automation `bulk_cron_tick` emitter.
 *
 * Fires every 15 min. Mirrors the replenishment 'cron_tick' but
 * scoped to `domain='bulk-operations'` so bulk rules don't fire on
 * the replenishment evaluator's clock and vice versa.
 *
 * Use case: scheduled hygiene rules. "Every 15 min, if more than 50
 * BulkActionJobs failed in the last hour, pause every active
 * schedule." That rule is two pieces — the trigger (this tick) +
 * conditions evaluating against the bulk-job aggregates the rule
 * can read via field paths.
 *
 * Default-ON; the evaluator itself is gated by per-rule `enabled`
 * + dry-run, so a tick with no rules is a sub-millisecond no-op.
 */

import { recordCronRun } from '../utils/cron-observability.js'
import { logger } from '../utils/logger.js'
import { fireBulkCronTick } from '../services/automation/bulk-ops-triggers.js'

const TICK_INTERVAL_MS = 15 * 60 * 1000

let tickTimer: NodeJS.Timeout | null = null

export async function runBulkAutomationTickOnce(): Promise<void> {
  await recordCronRun('bulk-automation-tick', async () => {
    await fireBulkCronTick()
    return 'fired'
  }).catch((err) => {
    logger.warn(
      `[bulk-automation-tick] failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  })
}

export function startBulkAutomationTickCron(): void {
  if (tickTimer) return
  // Don't fire at boot — the replenishment cron tick already fires
  // at boot, and double-firing every 'cron_tick' family at startup
  // could surprise operators with two runs in close succession on
  // the audit log. Wait one interval.
  tickTimer = setInterval(() => {
    void runBulkAutomationTickOnce()
  }, TICK_INTERVAL_MS)
}

export function stopBulkAutomationTickCron(): void {
  if (tickTimer) {
    clearInterval(tickTimer)
    tickTimer = null
  }
}
