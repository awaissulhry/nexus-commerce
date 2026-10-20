/**
 * Meta ads M1 — the daily read of each business's Meta ad account.
 *
 * 06:50 UTC every day (a free minute: 06:25 is Google's read), moved by NEXUS_META_ADS_SYNC_SCHEDULE;
 * NEXUS_META_ADS_SYNC=off schedules nothing. Cluster-safe through lib/cron/clustered.ts (hard rule 7): with business
 * profiles on it runs once per business, inside that business.
 *
 * Only a business with a chosen Meta ad account (an AD_ACCOUNT MetaAccountLink) gets a read and a run record; any other
 * business makes no call and records nothing. With queue workers the reads go on the `meta-ads-sync` queue (one job per
 * account and day); without them they run here, one after the other, and the run record carries their outcome.
 * Read-only: the read sends nothing but GET, and the gateway refuses anything else.
 */
import cron from '../lib/cron/clustered.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { logger } from '../utils/logger.js'
import { workspaceIdForQuery } from '../lib/workspace-context.js'
import { metaAdsSyncSchedule, metaAdsSyncSwitchedOff } from '../services/marketing/meta-ads/sync-switch.js'

export const META_ADS_SYNC_JOB = 'meta-ads-sync'

/** The tick's work in the current business. The cron registry's "Run now" passes MANUAL (once an hour, as "Read now"). */
export async function runMetaAdsSyncOnce(now: Date = new Date(), kind: 'DAILY' | 'MANUAL' = 'DAILY'): Promise<string> {
  if (metaAdsSyncSwitchedOff()) return 'off (NEXUS_META_ADS_SYNC=off)'
  const { listMetaReadTargets } = await import('../services/marketing/meta-ads/targets.js')
  const targets = await listMetaReadTargets()
  if (targets.length === 0) return 'no Meta ad account chosen'
  const accounts = `${targets.length} Meta ad account${targets.length === 1 ? '' : 's'}`
  if (kind === 'MANUAL' || process.env.ENABLE_QUEUE_WORKERS === '1') {
    const { enqueueMetaAdsSync } = await import('../services/marketing/meta-ads/enqueue.js')
    const answer = await enqueueMetaAdsSync({ kind })
    return answer.queued ? `queued ${kind === 'MANUAL' ? 'a read' : 'the daily read'} of ${accounts}` : `not queued: ${answer.reason}`
  }
  const { syncMetaAdAccount, metaSyncSummaryLine } = await import('../services/marketing/meta-ads/sync.service.js')
  const results = []
  for (const target of targets) results.push(await syncMetaAdAccount(target, { kind: 'DAILY', now }))
  return metaSyncSummaryLine(results)
}

const running = new Set<string>()

/** One tick: nothing (no call, no run record) for a business without a chosen Meta ad account. */
export async function runMetaAdsSyncTick(now: Date = new Date()): Promise<string | null> {
  if (metaAdsSyncSwitchedOff()) return null
  const key = workspaceIdForQuery()
  if (running.has(key)) return null
  running.add(key)
  try {
    const { listMetaReadTargets } = await import('../services/marketing/meta-ads/targets.js')
    if ((await listMetaReadTargets()).length === 0) return null
    return await recordCronRun(META_ADS_SYNC_JOB, () => runMetaAdsSyncOnce(now))
  } catch (error) {
    logger.error('[meta-ads-sync] daily read failed', { error: error instanceof Error ? error.message : String(error) })
    return null
  } finally {
    running.delete(key)
  }
}

let task: ReturnType<typeof cron.schedule> | null = null

export function startMetaAdsSyncCron(): void {
  if (task) return
  if (metaAdsSyncSwitchedOff()) {
    logger.info('[meta-ads-sync] daily read not scheduled (NEXUS_META_ADS_SYNC=off)')
    return
  }
  const schedule = metaAdsSyncSchedule()
  task = cron.schedule(schedule, async () => { await runMetaAdsSyncTick() }, { timezone: 'Etc/UTC', lockTtlMs: 15 * 60_000 })
  logger.info(`[meta-ads-sync] daily read scheduled (${schedule} UTC, per business with a chosen Meta ad account; read-only)`)
}
