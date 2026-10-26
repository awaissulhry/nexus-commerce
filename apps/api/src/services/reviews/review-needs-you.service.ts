/**
 * Reviews Overview — "Needs you": GET /api/reviews/area/needs-you?only=reply|requests|alerts&limit=8
 * (routes/reviews-area.routes.ts). The most urgent things across reviews that wait for a reply, open review alerts and
 * review requests that failed, each with ONE action. The action names a page kind (`inbox`, `review`, `requests`,
 * `alerts`) and its filters, never a URL: the web turns it into a link through its one link module (reviewsLinks.ts),
 * so a page that moves needs no API change.
 *
 * Fixture rows never count (review-visibility.ts). The order rule (`rankNeedsYou`) is pure and tested.
 */
import type { Prisma } from '@prisma/client'
import prisma from '../../db.js'
import { needsReplyWhere, reviewKindOf } from './review-visibility.js'
import { buyerShort, channelMarketLabel, channelWords, daysBetween, marketWords, quoteOf, round, themeWords } from './overviewMath.js'

export type NeedsYouOnly = 'reply' | 'requests' | 'alerts'
export type NeedsYouKind = 'review' | 'alert' | 'request'

export interface NeedsYouItem {
  kind: NeedsYouKind
  id: string
  /** The pill's words ("Reply needed") and its tone. */
  label: string
  tone: 'danger' | 'warning'
  title: string
  detail: string
  /** When it started waiting (ISO). */
  at: string
  action: { label: string; page: 'inbox' | 'review' | 'requests' | 'alerts'; params: Record<string, string | number> }
}

export interface NeedsYou {
  items: NeedsYouItem[]
  /** How many things there are of the kinds asked for (the footer's "Showing 5 of 8"). */
  total: number
  counts: { reply: number; requests: number; alerts: number }
}

export function parseOnly(raw: unknown): NeedsYouOnly | null {
  return raw === 'reply' || raw === 'requests' || raw === 'alerts' ? raw : null
}

export function parseLimit(raw: unknown, fallback = 8): number {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? Math.min(n, 50) : fallback
}

/** Most urgent first: a danger before a warning, then the one that started waiting most recently. Pure. */
export function rankNeedsYou<T extends Pick<NeedsYouItem, 'tone' | 'at' | 'id'>>(items: readonly T[]): T[] {
  const weight = (t: T) => (t.tone === 'danger' ? 0 : 1)
  return [...items].sort((a, b) => weight(a) - weight(b) || b.at.localeCompare(a.at) || a.id.localeCompare(b.id))
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en')} ${n === 1 ? one : many}`
}

/** "3 days", "5 h", "today". */
export function waitWords(since: Date, now: Date): string {
  const days = daysBetween(since, now)
  if (days >= 1) return plural(days, 'day')
  const hours = Math.floor((now.getTime() - since.getTime()) / 3_600_000)
  return hours >= 1 ? `${hours} h` : 'less than an hour'
}

type ReplyRow = {
  id: string
  channel: string
  marketplace: string | null
  rating: number | null
  body: string
  authorName: string | null
  postedAt: Date
  product: { name: string | null; sku: string | null } | null
  sentiment: { label: string } | null
}

/** One review that waits for a reply, in words. */
export function replyItem(r: ReplyRow, now: Date): NeedsYouItem {
  const seller = reviewKindOf(r.channel) === 'seller'
  const negative = (r.rating != null && r.rating <= 2) || r.sentiment?.label === 'NEGATIVE'
  const wait = waitWords(r.postedAt, now)
  const what = seller
    ? `${r.rating == null ? '' : r.rating >= 4 ? 'Positive ' : r.rating <= 2 ? 'Negative ' : 'Neutral '}feedback`.trim()
    : r.rating != null ? `${r.rating}-star review` : 'Review'
  const title = `${what.charAt(0).toUpperCase()}${what.slice(1)}, no reply for ${wait}`
  const detail = [
    r.product?.name ?? r.product?.sku ?? null,
    channelMarketLabel(r.channel, r.marketplace),
    buyerShort(r.authorName),
    quoteOf(r.body),
  ].filter(Boolean).join(' · ')
  return {
    kind: 'review',
    id: r.id,
    label: 'Reply needed',
    tone: negative ? 'danger' : 'warning',
    title,
    detail,
    at: r.postedAt.toISOString(),
    action: { label: 'Reply', page: 'review', params: { id: r.id, channel: r.channel.toUpperCase(), ...(r.marketplace ? { market: r.marketplace.toUpperCase() } : {}) } },
  }
}

type SpikeRow = {
  id: string
  marketplace: string
  category: string
  rate7dNumerator: number
  rate7dDenominator: number
  rate28dNumerator: number
  rate28dDenominator: number
  spikeMultiplier: Prisma.Decimal | number | null
  detectedAt: Date
  product: { name: string | null; sku: string | null } | null
}

/** One open review alert, in words: "Fit & sizing complaints up 2.6×". */
export function alertItem(s: SpikeRow): NeedsYouItem {
  const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : null)
  const now7 = pct(s.rate7dNumerator, s.rate7dDenominator)
  const was = pct(s.rate28dNumerator, s.rate28dDenominator)
  const times = s.spikeMultiplier == null ? null : round(Number(s.spikeMultiplier), 1)
  return {
    kind: 'alert',
    id: s.id,
    label: 'Alert',
    tone: 'warning',
    title: `${themeWords(s.category)} complaints ${times != null && times > 0 ? `up ${times}×` : 'up'}`,
    detail: [
      s.product?.name ?? s.product?.sku ?? null,
      marketWords(s.marketplace),
      now7 != null ? `${now7}% of reviews in the last 7 days${was != null ? `, was ${was}%` : ''}` : null,
    ].filter(Boolean).join(' · '),
    at: s.detectedAt.toISOString(),
    action: { label: 'See alert', page: 'alerts', params: { market: s.marketplace.toUpperCase() } },
  }
}

/** Failed and retrying review requests, as at most two items. */
export function requestItems(
  failed: ReadonlyArray<{ channel: string; count: number; latest: Date | null }>,
  retrying: { count: number; latest: Date | null },
  now: Date,
): NeedsYouItem[] {
  const items: NeedsYouItem[] = []
  const total = failed.reduce((n, f) => n + f.count, 0)
  if (total > 0) {
    const latest = failed.reduce<Date | null>((best, f) => (f.latest && (!best || f.latest > best) ? f.latest : best), null) ?? now
    const byChannel = failed.filter(f => f.count > 0).sort((a, b) => b.count - a.count).map(f => `${channelWords(f.channel)} ${f.count.toLocaleString('en')}`)
    items.push({
      kind: 'request',
      id: 'requests-failed',
      label: 'Requests failed',
      tone: 'danger',
      title: `${plural(total, 'review request')} failed in the last 7 days`,
      detail: `${byChannel.join(' · ')}${retrying.count > 0 ? ' · the ones with tries left try again on their own' : ''}`,
      at: latest.toISOString(),
      action: { label: 'See requests', page: 'requests', params: { status: 'FAILED' } },
    })
  }
  if (retrying.count > 0) {
    items.push({
      kind: 'request',
      id: 'requests-retrying',
      label: 'Retrying',
      tone: 'warning',
      title: `${plural(retrying.count, 'request')} waiting to try again`,
      detail: 'Nexus asks again on its own; nothing to do unless they keep failing',
      at: (retrying.latest ?? now).toISOString(),
      action: { label: 'See requests', page: 'requests', params: { status: 'RETRYING' } },
    })
  }
  return items
}

const REPLY_SELECT = {
  id: true, channel: true, marketplace: true, rating: true, body: true, authorName: true, postedAt: true,
  product: { select: { name: true, sku: true } },
  sentiment: { select: { label: true } },
} satisfies Prisma.ReviewSelect

/** The things that need a person now, most urgent first. */
export async function reviewNeedsYou(input: { only?: unknown; limit?: unknown; now?: Date } = {}): Promise<NeedsYou> {
  const now = input.now ?? new Date()
  const only = parseOnly(input.only)
  const limit = parseLimit(input.limit)
  const want = (kind: NeedsYouOnly) => only == null || only === kind
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000)
  const urgent: Prisma.ReviewWhereInput = { OR: [{ rating: { lte: 2 } }, { sentiment: { is: { label: 'NEGATIVE' } } }] }

  const [replyCount, urgentReplies, otherReplies, alertCount, spikes, failedGroups, retrying] = await Promise.all([
    prisma.review.count({ where: needsReplyWhere() }),
    want('reply') ? prisma.review.findMany({ where: { AND: [needsReplyWhere(), urgent] }, orderBy: { postedAt: 'desc' }, take: limit, select: REPLY_SELECT }) : Promise.resolve([]),
    want('reply') ? prisma.review.findMany({ where: { AND: [needsReplyWhere(), { NOT: urgent }] }, orderBy: { postedAt: 'desc' }, take: limit, select: REPLY_SELECT }) : Promise.resolve([]),
    prisma.reviewSpike.count({ where: { status: 'OPEN' } }),
    want('alerts') ? prisma.reviewSpike.findMany({
      where: { status: 'OPEN' },
      orderBy: { detectedAt: 'desc' },
      take: limit,
      select: {
        id: true, marketplace: true, category: true, rate7dNumerator: true, rate7dDenominator: true, rate28dNumerator: true,
        rate28dDenominator: true, spikeMultiplier: true, detectedAt: true, product: { select: { name: true, sku: true } },
      },
    }) : Promise.resolve([]),
    prisma.reviewRequest.groupBy({ by: ['channel'], where: { status: 'FAILED', updatedAt: { gte: weekAgo } }, _count: { _all: true }, _max: { updatedAt: true } }),
    prisma.reviewRequest.aggregate({ where: { status: 'FAILED', nextRetryAt: { not: null }, attemptCount: { lt: 3 } }, _count: { _all: true }, _max: { updatedAt: true } }),
  ])

  const requests = requestItems(
    failedGroups.map(g => ({ channel: g.channel, count: g._count._all, latest: g._max.updatedAt ?? null })),
    { count: retrying._count._all, latest: retrying._max.updatedAt ?? null },
    now,
  )
  const counts = { reply: replyCount, requests: requests.length, alerts: alertCount }

  // Negative reviews first, then the rest: each list is newest first, so a new one-star review leads.
  const replies = [...urgentReplies, ...otherReplies].slice(0, limit).map(r => replyItem(r, now))
  const alerts = spikes.map(alertItem)
  const pool = [...(want('reply') ? replies : []), ...(want('alerts') ? alerts : []), ...(want('requests') ? requests : [])]
  // A single kind keeps its own order (replies: negative first); a mix is ranked by urgency.
  const items = (only ? pool : rankNeedsYou(pool)).slice(0, limit)
  const total = only === 'reply' ? counts.reply : only === 'alerts' ? counts.alerts : only === 'requests' ? counts.requests : counts.reply + counts.alerts + counts.requests
  return { items, total, counts }
}
