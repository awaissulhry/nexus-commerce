/**
 * Meta step 37 (2026-10-21; Owner decision D5 = B, cross-lane Q6: the poll is step 37's) — the Instagram comment poll.
 *
 * Instagram sends no comment webhook to an app at Standard access, so Nexus looks for NEW comments itself and tells the
 * business; a person then reads and answers them live (meta-comments, set-meta-comments). Per business with a chosen
 * Instagram account (its INSTAGRAM MetaAccountLink) and a working Meta connection, every 15 minutes (jobs/
 * meta-instagram-comment-poll.job.ts, through lib/cron/clustered.ts):
 *   1. ONE read of the account's newest media: `GET /<ig user>/media?fields=id,timestamp,comments_count,
 *      total_comments_count,permalink&limit=25` (gateway, the business's system-user token, ledger "cron"); the count is
 *      total_comments_count (every surface, boosted copies included), else comments_count;
 *   2. only for a media whose count went up (at most 10 a poll), its comments newest first — `GET
 *      /<media>/comments?fields=id,timestamp&limit=50` (ig-media/comments.md: top-level only, at most 50 a call, newest
 *      first, no time filter), page after page (at most 4) until a comment no newer than the last one seen — to count the
 *      new ones and take the newest time;
 *   3. it stores per media ONLY what finding "new" needs (MetaInstagramCommentPoll: the media id, Meta's comment count, the
 *      newest comment time seen, the poll time) and drops the rows of media no longer among the newest 25 or of another
 *      Instagram account;
 *   4. for each media with new comments it raises ONE notification through Nexus's existing notices (the bell and
 *      alerts-inbox: advertising/ads-automation-notify.service.ts, the business's active members): "N new Instagram
 *      comments on a post of <account>", with the media id and the post's link — never a comment's words or a person's
 *      name, username or id (none is even read: the comment read asks id and timestamp only).
 * "New" is Meta's own comment count going up (replies included, deletions taken off) or the top-level comments newer than
 * the last one seen, whichever is more. The first poll of an account only records where it stands (no notice), and a media
 * the poll sees for the first time after that counts from the last poll. A refused or failed read writes nothing and
 * raises no notice: the next poll compares with the last good one. So does an answer with no list, or media with no count
 * (review fix B2); a list with no media writes nothing either, and old rows are never dropped by an empty list (A1).
 *
 * Brakes: NEXUS_META_IG_COMMENT_POLL=off (0 / false / no / disabled) — no poll is scheduled or run; NEXUS_META_ADS_SYNC=off
 * (Meta's read switch) stops it too. Meta's rate limits and the gateway's holds apply as to every read.
 */
import prisma from '../../../db.js'
import { logger } from '../../../utils/logger.js'
import { workspaceKey } from '../../../lib/workspace-context.js'
import { metaReadOne } from './read-client.js'
import { MetaReadError } from './errors.js'
import { metaAdsSyncSwitchedOff } from './sync-switch.js'
import { fieldRefused } from './live-objects.js'

/** Every 15 minutes, off the busy minutes (the clustered cron takes one per-minute lock per job and business). */
export const IG_COMMENT_POLL_SCHEDULE = '7,22,37,52 * * * *'
export const IG_COMMENT_POLL_JOB = 'meta-instagram-comment-poll'
/** The newest media the poll reads (one call). */
export const IG_POLL_MEDIA = 25
/** At most this many media get their comments read in one poll (the rest are counted by Meta's count alone). */
export const IG_POLL_COMMENT_READS = 10
/** At most this many pages of 50 comments per media. */
export const IG_POLL_COMMENT_PAGES = 4
export const IG_COMMENTS_NOTICE = 'meta-instagram-comments'
export const IG_COMMENTS_HREF = '/marketing/ads/meta'
/**
 * The media read's fields. Review fix B2 — `total_comments_count` ("across all surfaces, including comments on associated
 * promoted/boosted media"; Facebook Login only — instagram-media.md, as live-partners.ts reads it), else `comments_count`
 * per media; without the field when Meta refuses it.
 */
export const IG_POLL_MEDIA_FIELDS = 'id,timestamp,comments_count,total_comments_count,permalink'
export const IG_POLL_MEDIA_FIELDS_PLAIN = 'id,timestamp,comments_count,permalink'
/** The comments read's fields: ids and times only (never a person's words or name). */
export const IG_POLL_COMMENT_FIELDS = 'id,timestamp'

/** True when NEXUS_META_IG_COMMENT_POLL says off, or Meta's reads are switched off (NEXUS_META_ADS_SYNC). */
export function igCommentPollSwitchedOff(): boolean {
  const value = process.env.NEXUS_META_IG_COMMENT_POLL?.trim().toLowerCase()
  return value === 'off' || value === '0' || value === 'false' || value === 'no' || value === 'disabled' || metaAdsSyncSwitchedOff()
}

export interface IgPollTarget { connectionId: string; instagramId: string; label: string }

/** The current business's chosen Instagram account, through an active Meta connection that needs no new sign-in; else null. */
export async function igCommentPollTarget(): Promise<IgPollTarget | null> {
  const link = await prisma.metaAccountLink.findFirst({
    where: { product: 'INSTAGRAM', connection: { channelType: 'META', isActive: true, authStatus: { notIn: ['needs_reauth', 'revoked', 'disconnected'] } } },
    select: { connectionId: true, externalId: true, label: true },
  })
  if (!link || !/^\d{1,25}$/.test(link.externalId)) return null
  return { connectionId: link.connectionId, instagramId: link.externalId, label: link.label }
}

type Row = Record<string, unknown>
const obj = (v: unknown): Row | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Row : null)
const idText = (v: unknown): string | null => ((typeof v === 'string' || typeof v === 'number') && /^\d{1,25}$/.test(String(v)) ? String(v) : null)
/** Meta's ISO time (`2026-10-21T09:15:02+0000`), or null. */
export function metaTime(v: unknown): Date | null {
  if (typeof v !== 'string') return null
  const ms = Date.parse(v.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'))
  return Number.isFinite(ms) ? new Date(ms) : null
}
const later = (a: Date | null, b: Date | null) => (!a ? b : !b ? a : a.getTime() >= b.getTime() ? a : b)
const countOf = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null)
const permalinkOf = (v: unknown): string | null => (typeof v === 'string' && /^https:\/\/(www\.)?instagram\.com\/[\x21-\x7e]{1,300}$/.test(v) ? v : null)

export interface IgPollMediaPlan { mediaId: string; commentsCount: number; newestCommentAt: Date | null; newComments: number; since: Date | null; permalink: string | null }

export interface IgPollResult {
  status: 'off' | 'none' | 'failed' | 'done'
  /** One line for the cron's run record (no person's data). */
  line: string
  media: number
  newComments: number
  notified: number
  calls: number
}

export interface IgPollDeps {
  now?: () => Date
  /** The existing notice (advertising/ads-automation-notify.service.ts notifyAutomationDetailed); tests stand it in. */
  notify?: (notice: { type: string; severity: 'info'; title: string; body: string; href: string; meta: Record<string, unknown> }) => Promise<{ created: number }>
}

/** The top-level comments of one media newer than `since` (newest first): how many, and the newest time. Ids and times only. */
async function newTopLevel(target: IgPollTarget, mediaId: string, since: Date | null): Promise<{ count: number; newest: Date | null; calls: number }> {
  let after: string | null = null
  let count = 0
  let newest: Date | null = null
  let calls = 0
  for (let page = 0; page < IG_POLL_COMMENT_PAGES; page++) {
    const read: { body: { data?: unknown[]; paging?: { cursors?: { after?: unknown }; next?: unknown } } } = await metaReadOne<{ data?: unknown[]; paging?: { cursors?: { after?: unknown }; next?: unknown } }>({ connectionId: target.connectionId }, {
      operation: 'instagram.commentPollComments', path: `${mediaId}/comments`, query: { fields: IG_POLL_COMMENT_FIELDS, limit: 50, ...(after ? { after } : {}) }, triggeredBy: 'cron',
    })
    calls++
    let older = false
    for (const row of (Array.isArray(read.body.data) ? read.body.data : []).map(obj)) {
      const at = metaTime(row?.timestamp)
      if (!at) continue
      if (since && at.getTime() <= since.getTime()) { older = true; break }
      count++
      newest = later(newest, at)
    }
    const next = typeof read.body.paging?.cursors?.after === 'string' && read.body.paging?.next ? read.body.paging.cursors.after : null
    if (older || !next) break
    after = next
  }
  return { count, newest, calls }
}

/**
 * One poll of the current business (the cron runs it once per business, inside it). Never throws for a Meta answer: a
 * refused or failed read is `failed`, with nothing written and no notice.
 */
export async function pollInstagramComments(deps: IgPollDeps = {}): Promise<IgPollResult> {
  const result = (status: IgPollResult['status'], line: string, more: Partial<IgPollResult> = {}): IgPollResult => ({ status, line, media: 0, newComments: 0, notified: 0, calls: 0, ...more })
  if (igCommentPollSwitchedOff()) return result('off', 'off (NEXUS_META_IG_COMMENT_POLL=off or NEXUS_META_ADS_SYNC=off)')
  const target = await igCommentPollTarget()
  if (!target) return result('none', 'no Instagram account chosen through a working Meta connection')
  const startedAt = (deps.now ?? (() => new Date()))()
  let calls = 0
  let plans: IgPollMediaPlan[]
  let listed: string[]
  try {
    const mediaRead = (fields: string) => metaReadOne<{ data?: unknown }>({ connectionId: target.connectionId }, {
      operation: 'instagram.commentPollMedia', path: `${target.instagramId}/media`, query: { fields, limit: IG_POLL_MEDIA }, triggeredBy: 'cron',
    })
    let read: { body: { data?: unknown } }
    try {
      read = await mediaRead(IG_POLL_MEDIA_FIELDS)
      calls++
    } catch (err) {
      // Review fix B2 — total_comments_count is the Facebook-Login flavour's own: when Meta refuses the field, once without it.
      if (!fieldRefused(err)) throw err
      calls += err.callsSpent
      read = await mediaRead(IG_POLL_MEDIA_FIELDS_PLAIN)
      calls++
    }
    // Review fix B2 / A1 — an answer with no list is not an answer: nothing is written, nobody is told.
    if (!Array.isArray(read.body.data)) return result('failed', 'not read, nothing written: Meta answered no list of media', { calls })
    const rows = read.body.data.map(obj).filter((r): r is Row => !!r).slice(0, IG_POLL_MEDIA)
    listed = rows.map((r) => idText(r.id)).filter((id): id is string => !!id)
    // No media at all: nothing to compare, nothing written — the rows and their poll time stay (the next poll is no "first").
    if (!listed.length) return result('done', 'the Instagram account shows no media: nothing written', { calls })
    // The count of every surface (boosted and promoted copies included), else the media's own (instagram-media.md).
    const media = rows
      .map((r) => ({ mediaId: idText(r.id), at: metaTime(r.timestamp), count: countOf(r.total_comments_count) ?? countOf(r.comments_count), permalink: permalinkOf(r.permalink) }))
      .filter((m): m is { mediaId: string; at: Date | null; count: number; permalink: string | null } => !!m.mediaId && m.count !== null)
    if (!media.length) return result('failed', 'not read, nothing written: Meta answered the media without their comment counts', { calls })
    const stored = await prisma.metaInstagramCommentPoll.findMany({ where: { instagramId: target.instagramId }, select: { mediaId: true, commentsCount: true, newestCommentAt: true, polledAt: true } })
    const byMedia = new Map(stored.map((s) => [s.mediaId, s]))
    const lastPollAt = stored.reduce<Date | null>((at, s) => later(at, s.polledAt), null)
    plans = []
    let reads = 0
    for (const m of media) {
      const row = byMedia.get(m.mediaId)
      // Not seen before: the first poll of the account only records; a media posted since the last poll counts from it.
      const fresh = !row && !!lastPollAt && !!m.at && m.at.getTime() > lastPollAt.getTime()
      const before = row ? row.commentsCount : fresh ? 0 : m.count
      const since = row ? row.newestCommentAt ?? row.polledAt : fresh ? lastPollAt : null
      const delta = m.count - before
      if (delta <= 0) {
        plans.push({ mediaId: m.mediaId, commentsCount: m.count, newestCommentAt: row?.newestCommentAt ?? null, newComments: 0, since, permalink: m.permalink })
        continue
      }
      let top = { count: 0, newest: null as Date | null, calls: 0 }
      if (reads < IG_POLL_COMMENT_READS) {
        reads++
        top = await newTopLevel(target, m.mediaId, since)
        calls += top.calls
      }
      plans.push({ mediaId: m.mediaId, commentsCount: m.count, newestCommentAt: later(row?.newestCommentAt ?? null, top.newest), newComments: Math.max(delta, top.count), since, permalink: m.permalink })
    }
  } catch (err) {
    if (err instanceof MetaReadError) return result('failed', `not read, nothing written: ${err.failure.sentence}`, { calls: calls + err.callsSpent })
    throw err
  }

  // Every read went well: what the poll found is written in one go, and only then the business is told. A media Meta listed
  // without a count keeps its row as it was; rows of media no longer listed (or of another account) go — never with an
  // empty list (review fix A1: a poll that listed nothing returned above).
  const kept = listed
  if (!kept.length) return result('failed', 'nothing written: no media to keep', { calls })
  await prisma.$transaction(async (tx) => {
    for (const p of plans) {
      const data = { connectionId: target.connectionId, commentsCount: p.commentsCount, newestCommentAt: p.newestCommentAt, polledAt: startedAt }
      await tx.metaInstagramCommentPoll.upsert({
        where: { meta_ig_comment_poll: workspaceKey({ instagramId: target.instagramId, mediaId: p.mediaId }) },
        create: { instagramId: target.instagramId, mediaId: p.mediaId, ...data },
        update: data,
      })
    }
    await tx.metaInstagramCommentPoll.deleteMany({ where: { OR: [{ instagramId: { not: target.instagramId } }, { instagramId: target.instagramId, mediaId: { notIn: kept } }] } })
  })
  const notify = deps.notify ?? (async (notice) => (await import('../../advertising/ads-automation-notify.service.js')).notifyAutomationDetailed(notice))
  let notified = 0
  const fresh = plans.filter((p) => p.newComments > 0)
  for (const p of fresh) {
    const n = p.newComments
    const words = `${n} new Instagram comment${n === 1 ? '' : 's'}`
    try {
      const sent = await notify({
        type: IG_COMMENTS_NOTICE,
        severity: 'info',
        title: `${words} on a post of ${target.label}`,
        body: `Instagram media ${p.mediaId}${p.permalink ? ` (${p.permalink})` : ''}: ${n === 1 ? 'a new comment or reply' : `at least ${n} new comments or replies`}${p.since ? ` since ${p.since.toISOString().slice(0, 16).replace('T', ' ')} UTC` : ''}. Read and answer them in Nexus (meta-comments view instagram with mediaId ${p.mediaId}; replies, hiding and deleting: set-meta-comments). Nexus keeps no comment's words or author.`,
        href: IG_COMMENTS_HREF,
        meta: { instagramId: target.instagramId, mediaId: p.mediaId, newComments: n, ...(p.permalink ? { permalink: p.permalink } : {}) },
      })
      notified += sent.created > 0 ? 1 : 0
    } catch (err) {
      // A notice that cannot be written is logged; the poll's rows stand (the next poll does not repeat it).
      logger.warn('[meta-instagram-comment-poll] notice not written', { mediaId: p.mediaId, error: err instanceof Error ? err.message : String(err) })
    }
  }
  const total = fresh.reduce((sum, p) => sum + p.newComments, 0)
  const first = plans.length > 0 && !fresh.length && plans.every((p) => p.since === null)
  return result('done', `${plans.length} Instagram media read${first ? ' (first poll: where they stand is recorded, nothing is new yet)' : ''}; ${total} new comment${total === 1 ? '' : 's'} on ${fresh.length} of them; ${notified} notice${notified === 1 ? '' : 's'}`, { media: plans.length, newComments: total, notified, calls })
}
