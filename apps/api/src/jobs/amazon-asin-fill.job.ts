/**
 * The ASIN sweep: published Amazon listings whose ASIN is not recorded yet read it from Amazon.
 *
 * Publish promotes the rows Amazon accepted and reads their ASINs straight after (`studio-publication.service.ts`),
 * but Amazon often makes a new listing visible minutes later — the first read then says "not visible yet", and the
 * Studio has no later check that reads it again. This sweep is that check: every 30 minutes, per business, up to 50
 * published Amazon rows in a live status with no ASIN, updated in the last seven days (`pendingAsinListingIds`), go
 * through the one filler (`listing-asin-fill.service.ts`). It is idempotent: a filled row leaves the set, and the
 * write never replaces an ASIN already recorded.
 *
 * Default ON; `NEXUS_AMAZON_ASIN_FILL=0` turns it off, `NEXUS_AMAZON_ASIN_FILL_SCHEDULE` moves it.
 */
import cron from '../lib/cron/clustered.js'
import { visitActiveWorkspaces } from '../lib/workspace-sweep.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'

const JOB_NAME = 'amazon-asin-fill'
let scheduledTask: ReturnType<typeof cron.schedule> | null = null

export async function runAmazonAsinFillOnce(): Promise<{ summary: string }> {
  return recordCronRun(JOB_NAME, async () => {
    const { fillAmazonListingAsins, pendingAsinListingIds } = await import('../services/amazon/listing-asin-fill.service.js')
    const totals = { read: 0, filled: 0, not_visible_yet: 0, already_had_asin: 0, error: 0 }
    await visitActiveWorkspaces(async () => {
      const ids = await pendingAsinListingIds()
      if (!ids.length) return
      const { counts } = await fillAmazonListingAsins(ids)
      totals.read += ids.length
      for (const outcome of ['filled', 'not_visible_yet', 'already_had_asin', 'error'] as const) totals[outcome] += counts[outcome]
    })
    return { summary: `read ${totals.read} · filled ${totals.filled} · not visible yet ${totals.not_visible_yet} · already had ${totals.already_had_asin} · errors ${totals.error}` }
  })
}

export function startAmazonAsinFillCron(): void {
  if (process.env.NEXUS_AMAZON_ASIN_FILL === '0') {
    logger.info(`${JOB_NAME}: cron disabled (NEXUS_AMAZON_ASIN_FILL=0)`)
    return
  }
  const schedule = process.env.NEXUS_AMAZON_ASIN_FILL_SCHEDULE || '7,37 * * * *'
  scheduledTask = cron.schedule(schedule, async () => {
    await runAmazonAsinFillOnce().catch(error =>
      logger.error(`${JOB_NAME}: run failed`, { error: error instanceof Error ? error.message : String(error) }))
  })
  logger.info(`${JOB_NAME}: scheduled (${schedule})`)
}

export function stopAmazonAsinFillCron(): void {
  scheduledTask?.stop()
  scheduledTask = null
}
