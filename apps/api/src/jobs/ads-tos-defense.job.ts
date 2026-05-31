/**
 * Apex D.2 — Top-of-Search defense cron.
 *
 * Every 30 min, nudges the PLACEMENT_TOP bid multiplier toward the target so
 * allowlisted campaigns hold the top sponsored slot when ROAS allows and ease
 * off when it doesn't (±STEP_PCT per run, ≤900%). This is the autonomous "always
 * stay on top of search" loop.
 *
 * SAFETY — triple-gated, because it writes live placement bids:
 *   1. NEXUS_ENABLE_TOS_DEFENSE_CRON (default OFF — operator opts in only when ready)
 *   2. allowlistedOnly: writes only to campaigns with Campaign.liveBidWritesEnabled
 *   3. the global ads write-gate (env live + connection production/writesEnabledAt)
 * Registered in CRON_REGISTRY for manual triggering; only auto-scheduled when on.
 */

import cron from 'node-cron'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { envEnabled } from '../utils/env-flag.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null

export async function runTosDefenseCron(): Promise<void> {
  try {
    await recordCronRun('top-of-search-defense', async () => {
      const { defendTopOfSearch } = await import('../services/advertising/ads-top-of-search.service.js')
      const targetAcos = Number(process.env.NEXUS_TOS_TARGET_ACOS)
      const r = await defendTopOfSearch({
        allowlistedOnly: true,
        dryRun: false,
        targetAcos: Number.isFinite(targetAcos) && targetAcos > 0 ? targetAcos : undefined,
      })
      return `evaluated=${r.evaluated} changed=${r.changed} applied=${r.applied} skipped=${r.skippedNotAllowlisted}`
    })
  } catch (err) {
    logger.error('top-of-search-defense cron: failure', { error: err instanceof Error ? err.message : String(err) })
  }
}

export function startTosDefenseCron(): void {
  if (scheduledTask) {
    logger.warn('top-of-search-defense cron already started')
    return
  }
  // Opt-in: only auto-schedule when explicitly enabled (it writes live bids).
  if (!envEnabled('NEXUS_ENABLE_TOS_DEFENSE_CRON')) {
    logger.info('top-of-search-defense cron NOT scheduled (NEXUS_ENABLE_TOS_DEFENSE_CRON off) — manual trigger still available')
    return
  }
  // Every 30 min — well above the daily-grain data, so steps don't thrash.
  scheduledTask = cron.schedule('*/30 * * * *', () => void runTosDefenseCron())
  logger.info('top-of-search-defense cron scheduled (*/30 * * * *)')
}
