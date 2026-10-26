import { describe, expect, it } from 'vitest'
import { withQuery } from '../_lib/reviewsLinks'
import {
  EMPTY_INBOX_QUERY, activeFilterCount, clearFilters, gridSortOf, inboxApiParams, inboxPageHref, isFiltered, litTile, parseInboxQuery,
  querySignature, serializeInboxQuery, sortFromGrid, toggleStatusTile, withFilter, withKind, withPage, withPeriod, withSearch, withSort,
  withoutValue,
} from './inboxQuery'

describe('Inbox address', () => {
  it('reads every filter, drops what it does not know, and reads the one-time flags', () => {
    const { query, openImport, review } = parseInboxQuery(
      '?kind=seller&period=7d&status=overdue,NOPE&channel=ebay,amazon&market=de&stars=1,2,9&mood=negative,angry&theme=fit_sizing&owner=Owner%20A,none&family=fam_1,bad%20id&q=%20zip%20&sort=rating:asc&page=3&pageSize=100&import=1&review=rev_1',
    )
    expect(query).toEqual({
      ...EMPTY_INBOX_QUERY,
      kind: 'seller', period: '7d', statuses: ['OVERDUE'], channels: ['EBAY', 'AMAZON'], markets: ['DE'], stars: [1, 2],
      moods: ['NEGATIVE'], themes: ['FIT_SIZING'], owners: ['Owner A', 'none'], families: ['fam_1'], q: 'zip', sort: 'rating:asc',
      page: 3, pageSize: 100,
    })
    expect(openImport).toBe(true)
    expect(review).toBe('rev_1')
  })

  it('falls back to the defaults: 30 days, newest first, 50 a page; old numeric periods and 12 months read', () => {
    expect(parseInboxQuery('')).toEqual({ query: EMPTY_INBOX_QUERY, openImport: false, review: null })
    expect(parseInboxQuery('?period=90').query.period).toBe('90d')
    expect(parseInboxQuery('?period=12m').query.period).toBe('12m')
    expect(parseInboxQuery('?period=forever&sort=x&pageSize=7&kind=x').query).toEqual(EMPTY_INBOX_QUERY)
  })

  it('writes the address back without defaults, in a fixed order, and round-trips', () => {
    expect(serializeInboxQuery(EMPTY_INBOX_QUERY)).toBe('')
    const q = { ...EMPTY_INBOX_QUERY, kind: 'product' as const, period: 'all' as const, statuses: ['NEW' as const], stars: [1, 2], q: 'zip', page: 2 }
    const text = serializeInboxQuery(q, { review: 'r1' })
    expect(text).toBe('?kind=product&period=all&status=NEW&stars=1%2C2&q=zip&page=2&review=r1')
    expect(parseInboxQuery(text).query).toEqual(q)
  })

  it('hands the API the same names; 12 months is 365 days; the grid sort wins', () => {
    const q = { ...EMPTY_INBOX_QUERY, period: '12m' as const, channels: ['EBAY'], owners: ['none'] }
    expect(inboxApiParams(q)).toMatchObject({ kind: null, period: '365', channel: ['EBAY'], owner: ['none'], sort: 'postedAt:desc', page: 1, pageSize: 50 })
    expect(inboxApiParams(q, 4, 'rating:asc')).toMatchObject({ page: 4, sort: 'rating:asc' })
    expect(inboxApiParams({ ...q, kind: 'seller' }).kind).toBe('seller')
  })

  it('a status tile shows that status alone; pressing it again shows every status', () => {
    const on = toggleStatusTile({ ...EMPTY_INBOX_QUERY, page: 3 }, 'OVERDUE')
    expect(on.statuses).toEqual(['OVERDUE'])
    expect(on.page).toBe(1)
    expect(litTile(on)).toBe('OVERDUE')
    expect(toggleStatusTile(on, 'OVERDUE').statuses).toEqual([])
    expect(toggleStatusTile(on, 'NEW').statuses).toEqual(['NEW'])
    expect(litTile({ ...EMPTY_INBOX_QUERY, statuses: ['NEW', 'IN_PROGRESS'] })).toBeNull()
  })

  it('filters, chips and Clear: values validated, one removed, all cleared (tab and order stay)', () => {
    const q = withFilter(EMPTY_INBOX_QUERY, 'stars', [5, 1, 7])
    expect(q.stars).toEqual([1, 5])
    expect(withoutValue(q, 'stars', 1).stars).toEqual([5])
    const busy = { ...withFilter(withKind(q, 'seller'), 'channels', ['ebay']), q: 'zip', sort: 'rating:asc' as const }
    expect(activeFilterCount(busy)).toBe(2)
    const cleared = clearFilters(busy)
    expect(cleared).toMatchObject({ kind: 'seller', sort: 'rating:asc', stars: [], channels: [], q: '', period: 'all' })
    expect(isFiltered(cleared)).toBe(false)
    expect(isFiltered(EMPTY_INBOX_QUERY)).toBe(true) // the 30-day period narrows the rows
  })

  it('a change of what shows starts again at page 1; the pager and the page size do their own', () => {
    const q = { ...EMPTY_INBOX_QUERY, page: 4 }
    expect(withPeriod(q, '7d').page).toBe(1)
    expect(withPeriod(q, '30d')).toBe(q)
    expect(withSearch(q, ' zip ').q).toBe('zip')
    expect(withSort(q, 'rating:desc')).toMatchObject({ sort: 'rating:desc', page: 1 })
    expect(withPage(q, 5).page).toBe(5)
    expect(withPage(q, 5, 200)).toMatchObject({ pageSize: 200, page: 1 })
    expect(querySignature(q)).toBe(querySignature({ ...q, page: 9 }))
    expect(querySignature(q)).not.toBe(querySignature(withKind(q, 'product')))
  })

  it('maps the grid header sort to the API order and back', () => {
    expect(sortFromGrid([], 'postedAt:desc')).toBe('postedAt:desc')
    expect(sortFromGrid([{ colId: 'received', sort: 'asc' }], 'postedAt:desc')).toBe('postedAt:asc')
    expect(sortFromGrid([{ colId: 'stars', sort: 'desc' }], 'postedAt:desc')).toBe('rating:desc')
    expect(sortFromGrid([{ colId: 'review', sort: 'asc' }], 'rating:asc')).toBe('rating:asc')
    expect(gridSortOf('rating:asc')).toEqual({ colId: 'stars', sort: 'asc' })
  })

  it('reads the links other Reviews pages build with `withQuery` (comma lists encoded, true as 1)', () => {
    const href = withQuery('/marketing/reviews/inbox', {
      period: '12m', channel: 'EBAY', market: 'DE', kind: 'seller', stars: [1, 2], status: 'OVERDUE', theme: 'FIT_SIZING', family: 'f1', import: true,
    })
    const { query, openImport } = parseInboxQuery(href.slice(href.indexOf('?')))
    expect(query).toMatchObject({ period: '12m', channels: ['EBAY'], markets: ['DE'], kind: 'seller', stars: [1, 2], statuses: ['OVERDUE'], themes: ['FIT_SIZING'], families: ['f1'] })
    expect(openImport).toBe(true)
  })

  it('builds links into the Inbox', () => {
    expect(inboxPageHref({ themes: ['FIT_SIZING'], period: 'all' })).toBe('/marketing/reviews/inbox?period=all&theme=FIT_SIZING')
    expect(inboxPageHref()).toBe('/marketing/reviews/inbox')
  })
})
