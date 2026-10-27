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
  /** Reviews Inbox — the Nexus Order this review is about, when the adapter can match it (eBay feedback). */
  orderId?: string
  /**
   * The Nexus product it is about, when the adapter can tell (eBay feedback names no product: its listing's product,
   * else its matched order's). Live audit B13: no eBay feedback reached a product's reviews.
   */
  productId?: string
  /** Reviews eBay REST (PR G) — the buyer's photos, in order; undefined = the source says nothing about photos. */
  media?: ReviewMediaInput[]
  /** eBay's AI topics; undefined = not read this pass (stored topics are kept), [] = none. */
  channelTopics?: ReviewTopic[]
  /** eBay's state of the feedback (REVISION_OPEN …) and its eligibleForRevision; undefined = not given. */
  feedbackState?: string | null
  revisionEligible?: boolean | null
  /**
   * Feedback read by eBay's REST API that the older Trading read may have stored under its own id: the order line and
   * buyer it is about, so the ingest finds that row instead of storing the feedback twice.
   */
  sameAs?: { orderLineItemId: string; buyer: string | null }
}

export interface ReviewMediaInput {
  url: string
  type: 'image' | 'video'
  width?: number | null
  height?: number | null
  position: number
}

export interface ReviewTopic {
  /** eBay's coarse topic ("shipping", "quality", …). */
  topic: string
  sentiment: 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE' | null
  /** The buyer's own words eBay found for it (at most 3). */
  texts: string[]
}

export interface AdapterResult {
  reviews: AdapterRawReview[]
  /** Non-error explanation, e.g. "no active connection" or "opt-in off". */
  note?: string
  /** A real failure during fetch/parse. Surfaced but never thrown. */
  error?: string
}
