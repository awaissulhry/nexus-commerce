/**
 * Listings — the per-listing columns, the server's order and the column filters (step 4 of
 * docs/listings/LISTINGS-LIVE-LAYER-PLAN-2026-10-25.md).
 *
 * Which columns a page offers depends on its scope (`readinessScope.ts`):
 *   /listings                    none of them: a price or a quantity across markets would not be honest.
 *   a store page (/listings/ebay) all of them in Customise, hidden at first; Price only when the store's markets share one
 *                                currency. Values over several markets are never added up: a quantity reads as a range.
 *   a market page (/listings/ebay/it) all of them, shown: Status · Price · Qty · Channel ID · Last push · Synced · Channel
 *                                messages. The Markets column is called Readiness there; "On the channel" starts hidden
 *                                (Status says it per listing).
 * Without live data (an older API, a person without `listings.view`) none of these columns exist.
 *
 * The cells read a row's MAIN listings on the page's store and market (`listingChips`): not Shared, not a listing
 * customization, not a destination Nexus does not check. Every number is the API's (`ReadinessChip.live`).
 *
 * Header clicks sort on the server (`SORT_OF_COLUMN`); the live sorts and the column filters need the one destination
 * of a market page (`destinationColumnsReady`). AG owns a sort or a filter while its column exists, and the address
 * (`readinessQuery.ts`) mirrors it; `requestQuery` is what one request sends.
 *
 * Pure — no React — so every column set, word and mapping is a test.
 */
import type { GridFilterModel, GridFilterModelEntry } from '@nexus/shared/products-grid'
import {
  READINESS_LIVE_STATES,
  type ReadinessChip, type ReadinessColumnFilterKey, type ReadinessDestination, type ReadinessLiveSummary, type ReadinessPushSummary, type ReadinessSort,
} from '@nexus/shared/listing-readiness'
import type { SellingState } from '@nexus/shared/listing-actions'
import { AG_AUTO_COL } from '@/design-system/grid/columns/columnPrefs'
import { SELLING_STATE_TONE, SELLING_STATE_WORD } from '@/design-system/grid/renderers/sellingStatus'
import { publishFamilyMeta, publishResultMeta, type PublishStatusMeta } from '@/design-system/grid/renderers/publishStatus'
import type { Tone } from '@/design-system/primitives/tone'

import { CHANNEL_STATE_OPTIONS, channelStatesOf } from './liveFilters'
import { LIVE_COLUMN } from './liveMarks'
import { columnFilterValue, knownValues, type ReadinessPageQuery } from './readinessQuery'
import type { ReadinessLock } from './readinessScope'

/* ── The page's scope and its columns ─────────────────────────────────────────────────────────────────────────────── */

export type PageScope = 'all' | 'store' | 'market'
export const pageScopeOf = (lock: ReadinessLock | null): PageScope => (!lock ? 'all' : lock.marketplace ? 'market' : 'store')

/**
 * The grid's last-used layout key per kind of page (2026-10-26): `/listings` keeps the key it always had; store and
 * market pages get their own, so a market page's columns (On the channel hidden, the per-listing columns shown) never
 * change `/listings`. Named views are shared by every page (`viewsSurface: 'listing-readiness'`).
 */
export function lastUsedSurface(lock: ReadinessLock | null): string {
  const scope = pageScopeOf(lock)
  return scope === 'all' ? 'listing-readiness' : `listing-readiness:${scope}`
}

export const LISTING_COLUMNS = ['status', 'price', 'qty', 'channelId', 'lastPush', 'synced', 'messages'] as const
export type ListingColumn = (typeof LISTING_COLUMNS)[number]

const CHANNEL_ID_WORDS: Record<string, string> = { AMAZON: 'ASIN', EBAY: 'Item ID', SHOPIFY: 'Product ID', ETSY: 'Listing ID' }
/** The column's words. The channel id is the channel's own name for it ("ASIN", "Item ID") on a store or market page. */
export function listingColumnLabel(column: ListingColumn, channel?: string | null): string {
  switch (column) {
    case 'status': return 'Status'
    case 'price': return 'Price'
    case 'qty': return 'Qty'
    case 'channelId': return (channel && CHANNEL_ID_WORDS[channel]) || 'Channel ID'
    case 'lastPush': return 'Last push'
    case 'synced': return 'Synced'
    case 'messages': return 'Channel messages'
  }
}

/**
 * The per-listing columns a page offers: none on /listings or without live data; on a store page all of them but
 * Price when its markets do not share one currency (`currencies`: the store's markets' currencies).
 */
export function listingColumnsFor(scope: PageScope, { live, currencies }: { live: boolean; currencies: readonly string[] }): ListingColumn[] {
  if (!live || scope === 'all') return []
  const oneCurrency = new Set(currencies.filter(Boolean)).size <= 1
  return LISTING_COLUMNS.filter((column) => column !== 'price' || scope === 'market' || oneCurrency)
}

/** Shown at first: all of them on a market page; on a store page none (Customise offers them). */
export const listingColumnsShown = (scope: PageScope): boolean => scope === 'market'
/** The step-3 "On the channel" column: on a market page the Status column says it per listing, so it starts hidden there. */
export const onChannelShown = (scope: PageScope): boolean => scope !== 'market'

/** The page's columns, in order, for the Customise dialog. Product and Actions stay. On the channel: with live data only. */
export const READINESS_COLUMN_SPECS = [
  { key: 'product', label: 'Product', locked: true },
  { key: 'markets', label: 'Markets' },
  { key: LIVE_COLUMN, label: 'On the channel' },
  { key: 'nextStep', label: 'Next step' },
  { key: 'checked', label: 'Checked' },
  { key: 'actions', label: 'Actions', locked: true },
] as const

/** The Markets column's words: "Readiness" on a market page, where a row has one market. */
export const marketsLabel = (scope: PageScope): string => (scope === 'market' ? 'Readiness' : 'Markets')

/**
 * The Customise dialog's columns for a page (step 4): the per-listing ones (`listingColumns`, from `listingColumnsFor`)
 * right after Markets, then On the channel, Next step, Checked. `shown`: the columns visible at first.
 */
export function readinessColumnSpecs(scope: PageScope, { live, listingColumns, channel }: { live: boolean; listingColumns: readonly ListingColumn[]; channel: string | null }):
  Array<{ key: string; label: string; locked?: true; shown: boolean }> {
  const out: Array<{ key: string; label: string; locked?: true; shown: boolean }> = []
  for (const spec of READINESS_COLUMN_SPECS) {
    if (spec.key === LIVE_COLUMN && !live) continue
    if (spec.key === LIVE_COLUMN) {
      for (const column of listingColumns) out.push({ key: column, label: listingColumnLabel(column, channel), shown: listingColumnsShown(scope) })
      out.push({ key: spec.key, label: spec.label, shown: onChannelShown(scope) })
      continue
    }
    out.push({ key: spec.key, label: spec.key === 'markets' ? marketsLabel(scope) : spec.label, ...('locked' in spec && spec.locked ? { locked: true as const } : {}), shown: true })
  }
  return out
}

/** Where the per-listing columns go: right after Markets (Readiness), in this order, with On the channel after them. */
export const LIVE_COLUMN_ORDER: readonly string[] = [...LISTING_COLUMNS, LIVE_COLUMN]

/* ── The chips a row's columns read ───────────────────────────────────────────────────────────────────────────────── */

/**
 * A row's main listings on the page's store (and market, and the store chosen in Filters): never Shared, a listing
 * customization (alias) or a destination Nexus does not check (its `note`); only chips with live data.
 */
export function listingChips(chips: readonly ReadinessChip[], destinationOf: (key: string) => ReadinessDestination,
  where: { lock: ReadinessLock | null; accountId?: string }): ReadinessChip[] {
  return chips.filter((chip) => {
    if (!chip.live) return false
    const d = destinationOf(chip.destinationKey)
    if (d.channel === 'SHARED' || d.aliasKey || d.note) return false
    if (where.lock && d.channel !== where.lock.channel) return false
    if (where.lock?.marketplace && d.marketplace !== where.lock.marketplace) return false
    if (where.accountId && d.accountId !== where.accountId) return false
    return true
  })
}

/** What the per-listing cells say for one row: its listings here, summed where a sum is honest. */
export interface ListingFacts {
  /** The listings' state; Mixed when they differ. */
  state: SellingState
  /** Listings by state, plus the products with no listing here (as Not listed). */
  counts: Array<{ state: SellingState; count: number }>
  /** Products with a listing here, and without. */
  listed: number
  notListed: number
  priceMin: number | null
  priceMax: number | null
  /** One currency, or null when the listings' currencies differ or are unknown. */
  currency: string | null
  pricePinned: number
  priced: number
  /** One quantity, or a range when several destinations each have their own (never added up across them). */
  qty: { min: number; max: number } | null
  /** Several destinations (markets or stores) in the row. */
  places: number
  externalId: string | null
  url: string | null
  push: ReadinessPushSummary
  syncedOldest: string | null
  errors: number
  warnings: number
}

const STATE_ORDER: readonly SellingState[] = ['active', 'paused', 'mixed', 'not_listed', 'draft', 'ended', 'unknown']

/** The row's listing chips as one, or null when it has none (no live data, or not on this store). */
export function listingFacts(chips: readonly ReadinessChip[]): ListingFacts | null {
  const lives = chips.map((chip) => chip.live).filter((live): live is ReadinessLiveSummary => !!live)
  if (!lives.length) return null
  const counts = new Map<SellingState, number>()
  for (const live of lives) {
    for (const [state, n] of Object.entries(live.byState) as Array<[SellingState, number | undefined]>) {
      const key: SellingState = state === 'draft' ? 'not_listed' : state
      if (n) counts.set(key, (counts.get(key) ?? 0) + n)
    }
    if (live.notListed) counts.set('not_listed', (counts.get('not_listed') ?? 0) + live.notListed)
  }
  const states = new Set(lives.map((live) => live.state))
  const prices = lives.flatMap((live) => [live.priceMin, live.priceMax]).filter((p): p is number => p !== null)
  const currencies = new Set(lives.map((live) => live.currency))
  const quantities = lives.map((live) => live.quantity).filter((q): q is number => q !== null)
  const ids = new Set(lives.map((live) => live.externalId))
  const one = ids.size === 1 ? lives[0] : null
  const synced = lives.map((live) => live.lastSyncedAt).filter((at): at is string => !!at).sort()
  const push: ReadinessPushSummary = { worst: null, failed: 0, waiting: 0, done: 0, other: 0 }
  for (const live of lives) for (const key of ['failed', 'waiting', 'done', 'other'] as const) push[key] += live.push?.[key] ?? 0
  push.worst = (['failed', 'waiting', 'other', 'done'] as const).find((key) => push[key] > 0) ?? null
  return {
    state: states.size === 1 ? lives[0].state : 'mixed',
    counts: STATE_ORDER.filter((state) => counts.get(state)).map((state) => ({ state, count: counts.get(state)! })),
    listed: lives.reduce((n, live) => n + live.listed, 0),
    notListed: lives.reduce((n, live) => n + live.notListed, 0),
    priceMin: prices.length ? Math.min(...prices) : null,
    priceMax: prices.length ? Math.max(...prices) : null,
    currency: currencies.size === 1 ? lives[0].currency : null,
    pricePinned: lives.reduce((n, live) => n + (live.pricePinnedCount ?? 0), 0),
    priced: lives.reduce((n, live) => n + (live.pricedCount ?? 0), 0),
    qty: quantities.length ? { min: Math.min(...quantities), max: Math.max(...quantities) } : null,
    places: lives.length,
    externalId: one?.externalId ?? null,
    url: one?.url ?? null,
    push,
    syncedOldest: synced[0] ?? null,
    errors: lives.reduce((n, live) => n + live.channelErrorCount, 0),
    warnings: lives.reduce((n, live) => n + (live.channelWarningCount ?? 0), 0),
  }
}

/* ── The words ────────────────────────────────────────────────────────────────────────────────────────────────────── */

const count = (n: number) => n.toLocaleString('en')

/** The Status pill: the design system's word and tone; on Mixed the counts go in its tooltip ("18 Active · 2 Not listed"). */
export function statusWords(facts: ListingFacts): { label: string; tone: Tone; title: string } {
  const label = SELLING_STATE_WORD[facts.state]
  const parts = facts.counts.map((c) => `${count(c.count)} ${SELLING_STATE_WORD[c.state]}`).join(' · ')
  const several = facts.listed + facts.notListed > 1
  return { label, tone: SELLING_STATE_TONE[facts.state], title: facts.state === 'mixed' ? `${label}: ${parts}` : several && parts ? parts : label }
}

/** "€49.90", "€49.90–59.90" (one currency: the listings', or the euro when Nexus does not know it). */
export function priceWords(facts: Pick<ListingFacts, 'priceMin' | 'priceMax' | 'currency'>): string | null {
  if (facts.priceMin === null || facts.priceMax === null) return null
  const format = (n: number, symbol: boolean) => {
    try {
      return new Intl.NumberFormat('en-GB', symbol ? { style: 'currency', currency: facts.currency ?? 'EUR' } : { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
    } catch {
      return n.toFixed(2)
    }
  }
  return facts.priceMin === facts.priceMax ? format(facts.priceMin, true) : `${format(facts.priceMin, true)}–${format(facts.priceMax, false)}`
}

/** "Pinned" / "2 pinned" when the price is pinned on a listing; null when every price follows the master price. */
export function pinnedWords(facts: Pick<ListingFacts, 'pricePinned' | 'priced'>): { label: string; title: string } | null {
  if (!facts.pricePinned) return null
  const all = facts.pricePinned === facts.priced
  return {
    label: all ? 'Pinned' : `${count(facts.pricePinned)} pinned`,
    title: all ? 'The price is pinned on the listing: it does not follow the master price.'
      : `${count(facts.pricePinned)} of ${count(facts.priced)} prices are pinned on the listing; the rest follow the master price.`,
  }
}

/** The Qty cell: the quantity (a range across destinations, never a sum), "18 var." on a family, and its note. */
export function qtyWords(facts: ListingFacts, { family, channel }: { family: boolean; channel: string | null }): { text: string; aside: string | null; title: string } | null {
  if (!facts.qty) return null
  const text = facts.qty.min === facts.qty.max ? count(facts.qty.min) : `${count(facts.qty.min)}–${count(facts.qty.max)}`
  const notes = [
    facts.places > 1 ? 'Each market or store has its own quantity; they are not added up.' : null,
    family && facts.listed > 0 ? `The total of ${count(facts.listed)} listed ${facts.listed === 1 ? 'variation' : 'variations'}${facts.notListed ? `; ${count(facts.notListed)} not listed here` : ''}.` : null,
    channel === 'AMAZON' ? 'Amazon EU shares one quantity across its markets.' : null,
  ].filter(Boolean)
  return { text, aside: family && facts.listed > 0 ? `${count(facts.listed)} var.` : null, title: notes.join(' ') || `Quantity ${text}` }
}

/** The Channel ID cell: the id and its link; "per variation" when a family has no id of its own. */
export function channelIdWords(facts: ListingFacts): { id: string; url: string | null } | { perVariation: true } | null {
  if (facts.externalId) return { id: facts.externalId, url: facts.url }
  return facts.listed > 0 ? { perVariation: true } : null
}

/** The Last push pill (the design system's publish words): the worst, "3 of 20 failed" on a family. */
export function lastPushMeta(push: ReadinessPushSummary): PublishStatusMeta | null {
  const total = push.failed + push.waiting + push.done + push.other
  if (!push.worst || total === 0) return null
  if (push.failed > 0 && total > 1) return publishFamilyMeta(push.failed === total ? 'FAILED' : 'PARTIAL', { total, failed: push.failed })
  return publishResultMeta(push.worst === 'failed' ? 'FAILED' : push.worst === 'waiting' ? 'WAITING' : push.worst === 'done' ? 'ACCEPTED' : 'UNKNOWN')
}

/** The Channel messages cell: errors and warnings, one number with both in its tooltip. */
export function messageWords(facts: Pick<ListingFacts, 'errors' | 'warnings'>): { total: number; title: string } {
  const plural = (n: number, one: string) => `${count(n)} ${n === 1 ? one : `${one}s`}`
  return { total: facts.errors + facts.warnings, title: `${plural(facts.errors, 'error')} · ${plural(facts.warnings, 'warning')} on the channel` }
}

/* ── The server's order ───────────────────────────────────────────────────────────────────────────────────────────── */

/** The column a header click sorts, and the server's order it asks for. Next step sorts by how many problems a row has. */
export const SORT_OF_COLUMN: Readonly<Record<string, ReadinessSort>> = {
  [AG_AUTO_COL]: 'name', markets: 'state', nextStep: 'problems', checked: 'checked', status: 'status', price: 'price', qty: 'stock', synced: 'synced',
}
const COLUMN_OF_SORT: Readonly<Record<ReadinessSort, string>> = Object.fromEntries(Object.entries(SORT_OF_COLUMN).map(([column, sort]) => [sort, column])) as Record<ReadinessSort, string>
/** The sorts that read the one destination of a market page. */
export const DESTINATION_SORT_COLUMNS: readonly string[] = ['status', 'price', 'qty', 'synced']
/** The first click on these sorts high to low: the most problems, the newest. */
export const DESC_FIRST_COLUMNS: readonly string[] = ['nextStep']

/**
 * Does the page name ONE destination (the live sorts and the column filters need it)? A market page, and its store when
 * the market has more than one in the answer (`destinations`: the readiness destinations there, no alias).
 */
export function destinationColumnsReady(scope: PageScope, lock: ReadinessLock | null, accountId: string, destinations: readonly ReadinessDestination[]): boolean {
  if (scope !== 'market' || !lock) return false
  if (accountId) return true
  const stores = new Set(destinations.filter((d) => d.channel === lock.channel && d.marketplace === lock.marketplace && !d.aliasKey && !d.note).map((d) => d.accountId ?? ''))
  return stores.size <= 1
}

/** The columns a header click sorts on this page. */
export function sortableColumns(destinationReady: boolean): ReadonlySet<string> {
  return new Set(Object.keys(SORT_OF_COLUMN).filter((column) => destinationReady || !DESTINATION_SORT_COLUMNS.includes(column)))
}

export interface SortEntry { colId: string; sort: 'asc' | 'desc' }

/** AG's sort model → the server's order (the first sorted column it knows; none = the default). */
export function sortFromModel(model: readonly SortEntry[]): Pick<ReadinessPageQuery, 'sort' | 'dir'> {
  const entry = model.find((e) => SORT_OF_COLUMN[e.colId])
  return entry ? { sort: SORT_OF_COLUMN[entry.colId], dir: entry.sort } : { sort: '', dir: 'asc' }
}
/** The address's order → AG's sort model (the default is no sorted column). */
export function sortModelOf(query: Pick<ReadinessPageQuery, 'sort' | 'dir'>): SortEntry[] {
  return query.sort ? [{ colId: COLUMN_OF_SORT[query.sort], sort: query.dir }] : []
}

/* ── The column filters ───────────────────────────────────────────────────────────────────────────────────────────── */

/** The columns with a filter on a market page, and the address keys each writes (Status writes the Filters bar's `live`). */
export const FILTER_COLUMNS = ['status', 'price', 'qty', 'channelId'] as const
export type FilterColumn = (typeof FILTER_COLUMNS)[number]
type ColumnFilterFields = Pick<ReadinessPageQuery, 'live' | ReadinessColumnFilterKey>

/** The address → AG's filter model for the filter columns that exist. */
export function filterModelOf(query: ColumnFilterFields, columns: ReadonlySet<string>): GridFilterModel {
  const out: GridFilterModel = {}
  const range = (min: string, max: string): GridFilterModelEntry | null => (min || max
    ? { filterType: 'number', type: 'inRange', filter: min ? Number(min) : null, filterTo: max ? Number(max) : null } : null)
  const entries: Record<FilterColumn, GridFilterModelEntry | null> = {
    status: query.live.length ? { filterType: 'set', values: channelStatesOf({ live: query.live, flags: [] }) } : null,
    price: range(query.priceMin, query.priceMax),
    qty: range(query.qtyMin, query.qtyMax),
    channelId: query.channelId ? { filterType: 'text', type: 'contains', filter: query.channelId } : null,
  }
  for (const column of FILTER_COLUMNS) if (columns.has(column) && entries[column]) out[column] = entries[column]!
  return out
}

/** AG's filter model → the address keys of the filter columns that exist (the others keep the address's values). */
export function filtersFromModel(model: GridFilterModel, columns: ReadonlySet<string>, current: ColumnFilterFields): ColumnFilterFields {
  const next: ColumnFilterFields = { live: [...current.live], priceMin: current.priceMin, priceMax: current.priceMax, qtyMin: current.qtyMin, qtyMax: current.qtyMax, channelId: current.channelId }
  const bound = (value: unknown, key: ReadinessColumnFilterKey) => columnFilterValue(key, value ?? '')
  if (columns.has('status')) {
    const entry = model.status
    const values = entry?.filterType === 'set' ? entry.values : []
    next.live = knownValues(CHANNEL_STATE_OPTIONS.filter((o) => values.includes(o.value)).flatMap((o) => o.states), READINESS_LIVE_STATES)
  }
  for (const [column, min, max] of [['price', 'priceMin', 'priceMax'], ['qty', 'qtyMin', 'qtyMax']] as const) {
    if (!columns.has(column)) continue
    const entry = model[column]
    next[min] = entry?.filterType === 'number' ? bound(entry.filter, min) : ''
    next[max] = entry?.filterType === 'number' ? bound(entry.filterTo, max) : ''
  }
  if (columns.has('channelId')) {
    const entry = model.channelId
    next.channelId = entry?.filterType === 'text' ? columnFilterValue('channelId', entry.filter) : ''
  }
  return next
}

/**
 * What one request sends: the address, with AG's sort and filters where their columns exist — AG starts the read
 * BEFORE the page hears of a header click (its own listeners first), so the request takes them from AG. A column that
 * does not exist yet (the live columns wait for the first answer) leaves the address's value as it is.
 */
export function requestQuery(query: ReadinessPageQuery, grid: { sortModel?: readonly SortEntry[]; filterModel?: GridFilterModel; columns: ReadonlySet<string> }): ReadinessPageQuery {
  const sortOwner = query.sort ? COLUMN_OF_SORT[query.sort] : null
  const fromGrid = sortFromModel(grid.sortModel ?? [])
  const order = fromGrid.sort || !sortOwner || grid.columns.has(sortOwner) ? fromGrid : { sort: query.sort, dir: query.dir }
  return { ...query, ...order, ...filtersFromModel(grid.filterModel ?? {}, grid.columns, query) }
}

/** The grid's state differs from the address for the columns that exist: what to put into AG (null = nothing). */
export function gridStateToApply(query: ReadinessPageQuery, grid: { sortModel: readonly SortEntry[]; filterModel: GridFilterModel; columns: ReadonlySet<string> }):
  { sort: SortEntry[] | null; filter: GridFilterModel | null } {
  const wantSort = sortModelOf(query).filter((e) => grid.columns.has(e.colId))
  const haveSort = grid.sortModel.filter((e) => SORT_OF_COLUMN[e.colId])
  const sortDiffers = JSON.stringify(wantSort) !== JSON.stringify(haveSort) && !(query.sort && !wantSort.length && !haveSort.length)
  const wantFilter = filterModelOf(query, grid.columns)
  const keep = Object.fromEntries(Object.entries(grid.filterModel).filter(([column]) => !(FILTER_COLUMNS as readonly string[]).includes(column) || !grid.columns.has(column)))
  const haveOwn = Object.fromEntries(Object.entries(grid.filterModel).filter(([column]) => (FILTER_COLUMNS as readonly string[]).includes(column) && grid.columns.has(column)))
  const filterDiffers = JSON.stringify(normalize(wantFilter)) !== JSON.stringify(normalize(haveOwn))
  return { sort: sortDiffers ? wantSort : null, filter: filterDiffers ? { ...keep, ...wantFilter } : null }
}
/** A filter model in one spelling (sorted keys, sorted set values, no undefined bounds), to compare two. */
function normalize(model: GridFilterModel): unknown {
  return Object.keys(model).sort().map((column) => {
    const entry = model[column]
    if (entry.filterType === 'set') return [column, 'set', [...entry.values].sort()]
    if (entry.filterType === 'number') return [column, 'number', entry.filter ?? null, entry.filterTo ?? null]
    return [column, 'text', entry.filter]
  })
}

/** The columns the grid starts with: Product, Markets, Next step, Checked, and the per-listing ones it starts with. */
export function initialColumnIds(listingColumns: readonly string[]): Set<string> {
  return new Set([AG_AUTO_COL, 'markets', 'nextStep', 'checked', ...listingColumns])
}

/**
 * The grid's first state with the address's order and column filters, for the columns it starts with (AG reads its
 * first state once; a column that arrives later gets them from the page when it does).
 */
export function initialGridState<S extends object>(state: S | undefined, query: ReadinessPageQuery, columns: ReadonlySet<string>):
  (S & { sort?: { sortModel: SortEntry[] }; filter?: { filterModel: GridFilterModel } }) | undefined {
  const sortModel = sortModelOf(query).filter((e) => columns.has(e.colId))
  const filterModel = filterModelOf(query, columns)
  if (!sortModel.length && !Object.keys(filterModel).length) return state as (S & { sort?: { sortModel: SortEntry[] } }) | undefined
  return { ...(state ?? {}), ...(sortModel.length ? { sort: { sortModel } } : {}), ...(Object.keys(filterModel).length ? { filter: { filterModel } } : {}) } as S & { sort?: { sortModel: SortEntry[] }; filter?: { filterModel: GridFilterModel } }
}
