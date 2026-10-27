/**
 * Reviews Inbox — the list (GET /api/reviews/inbox) and the bulk bar (POST /api/reviews/inbox/bulk). The filters and
 * the bulk plan are pure (review-inbox-query.ts); this file runs the reads and writes. Every Review read goes through
 * `inboxWhere` → `visibleReviewWhere`, so fixture rows never show or count.
 */
import { isReviewOverdue, reviewDueAt, isReviewOpen } from '@nexus/shared/review-reply-rules'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import {
  inboxOrderBy,
  inboxWhere,
  isImportedSource,
  parseInboxQuery,
  planInboxBulk,
  variantWords,
  type InboxBulkRequest,
  type InboxBulkRow,
  type InboxQuery,
} from './review-inbox-query.js'
import { reviewKindOf, visibleReviewWhere, type ReviewKind } from './review-visibility.js'
import { REVIEW_CATEGORIES } from './sentiment-extraction.service.js'
import { reviewSources, type ReviewSource } from './review-sources.service.js'
import { applyBulkTriage } from './review-triage.service.js'
import { createReplyDraft } from './review-reply.service.js'
import { EBAY_TOPIC_WORDS } from './adapters/ebay-topics.js'

export interface InboxRow {
  id: string
  postedAt: string
  channel: string
  market: string | null
  kind: ReviewKind
  rating: number | null
  /** The start of the text (≤ 200 characters). */
  snippet: string
  /** The start of the English text, when the review is in another language and was translated. */
  english: string | null
  language: string | null
  buyer: string | null
  product: { id: string; name: string; sku: string; variant: string | null } | null
  order: { id: string; label: string } | null
  mood: string | null
  themes: string[]
  /** A row never triaged is New. */
  status: string
  assignee: string | null
  /** When a reply is due, while the review is open; null once it is closed. */
  dueAt: string | null
  overdue: boolean
  imported: boolean
  responses: { sent: number; draft: number }
  /** PR G — how many photos (or videos) the buyer added. */
  photos: number
  /** PR G — eBay's AI topics (eBay feedback read by eBay's REST API); [] = read, none; null = never read. */
  aiTopics: { topic: string; label: string; sentiment: string | null }[] | null
}

export interface InboxReadState {
  channel: string
  market: string | null
  ok: boolean
  /** Since when it has not updated (ISO), when known. */
  since: string | null
  reason: string | null
  reconnectHref: string | null
}

export interface InboxPage {
  rows: InboxRow[]
  total: number
  page: number
  pageSize: number
  tabCounts: { all: number; product: number; seller: number }
  statusCounts: { NEW: number; IN_PROGRESS: number; RESPONDED: number; RESOLVED: number; IGNORED: number; OVERDUE: number }
  facets: { owners: string[]; themes: string[]; families: { id: string; label: string }[] }
  readState: InboxReadState[]
}

const SNIPPET = 200

function snippet(text: string | null | undefined): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim()
  return t.length > SNIPPET ? `${t.slice(0, SNIPPET - 1)}…` : t
}

/** eBay's AI topics as the list shows them (pure; null = never read; unknown JSON is skipped). */
export function topicChips(raw: unknown): InboxRow['aiTopics'] {
  if (!Array.isArray(raw)) return null
  const out: NonNullable<InboxRow['aiTopics']> = []
  for (const t of raw) {
    const topic = typeof (t as { topic?: unknown })?.topic === 'string' ? (t as { topic: string }).topic.trim().toLowerCase() : ''
    if (!topic || out.some((o) => o.topic === topic)) continue
    const sentiment = typeof (t as { sentiment?: unknown }).sentiment === 'string' ? String((t as { sentiment: string }).sentiment).toUpperCase() : null
    out.push({ topic, label: EBAY_TOPIC_WORDS[topic] ?? topic.charAt(0).toUpperCase() + topic.slice(1), sentiment })
  }
  return out
}

/** GET /api/reviews/inbox. */
export async function listInbox(rawQuery: Record<string, unknown>, now: Date = new Date()): Promise<InboxPage> {
  const q: InboxQuery = parseInboxQuery(rawQuery)
  const where = inboxWhere(q, now)

  const [items, total, tabCounts, statusCounts, facets, readState] = await Promise.all([
    prisma.review.findMany({
      where,
      orderBy: inboxOrderBy(q),
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
      select: {
        id: true, postedAt: true, channel: true, marketplace: true, rating: true, title: true, body: true,
        bodyEnglish: true, language: true, authorName: true, orderId: true, ingestSource: true, kind: true,
        triageStatus: true, assignee: true, channelTopics: true,
        _count: { select: { media: true } },
        sentiment: { select: { label: true, categories: true } },
        product: { select: { id: true, name: true, sku: true, parentId: true, variantAttributes: true } },
      },
    }),
    prisma.review.count({ where }),
    inboxTabCounts(q, now),
    inboxStatusCounts(q, now),
    inboxFacets(),
    inboxReadState(now),
  ])

  const ids = items.map((r) => r.id)
  const orderIds = [...new Set(items.map((r) => r.orderId).filter((id): id is string => !!id))]
  const [responseGroups, orders] = await Promise.all([
    ids.length > 0
      ? prisma.reviewResponse.groupBy({ by: ['reviewId', 'status'], where: { reviewId: { in: ids } }, _count: { _all: true } })
      : Promise.resolve([] as { reviewId: string; status: string; _count: { _all: number } }[]),
    orderIds.length > 0
      ? prisma.order.findMany({ where: { id: { in: orderIds } }, select: { id: true, channelOrderId: true } })
      : Promise.resolve([] as { id: string; channelOrderId: string }[]),
  ])
  const responses = new Map<string, { sent: number; draft: number }>()
  for (const g of responseGroups) {
    const entry = responses.get(g.reviewId) ?? { sent: 0, draft: 0 }
    if (g.status === 'SENT') entry.sent += g._count._all
    else if (g.status === 'DRAFT') entry.draft += g._count._all
    responses.set(g.reviewId, entry)
  }
  const orderById = new Map(orders.map((o) => [o.id, o]))

  const rows: InboxRow[] = items.map((r) => {
    const status = r.triageStatus ?? 'NEW'
    const order = r.orderId ? orderById.get(r.orderId) : undefined
    return {
      id: r.id,
      postedAt: r.postedAt.toISOString(),
      channel: r.channel,
      market: r.marketplace,
      kind: reviewKindOf(r.channel, r.kind),
      rating: r.rating,
      snippet: snippet(r.title ? `${r.title} — ${r.body}` : r.body),
      english: r.bodyEnglish ? snippet(r.bodyEnglish) : null,
      language: r.language,
      buyer: r.authorName,
      product: r.product
        ? { id: r.product.id, name: r.product.name, sku: r.product.sku, variant: r.product.parentId ? variantWords(r.product.variantAttributes) : null }
        : null,
      order: order ? { id: order.id, label: order.channelOrderId } : null,
      mood: r.sentiment?.label ?? null,
      themes: r.sentiment?.categories ?? [],
      status,
      assignee: r.assignee,
      dueAt: isReviewOpen(r.triageStatus) ? reviewDueAt(r.postedAt).toISOString() : null,
      overdue: isReviewOverdue({ status: r.triageStatus, postedAt: r.postedAt }, now),
      imported: isImportedSource(r.ingestSource),
      responses: responses.get(r.id) ?? { sent: 0, draft: 0 },
      photos: r._count.media,
      aiTopics: topicChips(r.channelTopics),
    }
  })

  return { rows, total, page: q.page, pageSize: q.pageSize, tabCounts, statusCounts, facets, readState }
}

/** Each tab counts what it would show with every other filter kept. */
async function inboxTabCounts(q: InboxQuery, now: Date): Promise<InboxPage['tabCounts']> {
  const groups = await prisma.review.groupBy({ by: ['channel', 'kind'], where: inboxWhere(q, now, { kind: true }), _count: { _all: true } })
  const counts = { all: 0, product: 0, seller: 0 }
  for (const g of groups) {
    counts.all += g._count._all
    counts[reviewKindOf(g.channel, g.kind)] += g._count._all
  }
  return counts
}

/** Each tile counts what it would show with every other filter kept. A row never triaged counts as New. */
async function inboxStatusCounts(q: InboxQuery, now: Date): Promise<InboxPage['statusCounts']> {
  const base = inboxWhere(q, now, { status: true })
  const overdueQuery: InboxQuery = { ...q, statuses: ['OVERDUE'] }
  const [groups, overdue] = await Promise.all([
    prisma.review.groupBy({ by: ['triageStatus'], where: base, _count: { _all: true } }),
    prisma.review.count({ where: inboxWhere(overdueQuery, now) }),
  ])
  const counts = { NEW: 0, IN_PROGRESS: 0, RESPONDED: 0, RESOLVED: 0, IGNORED: 0, OVERDUE: overdue }
  for (const g of groups) {
    const key = (g.triageStatus ?? 'NEW') as keyof typeof counts
    if (key in counts && key !== 'OVERDUE') counts[key] += g._count._all
  }
  return counts
}

async function inboxFacets(): Promise<InboxPage['facets']> {
  const [owners, families] = await Promise.all([
    prisma.review.groupBy({ by: ['assignee'], where: visibleReviewWhere({ assignee: { not: null } }), _count: { _all: true } }),
    prisma.productFamily.findMany({ select: { id: true, label: true }, orderBy: { label: 'asc' } }),
  ])
  return {
    owners: owners.map((o) => o.assignee).filter((a): a is string => !!a).sort((a, b) => a.localeCompare(b)),
    themes: [...REVIEW_CATEGORIES],
    families,
  }
}

/**
 * Which channels Nexus reads reviews from, and whether that reading works — in words, never a setting's name. ONE
 * source with the Overview's channel table and Reviews Settings › Sources: review-sources.service.ts. A channel × market
 * that stopped updating (sign-in expired, not read since …) is `ok: false` with its reason and, when a person can fix
 * it, where (Settings › Channels).
 */
export async function inboxReadState(now: Date = new Date()): Promise<InboxReadState[]> {
  const { sources } = await reviewSources(now)
  return readStateFromSources(sources)
}

/** The Inbox's read state from the review sources (pure). */
export function readStateFromSources(sources: readonly ReviewSource[]): InboxReadState[] {
  return sources.map((s) => ({
    channel: s.channel,
    market: s.market,
    ok: s.state === 'ok',
    since: s.since,
    reason: s.reason,
    reconnectHref: s.reconnectHref,
  }))
}

// ── Bulk ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** POST /api/reviews/inbox/bulk (the request is validated by `validateInboxBulk`). */
export async function runInboxBulk(
  request: InboxBulkRequest,
  actor: string,
  now: Date = new Date(),
): Promise<{ changed: number; skipped: { id: string; reason: string }[] }> {
  const found = await prisma.review.findMany({
    where: visibleReviewWhere({ id: { in: request.ids } }),
    select: {
      id: true, channel: true, marketplace: true, postedAt: true, ingestSource: true, kind: true,
      assignee: true, triageStatus: true, triageTags: true,
    },
  })
  const replyGroups = request.action === 'draft' && found.length > 0
    ? await prisma.reviewResponse.groupBy({ by: ['reviewId', 'status'], where: { reviewId: { in: found.map((r) => r.id) } }, _count: { _all: true } })
    : []
  const rows: InboxBulkRow[] = found.map((r) => {
    const mine = replyGroups.filter((g) => g.reviewId === r.id)
    return {
      ...r,
      sentReplies: mine.filter((g) => g.status === 'SENT').reduce((n, g) => n + g._count._all, 0),
      draftReplies: mine.filter((g) => g.status === 'DRAFT').reduce((n, g) => n + g._count._all, 0),
    }
  })
  const plan = planInboxBulk(request, rows, now)
  if (plan.apply.length === 0) return { changed: 0, skipped: plan.skipped }

  if (request.action !== 'draft') {
    const changed = await applyBulkTriage(request.action, request.value, plan.apply)
    return { changed, skipped: plan.skipped }
  }

  // Draft with AI: one AI call per review (≤ 50), a few at a time; each becomes a DRAFT reply that waits for a person.
  let changed = 0
  const skipped = [...plan.skipped]
  const queue = [...plan.apply]
  const worker = async () => {
    for (let row = queue.shift(); row; row = queue.shift()) {
      try {
        const out = await createReplyDraft(row.id, { actor })
        if ('error' in out) skipped.push({ id: row.id, reason: 'Not found in this business’s Inbox.' })
        else changed += 1
      } catch (err) {
        logger.warn('[review-inbox] bulk draft failed', { reviewId: row.id, error: err instanceof Error ? err.message : String(err) })
        skipped.push({ id: row.id, reason: 'The draft could not be made. Try this review on its own.' })
      }
    }
  }
  await Promise.all([worker(), worker(), worker()])
  return { changed, skipped }
}
