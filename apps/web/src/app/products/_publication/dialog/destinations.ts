/**
 * Sheet publish parity, step 5 (item 3) — publish one family to several destinations from one dialog.
 *
 * Pure rules for the Publish dialog's destination list: which destinations start ticked, what each ticked destination's
 * review allows (ready, nothing to send, problems, expired…), what the one counted button says, and whether a send
 * takes today's single-destination path or the background batch (`POST /api/publication-batches`). Each destination
 * keeps its OWN review, change plan and ticks; nothing here merges them.
 */
import { blockingIssues, isPhotoChangeId, type PublicationBatchChild, type PublicationBatchView, type StudioPublishReview, type StudioPublishScope, type StudioPublishSelection } from '@nexus/shared/studio-publication'
import { channelLabel } from '@nexus/shared/channel-label'
import { publicationStatusMeta, type PublishStatusMeta } from '@/design-system/grid/renderers/publishStatus'
import type { Tone } from '@/design-system/primitives/tone'
import { matchesPublicationSelection, publicationOverwriteAcknowledged, publicationScopeKey, type PublicationDestinationOption } from './model'

/** The batch route takes at most this many destinations (server: `publication-batch.service.ts`). */
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
}

export const EMPTY_ENTRY: DestinationEntry = Object.freeze({
  review: null, loading: false, error: null, selectedIds: [], selection: null, selecting: false, locationId: '', confirmedReviewId: null,
}) as DestinationEntry

/** Amazon and eBay send only the ticked fields; the other channels send the whole product. */
export const isSparse = (review: Pick<StudioPublishReview, 'scope'> | null | undefined) => !!review && ['AMAZON', 'EBAY'].includes(review.scope.channel)

export type DestinationState =
  | { kind: 'not_checked' }
  | { kind: 'checking' }
  | { kind: 'error'; message: string }
  /** An earlier publish to this destination has no answer yet; the server refuses a new one until it has. */
  | { kind: 'earlier'; publicationId: string }
  | { kind: 'blocked'; problems: number; reason: string | null }
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
    return { kind: 'ready', changes: ticks.length, whole: false, requestReady: matchesPublicationSelection(entry.selection, review, ticks) }
  }
  if (review.locations && !review.locations.some(l => l.id === entry.locationId)) return { kind: 'input', needs: 'location' }
  if (!publicationOverwriteAcknowledged(review, entry.confirmedReviewId)) return { kind: 'input', needs: 'overwrite' }
  return { kind: 'ready', changes: review.rows.length, whole: true, requestReady: true }
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** The words in the destination list's Review column. */
export function destinationStateLabel(state: DestinationState): { label: string; tone: Tone; hint: string } {
  switch (state.kind) {
    case 'not_checked': return { label: 'Not checked yet', tone: 'neutral', hint: 'Tick this destination to review what would be sent.' }
    case 'checking': return { label: 'Checking…', tone: 'info', hint: 'Reading the saved values and the channel.' }
    case 'error': return { label: 'Could not check', tone: 'danger', hint: state.message }
    case 'earlier': return { label: 'Earlier publish waiting', tone: 'warning', hint: 'An earlier publish to this destination has no answer yet. It is not sent again until that publish has a result.' }
    case 'blocked': return state.problems
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
      : { label: state.requestReady ? 'Request ready' : 'Ready', tone: 'info', hint: state.requestReady ? 'The exact request is prepared.' : 'Review the selected changes to prepare the exact request.' }
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

/** "markets" when every destination is one channel, "destinations" when channels or accounts mix. */
function placesWord(keys: readonly string[], scopeOf: (key: string) => StudioPublishScope | undefined): { one: string; many: string } {
  const scopes = keys.map(scopeOf).filter((s): s is StudioPublishScope => !!s)
  const sameChannel = new Set(scopes.map(s => s.channel)).size <= 1 && new Set(scopes.map(s => s.accountId)).size <= 1
  return sameChannel ? { one: 'market', many: 'markets' } : { one: 'destination', many: 'destinations' }
}

/**
 * The counted primary button: "Publish 21 changes to 2 markets", "… · skip 1 with problems". A Shopify destination
 * sends a whole NEW product (the dialog refuses existing Shopify products), so it is counted as one.
 */
export function publishButtonText(plan: PublishPlan, scopeOf: (key: string) => StudioPublishScope | undefined): string {
  const word = placesWord(plan.send, scopeOf)
  const what = [plan.changes ? plural(plan.changes, 'change', 'changes') : null, plan.wholeProducts ? plural(plan.wholeProducts, 'new product', 'new products') : null]
    .filter(Boolean).join(' and ')
  const skip = plan.skipped.length ? ` · skip ${plan.skipped.length} with problems` : ''
  if (!plan.send.length) return plan.skipped.length ? `Nothing to publish · ${plan.skipped.length} with problems` : 'Nothing to publish'
  return `Publish ${what || 'the review'} to ${plural(plan.send.length, word.one, word.many)}${skip}`
}

/** "Review 2 requests" — prepares the exact request of every ticked Amazon or eBay destination. */
export const reviewRequestsText = (n: number) => `Review ${plural(n, 'request', 'requests')}`

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
 * Add the asked-for destinations that the market list does not name — a retry of a publish to a non-primary listing
 * carries its `listingId` — as their own options, so they can start ticked.
 */
export function withInitialOptions(options: readonly PublicationDestinationOption[], initial: readonly StudioPublishScope[]): PublicationDestinationOption[] {
  const extra = initial.filter(scope => !options.some(o => o.key === publicationScopeKey(scope))).flatMap(scope => {
    const base = options.find(o => o.scope.channel === scope.channel && o.scope.marketplace === scope.marketplace && o.scope.accountId === scope.accountId)
    return base ? [{ ...base, key: publicationScopeKey(scope), scope: { ...scope }, label: `${base.marketName} · ${base.accountLabel}${scope.listingId ? ' · Selected listing' : ''}` }] : []
  })
  return [...options, ...extra]
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
export function batchSentence(view: PublicationBatchView, word: { one: string; many: string } = { one: 'market', many: 'markets' }): string {
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
