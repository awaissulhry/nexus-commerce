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
 * - Needs a reply: a visible row whose triage status is open (none yet, New or In progress).
 */
import type { Prisma } from '@prisma/client'

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

/** Visible rows that still need a reply: no triage status yet, New, or In progress. */
export function needsReplyWhere(): Prisma.ReviewWhereInput {
  return visibleReviewWhere({ OR: [{ triageStatus: null }, { triageStatus: { in: [...OPEN_TRIAGE_STATUSES] } }] })
}
