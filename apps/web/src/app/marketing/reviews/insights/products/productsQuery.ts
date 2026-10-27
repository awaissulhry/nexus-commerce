/**
 * Reviews › Insights › Products — what the page shows, in the address (build spec §3.4, the Products board): the tile
 * that filters (Below 4 stars · Rating dropped), the filters (family, top complaint, rating range, open alert), the
 * search, the sort, the page and the product whose pop-up is open (`?product=<id>`). The channel, market and period are
 * the shared Insights scope (insightsScope.ts). Pure, tested in productsQuery.vitest.test.ts.
 */
import type { LinkParams } from '../../_lib/reviewsLinks'
import { themeWord } from '../../_lib/reviewWords'
import { scopeApiParams, type InsightsScope } from '../_shared/insightsScope'

export const PRODUCT_TILES = ['below4', 'dropped'] as const
export type ProductTile = (typeof PRODUCT_TILES)[number]

export const PRODUCT_SORTS = ['reviews', 'rating', 'change', 'returnRate', 'name'] as const
export type ProductSort = (typeof PRODUCT_SORTS)[number]

export const PRODUCTS_PAGE_SIZES = [25, 50, 100] as const
export const DEFAULT_PRODUCTS_PAGE_SIZE = 50

export interface ProductsQuery {
  tile: ProductTile | null
  /** A family (its parent product's id). */
  family: string | null
  /** The top complaint (a theme key). */
  theme: string | null
  /** Rating range, stars 1–5, as typed. */
  minRating: string
  maxRating: string
  openAlert: boolean
  q: string
  sort: ProductSort
  dir: 'asc' | 'desc' | null
  page: number
  pageSize: number
}

export const EMPTY_PRODUCTS_QUERY: ProductsQuery = {
  tile: null,
  family: null,
  theme: null,
  minRating: '',
  maxRating: '',
  openAlert: false,
  q: '',
  sort: 'reviews',
  dir: null,
  page: 1,
  pageSize: DEFAULT_PRODUCTS_PAGE_SIZE,
}

/** A star bound as typed: a number 1–5 (one decimal), else ''. */
export function cleanRating(raw: string | null | undefined): string {
  const text = (raw ?? '').trim().replace(',', '.')
  if (!text) return ''
  const n = Number(text)
  if (!Number.isFinite(n)) return ''
  return String(Math.round(Math.min(5, Math.max(1, n)) * 10) / 10)
}

const int = (raw: string | null, fallback: number) => {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : fallback
}

/** The page's state from its address, plus the product whose pop-up opens (read once, on load). */
export function parseProductsQuery(search: string | URLSearchParams): { query: ProductsQuery; product: string | null } {
  const p = typeof search === 'string' ? new URLSearchParams(search.startsWith('?') ? search.slice(1) : search) : search
  const tile = p.get('tile')
  const sort = p.get('sort')
  const dir = p.get('dir')
  const size = int(p.get('pageSize'), DEFAULT_PRODUCTS_PAGE_SIZE)
  return {
    query: {
      tile: (PRODUCT_TILES as readonly string[]).includes(tile ?? '') ? (tile as ProductTile) : null,
      family: (p.get('family') ?? '').trim().slice(0, 64) || null,
      theme: (p.get('theme') ?? '').trim().toUpperCase().slice(0, 40) || null,
      minRating: cleanRating(p.get('minRating')),
      maxRating: cleanRating(p.get('maxRating')),
      openAlert: p.get('openAlert') === '1' || p.get('openAlert') === 'true',
      q: (p.get('q') ?? '').trim().slice(0, 200),
      sort: (PRODUCT_SORTS as readonly string[]).includes(sort ?? '') ? (sort as ProductSort) : 'reviews',
      dir: dir === 'asc' || dir === 'desc' ? dir : null,
      page: int(p.get('page'), 1),
      pageSize: (PRODUCTS_PAGE_SIZES as readonly number[]).includes(size) ? size : DEFAULT_PRODUCTS_PAGE_SIZE,
    },
    product: (p.get('product') ?? '').trim().slice(0, 64) || null,
  }
}

/** The page's own address values (the defaults are left out), with the open pop-up's product. */
export function productsAddressParams(q: ProductsQuery, product: string | null): LinkParams {
  return {
    tile: q.tile,
    family: q.family,
    theme: q.theme,
    minRating: q.minRating || null,
    maxRating: q.maxRating || null,
    openAlert: q.openAlert || null,
    q: q.q || null,
    sort: q.sort === 'reviews' ? null : q.sort,
    dir: q.dir,
    page: q.page > 1 ? q.page : null,
    pageSize: q.pageSize === DEFAULT_PRODUCTS_PAGE_SIZE ? null : q.pageSize,
    product,
  }
}

/** What `GET /api/reviews/insights/products` reads. */
export function productsApiParams(scope: InsightsScope, q: ProductsQuery): LinkParams {
  return {
    ...scopeApiParams(scope),
    tile: q.tile,
    family: q.family,
    theme: q.theme,
    minRating: q.minRating || null,
    maxRating: q.maxRating || null,
    openAlert: q.openAlert ? 1 : null,
    q: q.q || null,
    sort: q.sort,
    dir: q.dir,
    page: q.page,
    pageSize: q.pageSize,
  }
}

/** A change of what shows (anything but the page) starts again from page 1. */
export function nextQuery(q: ProductsQuery, next: Partial<ProductsQuery>): ProductsQuery {
  const pageOnly = Object.keys(next).every((k) => k === 'page')
  return { ...q, ...next, page: pageOnly ? next.page ?? q.page : 1 }
}

/** A tile press: on, or off when it is the one already on. */
export function toggleTile(q: ProductsQuery, tile: ProductTile): ProductsQuery {
  return nextQuery(q, { tile: q.tile === tile ? null : tile })
}

/** A header click: the API's sort; the name and the rating start low-to-high, the rest high-to-low. */
export function withSort(q: ProductsQuery, sort: ProductSort, dir: 'asc' | 'desc' | null): ProductsQuery {
  return nextQuery(q, { sort, dir })
}

export interface ProductChip {
  key: keyof ProductsQuery
  label: string
  /** "Remove: Below 4 stars". */
  removeLabel: string
}

const TILE_WORDS: Record<ProductTile, string> = { below4: 'Below 4 stars', dropped: 'Rating dropped' }

/** The removable chips under the filters ("This page shows only …"): one per tile and filter that is on. */
export function productChips(q: ProductsQuery, familyName: (id: string) => string | null): ProductChip[] {
  const chips: ProductChip[] = []
  const add = (key: keyof ProductsQuery, label: string) => chips.push({ key, label, removeLabel: `Remove: ${label}` })
  if (q.tile) add('tile', TILE_WORDS[q.tile])
  if (q.family) add('family', `Family: ${familyName(q.family) ?? 'one family'}`)
  if (q.theme) add('theme', `Top complaint: ${themeWord(q.theme)}`)
  if (q.minRating || q.maxRating) add('minRating', `Rating ${q.minRating || '1'}–${q.maxRating || '5'}`)
  if (q.openAlert) add('openAlert', 'Has an open alert')
  if (q.q) add('q', `Search: ${q.q}`)
  return chips
}

/** A chip's ×: that filter off (the rating range goes as one). */
export function withoutChip(q: ProductsQuery, key: keyof ProductsQuery): ProductsQuery {
  if (key === 'minRating' || key === 'maxRating') return nextQuery(q, { minRating: '', maxRating: '' })
  if (key === 'openAlert') return nextQuery(q, { openAlert: false })
  if (key === 'q') return nextQuery(q, { q: '' })
  return nextQuery(q, { [key]: null } as Partial<ProductsQuery>)
}

/** How many filters are on (the filter bar's count; the tile and the search count as chips, not filters). */
export function activeFilterCount(q: ProductsQuery): number {
  return [q.family, q.theme, q.minRating || q.maxRating, q.openAlert].filter(Boolean).length
}

/** Clear: every filter, the tile and the search off; the sort and the page size stay. */
export function clearFilters(q: ProductsQuery): ProductsQuery {
  return nextQuery(q, { tile: null, family: null, theme: null, minRating: '', maxRating: '', openAlert: false, q: '' })
}

/** The grid's column → the API's sort. */
export const SORT_OF_COLUMN: Record<string, ProductSort> = {
  product: 'name',
  rating: 'rating',
  reviews: 'reviews',
  change: 'change',
  returnRate: 'returnRate',
}

/** The column that shows the API's sort (for the header's arrow). */
export function columnOfSort(sort: ProductSort): string {
  return Object.entries(SORT_OF_COLUMN).find(([, s]) => s === sort)?.[0] ?? 'reviews'
}

/** The direction the API uses when none is named: the name and the rating low-to-high, the rest high-to-low. */
export function effectiveDir(q: Pick<ProductsQuery, 'sort' | 'dir'>): 'asc' | 'desc' {
  return q.dir ?? (q.sort === 'name' || q.sort === 'rating' ? 'asc' : 'desc')
}
