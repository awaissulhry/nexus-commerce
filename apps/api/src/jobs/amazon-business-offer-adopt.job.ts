/**
 * Amazon Business step 3b — nightly copy of the business offers Amazon already holds into Nexus (Owner's pick 3B,
 * 2026-10-12; services/amazon/business-offer-adopt.service.ts), only on listings where Nexus has never kept a business
 * price. Step 4 — the same scan verifies the business prices Nexus keeps (`amazonBusinessLive` on the listing) and
 * queues one business send where Amazon differs or holds none; that send is the only thing it sends to Amazon.
 *
 * Runs at 04:30 UTC, after the schema refresh (04:00) has refreshed which markets list the B2B audience for each account.
 * Per business: registered through lib/cron/clustered.ts (hard rule 7), which runs it once per active profile inside
 * withWorkspace. "Run" on the Sync Logs hub starts it by hand (cron-registry.ts). NEXUS_ENABLE_AMAZON_BUSINESS_ADOPT_CRON=0
 * turns the schedule off.
 */
import nodeCron from '../lib/cron/clustered.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { AmazonService } from '../services/marketplaces/amazon.service.js'
import { adoptAmazonBusinessOffers, adoptSummary } from '../services/amazon/business-offer-adopt.service.js'

let scheduledTask: ReturnType<typeof nodeCron.schedule> | null = null
const amazonService = new AmazonService()

export async function runAmazonBusinessOfferAdopt(): Promise<string> {
  return recordCronRun('amazon-business-offer-adopt', async () => {
    if (!(await amazonService.isConfigured())) return 'Amazon SP-API not configured — nothing read'
    const summary = adoptSummary(await adoptAmazonBusinessOffers({ throttleMs: 300, label: 'amazon-business-offer-adopt cron' }))
    logger.info(`amazon-business-offer-adopt cron: ${summary}`)
    return summary
  })
}

export function startAmazonBusinessOfferAdoptCron(): void {
  if (scheduledTask) { logger.warn('amazon-business-offer-adopt cron: already started'); return }
  if (process.env.NEXUS_ENABLE_AMAZON_BUSINESS_ADOPT_CRON === '0') {
    logger.info('amazon-business-offer-adopt cron: disabled (NEXUS_ENABLE_AMAZON_BUSINESS_ADOPT_CRON=0)')
    return
  }
  const schedule = process.env.AMAZON_BUSINESS_ADOPT_CRON_SCHEDULE ?? '30 4 * * *' // 04:30 UTC daily
  scheduledTask = nodeCron.schedule(schedule, async () => {
    await runAmazonBusinessOfferAdopt().catch((err) => logger.error('amazon-business-offer-adopt cron tick failed', { error: err?.message }))
  })
  logger.info(`amazon-business-offer-adopt cron: scheduled (${schedule})`)
}

export function stopAmazonBusinessOfferAdoptCron(): void {
  if (scheduledTask) { scheduledTask.stop(); scheduledTask = null }
}
