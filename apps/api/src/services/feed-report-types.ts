/**
 * Channel-neutral feed-report shapes (P1). Amazon is the only producer today,
 * but eBay/Shopify adapters can emit the same shape → same UI/export unchanged.
 * A FeedIssue preserves EVERY Amazon issue individually (code, category, the
 * affected attributeNames, and the full untruncated message) — the detail the
 * old per-SKU-collapsed parser dropped.
 */

export type SkuStatus = 'success' | 'warning' | 'error'
export type FeedIssueSeverity = 'error' | 'warning' | 'info'

/** An affected editor column, resolved from an Amazon attributeName (P2). */
export interface FeedIssueColumn {
  id: string
  label: string
}

export interface FeedIssue {
  code: string
  severity: FeedIssueSeverity
  category?: string
  /** FULL, untruncated Amazon message (localized text preserved verbatim). */
  message: string
  /** Amazon's affected attribute names — the reliable location source. */
  attributeNames: string[]
  details?: string
  /** Editor columns these attributes map to — filled by the resolver (P2). */
  columns?: FeedIssueColumn[]
}

export interface PerSkuResult {
  sku: string
  status: SkuStatus
  /** Every issue for this SKU, preserved individually. */
  issues: FeedIssue[]
  // ── Legacy fields (kept populated for back-compat with already-stored rows
  //    and the existing UI/row-merge paths). Derived from the most-severe issue.
  code?: string
  message?: string
  fields?: string[]
}

export interface FeedReportSummary {
  messagesProcessed: number
  messagesSuccessful: number
  messagesWithWarning: number
  messagesWithError: number
}

export interface ParsedFeedReport {
  channel: 'AMAZON' | 'EBAY' | 'SHOPIFY'
  summary: FeedReportSummary
  perSku: PerSkuResult[]
  feedError?: string
  pending?: boolean
}
