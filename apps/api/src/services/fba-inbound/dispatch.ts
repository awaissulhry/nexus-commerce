/**
 * Step 4 Send to FBA — run a plan soon (the publication-batch pattern, `services/pim/publication-batch.service.ts`).
 * With queue workers (ENABLE_QUEUE_WORKERS=1) the plan goes on the `fba-inbound` queue (job id `fba-plan-<id>`: a
 * second dispatch while one waits is the same job); without them it runs in this process, as on the private stack and
 * in tests. Either way a second dispatch is harmless: only the run that claims the plan works (runner.ts).
 *
 * In this process only: a run that ends waiting for Amazon (`nextCheckAt` set: an operation still running, a rate wait,
 * a hold) is looked at again at that time — the private stack has no scheduler. With workers, the resume job does it
 * (`jobs/fba-inbound-resume.job.ts`, every minute).
 */
import { logger } from '../../utils/logger.js'
import { fbaPlanJobId } from './contract.js'
import { runFbaPlan } from './runner.js'

/** In-process follow-ups wait at most this long (a hold re-checks every 15 minutes). */
const INLINE_FOLLOW_UP_MAX_MS = 20 * 60_000

export async function dispatchFbaPlan(planRowId: string): Promise<'queued' | 'inline'> {
  if (process.env.ENABLE_QUEUE_WORKERS === '1') {
    try {
      const { fbaInboundQueue } = await import('../../lib/queue.js')
      await fbaInboundQueue.add('run', { planRowId }, { jobId: fbaPlanJobId(planRowId) })
      return 'queued'
    } catch (error) {
      logger.warn('[fba-inbound] queueing failed; running the plan in this process instead', { planRowId, error: error instanceof Error ? error.message : String(error) })
    }
  }
  setImmediate(() => { void runInline(planRowId) })
  return 'inline'
}

async function runInline(planRowId: string): Promise<void> {
  try {
    const outcome = await runFbaPlan(planRowId)
    if (!outcome.claimed || !outcome.nextCheckAt) return
    const wait = Math.max(1_000, outcome.nextCheckAt.getTime() - Date.now())
    if (wait > INLINE_FOLLOW_UP_MAX_MS) return
    const timer = setTimeout(() => { void dispatchFbaPlan(planRowId) }, wait)
    timer.unref?.()
  } catch (error) {
    logger.error('[fba-inbound] inline run failed; the resume job retries it', { planRowId, error: error instanceof Error ? error.message : String(error) })
  }
}
