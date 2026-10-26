/**
 * Negative Targeting step 4 — "Remove protection and stop" finishes on the server: the negatives that wait for a
 * protected term's removal are sent once it ran, as the person who approved it (services/advertising/waste/follow-up.ts).
 *
 * About once a minute (second 15 of each minute: the clustered cron gives a job one tick per minute per business,
 * lib/cron/clustered.ts), after the approval maintenance pass (approval-maintenance.job.ts) ran the removal once its 20 s
 * undo window closed: so a negative follows within about two minutes even when nobody keeps the page open. Each
 * follow-up is claimed before it is sent, so a page's "now" and this pass never send it twice.
 */
import cron from '../lib/cron/clustered.js'
import { runDueFollowUps } from '../services/advertising/waste/follow-up.js'
import { logger } from '../utils/logger.js'

let running = false

export async function runWasteFollowUpsOnce(): Promise<string> {
  if (running) return 'skipped=overlap'
  running = true
  try {
    const r = await runDueFollowUps()
    return `ran=${r.ran} sent=${r.sent} closed=${r.closed}`
  } finally {
    running = false
  }
}

let task: ReturnType<typeof cron.schedule> | null = null

export function startWasteFollowUpCron(): void {
  if (task) return
  const schedule = process.env.NEXUS_WASTE_FOLLOW_UP_SCHEDULE ?? '15 * * * * *'
  if (!cron.validate(schedule)) {
    logger.error(`[waste-follow-up] invalid schedule "${schedule}" — cron not started`)
    return
  }
  task = cron.schedule(schedule, async () => {
    await runWasteFollowUpsOnce().catch((err) => logger.error('[waste-follow-up] failed', { error: String(err) }))
  })
  logger.info(`[waste-follow-up] negatives after a protection's removal scheduled (${schedule})`)
}
