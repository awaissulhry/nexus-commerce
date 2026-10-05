/**
 * Sheet publish parity, build shape v2 (Owner 2026-10-04), phase P6 — ONE Publish of one product family to one or many
 * destinations: the rows' content (Partial and Full update) AND their waiting lifecycle values (a Status change —
 * Active, Inactive, Ended — or the Action column's Delete), reviewed together and sent together.
 *
 *   POST /api/products/:id/studio-publication/plan   `PublishPlanRequest` → `PublishPlan`               products.publish
 *        Per destination: the content review (the studio's own review, made with the Full update rows), the lifecycle
 *        rows (one per waiting value), the values the listing outgrew, and the rows whose content is held back.
 *   POST /api/publication-batches                     `{ plan: PublishPlanSubmit }` → 202 `{ batchId }`  products.publish
 *        One batch header with mixed children: the content reviews and one listing-action change per destination ×
 *        action. Ended and Delete need the typed family SKU AND products.delete (without products.delete they are not
 *        sent and keep waiting; the rest still sends).
 *   GET  /api/publication-batches/:id                 → `PublishPlanBatchView` (a `PublicationBatchView` whose children
 *        carry `kind` and `action`).
 *
 * The send order per channel account is `SEND_ORDER` (publish-actions.ts): Resume and Relist → content → Pause → End →
 * Delete. A row being ended or deleted gets no content (`contentGoesOut`); the review says why. Success clears a
 * waiting value (only if nobody changed it since the review); a failure keeps it. A Full update value clears when the
 * channel accepts that row.
 *
 * Which path a Publish takes (`publishPlanUsesBatch`): the batch when it has more than one destination, a ticked
 * lifecycle row or a value to clear; a single destination with content only keeps today's direct submit
 * (`POST …/studio-publication/:reviewId/submit`).
 *
 * P11 — the products list's Publish… window (many products × many markets, `ManyPublishRequest`): besides sending the
 * changes, it can set every listing of the chosen products in the chosen markets to one Status (Active / Inactive /
 * Ended; no Delete there). The batch reviews each product × market in the background with the engine's own plan (one
 * lifecycle child per product × market × action, refusals with the reason), waits, and sends on
 * `POST /api/publication-batches/:id/submit` (`ManySubmitRequest`). Ended needs products.delete and the typed COUNT of
 * listings it ends ("Type 36 to end 36 listings."), not a SKU. The single-family plan above is unchanged.
 *
 * New listings (ND4 B, Owner 2026-10-04): the window may also say how the listings its changes CREATE start
 * (`options.startAs`: Active or Inactive, per the channel's rules); each content review then marks the rows it creates
 * (`rows[].startsAs`) and the batch child lists them (`creates`): "Creates GALE-M (inactive)" (`createsSentence`).
 *
 * Pure and shared by the API and the web.
 */
import type { ListingAction, ListingActionDestination, ListingActionPlanRow, ListingActionRowResult, SellingState, StatusTarget } from './listing-actions.js'
import type { SendMode, SendStep } from './publish-actions.js'
import { isPhotoChangeId, type PublicationBatchChild, type PublicationBatchCounts, type PublicationBatchView, type StudioPublishReview,
  type StudioPublishScope } from './studio-publication.js'

/** One Publish reviews and sends at most this many destinations (the batch route's limit). */
export const MAX_PLAN_DESTINATIONS = 25

// ── The review: POST /api/products/:id/studio-publication/plan ──────────────────────────────────

export interface PublishPlanRequest {
  /** The destinations to review, in the order the person chose them (1 to `MAX_PLAN_DESTINATIONS`). */
  destinations: StudioPublishScope[]
}

/** Which column holds a waiting value: the Status column (Active / Inactive / Ended) or the Action column (Full update / Delete). */
export type PublishPlanColumn = 'status' | 'send'

/** One waiting Status change or Delete of one listing row. */
export interface PublishPlanLifecycleRow {
  /** Opaque. Send it back, as given, in `PublishPlanSubmit.lifecycle` to send this row. It pins the value this review saw. */
  id: string
  listingId: string
  productId: string
  sku: string
  isParent: boolean
  column: PublishPlanColumn
  /** The waiting value: a Status target, or 'delete'. */
  value: StatusTarget | 'delete'
  /** What Publish does for it, from the listing's state now (`statusChangeAction`), or 'delete'. */
  action: ListingAction
  /** Its place in the send order (`SEND_ORDER`). */
  step: SendStep
  /** The listing's selling state now. */
  state: SellingState
  /** This row's own line (plain English): "Stops selling here.", or why nothing would be sent. */
  sentence: string
  /** What the whole change does on this destination (plain English), the same on every row of one destination × action. */
  consequence: string
  /** Offered, but the person should know this first (an FBA pause; an FBA delete's unit count and Pan-European FBA), or null. */
  warning: string | null
  /** A check the channel answers only when sending (eBay's out-of-stock control), or null. */
  checkedAtSend: string | null
  setAt: string
  setById: string | null
  setByName: string | null
  /** Set by someone else, or more than 24 hours ago: starts unticked (`isStaleWaiting`). */
  stale: boolean
  /** Ticked when the window opens: not stale and not refused. */
  tickedByDefault: boolean
  /** Ended and Delete: sending it needs the typed confirmation (`PublishPlan.confirm`) and products.delete. */
  needsTypedConfirm: boolean
  /** Why it cannot be sent now (it keeps waiting), or null when it can. A refused row cannot be ticked. */
  refused: string | null
}

/** A waiting value the listing outgrew (already in that state, no longer allowed, another listing now): not sent. */
export interface PublishPlanOutgrownRow {
  /** Opaque. Send it back in `PublishPlanSubmit.outgrown`: the value is cleared when the Publish is sent, if nobody changed it. */
  id: string
  listingId: string
  productId: string
  sku: string
  column: PublishPlanColumn
  value: SendMode | StatusTarget
  /** "No longer applies": why, in plain English. */
  reason: string
}

/** A row whose content this Publish does not send (it is being ended, deleted or relisted, or Nexus deleted it and its Status is Not listed), and why. */
export interface PublishPlanHeldRow {
  productId: string
  sku: string
  reason: string
  /** Delete and relist: Nexus deleted the row and its Status is Not listed (set Status to Active to list it again). */
  deleted?: true
  /** New listings: the row (or its family's main row) has Status Not listed, so Publish leaves it out. */
  notListed?: true
}

export interface PublishPlanDestination {
  scope: StudioPublishScope
  /** The resolved destination (account and listing alias) the lifecycle rows run on. */
  destination: ListingActionDestination
  /** "Amazon · IT", "eBay · DE", "Shopify"; an alias adds its name: "eBay · IT · Racing edition". */
  label: string
  /**
   * Aliases in the Publish window (Owner 2026-10-05): the alias's name and place when this destination is an alias
   * (`destination.aliasKey` is its id), null on the main listing — set even when `review` is null.
   */
  aliasLabel?: string | null
  aliasPosition?: number | null
  /**
   * The content review (Partial and Full update rows): exactly what `POST …/studio-publication/preview` returns, made
   * with this destination's Full update rows. Its held rows' changes cannot be ticked (`reason` says why) and its
   * `rows[].blocked` names them. Null when no content goes out here (every row is held) or it could not be made (`error`).
   */
  review: StudioPublishReview | null
  /** The rows reviewed as Full update (stored Action value Full update). */
  fullProductIds: string[]
  /** Rows whose content is held back in this Publish. When every row is held, there is no review. */
  contentHeld: PublishPlanHeldRow[]
  /** One row per waiting Status change or Delete, in the send order. */
  lifecycle: PublishPlanLifecycleRow[]
  /** Waiting values the listing outgrew ("No longer applies"). */
  outgrown: PublishPlanOutgrownRow[]
  /** The destination or its content review could not be read (plain English). Its lifecycle rows can still be sent. */
  error: string | null
}

/** The counts of one Publish, for the summary line (`publishPlanSummary` in publish-actions.ts). */
export interface PublishPlanCounts {
  /** Rows sent as Partial update with at least one ticked field, and those fields. */
  partial: number
  fields: number
  /** Rows sent as Full update. */
  full: number
  delete: number
  /** Resume and Relist. */
  active: number
  /** Pause. */
  inactive: number
  /** End. */
  ended: number
  /** S10 — live Amazon listings moved to their own SKU (create NEW, then delete OLD). Absent when none. */
  moved?: number
}

/** The typed confirmation Ended and Delete rows need. */
export interface PublishPlanConfirm {
  /** What the person types: the family SKU. */
  expected: string
  /** Ended and Delete rows that can be sent (across every destination). */
  rows: number
}

export interface PublishPlan {
  /** The product the studio opened (any member of the family). */
  productId: string
  familyId: string
  familySku: string
  destinations: PublishPlanDestination[]
  /** With the default ticks. The window recounts with `publishPlanCounts` as the person ticks. */
  counts: PublishPlanCounts
  /** The one summary line with the default ticks: "18 partial updates (41 fields) · 2 full updates · 3 inactive · 1 ended". */
  summary: string
  /** Null when no Ended or Delete row can be sent. */
  confirm: PublishPlanConfirm | null
  /** The viewer may end and delete listings (products.delete). Without it, Ended and Delete rows are refused and keep waiting. */
  canDelete: boolean
  readAt: string
}

// ── The send: POST /api/publication-batches with { plan } ───────────────────────────────────────

export interface PublishPlanSubmitDestination {
  scope: StudioPublishScope
  /** This destination's content review (`PublishPlanDestination.review.id`). Leave it out to send no content here. */
  reviewId?: string | null
  /** Amazon and eBay: the token of the person's ticks (`POST …/studio-publication/:reviewId/selection`). */
  selectionToken?: string
  /** Shopify: the overwrite warning was confirmed. */
  confirmOverwrite?: boolean
  /** Shopify: the inventory location. */
  locationId?: string
  /**
   * S10 — this content review moves a live Amazon listing to a new SKU, which deletes the old SKU there once Amazon
   * accepts the new one (`StudioPublishReview.confirm`): the person typed the family SKU (`confirmText`).
   */
  confirmDelete?: boolean
}

export interface PublishPlanSubmit {
  /** The product the plan was made for (any member of the family). */
  productId: string
  /** Every destination with something to send: content (`reviewId`) and/or ticked lifecycle rows. */
  destinations: PublishPlanSubmitDestination[]
  /** The ticked lifecycle row ids, as the plan gave them. Unticked rows are not sent and keep their waiting value. */
  lifecycle: string[]
  /** The plan's "No longer applies" ids: cleared when the batch is queued (only if nobody changed them since the review). */
  outgrown?: string[]
  /** The typed confirmation for Ended and Delete rows, and for a content review that deletes an old SKU: the family SKU. */
  confirmText?: string | null
}

export interface PublishPlanBatchRequest { plan: PublishPlanSubmit }

// ── The batch, read back: GET /api/publication-batches/:id ───────────────────────────────────────

/** A batch child: a content review (studio publication) or one lifecycle change (one destination × one action). */
export type PublishPlanChildKind = 'content' | 'lifecycle'

/**
 * One child of a batch. A lifecycle child's `status` is the listing-action run's: PREVIEW (waiting its turn), RUNNING,
 * DONE, PARTIAL, FAILED, NOT_SENT (refused before sending — `message` says why, e.g. `ROLE_CANNOT_END_OR_DELETE`),
 * UNKNOWN (it stopped before Nexus heard back: `LIFECYCLE_UNKNOWN`) or CANCELLED.
 */
export interface PublishPlanBatchChild extends PublicationBatchChild {
  kind: PublishPlanChildKind
  /** The lifecycle child's action; null for content. */
  action: ListingAction | null
  step: SendStep
  /** A finished lifecycle child's rows (what became of each listing), or null. */
  rows: ListingActionRowResult[] | null
  /** P11 — a lifecycle child's reviewed plan, one row per listing (send / skip / refused, each with its sentence); null for content. */
  planRows?: ListingActionPlanRow[] | null
  /** P11 — how many listing rows a lifecycle child sends (its reviewed plan's); null for content. */
  sendCount?: number | null
  /**
   * One-click O5 — the products list: the family was not reviewed here because it is not listed (Active or Inactive) in
   * that market and no "New listings start as" was chosen. Not a problem; `message` says how to create it.
   */
  notListed?: boolean
  /**
   * One-click O5 — a content review's fields that differ from the channel (DIFFERS and selectable), and how many of them
   * are ticked (Nexus wins: all, unless "Keep channel values" or the person unticked some). Absent for lifecycle children.
   */
  differs?: { total: number; ticked: number }
}

export interface PublishPlanBatchCounts extends PublicationBatchCounts {
  /** Lifecycle children that stopped before Nexus heard back: check them on the channel. */
  unknown: number
}

/**
 * One-click O5 — the options a many-family batch was made with, as the server reads them from its stored request
 * (older batches included), echoed in `PublishPlanBatchView.request.options` so the window shows them after a reload.
 */
export interface ManyBatchOptions {
  /** "Keep channel values": fields that differ on the channel are left out. False = Nexus wins (the default). */
  keepChannelValues: boolean
  /** The Status every listing there is set to, or null. */
  status: ListedStatusTarget | null
  /** The changes are reviewed and sent. */
  content: boolean
  /** "New listings start as", or null (each row's own Status). */
  startAs: StartAsTarget | null
}

export interface PublishPlanBatchView extends PublicationBatchView {
  children: PublishPlanBatchChild[]
  counts: PublishPlanBatchCounts
  /** Step 6 — what a many-family batch was asked to review, with its options (O5). Null for a batch made in the studio. */
  request?: (NonNullable<PublicationBatchView['request']> & { options: ManyBatchOptions }) | null
}

// ── Words ────────────────────────────────────────────────────────────────────────────────────────

export const ROLE_CANNOT_END_OR_DELETE = 'Your role cannot end or delete listings, so this stays waiting.'
export const LIFECYCLE_UNKNOWN = 'This change stopped before Nexus heard back from the channel. Check the listing on the channel before sending it again.'
export const CONTENT_HELD_FOR_RELIST = 'This listing is being relisted (eBay gives it a new item number), so its changes wait for the next Publish.'
export const TYPE_TO_CONFIRM = (expected: string) => `Type ${expected} to end or delete listings.`

// ── Pure helpers ─────────────────────────────────────────────────────────────────────────────────

/** The step one lifecycle action takes in the send order. */
export const lifecycleStep = (action: ListingAction): SendStep => action

/** Does the typed text confirm Ended and Delete? Exact SKU, ignoring surrounding spaces. */
export const confirmMatches = (expected: string, typed: string | null | undefined) =>
  typeof typed === 'string' && typed.trim() === expected.trim() && expected.trim().length > 0

/** The changes a fresh review ticks: selectable and selected by default (photos only on a photos-only review). */
export function defaultReviewTicks(review: Pick<StudioPublishReview, 'changes' | 'photosOnly'> | null | undefined): string[] {
  return (review?.changes ?? []).filter(c => c.selectable && c.selectedByDefault && (!review?.photosOnly || isPhotoChangeId(c.id))).map(c => c.id)
}

/** The lifecycle rows ticked when the window opens. */
export const defaultLifecycleTicks = (plan: Pick<PublishPlan, 'destinations'>): string[] =>
  plan.destinations.flatMap(d => d.lifecycle.filter(row => row.tickedByDefault && !row.refused).map(row => row.id))

/**
 * The counts of one Publish with the person's ticks: `fields` maps a destination's review id to its ticked change ids
 * (absent = the review's default ticks); `lifecycle` is the ticked lifecycle row ids (absent = the default ticks).
 * A refused lifecycle row is never counted.
 */
export function publishPlanCounts(plan: Pick<PublishPlan, 'destinations'>, ticks: { fields?: Record<string, readonly string[]>; lifecycle?: readonly string[] } = {}): PublishPlanCounts {
  const counts: PublishPlanCounts = { partial: 0, fields: 0, full: 0, delete: 0, active: 0, inactive: 0, ended: 0 }
  const lifecycle = new Set(ticks.lifecycle ?? defaultLifecycleTicks(plan))
  for (const destination of plan.destinations) {
    const review = destination.review
    if (review?.id && review.changes) {
      const ticked = new Set(ticks.fields?.[review.id] ?? defaultReviewTicks(review))
      const modeOf = new Map(review.rows.map(row => [row.productId, row.mode ?? 'partial']))
      const partialRows = new Set<string>(), fullRows = new Set<string>(), movedRows = new Set<string>()
      for (const change of review.changes) {
        if (!change.selectable || !ticked.has(change.id)) continue
        if (modeOf.get(change.productId) === 'full') fullRows.add(change.productId)
        // S10 — a moved row is neither a Partial nor a Full update: it is counted as a move.
        else if (modeOf.get(change.productId) === 'move') movedRows.add(change.productId)
        else { partialRows.add(change.productId); counts.fields += 1 }
      }
      counts.partial += partialRows.size
      counts.full += fullRows.size
      if (movedRows.size) counts.moved = (counts.moved ?? 0) + movedRows.size
    }
    for (const row of destination.lifecycle) {
      if (row.refused || !lifecycle.has(row.id)) continue
      if (row.action === 'delete') counts.delete += 1
      else if (row.action === 'resume' || row.action === 'relist') counts.active += 1
      else if (row.action === 'pause') counts.inactive += 1
      else if (row.action === 'end') counts.ended += 1
    }
  }
  return counts
}

/** The ticked lifecycle rows that need the typed confirmation (Ended and Delete). */
export const confirmRowsTicked = (plan: Pick<PublishPlan, 'destinations'>, lifecycle: readonly string[]) => {
  const ticked = new Set(lifecycle)
  return plan.destinations.flatMap(d => d.lifecycle).filter(row => !row.refused && row.needsTypedConfirm && ticked.has(row.id)).length
}

/**
 * Batch or today's direct submit: the batch when more than one destination sends, a lifecycle row is ticked, or a
 * value the listing outgrew is cleared; one destination with content only keeps the direct submit.
 */
export function publishPlanUsesBatch(plan: Pick<PublishPlan, 'destinations'>, sending: { destinations: number; lifecycle: readonly string[] }): boolean {
  return sending.destinations > 1 || sending.lifecycle.length > 0 || plan.destinations.some(d => d.outgrown.length > 0)
}

// ── P11: many products × markets (the products list's Publish… window) ────────────────────────────

/** What the many-product window does on every chosen product × market: send the changes, or set one Status. No Delete. */
export type ManyPublishAction = 'content' | ListedStatusTarget
export const MANY_PUBLISH_ACTIONS: readonly ManyPublishAction[] = ['content', 'active', 'inactive', 'ended']
/** A Status target of a listing ON the channel (Not listed is only a new row's choice). */
export type ListedStatusTarget = Exclude<StatusTarget, 'not_listed'>
export const MANY_PUBLISH_ACTION_LABEL: Readonly<Record<ManyPublishAction, string>> = {
  content: 'Send changes', active: 'Set Active', inactive: 'Set Inactive', ended: 'Set Ended',
}

/**
 * The listing actions that bring listings to a Status target ('active': Relist an ended listing, Resume an inactive
 * one). The first is the one a product × market records when none of its listings needs a change (it shows why).
 */
export const STATUS_TARGET_ACTIONS: Readonly<Record<ListedStatusTarget, readonly ListingAction[]>> = {
  active: ['resume', 'relist'], inactive: ['pause'], ended: ['end'],
}

/** `POST /api/publication-batches` from the products list: products (a variation means its family) × destinations. */
export interface ManyPublishRequest {
  /** At most 200; at most 1,000 product × market reviews. */
  productIds: string[]
  /** At most `MAX_PLAN_DESTINATIONS`. */
  destinations: Array<Pick<StudioPublishScope, 'channel' | 'marketplace' | 'accountId'>>
  options?: {
    /**
     * Content: whether Publish replaces the values that differ on the channel (changed there, changed on both sides, or
     * never published from Nexus). Default true = Nexus wins; false = Keep channel values (the same as
     * `keepChannelValues: true`).
     */
    replaceDiffers?: boolean
    /**
     * One-click O5 — "Keep channel values": leave the fields that differ on the channel out. Default false = Nexus wins.
     * When both are sent, this one decides.
     */
    keepChannelValues?: boolean
    /** Set every listing there to this Status, where allowed. Ended needs products.delete. */
    status?: ListedStatusTarget | null
    /**
     * New listings (ND4 B, Owner 2026-10-04) — "New listings start as": the Status the changes create every listing not on
     * the channel yet with (Active, or Inactive: Amazon without this market's offer, eBay at quantity 0 with stock sync
     * held, Shopify a Draft product), per the channel's rules (refused with the reason). A row someone set Not listed stays
     * out. Only with the changes (`content`). Absent: each row's own Status, else the channel's default.
     */
    startAs?: StartAsTarget | null
    /** Also review and send the changes. Default: true without a Status, false with one; never with Ended. */
    content?: boolean
  }
}

/** `POST /api/publication-batches/:id/submit` — send what the batch reviewed. */
export interface ManySubmitRequest {
  /** Shopify: review ids whose overwrite warning was confirmed. */
  confirmOverwrite?: string[]
  /** Shopify: account id → inventory location. */
  shopifyLocations?: Record<string, string>
  /** Ended: the typed count of listings it ends (`manyEndCount`), e.g. "36". */
  confirmText?: string | null
}

/** ND4 B — "New listings start as": Active or Inactive (`ManyPublishRequest.options.startAs`). */
export type StartAsTarget = 'active' | 'inactive'
export const START_AS_TARGETS: readonly StartAsTarget[] = ['active', 'inactive']
export const START_AS_LABEL = 'New listings start as'
export const START_AS_WORD: Readonly<Record<StartAsTarget, string>> = { active: 'Active', inactive: 'Inactive' }
export const START_AS_HINT: Readonly<Record<StartAsTarget, string>> = {
  active: 'Every listing these changes create sells at once.',
  inactive: 'Every listing these changes create waits, not selling: Amazon without this market\'s offer, eBay at quantity 0 (its out-of-stock option must be on), Shopify as a Draft product. Set Active and Publish when you are ready.',
}
export const START_AS_NEEDS_CONTENT = 'New listings start as applies to the listings the changes create. Choose Send changes too.'
export const isStartAsTarget = (value: unknown): value is StartAsTarget => value === 'active' || value === 'inactive'

/** One row a content review creates and how it starts (`PublicationBatchChild.creates`, the review's `rows[].startsAs`). */
export interface PublishCreateRow { productId: string; sku: string; startsAs: StartAsTarget }

/** "Creates GALE-M (inactive)." / "Creates GALE-M, GALE-L (inactive) and 4 more." — null when nothing is created. */
export function createsSentence(rows: readonly Pick<PublishCreateRow, 'sku' | 'startsAs'>[]): string | null {
  if (!rows.length) return null
  const shown = rows.slice(0, 3).map(row => `${row.sku} (${row.startsAs})`)
  const more = rows.length - shown.length
  return `Creates ${shown.join(', ')}${more ? ` and ${more.toLocaleString('en')} more` : ''}.`
}

export const MANY_ENDED_WITH_CONTENT = 'A listing being ended gets no changes. Choose Send changes or Set Ended, not both.'
export const MANY_ROLE_CANNOT_END = 'Your role cannot end listings (it needs permission to delete products). Nothing was sent.'
/** "Type 36 to end 36 listings." */
export const TYPE_COUNT_TO_END = (count: number) => `Type ${count} to end ${count} ${count === 1 ? 'listing' : 'listings'}.`

/** Does the typed text confirm ending `count` listings? The exact number, ignoring surrounding spaces. */
export const confirmCountMatches = (count: number, typed: string | null | undefined) =>
  count > 0 && typeof typed === 'string' && typed.trim() === String(count)

/**
 * The listings a reviewed many-product batch would end: the rows to send of every End child still waiting. The typed
 * confirmation is this number, on the web and on the server alike.
 */
export function manyEndCount(children: ReadonlyArray<Pick<PublishPlanBatchChild, 'kind' | 'status' | 'action' | 'sendCount'>>): number {
  return children.filter(c => c.kind === 'lifecycle' && c.status === 'PREVIEW' && c.action === 'end').reduce((n, c) => n + Math.max(0, c.sendCount ?? 0), 0)
}
