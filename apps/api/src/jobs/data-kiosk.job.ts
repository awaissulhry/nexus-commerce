/**
 * Phase 2 — Data Kiosk economics crons.
 *
 * TWO separate crons, deliberately, because Data Kiosk's timings force it:
 *
 *  · CREATE (daily) — createQuery is rate-limited to ~1/min and a rejected
 *    query still consumes quota, so queries are created once a day and the
 *    service spaces multiple marketplaces itself.
 *
 *  · POLL (every 10 min) — an `economics` query took OVER 11 MINUTES to reach
 *    DONE in testing, so polling has to be resumable across ticks rather than
 *    inline. This is only safe because Data Kiosk mints its 300s signed URL at
 *    the DOCUMENT step, not the status step: the poll cycle downloads and
 *    ingests immediately upon seeing DONE, inside the same tick.
 *
 * Both are gated on NEXUS_ENABLE_DATA_KIOSK_CRON so environments without
 * SP-API credentials stay dormant.
 */

import cron from 'node-cron'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { runEconomicsCreateCycle, runDataKioskPollCycle } from '../services/amazon/data-kiosk.service.js'

let createTask: ReturnType<typeof cron.schedule> | null = null
let pollTask: ReturnType<typeof cron.schedule> | null = null

/** Marketplaces to query. Defaults to the primary; comma-separated override. */
function marketplaceIds(): string[] {
  const raw = process.env.NEXUS_DATA_KIOSK_MARKETPLACES
  if (raw) return raw.split(',').map((s) => s.trim()).filter(Boolean)
  return [process.env.AMAZON_MARKETPLACE_ID].filter((v): v is string => !!v)
}

export async function runDataKioskCreateCron(): Promise<void> {
  await recordCronRun('data-kiosk-economics-create', async () => {
    // Economics restates for a few days, so re-request a trailing window
    // rather than a single day. T-2 end date avoids the incomplete tail.
    const end = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10)
    const start = new Date(Date.now() - 9 * 86400000).toISOString().slice(0, 10)
    const out = await runEconomicsCreateCycle({ startDate: start, endDate: end, marketplaceIds: marketplaceIds() })
    return `created=${out.created} skipped=${out.skipped} errors=${out.errors.length}${out.errors.length ? ` — ${out.errors[0]}` : ''}`
  }).catch((err) => logger.error('data-kiosk-economics-create cron: failure', { error: String(err) }))
}

export async function runDataKioskPollCron(): Promise<void> {
  await recordCronRun('data-kiosk-poll', async () => {
    const out = await runDataKioskPollCycle()
    return `polled=${out.polled} done=${out.completed} running=${out.stillRunning} failed=${out.failed} rows=${out.rowsIngested} errors=${out.errors.length}`
  }).catch((err) => logger.error('data-kiosk-poll cron: failure', { error: String(err) }))
}

export function startDataKioskCrons(): void {
  if (createTask || pollTask) { logger.warn('data-kiosk crons already started'); return }

  const createSchedule = process.env.NEXUS_DATA_KIOSK_CREATE_SCHEDULE ?? '20 3 * * *'
  const pollSchedule = process.env.NEXUS_DATA_KIOSK_POLL_SCHEDULE ?? '*/10 * * * *'

  if (!cron.validate(createSchedule)) { logger.error('data-kiosk-create: invalid schedule', { createSchedule }); return }
  if (!cron.validate(pollSchedule)) { logger.error('data-kiosk-poll: invalid schedule', { pollSchedule }); return }

  createTask = cron.schedule(createSchedule, () => { void runDataKioskCreateCron() })
  pollTask = cron.schedule(pollSchedule, () => { void runDataKioskPollCron() })
  logger.info('data-kiosk crons: scheduled', { createSchedule, pollSchedule })
}
