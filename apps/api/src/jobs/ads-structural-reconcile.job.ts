/**
 * AX-VT.5 — the structural reconcile cron.
 *
 * Six-hourly rather than every 10 minutes: this compares the whole account against Amazon, and
 * structural state (names, budgets, portfolio membership, which ads exist) changes on a human
 * timescale, not a bidding one. The bid path already has its own minute-level sweeps.
 *
 * Self-gated on NEXUS_ENABLE_AMAZON_ADS_CRON, the same switch every other ads cron respects, so a
 * credential-less environment stays dormant instead of logging failures every six hours.
 *
 * That gate must go through `envEnabled`, not a `=== 'true'` compare. It read the flag strictly for
 * months while index.ts read it tolerantly, so on a prod that sets the flag to `1` the whole ads
 * fleet started and this one job silently did not — which is why ADX.0 measured zero runs in 14 days
 * and read it as "confirmed off, as predicted". The account had nothing comparing it against Amazon
 * on a schedule, and `ads-sync-integrity` was already reporting that symptom without the cause.
 */
import cron from '../lib/cron/clustered.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { envEnabled } from '../utils/env-flag.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null

export async function runStructuralReconcileCron(): Promise<void> {
  await recordCronRun('ads-structural-reconcile', async () => {
    const { runStructuralReconcileOnce } = await import('../services/advertising/ads-structural-reconcile.service.js')
    const r = await runStructuralReconcileOnce()
    // The summary lands in the CronRun row, so it has to carry the numbers somebody would ask for
    // rather than just "ok" — truncation included, because a silently partial pass reads as a full
    // one and that is the class of lie this whole series exists to remove.
    return [
      `campaigns=${r.campaignsChecked}${r.campaignsTruncated ? `(+${r.campaignsTruncated} skipped)` : ''}`,
      `entities=${r.entitiesChecked}`,
      `verified=${r.verified}`,
      `mismatch=${r.mismatch}`,
      `missing=${r.missingOnAmazon}`,
      `notPushed=${r.notPushed}`,
      `uncovered=${r.uncovered}`,
      `driftOpened=${r.driftRowsOpened}`,
      `driftResolved=${r.driftRowsResolved}`,
      `pfRepaired=${r.portfoliosRepaired}`,
      r.errors.length ? `errors=${r.errors.length}` : '',
    ].filter(Boolean).join(' ')
  }).catch((err) => logger.error('ads-structural-reconcile cron: failure', { error: String(err) }))
}

export function startStructuralReconcileCron(): void {
  if (scheduledTask) { logger.warn('ads-structural-reconcile already started'); return }
  if (!envEnabled('NEXUS_ENABLE_AMAZON_ADS_CRON')) {
    logger.info('ads-structural-reconcile cron: not scheduled (NEXUS_ENABLE_AMAZON_ADS_CRON is off)')
    return
  }
  const schedule = process.env.NEXUS_ADS_STRUCTURAL_RECONCILE_SCHEDULE ?? '35 */6 * * *'
  if (!cron.validate(schedule)) { logger.error('ads-structural-reconcile: invalid schedule', { schedule }); return }
  scheduledTask = cron.schedule(schedule, () => { void runStructuralReconcileCron() })
  logger.info('ads-structural-reconcile cron: scheduled', { schedule })
}
