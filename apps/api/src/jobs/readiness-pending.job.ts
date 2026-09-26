import cron from '../lib/cron/clustered.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { countPendingReadinessFamilies, drainPendingReadiness } from '../services/pim/readiness-index.service.js'
import { describeSweep } from '../services/pim/resumable-sweep.js'

let scheduled: ReturnType<typeof cron.schedule> | null = null

/**
 * P2 (docs/attributes/PLAN.md §4.7) — the durable half of "readiness catches up after a big save".
 *
 * A bulk edit marks the readiness rows of the families it changed as pending (`ReadinessIndex.pendingSince`) in the
 * same transaction as the values, and enqueues one job per family. This drain rebuilds every family that is still
 * pending, oldest first, whether or not a job exists — so queue workers being off, Redis being down or a lost job
 * only add latency, never a stale answer shown as current.
 *
 * Runs every minute with a 45 s budget, so one run never overlaps the next tick's lock. A family is 3–5 s, so a run
 * clears about 10–15 families; the queue worker (when on) works beside it.
 */
export async function runReadinessPendingDrain(): Promise<string> {
  const report = await drainPendingReadiness({ budgetMs: 45_000 })
  const line = describeSweep(report)
  if (report.failed > 0) throw new Error(line)
  return line
}

export function startReadinessPendingCron() {
  if (scheduled || process.env.NEXUS_ENABLE_READINESS_PENDING === '0') return
  scheduled = cron.schedule('* * * * *', async () => {
    // A quiet minute writes nothing: the run is recorded only when there is pending work.
    if (!(await countPendingReadinessFamilies())) return
    await recordCronRun('readiness-pending', runReadinessPendingDrain)
  }, { lockTtlMs: 55_000 })
}
