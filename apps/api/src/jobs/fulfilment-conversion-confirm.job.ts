/**
 * Amazon fulfilment conversion — the CONFIRMATION cron (Owner 2026-10-07: "make sure that it is certain").
 *
 * Amazon accepting a Listings Items patch is not Amazon converting the offer (the API does not document a conversion),
 * so every FBA ⇄ FBM change Nexus sends stays SENT until Amazon's own merchant listings report
 * (GET_MERCHANT_LISTINGS_ALL_DATA, its fulfillment-channel column — the read the FBA drift detector trusts) shows the new
 * channel. Every 15 minutes, and only while a record is SENT or STILL_OLD and under 24 h old, this pulls the report ONCE
 * per account and marketplace through the existing path (`AmazonService.fetchActiveCatalog`) and moves each record:
 * CONFIRMED (the report shows the new channel; the listing's reported copy is rewritten so the Matrix stops showing an
 * old code), STILL_OLD (still the old channel after 3 reads and 4 h: "check Seller Central → Manage Inventory"), or
 * NOT_IN_REPORT. Read-only on Amazon: it never sends anything.
 *
 * Clustered (`lib/cron/clustered.ts`): one run per tick, per active business. Opt out: NEXUS_ENABLE_FULFILMENT_CONFIRM=0.
 */
import cron from '../lib/cron/clustered.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { confirmFulfilmentConversions, conversionsAwaitingReport } from '../services/pim/fulfilment-conversion.service.js'

const JOB = 'fulfilment-conversion-confirm'
const SCHEDULE = process.env.NEXUS_FULFILMENT_CONFIRM_CRON_SCHEDULE ?? '*/15 * * * *'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null

export async function runFulfilmentConversionConfirm(): Promise<void> {
  try {
    // No record waiting = no report pulled (they are throttle-heavy).
    if ((await conversionsAwaitingReport()) === 0) return
    await recordCronRun(JOB, async () => {
      const { AmazonService } = await import('../services/marketplaces/amazon.service.js')
      const amazon = new AmazonService()
      const r = await confirmFulfilmentConversions({ fetchCatalog: (marketplaceId, accountId) => amazon.fetchActiveCatalog(marketplaceId, accountId) })
      return `read ${r.read}; confirmed ${r.confirmed}; still old ${r.stillOld}; not in report ${r.notInReport}; ${r.pullsFailed} pull(s) failed`
    })
  } catch (err) {
    logger.error('fulfilment-conversion-confirm: failure', { error: err instanceof Error ? err.message : String(err) })
  }
}

export function startFulfilmentConversionConfirmCron(): void {
  if (process.env.NEXUS_ENABLE_FULFILMENT_CONFIRM === '0') {
    logger.info('fulfilment-conversion-confirm cron: disabled via env')
    return
  }
  if (scheduledTask) return
  if (!cron.validate(SCHEDULE)) {
    logger.error('fulfilment-conversion-confirm cron: invalid schedule expression', { schedule: SCHEDULE })
    return
  }
  scheduledTask = cron.schedule(SCHEDULE, async () => {
    await runFulfilmentConversionConfirm()
  })
  logger.info(`fulfilment-conversion-confirm cron: scheduled (${SCHEDULE})`)
}
