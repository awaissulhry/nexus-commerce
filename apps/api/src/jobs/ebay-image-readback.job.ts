/**
 * eBay live-IMAGE read-back sweep.
 *
 * Keeps the ChannelLiveImage read-replica (the "Live on eBay" strip in the
 * images panel) fresh for every eBay-listed product WITHOUT the operator
 * hitting Refresh — the real-time half of the read-back. Read-only against
 * eBay (GetItem PictureDetails + VariationSpecificPictureSet) + a full-replace
 * of our replica rows; it NEVER touches the pool or the live listing.
 *
 * Gated behind NEXUS_ENABLE_EBAY_IMAGE_READBACK_CRON (default ON when
 * NEXUS_EBAY_REAL_API=true — read-only + idempotent). Default schedule: every
 * 6 hours at :45 (offset from the label guard's :15 so they don't collide).
 * Override: NEXUS_EBAY_IMAGE_READBACK_SCHEDULE.
 */

import cron from 'node-cron'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'

const JOB_NAME = 'ebay-image-readback'
let scheduledTask: ReturnType<typeof cron.schedule> | null = null

export async function runEbayImageReadbackOnce(): Promise<void> {
  await recordCronRun(JOB_NAME, async () => {
    const { readbackAllEbayLiveImages } = await import('../services/images/ebay-live-images.service.js')
    const s = await readbackAllEbayLiveImages()
    logger.info('ebay-image-readback: run complete', s as unknown as Record<string, unknown>)
    return { summary: `scanned ${s.scanned} · refreshed ${s.refreshed} · empty ${s.empty} · skipped ${s.skipped} · errored ${s.errored}` }
  })
}

export function startEbayImageReadbackCron(): void {
  const realApi = process.env.NEXUS_EBAY_REAL_API === 'true'
  const enabled = process.env.NEXUS_ENABLE_EBAY_IMAGE_READBACK_CRON
  const on = enabled != null ? enabled === '1' || enabled === 'true' : realApi
  if (!on) {
    logger.info('ebay-image-readback: cron disabled (enable NEXUS_ENABLE_EBAY_IMAGE_READBACK_CRON or NEXUS_EBAY_REAL_API)')
    return
  }
  const schedule = process.env.NEXUS_EBAY_IMAGE_READBACK_SCHEDULE || '45 */6 * * *'
  scheduledTask = cron.schedule(schedule, () => {
    void runEbayImageReadbackOnce().catch((err) =>
      logger.error('ebay-image-readback: run failed', { error: err instanceof Error ? err.message : String(err) }),
    )
  })
  logger.info(`ebay-image-readback: scheduled (${schedule})`)
}

export function stopEbayImageReadbackCron(): void {
  scheduledTask?.stop()
  scheduledTask = null
}
