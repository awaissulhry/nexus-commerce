/**
 * Incident #36 — periodic custom-label guard.
 *
 * The parent-SKU custom label on every membership-backed eBay listing is a
 * guaranteed invariant (see ebay-label-guard.service.ts). Creation and
 * adoption set it inline; this cron is the FOREVER belt: whatever slips
 * through (transient revise failure, an eBay-side surprise, a listing adopted
 * by a path we haven't met yet) self-heals within one cycle — the operator
 * never runs a manual backfill again.
 *
 * Gated behind NEXUS_ENABLE_EBAY_LABEL_GUARD_CRON (default ON when
 * NEXUS_EBAY_REAL_API=true — the guard is metadata-only and idempotent).
 * Default schedule: every 6 hours. Override: NEXUS_EBAY_LABEL_GUARD_SCHEDULE.
 */

import cron from 'node-cron'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'

const JOB_NAME = 'ebay-label-guard'
let scheduledTask: ReturnType<typeof cron.schedule> | null = null

export async function runEbayLabelGuardOnce(): Promise<void> {
  await recordCronRun(JOB_NAME, async () => {
    const { ensureListingLabels, relinkNullPoolMemberships } = await import('../services/ebay-label-guard.service.js')
    // FFT-I2 — pool-link self-heal rides the same tick (cheap when clean).
    const relink = await relinkNullPoolMemberships()
    const summary = await ensureListingLabels()
    if (relink.relinked > 0) {
      return `relinked ${relink.relinked}/${relink.scanned} null pool links · labels: ${JSON.stringify(summary)}`
    }
    logger.info('ebay-label-guard: run complete', summary as unknown as Record<string, unknown>)
    return { summary: `checked ${summary.checked} · set ${summary.set} · kept ${summary.kept} · unsupported ${summary.unsupported} · failed ${summary.failed}` }
  })
}

export function startEbayLabelGuardCron(): void {
  const realApi = process.env.NEXUS_EBAY_REAL_API === 'true'
  const enabled = process.env.NEXUS_ENABLE_EBAY_LABEL_GUARD_CRON
  const on = enabled != null ? enabled === '1' || enabled === 'true' : realApi
  if (!on) {
    logger.info('ebay-label-guard: cron disabled (enable NEXUS_ENABLE_EBAY_LABEL_GUARD_CRON or NEXUS_EBAY_REAL_API)')
    return
  }
  const schedule = process.env.NEXUS_EBAY_LABEL_GUARD_SCHEDULE || '15 */6 * * *'
  scheduledTask = cron.schedule(schedule, () => {
    void runEbayLabelGuardOnce().catch((err) =>
      logger.error('ebay-label-guard: run failed', { error: err instanceof Error ? err.message : String(err) }),
    )
  })
  logger.info(`ebay-label-guard: scheduled (${schedule})`)
}

export function stopEbayLabelGuardCron(): void {
  scheduledTask?.stop()
  scheduledTask = null
}
