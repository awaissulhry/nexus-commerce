/**
 * Sheet publish parity T1 (item 6) — the Publish dialog for many products at once, opened from the products list.
 *
 * Pure rules. The server reviews every family × destination in the background (`POST /api/publication-batches` with
 * product ids), waits as REVIEWED, then sends on `POST …/:id/submit`. This file decides what each reviewed row says,
 * what the one counted button says, and when a selection is too large — so the dialog, its tests and the screen agree.
 */
import type { PublicationBatchChild, PublicationBatchView, StudioPublishScope } from '@nexus/shared/studio-publication'
import type { Tone } from '@/design-system/primitives/tone'
import type { PublicationDestinationOption } from './model'

/** The server's limits (`publication-batch.service.ts`). */
export const MAX_BATCH_PRODUCTS = 200
export const MAX_BATCH_REVIEWS = 1_000

/**
 * Channels a many-product publish can reach. Amazon and eBay are reviewed field by field and sent without a question
 * per product; Shopify needs a stock location and an overwrite confirmation for each product, and Etsy cannot be
 * published from Nexus yet — both stay in each product's own Publish window.
 */
export const MANY_CHANNELS = ['AMAZON', 'EBAY'] as const
export const manyDestinationOptions = (options: readonly PublicationDestinationOption[]) =>
  options.filter(o => (MANY_CHANNELS as readonly string[]).includes(o.scope.channel) && !o.scope.listingId)
export const MANY_CHANNELS_NOTE = 'Amazon and eBay only. Publish Shopify and Etsy from each product’s own Publish window: Shopify asks for a stock location and a confirmation per product.'

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

/** One reviewed family × destination, before anything is sent. */
export type ManyRowState =
  | { kind: 'ready'; changes: number }
  | { kind: 'nothing'; reason: string }
  | { kind: 'problems'; problems: number; reason: string | null }
  | { kind: 'expired' }
  | { kind: 'not_sent'; reason: string }

export function manyRowState(child: Pick<PublicationBatchChild, 'status' | 'message' | 'problems' | 'selectedCount' | 'expiresAt' | 'nothingToSend'>, now: number = Date.now()): ManyRowState {
  const status = child.status.toUpperCase()
  if (status === 'BLOCKED') return { kind: 'problems', problems: child.problems?.errors ?? 0, reason: child.message }
  if (status === 'NOT_SENT') {
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
}

export function manyPlan(children: readonly PublicationBatchChild[], now: number = Date.now()): ManyPlan {
  const plan: ManyPlan = { listings: 0, changes: 0, problems: 0, expired: 0, nothing: 0, problemCount: 0 }
  for (const child of children) {
    const state = manyRowState(child, now)
    if (state.kind === 'ready') { plan.listings++; plan.changes += state.changes }
    else if (state.kind === 'nothing') plan.nothing++
    else if (state.kind === 'expired') plan.expired++
    else { plan.problems++; if (state.kind === 'problems') plan.problemCount += state.problems }
  }
  return plan
}

/** "Publish 214 changes to 12 listings · skip 3 with problems" — the one counted button. */
export function manyPublishButtonText(plan: ManyPlan): string {
  const skips = [plan.problems ? `skip ${plan.problems} with problems` : null, plan.expired ? `${plan.expired} expired` : null].filter(Boolean)
  const tail = skips.length ? ` · ${skips.join(' · ')}` : ''
  if (!plan.listings) return `Nothing to publish${tail}`
  return `Publish ${plural(plan.changes, 'change', 'changes')} to ${plural(plan.listings, 'listing', 'listings')}${tail}`
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

/** The batch request body for the background review. */
export const manyRequest = (productIds: readonly string[], destinations: readonly StudioPublishScope[], replaceDiffers: boolean) => ({
  productIds: [...productIds],
  destinations: destinations.map(({ channel, marketplace, accountId }) => ({ channel, marketplace, accountId })),
  options: { replaceDiffers },
})

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
