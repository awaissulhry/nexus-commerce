/**
 * P4.2d — the image read-back sweep actually runs.
 *
 * ## The defect this fixes is the one P4.2c was fixing
 *
 * P4.2c's finding was that Amazon and Shopify had a read-back **function** and no
 * **habit** — nothing scheduled it, so drift stayed invisible until somebody
 * opened a screen. It then shipped the sweep into `CRON_REGISTRY` only, which is
 * a **manual trigger**. Registry-only is exactly the state P4.2c called the
 * defect: a capability with no habit.
 *
 * Reported as *"one variable starts detecting drift"*, which was wrong — the
 * variable alone would have changed nothing, because nothing called it.
 *
 * This is the schedule, built on eBay's (`ebay-image-readback.job.ts`) so the two
 * behave the same way and can be read side by side.
 *
 * ## One switch, not two
 *
 * The cron is gated on the SAME `NEXUS_ENABLE_IMAGE_READBACK_SWEEP` the sweep
 * itself checks. Two switches for one fact is the drift shape this programme
 * keeps finding — and it would produce the worst outcome of all: a scheduled job
 * that runs every six hours and returns "off" every time.
 */

import cron from '../lib/cron/clustered.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'

const JOB_NAME = 'image-readback-sweep'
let scheduledTask: ReturnType<typeof cron.schedule> | null = null

export async function runImageReadbackSweepOnce(): Promise<void> {
  await recordCronRun(JOB_NAME, async () => {
    const { runImageReadbackSweep } = await import('../services/images/live-image-readback.service.js')
    const runs = await runImageReadbackSweep()
    if (runs.length === 0) return { summary: 'off (set NEXUS_ENABLE_IMAGE_READBACK_SWEEP=true)' }
    // `unconfigured` is printed beside `empty` on purpose: a sweep that could not
    // run must never read like a sweep that ran and found nothing.
    return {
      summary: runs
        .map((s) => `${s.channel}: eligible ${s.eligible} · scanned ${s.scanned} · refreshed ${s.refreshed} · empty ${s.empty} · skipped ${s.skipped} · unconfigured ${s.unconfigured} · errored ${s.errored}${s.capped ? ' · CAPPED' : ''}`)
        .join(' | '),
    }
  })
}

export function startImageReadbackSweepCron(): void {
  // The SAME switch the sweep reads. Not a second one.
  if (process.env.NEXUS_ENABLE_IMAGE_READBACK_SWEEP !== 'true') {
    logger.info('image-readback-sweep: cron disabled (set NEXUS_ENABLE_IMAGE_READBACK_SWEEP=true)')
    return
  }
  // Offset from eBay's 6-hourly read-back so the two do not compete for the
  // event loop, and a little later so a deploy does not start both at once.
  const schedule = process.env.NEXUS_IMAGE_READBACK_SCHEDULE || '25 2,8,14,20 * * *'
  scheduledTask = cron.schedule(schedule, async () => {
    await runImageReadbackSweepOnce().catch((err) =>
      logger.error('image-readback-sweep: run failed', { error: err instanceof Error ? err.message : String(err) }),
    )
  })
  logger.info(`image-readback-sweep: scheduled (${schedule})`)
}

export function stopImageReadbackSweepCron(): void {
  scheduledTask?.stop()
  scheduledTask = null
}
