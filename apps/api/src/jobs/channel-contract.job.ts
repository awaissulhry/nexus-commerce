/**
 * P1.8 — the nightly channel contract run (FINAL-PLAN section 13.7).
 *
 * It asks each channel's sandbox for one read and one dry-run write per operation and checks the shape
 * of the answer, so a channel change turns red here instead of on a live listing.
 *
 * The cron record: a RED run fails the row (FAILED). Otherwise the row completes with the run's own status —
 * green SUCCESS, partial PARTIAL, not-configured NOT_CONFIGURED — and a summary that opens with how much was
 * proven ("5/9 required operations proven — Partial, not green. Not proven: …"). Only SUCCESS is drawn green.
 * A channel with no sandbox (Etsy) is not applicable — stated in the summary, outside the verdict — so a run
 * where everything applicable passed is SUCCESS (review 2026-09-26).
 *
 * It is **off until the Owner turns it on**: `NEXUS_ENABLE_CHANNEL_CONTRACT_RUN=true` plus one sandbox
 * account per channel (`NEXUS_CONTRACT_ACCOUNT_EBAY`, …). With the switch off nothing is scheduled and
 * nothing is sent. Schedule: `NEXUS_CHANNEL_CONTRACT_SCHEDULE` (default 03:20 every night).
 */
import cron from '../lib/cron/clustered.js'
import { logger } from '../utils/logger.js'
import { recordCronRun, type CronCompletedStatus } from '../utils/cron-observability.js'
import { isContractRunEnabled, runChannelContracts, type ContractRunSummary } from '../services/contract/contract-run.service.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null
let lastSummary: ContractRunSummary | null = null

const CRON_STATUS: Record<Exclude<ContractRunSummary['status'], 'red'>, CronCompletedStatus> = {
  green: 'SUCCESS', partial: 'PARTIAL', 'not-configured': 'NOT_CONFIGURED',
}

/** The CronRun row's view of a finished run. A red run throws: it must be loud in the row itself. */
function cronResultOf(run: ContractRunSummary): { summary: string; cronStatus: CronCompletedStatus } {
  if (run.status === 'red') throw new Error(run.sentence)
  return { summary: run.sentence, cronStatus: CRON_STATUS[run.status] }
}

/** The nightly tick: one run, recorded as one CronRun row. Never throws — the summary is the result. */
export async function runChannelContractsOnce(triggeredBy: 'cron' | 'manual' = 'cron'): Promise<ContractRunSummary> {
  // THIS run's summary, kept apart from `lastSummary`: a run that throws before it finishes must report
  // itself, never the previous night's result.
  const tonight: { run: ContractRunSummary | null } = { run: null }
  try {
    await recordCronRun('channel-contract-run', async () => {
      const run = await runChannelContracts()
      tonight.run = lastSummary = run
      return cronResultOf(run)
    }, { triggeredBy })
    return tonight.run!
  } catch (error) {
    if (tonight.run) return tonight.run
    const failed: ContractRunSummary = {
      status: 'red', passed: 0, failed: 0, notConfigured: 0, notApplicable: 0, required: 0, proven: 0, channels: [], gaps: [], results: [],
      sentence: `The channel contract run did not complete: ${error instanceof Error ? error.message : String(error)}`,
    }
    lastSummary = failed
    return failed
  }
}

/**
 * The hub's manual trigger (cron-registry). The trigger route records the run as ONE CronRun row, so this
 * opens none of its own, and it honours the switch: off means "not run", said as NOT_CONFIGURED.
 */
export async function runChannelContractsManual(): Promise<{ summary: string; cronStatus: CronCompletedStatus }> {
  if (!isContractRunEnabled()) {
    return { summary: 'Not run: the channel contract run is switched off (NEXUS_ENABLE_CHANNEL_CONTRACT_RUN is not "true"); nothing was sent.', cronStatus: 'NOT_CONFIGURED' }
  }
  const run = await runChannelContracts()
  lastSummary = run
  return cronResultOf(run)
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
