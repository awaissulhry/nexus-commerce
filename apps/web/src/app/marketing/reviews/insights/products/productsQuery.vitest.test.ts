import { describe, expect, it } from 'vitest'
import { insightsSearch } from '../_shared/insightsScope'
import {
  EMPTY_PRODUCTS_QUERY,
  activeFilterCount,
  cleanRating,
  clearFilters,
  columnOfSort,
  effectiveDir,
  nextQuery,
  parseProductsQuery,
  productChips,
  productsAddressParams,
  productsApiParams,
  toggleTile,
  withSort,
  withoutChip,
} from './productsQuery'

describe('the Products address', () => {
  it('reads the tile, filters, search, sort, page and the open product', () => {
    const { query, product } = parseProductsQuery('?tile=dropped&family=fam-1&theme=fit_sizing&minRating=2,5&maxRating=9&openAlert=1&q=%20jacket%20&sort=rating&dir=desc&page=3&pageSize=100&product=p-1')
    expect(query).toEqual({ tile: 'dropped', family: 'fam-1', theme: 'FIT_SIZING', minRating: '2.5', maxRating: '5', openAlert: true, q: 'jacket', sort: 'rating', dir: 'desc', page: 3, pageSize: 100 })
    expect(product).toBe('p-1')
  })

  it('falls back to the defaults for anything it does not know', () => {
    const { query, product } = parseProductsQuery('?tile=all&sort=price&dir=up&page=-2&pageSize=7')
    expect(query).toEqual(EMPTY_PRODUCTS_QUERY)
    expect(product).toBeNull()
    expect(cleanRating('abc')).toBe('')
    expect(cleanRating('0')).toBe('1')
  })

  it('writes back only what differs from the defaults, and round-trips with the scope', () => {
    expect(productsAddressParams(EMPTY_PRODUCTS_QUERY, null)).toEqual({ tile: null, family: null, theme: null, minRating: null, maxRating: null, openAlert: null, q: null, sort: null, dir: null, page: null, pageSize: null, product: null })
    const q = { ...EMPTY_PRODUCTS_QUERY, tile: 'below4' as const, theme: 'SHIPPING', page: 2 }
    const search = insightsSearch({ channel: 'AMAZON', market: 'DE', period: '90d' }, productsAddressParams(q, 'p-9'))
    expect(search).toBe('?channel=AMAZON&market=DE&period=90d&tile=below4&theme=SHIPPING&page=2&product=p-9')
    expect(parseProductsQuery(search)).toEqual({ query: q, product: 'p-9' })
  })

  it('asks the API for the scope, the filters and the page', () => {
    const params = productsApiParams({ channel: null, market: null, period: '30d' }, { ...EMPTY_PRODUCTS_QUERY, openAlert: true, minRating: '3' })
    expect(params).toMatchObject({ period: '30d', openAlert: 1, minRating: '3', sort: 'reviews', page: 1, pageSize: 50 })
  })
})

describe('changing what shows', () => {
  it('starts again from page 1 unless only the page moves', () => {
    const on3 = { ...EMPTY_PRODUCTS_QUERY, page: 3 }
    expect(nextQuery(on3, { theme: 'FIT_SIZING' }).page).toBe(1)
    expect(nextQuery(on3, { page: 4 }).page).toBe(4)
  })

  it('toggles a tile, and a second press clears it', () => {
    const on = toggleTile(EMPTY_PRODUCTS_QUERY, 'below4')
    expect(on.tile).toBe('below4')
    expect(toggleTile(on, 'below4').tile).toBeNull()
    expect(toggleTile(on, 'dropped').tile).toBe('dropped')
  })

  it('sorts by a column on the server; name and rating start low-to-high', () => {
    expect(withSort(EMPTY_PRODUCTS_QUERY, 'rating', 'asc')).toMatchObject({ sort: 'rating', dir: 'asc', page: 1 })
    expect(effectiveDir({ sort: 'rating', dir: null })).toBe('asc')
    expect(effectiveDir({ sort: 'reviews', dir: null })).toBe('desc')
    expect(columnOfSort('returnRate')).toBe('returnRate')
    expect(columnOfSort('name')).toBe('product')
  })

  it('shows one removable chip per thing that narrows the list, and Clear takes them all', () => {
    const q = { ...EMPTY_PRODUCTS_QUERY, tile: 'below4' as const, family: 'fam-1', theme: 'FIT_SIZING', maxRating: '3.5', openAlert: true, q: 'mesh' }
    const chips = productChips(q, (id) => (id === 'fam-1' ? 'Touring jacket' : null))
    expect(chips.map((c) => c.label)).toEqual(['Below 4 stars', 'Family: Touring jacket', 'Top complaint: Fit & sizing', 'Rating 1–3.5', 'Has an open alert', 'Search: mesh'])
    expect(chips[0].removeLabel).toBe('Remove: Below 4 stars')
    expect(withoutChip(q, 'minRating')).toMatchObject({ minRating: '', maxRating: '' })
    expect(withoutChip(q, 'family').family).toBeNull()
    expect(withoutChip(q, 'openAlert').openAlert).toBe(false)
    expect(activeFilterCount(q)).toBe(4)
    expect(clearFilters({ ...q, sort: 'rating', pageSize: 100 })).toEqual({ ...EMPTY_PRODUCTS_QUERY, sort: 'rating', pageSize: 100 })
  })
})
