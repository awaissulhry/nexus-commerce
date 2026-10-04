/**
 * Sheet publish parity, build shape v2 (Owner 2026-10-04) — the two values a listing row can WAIT with until Publish.
 *
 * Every channel scope of the product sheet has two columns, one value per market:
 *  - **Action** — what Publish sends: **Partial update** (the default, never stored: today's Publish, only the changed
 *    fields, field ticks), **Full update** (every field Nexus manages again; the review lists what it would remove on
 *    the channel), **Delete** (remove the listing from the channel; Nexus forgets its channel number). Nothing else.
 *  - **Status** — the ONE control for "is it on this market": **Active**, **Inactive**, **Ended** (eBay, Shopify), and
 *    on a row not on the channel **Not listed** (`listing-actions.ts`).
 * The selection bar's **Action ▾** button fills either column for many rows. Nothing is sent until Publish; the review
 * lists every waiting value, and one Publish sends them in a fixed order (`SEND_ORDER`).
 *
 * Pure and shared by the API and the web: the options of a row, paste parsing, the words, the waiting summary, the
 * stale rule and the send order. Price, stock and fulfilment never travel with Publish (D7 A) — Full update included.
 *
 * New listings (Owner 2026-10-04): a row NOT on the channel (Draft, no listing in this destination — its cell then has
 * a `new:` listing id, `newRowId` — or deleted by Nexus) chooses Active / Inactive / Not listed in the Status column
 * (`PublishActionCell.create`); its Action reads **Full update** (a create always sends the whole listing; Partial
 * update and Delete are held with their reasons). A Status choice on a row with no listing first starts the drafts of
 * the whole family on the sheet's own account (`PublishActionWriteResult.started`); the Shared scope never does.
 *
 * Simplify (Owner 2026-10-04): a row Nexus deleted is such a row — Status Not listed by default, Active or Inactive lists
 * it again on the next Publish. There is no "Deleted", "Keep deleted" or "Create" Action value.
 */
import type { CapabilityFacts, FbaUnits, ListingAction, ListingDeletion, ListingModel, NewListingSource, NewListingTarget, SellingState, StatusTarget } from './listing-actions.js'
import { agoText, ALREADY_DELETED, deleteOffered, fbaUnitTotal, isNewListingRow, STATUS_TARGET_LABEL } from './listing-actions.js'

/** What Publish sends for a row: Partial update, Full update or Delete. A row not on the channel always reads Full update. */
export type SendMode = 'partial' | 'full' | 'delete'
/** The Action values a write may set. */
export const SEND_MODES: readonly SendMode[] = ['partial', 'full', 'delete']
export const SEND_MODE_LABEL: Readonly<Record<SendMode, string>> = { partial: 'Partial update', full: 'Full update', delete: 'Delete' }

/** As stored on `ChannelListing.publishAction` (null = Partial update, the default). */
export type StoredSendMode = 'FULL_UPDATE' | 'DELETE'
/** As stored on `ChannelListing.sellingTarget` (null = no change waiting; NOT_LISTED only on a row not on the channel). */
export type StoredStatusTarget = 'ACTIVE' | 'INACTIVE' | 'ENDED' | 'NOT_LISTED'

export const storedSendMode = (mode: SendMode): StoredSendMode | null => mode === 'full' ? 'FULL_UPDATE' : mode === 'delete' ? 'DELETE' : null
export const sendModeOf = (stored: string | null | undefined): SendMode => stored === 'FULL_UPDATE' ? 'full' : stored === 'DELETE' ? 'delete' : 'partial'
export const storedStatusTarget = (target: StatusTarget | null): StoredStatusTarget | null => target ? target.toUpperCase() as StoredStatusTarget : null
export const statusTargetOf = (stored: string | null | undefined): StatusTarget | null =>
  stored === 'ACTIVE' ? 'active' : stored === 'INACTIVE' ? 'inactive' : stored === 'ENDED' ? 'ended' : stored === 'NOT_LISTED' ? 'not_listed' : null

/** What a row's Action column may offer. */
export interface SendModeOption { mode: SendMode; offered: boolean; reason: string | null; warning: string | null }

export interface SendModeFacts extends CapabilityFacts {
  /** The row is the main product of a family (eBay and Shopify change whole listings from it). */
  isParent: boolean
  /** The row is a variation (a child of a family). */
  isVariation: boolean
}

export const FULL_NEW_LISTING = 'A new listing is always sent whole: Partial update creates it.'
/** A row not on the channel (new or deleted): its Action reads Full update, with this hint; Partial update is held with it. */
export const NEW_LISTING_SENT_WHOLE = 'A new listing is always sent whole.'
/** New listings: Delete on a row not on the channel. */
export const NOTHING_TO_DELETE_YET = 'Nothing to delete yet. To leave it out, set Status to Not listed.'
export const FULL_EBAY_VARIATION = 'eBay changes a whole listing. Choose Full update on the main row.'
export const DELETE_EBAY_VARIATION = 'eBay changes a whole listing. Choose Delete on the main row.'
export const FULL_EBAY_INVENTORY_LATER = 'Full update for eBay Inventory listings comes later. Partial update works.'
export const SHOPIFY_EXISTING_NOT_YET = 'Nexus cannot update an existing Shopify product yet. Its status can change in the Status column.'
export const SHOPIFY_VARIATION_PRODUCT = 'Shopify changes the whole product. Choose it on the main row.'
export const ENDED_FIRST = 'Ended on the channel. Set Active to relist it first.'
export const FULL_WARNING = 'Every field Nexus manages is sent again. The review lists what the channel holds that Nexus does not; those values are removed.'

/**
 * The Action column's options for one row: Partial is always there (it is the default); Full and Delete by rule. A row
 * not on the channel (new, or deleted by Nexus) reads **Full update** — a create always sends the whole listing — with
 * Partial update and Delete held with their reasons (its Status says whether Publish creates it).
 */
export function sendModeOptions(model: ListingModel, state: SellingState, facts: SendModeFacts, channelLabel?: string): SendModeOption[] {
  const option = (mode: SendMode, reason: string | null, warning: string | null = null): SendModeOption => ({ mode, offered: !reason, reason, warning })
  if (isNewListingRow(state, facts)) return [option('partial', NEW_LISTING_SENT_WHOLE), option('full', null, NEW_LISTING_SENT_WHOLE),
    option('delete', facts.deleted ? ALREADY_DELETED(facts.deleted.where) : NOTHING_TO_DELETE_YET)]
  const notOnChannel = state === 'draft' || state === 'not_listed'
  const full = (): string | null => {
    if (notOnChannel) return FULL_NEW_LISTING
    if (state === 'ended') return ENDED_FIRST
    switch (model) {
      case 'amazon': return null
      case 'ebay-trading': return facts.isVariation ? FULL_EBAY_VARIATION : null
      case 'ebay-inventory': return FULL_EBAY_INVENTORY_LATER
      case 'shopify': return SHOPIFY_EXISTING_NOT_YET
      default: return `Publishing to ${channelLabel ?? 'this channel'} from the product sheet is not available yet.`
    }
  }
  const remove = (): SendModeOption => {
    if ((model === 'ebay-trading' || model === 'ebay-inventory') && facts.isVariation) return option('delete', DELETE_EBAY_VARIATION)
    if (model === 'shopify' && facts.isVariation) return option('delete', SHOPIFY_VARIATION_PRODUCT)
    const capability = deleteOffered(state, model, facts, channelLabel)
    // An FBA offer may be deleted, with its warning (the review adds Amazon's unit count).
    return capability.offered ? option('delete', null, capability.warning) : option('delete', capability.reason ?? 'Not available here.')
  }
  const fullReason = full()
  return [option('partial', null), option('full', fullReason, fullReason ? null : FULL_WARNING), remove()]
}

// ── Paste and fill ────────────────────────────────────────────────────────────────────────────────

const words = (text: string) => text.trim().toLowerCase().replace(/[\s_-]+/g, ' ')

/** A pasted or typed Action value: "Partial update", "partial", "partial_update", "Full", "Delete". Null = not a value. */
export function parseSendMode(text: string): SendMode | null {
  const w = words(text)
  if (['partial update', 'partial', 'update partial'].includes(w)) return 'partial'
  if (['full update', 'full', 'update', 'update full'].includes(w)) return 'full'
  if (['delete', 'remove', 'delete listing'].includes(w)) return 'delete'
  return null
}

/** A pasted or typed Status value: "Active", "Inactive", "Ended" (and the verbs that mean them). Null = not a value. */
export function parseStatusTarget(text: string): StatusTarget | null {
  const w = words(text)
  if (['active', 'live', 'resume', 'resume offer', 'relist'].includes(w)) return 'active'
  if (['inactive', 'paused', 'pause', 'pause offer'].includes(w)) return 'inactive'
  if (['ended', 'end', 'end listing'].includes(w)) return 'ended'
  if (['not listed', 'notlisted', 'leave out', 'left out', 'not on channel'].includes(w)) return 'not_listed'
  return null
}

// ── Waiting values: who, when, and the stale rule ───────────────────────────────────────────────

/** One waiting value as the sheet and the review read it. */
export interface WaitingValue {
  kind: 'send' | 'status'
  /** `SendMode` ('full' | 'delete') or `StatusTarget`. */
  value: SendMode | StatusTarget
  setAt: string
  setById: string | null
  setByName: string | null
}

/** A value set by someone else, or more than a day ago, starts UNticked in the review (Owner's safety rule 3). */
export const STALE_AFTER_MS = 24 * 60 * 60_000
export function isStaleWaiting(value: Pick<WaitingValue, 'setAt' | 'setById'>, viewerId: string | null, now: number = Date.now()): boolean {
  const at = Date.parse(value.setAt)
  return !Number.isFinite(at) || now - at > STALE_AFTER_MS || (value.setById ?? null) !== (viewerId ?? null)
}

/** Ended and Delete need the publisher's own typed confirmation and `products.delete`. */
export const needsTypedConfirm = (value: Pick<WaitingValue, 'kind' | 'value'>) =>
  (value.kind === 'send' && value.value === 'delete') || (value.kind === 'status' && value.value === 'ended')

export interface WaitingCounts { full: number; delete: number; active: number; inactive: number; ended: number }
export const EMPTY_WAITING: WaitingCounts = Object.freeze({ full: 0, delete: 0, active: 0, inactive: 0, ended: 0 }) as WaitingCounts

export function countWaiting(values: Iterable<Pick<WaitingValue, 'kind' | 'value'>>): WaitingCounts {
  const counts = { ...EMPTY_WAITING }
  for (const v of values) {
    if (v.kind === 'send' && (v.value === 'full' || v.value === 'delete')) counts[v.value] += 1
    if (v.kind === 'status' && (v.value === 'active' || v.value === 'inactive' || v.value === 'ended')) counts[v.value] += 1
  }
  return counts
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en')} ${n === 1 ? one : many}`

/** The toolbar mark: "4 waiting for Publish" and its detail "2 inactive · 1 ended · 1 full update". Null when none. */
export function waitingMark(counts: WaitingCounts): { label: string; detail: string; danger: boolean } | null {
  const total = counts.full + counts.delete + counts.active + counts.inactive + counts.ended
  if (!total) return null
  const detail = [
    counts.active ? `${counts.active.toLocaleString('en')} ${STATUS_TARGET_LABEL.active.toLowerCase()}` : null,
    counts.inactive ? `${counts.inactive.toLocaleString('en')} ${STATUS_TARGET_LABEL.inactive.toLowerCase()}` : null,
    counts.ended ? `${counts.ended.toLocaleString('en')} ${STATUS_TARGET_LABEL.ended.toLowerCase()}` : null,
    counts.full ? plural(counts.full, 'full update', 'full updates') : null,
    counts.delete ? plural(counts.delete, 'delete', 'deletes') : null,
  ].filter(Boolean).join(' · ')
  return { label: `${total.toLocaleString('en')} waiting for Publish`, detail, danger: counts.delete > 0 || counts.ended > 0 }
}

// ── The send order of one Publish ────────────────────────────────────────────────────────────────

/**
 * One Publish sends, per channel account: Resume and Relist first (a listing must sell again before it is updated),
 * then the content (Partial and Full updates), then Pause, then End, then Delete (Amazon variations before their main
 * product). A row set to Ended or Delete gets no content: the review says why.
 */
export type SendStep = 'resume' | 'relist' | 'content' | 'pause' | 'end' | 'delete'
export const SEND_ORDER: readonly SendStep[] = ['resume', 'relist', 'content', 'pause', 'end', 'delete']
export const sendStepOf = (action: ListingAction | 'content'): SendStep => action

/** Does this row's content go out in this Publish? Not when it is being ended or deleted. */
export function contentGoesOut(mode: SendMode, statusAction: ListingAction | null): boolean {
  return mode !== 'delete' && statusAction !== 'end'
}

export const CONTENT_HELD_FOR_END = 'This listing is being ended, so its changes are not sent. Relist it to send them.'
export const CONTENT_HELD_FOR_DELETE = 'This listing is being deleted, so its changes are not sent.'

/** The review's one summary line: "18 partial updates (41 fields) · 2 full updates · 3 inactive · 1 ended · 1 delete". */
export function publishPlanSummary(plan: { partial: number; fields: number; full: number; delete: number; active: number; inactive: number; ended: number }): string {
  return [
    plan.partial ? `${plural(plan.partial, 'partial update', 'partial updates')}${plan.fields ? ` (${plural(plan.fields, 'field', 'fields')})` : ''}` : null,
    plan.full ? plural(plan.full, 'full update', 'full updates') : null,
    plan.active ? `${plan.active.toLocaleString('en')} active` : null,
    plan.inactive ? `${plan.inactive.toLocaleString('en')} inactive` : null,
    plan.ended ? `${plan.ended.toLocaleString('en')} ended` : null,
    plan.delete ? plural(plan.delete, 'delete', 'deletes') : null,
  ].filter(Boolean).join(' · ')
}

// ── The wire shapes of the waiting values (API ↔ web) ────────────────────────────────────────────

/** One listing row's waiting values, as `GET /api/products/:id/studio/publish-actions` returns them. */
export interface PublishActionCell {
  listingId: string
  productId: string
  sku: string
  channel: string
  marketplace: string
  accountId: string
  aliasKey: string
  /** The live selling state Nexus holds (no channel call). */
  state: SellingState
  stateReason: string | null
  /** `noLongerApplies`: a waiting value the listing has outgrown (already inactive, ended on eBay, …) says why, or null. */
  send: { mode: SendMode; setAt: string | null; setById: string | null; setByName: string | null; noLongerApplies: string | null }
  status: { target: StatusTarget | null; setAt: string | null; setById: string | null; setByName: string | null; noLongerApplies: string | null }
  /**
   * Delete and relist (Owner 2026-10-04): Nexus deleted this listing from the channel and it is not listed again yet;
   * null otherwise. Such a row is a row NOT on the channel (`create` is set; Status reads Not listed by default and
   * `stateReason` says "Deleted on Amazon · IT on 4 Oct. …"). The API always sends it; absent reads as null.
   */
  deleted?: PublishActionDeleted | null
  /**
   * New listings (Owner 2026-10-04): a row NOT on the channel (Draft, no listing here — `listingId` is then a `new:` id,
   * `newRowId` — or deleted by Nexus): what Publish does with it. Null on every other row. The Status column shows
   * `create.target` (the row's own choice is also `status.target`, with who and when); the Action column reads Full
   * update (`send.mode` 'full'; `send.setAt` is null unless a value is stored). The API always sends it; absent = null.
   */
  create?: PublishActionCreate | null
  /** What the row may choose now. On a row not on the channel: Active, Inactive, Not listed (Status); Full update (Action). */
  sendOptions: SendModeOption[]
  statusOptions: Array<{ target: StatusTarget; offered: boolean; action: ListingAction | null; reason: string | null; warning: string | null; checkedAtSend: string | null
    /** New listings: what this choice makes Publish do (the option's tooltip). */
    sentence?: string | null }>
}

/** New listings: what Publish does with a row not on the channel (`PublishActionCell.create`; a deleted row is one too). */
export interface PublishActionCreate {
  /** Creates it selling ('active'), creates it without selling ('inactive'), or leaves it out ('not_listed'). */
  target: NewListingTarget
  /** This row's own choice (also `status.target`), the main row's (a variation without its own follows it), or the default. */
  source: NewListingSource
  /**
   * What a row nobody chose for gets (ND2 A: Amazon and eBay Active, Shopify Inactive, a variation with no listing here
   * Not listed; a row Nexus deleted: Not listed).
   */
  defaultTarget: NewListingTarget
  /** No listing record here yet: the first Status choice starts the drafts of the whole family on this sheet's account. */
  noRecord: boolean
  /** The cell's sentence: what Publish does, and where the choice comes from. */
  sentence: string
}

// ── New listings: rows with no listing record yet ────────────────────────────────────────────────

/** A row with no listing in a destination (`PublishActionCell.listingId` of such a cell). */
export interface NewRowRef { productId: string; channel: string; marketplace: string; accountId: string; aliasKey: string }

/** The id the read gives a family member with no listing in a destination; a write sends it back as a listing id. */
export const newRowId = (row: NewRowRef) => `new:${row.productId}:${row.channel}:${row.marketplace}:${row.accountId}:${row.aliasKey}`

/** The row a `new:` id names, or null when the id is not one. */
export function parseNewRowId(id: unknown): NewRowRef | null {
  if (typeof id !== 'string' || !id.startsWith('new:') || id.length > 600) return null
  const parts = id.slice(4).split(':')
  if (parts.length !== 5) return null
  const [productId, channel, marketplace, accountId, aliasKey] = parts
  if (!productId || !channel || !marketplace || !accountId) return null
  return { productId, channel, marketplace, accountId, aliasKey }
}

export const isNewRowId = (id: unknown) => parseNewRowId(id) !== null

/** One write: set or clear one column on many rows. `expected` is the compare-and-set guard (the setAt the client saw). */
export type PublishActionChange =
  | { column: 'send'; mode: SendMode }
  | { column: 'status'; target: StatusTarget | null }

export interface PublishActionWrite {
  /** The rows to change. Shared scope: leave it out and set `allCoordinates` — every market of the product, where allowed
   *  (the Shared scope also sets `allCoordinates` beside its own `listingIds`: a deleted market is refused there). */
  listingIds?: string[]
  allCoordinates?: boolean
  change: PublishActionChange
  /** listingId → the `setAt` of that column the client last saw (null = none). A different stored value is a conflict. */
  expected?: Record<string, string | null>
}

export interface PublishActionWriteResult {
  applied: string[]
  /** Rows this value is not allowed on, with the reason ("Inactive set on 18 rows. 3 not allowed: …"). */
  refused: Array<{ listingId: string; sku: string; reason: string }>
  /** Rows someone else changed since the client read them. */
  conflicts: Array<{ listingId: string; sku: string; setByName: string | null; setAt: string | null }>
  /**
   * New listings: the drafts this write started (a Status choice on a row with no listing here starts the whole family on
   * the sheet's own account): "Started Amazon · IT for GALE and 6 variations." `rows` maps each chosen `new:` id to the
   * listing it now is. Null when nothing was started. The API always sends it; absent reads as null.
   */
  started?: PublishActionStarted | null
  /** The Shared scope never starts a listing: the markets it left out, "2 markets without a listing were left out: …". */
  leftOut?: { count: number; sentence: string } | null
}

export interface PublishActionStarted {
  sentence: string
  /** Every listing row the write created (the family's drafts). */
  listingIds: string[]
  /** Each chosen `new:` id → the listing id it is now. */
  rows: Array<{ id: string; listingId: string }>
}

/** "Started Amazon · IT for GALE and 6 variations." / "Started eBay · DE for GALE-M." */
export function startedSentence(where: string, created: { mainSku: string | null; variationSkus: string[] }): string {
  const n = created.variationSkus.length
  if (created.mainSku) return `Started ${where} for ${created.mainSku}${n ? ` and ${plural(n, 'variation', 'variations')}` : ''}.`
  if (n <= 3) return `Started ${where} for ${created.variationSkus.join(', ')}.`
  return `Started ${where} for ${plural(n, 'variation', 'variations')}.`
}

/** The Shared scope's note when markets had no listing: "2 markets without a listing were left out: set them in their own sheet." */
export const leftOutSentence = (count: number) =>
  `${plural(count, 'market', 'markets')} without a listing ${count === 1 ? 'was' : 'were'} left out: set ${count === 1 ? 'it' : 'them'} in ${count === 1 ? 'its' : 'their'} own sheet.`

/** The refusal on one Shared-scope row whose market has no listing. */
export const SHARED_NO_LISTING = 'No listing in this market yet: set it in its own sheet.'

/** The toast after a fill: "Inactive set on 18 rows. 3 not allowed: GALE-S (…)…". */
export function fillResultSentence(label: string, result: Pick<PublishActionWriteResult, 'applied' | 'refused' | 'conflicts'> & Partial<Pick<PublishActionWriteResult, 'started' | 'leftOut'>>): string {
  const head = `${label} set on ${plural(result.applied.length, 'row', 'rows')}.`
  const started = result.started ? ` ${result.started.sentence}` : ''
  const leftOut = result.leftOut?.count ? ` ${result.leftOut.sentence}` : ''
  const refusedRows = result.leftOut?.count ? result.refused.filter(r => r.reason !== SHARED_NO_LISTING) : result.refused
  const refused = refusedRows.length ? ` ${refusedRows.length.toLocaleString('en')} not allowed: ${refusedRows.slice(0, 3).map(r => `${r.sku} (${r.reason})`).join('; ')}${refusedRows.length > 3 ? '; …' : ''}.` : ''
  const conflicts = result.conflicts.length ? ` ${plural(result.conflicts.length, 'row was', 'rows were')} changed by someone else first; Nexus kept their value.` : ''
  return head + started + leftOut + refused + conflicts
}

// ── Delete and relist (Owner 2026-10-04; simplified the same day) ────────────────────────────────

/**
 * A row Nexus deleted (`PublishActionCell.deleted`): the delete's facts and the Status cell's short words ("Deleted on
 * Amazon · IT on 4 Oct."). The row is a row not on the channel: its Status (`create`) says whether Publish lists it
 * again (Active, Inactive) or leaves it out (Not listed, the default).
 */
export interface PublishActionDeleted extends ListingDeletion {
  /** "Deleted on Amazon · IT on 4 Oct." */
  sentence: string
}

/**
 * OLDER STORED VALUE (the first delete-and-relist build): is a stored Action value a choice made on this row after its
 * delete (Partial update — null with a time — or Full update)? Such a value is read as Status Active.
 */
export function isRelistChoice(stored: { value: string | null; at: Date | string | null }, deletedAt: string): boolean {
  if (!stored.at || stored.value === 'DELETE') return false
  const at = new Date(stored.at).getTime(), deleted = Date.parse(deletedAt)
  return Number.isFinite(at) && Number.isFinite(deleted) && at > deleted
}

/**
 * The Publish window's line for a row listed again (S4): "Lists GALE-M on ASIN B0NEW (was B0OLD).", "Lists GALE-M again
 * on ASIN B0OLD.", or, when Nexus names no ASIN, "Lists GALE-M again (it was ASIN B0OLD; Amazon matches it by its
 * product ID)." Other channels: "Lists GALE-M again."
 */
export function relistSentence(sku: string, asin: string | null, oldReference: string | null, channel: string): string {
  if (channel !== 'AMAZON') return `Lists ${sku} again.`
  if (asin && oldReference && asin !== oldReference) return `Lists ${sku} on ASIN ${asin} (was ${oldReference}).`
  if (asin) return `Lists ${sku} again on ASIN ${asin}.`
  return oldReference ? `Lists ${sku} again (it was ASIN ${oldReference}; Amazon matches it by its product ID).` : `Lists ${sku} again.`
}

/** Relist on a new ASIN while Amazon holds FBA units of the old one (a warning, not a refusal). */
export function fbaNewAsinWarning(units: FbaUnits, oldAsin: string): string | null {
  const total = fbaUnitTotal(units)
  return total ? `Amazon holds ${total} unit${total === 1 ? '' : 's'} labelled for ${oldAsin}. They cannot sell on the new ASIN; ask Amazon for a removal order.` : null
}

/** The Amazon marketplaces of Pan-European FBA (BE joins from 2027-02-26). */
export const PAN_EU_MARKETS: readonly string[] = ['DE', 'FR', 'IT', 'ES', 'NL']

/** What Nexus knew about a row it listed again on Amazon, to explain Amazon's refusal (S3). */
export interface AmazonRelistContext {
  /** When Amazon accepted the delete (ISO). */
  deletedAt: string
  /** The ASIN the listing had before the delete, or null. */
  oldAsin: string | null
  /** The ASIN this create named (`merchant_suggested_asin`), or null. */
  asin: string | null
}

export const AMAZON_RELIST_TOO_EARLY = (deletedAt: string, now?: number) =>
  `Amazon is still removing this SKU (deleted ${agoText(deletedAt, now)}). Try again later; Amazon can take up to 24 hours.`
export const AMAZON_RELIST_LINKED_ELSEWHERE = (asin: string | null) =>
  `Amazon still links this SKU to ${asin ? `ASIN ${asin}` : 'another ASIN'} in another market. Delete it there first.`
export const AMAZON_RELIST_NO_MATCH = 'Amazon could not match this SKU to a product to list it on. Enter its ASIN (or a barcode) in the product ID cell, then Publish again.'

const ASIN_PATTERN = /\bB0[A-Z0-9]{8}\b/g

/**
 * PURE (S3). Amazon's refusal of a create made after a delete, in plain words — or null when the codes are not about
 * the delete (Amazon's own words then speak alone). 13013: too early; 8005: the SKU is still tied to another ASIN;
 * 8541 / 8542: the same, when Amazon names another ASIN than the one this create asked for (or it moves to a new ASIN);
 * 8560: Amazon found no product to list it on. Callers keep Amazon's words beside the sentence.
 */
export function amazonRelistAnswer(issues: ReadonlyArray<{ code?: string | null; message?: string | null }>, ctx: AmazonRelistContext, now?: number): string | null {
  const code = (wanted: string) => issues.find(issue => String(issue.code ?? '').trim() === wanted)
  if (code('13013')) return AMAZON_RELIST_TOO_EARLY(ctx.deletedAt, now)
  const named = (issue: { message?: string | null } | undefined) => [...String(issue?.message ?? '').matchAll(ASIN_PATTERN)].map(match => match[0])
  const other = (issue: { message?: string | null } | undefined) => named(issue).find(asin => asin !== ctx.asin) ?? null
  const linked = code('8005')
  if (linked) return AMAZON_RELIST_LINKED_ELSEWHERE(other(linked) ?? ctx.oldAsin)
  for (const wanted of ['8541', '8542']) {
    const issue = code(wanted)
    if (!issue) continue
    const elsewhere = other(issue) ?? (ctx.asin && ctx.oldAsin && ctx.asin !== ctx.oldAsin ? ctx.oldAsin : null)
    if (elsewhere) return AMAZON_RELIST_LINKED_ELSEWHERE(elsewhere)
  }
  if (code('8560')) return AMAZON_RELIST_NO_MATCH
  return null
}

/** Amazon's codes in a text such as the validation preview's "GALE-M: 8005: … | 13013: …" (the last code of each part). */
export function amazonIssuesInText(text: string): Array<{ code: string; message: string }> {
  return String(text ?? '').split(' | ').flatMap(part => {
    const last = [...part.matchAll(/(?:^|\s)(\d{4,6}):\s/g)].at(-1)
    return last ? [{ code: last[1], message: part.slice((last.index ?? 0) + last[0].length).trim() }] : []
  })
}

/** "<plain sentence> Amazon said: <Amazon's words>" — or Amazon's words alone when nothing maps. */
export const withAmazonWords = (plain: string | null, amazon: string) => plain ? `${plain} Amazon said: ${amazon}` : amazon

/** One row a publication listed again, as the publication keeps it (`relist` on the stored review). */
export interface PublicationRelistRecord { productId?: string; sku: string; deletedAt: string; oldReference: string | null; asin: string | null }

/**
 * PURE (S3). Amazon's refusal of a create made after a delete, in plain words BESIDE Amazon's own ("Amazon is still
 * removing this SKU (deleted 12 minutes ago)… Amazon said: 13013: …"). `publication` is the stored publication
 * (`{ scope: { channel }, relist }`); only a SKU it listed again on Amazon is explained — `sku` null = its only one, or
 * the one Amazon's words name. Anything else, and codes that are not about the delete, keep Amazon's words alone. The
 * relist keeps waiting (its Action value clears only once Amazon accepts it), so the person can Publish again.
 */
export function explainAmazonRelist(publication: unknown, sku: string | null, issues: ReadonlyArray<{ code?: string | null; message?: string | null }>,
  amazonWords: string, now?: number): string {
  const data = (publication && typeof publication === 'object' ? publication : {}) as { scope?: { channel?: unknown }; relist?: unknown }
  const kept = Array.isArray(data.relist) ? data.relist as PublicationRelistRecord[] : []
  if (data.scope?.channel !== 'AMAZON' || !kept.length) return amazonWords
  const entry = sku ? kept.find(row => row.sku === sku) : kept.length === 1 ? kept[0] : kept.find(row => amazonWords.includes(`${row.sku}:`))
  if (!entry) return amazonWords
  const found = issues.length ? issues : amazonIssuesInText(amazonWords)
  return withAmazonWords(amazonRelistAnswer(found, { deletedAt: entry.deletedAt, oldAsin: entry.oldReference, asin: entry.asin }, now), amazonWords)
}
