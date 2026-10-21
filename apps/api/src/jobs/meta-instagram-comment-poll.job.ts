/**
 * Meta ads step 37 — the Instagram comment poll (services/marketing/meta-ads/instagram-comment-poll.ts): every 15 minutes
 * (7, 22, 37, 52 past the hour, UTC), per business with a chosen Instagram account and a working Meta connection, Nexus
 * reads the account's newest media and tells the business of new comments. Cluster-safe through lib/cron/clustered.ts
 * (hard rule 7): with business profiles on it runs once per business, inside that business. A business without a chosen
 * Instagram account makes no call and records nothing.
 *
 * NEXUS_META_IG_COMMENT_POLL=off (or NEXUS_META_ADS_SYNC=off) schedules nothing and runs nothing. Read-only towards Meta:
 * the poll sends nothing but GET, and the gateway refuses anything else. It stores no comment's words or author.
 */
import cron from '../lib/cron/clustered.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { logger } from '../utils/logger.js'
import { workspaceIdForQuery } from '../lib/workspace-context.js'
import { IG_COMMENT_POLL_JOB, IG_COMMENT_POLL_SCHEDULE, igCommentPollSwitchedOff } from '../services/marketing/meta-ads/instagram-comment-poll.js'

/** The tick's work in the current business (also the cron registry's "Run now"). */
export async function runMetaInstagramCommentPollOnce(): Promise<string> {
  if (igCommentPollSwitchedOff()) return 'off (NEXUS_META_IG_COMMENT_POLL=off or NEXUS_META_ADS_SYNC=off)'
  const { pollInstagramComments } = await import('../services/marketing/meta-ads/instagram-comment-poll.js')
  return (await pollInstagramComments()).line
}

const running = new Set<string>()

/** One tick: nothing (no call, no run record) for a business without a chosen Instagram account. */
export async function runMetaInstagramCommentPollTick(): Promise<string | null> {
  if (igCommentPollSwitchedOff()) return null
  const key = workspaceIdForQuery()
  if (running.has(key)) return null
  running.add(key)
  try {
    const { igCommentPollTarget } = await import('../services/marketing/meta-ads/instagram-comment-poll.js')
    if (!(await igCommentPollTarget())) return null
    return await recordCronRun(IG_COMMENT_POLL_JOB, () => runMetaInstagramCommentPollOnce())
  } catch (error) {
    logger.error('[meta-instagram-comment-poll] poll failed', { error: error instanceof Error ? error.message : String(error) })
    return null
  } finally {
    running.delete(key)
  }
}

let task: ReturnType<typeof cron.schedule> | null = null

export function startMetaInstagramCommentPollCron(): void {
  if (task) return
  if (igCommentPollSwitchedOff()) {
    logger.info('[meta-instagram-comment-poll] not scheduled (NEXUS_META_IG_COMMENT_POLL=off or NEXUS_META_ADS_SYNC=off)')
    return
  }
  task = cron.schedule(IG_COMMENT_POLL_SCHEDULE, async () => { await runMetaInstagramCommentPollTick() }, { timezone: 'Etc/UTC', lockTtlMs: 10 * 60_000 })
  logger.info(`[meta-instagram-comment-poll] scheduled (${IG_COMMENT_POLL_SCHEDULE} UTC, per business with a chosen Instagram account; read-only)`)
}
