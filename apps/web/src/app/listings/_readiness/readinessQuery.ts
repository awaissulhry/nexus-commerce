/**
 * Listing readiness — the page's query, read from and written to the address (rebuild 2026-10-23, layout A).
 *
 * Every link that ever opened this page keeps working: the Products menu (`?productIds=`), the Listings pages
 * (`?listingIds=`), an import's review (`?job=`), the studio's progress cards (`?channel=&marketplace=&language=`) and
 * older bookmarks (`?skus=`, `?familyId=`, `?market=`, `?state=`, `?accountId=`, `?page=`). The new page adds `q`
 * (search), `pageSize`, `parent` (one family's page) and the `notChecked` tile state; the live layer (step 3 of
 * docs/listings/LISTINGS-LIVE-LAYER-PLAN-2026-10-25.md) adds `live` (channel states) and `flags` (live flags), each a
 * comma list, sent to the API under the same names. Step 4 adds the server's order (`sort`, `dir`; none = state, worst
 * first) and the market page's column filters (`priceMin`, `priceMax`, `qtyMin`, `qtyMax`, `channelId`; the Status
 * column filter writes `live`).
 * Step 7 adds `view` (`problems`: the Problems view; never sent) and
 * `problem` (one row of it, sent to the API: the families with that problem — the Problems view's Show products).
 * Step 8 (the legacy exit) reads the old Listings page's options too, in this page's words (`legacyListingOptions.ts`).
 *
 * Pure — no React, no fetch — so every mapping is a test.
 */
import {
  READINESS_COLUMN_FILTER_KEYS,
  READINESS_LIVE_FLAGS,
  READINESS_LIVE_STATES,
  READINESS_SORTS,
  type ReadinessColumnFilterKey,
  type ReadinessLiveFlag,
  type ReadinessLiveState,
  type ReadinessSort,
  type ReadinessSortDir,
  type ReadinessStateFilter,
} from '@nexus/shared/listing-readiness'
import { SCOPE_READINESS_STATES } from '@/design-system/grid/renderers/readiness'
import { lockedKeys, readinessPath, type ReadinessLock } from './readinessScope'
import { withLegacyListingOptions } from './legacyListingOptions'

export const READINESS_PAGE_SIZES = [50, 100, 200] as const
export type ReadinessPageSize = (typeof READINESS_PAGE_SIZES)[number]
export const DEFAULT_READINESS_PAGE_SIZE: ReadinessPageSize = 50
/** An open family shows at most this many rows, then the family footer ("Showing 10 of 40 variations"). */
export const MEMBER_PREVIEW_LIMIT = 10

/** A link's own selection. The API takes one at a time (`readinessQuery` refuses two). */
export type SelectorKind = 'productIds' | 'listingIds' | 'job' | 'skus'
export const SELECTOR_KINDS: readonly SelectorKind[] = ['productIds', 'listingIds', 'job', 'skus']
export interface ReadinessSelector { kind: SelectorKind; value: string }

/** The filters the Filters panel sets (and a saved view keeps). */
export type ReadinessFilterKey = 'channel' | 'marketplace' | 'accountId' | 'language' | 'familyId'
export const FILTER_KEYS: readonly ReadinessFilterKey[] = ['channel', 'marketplace', 'accountId', 'language', 'familyId']

/** The grid card shows products (the families) or problems (one row per problem × destination; live layer step 7). */
export type ReadinessView = 'products' | 'problems'

export interface ReadinessPageQuery {
  selector: ReadinessSelector | null
  familyId: string
  channel: string
  marketplace: string
  accountId: string
  language: string
  /** A tile (`blocked`, `warn`, `ready`, `notChecked`) or an older link's own state (`absent`, `notComputed`). */
  state: ReadinessStateFilter | ''
  /** The live layer: the listings' states on the channel (the Channel state filter, the Live tile). Empty = any. */
  live: ReadinessLiveState[]
  /** The live layer: flags every listing must carry (the Errors, Suppressed and Out of sync tiles; Stock › Low stock). */
  flags: ReadinessLiveFlag[]
  q: string
  /** One family's page (`View all 40`): the root product id. */
  parent: string
  page: number
  pageSize: ReadinessPageSize
  /** A store page's store and market (`readinessScope.ts`): the filters it fixes always hold its values. */
  lock: ReadinessLock | null
  /** Step 4: the server's order. `''` = the default (state, worst first). */
  sort: ReadinessSort | ''
  dir: ReadinessSortDir
  /** Step 4: the market page's column filters, as typed (numbers as text; `''` = not set). */
  priceMin: string
  priceMax: string
  qtyMin: string
  qtyMax: string
  channelId: string
  /** Step 7: Products (the default) or Problems. One family's page has no Problems view. */
  view: ReadinessView
  /** Step 7: one problem's id (`r:…`, `c:…`, `n:…`): only the families with it. Never together with the Problems view. */
  problem: string
}

export const EMPTY_READINESS_QUERY: ReadinessPageQuery = {
  selector: null, familyId: '', channel: '', marketplace: '', accountId: '', language: '', state: '', live: [], flags: [], q: '',
  parent: '', page: 1, pageSize: DEFAULT_READINESS_PAGE_SIZE, lock: null, sort: '', dir: 'asc',
  priceMin: '', priceMax: '', qtyMin: '', qtyMax: '', channelId: '', view: 'products', problem: '',
}

/* ── Step 4: the order and the column filters ─────────────────────────────────────────────────────────────────────── */

export const isSort = (value: string): value is ReadinessSort => (READINESS_SORTS as readonly string[]).includes(value)
/** The column filters the API reads, with what each accepts (the API's own rule: prices with up to 4 decimals, whole quantities). */
const COLUMN_FILTER_PATTERN: Record<ReadinessColumnFilterKey, RegExp> = {
  priceMin: /^\d{1,9}(?:\.\d{1,4})?$/, priceMax: /^\d{1,9}(?:\.\d{1,4})?$/, qtyMin: /^\d{1,9}$/, qtyMax: /^\d{1,9}$/, channelId: /^[\s\S]{1,200}$/,
}
/** A column filter's value as the API takes it; anything else is dropped (never sent on). */
export function columnFilterValue(key: ReadinessColumnFilterKey, value: unknown): string {
  const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : typeof value === 'string' ? value.trim() : ''
  return COLUMN_FILTER_PATTERN[key].test(text) ? text : ''
}
/** The column filters in use. */
export const columnFilterCount = (query: Pick<ReadinessPageQuery, ReadinessColumnFilterKey>): number =>
  (query.priceMin || query.priceMax ? 1 : 0) + (query.qtyMin || query.qtyMax ? 1 : 0) + (query.channelId ? 1 : 0)
const NO_COLUMN_FILTERS: Pick<ReadinessPageQuery, ReadinessColumnFilterKey> = { priceMin: '', priceMax: '', qtyMin: '', qtyMax: '', channelId: '' }

/**
 * The lock's filters, put back. Every way the query changes ends here — an older link, a filter, Clear, a saved view —
 * so a store page always shows its own store and market.
 */
export function withLock(query: ReadinessPageQuery): ReadinessPageQuery {
  const lock = query.lock
  if (!lock) return query
  const keys = lockedKeys(lock)
  const marketplace = keys.includes('marketplace') ? lock.marketplace : query.marketplace
  return query.channel === lock.channel && query.marketplace === marketplace ? query : { ...query, channel: lock.channel, marketplace }
}
const isLocked = (query: ReadinessPageQuery, key: ReadinessFilterKey): boolean => (lockedKeys(query.lock) as readonly string[]).includes(key)

const STATE_VALUES: ReadonlySet<string> = new Set<string>([...SCOPE_READINESS_STATES, 'notChecked'])
export const isStateFilter = (value: string): value is ReadinessStateFilter => STATE_VALUES.has(value)
export const isPageSize = (value: number): value is ReadinessPageSize => (READINESS_PAGE_SIZES as readonly number[]).includes(value)
/** The shape of a problem id (the API checks the rest and refuses what is not one): a source, then a destination key. */
export const isProblemId = (value: string): boolean => value.length <= 1200 && /^[rcn]:\[/.test(value)

/** The values of `allowed` a list names, once each, in `allowed`'s order (so one choice is one address). Junk is dropped. */
export function knownValues<T extends string>(values: Iterable<unknown>, allowed: readonly T[]): T[] {
  const named = new Set<unknown>(values)
  return allowed.filter((value) => named.has(value))
}
/** A comma list from the address (`live=active,paused`). */
const commaList = (text: string): string[] => text.split(',').map((v) => v.trim()).filter(Boolean)

/** The address → the page's query. Unknown or invalid values are dropped, never sent on; a store page's lock wins. */
export function parseReadinessQuery(search: string | URLSearchParams, lock: ReadinessLock | null = null): ReadinessPageQuery {
  // The old Listings page's options (`search`, `listingStatus`, `drawer`, …) in this page's words first (step 8).
  const params = withLegacyListingOptions(typeof search === 'string' ? new URLSearchParams(search) : search)
  const text = (key: string) => (params.get(key) ?? '').trim()
  const kind = SELECTOR_KINDS.find((k) => text(k) !== '')
  const selector = kind ? { kind, value: text(kind) } : null
  const state = text('state')
  const page = Number(text('page'))
  const pageSize = Number(text('pageSize'))
  // Step 7: the Problems view, or one problem; the Problems view lists every problem, so it never carries one, and a
  // family's own page reads its members, which a problem does not narrow.
  const parent = text('parent')
  const view: ReadinessView = text('view') === 'problems' && !parent ? 'problems' : 'products'
  const problem = (params.get('problem') ?? '').trim()
  return withLock({
    selector,
    // The API refuses a family together with a selection; the link's own selection is what it was opened for.
    familyId: selector ? '' : text('familyId'),
    channel: text('channel').toUpperCase(),
    marketplace: (text('marketplace') || text('market')).toUpperCase(),
    accountId: text('accountId'),
    language: text('language'),
    state: isStateFilter(state) ? state : '',
    live: knownValues(commaList(text('live')), READINESS_LIVE_STATES),
    flags: knownValues(commaList(text('flags')), READINESS_LIVE_FLAGS),
    q: text('q'),
    parent,
    page: Number.isSafeInteger(page) && page >= 1 ? page : 1,
    pageSize: isPageSize(pageSize) ? pageSize : DEFAULT_READINESS_PAGE_SIZE,
    lock,
    sort: isSort(text('sort')) ? (text('sort') as ReadinessSort) : '',
    dir: text('dir') === 'desc' ? 'desc' : 'asc',
    ...Object.fromEntries(READINESS_COLUMN_FILTER_KEYS.map((key) => [key, columnFilterValue(key, text(key))])) as Pick<ReadinessPageQuery, ReadinessColumnFilterKey>,
    view,
    problem: view === 'products' && !parent && isProblemId(problem) ? problem : '',
  })
}

/**
 * The filters as the API reads them — the families, members and detail endpoints, and the Fix window's `query`. No
 * paging: each caller adds its own.
 */
export function apiFilterParams(query: ReadinessPageQuery): Record<string, string> {
  const out: Record<string, string> = {}
  if (query.selector) out[query.selector.kind] = query.selector.value
  for (const key of FILTER_KEYS) if (query[key]) out[key] = query[key]
  if (query.state) out.state = query.state
  if (query.live.length) out.live = query.live.join(',')
  if (query.flags.length) out.flags = query.flags.join(',')
  if (query.q) out.q = query.q
  // Step 4: the order (the default is left out) and the column filters.
  if (query.sort) {
    out.sort = query.sort
    if (query.dir === 'desc') out.dir = 'desc'
  }
  for (const key of READINESS_COLUMN_FILTER_KEYS) if (query[key]) out[key] = query[key]
  // Step 7: one problem narrows the families; the Problems view itself (`view`) is the page's, never the API's.
  if (query.problem) out.problem = query.problem
  return out
}

/**
 * The address the page keeps in sync (`replaceState`). Defaults are left out, so a plain visit stays `?`-free; so is
 * what the path already says (`/listings/amazon/it`, never `?channel=AMAZON&marketplace=IT`).
 */
export function serializeReadinessQuery(query: ReadinessPageQuery): string {
  const params = new URLSearchParams(apiFilterParams(query))
  for (const key of lockedKeys(query.lock)) params.delete(key)
  if (query.parent) params.set('parent', query.parent)
  if (query.view === 'problems') params.set('view', 'problems')
  if (query.page > 1) params.set('page', String(query.page))
  if (query.pageSize !== DEFAULT_READINESS_PAGE_SIZE) params.set('pageSize', String(query.pageSize))
  return params.toString()
}

/** One family's own page (`View all 40`, "N variations"): the same page and filters, that family only, from page 1. */
export function familyPageHref(query: ReadinessPageQuery, rootId: string): string {
  return `${readinessPath(query.lock)}?${serializeReadinessQuery({ ...query, parent: rootId, page: 1, problem: '' })}`
}

/** `GET …/readiness/families` for one page. */
export function familiesParams(query: ReadinessPageQuery, page: number, pageSize: number): URLSearchParams {
  return new URLSearchParams({ ...apiFilterParams(query), page: String(page), pageSize: String(pageSize) })
}

/** `GET …/readiness/families/:rootId/members` — the open family's preview, or one page of a family's own page. */
export function membersParams(query: ReadinessPageQuery, limit: number, offset: number): URLSearchParams {
  return new URLSearchParams({ ...apiFilterParams(query), limit: String(limit), offset: String(offset) })
}

/**
 * One AG block → one API page. The grid asks for `[startRow, endRow)`; the API pages with `page` + `pageSize`
 * (50 / 100 / 200). The block size IS the page size (`cacheBlockSize = pageSize`), so `skip` is 0 and `take` the whole
 * page — the arithmetic only matters for a block that does not line up, which then reads its slice of the page.
 */
export function pageOfBlock(startRow: number, endRow: number, pageSize: ReadinessPageSize): { page: number; pageSize: ReadinessPageSize; skip: number; take: number } {
  const start = Math.max(0, Math.floor(startRow))
  const page = Math.floor(start / pageSize) + 1
  const skip = start - (page - 1) * pageSize
  const take = Math.max(0, Math.min(Math.floor(endRow) - start, pageSize - skip))
  return { page, pageSize, skip, take }
}

/** One filter changed: the page goes back to 1; a new channel drops the market and store it no longer has. A filter the
 *  page's lock fixes does not change. */
export function withFilter(query: ReadinessPageQuery, key: ReadinessFilterKey, value: string): ReadinessPageQuery {
  if (isLocked(query, key)) return query
  const next: ReadinessPageQuery = { ...query, [key]: value, page: 1 }
  if (key === 'channel' && value !== query.channel) { next.marketplace = ''; next.accountId = '' }
  if (key === 'marketplace' && value !== query.marketplace) next.accountId = ''
  // One selection at a time (the API's rule): a family filter replaces a link's own selection.
  if (key === 'familyId' && value) next.selector = null
  return next
}

/**
 * "Clear" in the Filters panel: the panel's filters go — the five, Channel state (`live`) and Stock (the `lowStock`
 * flag); the link's selection, the tiles (`state`, the live tiles' flags), the search and the family page stay.
 */
export function withoutFilters(query: ReadinessPageQuery): ReadinessPageQuery {
  return withLock({
    ...query, channel: '', marketplace: '', accountId: '', language: '', familyId: '', live: [],
    flags: query.flags.filter((flag) => flag !== 'lowStock'), page: 1,
    // Step 4: the column filters go too; the order stays.
    ...NO_COLUMN_FILTERS,
  })
}

/** The filters set in the Filters panel. What the lock fixes is the page, not a filter. */
export const activeFilterCount = (query: ReadinessPageQuery): number =>
  FILTER_KEYS.filter((key) => query[key] !== '' && !isLocked(query, key)).length
  + (query.live.length > 0 ? 1 : 0)
  + (query.flags.includes('lowStock') ? 1 : 0)
  + columnFilterCount(query)

/**
 * The values a saved view keeps beside the grid's own state. The link's selection and the search are not a view, and
 * neither is the store page it was saved on: one list of views serves every Listings page.
 */
export interface ReadinessViewFilters {
  channel: string; marketplace: string; accountId: string; language: string; familyId: string; state: ReadinessStateFilter | ''
  live: ReadinessLiveState[]; flags: ReadinessLiveFlag[]
  /** Step 4: the order and the column filters (absent from a view saved before). */
  sort?: ReadinessSort | ''; dir?: ReadinessSortDir
  priceMin?: string; priceMax?: string; qtyMin?: string; qtyMax?: string; channelId?: string
  /** Step 7: set only for the Problems view (a view saved before it, or on Products, has none). */
  view?: ReadinessView
}
export const viewFiltersOf = (query: ReadinessPageQuery): ReadinessViewFilters => ({
  channel: isLocked(query, 'channel') ? '' : query.channel,
  marketplace: isLocked(query, 'marketplace') ? '' : query.marketplace,
  accountId: query.accountId, language: query.language, familyId: query.familyId, state: query.state,
  live: [...query.live], flags: [...query.flags],
  // Step 4: only what is set, so a view without an order or a column filter reads as before.
  ...(query.sort ? { sort: query.sort, dir: query.dir } : {}),
  ...Object.fromEntries(READINESS_COLUMN_FILTER_KEYS.filter((key) => query[key]).map((key) => [key, query[key]])),
  ...(query.view === 'problems' ? { view: 'problems' as const } : {}),
})
export function withViewFilters(query: ReadinessPageQuery, filters: Partial<ReadinessViewFilters> | null | undefined): ReadinessPageQuery {
  if (!filters) return query
  const text = (v: unknown) => (typeof v === 'string' ? v : '')
  const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
  const state = text(filters.state)
  const familyId = text(filters.familyId)
  return withLock({
    ...query,
    channel: text(filters.channel), marketplace: text(filters.marketplace), accountId: text(filters.accountId),
    language: text(filters.language), familyId, state: isStateFilter(state) ? state : '',
    // A view saved before the live layer has neither: it shows every channel state.
    live: knownValues(list(filters.live), READINESS_LIVE_STATES), flags: knownValues(list(filters.flags), READINESS_LIVE_FLAGS),
    selector: familyId ? null : query.selector, page: 1,
    // A view saved before step 4 has no order and no column filter: the default order, none.
    sort: isSort(text(filters.sort)) ? (text(filters.sort) as ReadinessSort) : '', dir: filters.dir === 'desc' ? 'desc' : 'asc',
    ...Object.fromEntries(READINESS_COLUMN_FILTER_KEYS.map((key) => [key, columnFilterValue(key, filters[key])])) as Pick<ReadinessPageQuery, ReadinessColumnFilterKey>,
    // Step 7: the view's own view; a problem chip stays on Products, the Problems view lists every problem.
    ...(filters.view === 'problems' && !query.parent ? { view: 'problems' as const, problem: '' } : { view: 'products' as const }),
  })
}

/* ── The link's own selection, as a removable chip ─────────────────────────────────────────────────────────────── */

/** How many things a selection names. `skus` is one SKU or a JSON array (the API's own rule); `job` names an import. */
export function selectorCount(selector: ReadinessSelector): number | null {
  if (selector.kind === 'job') return null
  if (selector.kind === 'skus') {
    if (!selector.value.startsWith('[')) return 1
    try {
      const parsed: unknown = JSON.parse(selector.value)
      return Array.isArray(parsed) ? new Set(parsed.filter((v) => typeof v === 'string' && v.trim())).size : 1
    } catch {
      return 1
    }
  }
  return new Set(selector.value.split(',').map((v) => v.trim()).filter(Boolean)).size
}

export function selectorChipText(selector: ReadinessSelector): string {
  const n = selectorCount(selector) ?? 0
  switch (selector.kind) {
    case 'productIds': return n === 1 ? '1 chosen product' : `${n.toLocaleString('en')} chosen products`
    case 'listingIds': return n === 1 ? '1 chosen listing' : `${n.toLocaleString('en')} chosen listings`
    case 'skus': return n === 1 ? '1 chosen SKU' : `${n.toLocaleString('en')} chosen SKUs`
    case 'job': return 'Products from one import'
  }
}

/* ── A search with several terms (pasted SKUs, ASINs, Item IDs) ─────────────────────────────────────────────────── */

/** How many pasted terms the notice names before "and N more". */
export const NOT_FOUND_SHOWN = 5

/**
 * The notice under a search with several terms when some matched nothing (`ReadinessFamiliesPage.search`):
 * "3 of 40 not found: GAL-1, GAL-2, B0ABC and 1 more". Null when every term matched, or for a one-word search (the
 * empty grid already says so).
 */
export function notFoundWords(search: { tokens: number; unmatched: readonly string[] } | null | undefined, shown = NOT_FOUND_SHOWN): string | null {
  if (!search || search.tokens < 2 || search.unmatched.length === 0) return null
  const named = search.unmatched.slice(0, shown).join(', ')
  const more = search.unmatched.length - Math.min(shown, search.unmatched.length)
  return `${search.unmatched.length.toLocaleString('en')} of ${search.tokens.toLocaleString('en')} not found: ${named}${more > 0 ? ` and ${more.toLocaleString('en')} more` : ''}`
}

/* ── Translate filtered products… ──────────────────────────────────────────────────────────────────────────────── */

/** The keys the old readiness scope (`listingReadinessWhere`, the Translate preview) reads. Anything else would be ignored there. */
const TRANSLATE_KEYS = ['familyId', 'productIds', 'listingIds', 'job', 'skus', 'accountId', 'channel', 'marketplace', 'language', 'state'] as const

/**
 * The Translate dialog's scope: only what the old endpoint accepts. When the page narrows by something that scope
 * cannot express — a search, the `Not checked` tile, one family's page — Translate would reach MORE products than the
 * page shows, so it is held and says why.
 */
export function translateScope(query: ReadinessPageQuery): { ok: true; query: Record<string, string> } | { ok: false; reason: string } {
  if (!query.language) return { ok: false, reason: 'Choose a language in Filters to translate every matching product.' }
  if (query.q) return { ok: false, reason: 'Translate cannot narrow by a search. Clear the search box first.' }
  if (query.state === 'notChecked') return { ok: false, reason: 'Translate cannot narrow to Not checked. Choose another tile or All first.' }
  if (query.parent) return { ok: false, reason: 'Translate cannot narrow to one family’s page. Use the Product family filter instead.' }
  if (query.live.length || query.flags.length || columnFilterCount(query) > 0) {
    return { ok: false, reason: 'Translate cannot narrow by what is on the channel. Clear Channel state, Stock, the live tiles and the column filters first.' }
  }
  if (query.problem) return { ok: false, reason: 'Translate cannot narrow to one problem. Remove the problem chip first.' }
  const params = apiFilterParams(query)
  const out: Record<string, string> = {}
  for (const key of TRANSLATE_KEYS) if (params[key]) out[key] = params[key]
  return { ok: true, query: out }
}

/* ── Export (step 4) ──────────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * The plain download link of the page's result: `GET /api/catalog-transfer/readiness/export` with the page's filters
 * and order, a format and a level. A plain link carries no request header, so the business goes in the address
 * (`workspaceId`, as the API reads it) when there is one.
 */
export function exportHref(base: string, query: ReadinessPageQuery, format: 'csv' | 'xlsx', level: 'listing' | 'family', workspaceId: string | null): string {
  const params = new URLSearchParams({ ...apiFilterParams(query), format, level })
  if (workspaceId) params.set('workspaceId', workspaceId)
  return `${base}/api/catalog-transfer/readiness/export?${params}`
}

/* ── Step 7: Products | Problems ───────────────────────────────────────────────────────────────────────────────── */

/** The switch: the Problems view lists every problem (a problem chip goes); Products keeps everything. Page 1 either way. */
export function withView(query: ReadinessPageQuery, view: ReadinessView): ReadinessPageQuery {
  if (query.view === view) return query
  return view === 'problems' ? { ...query, view, problem: '', parent: '', page: 1 } : { ...query, view, page: 1 }
}

/** Show products: back to Products, only the families with that problem. */
export function withProblem(query: ReadinessPageQuery, id: string): ReadinessPageQuery {
  return { ...query, view: 'products', problem: isProblemId(id) ? id : '', page: 1 }
}
