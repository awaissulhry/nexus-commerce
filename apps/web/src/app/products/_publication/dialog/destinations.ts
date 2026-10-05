/**
 * Sheet publish parity, step 5 (item 3) — publish one family to several destinations from one dialog.
 *
 * Pure rules for the Publish dialog's destination list: which destinations start ticked, what each ticked destination's
 * review allows (ready, nothing to send, problems, expired…), what the one counted button says, and whether a send
 * takes today's single-destination path or the background batch (`POST /api/publication-batches`). Each destination
 * keeps its OWN review, change plan and ticks; nothing here merges them.
 *
 * One-click publish (Owner 2026-10-04, OD1/OD4 A): the window starts with every market where the family is listed
 * (`listedDestinationKeys`), reviews them one at a time per account (`ReviewQueue`, the sheet's market first), and
 * builds each market's exact request by itself (`requestsDue`); a market whose request cannot be built is skipped with
 * its reason, the others are sent.
 *
 * Aliases (Owner 2026-10-05: "I should be able to publish the aliases as well"): a market's listing aliases (a second,
 * third… listing of the family on the same channel, market and account) are destinations of their own, offered right
 * after their market's main listing (`listedAliases`), keyed by the ALIAS id (`scope.listingId`), and ticked by the same
 * "listed" rule as the main listing. The counts then say "listings" instead of "markets" (`placesWord`).
 */
import { blockingIssues, isPhotoChangeId, type PublicationBatchChild, type PublicationBatchView, type StudioPublishReview, type StudioPublishScope, type StudioPublishSelection } from '@nexus/shared/studio-publication'
import { isNewRowId, type PublishActionCell } from '@nexus/shared/publish-actions'
import type { PublishPlanDestination } from '@nexus/shared/publish-plan'
import { channelLabel, channelPlace } from '@nexus/shared/channel-label'
import { publicationStatusMeta, type PublishStatusMeta } from '@/design-system/grid/renderers/publishStatus'
import type { Tone } from '@/design-system/primitives/tone'
import {
  SELECTED_LISTING_LABEL, matchesPublicationSelection, optionListingLabel, publicationOverwriteAcknowledged, publicationScopeKey,
  type PublicationAlias, type PublicationDestinationOption,
} from './model'

/** The batch route takes at most this many destinations — markets and listing aliases alike (server: `publication-batch.service.ts`). */
export const MAX_BATCH_DESTINATIONS = 25

/** What the dialog holds for one destination. Each one is reviewed only while it is ticked. */
export interface DestinationEntry {
  review: StudioPublishReview | null
  loading: boolean
  error: string | null
  /** The change ids ticked in this destination's own review. */
  selectedIds: string[]
  /** The exact request for `selectedIds` (Amazon and eBay), with its token. */
  selection: StudioPublishSelection | null
  selecting: boolean
  locationId: string
  /** The review whose overwrite warning the person confirmed (Shopify). */
  confirmedReviewId: string | null
  /**
   * Build shape v2 (P10) — this destination's part of the Publish plan (`POST …/studio-publication/plan`): its content
   * review (`review` above is the same object), the waiting Status changes and Deletes, held rows and outgrown values.
   * Null until the plan is read.
   */
  plan: PublishPlanDestination | null
  /** The family SKU the typed confirmation asks for (the plan's `familySku`). */
  familySku: string | null
  /** The viewer may end and delete listings (the plan's `canDelete`). */
  canDelete: boolean
  /** The ticked lifecycle row ids of this destination (the plan's own ids, sent back as given). */
  lifecycleIds: string[]
  /**
   * One-click publish (OD4 A): the exact request for the ticked fields could not be built — the server's words. The
   * market is skipped with this reason until its ticks change or the person tries again; the others are sent.
   */
  selectionError: string | null
  /** When the ticks last changed (ms), 0 as the review gave them: a rebuild of the exact request waits a short pause after it. */
  ticksAt: number
}

export const EMPTY_ENTRY: DestinationEntry = Object.freeze({
  review: null, loading: false, error: null, selectedIds: [], selection: null, selecting: false, locationId: '', confirmedReviewId: null,
  plan: null, familySku: null, canDelete: true, lifecycleIds: [], selectionError: null, ticksAt: 0,
}) as DestinationEntry

/** Amazon and eBay send only the ticked fields; the other channels send the whole product. */
export const isSparse = (review: Pick<StudioPublishReview, 'scope'> | null | undefined) => !!review && ['AMAZON', 'EBAY'].includes(review.scope.channel)

export type DestinationState =
  | { kind: 'not_checked' }
  | { kind: 'checking' }
  | { kind: 'error'; message: string }
  /** An earlier publish to this destination has no answer yet; the server refuses a new one until it has. */
  | { kind: 'earlier'; publicationId: string }
  /** `request`: the exact request could not be built (OD4 A) — the market is skipped, the reason says why. */
  | { kind: 'blocked'; problems: number; reason: string | null; request?: true }
  | { kind: 'expired' }
  | { kind: 'nothing'; reason: 'none' | 'unticked' }
  | { kind: 'input'; needs: 'location' | 'overwrite' }
  | { kind: 'ready'; changes: number; whole: boolean; requestReady: boolean }

/** The ticked fields that still count: selectable in this review (and photos only, on a photos-only review). */
export function tickedChanges(entry: Pick<DestinationEntry, 'review' | 'selectedIds'>): string[] {
  const review = entry.review
  if (!review?.changes) return []
  return review.changes.filter(c => c.selectable && entry.selectedIds.includes(c.id) && (!review.photosOnly || isPhotoChangeId(c.id))).map(c => c.id)
}

/** The fields a fresh review starts with: its own defaults, or — for "Publish failed products again…" — only the given ids. */
export function initialTicks(review: StudioPublishReview, given?: { fieldIds: readonly string[] } | null): string[] {
  const usable = (review.changes ?? []).filter(c => c.selectable && (!review.photosOnly || isPhotoChangeId(c.id)))
  if (given) return usable.filter(c => given.fieldIds.includes(c.id)).map(c => c.id)
  return usable.filter(c => c.selectedByDefault).map(c => c.id)
}

export function destinationState(entry: DestinationEntry, ticked: boolean, now: number = Date.now()): DestinationState {
  if (entry.loading) return { kind: 'checking' }
  if (entry.error) return { kind: 'error', message: entry.error }
  const review = entry.review
  // A plan without a content review: every row's content is held here (only status changes go out), or the content
  // review could not be made (the plan says why; its status changes can still be sent).
  if (!review && entry.plan) return entry.plan.error ? { kind: 'error', message: entry.plan.error } : { kind: 'nothing', reason: 'none' }
  if (!review) return ticked ? { kind: 'checking' } : { kind: 'not_checked' }
  if (review.previousPublicationId) return { kind: 'earlier', publicationId: review.previousPublicationId }
  const blockers = blockingIssues(review.issues, review.photosOnly ? entry.selectedIds : undefined)
  if (blockers.length) return { kind: 'blocked', problems: blockers.length, reason: null }
  if (!review.id) return { kind: 'blocked', problems: 0, reason: 'This review cannot be sent. Its notes say why.' }
  if (Number.isFinite(Date.parse(review.expiresAt)) && Date.parse(review.expiresAt) <= now) return { kind: 'expired' }
  if (isSparse(review)) {
    if (!review.changes) return { kind: 'blocked', problems: 0, reason: 'The review did not list the fields to send. Check again.' }
    const ticks = tickedChanges(entry)
    if (!ticks.length) return { kind: 'nothing', reason: review.changes.some(c => c.selectable) ? 'unticked' : 'none' }
    const requestReady = matchesPublicationSelection(entry.selection, review, ticks)
    if (!requestReady && entry.selectionError) return { kind: 'blocked', problems: 0, reason: requestSkipReason(entry.selectionError), request: true }
    return { kind: 'ready', changes: ticks.length, whole: false, requestReady }
  }
  if (review.locations && !review.locations.some(l => l.id === entry.locationId)) return { kind: 'input', needs: 'location' }
  if (!publicationOverwriteAcknowledged(review, entry.confirmedReviewId)) return { kind: 'input', needs: 'overwrite' }
  return { kind: 'ready', changes: review.rows.length, whole: true, requestReady: true }
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** OD4 A — why a market is skipped when its exact request could not be built: the server's words, and what happens. */
export function requestSkipReason(message: string): string {
  const said = message.trim().replace(/\s*(Review the selection again|Check again)\.?\s*$/i, '')
  return `Skipped: the exact request could not be built.${said ? ` ${/[.!?]$/.test(said) ? said : `${said}.`}` : ''}`
}

/** The words in the destination list's Review column. */
export function destinationStateLabel(state: DestinationState): { label: string; tone: Tone; hint: string } {
  switch (state.kind) {
    case 'not_checked': return { label: 'Not checked yet', tone: 'neutral', hint: 'Tick this destination to review what would be sent.' }
    case 'checking': return { label: 'Checking…', tone: 'info', hint: 'Reading the saved values and the channel.' }
    case 'error': return { label: 'Could not check', tone: 'danger', hint: state.message }
    case 'earlier': return { label: 'Earlier publish waiting', tone: 'warning', hint: 'An earlier publish to this destination has no answer yet. It is not sent again until that publish has a result.' }
    case 'blocked': return state.request
      ? { label: 'Skipped', tone: 'warning', hint: state.reason ?? requestSkipReason('') }
      : state.problems
      ? { label: `Fix ${plural(state.problems, 'problem', 'problems')} first`, tone: 'warning', hint: 'Open the review to see the problems. This destination is skipped until they are fixed.' }
      : { label: 'Cannot be sent', tone: 'warning', hint: state.reason ?? 'Open the review to see why.' }
    case 'expired': return { label: 'Review expired', tone: 'warning', hint: 'Reviews last 15 minutes. Check again to compare the current values.' }
    case 'nothing': return state.reason === 'unticked'
      ? { label: 'No fields ticked', tone: 'neutral', hint: 'Open the review and tick the fields to send.' }
      : { label: 'Nothing to send', tone: 'neutral', hint: 'The channel already has these values.' }
    case 'input': return state.needs === 'location'
      ? { label: 'Choose a location', tone: 'warning', hint: 'Open the review and choose the inventory location.' }
      : { label: 'Confirm the overwrite', tone: 'warning', hint: 'Open the review and confirm that this publish can overwrite channel values.' }
    case 'ready': return state.whole
      ? { label: 'Ready', tone: 'info', hint: 'The whole product will be sent.' }
      : { label: 'Ready', tone: 'info', hint: state.requestReady ? 'The exact request is prepared.' : 'Preparing the exact request…' }
  }
}

/** What one click would do with the ticked destinations. */
export interface PublishPlan {
  /** Ready to send, in list order. */
  send: string[]
  /** Ticked but skipped: problems, an earlier publish still waiting, or a review that could not be read. */
  skipped: string[]
  /** Ticked with nothing to send. */
  nothing: string[]
  /** Ticked and not decided yet (checking, expired, input missing): the button waits. */
  pending: string[]
  /** Sparse destinations whose exact request is not prepared yet. */
  needsRequest: string[]
  /** Fields to send, over the sparse destinations in `send`. */
  changes: number
  /** Destinations that send a whole new product (Shopify). */
  wholeProducts: number
  /** Blocking problems over every ticked destination. */
  problems: number
}

export function publishPlan(ticked: readonly string[], stateOf: (key: string) => DestinationState): PublishPlan {
  const plan: PublishPlan = { send: [], skipped: [], nothing: [], pending: [], needsRequest: [], changes: 0, wholeProducts: 0, problems: 0 }
  for (const key of ticked) {
    const state = stateOf(key)
    if (state.kind === 'ready') {
      plan.send.push(key)
      if (state.whole) plan.wholeProducts++
      else { plan.changes += state.changes; if (!state.requestReady) plan.needsRequest.push(key) }
    } else if (state.kind === 'blocked' || state.kind === 'earlier' || state.kind === 'error') {
      plan.skipped.push(key)
      if (state.kind === 'blocked') plan.problems += state.problems
    } else if (state.kind === 'nothing') plan.nothing.push(key)
    else plan.pending.push(key)
  }
  return plan
}

/** One destination sends through today's path; two or more go to the background batch. */
export type PublishPath = 'none' | 'single' | 'batch'
export const publishPath = (plan: Pick<PublishPlan, 'send'>): PublishPath => plan.send.length === 0 ? 'none' : plan.send.length === 1 ? 'single' : 'batch'

export type PlacesWord = { one: string; many: string }
export const MARKETS_WORD: PlacesWord = Object.freeze({ one: 'market', many: 'markets' })
export const LISTINGS_WORD: PlacesWord = Object.freeze({ one: 'listing', many: 'listings' })
export const DESTINATIONS_WORD: PlacesWord = Object.freeze({ one: 'destination', many: 'destinations' })

/**
 * What the window counts: "listings" when the chosen destinations (`chosen`, by default `keys`) include a listing alias
 * — two listings of one market are not two markets — else "markets" when every destination of `keys` is one channel and
 * account, else "destinations".
 */
export function placesWord(keys: readonly string[], scopeOf: (key: string) => StudioPublishScope | undefined, chosen: readonly string[] = keys): PlacesWord {
  if (chosen.some(key => !!scopeOf(key)?.listingId)) return LISTINGS_WORD
  const scopes = keys.map(scopeOf).filter((s): s is StudioPublishScope => !!s)
  const sameChannel = new Set(scopes.map(s => s.channel)).size <= 1 && new Set(scopes.map(s => s.accountId)).size <= 1
  return sameChannel ? MARKETS_WORD : DESTINATIONS_WORD
}

/** Every destination a plan counts (ticked), in its order. */
const planKeys = (plan: Pick<PublishPlan, 'send' | 'skipped' | 'nothing' | 'pending'>) => [...plan.send, ...plan.skipped, ...plan.nothing, ...plan.pending]

/**
 * The counted primary button: "Publish 21 changes to 2 markets", "… · skip 1 with problems" — "to 3 listings" when an
 * alias is ticked. A Shopify destination sends a whole NEW product (the dialog refuses existing Shopify products), so it
 * is counted as one.
 */
export function publishButtonText(plan: PublishPlan, scopeOf: (key: string) => StudioPublishScope | undefined): string {
  const word = placesWord(plan.send, scopeOf, planKeys(plan))
  const what = [plan.changes ? plural(plan.changes, 'change', 'changes') : null, plan.wholeProducts ? plural(plan.wholeProducts, 'new product', 'new products') : null]
    .filter(Boolean).join(' and ')
  const skip = plan.skipped.length ? ` · skip ${plan.skipped.length} with problems` : ''
  if (!plan.send.length) return plan.skipped.length ? `Nothing to publish · ${plan.skipped.length} with problems` : 'Nothing to publish'
  return `Publish ${what || 'the review'} to ${plural(plan.send.length, word.one, word.many)}${skip}`
}

// ── One-click publish (Owner 2026-10-04) ─────────────────────────────────────────────────────────────────────────────

/** A rebuild of a market's exact request waits this long after its last tick change (the pause restarts with each change). */
export const REQUEST_PAUSE_MS = 600

/**
 * The markets whose exact request (`…/selection`, no channel call) is to be built, and when: an Amazon or eBay market
 * that is ready, whose request is not built for its current ticks, is not being built (one request at a time per
 * market — the server refuses overlaps) and did not just fail for these ticks. At once (`at` 0) when the review just
 * arrived; `pauseMs` after the last tick change otherwise.
 */
export function requestsDue(keys: readonly string[], stateOf: (key: string) => DestinationState, entryOf: (key: string) => DestinationEntry,
  pauseMs: number = REQUEST_PAUSE_MS): Array<{ key: string; at: number }> {
  return keys.flatMap(key => {
    const state = stateOf(key), entry = entryOf(key)
    if (state.kind !== 'ready' || state.whole || state.requestReady || entry.selecting || entry.selectionError) return []
    return [{ key, at: entry.ticksAt ? entry.ticksAt + pauseMs : 0 }]
  })
}

/** A request is still to come for this market (due, or being built): a click on Publish waits for it. */
export function requestOutstanding(state: DestinationState, entry: Pick<DestinationEntry, 'selecting' | 'selectionError'>): boolean {
  return entry.selecting || (state.kind === 'ready' && !state.whole && !state.requestReady && !entry.selectionError)
}

/**
 * The chosen markets still being checked: the review is not in yet, or its FIRST exact request is still being built. A
 * rebuild after a tick change is not counted — the button stays ready and a click waits for it.
 */
export function checkingProgress(keys: readonly string[], stateOf: (key: string) => DestinationState, entryOf: (key: string) => DestinationEntry):
  { checking: number; done: number; total: number } {
  let checking = 0
  for (const key of keys) {
    const state = stateOf(key), entry = entryOf(key)
    if (state.kind === 'checking' || state.kind === 'not_checked' || (!entry.ticksAt && requestOutstanding(state, entry))) checking++
  }
  return { checking, done: keys.length - checking, total: keys.length }
}

/**
 * The button while markets are checked: "Checking 3 of 7 markets…" (the one being checked now), "Checking 2 of 3
 * listings…" when an alias is chosen (`word`), or "Checking…" for one.
 */
export function checkingButtonText(progress: { done: number; total: number }, word: PlacesWord = MARKETS_WORD): string {
  if (progress.total <= 1) return 'Checking…'
  return `Checking ${Math.min(progress.done + 1, progress.total)} of ${progress.total} ${word.many}…`
}

/** "At most 25 markets can be published at once." — "listings" when an alias is chosen: the cap counts every destination. */
export const batchLimitText = (word: PlacesWord = MARKETS_WORD) => `At most ${MAX_BATCH_DESTINATIONS} ${word.many} can be published at once.`

/** One review queue per account: the channel and the account (two Amazon reviews at once were throttled by Amazon). */
export const accountGroup = (scope: Pick<StudioPublishScope, 'channel' | 'accountId'>) => `${scope.channel}|${scope.accountId}`

/**
 * The order the chosen markets ask for their review: the sheet's own market first, then the tab the person opened,
 * then the rest in the market list's order.
 */
export function reviewOrder(keys: readonly string[], first: string | null, shown: string | null): string[] {
  const head = [first, shown].filter((key): key is string => !!key && keys.includes(key))
  return [...new Set([...head, ...keys])]
}

/**
 * One review at a time per account. Each account has its own turn; when a review ends, the next turn goes to the
 * market the person is looking at (`preferred`), else to the next in line. Every `acquire` is paired with one `release`.
 */
export class ReviewQueue {
  private readonly groups = new Map<string, { busy: number; waiting: Array<{ key: string; go(): void }> }>()
  constructor(private readonly preferred: () => string | null = () => null, private readonly perGroup = 1) {}

  acquire(group: string, key: string): Promise<void> {
    const g = this.groups.get(group) ?? { busy: 0, waiting: [] }
    this.groups.set(group, g)
    if (g.busy < this.perGroup) { g.busy++; return Promise.resolve() }
    return new Promise(resolve => g.waiting.push({ key, go: () => { g.busy++; resolve() } }))
  }

  release(group: string): void {
    const g = this.groups.get(group)
    if (!g) return
    g.busy = Math.max(0, g.busy - 1)
    if (!g.waiting.length || g.busy >= this.perGroup) return
    const want = this.preferred()
    const [next] = g.waiting.splice(Math.max(0, g.waiting.findIndex(w => w.key === want)), 1)
    next.go()
  }

  /** The markets waiting for this account's turn, in line (tests). */
  waiting(group: string): string[] { return this.groups.get(group)?.waiting.map(w => w.key) ?? [] }
}

/**
 * OD1 A — where the family counts as listed: the destination's key when the family's main row there is Active or
 * Inactive (Mixed: its variations differ), or when a row not on the channel yet was set Active or Inactive by a person
 * (the new-listings choice). A draft nobody chose for does not count (OD1 B was not chosen). Read from
 * `GET /api/products/:id/studio/publish-actions` with no filter (every listing of the family). The main listing's key is
 * the market's (channel, market, account; no listing); a listing alias's key adds its alias id (`listingId`), and the
 * same rule decides it on its own rows (Owner 2026-10-05). Only an alias the window offers counts (`offeredAliasIds`).
 */
export interface ListedDestinations {
  keys: ReadonlySet<string>
  /** Still reading: the window starts with the sheet's market and adds the others when they arrive. */
  loading: boolean
  /** The read failed: only the sheet's market is chosen, and the window says so. */
  failed?: boolean
  /** The family's listing aliases (`listedAliases`), from the same read: offered after their market's main listing. */
  aliases?: readonly PublicationAlias[]
}

const LISTED_STATES: ReadonlySet<string> = new Set(['active', 'paused', 'mixed'])

/** A destination's key without its listing: the main listing's key. */
export const marketKey = (scope: Pick<StudioPublishScope, 'channel' | 'marketplace' | 'accountId'>) =>
  publicationScopeKey({ channel: scope.channel, marketplace: scope.marketplace, accountId: scope.accountId })

/** The destination key of a publish-actions cell: its market's (the main listing), or with its alias id (a listing alias). */
export const cellDestinationKey = (cell: Pick<PublishActionCell, 'channel' | 'marketplace' | 'accountId' | 'aliasKey'>) =>
  cell.aliasKey ? publicationScopeKey({ channel: cell.channel, marketplace: cell.marketplace, accountId: cell.accountId, listingId: cell.aliasKey }) : marketKey(cell)

/** A read's cell as far as offering its alias goes (no `listingId`: a listing record). */
type OfferCell = Pick<PublishActionCell, 'productId' | 'aliasKey'> & Partial<Pick<PublishActionCell, 'listingId' | 'aliasStatus'>>

/**
 * The listing aliases the Publish window and the studio's listing picker offer (review 2026-10-05), from a
 * publish-actions read: an ACTIVE alias — an ARCHIVED alias's rows are still read, so a live item of it can be ended or
 * deleted from its Status cell, but it is never offered (nor an alias the read names no state for, once it names one for
 * any; a read that names none comes from a server that reads ACTIVE aliases only) — that the family's main product has
 * a listing record of: the review of an alias opens that record, so an alias without one could never be reviewed (m7).
 * `familyId` absent: the record check is skipped.
 */
export function offeredAliasIds(cells: ReadonlyArray<OfferCell>, familyId?: string | null): Set<string> {
  const stated = cells.some(cell => !!cell.aliasKey && cell.aliasStatus !== undefined)
  const active = new Set<string>(), rooted = new Set<string>()
  for (const cell of cells) {
    if (!cell.aliasKey) continue
    if (stated ? cell.aliasStatus === 'ACTIVE' : true) active.add(cell.aliasKey)
    if ((!familyId || cell.productId === familyId) && !isNewRowId(cell.listingId)) rooted.add(cell.aliasKey)
  }
  return new Set([...active].filter(id => rooted.has(id)))
}

/** The cells of the main listings and of the offered aliases only (`offeredAliasIds`): what the window and the picker read. */
export function offeredCells<T extends OfferCell>(cells: readonly T[], familyId?: string | null): T[] {
  const offered = offeredAliasIds(cells, familyId)
  return cells.filter(cell => !cell.aliasKey || offered.has(cell.aliasKey))
}

/**
 * A destination the window may offer: the main listing (no listing named), an offered alias, or a listing the read does
 * not know as an alias (a retry's ChannelListing id; the server resolves it). An alias the read knows but the window
 * does not offer (archived, or without a record of the family's main product) is never offered.
 */
export function isOfferedScope(scope: StudioPublishScope, cells: ReadonlyArray<OfferCell>, familyId?: string | null): boolean {
  if (!scope.listingId) return true
  if (!cells.some(cell => cell.aliasKey === scope.listingId)) return true
  return offeredAliasIds(cells, familyId).has(scope.listingId)
}

/**
 * Does a listing event change the listings of this family the studio's listing picker offers (review 2026-10-05, m1)?
 * A listing created or removed for a product of the family (`productIds`; an event that names no product: created —
 * it may be ours — or removed when it is one of our records, `records`), or a waiting Status choice of the family that
 * may have started drafts (`listing.updated` with the publish-action subtype: an alias gets its records then).
 */
export function listingEventConcerns(event: { type: string; id?: string; meta?: Record<string, unknown> }, productIds: ReadonlySet<string>, records: ReadonlySet<string>): boolean {
  const meta = event.meta ?? {}
  const product = typeof meta.productId === 'string' && meta.productId ? meta.productId : null
  if (event.type === 'listing.created' || event.type === 'listing.deleted') {
    if (product) return productIds.has(product)
    return event.type === 'listing.created' || (!!event.id && records.has(event.id))
  }
  if (event.type === 'listing.updated') return meta.subtype === 'listing.publish_action_changed' && productIds.has(product ?? event.id ?? '')
  return false
}

export function listedDestinationKeys(cells: ReadonlyArray<Pick<PublishActionCell, 'productId' | 'channel' | 'marketplace' | 'accountId' | 'aliasKey' | 'state' | 'create'> & Partial<Pick<PublishActionCell, 'listingId' | 'aliasStatus'>>>,
  familyId: string,
  /**
   * The studio's chosen listing (review 2026-10-05, M2): the window ticks ONLY that listing in its market — never its
   * market's other listings — and on every other market the listed main listing (as before aliases). Absent (no listing
   * chosen): every listed main listing and every listed alias, for one-click publish.
   */
  chosen?: StudioPublishScope | null): Set<string> {
  const offered = offeredAliasIds(cells, familyId)
  const byDestination = new Map<string, Array<(typeof cells)[number]>>()
  for (const cell of cells) {
    if (cell.aliasKey && !offered.has(cell.aliasKey)) continue
    // Each listing on a market is its own destination: the main listing, and each alias by its alias id.
    const key = cellDestinationKey(cell)
    byDestination.set(key, [...(byDestination.get(key) ?? []), cell])
  }
  const chosenMarket = chosen ? marketKey(chosen) : null
  const chosenKey = chosen ? publicationScopeKey(chosen) : null
  const out = new Set<string>()
  for (const [key, rows] of byDestination) {
    if (chosen) {
      const [first] = rows
      if (marketKey(first) === chosenMarket ? key !== chosenKey : !!first.aliasKey) continue
    }
    const main = rows.filter(row => row.productId === familyId)
    const live = (main.length ? main : rows).some(row => LISTED_STATES.has(row.state))
    const asked = rows.some(row => row.create?.source === 'own' && row.create.target !== 'not_listed')
    if (live || asked) out.add(key)
  }
  return out
}

/**
 * The family's listing aliases the window offers (`offeredAliasIds`), one per channel, market, account and alias, from
 * the publish-actions read, with their name and place. Each is offered whether it is listed or not; only a listed one
 * starts ticked (`listedDestinationKeys`). A cell without a name falls back to the alias's main row SKU (the family's
 * own row, `familyId`); one without a place follows the known ones of its market, in read order.
 */
export function listedAliases(cells: ReadonlyArray<Pick<PublishActionCell, 'productId' | 'sku' | 'channel' | 'marketplace' | 'accountId' | 'aliasKey' | 'aliasLabel' | 'aliasPosition'> & Partial<Pick<PublishActionCell, 'listingId' | 'aliasStatus'>>>,
  familyId?: string): PublicationAlias[] {
  const offered = offeredAliasIds(cells, familyId)
  const found = new Map<string, { alias: Omit<PublicationAlias, 'label' | 'position'>; label: string | null; position: number | null; sku: string | null; own: boolean }>()
  for (const cell of cells) {
    if (!cell.aliasKey || !offered.has(cell.aliasKey)) continue
    const key = cellDestinationKey(cell)
    const entry = found.get(key) ?? { alias: { channel: cell.channel, marketplace: cell.marketplace, accountId: cell.accountId, id: cell.aliasKey }, label: null, position: null, sku: null, own: false }
    found.set(key, entry)
    const label = typeof cell.aliasLabel === 'string' ? cell.aliasLabel.trim() : ''
    if (!entry.label && label) entry.label = label
    if (entry.position === null && typeof cell.aliasPosition === 'number' && Number.isInteger(cell.aliasPosition) && cell.aliasPosition > 0) entry.position = cell.aliasPosition
    const own = !!familyId && cell.productId === familyId
    if (cell.sku && (!entry.sku || (own && !entry.own))) { entry.sku = cell.sku; entry.own = own }
  }
  const last = new Map<string, number>()
  for (const entry of found.values()) {
    if (entry.position === null) continue
    const market = marketKey(entry.alias)
    last.set(market, Math.max(last.get(market) ?? 0, entry.position))
  }
  return [...found.values()].map(entry => {
    const market = marketKey(entry.alias)
    let position = entry.position
    if (position === null) { position = (last.get(market) ?? 0) + 1; last.set(market, position) }
    return { ...entry.alias, label: entry.label ?? entry.sku ?? `Listing alias ${position}`, position }
  })
}

/**
 * The canonical destination of a scope (Owner 2026-10-05): a listing named by its ChannelListing id becomes its alias id,
 * or no listing at all when it is the market's main listing — so one listing never has two keys. An alias id stays as
 * it is; an id the read does not know is kept (the server resolves it).
 */
export function canonicalScope(scope: StudioPublishScope, cells: ReadonlyArray<Pick<PublishActionCell, 'listingId' | 'channel' | 'marketplace' | 'accountId' | 'aliasKey'>>): StudioPublishScope {
  if (!scope.listingId) return scope
  const here = cells.filter(cell => cell.channel === scope.channel && cell.marketplace === scope.marketplace && cell.accountId === scope.accountId)
  if (here.some(cell => cell.aliasKey === scope.listingId)) return scope
  const row = here.find(cell => cell.listingId === scope.listingId)
  if (!row) return scope
  const main: StudioPublishScope = { channel: scope.channel, marketplace: scope.marketplace, accountId: scope.accountId }
  return row.aliasKey ? { ...main, listingId: row.aliasKey } : main
}

/**
 * The studio sheet's own destination (`scope` is its channel, or 'master'), canonical (Owner 2026-10-05): a listing alias
 * by its ALIAS id (the resolved destination's `aliasKey`; `undefined` while it resolves), the market's main listing with
 * no listing at all. Until the destination resolves, the family's listings (`cells`) name it when they know the id;
 * otherwise it waits — a `listing=` ChannelListing id in the address never becomes a destination key of its own.
 */
export function sheetDestinationScope(scope: string, market: string | null, accountId: string | undefined, listingId: string | undefined,
  aliasKey: string | null | undefined, cells?: ReadonlyArray<Pick<PublishActionCell, 'listingId' | 'channel' | 'marketplace' | 'accountId' | 'aliasKey'>> | null): StudioPublishScope | undefined {
  if (scope === 'master' || !market || !accountId) return undefined
  const main: StudioPublishScope = { channel: scope, marketplace: market, accountId }
  if (!listingId) return main
  if (aliasKey !== undefined) return aliasKey ? { ...main, listingId: aliasKey } : main
  const known = cells?.some(cell => cell.channel === scope && cell.marketplace === market && cell.accountId === accountId
    && (cell.aliasKey === listingId || cell.listingId === listingId))
  return known && cells ? canonicalScope({ ...main, listingId }, cells) : undefined
}

/**
 * A destination's place in the banners and hints: "eBay · IT", and with its listing when its market has more than one
 * ("eBay · IT · ① Racing edition", "eBay · IT · ★ Main listing") — the sheet band's mark and name.
 */
export function destinationPlace(scope: Pick<StudioPublishScope, 'channel' | 'marketplace'>, option?: Pick<PublicationDestinationOption, 'scope' | 'alias' | 'listings'> | null): string {
  const listing = option ? optionListingLabel(option) : null
  return [channelPlace(scope.channel, scope.marketplace), listing].filter(Boolean).join(' · ')
}

/** A destination's market name with its listing ("eBay Italy · ① Racing edition"), for a hint or a button's label. */
export function destinationName(option: Pick<PublicationDestinationOption, 'scope' | 'alias' | 'listings' | 'marketName'>): string {
  const listing = optionListingLabel(option)
  return listing ? `${option.marketName} · ${listing}` : option.marketName
}

/**
 * Every market of one channel on one account, for "Select all Amazon markets (11)". A business with two accounts on a
 * channel would otherwise tick each market twice.
 */
export function channelOptions(options: readonly PublicationDestinationOption[], channel: string, accountId?: string): PublicationDestinationOption[] {
  return options.filter(o => o.scope.channel === channel && (!accountId || o.scope.accountId === accountId) && !o.scope.listingId)
}
export const selectAllText = (channel: string, n: number) => `Select all ${channelLabel(channel)} markets (${n})`

/** The destinations ticked when the dialog opens: the ones asked for that exist, else the only one there is. */
export function initialTicked(options: readonly PublicationDestinationOption[], initial: readonly StudioPublishScope[]): string[] {
  const keys = initial.map(publicationScopeKey).filter(key => options.some(o => o.key === key))
  if (keys.length) return [...new Set(keys)]
  return options.length === 1 ? [options[0].key] : []
}

/**
 * Add the asked-for destinations that the market list does not name — a retry of a publish to a listing the window does
 * not know as an alias carries its `listingId` — as their own options ("Selected listing"), after their market's other
 * listings, so they can start ticked.
 */
export function withInitialOptions(options: readonly PublicationDestinationOption[], initial: readonly StudioPublishScope[]): PublicationDestinationOption[] {
  const out = [...options]
  for (const scope of initial) {
    const key = publicationScopeKey(scope)
    if (out.some(o => o.key === key)) continue
    const same = (o: PublicationDestinationOption) => o.scope.channel === scope.channel && o.scope.marketplace === scope.marketplace && o.scope.accountId === scope.accountId
    const at = out.map(same).lastIndexOf(true)
    if (at < 0) continue
    const base = out[at]
    const listings = out.filter(same).length + 1
    const added: PublicationDestinationOption = { ...base, key, scope: { ...scope }, alias: null, listings,
      label: `${base.marketName} · ${base.accountLabel}${scope.listingId ? ` · ${SELECTED_LISTING_LABEL}` : ''}` }
    // The market now holds one more listing: its main listing shows ★.
    out.forEach((o, i) => { if (same(o)) out[i] = { ...o, listings } })
    out.splice(at + 1, 0, added)
  }
  return out
}

// ── the batch, after the click ───────────────────────────────────────────────────────────────────────────────────

/**
 * A batch destination's words, all from the design system's one table: waiting its turn (PREVIEW) is `QUEUED`,
 * cancelled before its turn is `CANCELLED`, and a destination refused before sending (BLOCKED) is "Not sent".
 */
export function batchChildMeta(child: Pick<PublicationBatchChild, 'status' | 'checked'>): PublishStatusMeta {
  const status = child.status.toUpperCase()
  if (status === 'PREVIEW') return publicationStatusMeta('QUEUED')
  if (status === 'BLOCKED') return publicationStatusMeta('NOT_SENT')
  const meta = publicationStatusMeta(status)
  return child.checked ? { ...meta, hint: `${meta.hint} A person marked it as checked.` } : meta
}

/**
 * Ticking many destinations at once (the grid's header box, or a pasted set) keeps ONE account per channel, the same
 * rule as "Select all Amazon markets": a business with two accounts on a channel would otherwise tick every market
 * twice. The account kept is the one already ticked on that channel, else the first one listed. A single click on one
 * row is never changed.
 */
export function limitOneAccountPerChannel(next: ReadonlySet<string>, previous: ReadonlySet<string>, options: readonly PublicationDestinationOption[]): Set<string> {
  const added = [...next].filter(key => !previous.has(key))
  if (added.length <= 1) return new Set(next)
  const byKey = new Map(options.map(o => [o.key, o]))
  const keep = new Map<string, string>()
  for (const key of previous) { const o = byKey.get(key); if (o && next.has(key) && !keep.has(o.scope.channel)) keep.set(o.scope.channel, o.scope.accountId) }
  for (const o of options) if (next.has(o.key) && !keep.has(o.scope.channel)) keep.set(o.scope.channel, o.scope.accountId)
  return new Set([...next].filter(key => {
    if (previous.has(key)) return true
    const o = byKey.get(key)
    return !o || keep.get(o.scope.channel) === o.scope.accountId
  }))
}

/**
 * How many destinations a batch publishes to: each channel, market, account and listing (an alias is its own place; its
 * status changes and its content are one place).
 */
export function batchPlaces(children: ReadonlyArray<Pick<PublicationBatchChild, 'channel' | 'marketplace' | 'accountId' | 'aliasKey'>>): number {
  return new Set(children.map(c => JSON.stringify([c.channel, c.marketplace, c.accountId, c.aliasKey || null]))).size
}

/** "2 of 3 markets" — destinations with a final word, out of all. */
export function batchProgress(view: Pick<PublicationBatchView, 'children'>): { done: number; total: number } {
  return { done: view.children.filter(c => c.terminal).length, total: view.children.length }
}

/** The batch is still sending (not merely waiting for channels to answer): the dialog reads it again soon. */
export const batchSending = (view: Pick<PublicationBatchView, 'phase'> | null) => !!view && ['REVIEWING', 'REVIEWED', 'QUEUED', 'RUNNING', 'CANCELLING'].includes(view.phase)

/** Destinations not sent yet can still be cancelled. */
export const batchCancellable = (view: Pick<PublicationBatchView, 'phase' | 'counts' | 'cancelRequestedAt'> | null) =>
  !!view && !view.cancelRequestedAt && ['QUEUED', 'RUNNING'].includes(view.phase) && view.counts.waiting > 0

/** One sentence for the whole batch, for the banner and the screen reader. */
export function batchSentence(view: PublicationBatchView, word: PlacesWord = MARKETS_WORD): string {
  const { done, total } = batchProgress(view)
  const c = view.counts
  const places = (n: number) => plural(n, word.one, word.many)
  if (view.outcome === 'CANCELLED') return `Cancelled. ${c.cancelled} of ${places(total)} ${c.cancelled === 1 ? 'was' : 'were'} not sent.`
  if (!view.done) return `${done} of ${places(total)} have a result.`
  const parts = [
    c.succeeded ? `${c.succeeded} accepted` : null,
    c.partial ? `${c.partial} partly failed` : null,
    c.failed ? `${c.failed} failed` : null,
    c.notSent + c.blocked ? `${c.notSent + c.blocked} not sent` : null,
    c.cancelled ? `${c.cancelled} cancelled` : null,
    c.checked ? `${c.checked} checked by a person` : null,
  ].filter(Boolean)
  return `All ${places(total)} have a result: ${parts.join(', ')}.`
}

/** The tone of the batch as a whole. */
export function batchTone(view: Pick<PublicationBatchView, 'outcome' | 'done'>): Tone {
  if (!view.done) return 'info'
  return view.outcome === 'SUCCEEDED' ? 'success' : view.outcome === 'PARTIAL' ? 'warning' : view.outcome === 'FAILED' ? 'danger' : 'neutral'
}

/**
 * A 422 from the batch route is the Amazon EU quantity guard: two EU markets of the batch would create one SKU with
 * different quantities, and Amazon keeps ONE EU quantity. Its message names each SKU and market on its own line.
 */
export function euRefusal(error: unknown): { title: string; lines: string[] } | null {
  const e = error as { status?: number; message?: string } | null
  if (!e || e.status !== 422 || typeof e.message !== 'string') return null
  return { title: 'Different Amazon EU quantities', lines: e.message.split('\n').map(line => line.trim()).filter(Boolean) }
}

/** The batch request for the ready destinations, each with its own token, confirmation and location. */
export function batchRequest(keys: readonly string[], entryOf: (key: string) => DestinationEntry) {
  return {
    reviews: keys.flatMap(key => {
      const entry = entryOf(key), review = entry.review
      if (!review?.id) return []
      return [{
        reviewId: review.id,
        ...(isSparse(review) && entry.selection?.token ? { selectionToken: entry.selection.token } : {}),
        ...(!isSparse(review) && entry.confirmedReviewId === review.id ? { confirmOverwrite: true } : {}),
        ...(review.locations ? { locationId: entry.locationId } : {}),
      }]
    }),
  }
}
