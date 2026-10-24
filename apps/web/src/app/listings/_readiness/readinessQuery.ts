/**
 * Listing readiness — the page's query, read from and written to the address (rebuild 2026-10-23, layout A).
 *
 * Every link that ever opened this page keeps working: the Products menu (`?productIds=`), the Listings pages
 * (`?listingIds=`), an import's review (`?job=`), the studio's progress cards (`?channel=&marketplace=&language=`) and
 * older bookmarks (`?skus=`, `?familyId=`, `?market=`, `?state=`, `?accountId=`, `?page=`). The new page adds `q`
 * (search), `pageSize`, `parent` (one family's page) and the `notChecked` tile state.
 *
 * Pure — no React, no fetch — so every mapping is a test.
 */
import type { ReadinessStateFilter } from '@nexus/shared/listing-readiness'
import { SCOPE_READINESS_STATES } from '@/design-system/grid/renderers/readiness'
import { lockedKeys, readinessPath, type ReadinessLock } from './readinessScope'

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

export interface ReadinessPageQuery {
  selector: ReadinessSelector | null
  familyId: string
  channel: string
  marketplace: string
  accountId: string
  language: string
  /** A tile (`blocked`, `warn`, `ready`, `notChecked`) or an older link's own state (`absent`, `notComputed`). */
  state: ReadinessStateFilter | ''
  q: string
  /** One family's page (`View all 40`): the root product id. */
  parent: string
  page: number
  pageSize: ReadinessPageSize
  /** A store page's store and market (`readinessScope.ts`): the filters it fixes always hold its values. */
  lock: ReadinessLock | null
}

export const EMPTY_READINESS_QUERY: ReadinessPageQuery = {
  selector: null, familyId: '', channel: '', marketplace: '', accountId: '', language: '', state: '', q: '', parent: '',
  page: 1, pageSize: DEFAULT_READINESS_PAGE_SIZE, lock: null,
}

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

/** The address → the page's query. Unknown or invalid values are dropped, never sent on; a store page's lock wins. */
export function parseReadinessQuery(search: string | URLSearchParams, lock: ReadinessLock | null = null): ReadinessPageQuery {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search
  const text = (key: string) => (params.get(key) ?? '').trim()
  const kind = SELECTOR_KINDS.find((k) => text(k) !== '')
  const selector = kind ? { kind, value: text(kind) } : null
  const state = text('state')
  const page = Number(text('page'))
  const pageSize = Number(text('pageSize'))
  return withLock({
    selector,
    // The API refuses a family together with a selection; the link's own selection is what it was opened for.
    familyId: selector ? '' : text('familyId'),
    channel: text('channel').toUpperCase(),
    marketplace: (text('marketplace') || text('market')).toUpperCase(),
    accountId: text('accountId'),
    language: text('language'),
    state: isStateFilter(state) ? state : '',
    q: text('q'),
    parent: text('parent'),
    page: Number.isSafeInteger(page) && page >= 1 ? page : 1,
    pageSize: isPageSize(pageSize) ? pageSize : DEFAULT_READINESS_PAGE_SIZE,
    lock,
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
  if (query.q) out.q = query.q
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
  if (query.page > 1) params.set('page', String(query.page))
  if (query.pageSize !== DEFAULT_READINESS_PAGE_SIZE) params.set('pageSize', String(query.pageSize))
  return params.toString()
}

/** One family's own page (`View all 40`, "N variations"): the same page and filters, that family only, from page 1. */
export function familyPageHref(query: ReadinessPageQuery, rootId: string): string {
  return `${readinessPath(query.lock)}?${serializeReadinessQuery({ ...query, parent: rootId, page: 1 })}`
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

/** "Clear" in the Filters panel: the five filters go; the link's selection, the tile, the search and the family page stay. */
export function withoutFilters(query: ReadinessPageQuery): ReadinessPageQuery {
  return withLock({ ...query, channel: '', marketplace: '', accountId: '', language: '', familyId: '', page: 1 })
}

/** The filters set in the Filters panel. What the lock fixes is the page, not a filter. */
export const activeFilterCount = (query: ReadinessPageQuery): number =>
  FILTER_KEYS.filter((key) => query[key] !== '' && !isLocked(query, key)).length

/**
 * The values a saved view keeps beside the grid's own state. The link's selection and the search are not a view, and
 * neither is the store page it was saved on: one list of views serves every Listings page.
 */
export interface ReadinessViewFilters { channel: string; marketplace: string; accountId: string; language: string; familyId: string; state: ReadinessStateFilter | '' }
export const viewFiltersOf = (query: ReadinessPageQuery): ReadinessViewFilters => ({
  channel: isLocked(query, 'channel') ? '' : query.channel,
  marketplace: isLocked(query, 'marketplace') ? '' : query.marketplace,
  accountId: query.accountId, language: query.language, familyId: query.familyId, state: query.state,
})
export function withViewFilters(query: ReadinessPageQuery, filters: Partial<ReadinessViewFilters> | null | undefined): ReadinessPageQuery {
  if (!filters) return query
  const text = (v: unknown) => (typeof v === 'string' ? v : '')
  const state = text(filters.state)
  const familyId = text(filters.familyId)
  return withLock({
    ...query,
    channel: text(filters.channel), marketplace: text(filters.marketplace), accountId: text(filters.accountId),
    language: text(filters.language), familyId, state: isStateFilter(state) ? state : '',
    selector: familyId ? null : query.selector, page: 1,
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
  const params = apiFilterParams(query)
  const out: Record<string, string> = {}
  for (const key of TRANSLATE_KEYS) if (params[key]) out[key] = params[key]
  return { ok: true, query: out }
}
