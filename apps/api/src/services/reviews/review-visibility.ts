/**
 * Reviews area — which Review rows a person may see, and what kind each one is. Pure `where` builders: no database
 * call here, so every reader (the sidebar count, the Overview, the Inbox) asks the same question the same way and the
 * rules are tested without a database (review-visibility.vitest.test.ts).
 *
 * - Visible: every row except fixture/seed rows (`ingestSource = 'FIXTURE'`). Existing fixture rows stay in place;
 *   they are only kept out of every screen and count. A null `ingestSource` (rows older than RX.1) is visible.
 * - Kind: until the `Review.kind` column lands (Phase 3), an eBay row is seller feedback and every other row is a
 *   product review. Phase 3 switches `reviewKindOf` / `reviewKindWhere` to the column here, and nowhere else.
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

/** The kind of one row. `ingestSource` is unused until Phase 3 adds seller feedback from other channels. */
export function reviewKindOf(channel: string | null | undefined, _ingestSource?: string | null): ReviewKind {
  return (channel ?? '').toUpperCase() === 'EBAY' ? 'seller' : 'product'
}

/** The rows of one kind (the same rule as `reviewKindOf`). */
export function reviewKindWhere(kind: ReviewKind): Prisma.ReviewWhereInput {
  return kind === 'seller' ? { channel: 'EBAY' } : { channel: { not: 'EBAY' } }
}

/** Visible rows that still need a reply: no triage status yet, New, or In progress. */
export function needsReplyWhere(): Prisma.ReviewWhereInput {
  return visibleReviewWhere({ OR: [{ triageStatus: null }, { triageStatus: { in: [...OPEN_TRIAGE_STATUSES] } }] })
}
