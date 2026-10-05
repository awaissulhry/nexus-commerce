/**
 * Sheet publish parity, step 4 (docs/sheet-publish-parity/PLAN.md, item 4) — the publish history's wire contract.
 *
 * One history, many sources: product sheet publications today, the old flat-file uploads and the photo runs next
 * (the Owner's D1 = A: the old pages still publish, so a history without them must say so — `coverage`).
 *
 * Vocabulary: `status` is the source's own raw status (for a product sheet publication, the publish status the design
 * system's `publishStatus.ts` labels). `state` is the plain group a list filters by. A product inside a run carries a
 * per-SKU `result` from the same design-system table (`PUBLISH_RESULT_STATUSES`). The server never invents a result:
 * what the channel has not said is WAITING or UNKNOWN, never a success.
 *
 * Build shape v2 (P7): a fifth source, `listing-action` — the selling changes the listing-action engine runs (Pause
 * offer, Resume offer, End listing, Relist, Delete listing; apps/api/src/services/listings/listing-action.service.ts).
 * One Publish that sends content AND selling changes is a publication batch: the history shows it as ONE run (id
 * `listing-action:batch:<batchId>`, `kinds` = every change inside it) whose detail lists its parts (`children`).
 */
import { LISTING_ACTION_LABEL, type ListingAction } from './listing-actions.js'
import type { StudioChannelIssue, StudioPublishChange } from './studio-publication.js'

export const HISTORY_SOURCES = ['studio', 'listing-action', 'amazon-flat-file', 'ebay-flat-file', 'photos'] as const
export type HistorySource = (typeof HISTORY_SOURCES)[number]

/**
 * The plain group a run belongs to.
 * - `in_progress`: Nexus or the channel is still working, and Nexus will look again by itself.
 * - `needs_check`: nobody will look again by itself (no answer, or the checks gave up). A run a person marked as
 *   checked (D3) STAYS here — its result is still unknown — with `checkedAt` / `checkedBy` set and `needsCheck` false.
 */
export const HISTORY_STATES = ['in_progress', 'succeeded', 'partial', 'failed', 'needs_check'] as const
export type HistoryState = (typeof HISTORY_STATES)[number]

/**
 * What a run (or one part of a run) changed.
 * - `update`: today's Publish — only the changed fields (Partial update). `full_update`: every field Nexus manages was
 *   sent again (the sheet's Action column, Full update). `create`: a new listing. `photos`: photos only.
 * - `pause` / `resume` / `end` / `relist` / `delete`: a selling change (`LISTING_ACTION_LABEL` names them: Pause offer,
 *   Resume offer, End listing, Relist, Delete listing).
 */
export const HISTORY_KINDS = ['update', 'create', 'full_update', 'photos', 'pause', 'resume', 'end', 'relist', 'delete'] as const
export type HistoryKind = (typeof HISTORY_KINDS)[number]

/** The order one Publish sends its parts in (build shape v2): Resume/Relist → content → Inactive → Ended → Delete. */
export const HISTORY_SEND_ORDER: readonly HistoryKind[] = ['resume', 'relist', 'create', 'full_update', 'update', 'photos', 'pause', 'end', 'delete']

/**
 * The sheet's "Last publish" column (GET …/studio-publication-status): what the row's newest publish was, so the card
 * can be titled "Pause offer · Accepted · 10:42 · Awais". `publish` = a content publish (Partial update, or a new
 * listing); `full_update` = the row was sent as a Full update; the rest are selling changes.
 */
export type LastPublishKind = 'publish' | 'full_update' | ListingAction
export const LAST_PUBLISH_KIND_LABEL: Readonly<Record<LastPublishKind, string>> = { publish: 'Publish', full_update: 'Full update', ...LISTING_ACTION_LABEL }

/**
 * The history's "What" filter: four groups that together hold every kind exactly once. A run of several parts (one
 * Publish) matches a group when ANY of its parts does.
 */
export const HISTORY_WHAT = ['updates', 'selling', 'deletes', 'photos'] as const
export type HistoryWhat = (typeof HISTORY_WHAT)[number]
export const HISTORY_WHAT_LABEL: Readonly<Record<HistoryWhat, string>> = { updates: 'Updates', selling: 'Selling changes', deletes: 'Deletes', photos: 'Photos' }
export const HISTORY_WHAT_KINDS: Readonly<Record<HistoryWhat, readonly HistoryKind[]>> = {
  updates: ['update', 'create', 'full_update'],
  selling: ['pause', 'resume', 'end', 'relist'],
  deletes: ['delete'],
  photos: ['photos'],
}
/** The group a kind belongs to. */
export const whatOfKind = (kind: HistoryKind): HistoryWhat =>
  HISTORY_WHAT.find(what => HISTORY_WHAT_KINDS[what].includes(kind)) ?? 'updates'
/** Every kind the chosen groups hold; an empty choice = every kind. */
export const kindsOfWhat = (what: readonly HistoryWhat[]): HistoryKind[] =>
  what.length ? HISTORY_KINDS.filter(kind => what.includes(whatOfKind(kind))) : [...HISTORY_KINDS]

/** Per product. Disjoint: their sum is the run's product count. */
export interface HistoryCounts {
  accepted: number
  verified: number
  failed: number
  waiting: number
  notSent: number
  skipped: number
  unknown: number
}

export interface HistoryRun {
  /** Product sheet publications keep their own id (the Publish dialog's review id). Other sources: `<source>:<id>`. */
  id: string
  source: HistorySource
  /** One click that made several runs (many markets or many families); null = a run of its own. */
  batchId: string | null
  /** ISO. When the run was sent (else when it was created). The list is newest first by this time. */
  startedAt: string
  /** ISO. When the channel's result was stored; null while there is none (a run marked checked has none either). */
  finishedAt: string | null
  state: HistoryState
  /** The source's own status, as stored. */
  status: string
  kind: HistoryKind
  /**
   * A run of several parts (one Publish with content and selling changes): every kind inside it, in send order
   * (`HISTORY_SEND_ORDER`); `kind` is the first of them. Absent = the run is one change, `kind`.
   */
  kinds?: HistoryKind[]
  /** The family (parent) product; null when the run is not tied to one product family. */
  productId: string | null
  familySku: string | null
  familyTitle: string | null
  channel: string
  marketplace: string | null
  accountId: string | null
  accountLabel: string | null
  /**
   * The listing on that account the run went to, as the studio names it: `''` = the primary listing, any other value =
   * that extra listing. null = the source does not record it (the old flat-file pages and photo runs).
   */
  aliasKey: string | null
  /** null = the primary listing. */
  aliasLabel: string | null
  /** Fields the person chose to send; null = not recorded (a complete listing, or a source that has no fields). */
  fieldCount: number | null
  productCount: number
  counts: HistoryCounts
  userId: string | null
  /** null = not recorded. */
  userName: string | null
  /** Feed id, ItemID or product id on the channel. */
  reference: string | null
  /** The source's own one-line result. */
  message: string | null
  /** ISO. The last time Nexus asked the channel; null = not recorded. */
  lastCheckedAt: string | null
  /** True while a person still has to check it: `state` is `needs_check` and nobody marked it checked yet. */
  needsCheck: boolean
  /** ISO. When a person marked this run as checked; null = not marked. */
  checkedAt: string | null
  /** Who marked it; null = not marked, or not recorded. */
  checkedBy: string | null
}

export interface HistoryCoverage {
  source: HistorySource
  included: boolean
  /** ISO. The oldest run this source can show; null = it has none, or it is not included. */
  since: string | null
  /** Plain words for the reader when something is missing. */
  note: string | null
}

export interface HistoryPage {
  runs: HistoryRun[]
  /** Pass back as `cursor` for the next page; null = this is the last page. */
  nextCursor: string | null
  coverage: HistoryCoverage[]
}

export type HistoryStepKey = 'reviewed' | 'sent' | 'not_sent' | 'received' | 'waiting' | 'processed' | 'verified' | 'unknown' | 'needs_check' | 'checked'
  /** S10 — what became of the old SKU of a live Amazon listing this publish moved to a new SKU. */
  | 'old_sku'

export interface HistoryStep {
  key: HistoryStepKey
  label: string
  /** ISO; null = this step has no recorded time (or has not happened yet). */
  at: string | null
  tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger'
  detail: string | null
}

/** Per-SKU result, the design system's `PUBLISH_RESULT_STATUSES`. */
export type HistoryProductResult = 'ACCEPTED' | 'VERIFIED' | 'FAILED' | 'WAITING' | 'NOT_SENT' | 'SKIPPED' | 'UNKNOWN'

export interface HistoryProduct {
  productId: string | null
  /** The identity sent to the channel (an alias may use its own SKU). */
  sku: string
  /** e.g. "Nero · M"; null when the product is not a variation. */
  variationLabel: string | null
  result: HistoryProductResult
  message: string | null
  code: string | null
  /** The first attribute the channel named, as the channel named it. The browser maps it to a sheet column. */
  fieldLabel: string | null
  /** A sheet column key when the server knows it; null = map `fieldLabel` / `issues[].attributeNames` in the browser. */
  columnKey: string | null
  /**
   * Every channel attribute the channel named for this product, as the channel named it, in order and without repeats
   * (the union of `issues[].attributeNames`). The browser maps each to a sheet column; [] = the channel named none.
   */
  columnHint: string[]
  /** The Nexus listing this product's result belongs to; null = not known (an old source that does not record it). */
  listingId: string | null
  /** The listing's id on the channel (ASIN, ItemID…), for a link. */
  externalId: string | null
  /** Field names the publish carried for this product; `['$create']` = a complete new listing; [] = not recorded. */
  sentFields: string[]
  issues: StudioChannelIssue[]
  /** The change rows the person chose for this product (current, last accepted, channel at review time). */
  changes?: StudioPublishChange[]
  /** In a run of several parts: what this product's part changed (absent = the run's `kind`). */
  kind?: HistoryKind
  /** In a run of several parts: the part (a run of `HistoryRunDetail.children`) this result belongs to. */
  runId?: string
}

export interface HistoryRunDetail {
  run: HistoryRun
  steps: HistoryStep[]
  /** Failed first, then not sent, unknown, waiting, then the rest; each group by SKU. */
  products: HistoryProduct[]
  /** True when the exact request is kept: read it per listing from the request route. */
  hasRequest: boolean
  /** The channel's answer as Nexus recorded it; null = none recorded. */
  rawResponse: unknown | null
  /**
   * A run of several parts (one Publish): each part as a run of its own, in send order — a content publication per
   * destination (open it by its own id for its fields and request) and a selling change per family and destination.
   * Absent = the run has no parts.
   */
  children?: HistoryRun[]
  /**
   * S10 — the live Amazon listings this publish moved to a new SKU (create NEW, then delete OLD), and what became of each
   * OLD. Absent when the publish moved none.
   */
  skuMoves?: HistorySkuMove[]
}

/** S10 — one move of a publish, as the history shows it. */
export interface HistorySkuMove {
  productId: string
  /** The SKU Amazon held (deleted once Amazon accepted NEW). */
  from: string
  /** The listing's own SKU, created as a new offer. */
  to: string
  /**
   * `deleted`, `kept` (Amazon refused NEW: OLD stays, nothing deleted), `shared` (another listing still sells OLD),
   * `not-sent` (Amazon writes in preview mode), `failed` (Amazon did not confirm the delete yet), `pending` (Amazon has not
   * answered about NEW yet).
   */
  state: 'deleted' | 'kept' | 'shared' | 'not-sent' | 'failed' | 'pending'
  /** The sentence the result shows for it; null while pending. */
  message: string | null
  /** The publish offers "Delete the old SKU again" (`DELETE_OLD_SKU_AGAIN`, `POST …/studio-publication/:id/delete-old-sku`). */
  canDeleteAgain: boolean
}

/**
 * The query a list accepts (all optional). Dates are ISO; `cursor` comes from `HistoryPage.nextCursor`.
 * `checked`: false = leave out runs a person marked as checked; true = only those runs; absent = both.
 */
export interface HistoryQuery {
  channel?: string
  marketplace?: string
  accountId?: string
  state?: HistoryState[]
  source?: HistorySource[]
  /** The "What" filter (`what=updates,selling`): runs with at least one part in a chosen group. */
  what?: HistoryWhat[]
  productId?: string
  userId?: string
  from?: string
  to?: string
  q?: string
  checked?: boolean
  cursor?: string
  limit?: number
}

/** The window `doneLast7Days` uses: runs STARTED in the last 7 days, like the list's Started filter. */
export const HISTORY_RECENT_DAYS = 7

/**
 * Exact run counts for the same filters as a list (`state`, `checked`, `cursor` and `limit` are ignored). Each count
 * equals the length of the list a filter tile opens:
 * - `needsAttention` = the list with state failed,partial,needs_check and checked=false;
 * - `inProgress` = state in_progress;
 * - `doneLast7Days` = state succeeded,partial,failed and from = `recentSince`.
 */
export interface HistoryTotals {
  total: number
  byState: Record<HistoryState, number>
  /** Failed, partly failed or result unknown, leaving out the runs a person already marked as checked. */
  needsAttention: number
  inProgress: number
  /** Finished with a result (succeeded, partial or failed) and started on or after `recentSince`. */
  doneLast7Days: number
  /** ISO. The start of the `doneLast7Days` window (now − HISTORY_RECENT_DAYS days). */
  recentSince: string
  /** Runs whose result is unknown that a person marked as checked (all are in `byState.needs_check`). */
  checked: number
}
