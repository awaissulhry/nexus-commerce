/**
 * AX-IE.1 — keep the Amazon cross-channel shadow from rotting.
 *
 * `MarketingCampaign` + `CampaignMetric` mirror the canonical `Campaign` /
 * `AmazonAdsDailyPerformance` tables for the UM cross-channel cockpit
 * (/marketing/campaigns). The mirror is populated by backfillAmazonShadow, which
 * until now had exactly ONE caller — a manual endpoint — and no schedule.
 *
 * The result was a shadow frozen at its migration date: 338 Amazon campaigns
 * against the canonical 196, because 338 is the PRE-dedup count from AF.1d
 * (338 -> 169 duplicate merge) and nothing ever re-ran the copy. Two campaign
 * pages, two different answers, no way for either to explain itself.
 *
 * This cron closes that. Nightly is the right cadence: the shadow feeds a
 * cross-channel overview, not an operational bidding surface — anything
 * Amazon-ads-facing reads the canonical tables directly (see
 * docs/CANONICAL-ADS-MODELS.md).
 *
 * Safety: backfillAmazonShadow is idempotent delete-then-insert scoped to
 * channel=AMAZON. It NEVER writes the canonical Generation A tables, so the ads
 * cockpit cannot be damaged by this job. Reverting is removing the start call —
 * the failure mode of rollback is simply today's behaviour (a stale shadow).
 *
 * Gated with the other marketing crons and registered in CRON_REGISTRY so it can
 * be triggered by hand from the cron status panel.
 */

import cron from 'node-cron'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null

export async function runMarketingAmazonShadowBackfillCron(): Promise<void> {
  try {
    await recordCronRun('marketing-amazon-shadow-backfill', async () => {
      const { backfillAmazonShadow } = await import('../services/marketing/amazon-backfill.service.js')
      const r = await backfillAmazonShadow({ apply: true })
      // Parity is the signal worth surfacing: it compares the shadow against the
      // canonical source it was copied from. A false here means the two campaign
      // surfaces would disagree again, so it belongs in the cron audit summary.
      const parity = r.parity ? (r.parity.ok ? 'ok' : `MISMATCH campaigns=${r.parity.campaignsOk} metrics=${r.parity.metricsOk} cost=${r.parity.costOk}`) : 'n/a'
      if (r.parity && !r.parity.ok) {
        logger.warn('[marketing-amazon-shadow-backfill] parity mismatch after apply', { parity: r.parity })
      }
      return `campaigns=${r.written.campaigns} links=${r.written.links} metrics=${r.written.metrics} fxMissing=${r.fxMissing} parity=${parity}`
    })
  } catch (err) {
    logger.error('marketing-amazon-shadow-backfill cron: failure', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export function startMarketingAmazonShadowBackfillCron(): void {
  if (scheduledTask) {
    logger.warn('marketing-amazon-shadow-backfill cron already started')
    return
  }
  // 03:20 UTC nightly — after the Amazon sales/ads ingest crons have landed the
  // day's canonical rows, so the shadow copies a settled source rather than a
  // half-written one.
  scheduledTask = cron.schedule('20 3 * * *', () => void runMarketingAmazonShadowBackfillCron())
  logger.info('marketing-amazon-shadow-backfill cron scheduled (20 3 * * *)')
}
