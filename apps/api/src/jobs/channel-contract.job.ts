/**
 * P1.8 — the nightly channel contract run (FINAL-PLAN section 13.7).
 *
 * It asks each channel's sandbox for one read and one dry-run write per operation and checks the shape
 * of the answer, so a channel change turns red here instead of on a live listing.
 *
 * It is **off until the Owner turns it on**: `NEXUS_ENABLE_CHANNEL_CONTRACT_RUN=true` plus one sandbox
 * account per channel (`NEXUS_CONTRACT_ACCOUNT_EBAY`, …). With the switch off nothing is scheduled and
 * nothing is sent. Schedule: `NEXUS_CHANNEL_CONTRACT_SCHEDULE` (default 03:20 every night).
 */
import cron from '../lib/cron/clustered.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { isContractRunEnabled, runChannelContracts, type ContractRunSummary } from '../services/contract/contract-run.service.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null
let lastSummary: ContractRunSummary | null = null

/** One run. Exported so an operator trigger and the tests can fire it without waiting for the night. */
export async function runChannelContractsOnce(triggeredBy: 'cron' | 'manual' = 'cron'): Promise<ContractRunSummary> {
  return recordCronRun('channel-contract-run', async () => {
    const summary = await runChannelContracts()
    lastSummary = summary
    // A red run must be loud in the cron record itself, not only in the log line.
    if (summary.status === 'red') throw new Error(summary.sentence)
    return summary.sentence
  }, { triggeredBy })
    .then(() => lastSummary!)
    .catch(() => lastSummary ?? { status: 'red', passed: 0, failed: 0, notConfigured: 0, results: [], sentence: 'The channel contract run did not complete.' })
}

export function startChannelContractCron(): void {
  if (scheduledTask) {
    logger.warn('channel-contract cron already started — skipping')
    return
  }
  if (!isContractRunEnabled()) {
    logger.info('channel-contract cron: off (set NEXUS_ENABLE_CHANNEL_CONTRACT_RUN=true and one sandbox account per channel)')
    return
  }
  const schedule = process.env.NEXUS_CHANNEL_CONTRACT_SCHEDULE ?? '20 3 * * *'
  if (!cron.validate(schedule)) {
    logger.error('channel-contract cron: invalid schedule', { schedule })
    return
  }
  scheduledTask = cron.schedule(schedule, async () => { await runChannelContractsOnce('cron') })
  logger.info('channel-contract cron: scheduled', { schedule })
}

export function stopChannelContractCron(): void {
  if (scheduledTask) {
    scheduledTask.stop()
    scheduledTask = null
  }
}

export function getChannelContractStatus(): { scheduled: boolean; enabled: boolean; last: ContractRunSummary | null } {
  return { scheduled: scheduledTask !== null, enabled: isContractRunEnabled(), last: lastSummary }
}
