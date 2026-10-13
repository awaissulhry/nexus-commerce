/**
 * Google Ads step 1a — the daily read of each business's Google Ads account (PLAN.md L9; plan-2 §4).
 *
 * 06:25 UTC every day (a free minute: 06:15 is auto-undo, 06:35 the structural reconcile), moved by
 * NEXUS_GOOGLE_ADS_SYNC_SCHEDULE; NEXUS_GOOGLE_ADS_SYNC=off schedules nothing. Cluster-safe through lib/cron/clustered.ts
 * (hard rule 7): with business profiles on it runs once per business, inside that business.
 *
 * Only a business with a chosen Google Ads account (an ADS GoogleAccountLink) gets a read and a run record; any other
 * business makes no call and records nothing. With queue workers the reads go on the `google-ads-sync` queue (one job
 * per account and day); without them they run here, one after the other, and the run record carries their outcome.
 * Read-only: the read sends nothing but GoogleAdsService.Search, and the gateway refuses anything else.
 */
import cron from '../lib/cron/clustered.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { logger } from '../utils/logger.js'
import { workspaceIdForQuery } from '../lib/workspace-context.js'
import { googleAdsSyncSchedule, googleAdsSyncSwitchedOff } from '../services/marketing/google-ads/sync-switch.js'

export const GOOGLE_ADS_SYNC_JOB = 'google-ads-sync'

/**
 * The tick's work in the current business. The cron registry's "Run now" passes MANUAL: a read asked for by a person,
 * held to the same once-an-hour rule as Ads › Google's "Read now" (a DAILY job already run today would be dropped by
 * its job id, silently).
 */
export async function runGoogleAdsSyncOnce(now: Date = new Date(), kind: 'DAILY' | 'MANUAL' = 'DAILY'): Promise<string> {
  if (googleAdsSyncSwitchedOff()) return 'off (NEXUS_GOOGLE_ADS_SYNC=off)'
  // Loaded at the tick, not when the scheduler boots.
  const { listReadTargets } = await import('../services/marketing/google-ads/targets.js')
  const targets = await listReadTargets()
  if (targets.length === 0) return 'no Google Ads account chosen'
  const accounts = `${targets.length} Google Ads account${targets.length === 1 ? '' : 's'}`
  if (kind === 'MANUAL' || process.env.ENABLE_QUEUE_WORKERS === '1') {
    const { enqueueGoogleAdsSync } = await import('../services/marketing/google-ads/enqueue.js')
    const answer = await enqueueGoogleAdsSync({ kind })
    return answer.queued ? `queued ${kind === 'MANUAL' ? 'a read' : 'the daily read'} of ${accounts}` : `not queued: ${answer.reason}`
  }
  // No queue consumers: read here, one account after the other.
  const { syncGoogleAdsAccount, syncSummaryLine } = await import('../services/marketing/google-ads/sync.service.js')
  const results = []
  for (const target of targets) results.push(await syncGoogleAdsAccount(target, { kind: 'DAILY', now }))
  return syncSummaryLine(results)
}

const running = new Set<string>()

/** One tick: nothing (no call, no run record) for a business without a chosen Google Ads account. */
export async function runGoogleAdsSyncTick(now: Date = new Date()): Promise<string | null> {
  if (googleAdsSyncSwitchedOff()) return null
  const key = workspaceIdForQuery()
  if (running.has(key)) return null
  running.add(key)
  try {
    const { listReadTargets } = await import('../services/marketing/google-ads/targets.js')
    if ((await listReadTargets()).length === 0) return null
    return await recordCronRun(GOOGLE_ADS_SYNC_JOB, () => runGoogleAdsSyncOnce(now))
  } catch (error) {
    logger.error('[google-ads-sync] daily read failed', { error: error instanceof Error ? error.message : String(error) })
    return null
  } finally {
    running.delete(key)
  }
}

let task: ReturnType<typeof cron.schedule> | null = null

export function startGoogleAdsSyncCron(): void {
  if (task) return
  if (googleAdsSyncSwitchedOff()) {
    logger.info('[google-ads-sync] daily read not scheduled (NEXUS_GOOGLE_ADS_SYNC=off)')
    return
  }
  const schedule = googleAdsSyncSchedule()
  task = cron.schedule(schedule, async () => { await runGoogleAdsSyncTick() }, { timezone: 'Etc/UTC', lockTtlMs: 15 * 60_000 })
  logger.info(`[google-ads-sync] daily read scheduled (${schedule} UTC, per business with a chosen Google Ads account; read-only)`)
}
