/**
 * Option C — Top-of-Search impression-share ingest cron.
 * Runs at 02:30 daily (after Amazon's daily reports are available).
 * Gated by NEXUS_ENABLE_TOS_IS_INGEST_CRON (default OFF — flip on Railway once
 * the probe confirms topOfSearchImpressionShare returns data for this account).
 * The job itself is always available for manual trigger via the cron registry.
 */

import cron from 'node-cron'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { envEnabled } from '../utils/env-flag.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null

export async function runTosIsIngestCron(): Promise<void> {
  try {
    await recordCronRun('tos-is-ingest', async () => {
      const { ingestTopOfSearchIS } = await import('../services/advertising/ads-tos-is-ingest.service.js')
      const r = await ingestTopOfSearchIS({ windowDays: 7 })
      return `profiles=${r.profiles} rowsFetched=${r.rowsFetched} withIS=${r.withIS} rowsUpdated=${r.rowsUpdated} errors=${r.errors.length}`
    })
  } catch (err) {
    logger.error('tos-is-ingest cron: failure', { error: err instanceof Error ? err.message : String(err) })
  }
}

export function startTosIsIngestCron(): void {
  if (scheduledTask) { logger.warn('tos-is-ingest cron already started'); return }
  if (!envEnabled('NEXUS_ENABLE_TOS_IS_INGEST_CRON')) {
    logger.info('tos-is-ingest cron NOT scheduled (NEXUS_ENABLE_TOS_IS_INGEST_CRON off) — manual trigger available once topOfSearchImpressionShare data confirmed')
    return
  }
  scheduledTask = cron.schedule('30 2 * * *', () => void runTosIsIngestCron())
  logger.info('tos-is-ingest cron scheduled (30 2 * * *)')
}

export function stopTosIsIngestCron(): void {
  scheduledTask?.stop(); scheduledTask = null
}
