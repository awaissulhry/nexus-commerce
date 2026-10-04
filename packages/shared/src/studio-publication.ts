/** Product studio publication uses an explicit account and listing coordinate. */
export interface StudioPublishScope {
  channel: string
  marketplace: string
  accountId: string
  listingId?: string
}

export interface StudioPublishIssue {
  productId?: string
  sku?: string
  field?: string
  message: string
  severity: 'error' | 'warning'
  /** The channel's own words behind `message` (eBay's check answers in its own text), shown as a detail. */
  detail?: string
}

export interface StudioPublishReview {
  id: string | null
  productId: string
  scope: StudioPublishScope
  accountLabel: string
  aliasLabel: string
  mode: string
  action: 'create' | 'update'
  rows: Array<{ productId: string; sku: string; title: string; existing: boolean }>
  excluded: number
  issues: StudioPublishIssue[]
  expiresAt: string
  locations?: Array<{ id: string; name: string }>
  visibility?: string
  previousPublicationId?: string
  /** Fresh channel comparison. Missing means this server cannot review sparse publication yet. */
  changes?: StudioPublishChange[]
  skipped?: Array<{ productId: string; sku: string; reason: string }>
  /** Historical content observations, not a live read or a list of changes to be sent. */
  overwrite?: StudioPublishOverwrite
  /**
   * Images rebuild P4c — some fields have problems (every error names its field), so only photo fields may be sent from
   * this review. The problems are in `issues`; a selection with any other field is refused.
   */
  photosOnly?: boolean
}

/** The change-review fields that carry only photos (eBay Trading gallery and colour sets; eBay Inventory's). */
export const PUBLICATION_PHOTO_FIELDS: ReadonlySet<string> = new Set(['pictures', 'Pictures', 'variationPictures'])

/** Whether a change id (`["<productId>","<field>"]`) is a photo field. */
export function isPhotoChangeId(id: string): boolean {
  try {
    const parsed: unknown = JSON.parse(id)
    return Array.isArray(parsed) && typeof parsed[1] === 'string' && PUBLICATION_PHOTO_FIELDS.has(parsed[1])
  } catch { return false }
}

/**
 * The problems that block a publication. When every error names a field, a selection of photo fields only is not
 * blocked by them — it sends no other field (Owner, 2026-09-28: an off-list Season value blocked a photos-only send).
 * An error that names no field (the account, a paused listing, the photo plan's own checks) always blocks.
 */
export function blockingIssues(issues: readonly StudioPublishIssue[], selectedIds?: readonly string[]): StudioPublishIssue[] {
  const errors = issues.filter(i => i.severity === 'error')
  if (!errors.length || errors.some(i => !i.field)) return errors
  return selectedIds?.length && selectedIds.every(isPhotoChangeId) ? [] : errors
}

export interface StudioPublishOverwrite {
  requiresConfirmation: boolean
  products: Array<{
    productId: string
    sku: string
    status: 'new' | 'not_read' | 'not_compared' | 'compared'
    checkedAt: string | null
    reason?: string
    differing: number
    notCompared: number | null
    omittedDifferences: number
    fields: Array<{ field: string; nexusAtRead: unknown; channelAtRead: unknown; checkedAt: string }>
  }>
}

/** Absence is a known cleared value; unknown never means unchanged or cleared. */
export type StudioPublishValue = { state: 'value'; value: unknown } | { state: 'absent' } | { state: 'unknown'; reason: string }

/** An intentional field write; required preserved collection siblings are not adopted as Nexus changes. */
export interface StudioPublishFieldWrite {
  field: string
  value: Exclude<StudioPublishValue, { state: 'unknown' }>
}

export interface StudioPublishChange {
  id: string
  productId: string
  sku: string
  field: string
  label: string
  current: StudioPublishValue
  lastAccepted: StudioPublishValue
  channel: StudioPublishValue
  status: 'SEND' | 'DIFFERS' | 'CANNOT_COMPARE' | 'SAME'
  localChanged: boolean | null
  channelChanged: boolean | null
  selectable: boolean
  selectedByDefault: boolean
  reason: string
  operation: 'replace' | 'delete' | null
  /**
   * Amazon sheet gaps (D4=B) — an Amazon offer draft line shows three values in words instead of the raw ones: the
   * saved value that waits for Publish, the value live in Nexus, and what Amazon shows now. `note` carries a warning
   * (Automate Pricing, Always available) or "Live changed since you saved".
   */
  display?: StudioPublishChangeDisplay
}

export interface StudioPublishChangeDisplay { current: string; lastAccepted: string; channel: string; note?: string }

/** The sheet's words for an offer draft whose Publish was sent but whose result Amazon never gave (UNVERIFIED). */
export const OFFER_DRAFT_UNVERIFIED = 'Sent — Amazon\'s answer is unknown. Check Amazon, then publish again or discard.'

export interface StudioPublishResult {
  id: string
  status: 'SUBMITTED' | 'ACCEPTED' | 'VERIFIED' | 'PARTIAL' | 'FAILED' | 'PUBLISHING' | 'UNVERIFIED'
  message: string
  warnings?: string[]
  results: Array<{ sku: string; status: 'SUBMITTED' | 'ACCEPTED' | 'VERIFIED' | 'FAILED'; message: string; reference?: string
    /** The channel's own issues for this SKU, one per issue (an Amazon processing report keeps them apart). */
    issues?: StudioChannelIssue[] }>
}

/** One channel issue on one SKU of a publication result: the channel's code, words and named attributes. */
export interface StudioChannelIssue {
  code: string
  severity: 'error' | 'warning' | 'info'
  message: string
  attributeNames: string[]
}

/**
 * Sheet publish parity, step 3 (item 2) — what became of the last publish of each sheet row on one destination:
 * `GET /api/products/:id/studio/publication-status?channel&market&accountId&aliasKey`. Shaped for the design
 * system's `PublishStatusValue` (`grid/renderers/publishStatus.ts`); the browser maps `attributeNames` to columns.
 */
export interface StudioRowLastPublish {
  publicationId: string
  /** The publication's status (`StudioPublishResult['status']`). */
  status: string
  /** This row's own result inside it: the stored per-SKU result, else the publish journal's outcome; null = not known. */
  outcome: 'SUBMITTED' | 'ACCEPTED' | 'VERIFIED' | 'FAILED' | 'UNKNOWN' | null
  /** ISO time the publish was sent. */
  at: string
  userName: string | null
  message: string | null
  /** Feed id, ItemID or product id on the channel. */
  reference: string | null
  /** Field names the publish carried for this row; `['$create']` = a complete new listing; empty = not recorded. */
  sentFields: string[]
  /** The channel's issues for this row in that publish. */
  issues: StudioChannelIssue[]
}

/** An issue the channel reports for the listing NOW (open `ListingIssue`), whatever produced it. */
export interface StudioRowOpenIssue extends StudioChannelIssue {
  source: string
  /** ISO time the channel last reported it. */
  seenAt: string
}

export interface StudioRowPublicationStatus {
  productId: string
  listingId: string
  sku: string
  last: StudioRowLastPublish | null
  issues: StudioRowOpenIssue[]
}

export interface StudioPublicationStatus {
  destination: { channel: string; marketplace: string; accountId: string; aliasKey: string }
  /** A publication to this destination that has not settled; the sheet re-reads while it is set. */
  inFlight: { publicationId: string; status: string } | null
  /** The newest sent publication to this destination, with its counts (for the toolbar status). */
  latest: { publicationId: string; status: string; at: string; completedAt: string | null; summary: Record<string, unknown> | null } | null
  rows: StudioRowPublicationStatus[]
  /** ISO time of this read. */
  readAt: string
}

/**
 * Sheet publish parity T1 — one saved review read back (`GET /api/products/:id/studio-publication/:reviewId/review`),
 * for a row of the many-product dialog. The same review the preview returned, the fields ticked so far, and whether
 * the ticks can still change (through the selection route). It never carries the exact channel request.
 */
export interface StudioPublishStoredReview {
  review: StudioPublishReview
  /** The review row's status: PREVIEW while it waits, BLOCKED when it can never be sent, or a later status. */
  status: string
  /** The fields ticked so far (a batch's default ticks, or the person's choice); null when none were ticked yet. */
  selectedIds: string[] | null
  fieldCount: number | null
  /** The ticks can still change: the review waits (PREVIEW), has not expired, and lists its fields. */
  editable: boolean
}

/** Exact request for one explicit selection, bound to a durable review. */
export interface StudioPublishSelection {
  reviewId: string
  token: string
  selectedIds: string[]
  products: Array<{ productId: string; sku: string }>
  fieldCount: number
  payload: { format: 'json' | 'xml'; content: string }
}

/**
 * Sheet publish parity, D3 (Owner, 2026-10-01) — a person checked a publication that is still waiting for a result:
 * `POST /api/products/:id/studio-publication/:reviewId/mark-checked` with `{ note?: string }` (500 characters at most).
 * The status stays what it was (Nexus never invents a result); the publication is closed, stops blocking its
 * destination and is no longer swept. In the stored summary: `checkedAt`, `checkedBy` (user id), `checkedNote`.
 */
export interface StudioPublicationCheck {
  publicationId: string
  /** Unchanged by the check: still PUBLISHING, SUBMITTED or UNVERIFIED, unless a real result arrived since. */
  status: StudioPublishResult['status']
  /** ISO time of the check. */
  checkedAt: string
  checkedBy: { id: string; name: string | null } | null
  note: string | null
  /** No other unsettled publication blocks this destination: a new publish can start. */
  destinationOpen: boolean
}

/**
 * "Publish failed products again…" — what to pre-tick in a NEW review of the same destination:
 * `GET /api/products/:id/studio-publication/:reviewId/retry-selection`. Nothing is sent and no stored request is
 * replayed; the new review compares the current saved values again. Change ids are `["<productId>","<field>"]`, the
 * same in every review of the destination, so `fieldIds` can be matched against the new review's `changes`.
 */
export interface StudioRetrySelection {
  publicationId: string
  status: StudioPublishResult['status']
  /** The destination of the failed publication: open the Publish dialog on it. */
  destination: StudioPublishScope & { aliasKey: string }
  /** The products that failed (or were never sent), by product id. Empty when every product was accepted. */
  productIds: string[]
  /** The selected change ids of those products in the failed publication (every field the channel did not apply). */
  fieldIds: string[]
  products: Array<{
    productId: string
    sku: string
    /** The channel's (or Nexus's) words for this product's failure. */
    message: string | null
    /** Attributes the channel named in its issues for this product. */
    attributeNames: string[]
    fieldIds: string[]
    /** The subset of `fieldIds` whose field the channel named; empty when it named none. */
    flaggedFieldIds: string[]
  }>
  /** Failed SKUs the publication's records could not tie to a product; the review cannot pre-tick them. */
  unmatchedSkus: string[]
  /** True when nothing reached the channel (a refusal before sending): every delivered product is listed. */
  notSent: boolean
}

/**
 * Sheet publish parity, step 5 (item 3) — one action that publishes a family to several destinations (markets or
 * accounts). Each destination keeps its own review (its own change plan and ticks); the batch only sends them, in the
 * background, so closing the dialog does not stop it. `POST /api/publication-batches` with `PublicationBatchRequest`
 * answers 202 `{ batchId }`; `GET /api/publication-batches/:id` and `POST /api/publication-batches/:id/cancel` answer
 * `PublicationBatchView`. Every route needs products.publish.
 */
export interface PublicationBatchRequest {
  reviews: Array<{ reviewId: string; selectionToken?: string; confirmOverwrite?: boolean; locationId?: string }>
}

/**
 * Sheet publish parity, step 6 (item 6) — many families from the products list. `POST /api/publication-batches` with
 * this body answers 202 `{ batchId }`; the batch first REVIEWS every family × destination in the background (phase
 * REVIEWING), with the default ticks (only the fields Nexus changed; fields the channel holds differently only with
 * `replaceDiffers`), then waits (REVIEWED) until `POST /api/publication-batches/:id/submit`. A selected variation
 * means its family. At most 200 products and 25 destinations; at most 1,000 reviews.
 */
export interface PublicationBatchFamiliesRequest {
  productIds: string[]
  destinations: StudioPublishScope[]
  options?: { replaceDiffers?: boolean }
}

/** `POST /api/publication-batches/:id/submit` — send what the batch reviewed. */
export interface PublicationBatchSubmitRequest {
  /** Reviews whose overwrite warning the person confirmed (Shopify). */
  confirmOverwrite?: string[]
  /** The Shopify inventory location per Shopify account. */
  shopifyLocations?: Record<string, string>
}

/** What the batch itself is doing. The children's results are counted, never stored twice. */
export type PublicationBatchPhase = 'REVIEWING' | 'REVIEWED' | 'QUEUED' | 'RUNNING' | 'SENT' | 'CANCELLING' | 'CANCELLED'

/**
 * One destination of a batch. `status` is the publication's own status (`StudioPublishResult['status']`) or, for a
 * review the batch did not send: PREVIEW (still waiting its turn), NOT_SENT (refused before sending, `message` says
 * why), CANCELLED (the batch was cancelled before its turn) or BLOCKED (its review could not be sent).
 */
export interface PublicationBatchChild {
  publicationId: string
  productId: string | null
  channel: string | null
  marketplace: string | null
  accountId: string | null
  aliasKey: string | null
  status: string
  /** Nothing more will happen to it: a final result, not sent, cancelled, blocked, or a person marked it checked. */
  terminal: boolean
  /** Still waiting for a result, but a person marked it checked (it no longer blocks its destination). */
  checked: boolean
  message: string | null
  summary: Record<string, unknown> | null
  /** Step 6 — the family this row publishes (its main product), for one row per family × destination. */
  familySku?: string | null
  familyTitle?: string | null
  /** Products in this review (the family's main product and its included variations). */
  productCount?: number | null
  /** Fields ticked to send (null when the channel has no field ticks, e.g. Shopify). */
  selectedCount?: number | null
  /** The review's own problems: errors block it, warnings do not. At most five messages are listed. */
  problems?: { errors: number; warnings: number; messages: string[] }
  /** When the review stops being sendable (a batch review lives 2 hours). */
  expiresAt?: string | null
  /** Not sent because every ticked field already matches the channel. */
  nothingToSend?: boolean
}

/** Step 6 — how long the rest of the batch should take, from the channels' rates. Null when nothing is left. */
export interface PublicationBatchEstimate {
  seconds: number | null
  /** Rounded up; at least 1 while anything is left. */
  minutes: number | null
  /** One plain sentence on the rates the estimate uses. */
  basis: string
}

export interface PublicationBatchCounts {
  total: number
  /** Not sent yet: waiting its turn. */
  waiting: number
  /** Being sent now. */
  sending: number
  /** Sent; the channel has not answered yet. */
  awaitingChannel: number
  succeeded: number
  partial: number
  failed: number
  notSent: number
  cancelled: number
  blocked: number
  /** Marked checked by a person while its result was still unknown. */
  checked: number
}

export interface PublicationBatchView {
  batchId: string
  phase: PublicationBatchPhase
  createdAt: string
  /** ISO time every destination had its turn (phase SENT or CANCELLED); null while sending. */
  sentAt: string | null
  cancelRequestedAt: string | null
  /** Every destination is final (see `PublicationBatchChild.terminal`) and the batch is no longer sending. */
  done: boolean
  outcome: 'IN_PROGRESS' | 'SUCCEEDED' | 'PARTIAL' | 'FAILED' | 'CANCELLED'
  counts: PublicationBatchCounts
  children: PublicationBatchChild[]
  /** Step 6 — 'review' while a many-family batch is reviewing or waiting for the person; 'send' once sent. */
  stage?: 'review' | 'send'
  /** Step 6 — what a many-family batch was asked to review. Null for a batch of reviews made in the dialog. */
  request?: { families: number; destinations: number; reviews: number; reviewed: number } | null
  /** Step 6 — time left for the current stage (when REVIEWED: for the send that submit starts). */
  estimate?: PublicationBatchEstimate
}
