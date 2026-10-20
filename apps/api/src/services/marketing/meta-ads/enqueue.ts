/**
 * Meta ads M1 — ask for a read of this business's Meta ad account(s).
 *
 *   BACKFILL  the first read, queued when a person saves the ad account choice
 *   DAILY     the 06:50 UTC cron (jobs/ads-meta-sync.job.ts)
 *   MANUAL    "Read now" (POST /api/meta-ads/sync): at most once an hour per account, refused in words otherwise
 *   TOKEN     after a good token (credentials replaced, or "Check now" valid) when the last read lost the token: at once,
 *             outside the hourly limit (review A2)
 *
 * With queue workers (ENABLE_QUEUE_WORKERS=1) the read goes on the `meta-ads-sync` queue — one job per account and day
 * (DAILY) or hour (MANUAL, BACKFILL), so a second ask while one is kept adds nothing; without them (or when the queue
 * does not answer) it runs in this process. Either way the business travels with it. A business without a chosen ad
 * account gets no read, and nothing is queued while `NEXUS_META_ADS_SYNC=off`.
 */
import { safeJobId } from '../../../lib/job-id.js'
import { workspaceIdForQuery } from '../../../lib/workspace-context.js'
import { logger } from '../../../utils/logger.js'
import { getMetaAdAccount } from './store.js'
import { syncMetaAdAccountById, type MetaAdsSyncKind } from './sync.service.js'
import { metaAdsSyncSwitchedOff, SWITCHED_OFF_SENTENCE } from './sync-switch.js'
import { listMetaReadTargets } from './targets.js'

export const META_ADS_SYNC_QUEUE = 'meta-ads-sync'
export const MANUAL_INTERVAL_MS = 60 * 60_000
const ENQUEUE_TIMEOUT_MS = 2_500
const MANUAL_KEY = 'nexus:meta-ads:manual'

export interface MetaAdsSyncJobData { adAccountId: string; kind: MetaAdsSyncKind }

const NO_ACCOUNT_SENTENCE = 'Choose a Meta ad account first, in Settings › Channels › Meta.'
const NOT_THIS_ACCOUNT_SENTENCE = 'This business does not read that Meta ad account.'
const hhmm = (at: Date) => `${at.toISOString().slice(11, 16)} UTC`

/** The deterministic job id: per account and UTC day (DAILY), hour (MANUAL, BACKFILL) or minute (TOKEN). */
export function metaAdsSyncJobId(kind: MetaAdsSyncKind, adAccountId: string, now: Date = new Date()): string {
  // TOKEN: per minute (a new token is a person's act; a second save in the same minute adds nothing).
  const stamp = kind === 'DAILY' ? now.toISOString().slice(0, 10) : kind === 'TOKEN' ? now.toISOString().slice(0, 16) : now.toISOString().slice(0, 13)
  return safeJobId('meta-ads', kind.toLowerCase(), adAccountId, stamp)
}

const localManualClaims = new Map<string, number>()

async function claimManual(key: string, now: Date): Promise<boolean> {
  try {
    if (process.env.REDIS_URL?.trim() || process.env.REDIS_HOST?.trim()) {
      const { redis } = await import('../../../lib/queue.js')
      const claim = redis.connection.set(`${MANUAL_KEY}:${key}`, now.toISOString(), 'PX', MANUAL_INTERVAL_MS, 'NX')
      claim.catch(() => {})
      const answer = await Promise.race([claim, new Promise<'timeout'>((resolve) => { setTimeout(() => resolve('timeout'), ENQUEUE_TIMEOUT_MS).unref?.() })])
      if (answer !== 'timeout') return answer === 'OK'
    }
  } catch { /* fall through to this process's own memory */ }
  const last = localManualClaims.get(key)
  if (last !== undefined && now.getTime() - last < MANUAL_INTERVAL_MS) return false
  localManualClaims.set(key, now.getTime())
  return true
}

async function manualRefusal(adAccountId: string, now: Date): Promise<string | null> {
  const account = await getMetaAdAccount(adAccountId)
  const last = account?.lastSyncAt ?? null
  if (last && now.getTime() - last.getTime() < MANUAL_INTERVAL_MS) {
    return `Nexus read this Meta ad account at ${hhmm(last)}. It reads it again on request at most once an hour: ask again after ${hhmm(new Date(last.getTime() + MANUAL_INTERVAL_MS))}.`
  }
  if (!(await claimManual(`${workspaceIdForQuery()}:${adAccountId}`, now))) {
    return 'A read of this Meta ad account was asked for less than an hour ago. Nexus reads it again on request at most once an hour.'
  }
  return null
}

const inlineRunning = new Set<string>()

function runInline(adAccountId: string, kind: MetaAdsSyncKind): void {
  const key = `${workspaceIdForQuery()}:${adAccountId}`
  if (inlineRunning.has(key)) return
  inlineRunning.add(key)
  setImmediate(() => {
    void syncMetaAdAccountById(adAccountId, kind)
      .catch((error) => logger.error('[meta-ads-sync] inline read failed', { kind, error: error instanceof Error ? error.message : String(error) }))
      .finally(() => inlineRunning.delete(key))
  })
}

async function addToQueue(data: MetaAdsSyncJobData, jobId: string): Promise<boolean> {
  if (process.env.ENABLE_QUEUE_WORKERS !== '1') return false
  try {
    const { metaAdsSyncQueue } = await import('../../../lib/queue.js')
    const added = metaAdsSyncQueue.add('sync', data, { jobId })
    added.catch(() => {})
    const answer = await Promise.race([added.then(() => 'ok' as const), new Promise<'timeout'>((resolve) => { setTimeout(() => resolve('timeout'), ENQUEUE_TIMEOUT_MS).unref?.() })])
    if (answer === 'ok') return true
    logger.warn('[meta-ads-sync] the queue did not answer; reading in this process instead', { kind: data.kind })
  } catch (error) {
    logger.warn('[meta-ads-sync] queueing failed; reading in this process instead', { kind: data.kind, error: error instanceof Error ? error.message : String(error) })
  }
  return false
}

/** Ask for a read of this business's ad account (`adAccountId`), or of every one it reads when left out. */
export async function enqueueMetaAdsSync({ adAccountId, kind }: { adAccountId?: string; kind: MetaAdsSyncKind }): Promise<{ queued: boolean; reason: string | null }> {
  if (metaAdsSyncSwitchedOff()) return { queued: false, reason: SWITCHED_OFF_SENTENCE }
  const now = new Date()
  const targets = (await listMetaReadTargets()).filter((target) => !adAccountId || target.adAccountId === adAccountId)
  if (targets.length === 0) return { queued: false, reason: adAccountId ? NOT_THIS_ACCOUNT_SENTENCE : NO_ACCOUNT_SENTENCE }
  let queued = false
  let reason: string | null = null
  for (const target of targets) {
    if (kind === 'MANUAL') {
      const refused = await manualRefusal(target.adAccountId, now)
      if (refused) { reason = reason ?? refused; continue }
    }
    const data: MetaAdsSyncJobData = { adAccountId: target.adAccountId, kind }
    if (!(await addToQueue(data, metaAdsSyncJobId(kind, target.adAccountId, now)))) runInline(target.adAccountId, kind)
    queued = true
  }
  return { queued, reason: queued ? null : reason }
}

/**
 * Review A2 — a good token for this connection (its credentials were replaced and checked, or "Check now" found it
 * valid): a read that ended AUTH_LOST no longer stands. Its status is cleared and a read is queued at once (TOKEN: not
 * held to the hourly limit of "Read now"). Never throws: a person's save is never failed by it.
 */
export async function metaReadAfterGoodToken(connectionId: string): Promise<void> {
  try {
    const { default: prisma } = await import('../../../db.js')
    const { workspaceKey } = await import('../../../lib/workspace-context.js')
    const lost = await prisma.metaAdAccount.findMany({ where: { connectionId, lastSyncStatus: 'AUTH_LOST' }, select: { adAccountId: true } })
    for (const { adAccountId } of lost) {
      await prisma.metaAdAccount.update({ where: { meta_ad_account: workspaceKey({ adAccountId }) }, data: { lastSyncStatus: null, lastSyncError: null } })
      const queued = await enqueueMetaAdsSync({ adAccountId, kind: 'TOKEN' })
      if (!queued.queued) logger.info('[meta-ads-sync] read after a good token not queued', { reason: queued.reason })
    }
  } catch (error) {
    logger.warn('[meta-ads-sync] could not clear a lost-token read', { error: error instanceof Error ? error.message : String(error) })
  }
}
