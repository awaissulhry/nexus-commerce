/**
 * RX.1b — Shared types for live review-source adapters.
 *
 * Each adapter is read-only and self-contained: it resolves its own
 * channel credentials, fetches, maps to RawReview, and NEVER throws past
 * its own boundary — failures come back as { error } so one channel's
 * outage can't poison the others' ingestion.
 */

export interface AdapterRawReview {
  externalReviewId: string
  channel: string
  marketplace?: string
  asin?: string
  sku?: string
  rating?: number
  title?: string
  body: string
  authorName?: string
  authorId?: string
  verifiedPurchase?: boolean
  helpfulVotes?: number
  postedAt: string // ISO
  rawPayload?: unknown
}

export interface AdapterResult {
  reviews: AdapterRawReview[]
  /** Non-error explanation, e.g. "no active connection" or "opt-in off". */
  note?: string
  /** A real failure during fetch/parse. Surfaced but never thrown. */
  error?: string
}
