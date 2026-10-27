/**
 * Reviews area — which Review rows a person may see, and what kind each one is. Pure `where` builders: no database
 * call here, so every reader (the sidebar count, the Overview, the Inbox) asks the same question the same way and the
 * rules are tested without a database (review-visibility.vitest.test.ts).
 *
 * - Visible: every row except fixture/seed rows (`ingestSource = 'FIXTURE'`). Existing fixture rows stay in place;
 *   they are only kept out of every screen and count. A null `ingestSource` (rows older than RX.1) is visible.
 * - Kind: the `Review.kind` column ('SELLER' | 'PRODUCT', Phase 3 PR H) says what a row is about — Amazon's seller
 *   feedback is an Amazon row about the seller. A row with no kind (stored before the column) reads by the old channel
 *   rule: an eBay row is seller feedback and every other row is a product review. No row is rewritten; a later contract
 *   step may backfill the column. `reviewKindOf` and `reviewKindWhere` are the only places that decide it.
 * - Needs a reply (Owner, 2026-10-27 — ONE definition, used by the rail and sub-sidebar badges, the Inbox's "Needs a
 *   reply" filter and its Overdue tile, the Overview tile, the channel pages, Needs you and the digest): a visible row
 *   whose triage status is open (none yet, New or In progress) AND that someone can answer AND that was not imported.
 *   Amazon's product reviews never need a reply — Amazon lets nobody reply to them (@nexus/shared review-reply-rules);
 *   an Etsy review whose 100-day reply window closed cannot be answered (the 100 days count from the buyer's last edit,
 *   `channelEditedAt`, else from when it was posted — the reply rules' own window); a row a person imported from a
 *   file is old history read in, never work. Shopify reviews (Judge.me answered from Nexus, the other apps by copy)
 *   and Etsy reviews inside their window count. Overdue = the same rows, open for more than REPLY_DUE_HOURS.
 */
import type { Prisma } from '@prisma/client'
import { ETSY_REPLY_WINDOW_DAYS, REPLY_DUE_HOURS } from '@nexus/shared/review-reply-rules'

export type ReviewKind = 'product' | 'seller'

/** The `ingestSource` of fixture/seed rows. They never show in the Reviews area. */
export const FIXTURE_SOURCE = 'FIXTURE'

/** Triage statuses that still need a person; a null status counts as New (RX.2). */
export const OPEN_TRIAGE_STATUSES = ['NEW', 'IN_PROGRESS'] as const

/** Rows a person may see, optionally narrowed by `extra` (both must hold). */
export function visibleReviewWhere(extra?: Prisma.ReviewWhereInput): Prisma.ReviewWhereInput {
  // `not: 'FIXTURE'` alone would also drop rows with no source: SQL compares NULL <> 'FIXTURE' as unknown.
  const visible: Prisma.ReviewWhereInput = { OR: [{ ingestSource: null }, { ingestSource: { not: FIXTURE_SOURCE } }] }
  return extra ? { AND: [visible, extra] } : visible
}

/** The values `Review.kind` holds. */
export const REVIEW_KIND_VALUE: Record<ReviewKind, 'SELLER' | 'PRODUCT'> = { seller: 'SELLER', product: 'PRODUCT' }

/** The kind of one row: its `kind` column when set, else the old channel rule (eBay = seller feedback). */
export function reviewKindOf(channel: string | null | undefined, kind?: string | null): ReviewKind {
  const k = (kind ?? '').toUpperCase()
  if (k === 'SELLER') return 'seller'
  if (k === 'PRODUCT') return 'product'
  return (channel ?? '').toUpperCase() === 'EBAY' ? 'seller' : 'product'
}

/** The rows of one kind (the same rule as `reviewKindOf`): the column, or the channel rule where the column is empty. */
export function reviewKindWhere(kind: ReviewKind): Prisma.ReviewWhereInput {
  return kind === 'seller'
    ? { OR: [{ kind: 'SELLER' }, { AND: [{ kind: null }, { channel: 'EBAY' }] }] }
    : { OR: [{ kind: 'PRODUCT' }, { AND: [{ kind: null }, { channel: { not: 'EBAY' } }] }] }
}

/**
 * Whether a row's stars may count in an average, a spread or a trend. Amazon's seller feedback report holds ONLY
 * feedback of 1 to 3 stars (Amazon gives no 4–5 star feedback by API), so averaging it would drag every number down:
 * those rows are counted and listed, never averaged.
 */
export function countsInRating(row: { channel: string | null | undefined; kind?: string | null }): boolean {
  return !((row.channel ?? '').toUpperCase() === 'AMAZON' && reviewKindOf(row.channel, row.kind) === 'seller')
}

/** A row a person imported from a file (`IMPORT_CSV`): read in as history, its channel id unknown. */
export function isImportedSource(ingestSource: string | null | undefined): boolean {
  return (ingestSource ?? '').toUpperCase().startsWith('IMPORT')
}

/** The imported rows (the same rule as `isImportedSource`). */
function importedWhere(): Prisma.ReviewWhereInput {
  return { ingestSource: { startsWith: 'IMPORT', mode: 'insensitive' } }
}

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

/**
 * Whether anyone can answer this review at all: never Amazon's product reviews; Etsy within its reply window (100 days
 * from the buyer's last edit, else from when it was posted). Pure.
 */
export function canTakeReply(
  row: { channel: string | null | undefined; kind?: string | null; postedAt?: Date | string | null; channelEditedAt?: Date | string | null },
  now: Date = new Date(),
): boolean {
  const channel = (row.channel ?? '').toUpperCase()
  if (channel === 'AMAZON' && reviewKindOf(channel, row.kind) === 'product') return false
  const from = row.channelEditedAt ?? row.postedAt
  if (channel === 'ETSY' && from != null) {
    const start = new Date(from).getTime()
    if (Number.isFinite(start) && now.getTime() - start > ETSY_REPLY_WINDOW_DAYS * DAY_MS) return false
  }
  return true
}

/** One row: does it need a reply (the same rule as `needsReplyWhere`)? Pure. */
export function reviewNeedsReply(
  row: { channel: string | null | undefined; kind?: string | null; ingestSource?: string | null; triageStatus?: string | null; postedAt?: Date | string | null; channelEditedAt?: Date | string | null },
  now: Date = new Date(),
): boolean {
  if (row.ingestSource === FIXTURE_SOURCE) return false
  if (row.triageStatus != null && !(OPEN_TRIAGE_STATUSES as readonly string[]).includes(row.triageStatus)) return false
  if (isImportedSource(row.ingestSource)) return false
  return canTakeReply(row, now)
}

/** Visible rows that still need a reply: open (no triage status yet, New, In progress), answerable, not imported. */
export function needsReplyWhere(now: Date = new Date()): Prisma.ReviewWhereInput {
  const etsyCutoff = new Date(now.getTime() - ETSY_REPLY_WINDOW_DAYS * DAY_MS)
  return visibleReviewWhere({
    AND: [
      { OR: [{ triageStatus: null }, { triageStatus: { in: [...OPEN_TRIAGE_STATUSES] } }] },
      { OR: [{ ingestSource: null }, { NOT: importedWhere() }] },
      { NOT: { AND: [{ channel: 'AMAZON' }, reviewKindWhere('product')] } },
      // Etsy: the window closed — 100 days after the buyer's last edit, else after it was posted.
      {
        NOT: {
          AND: [
            { channel: 'ETSY' },
            { OR: [{ channelEditedAt: { lt: etsyCutoff } }, { AND: [{ channelEditedAt: null }, { postedAt: { lt: etsyCutoff } }] }] },
          ],
        },
      },
    ],
  })
}

/** The rows that need a reply and have waited more than REPLY_DUE_HOURS since they were posted. */
export function overdueWhere(now: Date = new Date()): Prisma.ReviewWhereInput {
  return { AND: [needsReplyWhere(now), { postedAt: { lt: new Date(now.getTime() - REPLY_DUE_HOURS * HOUR_MS) } }] }
}

/** One row: needs a reply and is older than REPLY_DUE_HOURS (the same rule as `overdueWhere`). Pure. */
export function reviewOverdue(
  row: { channel: string | null | undefined; kind?: string | null; ingestSource?: string | null; triageStatus?: string | null; postedAt: Date | string; channelEditedAt?: Date | string | null },
  now: Date = new Date(),
): boolean {
  if (!reviewNeedsReply(row, now)) return false
  const posted = new Date(row.postedAt).getTime()
  return Number.isFinite(posted) && posted + REPLY_DUE_HOURS * HOUR_MS < now.getTime()
}
