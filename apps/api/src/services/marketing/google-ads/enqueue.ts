/**
 * Google Ads step 1a — ask for a read of this business's Google Ads account(s) (PLAN.md L9).
 *
 *   BACKFILL  the first read, queued when a person saves the account choice (C3)
 *   DAILY     the 06:25 UTC cron (jobs/ads-google-sync.job.ts)
 *   MANUAL    "Read now" (POST /api/google-ads/sync): at most once an hour per account, refused in words otherwise
 *
 * With queue workers (ENABLE_QUEUE_WORKERS=1) the read goes on the `google-ads-sync` queue — one job per account and
 * day (DAILY) or hour (MANUAL, BACKFILL), so a second ask while one is kept adds nothing; without them (or when the queue
 * does not answer) it runs in this process, as the private stack and tests do. Either way the business travels with
 * it. A business without a chosen Google Ads account gets no read, and nothing is queued while the kill switch
 * `NEXUS_GOOGLE_ADS_SYNC=off` is set.
 */
import { safeJobId } from '../../../lib/job-id.js'
import { workspaceIdForQuery } from '../../../lib/workspace-context.js'
import { logger } from '../../../utils/logger.js'
import { getGoogleAdsCustomer } from './store.js'
import { syncGoogleAdsCustomer, type GoogleAdsSyncKind } from './sync.service.js'
import { googleAdsSyncSwitchedOff, SWITCHED_OFF_SENTENCE } from './sync-switch.js'
import { listReadTargets } from './targets.js'

export const GOOGLE_ADS_SYNC_QUEUE = 'google-ads-sync'
export const MANUAL_INTERVAL_MS = 60 * 60_000
const ENQUEUE_TIMEOUT_MS = 2_500
const MANUAL_KEY = 'nexus:gads:manual'

/** The job's data (the business rides in the envelope WorkspaceQueue adds). */
export interface GoogleAdsSyncJobData { customerId: string; kind: GoogleAdsSyncKind }

const NO_ACCOUNT_SENTENCE = 'Choose a Google Ads account first, in Settings, Channels, Google.'
const NOT_THIS_ACCOUNT_SENTENCE = 'This business does not read that Google Ads account.'

const hhmm = (at: Date) => `${at.toISOString().slice(11, 16)} UTC`

/** The deterministic job id: per account and UTC day (DAILY), per account and UTC hour (MANUAL, BACKFILL). */
export function googleAdsSyncJobId(kind: GoogleAdsSyncKind, customerId: string, now: Date = new Date()): string {
  const stamp = kind === 'DAILY' ? now.toISOString().slice(0, 10) : now.toISOString().slice(0, 13)
  return safeJobId('gads', kind.toLowerCase(), customerId, stamp)
}

// ── "at most once an hour" for MANUAL ────────────────────────────────────────────────────────────────────────────

/** Fallback when Redis cannot be asked (one process only). */
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

/** Why a manual read of this account is refused now, or null when it may run. */
async function manualRefusal(customerId: string, now: Date): Promise<string | null> {
  const account = await getGoogleAdsCustomer(customerId)
  // When the last run that called Google ended (store.ts stamps it only then): a run skipped for want of allowance, or
  // refused before anything was sent, read nothing, so it never says "Nexus read this account at …".
  const last = account?.lastSyncAt ?? null
  if (last && now.getTime() - last.getTime() < MANUAL_INTERVAL_MS) {
    return `Nexus read this Google Ads account at ${hhmm(last)}. It reads it again on request at most once an hour: ask again after ${hhmm(new Date(last.getTime() + MANUAL_INTERVAL_MS))}.`
  }
  if (!(await claimManual(`${workspaceIdForQuery()}:${customerId}`, now))) {
    return 'A read of this Google Ads account was asked for less than an hour ago. Nexus reads it again on request at most once an hour.'
  }
  return null
}

// ── dispatch ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Accounts being read in this process (inline runs), so two inline reads of one account never overlap. */
const inlineRunning = new Set<string>()

function runInline(customerId: string, kind: GoogleAdsSyncKind): void {
  const key = `${workspaceIdForQuery()}:${customerId}`
  if (inlineRunning.has(key)) return
  inlineRunning.add(key)
  // setImmediate keeps the caller's business (AsyncLocalStorage follows the callback).
  setImmediate(() => {
    void syncGoogleAdsCustomer(customerId, kind)
      .catch((error) => logger.error('[google-ads-sync] inline read failed', { customerId, kind, error: error instanceof Error ? error.message : String(error) }))
      .finally(() => inlineRunning.delete(key))
  })
}

/** Put one read on the queue within a bounded wait; false = run it here instead. */
async function addToQueue(data: GoogleAdsSyncJobData, jobId: string): Promise<boolean> {
  if (process.env.ENABLE_QUEUE_WORKERS !== '1') return false
  try {
    const { googleAdsSyncQueue } = await import('../../../lib/queue.js')
    const added = googleAdsSyncQueue.add('sync', data, { jobId })
    added.catch(() => {})
    const answer = await Promise.race([added.then(() => 'ok' as const), new Promise<'timeout'>((resolve) => { setTimeout(() => resolve('timeout'), ENQUEUE_TIMEOUT_MS).unref?.() })])
    if (answer === 'ok') return true
    logger.warn('[google-ads-sync] the queue did not answer; reading in this process instead', { customerId: data.customerId, kind: data.kind })
  } catch (error) {
    logger.warn('[google-ads-sync] queueing failed; reading in this process instead', { customerId: data.customerId, kind: data.kind, error: error instanceof Error ? error.message : String(error) })
  }
  return false
}

/**
 * Ask for a read of this business's Google Ads account (`customerId`), or of every account it reads when left out.
 * `queued` is true when at least one read was queued or started; `reason` says in words why not.
 */
export async function enqueueGoogleAdsSync({ customerId, kind }: { customerId?: string; kind: 'BACKFILL' | 'DAILY' | 'MANUAL' }): Promise<{ queued: boolean; reason: string | null }> {
  if (googleAdsSyncSwitchedOff()) return { queued: false, reason: SWITCHED_OFF_SENTENCE }
  const now = new Date()
  const targets = (await listReadTargets()).filter((target) => !customerId || target.customerId === customerId)
  if (targets.length === 0) return { queued: false, reason: customerId ? NOT_THIS_ACCOUNT_SENTENCE : NO_ACCOUNT_SENTENCE }
  let queued = false
  let reason: string | null = null
  for (const target of targets) {
    if (kind === 'MANUAL') {
      const refused = await manualRefusal(target.customerId, now)
      if (refused) { reason = reason ?? refused; continue }
    }
    const data: GoogleAdsSyncJobData = { customerId: target.customerId, kind }
    if (!(await addToQueue(data, googleAdsSyncJobId(kind, target.customerId, now)))) runInline(target.customerId, kind)
    queued = true
  }
  return { queued, reason: queued ? null : reason }
}
