/**
 * Reviews › eBay page (2026-10-27, B19 / PR G) — the two sections eBay's REST Feedback API makes real:
 *
 *   topics      eBay's AI topics of the feedback in the page's scope and period (Review.channelTopics), counted per topic
 *               with how many mention it positively / negatively.
 *   revisions   revision requests: the feedback whose eBay state is a revision (waiting for the buyer, revised, said no
 *               or expired) and the neutral or negative feedback eBay says can still be asked (eligibleForRevision),
 *               with eBay's rules in words. eBay has no API to ask for a revision: the page opens eBay Seller Hub.
 *
 * Both read only the feedback Nexus stored (every Review read through `visibleReviewWhere`); the arithmetic is pure and
 * tested (ebay-feedback-extras.vitest.test.ts).
 */
import { Prisma } from '@prisma/client'
import { EBAY_REVISION_NO_API, EBAY_REVISION_RULE, EBAY_REVISION_TIP, revisionWords, type RevisionTone } from '@nexus/shared/review-reply-rules'
import prisma from '../../db.js'
import { visibleReviewWhere } from './review-visibility.js'
import { EBAY_TOPIC_WORDS } from './adapters/ebay-topics.js'
import type { PeriodBounds } from './overviewMath.js'

const DAY_MS = 24 * 60 * 60 * 1000
const REVISION_STATES = ['REVISION_OPEN', 'REVISED', 'REVISION_DECLINED_OR_EXPIRED'] as const
/** eBay: revision requests may be asked only for feedback under 30 days old. */
const REVISION_DAYS = 30

// ── Topics ───────────────────────────────────────────────────────────

export interface EbayTopicCount {
  topic: string
  label: string
  count: number
  positive: number
  negative: number
  neutral: number
}

export interface EbayTopics {
  topics: EbayTopicCount[]
  /** Feedback in scope that eBay's topics were read for. */
  read: number
  /** Why there is nothing to show, in words, or null. */
  words: string | null
}

/** Counts eBay's topics over stored rows (pure). Unknown JSON is skipped, never guessed. */
export function countEbayTopics(rows: ReadonlyArray<{ channelTopics: unknown }>): EbayTopics {
  const counts = new Map<string, EbayTopicCount>()
  let read = 0
  for (const row of rows) {
    if (!Array.isArray(row.channelTopics)) continue
    read += 1
    const seen = new Set<string>()
    for (const t of row.channelTopics) {
      const topic = typeof (t as { topic?: unknown })?.topic === 'string' ? String((t as { topic: string }).topic).trim().toLowerCase() : ''
      if (!topic || seen.has(topic)) continue
      seen.add(topic)
      const c = counts.get(topic) ?? { topic, label: EBAY_TOPIC_WORDS[topic] ?? topic.charAt(0).toUpperCase() + topic.slice(1), count: 0, positive: 0, negative: 0, neutral: 0 }
      c.count += 1
      const sentiment = String((t as { sentiment?: unknown }).sentiment ?? '').toUpperCase()
      if (sentiment === 'POSITIVE') c.positive += 1
      else if (sentiment === 'NEGATIVE') c.negative += 1
      else if (sentiment === 'NEUTRAL') c.neutral += 1
      counts.set(topic, c)
    }
  }
  const topics = [...counts.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
  const words = read === 0
    ? 'eBay’s topics come with eBay’s newer feedback read, which has not read this feedback yet. Nexus reads the topics of the last 30 days every 6 hours.'
    : topics.length === 0 ? 'eBay found no topics in this feedback.' : null
  return { topics, read, words }
}

export async function ebayTopicsSection(scope: Prisma.ReviewWhereInput, bounds: PeriodBounds): Promise<EbayTopics> {
  const rows = await prisma.review.findMany({
    where: visibleReviewWhere({ ...scope, postedAt: { ...(bounds.from ? { gte: bounds.from } : {}), lte: bounds.to }, channelTopics: { not: Prisma.AnyNull } }),
    select: { channelTopics: true },
    take: 20_000,
  })
  return countEbayTopics(rows)
}

// ── Revision requests ────────────────────────────────────────────────

export interface RevisionRow {
  id: string
  buyer: string | null
  market: string | null
  type: 'negative' | 'neutral' | 'positive' | null
  postedAt: string
  state: string | null
  words: string
  tone: RevisionTone
  /** When Nexus first read this state (eBay gives no date for it). */
  stateSince: string | null
  /** Eligible feedback: days left to ask (eBay: under 30 days old). */
  daysLeft: number | null
  canAsk: boolean
}

export interface EbayRevisions {
  rows: RevisionRow[]
  counts: { waiting: number; revised: number; declined: number; canAsk: number }
  /** eBay's allowance for the calendar year, from the feedback Nexus holds for the whole account. */
  allowance: { year: number; received: number; allowed: number; seen: number; words: string }
  rule: string
  tip: string
  noApi: string
  /** Whether eBay's REST read ran for any feedback in scope (else the states are unknown), and why not in words. */
  read: boolean
  words: string | null
}

function typeOf(rating: number | null): RevisionRow['type'] {
  if (rating == null) return null
  return rating >= 4 ? 'positive' : rating === 3 ? 'neutral' : 'negative'
}

/** The revision rows and counts (pure). */
export function revisionRows(
  rows: ReadonlyArray<{ id: string; authorName: string | null; marketplace: string | null; rating: number | null; postedAt: Date; feedbackState: string | null; revisionEligible: boolean | null; feedbackStateAt: Date | null }>,
  now: Date,
): Pick<EbayRevisions, 'rows' | 'counts'> {
  const out: RevisionRow[] = []
  const counts = { waiting: 0, revised: 0, declined: 0, canAsk: 0 }
  for (const r of rows) {
    const inRevision = (REVISION_STATES as readonly string[]).includes(r.feedbackState ?? '')
    const age = (now.getTime() - r.postedAt.getTime()) / DAY_MS
    const canAsk = !inRevision && r.revisionEligible === true && (r.rating ?? 5) <= 3 && age < REVISION_DAYS
    if (!inRevision && !canAsk) continue
    const said = revisionWords(r.feedbackState, canAsk)
    if (!said) continue
    if (r.feedbackState === 'REVISION_OPEN') counts.waiting += 1
    else if (r.feedbackState === 'REVISED') counts.revised += 1
    else if (r.feedbackState === 'REVISION_DECLINED_OR_EXPIRED') counts.declined += 1
    else counts.canAsk += 1
    out.push({
      id: r.id,
      buyer: r.authorName,
      market: r.marketplace,
      type: typeOf(r.rating),
      postedAt: r.postedAt.toISOString(),
      state: r.feedbackState,
      words: said.words,
      tone: said.tone,
      stateSince: inRevision ? r.feedbackStateAt?.toISOString() ?? null : null,
      daysLeft: canAsk ? Math.max(0, Math.ceil(REVISION_DAYS - age)) : null,
      canAsk,
    })
  }
  // What a person acts on first: the ones that can still be asked (fewest days left), then those waiting, then the rest.
  const rank = (r: RevisionRow) => (r.canAsk ? 0 : r.state === 'REVISION_OPEN' ? 1 : 2)
  out.sort((a, b) => rank(a) - rank(b) || (a.canAsk ? (a.daysLeft ?? 0) - (b.daysLeft ?? 0) : b.postedAt.localeCompare(a.postedAt)))
  return { rows: out, counts }
}

/** eBay's yearly allowance: 5, plus 5 for every 1,000 feedback received that calendar year (pure). */
export function revisionAllowance(year: number, received: number, seen: number): EbayRevisions['allowance'] {
  const allowed = 5 + 5 * Math.floor(received / 1000)
  const words = `${year}: about ${allowed} requests allowed (Nexus counts ${received.toLocaleString('en')} feedback received this year). Nexus saw ${seen} revision ${seen === 1 ? 'request' : 'requests'} this year; eBay counts every request, including ones Nexus did not see.`
  return { year, received, allowed, seen, words }
}

export async function ebayRevisionsSection(scope: Prisma.ReviewWhereInput, now: Date): Promise<EbayRevisions> {
  const year = now.getUTCFullYear()
  const yearStart = new Date(Date.UTC(year, 0, 1))
  const [rows, received, seen, restRead] = await Promise.all([
    prisma.review.findMany({
      where: visibleReviewWhere({
        AND: [scope, {
          OR: [
            { feedbackState: { in: [...REVISION_STATES] } },
            { revisionEligible: true, rating: { lte: 3 }, postedAt: { gte: new Date(now.getTime() - REVISION_DAYS * DAY_MS) } },
          ],
        }],
      }),
      orderBy: { postedAt: 'desc' },
      take: 200,
      select: { id: true, authorName: true, marketplace: true, rating: true, postedAt: true, feedbackState: true, revisionEligible: true, feedbackStateAt: true },
    }),
    // The allowance is the eBay ACCOUNT's: counted over every eBay market.
    prisma.review.count({ where: visibleReviewWhere({ channel: 'EBAY', postedAt: { gte: yearStart } }) }),
    prisma.review.count({ where: visibleReviewWhere({ channel: 'EBAY', feedbackState: { in: [...REVISION_STATES] }, feedbackStateAt: { gte: yearStart } }) }),
    prisma.review.count({ where: visibleReviewWhere({ AND: [scope, { feedbackState: { not: null } }] }) }),
  ])
  const { rows: list, counts } = revisionRows(rows, now)
  return {
    rows: list,
    counts,
    allowance: revisionAllowance(year, received, seen),
    rule: EBAY_REVISION_RULE,
    tip: EBAY_REVISION_TIP,
    noApi: EBAY_REVISION_NO_API,
    read: restRead > 0,
    words: restRead > 0 ? null : 'eBay’s revision states come with eBay’s newer feedback read, which has not read this feedback yet.',
  }
}
