/**
 * The Listings page's selection, bulk bar and row menu (step 6 of docs/listings/LISTINGS-LIVE-LAYER-PLAN-2026-10-25.md),
 * in words and decisions. Pure — no React, no fetch — so every reach, hold and sentence is a test; the page
 * (`ListingReadinessClient.tsx`, `useListingsBulk.tsx`) only draws what these say.
 *
 * A row is a product; a family row stands for its family and counts once. The bar says which listings an action
 * reaches BEFORE anything runs: the API answers that (`POST /api/catalog-transfer/readiness/listing-ids`, the
 * readiness ⇄ listing join rule) for the selected products on the destinations in scope — on a market page its own
 * destination(s), elsewhere every destination in view, narrowed by the Channel, Market and Store filters. Every write
 * is an existing endpoint with its own checks: `POST /api/listings/bulk-action` (Set price, Follow master, Stop
 * following master), the Publish window, the Translate window.
 */
import type { ReadinessChip, ReadinessDestination } from '@nexus/shared/listing-readiness'
import type { MenuItemDef } from '@/design-system/components/Menu'
import { channelIdLabel, openHeldReason, publishStartKey } from './listingDialogModel'
import { channelLabel, plural } from './marketChips'
import { marketCount, type ReadinessLock } from './readinessScope'
import { isFamilyRow, isMemberRow, isReadinessFooter, type ReadinessDataRow, type ReadinessGridRow } from './readinessRows'

/** The bulk-action route's own cap (`POST /api/listings/bulk-action`: "Max 1000 listings per bulk action"). */
export const BULK_LISTINGS_MAX = 1000
/** The Publish window takes this many products at once (the Products page's `BULK_MAX`). */
export const BULK_PUBLISH_MAX = 200
/** Translate's readiness scope takes 1–200 product ids (`readinessQuery`). */
export const BULK_TRANSLATE_MAX = 200
/** The reach endpoint's cap. */
export const BULK_REACH_MAX = 1000

/* ── The selection ──────────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * May a row be ticked? A product or family, yes. Not the family footer, and not the parent's own listing inside an open
 * family ("Parent listing"): it carries the family root's id, so ticking it would tick the whole family.
 */
export function isSelectableRow(row: ReadinessGridRow | null | undefined): boolean {
  if (!row || isReadinessFooter(row)) return false
  return !(isMemberRow(row) && row.isParentListing)
}

export interface BulkSelection {
  /** The products to ask about and act on: each ticked family or product once; a variation of a ticked family is in it already. */
  productIds: string[]
  /** "12 products selected": a family counts once. */
  count: number
  /** The families it touches: the Publish window's count. */
  families: number
}

export const EMPTY_SELECTION: BulkSelection = { productIds: [], count: 0, families: 0 }

/** The ticked rows, as the bar counts them. */
export function bulkSelection(rows: readonly ReadinessDataRow[]): BulkSelection {
  const ticked = new Set(rows.filter((r) => !isMemberRow(r)).map((r) => r.id))
  const ids: string[] = []
  const roots = new Set<string>()
  for (const row of rows) {
    const root = isMemberRow(row) ? row.parentId ?? row.id : row.id
    roots.add(root)
    // A variation whose family row is ticked too is in that family already.
    if (isMemberRow(row) && row.parentId && ticked.has(row.parentId)) continue
    if (!ids.includes(row.id)) ids.push(row.id)
  }
  return { productIds: ids, count: ids.length, families: roots.size }
}

/** The selection's identity: the reach is asked again only when it changes. */
export const selectionKey = (selection: BulkSelection): string => selection.productIds.join('\n')

/* ── Destinations in scope ──────────────────────────────────────────────────────────────────────────────────────── */

// The readiness index says UK where a listing (or an older link) may say GB.
const marketCode = (code: string | null | undefined) => {
  const upper = (code ?? '').trim().toUpperCase()
  return upper === 'GB' ? 'UK' : upper
}

/**
 * The destinations an action reaches: the page's destinations (on a market page those are its own), narrowed by the
 * Channel, Market and Store filters, once each, in the page's order.
 */
export function destinationsInScope(
  destinations: readonly ReadinessDestination[],
  filters: { channel?: string; marketplace?: string; accountId?: string },
): ReadinessDestination[] {
  const channel = (filters.channel ?? '').toUpperCase()
  const market = marketCode(filters.marketplace)
  const seen = new Set<string>()
  return destinations.filter((d) => {
    if (seen.has(d.key)) return false
    seen.add(d.key)
    if (channel && d.channel !== channel) return false
    if (market && (d.channel === 'SHARED' || marketCode(d.marketplace) !== market)) return false
    if (filters.accountId && (d.channel === 'SHARED' || d.accountId !== filters.accountId)) return false
    return true
  })
}

/** Where a price action can land: a store's own listing, never Shared (it has none) nor a second listing (an alias). */
export function priceDestinations(destinations: readonly ReadinessDestination[]): ReadinessDestination[] {
  return destinations.filter((d) => d.channel !== 'SHARED' && !d.aliasKey)
}

/** Where the Publish window starts: the destinations in scope, as its option keys. */
export function publishKeys(destinations: readonly ReadinessDestination[]): string[] {
  return destinations.map(publishStartKey).filter((key): key is string => key !== null)
}

/**
 * Where, in words: "Amazon DE"; "eBay IT (2 stores)"; "5 Amazon markets"; "12 markets". Shared is not a market.
 */
export function placeWords(destinations: readonly ReadinessDestination[]): string {
  const stores = destinations.filter((d) => d.channel !== 'SHARED')
  if (stores.length === 0) return 'no store'
  if (stores.length === 1) return stores[0].label
  const markets = marketCount(stores)
  const channels = [...new Set(stores.map((d) => d.channel))]
  if (channels.length === 1 && markets === 1) {
    const market = stores[0].marketplace && stores[0].marketplace !== 'GLOBAL' ? ` ${stores[0].marketplace}` : ''
    return `${channelLabel(channels[0])}${market} (${stores.length} stores)`
  }
  if (channels.length === 1) return `${markets.toLocaleString('en')} ${channelLabel(channels[0])} markets`
  return plural(markets, 'market')
}

/* ── The reach (the API's answer) ───────────────────────────────────────────────────────────────────────────────── */

/** `POST /api/catalog-transfer/readiness/listing-ids`. */
export interface ListingReach {
  listingIds: string[]
  /** Products with at least one listing reached. */
  products: number
  /** Product × destination pairs where the product belongs but has no listing. */
  missing: number
  /** Second listings (aliases) on these destinations, left out. */
  aliases: number
  /** The reached listings' currencies, once each; null = a market Nexus has no currency for. */
  currencies: Array<string | null>
  /** Every product the selection covers (a family's variations included). */
  productIds: string[]
}

/** The request body. */
export function reachBody(selection: BulkSelection, destinations: readonly ReadinessDestination[]): { productIds: string[]; destinationKeys: string[] } {
  return { productIds: selection.productIds, destinationKeys: priceDestinations(destinations).map((d) => d.key) }
}

/** Where the reach stands: being counted, counted, or not countable (and why). */
export type ReachState = { kind: 'counting' } | { kind: 'counted'; reach: ListingReach } | { kind: 'failed'; error: string }

/**
 * The note beside the count: "reaches 214 listings on Amazon DE · 6 products not listed there · 1 second listing left
 * out". Null when the scope has no store (only Shared).
 */
export function reachWords(state: ReachState, destinations: readonly ReadinessDestination[]): string | null {
  const stores = priceDestinations(destinations)
  if (stores.length === 0) return null
  const place = placeWords(stores)
  if (state.kind === 'counting') return `counting the listings on ${place}…`
  if (state.kind === 'failed') return `the listings on ${place} could not be counted: ${state.error}`
  const { reach } = state
  const parts = [`reaches ${plural(reach.listingIds.length, 'listing')} on ${place}`]
  if (reach.missing > 0) parts.push(stores.length === 1 ? `${plural(reach.missing, 'product')} not listed there` : `not listed in ${plural(reach.missing, 'place')}`)
  if (reach.aliases > 0) parts.push(`${plural(reach.aliases, 'second listing')} left out`)
  return parts.join(' · ')
}

/* ── Why an action is held ──────────────────────────────────────────────────────────────────────────────────────── */

/** The API's own words for a person without `products.price.edit` (the legacy page holds its price controls with them). */
export const PRICE_PERMISSION_REASON = 'You do not have permission to change prices (products.price.edit)'
export const BUSY_REASON = 'Wait for the last bulk action to finish.'

export interface PriceHoldInput {
  state: ReachState | null
  destinations: readonly ReadinessDestination[]
  canEditPrice: boolean
  busy: boolean
}

/** Follow master and Stop following master: held while nothing can be reached, or more than the route takes. */
export function followHeld({ state, destinations, canEditPrice, busy }: PriceHoldInput): string | null {
  if (busy) return BUSY_REASON
  if (!canEditPrice) return PRICE_PERMISSION_REASON
  if (priceDestinations(destinations).length === 0) return 'Shared has no listings: choose a store or market in Filters.'
  if (!state || state.kind === 'counting') return 'Counting the listings…'
  if (state.kind === 'failed') return `The listings could not be counted: ${state.error}`
  const n = state.reach.listingIds.length
  if (n === 0) return 'None of the selected products is listed here.'
  if (n > BULK_LISTINGS_MAX) {
    return `One bulk change reaches at most ${BULK_LISTINGS_MAX.toLocaleString('en')} listings; this one would reach ${n.toLocaleString('en')}. Select fewer products.`
  }
  return null
}

/**
 * Set price: also only on a store or market page (the plan's rule), and only when every listing it reaches has one
 * currency — one typed number is never sent as euros to one market and pounds to another.
 */
export function setPriceHeld(input: PriceHoldInput & { lock: ReadinessLock | null }): string | null {
  if (input.busy) return BUSY_REASON
  if (!input.canEditPrice) return PRICE_PERMISSION_REASON
  if (!input.lock) return 'Set a price on a store or market page (the Listings menu).'
  const held = followHeld(input)
  if (held) return held
  const currencies = input.state?.kind === 'counted' ? input.state.reach.currencies : []
  if (currencies.length > 1) return 'Prices differ by market: open one market.'
  if (currencies[0] == null) return 'Nexus has no currency for this market: set the price in the Listing window.'
  return null
}

/** The one currency of a reach Set price may use; null when there is not exactly one. */
export function reachCurrency(state: ReachState | null): string | null {
  if (state?.kind !== 'counted' || state.reach.currencies.length !== 1) return null
  return state.reach.currencies[0]
}

/** Publish…: the window's own review and gates do the rest; it takes 200 products at once. */
export function publishHeld(selection: BulkSelection, busy: boolean): string | null {
  if (busy) return BUSY_REASON
  if (selection.count > BULK_PUBLISH_MAX) return `Select ${BULK_PUBLISH_MAX} or fewer products to publish.`
  return null
}

/**
 * Translate selected…: the Translate window on these products (a family's variations included), in the language the
 * Language filter names. Changes Nexus only: the shared text in that language.
 */
export function translateSelectedScope(state: ReachState | null, language: string, page: { columnFilters?: number; problem?: boolean } = {}):
  { ok: true; query: { productIds: string; language: string } } | { ok: false; reason: string } {
  if (!language) return { ok: false, reason: 'Choose a language in Filters first: Translate writes one language.' }
  // As Translate filtered products (`translateScope`): never while a column filter or a problem narrows the page.
  if ((page.columnFilters ?? 0) > 0) return { ok: false, reason: 'Translate cannot narrow by the column filters. Clear them first.' }
  if (page.problem) return { ok: false, reason: 'Translate cannot narrow to one problem. Remove the problem chip first.' }
  if (!state || state.kind === 'counting') return { ok: false, reason: 'Counting the products…' }
  if (state.kind === 'failed') return { ok: false, reason: `The products could not be counted: ${state.error}` }
  const ids = state.reach.productIds
  if (ids.length === 0) return { ok: false, reason: 'None of the selected products is in Nexus any more.' }
  if (ids.length > BULK_TRANSLATE_MAX) {
    return { ok: false, reason: `Translate takes at most ${BULK_TRANSLATE_MAX} products at once; this selection covers ${ids.length.toLocaleString('en')} with its variations. Select fewer.` }
  }
  return { ok: true, query: { productIds: ids.join(','), language } }
}

/* ── The confirms ───────────────────────────────────────────────────────────────────────────────────────────────── */

export type BulkPriceAction = 'set-price' | 'follow-master' | 'unfollow-master'

/** "€49.90"; the bare number when the currency is not one `Intl` knows. */
export function priceText(value: number, currency: string | null): string {
  if (currency) {
    try { return new Intl.NumberFormat('en', { style: 'currency', currency }).format(value) } catch { /* below */ }
  }
  return `${value.toFixed(2)}${currency ? ` ${currency}` : ''}`
}

const reachLine = (reach: ListingReach, place: string) =>
  `${plural(reach.listingIds.length, 'listing')} of ${plural(reach.products, 'product')} on ${place}.`

/** The confirm before Set price: what it reaches, what it sends, and that there is no undo. */
export function setPriceConfirm(reach: ListingReach, place: string, price: number, currency: string | null) {
  const money = priceText(price, currency)
  return {
    level: 'confirm' as const,
    title: `Set ${money} on ${plural(reach.listingIds.length, 'listing')}?`,
    confirmLabel: `Set ${money}`,
    consequences: [
      reachLine(reach, place),
      `Each listing keeps ${money} as its own price and stops following the master price.`,
      'Nexus sends each price to its channel after a 30-second hold. A price outside a product’s floor or ceiling is refused for that listing.',
      'There is no undo: the listings’ earlier prices are not kept. Follow master puts them back on the master price.',
    ],
  }
}

/** The confirm before Follow master: it clears each listing's own price, so it says there is no undo. */
export function followMasterConfirm(reach: ListingReach, place: string) {
  return {
    level: 'confirm' as const,
    title: `Follow the master on ${plural(reach.listingIds.length, 'listing')}?`,
    confirmLabel: 'Follow master',
    consequences: [
      reachLine(reach, place),
      'Each listing’s own price is cleared: its price is worked out from the master price by its rule again, and Nexus sends it after a 30-second hold.',
      'Its quantity, title, description, photos and bullet points follow the master too. An Amazon FBA quantity is never changed.',
      'There is no undo: the listings’ own prices are not kept.',
    ],
  }
}

/* ── The job's answer ───────────────────────────────────────────────────────────────────────────────────────────── */

/** `GET /api/listings/bulk-action/:jobId`, the part the bar reads. */
export interface BulkJob {
  status: string
  total: number
  processed: number
  succeeded: number
  failed: number
  /** Failures and notes, each by listing ("Not sent: …", "Quantity not changed: …" are notes). */
  errors?: Array<{ listingId?: string; reason?: string }>
  /** The listings a follow / unfollow master changed: what its Undo puts back. */
  changed?: string[]
}

const FINISHED = new Set(['COMPLETED', 'PARTIALLY_COMPLETED', 'FAILED'])
export const jobFinished = (job: Pick<BulkJob, 'status'> | null | undefined): boolean => !!job && FINISHED.has(job.status)

const NOTE = /^(Not sent|Quantity not changed): /
const PAST: Record<BulkPriceAction, string> = {
  'set-price': 'Price set on',
  'follow-master': 'Following the master on',
  'unfollow-master': 'Stopped following the master on',
}
const RUNNING: Record<BulkPriceAction, string> = {
  'set-price': 'Setting prices',
  'follow-master': 'Following the master',
  'unfollow-master': 'Stopping following the master',
}

/** "Setting prices: 40 of 214". */
export function jobProgress(action: BulkPriceAction, job: Pick<BulkJob, 'processed' | 'total'> | null): string {
  return job ? `${RUNNING[action]}: ${job.processed.toLocaleString('en')} of ${job.total.toLocaleString('en')}` : `${RUNNING[action]}…`
}

/** What a finished job did, in one sentence, with the channel's or Nexus's first reason word for word. */
export function jobOutcome(action: BulkPriceAction, job: BulkJob): { tone: 'success' | 'warning' | 'danger'; text: string } {
  const entries = (job.errors ?? []).filter((e) => typeof e?.reason === 'string')
  const notes = entries.filter((e) => NOTE.test(e.reason ?? ''))
  const failures = entries.filter((e) => !NOTE.test(e.reason ?? ''))
  const parts = [`${PAST[action]} ${plural(job.succeeded, 'listing')}`]
  if (job.failed > 0) parts.push(`${job.failed.toLocaleString('en')} failed${failures[0]?.reason ? `: ${failures[0].reason}` : ''}`)
  if (notes.length > 0) parts.push(`${plural(notes.length, 'note')}: ${notes[0].reason}`)
  const sent = action !== 'unfollow-master' && job.succeeded > 0 ? ' Nexus sends the prices after a 30-second hold.' : ''
  const tone = job.failed > 0 && job.succeeded === 0 ? 'danger' : job.failed > 0 || notes.length > 0 ? 'warning' : 'success'
  return { tone, text: `${parts.join(' · ')}.${sent}` }
}

/** The bar stopped watching a job that is still running. */
export function jobStillRunning(action: BulkPriceAction, job: Pick<BulkJob, 'processed' | 'total'> | null): string {
  return `${jobProgress(action, job)} — still running after a minute. The page updates when it finishes.`
}

/* ── One row's menu: the ⋯ column and the right-click menu read the same list ────────────────────────────────────── */

/** The chip's own link and channel id: a variation's listing first, else what the row's listings here share. */
export function chipLinks(chip: Pick<ReadinessChip, 'live' | 'listing'> | null | undefined): { url: string | null; externalId: string | null } {
  return {
    url: chip?.listing?.url ?? chip?.live?.url ?? null,
    externalId: chip?.listing?.externalId ?? chip?.live?.externalId ?? null,
  }
}

/** The destination a row's menu acts on: the chip under the pointer when the row has it, else where Open opens. */
export function menuDestination(row: Pick<ReadinessDataRow, 'chips'>, asked: string | null | undefined, fallback: string | null): string | null {
  if (asked && row.chips.some((c) => c.destinationKey === asked)) return asked
  return fallback
}

export interface RowMenuDeps {
  destination: (key: string) => ReadinessDestination
  /** Open the Listing window on this row and destination. */
  openListing: (row: ReadinessDataRow, key: string) => void
  /** Same-tab navigation to a studio path (the page adds the business). */
  edit: (row: ReadinessDataRow) => void
  publish: (row: ReadinessDataRow, key: string | null) => void
  copy: (text: string, what: string) => void
}

/**
 * Open listing · Edit in studio · Open on <channel> (when the chip has a link) · Publish… · Copy SKU · Copy <ASIN | Item
 * ID …> (when the chip has one). Plain-string labels: AG's context menu takes `name: string`.
 */
export function rowMenuItems(row: ReadinessDataRow, key: string | null, deps: RowMenuDeps): MenuItemDef[] {
  const chip = key ? row.chips.find((c) => c.destinationKey === key) ?? null : null
  const destination = key ? deps.destination(key) : null
  const { url, externalId } = chipLinks(chip)
  const store = destination && destination.channel !== 'SHARED' ? destination : null
  const held = openHeldReason(row)
  const items: MenuItemDef[] = [
    key && !held
      ? { id: 'open', label: 'Open listing', onSelect: () => deps.openListing(row, key) }
      : { id: 'open', label: 'Open listing', disabled: true, description: held ?? 'Nothing to open here.' },
    { id: 'edit', label: 'Edit in studio', onSelect: () => deps.edit(row) },
  ]
  if (store && url) items.push({ id: 'channel', label: `Open on ${channelLabel(store.channel)}`, href: url, target: '_blank' })
  items.push({ id: 'publish', label: 'Publish…', onSelect: () => deps.publish(row, key) })
  items.push({ id: 'copy-sku', label: 'Copy SKU', onSelect: () => deps.copy(row.sku, 'SKU') })
  if (store && externalId) {
    const what = channelIdLabel(store.channel, isFamilyRow(row) && row.isParent)
    items.push({ id: 'copy-id', label: `Copy ${what}`, onSelect: () => deps.copy(externalId, what) })
  }
  return items
}
