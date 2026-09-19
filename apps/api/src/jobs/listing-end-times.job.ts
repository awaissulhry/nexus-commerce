/**
 * Shared stock plan step 3 — end listing overrides on time: "Fixed number until …", "Paused until …",
 * and the same for shared eBay variants (services/listing-end-times.service.ts).
 *
 * Once a minute, per business (the clustered wrapper visits each active business under a lease, so
 * replicas never double-run it). An override therefore ends within about a minute of its end time.
 * Most minutes nothing is due: one probe on partial indexes (listing-end-times.sql), and no run is
 * recorded. A write that fails leaves the end time in place, so the next minute tries again.
 */
import cron from '../lib/cron/clustered.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { endDueOverrides, hasDueEndTimes } from '../services/listing-end-times.service.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null

export function startListingEndTimesCron(): void {
  if (scheduledTask) return
  scheduledTask = cron.schedule('* * * * *', async () => {
    try {
      if (!(await hasDueEndTimes())) return
      await recordCronRun('listing-end-times', async () => {
        const result = await endDueOverrides()
        logger.info('listing-end-times: ended overrides', result)
        return `fixed=${result.fixedEnded} fbaLapsed=${result.fixedLapsedFba} paused=${result.pausesEnded} sharedFixed=${result.sharedFixedEnded} sharedExcluded=${result.sharedExclusionsEnded} retryLater=${result.retryLater}`
      })
    } catch (error) {
      logger.warn('listing-end-times: sweep failed', { error: error instanceof Error ? error.message : String(error) })
    }
  })
}
