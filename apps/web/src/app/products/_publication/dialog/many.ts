/**
 * Sheet publish parity T1 (item 6) — the Publish dialog for many products at once, opened from the products list.
 *
 * Pure rules. The server reviews every family × destination in the background (`POST /api/publication-batches` with
 * product ids), waits as REVIEWED, then sends on `POST …/:id/submit`. This file decides what each reviewed row says,
 * what the one counted button says, and when a selection is too large — so the dialog, its tests and the screen agree.
 *
 * Build shape v2 (P11) — the window's Action picker: Send changes (the content, as before) or one Status for every
 * listing of the chosen products in the chosen markets (Set Active · Set Inactive · Set Ended; no Delete here). A Status
 * is reviewed by the listing-action engine (one lifecycle child per product × market × action, each listing with what
 * happens or why it cannot); the window shows one row per product × market, a summary per market tab ("Inactive on
 * Amazon · DE: 36 listings · 4 cannot"), and one counted button ("Set 36 listings inactive on 2 markets"). Ended asks
 * for the typed count of listings it ends (`TYPE_COUNT_TO_END`, checked again by the server).
 *
 * New listings (ND4 B, Owner 2026-10-04) — with Send changes, "New listings start as: As each row says · Active ·
 * Inactive" (`manyStartAsOptions`): the Status every listing the changes CREATE starts with (`options.startAs`; absent =
 * each row's own Status, else the channel's default). A checked row says what it creates ("Creates GALE-M (inactive).",
 * `createsSentence`), and the summary line counts them (`manyCreatesSummary`).
 *
 * One-click O5 (Owner 2026-10-04, OD3 A + OD4 A) — the studio window's rules:
 *   - the Markets picker starts with every market (of the chosen channel + account) where a ticked family is listed,
 *     Active or Inactive (`POST /api/publication-batches/listed-markets` → `manyListedSet`; removable);
 *   - Nexus wins: the review ticks the fields that differ on the channel; the "Keep channel values" switch (off by
 *     default) leaves them out (`manyRequest`); each market tab says how many values differ (`manyDiffersSummary`);
 *   - a family not listed in a market is skipped with the reason (`not_listed`, not a problem) unless "New listings start
 *     as" is chosen; a family or market whose request cannot be built is skipped with its reason, the rest publish;
 *   - one button: "Check 12 products in 3 markets" → "Checking 1 of 3 markets…" → "Publish 120 changes to 3 markets ·
 *     skip 2 with problems" (the server builds every request while it checks).
 */
import { differsSentence, type PublicationBatchChild, type PublicationBatchView, type StudioPublishScope } from '@nexus/shared/studio-publication'
import { channelLabel } from '@nexus/shared/channel-label'
import { STATUS_TARGET_LABEL, type ListingAction, type ListingActionRowOutcome, type ListingActionRowPlan } from '@nexus/shared/listing-actions'
import {
  MANY_PUBLISH_ACTION_LABEL, MANY_PUBLISH_ACTIONS, START_AS_HINT, START_AS_LABEL, START_AS_TARGETS, START_AS_WORD, manyEndCount,
  type ListedStatusTarget, type ManyBatchOptions, type ManyPublishAction, type ManyPublishRequest, type PublishPlanBatchChild, type PublishPlanBatchView,
  type StartAsTarget,
} from '@nexus/shared/publish-plan'
import type { Tone } from '@/design-system/primitives/tone'
import { publicationScopeKey, type PublicationDestinationOption } from './model'

/** The server's limits (`publication-batch.service.ts`). */
export const MAX_BATCH_PRODUCTS = 200
export const MAX_BATCH_REVIEWS = 1_000

/**
 * Channels a many-product publish can reach. Amazon and eBay are reviewed field by field and sent without a question
 * per product; Shopify needs a stock location and an overwrite confirmation for each product, and Etsy cannot be
 * published from Nexus yet — both stay in each product's own Publish window.
 */
export const MANY_CHANNELS = ['AMAZON', 'EBAY'] as const
/**
 * P11 — a Status reaches every channel: it asks nothing per product, and the engine says per listing when a channel
 * cannot do it (Amazon has no End, an eBay listing without out-of-stock control cannot be paused, …).
 */
export const MANY_STATUS_CHANNELS = ['AMAZON', 'EBAY', 'SHOPIFY', 'ETSY'] as const
export const manyDestinationOptions = (options: readonly PublicationDestinationOption[], action: ManyPublishAction = 'content') => {
  const channels: readonly string[] = action === 'content' ? MANY_CHANNELS : MANY_STATUS_CHANNELS
  return options.filter(o => channels.includes(o.scope.channel) && !o.scope.listingId)
}
export const MANY_CHANNELS_NOTE = 'Amazon and eBay only. Publish Shopify and Etsy from each product’s own Publish window: Shopify asks for a stock location and a confirmation per product.'
export const MANY_STATUS_CHANNELS_NOTE = 'Amazon, eBay, Shopify and Etsy. A listing its channel cannot change is shown with the reason, and is left as it is.'

const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en')} ${n === 1 ? one : many}`

/** Why the selection cannot be checked as it is, or null. */
export function manyCapMessage(products: number, families: number, destinations: number): string | null {
  if (products > MAX_BATCH_PRODUCTS) return `Select ${MAX_BATCH_PRODUCTS} or fewer products. ${plural(products, 'product is', 'products are')} selected.`
  if (families * destinations > MAX_BATCH_REVIEWS) {
    return `${plural(families, 'family', 'families')} in ${plural(destinations, 'market', 'markets')} make ${(families * destinations).toLocaleString('en')} reviews. At most ${MAX_BATCH_REVIEWS.toLocaleString('en')} can be checked at once: choose fewer markets or select fewer products.`
  }
  return null
}

/** "Check 12 products in 3 markets" — the button that starts the background review. */
export const manyCheckButtonText = (families: number, destinations: number) => destinations
  ? `Check ${plural(families, 'product', 'products')} in ${plural(destinations, 'market', 'markets')}`
  : `Choose a market to check ${plural(families, 'product', 'products')}`

// ── One-click O5: the batch view as the server sends it to this window ──────────────────────────────────────────────

/**
 * A reviewed row's facts: a batch child (`PublishPlanBatchChild` from `GET /api/publication-batches/:id`, whose
 * `notListed` and `differs` O5 added). The row rules read only these, so a plain content child is enough.
 */
type RowChild = PublicationBatchChild & Pick<PublishPlanBatchChild, 'notListed' | 'differs'>

/** One market where some ticked families are listed (`POST /api/publication-batches/listed-markets`). */
export interface ManyListedMarket { channel: string; marketplace: string; accountId: string; families: number }
export interface ManyListedMarkets { families: number; markets: ManyListedMarket[] }

/** The listed markets as the pickers' keys (`initialChoice` / `refillChoice` in pickers.ts take this set). */
export const manyListedSet = (listed: ManyListedMarkets | null): Set<string> | null => listed
  ? new Set(listed.markets.map(market => publicationScopeKey({ channel: market.channel, marketplace: market.marketplace, accountId: market.accountId })))
  : null

/** The line under the pickers once the listed markets are chosen; null when none is. */
export function manyListedNote(chosen: number, listed: ManyListedMarkets | null): string | null {
  if (!listed) return null
  if (!listed.markets.length) return `These products are not listed (Active or Inactive) in any market yet. Choose the markets, and “${START_AS_LABEL}” to create them.`
  if (!chosen) return null
  return `Chosen: the ${plural(chosen, 'market', 'markets')} where these products are listed (Active or Inactive). Remove any you do not want.`
}

export const KEEP_CHANNEL_VALUES_LABEL = 'Keep channel values'
export const KEEP_CHANNEL_VALUES_HINT = 'Leave values changed on the channel as they are.'
/** What the switch does now, said under it. */
export const keepChannelValuesState = (keep: boolean) => keep
  ? 'On: only what Nexus changed is sent. A value someone changed on the channel stays.'
  : 'Off: Nexus wins. Publish replaces values that differ on the channel with Nexus’s.'

/** The options the batch was made with (the server's echo), else the window's own choice. */
export function manyBatchOptions(view: Pick<PublishPlanBatchView, 'request'> | null, own: Pick<ManyBatchOptions, 'keepChannelValues' | 'startAs'>): Pick<ManyBatchOptions, 'keepChannelValues' | 'startAs'> {
  const echoed = view?.request?.options
  return echoed ? { keepChannelValues: echoed.keepChannelValues, startAs: echoed.startAs } : own
}

/** One reviewed family × destination, before anything is sent. */
export type ManyRowState =
  | { kind: 'ready'; changes: number }
  | { kind: 'nothing'; reason: string }
  | { kind: 'not_listed'; reason: string }
  | { kind: 'problems'; problems: number; reason: string | null }
  | { kind: 'expired' }
  | { kind: 'not_sent'; reason: string }

const NOT_LISTED_REASON = `Not listed in this market. Choose “${START_AS_LABEL}” to create it.`

export function manyRowState(child: Pick<RowChild, 'status' | 'message' | 'problems' | 'selectedCount' | 'expiresAt' | 'nothingToSend' | 'notListed'>,
  now: number = Date.now()): ManyRowState {
  const status = child.status.toUpperCase()
  if (status === 'BLOCKED') return { kind: 'problems', problems: child.problems?.errors ?? 0, reason: child.message }
  if (status === 'NOT_SENT') {
    if (child.notListed) return { kind: 'not_listed', reason: child.message ?? NOT_LISTED_REASON }
    return child.nothingToSend
      ? { kind: 'nothing', reason: 'The channel already has these values.' }
      : { kind: 'not_sent', reason: child.message ?? 'This product could not be reviewed for this market.' }
  }
  if (status !== 'PREVIEW') return { kind: 'not_sent', reason: child.message ?? 'This row is not waiting to be sent.' }
  const expires = child.expiresAt ? Date.parse(child.expiresAt) : NaN
  if (Number.isFinite(expires) && expires <= now) return { kind: 'expired' }
  const changes = child.selectedCount ?? 0
  return changes > 0 ? { kind: 'ready', changes } : { kind: 'nothing', reason: 'No fields are ticked for this market.' }
}

/** The words in a reviewed row's Review column. */
export function manyRowLabel(state: ManyRowState): { label: string; tone: Tone; hint: string } {
  switch (state.kind) {
    case 'ready': return { label: 'Ready', tone: 'info', hint: 'Open the row to see or change the ticked fields.' }
    case 'nothing': return { label: 'Nothing to send', tone: 'neutral', hint: state.reason }
    case 'not_listed': return { label: 'Not listed', tone: 'neutral', hint: state.reason }
    case 'problems': return state.problems
      ? { label: `Fix ${plural(state.problems, 'problem', 'problems')} first`, tone: 'warning', hint: 'This row is skipped until its problems are fixed in the product’s sheet.' }
      : { label: 'Cannot be sent', tone: 'warning', hint: state.reason ?? 'Open the row to see why.' }
    case 'expired': return { label: 'Review expired', tone: 'warning', hint: 'A batch review lasts 2 hours. Check again to compare the current values.' }
    case 'not_sent': return { label: 'Not sent', tone: 'danger', hint: state.reason }
  }
}

export interface ManyPlan {
  /** Rows that will be sent. */
  listings: number
  /** Ticked fields over the rows that will be sent. */
  changes: number
  /** Rows skipped because of problems (or a review that could not be made). */
  problems: number
  /** Rows whose review expired. */
  expired: number
  /** Rows with nothing to send. */
  nothing: number
  /** Blocking problems over every row. */
  problemCount: number
  /** One-click O5 — markets with at least one row to send. */
  markets: number
  /** One-click O5 — rows skipped because the family is not listed in that market (not a problem). */
  notListed: number
}

export function manyPlan(children: readonly RowChild[], now: number = Date.now()): ManyPlan {
  const plan: ManyPlan = { listings: 0, changes: 0, problems: 0, expired: 0, nothing: 0, problemCount: 0, markets: 0, notListed: 0 }
  const markets = new Set<string>()
  for (const child of children) {
    const state = manyRowState(child, now)
    if (state.kind === 'ready') { plan.listings++; plan.changes += state.changes; markets.add(manyChildMarketKey(child)) }
    else if (state.kind === 'nothing') plan.nothing++
    else if (state.kind === 'not_listed') plan.notListed++
    else if (state.kind === 'expired') plan.expired++
    else { plan.problems++; if (state.kind === 'problems') plan.problemCount += state.problems }
  }
  plan.markets = markets.size
  return plan
}

/** "Publish 120 changes to 3 markets · skip 2 with problems" — the one counted button (as the studio's). */
export function manyPublishButtonText(plan: ManyPlan): string {
  const skips = [plan.problems ? `skip ${plan.problems} with problems` : null, plan.expired ? `${plan.expired} expired` : null].filter(Boolean)
  const tail = skips.length ? ` · ${skips.join(' · ')}` : ''
  if (!plan.listings) return `Nothing to publish${tail}`
  return `Publish ${plural(plan.changes, 'change', 'changes')} to ${plural(plan.markets, 'market', 'markets')}${tail}`
}

/** The one line above the tabs once checked: "12 products ready in 3 markets · 120 changes · 2 with problems · 4 not listed there". */
export function manyPlanSummary(plan: ManyPlan): string {
  return [
    plan.listings ? `${plural(plan.listings, 'product', 'products')} ready in ${plural(plan.markets, 'market', 'markets')}` : 'No product ready to publish',
    plan.changes ? plural(plan.changes, 'change', 'changes') : null,
    plan.problems ? `${plan.problems.toLocaleString('en')} with problems` : null,
    plan.expired ? `${plan.expired.toLocaleString('en')} expired` : null,
    plan.notListed ? `${plan.notListed.toLocaleString('en')} not listed there` : null,
    plan.nothing ? `${plan.nothing.toLocaleString('en')} with nothing to send` : null,
  ].filter(Boolean).join(' · ')
}

/**
 * The one button while the server checks: "Checking 1 of 3 markets…" — a market is checked once every family has its
 * row there.
 */
export function manyCheckingText(children: readonly PublicationBatchChild[], marketKeys: readonly string[], families: number): string {
  const done = marketKeys.filter(key => families > 0 && new Set(children.filter(child => manyChildMarketKey(child) === key).map(child => child.productId)).size >= families).length
  return `Checking ${Math.min(done + 1, marketKeys.length).toLocaleString('en')} of ${plural(marketKeys.length, 'market', 'markets')}…`
}

/**
 * One market tab's few words: "checking…" until every family has its row there, then "12 changes", "3 with problems",
 * "4 not listed" or "nothing to send"; while sending "2 of 5 done".
 */
export function manyMarketTabWords(children: readonly RowChild[], stage: 'reviewing' | 'reviewed' | 'sending', families: number, now: number = Date.now()): string {
  if (stage === 'sending') {
    const done = children.filter(c => c.terminal).length
    return done === children.length && children.length ? 'done' : `${done} of ${children.length} done`
  }
  if (stage === 'reviewing' && new Set(children.map(child => child.productId)).size < families) return 'checking…'
  let changes = 0, ready = 0, problems = 0, notListed = 0
  for (const child of children) {
    const state = manyRowState(child, now)
    if (state.kind === 'ready') { ready++; changes += state.changes }
    else if (state.kind === 'not_listed') notListed++
    else if (state.kind === 'problems' || state.kind === 'not_sent' || state.kind === 'expired') problems++
  }
  if (ready) return plural(changes, 'change', 'changes')
  if (problems) return `${problems.toLocaleString('en')} with problems`
  if (notListed && notListed === children.length) return 'not listed'
  return children.length ? 'nothing to send' : 'no products'
}

/** One market tab's line for the families skipped there: "4 products are not listed on Amazon · DE, so they are skipped. …"; null for none. */
export function manyNotListedSummary(children: readonly RowChild[], market: string, now: number = Date.now()): string | null {
  const skipped = children.filter(child => manyRowState(child, now).kind === 'not_listed').length
  if (!skipped) return null
  return `${plural(skipped, 'product is', 'products are')} not listed on ${market}, so ${skipped === 1 ? 'it is' : 'they are'} skipped. Choose “${START_AS_LABEL}” to create ${skipped === 1 ? 'it' : 'them'}.`
}

/**
 * One market tab's Nexus-wins line (SIMPLIFY item 3), over the rows ready to send: "12 values on Amazon · IT differ from
 * Nexus. Publish replaces them." — O1's words from counts (`differsSentence`: `differsSummary` reads the change lines;
 * this window has only each row's counts, `differs`). Some or all unticked (Keep channel values, or ticks taken off):
 * "Publish keeps them." / "Publish replaces 2 of them." Null when no value differs.
 */
export function manyDiffersSummary(children: readonly RowChild[], market: string, now: number = Date.now()): string | null {
  let count = 0, ticked = 0
  for (const child of children) {
    if (!child.differs || manyRowState(child, now).kind !== 'ready') continue
    count += child.differs.total; ticked += Math.min(child.differs.ticked, child.differs.total)
  }
  return count ? differsSentence(count, ticked, market) : null
}

/** "about 9 minutes" — the server's estimate for the stage that is running, or for the send REVIEWED would start. */
export function estimateText(view: Pick<PublicationBatchView, 'estimate'> | null): string | null {
  const minutes = view?.estimate?.minutes
  if (minutes == null) return null
  return minutes <= 1 ? 'about a minute' : `about ${minutes.toLocaleString('en')} minutes`
}

/** The review stage's progress: reviews made out of reviews asked for. */
export function reviewProgress(view: Pick<PublicationBatchView, 'request'> | null): { done: number; total: number } | null {
  const r = view?.request
  return r ? { done: Math.min(r.reviewed, r.reviews), total: r.reviews } : null
}

/** A many-product batch is waiting for the person (REVIEWED) — the rows can be read and sent. */
export const manyReviewed = (view: Pick<PublicationBatchView, 'phase'> | null) => view?.phase === 'REVIEWED'
/** The background review is still running. */
export const manyReviewing = (view: Pick<PublicationBatchView, 'phase'> | null) => view?.phase === 'REVIEWING'

/** A reviewed row's destination words: "Amazon IT · Xavia Racing". */
export function manyDestinationLabel(child: Pick<PublicationBatchChild, 'channel' | 'marketplace' | 'accountId'>, options: readonly PublicationDestinationOption[]): string {
  const option = options.find(o => o.scope.channel === child.channel && o.scope.marketplace === child.marketplace && o.scope.accountId === child.accountId)
  return option ? `${option.marketName} · ${option.accountLabel}` : [child.channel, child.marketplace].filter(Boolean).join(' · ')
}

/** The studio link for one reviewed row: the family's sheet on that destination, where its ticks can be changed. */
export function manyStudioHref(child: Pick<PublicationBatchChild, 'productId' | 'channel' | 'marketplace' | 'accountId'>): string | null {
  if (!child.productId || !child.channel || !child.marketplace) return null
  const query = new URLSearchParams({ scope: child.channel, market: child.marketplace, ...(child.accountId ? { account: child.accountId } : {}) })
  return `/products/${encodeURIComponent(child.productId)}/edit/studio?${query}`
}

/**
 * The batch request body for the background review. Send changes reviews the content (and, when chosen, how the listings
 * it creates start: `startAs`); a Status reviews only that Status (`content: false`), so a listing being ended never gets
 * changes first — and never a "start as" (it applies only to the listings the changes create).
 * One-click O5 — Nexus wins unless "Keep channel values" (`keepChannelValues`): sent as the shared request's
 * `replaceDiffers` (true = Nexus wins, false = keep the channel's values).
 */
export const manyRequest = (productIds: readonly string[], destinations: readonly StudioPublishScope[], keepChannelValues: boolean,
  action: ManyPublishAction = 'content', startAs: StartAsTarget | null = null): ManyPublishRequest => ({
  productIds: [...productIds],
  destinations: destinations.map(({ channel, marketplace, accountId }) => ({ channel, marketplace, accountId })),
  options: action === 'content' ? { replaceDiffers: !keepChannelValues, ...(startAs ? { startAs } : {}) } : { status: action, content: false },
})

// ── New listings start as (ND4 B) ───────────────────────────────────────────────────────────────────────────────────

/** The choice that sends no `startAs`: each new listing starts as its own Status, else as the channel does today. */
export const START_AS_EACH_ROW = 'As each row says'
export const START_AS_EACH_ROW_HINT = 'Every listing these changes create starts as its own Status in the product sheet; without one, as today: Amazon and eBay Active, Shopify a Draft product. A row set Not listed stays out.'

/** The control's choices: As each row says · Active · Inactive (the value '' sends nothing). */
export function manyStartAsOptions(): Array<{ value: '' | StartAsTarget; label: string; title: string }> {
  return [
    { value: '', label: START_AS_EACH_ROW, title: START_AS_EACH_ROW_HINT },
    ...START_AS_TARGETS.map(target => ({ value: target, label: START_AS_WORD[target], title: START_AS_HINT[target] })),
  ]
}

/** What the chosen value does, said under the control. */
export const manyStartAsHint = (startAs: StartAsTarget | null) => (startAs ? START_AS_HINT[startAs] : START_AS_EACH_ROW_HINT)

/** "New listings start as: Inactive" — the line that stays once the check started; null for As each row says. */
export const manyStartAsLine = (startAs: StartAsTarget | null) => (startAs ? `${START_AS_LABEL}: ${START_AS_WORD[startAs]}` : null)

/**
 * "12 new listings (all inactive)" — what the rows ready to send create (for the summary line after "12 listings ready ·
 * 214 changes"); null when they create none.
 */
export function manyCreatesSummary(children: readonly PublicationBatchChild[], now: number = Date.now()): string | null {
  const creates = children.filter(child => manyRowState(child, now).kind === 'ready').flatMap(child => child.creates ?? [])
  if (!creates.length) return null
  const inactive = creates.filter(row => row.startsAs === 'inactive').length
  const how = !inactive ? '' : inactive === creates.length ? (creates.length === 1 ? ' (inactive)' : ' (all inactive)') : ` (${inactive.toLocaleString('en')} inactive)`
  return `${plural(creates.length, 'new listing', 'new listings')}${how}`
}

/**
 * One-click O5 — why a row has no saved review to open: not listed in that market, or not reviewed (the reason the
 * server gave, without its "Nothing was sent." opening); null for a row with a review.
 */
export function manyRowSkipReason(child: Pick<RowChild, 'status' | 'message' | 'summary' | 'notListed'>): string | null {
  if (child.status.toUpperCase() !== 'NOT_SENT') return null
  if (child.notListed) return child.message ?? NOT_LISTED_REASON
  if (child.summary?.notReviewed !== true) return null
  return (child.message ?? 'This product could not be reviewed for this market.').replace(/^Nothing was sent\.\s*/, '')
}

/** A reviewed row's saved review (`GET …/studio-publication/:reviewId/review`) and its tick route, or null without a product. */
export function manyReviewPaths(child: Pick<PublicationBatchChild, 'productId' | 'publicationId'>): { review: string; selection: string } | null {
  if (!child.productId) return null
  const base = `/api/products/${encodeURIComponent(child.productId)}/studio-publication/${encodeURIComponent(child.publicationId)}`
  return { review: `${base}/review`, selection: `${base}/selection` }
}

/** The ticks of one reviewed row can change: the review still waits for the person and nothing is being sent. */
export const manyRowEditable = (stored: { editable: boolean } | null, sending: boolean) => !!stored?.editable && !sending

/** Ticks as one comparable key (order does not matter). */
export const tickKey = (ids: readonly string[] | null | undefined) => [...(ids ?? [])].sort().join('\n')

// ── P11: one Status for many products × markets ────────────────────────────────────────────────────────────────────

/** The Action picker: Send changes, Set Active, Set Inactive, Set Ended (never Delete). Ended needs products.delete. */
export const MANY_ROLE_CANNOT_END_SHORT = 'Your role cannot end listings: it needs permission to delete products.'
export function manyActionOptions(canEnd: boolean): Array<{ value: ManyPublishAction; label: string; disabled?: boolean; title?: string }> {
  return MANY_PUBLISH_ACTIONS.map(action => ({ value: action, label: MANY_PUBLISH_ACTION_LABEL[action],
    ...(action === 'ended' && !canEnd ? { disabled: true, title: MANY_ROLE_CANNOT_END_SHORT } : {}) }))
}

/** What a Status does, said before the check. */
export const MANY_STATUS_HINT: Readonly<Record<ListedStatusTarget, string>> = {
  active: 'Every listing of these products in the chosen markets sells again. An inactive listing resumes with the current stock; an ended one is relisted (eBay gives it a new item number). Listings already active are left as they are.',
  inactive: 'Every listing of these products in the chosen markets stops selling. The listings stay on the channel, and Set Active sells them again.',
  ended: 'Every listing of these products in the chosen markets is ended. Amazon and Etsy have no End: set Inactive there. You type the number of listings to confirm.',
}

/** The Status word inside a sentence: "inactive", "ended". */
const TARGET_WORD: Readonly<Record<ListedStatusTarget, string>> = { active: 'active', inactive: 'inactive', ended: 'ended' }

/** "Amazon · DE"; a channel with one market ("Shopify") is its name alone. */
export function manyMarketName(child: Pick<PublicationBatchChild, 'channel' | 'marketplace'>): string {
  const channel = child.channel ? channelLabel(child.channel) : 'Channel'
  return !child.marketplace || child.marketplace === 'GLOBAL' || child.channel === 'SHOPIFY' ? channel : `${channel} · ${child.marketplace}`
}

/** One listing of a product × market: what happens to it, or why not (before the send). */
export interface ManyStatusListing { key: string; sku: string; plan: ListingActionRowPlan; sentence: string }
/** One listing's result once sent. */
export interface ManyStatusResult { key: string; sku: string; action: ListingAction | null; outcome: ListingActionRowOutcome; message: string }

export type ManyStatusRowState = 'ready' | 'nothing' | 'refused' | 'expired' | 'not_checked'

/** One product × market of a Status batch: its lifecycle children (one per action) merged into one row. */
export interface ManyStatusRow {
  key: string
  productId: string | null
  familySku: string | null
  familyTitle: string | null
  /** The market tab it sits under (`publicationScopeKey` of its destination). */
  marketKey: string
  channel: string | null
  marketplace: string | null
  children: PublishPlanBatchChild[]
  state: ManyStatusRowState
  /** Listings it changes (the server's count). */
  send: number
  /** Listings the channel or the listing cannot change. */
  refused: number
  /** Why nothing changes here, or why it was not checked. */
  reason: string | null
  /** Every listing with what happens to it (before the send; one per listing, the best plan of its actions). */
  listings: ManyStatusListing[]
  /** Every listing's result (after the send). */
  results: ManyStatusResult[]
}

const PLAN_RANK: Readonly<Record<ListingActionRowPlan, number>> = { send: 0, refused: 1, skip: 2 }
const isExpired = (expiresAt: string | null | undefined, now: number) => { const t = expiresAt ? Date.parse(expiresAt) : NaN; return Number.isFinite(t) && t <= now }
const rowKey = (child: Pick<PublicationBatchChild, 'productId' | 'channel' | 'marketplace' | 'accountId'>) =>
  JSON.stringify([child.productId, child.channel, child.marketplace, child.accountId])
/** A lifecycle child still waiting its turn that changes something. */
const waitingToSend = (child: PublishPlanBatchChild) =>
  child.kind === 'lifecycle' && child.status.toUpperCase() === 'PREVIEW' && !child.nothingToSend && (child.sendCount ?? 0) > 0
const NOT_CHECKED = 'This product could not be checked for this market.'
const NOT_SENT_PREFIX = /^Nothing was sent\.\s*/

/** The rows of a Status batch, one per product × market, in the batch's order. */
export function manyStatusRows(children: readonly PublishPlanBatchChild[], now: number = Date.now()): ManyStatusRow[] {
  const groups = new Map<string, PublishPlanBatchChild[]>()
  for (const child of children) groups.set(rowKey(child), [...(groups.get(rowKey(child)) ?? []), child])
  return [...groups.entries()].map(([key, group]) => {
    const first = group[0]
    const lifecycle = group.filter(child => child.kind === 'lifecycle')
    const byListing = new Map<string, ManyStatusListing>()
    for (const child of lifecycle) for (const row of child.planRows ?? []) {
      const id = row.listingId ?? `${row.productId}:${row.sku}`
      const known = byListing.get(id)
      if (!known || PLAN_RANK[row.plan] < PLAN_RANK[known.plan]) byListing.set(id, { key: id, sku: row.sku, plan: row.plan, sentence: row.sentence })
    }
    const listings = [...byListing.values()].sort((a, b) => PLAN_RANK[a.plan] - PLAN_RANK[b.plan] || a.sku.localeCompare(b.sku))
    const results = lifecycle.flatMap(child => (child.rows ?? []).map((row, at): ManyStatusResult =>
      ({ key: `${child.publicationId}:${row.listingId ?? at}`, sku: row.sku, action: child.action, outcome: row.outcome, message: row.message })))
    const waiting = lifecycle.filter(waitingToSend)
    const sent = lifecycle.filter(child => child.status.toUpperCase() !== 'PREVIEW' && (child.sendCount ?? 0) > 0)
    const send = [...waiting, ...sent].reduce((n, child) => n + Math.max(0, child.sendCount ?? 0), 0)
    const refused = listings.filter(listing => listing.plan === 'refused').length
    const unchecked = group.find(child => child.kind !== 'lifecycle' && child.status.toUpperCase() === 'NOT_SENT')
    const quiet = lifecycle.find(child => child.nothingToSend)
    let state: ManyStatusRowState, reason: string | null = null
    if (!lifecycle.length) { state = 'not_checked'; reason = unchecked?.message?.replace(NOT_SENT_PREFIX, '') || NOT_CHECKED }
    else if (waiting.some(child => isExpired(child.expiresAt, now))) state = 'expired'
    else if (send > 0) state = 'ready'
    else if (refused > 0) { state = 'refused'; reason = quiet?.message ?? listings.find(listing => listing.plan === 'refused')?.sentence ?? null }
    else { state = 'nothing'; reason = quiet?.message ?? null }
    return { key, productId: first.productId, familySku: first.familySku ?? null, familyTitle: first.familyTitle ?? null,
      marketKey: manyChildMarketKey(first), channel: first.channel, marketplace: first.marketplace, children: group, state, send, refused, reason, listings, results }
  })
}

/** The market tab a batch child sits under (the same key as the pickers' market options). */
export const manyChildMarketKey = (child: Pick<PublicationBatchChild, 'channel' | 'marketplace' | 'accountId'>) =>
  publicationScopeKey({ channel: child.channel ?? '', marketplace: child.marketplace ?? '', accountId: child.accountId ?? '' })

/** The words in a Status row's Review column. */
export function manyStatusRowLabel(row: Pick<ManyStatusRow, 'state' | 'reason' | 'refused'>, target: ListedStatusTarget): { label: string; tone: Tone; hint: string } {
  switch (row.state) {
    case 'ready': return { label: `Set ${STATUS_TARGET_LABEL[target]}`, tone: target === 'active' ? 'info' : 'warning',
      hint: row.refused ? `${plural(row.refused, 'listing', 'listings')} here cannot change. Open the row to see why.` : 'Open the row to see each listing.' }
    case 'nothing': return { label: 'Nothing to change', tone: 'neutral', hint: row.reason ?? `Every listing here is already ${TARGET_WORD[target]}, or not on the channel.` }
    case 'refused': return { label: 'Not possible', tone: 'warning', hint: row.reason ?? 'Open the row to see why.' }
    case 'expired': return { label: 'Check expired', tone: 'warning', hint: 'A check lasts 2 hours. Check again to read the listings anew.' }
    case 'not_checked': return { label: 'Not checked', tone: 'danger', hint: row.reason ?? NOT_CHECKED }
  }
}

/** What a Status batch would do, over every row. */
export interface ManyStatusPlan {
  /** Listings it changes (rows ready to send). */
  listings: number
  /** Markets with at least one listing to change. */
  markets: number
  /** Listings that cannot change (every row). */
  refused: number
  /** Products × markets with nothing to change. */
  nothing: number
  /** Products × markets whose check expired. */
  expired: number
  /** Products × markets that could not be checked. */
  notChecked: number
  /** Listings it ends: the typed count Ended asks for. */
  ending: number
}

export function manyStatusPlan(rows: readonly ManyStatusRow[], now: number = Date.now()): ManyStatusPlan {
  const plan: ManyStatusPlan = { listings: 0, markets: 0, refused: 0, nothing: 0, expired: 0, notChecked: 0, ending: 0 }
  const markets = new Set<string>()
  for (const row of rows) {
    plan.refused += row.refused
    if (row.state === 'ready') { plan.listings += row.send; markets.add(row.marketKey) }
    else if (row.state === 'nothing') plan.nothing++
    else if (row.state === 'refused') { /* its listings count under `refused` above */ }
    else if (row.state === 'expired') plan.expired++
    else plan.notChecked++
  }
  plan.markets = markets.size
  plan.ending = manyEndingCount(rows.flatMap(row => row.children), now)
  return plan
}

/** The listings the send would end — as the server counts them (`manyEndCount`): waiting End children not expired. */
export const manyEndingCount = (children: readonly PublishPlanBatchChild[], now: number = Date.now()) =>
  manyEndCount(children.filter(child => !isExpired(child.expiresAt, now)))

/** "Set 36 listings inactive on 2 markets", "End 36 listings on 2 markets" — the one counted button. */
export function manyStatusButtonText(plan: Pick<ManyStatusPlan, 'listings' | 'markets'>, target: ListedStatusTarget): string {
  if (!plan.listings) return 'Nothing to change'
  const listings = plural(plan.listings, 'listing', 'listings'), markets = plural(plan.markets, 'market', 'markets')
  return target === 'ended' ? `End ${listings} on ${markets}` : `Set ${listings} ${TARGET_WORD[target]} on ${markets}`
}
/** "set inactive", "end" — what the summary says the listings are about to have done to them. */
const TARGET_VERB: Readonly<Record<ListedStatusTarget, string>> = { active: 'set active', inactive: 'set inactive', ended: 'end' }

/** The one line above the tabs: "36 listings to set inactive in 2 markets · 4 cannot · 12 with nothing to change" ("… to end …"). */
export function manyStatusSummary(plan: ManyStatusPlan, target: ListedStatusTarget): string {
  return [
    plan.listings ? `${plural(plan.listings, 'listing', 'listings')} to ${TARGET_VERB[target]} in ${plural(plan.markets, 'market', 'markets')}` : `No listing to ${TARGET_VERB[target]}`,
    plan.refused ? `${plan.refused.toLocaleString('en')} cannot` : null,
    plan.nothing ? `${plan.nothing.toLocaleString('en')} with nothing to change` : null,
    plan.expired ? `${plan.expired.toLocaleString('en')} expired` : null,
    plan.notChecked ? `${plan.notChecked.toLocaleString('en')} not checked` : null,
  ].filter(Boolean).join(' · ')
}

/**
 * One market tab's summary: "Inactive on Amazon · DE: 36 listings · 4 cannot", and why the listings that cannot change
 * cannot, most frequent first ("3 listings: Amazon holds FBA units…").
 */
export function manyStatusMarketSummary(rows: readonly ManyStatusRow[], target: ListedStatusTarget, market: string): { line: string; reasons: string[] } {
  const ready = rows.filter(row => row.state === 'ready')
  const listings = ready.reduce((n, row) => n + row.send, 0)
  const refused = rows.reduce((n, row) => n + row.refused, 0)
  const nothing = rows.filter(row => row.state === 'nothing').length
  const notChecked = rows.filter(row => row.state === 'not_checked' || row.state === 'expired').length
  const line = `${STATUS_TARGET_LABEL[target]} on ${market}: ` + [
    plural(listings, 'listing', 'listings'),
    refused ? `${refused.toLocaleString('en')} cannot` : null,
    nothing ? `${plural(nothing, 'product', 'products')} with nothing to change` : null,
    notChecked ? `${notChecked.toLocaleString('en')} not checked` : null,
  ].filter(Boolean).join(' · ')
  const counts = new Map<string, number>()
  for (const row of rows) for (const listing of row.listings) if (listing.plan === 'refused') counts.set(listing.sentence, (counts.get(listing.sentence) ?? 0) + 1)
  const reasons = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([sentence, n]) => `${plural(n, 'listing', 'listings')}: ${sentence}`)
  return { line, reasons }
}

/** A market tab's few words: "checking…", "36 listings", "4 cannot", "nothing to change"; while sending "2 of 5 done". */
export function manyStatusTabWords(rows: readonly ManyStatusRow[], stage: 'reviewing' | 'reviewed' | 'sending'): string {
  if (stage === 'reviewing') return 'checking…'
  if (stage === 'sending') {
    const children = rows.flatMap(row => row.children)
    const done = children.filter(child => child.terminal).length
    return done === children.length && children.length ? 'done' : `${done} of ${children.length} done`
  }
  const listings = rows.filter(row => row.state === 'ready').reduce((n, row) => n + row.send, 0)
  if (listings) return plural(listings, 'listing', 'listings')
  const refused = rows.reduce((n, row) => n + row.refused, 0)
  if (refused) return `${refused.toLocaleString('en')} cannot`
  if (rows.some(row => row.state === 'not_checked' || row.state === 'expired')) return 'not checked'
  return rows.length ? 'nothing to change' : 'no products'
}

