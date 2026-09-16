/**
 * AE.3 — finish first copies whose product review was applied while nobody was watching.
 *
 * The status poll finishes a run as soon as its transfer job completes. This job is the backstop for
 * when nobody reopens the copy: once a minute, per business (the clustered wrapper visits each active
 * business under a lease, so replicas never double-run it), it advances open runs. Advancing is
 * idempotent and claims the finish step, so a poll and this job can never both run it.
 * Plan: docs/2026-09-16-assortment-engine-plan.md §16.2.
 */
import cron from '../lib/cron/clustered.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { advanceOpenCopyRuns, hasOpenCopyRuns } from '../services/assortment/copy-run.service.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null

export function startAssortmentCopyCron(): void {
  if (scheduledTask) return
  scheduledTask = cron.schedule('* * * * *', async () => {
    try {
      // Most minutes nothing is open. Record a run only when there is work, or this table gains a
      // row per business per minute for nothing (a background loop's cost is invisible in tests).
      if (!(await hasOpenCopyRuns())) return
      await recordCronRun('assortment-copy-finish', async () => {
        const result = await advanceOpenCopyRuns()
        if (result.checked > 0) logger.info('assortment-copy: advanced open copy runs', result)
        return `checked=${result.checked} finished=${result.finished}`
      })
    } catch (error) {
      logger.warn('assortment-copy: sweep failed', { error: error instanceof Error ? error.message : String(error) })
    }
  })
}
