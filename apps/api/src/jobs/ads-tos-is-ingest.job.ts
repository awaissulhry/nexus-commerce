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
      const head = `profiles=${r.profiles} rowsFetched=${r.rowsFetched} withIS=${r.withIS} rowsUpdated=${r.rowsUpdated} errors=${r.errors.length}`
      // ACR.0.2: a job whose every profile failed must not read as SUCCESS.
      //
      // This ran `profiles=9 … errors=9` — a 100% failure — for months under a green
      // CronRun, because the summary carried the error COUNT and never a message. Throwing
      // here is what makes the row FAILED and puts the cause where somebody will find it.
      if (r.errors.length && r.errors.length >= r.profiles) {
        throw new Error(`${head} — every profile failed: ${r.errors.slice(0, 3).join(' | ')}`)
      }
      // A partial failure stays SUCCESS (some profiles delivered) but still says what broke.
      return r.errors.length ? `${head} — ${r.errors.slice(0, 3).join(' | ')}` : head
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
