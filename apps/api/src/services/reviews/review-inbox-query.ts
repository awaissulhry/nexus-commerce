/**
 * Reviews Inbox — the pure half: the address's filters parsed once, turned into ONE Prisma `where` (always through
 * `visibleReviewWhere`, so fixture rows never show), and the bulk bar's plan (which ticked rows an action changes, and
 * why it skips the others). No database here; review-inbox.service.ts runs the reads and writes.
 * Tests: review-inbox-query.vitest.test.ts.
 */
import type { Prisma } from '@prisma/client'
import { OPEN_REVIEW_STATUSES, REPLY_DUE_HOURS, reviewReplyRules } from '@nexus/shared/review-reply-rules'
import { reviewKindOf, reviewKindWhere, visibleReviewWhere, type ReviewKind } from './review-visibility.js'

export const INBOX_STATUSES = ['NEW', 'IN_PROGRESS', 'RESPONDED', 'RESOLVED', 'IGNORED', 'OVERDUE'] as const
export type InboxStatus = (typeof INBOX_STATUSES)[number]
export const TRIAGE_STATUS_WORDS: Record<string, string> = {
  NEW: 'New', IN_PROGRESS: 'In progress', RESPONDED: 'Responded', RESOLVED: 'Resolved', IGNORED: 'Ignored',
}
export const INBOX_MOODS = ['POSITIVE', 'NEUTRAL', 'NEGATIVE'] as const
/** `owner=none` = nobody is assigned. */
export const NO_OWNER = 'none'
export const INBOX_DEFAULT_PAGE_SIZE = 50
export const INBOX_MAX_PAGE_SIZE = 200
export const INBOX_BULK_MAX = 200
export const INBOX_BULK_DRAFT_MAX = 50

export interface InboxQuery {
  kind: 'all' | ReviewKind
  statuses: InboxStatus[]
  channels: string[]
  markets: string[]
  stars: number[]
  moods: string[]
  themes: string[]
  owners: string[]
  families: string[]
  /** null = all time. */
  periodDays: number | null
  q: string | null
  sort: { field: 'postedAt' | 'rating'; dir: 'asc' | 'desc' }
  page: number
  pageSize: number
}

function list(v: unknown): string[] {
  const raw = Array.isArray(v) ? v.join(',') : typeof v === 'string' ? v : ''
  return [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))]
}

function upperList(v: unknown): string[] {
  return [...new Set(list(v).map((s) => s.toUpperCase()))]
}

function positiveInt(v: unknown, fallback: number): number {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : fallback
}

/** "7", "7d", "30d", "90d", "all" → days or null (all time). Anything else: all time. */
export function parseInboxPeriod(v: unknown): number | null {
  const m = String(v ?? '').trim().toLowerCase().match(/^(\d{1,4})d?$/)
  if (!m) return null
  const days = Number(m[1])
  return days > 0 ? days : null
}

/** The address's query string → one InboxQuery. Unknown values are dropped, never guessed. */
export function parseInboxQuery(raw: Record<string, unknown> = {}): InboxQuery {
  const kind = raw.kind === 'product' || raw.kind === 'seller' ? raw.kind : 'all'
  const statuses = upperList(raw.status).filter((s): s is InboxStatus => (INBOX_STATUSES as readonly string[]).includes(s))
  const stars = list(raw.stars).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 5)
  const moods = upperList(raw.mood).filter((m) => (INBOX_MOODS as readonly string[]).includes(m))
  const [sortField, sortDir] = String(raw.sort ?? 'postedAt:desc').split(':')
  const q = typeof raw.q === 'string' && raw.q.trim() ? raw.q.trim().slice(0, 200) : null
  return {
    kind,
    statuses,
    channels: upperList(raw.channel),
    markets: upperList(raw.market),
    stars: [...new Set(stars)],
    moods,
    themes: upperList(raw.theme),
    owners: list(raw.owner),
    families: list(raw.family),
    periodDays: parseInboxPeriod(raw.period),
    q,
    sort: { field: sortField === 'rating' ? 'rating' : 'postedAt', dir: sortDir === 'asc' ? 'asc' : 'desc' },
    page: positiveInt(raw.page, 1),
    pageSize: Math.min(positiveInt(raw.pageSize, INBOX_DEFAULT_PAGE_SIZE), INBOX_MAX_PAGE_SIZE),
  }
}

const openWhere = (): Prisma.ReviewWhereInput => ({
  OR: [{ triageStatus: null }, { triageStatus: { in: [...OPEN_REVIEW_STATUSES] } }],
})

/** One status tile as a `where`. New includes rows never triaged; Overdue = open and older than REPLY_DUE_HOURS. */
export function inboxStatusWhere(status: InboxStatus, now: Date): Prisma.ReviewWhereInput {
  if (status === 'NEW') return { OR: [{ triageStatus: null }, { triageStatus: 'NEW' }] }
  if (status === 'OVERDUE') {
    return { AND: [openWhere(), { postedAt: { lt: new Date(now.getTime() - REPLY_DUE_HOURS * 60 * 60 * 1000) } }] }
  }
  return { triageStatus: status }
}

/**
 * The rows the Inbox shows for this query. `omit` leaves out the kind or the status filter, for the tab and tile
 * counts (each tab counts what it would show with every other filter kept).
 */
export function inboxWhere(q: InboxQuery, now: Date, omit: { kind?: boolean; status?: boolean } = {}): Prisma.ReviewWhereInput {
  const and: Prisma.ReviewWhereInput[] = []
  if (!omit.kind && q.kind !== 'all') and.push(reviewKindWhere(q.kind))
  if (!omit.status && q.statuses.length > 0) {
    and.push(q.statuses.length === 1 ? inboxStatusWhere(q.statuses[0], now) : { OR: q.statuses.map((s) => inboxStatusWhere(s, now)) })
  }
  if (q.channels.length > 0) and.push({ channel: { in: q.channels } })
  if (q.markets.length > 0) and.push({ marketplace: { in: q.markets } })
  if (q.stars.length > 0) and.push({ rating: { in: q.stars } })
  if (q.moods.length > 0 || q.themes.length > 0) {
    and.push({
      sentiment: {
        is: {
          ...(q.moods.length > 0 ? { label: { in: q.moods } } : {}),
          ...(q.themes.length > 0 ? { categories: { hasSome: q.themes } } : {}),
        },
      },
    })
  }
  if (q.owners.length > 0) {
    const named = q.owners.filter((o) => o !== NO_OWNER)
    const or: Prisma.ReviewWhereInput[] = []
    if (named.length > 0) or.push({ assignee: { in: named } })
    if (q.owners.includes(NO_OWNER)) or.push({ assignee: null })
    and.push(or.length === 1 ? or[0] : { OR: or })
  }
  if (q.families.length > 0) {
    // A variation's family sits on its parent product.
    and.push({
      product: { is: { OR: [{ familyId: { in: q.families } }, { parent: { is: { familyId: { in: q.families } } } }] } },
    })
  }
  if (q.periodDays != null) and.push({ postedAt: { gte: new Date(now.getTime() - q.periodDays * 24 * 60 * 60 * 1000) } })
  if (q.q) {
    const contains = { contains: q.q, mode: 'insensitive' as const }
    and.push({ OR: [{ title: contains }, { body: contains }, { bodyEnglish: contains }, { authorName: contains }, { sku: contains }] })
  }
  return and.length > 0 ? visibleReviewWhere({ AND: and }) : visibleReviewWhere()
}

/** "XL · Black" from a variation's attribute values; null for a product without them. */
export function variantWords(attributes: unknown): string | null {
  if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) return null
  const values = Object.values(attributes as Record<string, unknown>).filter((v) => typeof v === 'string' && v.trim()) as string[]
  return values.length > 0 ? values.join(' · ') : null
}

/** Newest first by default; a tie keeps a stable order across pages. */
export function inboxOrderBy(q: InboxQuery): Prisma.ReviewOrderByWithRelationInput[] {
  const first: Prisma.ReviewOrderByWithRelationInput =
    q.sort.field === 'rating' ? { rating: { sort: q.sort.dir, nulls: 'last' } } : { postedAt: q.sort.dir }
  return [first, { id: q.sort.dir }]
}

// ── Bulk bar: Assign · Tag · Set status · Draft with AI ───────────────────────────────────────────────────────────

export type InboxBulkAction = 'assign' | 'tag' | 'status' | 'draft'
export const INBOX_BULK_ACTIONS: readonly InboxBulkAction[] = ['assign', 'tag', 'status', 'draft']

export type InboxBulkRequest = { ids: string[]; action: InboxBulkAction; value: string | null }

/** Validates the body of POST /reviews/inbox/bulk; the refusal carries words for the person. */
export function validateInboxBulk(body: unknown):
  | { ok: true; request: InboxBulkRequest }
  | { ok: false; error: string; words: string } {
  const b = (body ?? {}) as { ids?: unknown; action?: unknown; value?: unknown }
  const ids = Array.isArray(b.ids) ? [...new Set(b.ids.filter((id): id is string => typeof id === 'string' && id.length > 0))] : []
  if (ids.length === 0) return { ok: false, error: 'no_ids', words: 'Tick at least one review.' }
  if (ids.length > INBOX_BULK_MAX) return { ok: false, error: 'too_many', words: `Pick at most ${INBOX_BULK_MAX} reviews at once.` }
  const action = b.action as InboxBulkAction
  if (!INBOX_BULK_ACTIONS.includes(action)) return { ok: false, error: 'invalid_action', words: 'Pick Assign, Tag, Set status or Draft with AI.' }
  const raw = typeof b.value === 'string' ? b.value.trim() : null
  if (action === 'assign') {
    if (raw != null && raw.length > 120) return { ok: false, error: 'invalid_value', words: 'That name is too long.' }
    return { ok: true, request: { ids, action, value: raw ? raw : null } }
  }
  if (action === 'tag') {
    if (!raw) return { ok: false, error: 'invalid_value', words: 'Type a tag first.' }
    if (raw.length > 40) return { ok: false, error: 'invalid_value', words: 'A tag is at most 40 characters.' }
    return { ok: true, request: { ids, action, value: raw } }
  }
  if (action === 'status') {
    const status = (raw ?? '').toUpperCase()
    if (!(status in TRIAGE_STATUS_WORDS)) return { ok: false, error: 'invalid_status', words: 'Pick New, In progress, Responded, Resolved or Ignored.' }
    return { ok: true, request: { ids, action, value: status } }
  }
  if (ids.length > INBOX_BULK_DRAFT_MAX) {
    return { ok: false, error: 'too_many_drafts', words: `Draft with AI takes at most ${INBOX_BULK_DRAFT_MAX} reviews at once.` }
  }
  return { ok: true, request: { ids, action, value: null } }
}

/** What the bulk plan needs to know about one ticked row. */
export interface InboxBulkRow {
  id: string
  channel: string
  marketplace: string | null
  postedAt: Date
  ingestSource: string | null
  /** `Review.kind` ('SELLER' | 'PRODUCT'), null on older rows (review-visibility.ts). */
  kind?: string | null
  assignee: string | null
  triageStatus: string | null
  triageTags: string[]
  /** Replies of this review by status. */
  sentReplies: number
  draftReplies: number
}

export const BULK_NOT_FOUND = 'Not found in this business’s Inbox.'

export function isImportedSource(ingestSource: string | null | undefined): boolean {
  return (ingestSource ?? '').toUpperCase().startsWith('IMPORT')
}

/** Which ticked rows the action changes, and why it skips the others (in the order the person ticked them). */
export function planInboxBulk(
  request: InboxBulkRequest,
  rows: InboxBulkRow[],
  now: Date = new Date(),
): { apply: InboxBulkRow[]; skipped: { id: string; reason: string }[] } {
  const byId = new Map(rows.map((r) => [r.id, r]))
  const apply: InboxBulkRow[] = []
  const skipped: { id: string; reason: string }[] = []
  for (const id of request.ids) {
    const row = byId.get(id)
    if (!row) {
      skipped.push({ id, reason: BULK_NOT_FOUND })
      continue
    }
    const reason = bulkSkipReason(request, row, now)
    if (reason) skipped.push({ id, reason })
    else apply.push(row)
  }
  return { apply, skipped }
}

function bulkSkipReason(request: InboxBulkRequest, row: InboxBulkRow, now: Date): string | null {
  switch (request.action) {
    case 'assign':
      if ((row.assignee ?? null) === request.value) return request.value ? `Already assigned to ${request.value}.` : 'Nobody is assigned already.'
      return null
    case 'tag':
      return row.triageTags.includes(request.value ?? '') ? `Already tagged “${request.value}”.` : null
    case 'status': {
      const current = row.triageStatus ?? 'NEW'
      return current === request.value ? `Already ${TRIAGE_STATUS_WORDS[current] ?? current}.` : null
    }
    case 'draft': {
      const rules = reviewReplyRules(row.channel, {
        kind: reviewKindOf(row.channel, row.kind),
        marketplace: row.marketplace,
        postedAt: row.postedAt,
        imported: isImportedSource(row.ingestSource),
        replied: row.sentReplies > 0,
      }, now)
      if (rules.held) return rules.held
      if (row.sentReplies > 0) return 'A reply was already sent.'
      if (row.draftReplies > 0) return 'A reply draft is already saved.'
      return null
    }
  }
}
