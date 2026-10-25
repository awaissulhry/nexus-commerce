import { describe, expect, it } from 'vitest'
import {
  DEFAULT_READINESS_PAGE_SIZE,
  EMPTY_READINESS_QUERY,
  activeFilterCount,
  apiFilterParams,
  exportHref,
  familiesParams,
  familyPageHref,
  membersParams,
  notFoundWords,
  pageOfBlock,
  parseReadinessQuery,
  selectorChipText,
  selectorCount,
  serializeReadinessQuery,
  translateScope,
  viewFiltersOf,
  withFilter,
  withLock,
  withViewFilters,
  withoutFilters,
} from './readinessQuery'
import type { ReadinessLock } from './readinessScope'

describe('parseReadinessQuery — every older link keeps working', () => {
  it('the Products menu: ?productIds= is the selection', () => {
    const q = parseReadinessQuery('?productIds=p1,p2,p3')
    expect(q.selector).toEqual({ kind: 'productIds', value: 'p1,p2,p3' })
    expect(apiFilterParams(q)).toEqual({ productIds: 'p1,p2,p3' })
  })
  it('the Listings pages: ?listingIds=', () => {
    expect(parseReadinessQuery('?listingIds=l1').selector).toEqual({ kind: 'listingIds', value: 'l1' })
  })
  it('an import review: ?job=', () => {
    expect(apiFilterParams(parseReadinessQuery('?job=job_1'))).toEqual({ job: 'job_1' })
  })
  it('?skus= as one SKU or a JSON array', () => {
    expect(parseReadinessQuery('?skus=GAL-1').selector).toEqual({ kind: 'skus', value: 'GAL-1' })
    expect(parseReadinessQuery(`?skus=${encodeURIComponent('["A","B"]')}`).selector).toEqual({ kind: 'skus', value: '["A","B"]' })
  })
  it('the studio progress cards: ?channel=&marketplace=&language=', () => {
    const q = parseReadinessQuery('?channel=AMAZON&marketplace=IT&language=it')
    expect(apiFilterParams(q)).toEqual({ channel: 'AMAZON', marketplace: 'IT', language: 'it' })
    expect(parseReadinessQuery('?channel=SHARED&language=it').channel).toBe('SHARED')
  })
  it('?market= is the older name of ?marketplace=, and codes are upper-cased like the API does', () => {
    expect(parseReadinessQuery('?market=de').marketplace).toBe('DE')
    expect(parseReadinessQuery('?channel=amazon').channel).toBe('AMAZON')
  })
  it('?familyId=, ?accountId=, ?page=', () => {
    const q = parseReadinessQuery('?familyId=fam1&accountId=acc1&page=3')
    expect(q).toMatchObject({ familyId: 'fam1', accountId: 'acc1', page: 3 })
  })
  it('older ?state= values still work (every scope state), and the new notChecked tile', () => {
    for (const state of ['blocked', 'warn', 'ready', 'absent', 'notComputed', 'notChecked'] as const) {
      expect(parseReadinessQuery(`?state=${state}`).state).toBe(state)
    }
    expect(parseReadinessQuery('?state=teleport').state).toBe('')
  })
  it('one selection at a time: a link with both keeps its own selection and drops the family (the API refuses two)', () => {
    const q = parseReadinessQuery('?productIds=p1&familyId=fam1')
    expect(q.selector?.kind).toBe('productIds')
    expect(q.familyId).toBe('')
    expect(parseReadinessQuery('?productIds=p1&listingIds=l1').selector?.kind).toBe('productIds')
  })
  it('bad paging falls back to page 1 and 50 rows', () => {
    expect(parseReadinessQuery('?page=0&pageSize=25')).toMatchObject({ page: 1, pageSize: DEFAULT_READINESS_PAGE_SIZE })
    expect(parseReadinessQuery('?page=abc&pageSize=200')).toMatchObject({ page: 1, pageSize: 200 })
  })
  it('the new keys: q, parent, pageSize', () => {
    expect(parseReadinessQuery('?q=gale&parent=root1&pageSize=100')).toMatchObject({ q: 'gale', parent: 'root1', pageSize: 100 })
  })
  it('a plain visit is the empty query', () => {
    expect(parseReadinessQuery('')).toEqual(EMPTY_READINESS_QUERY)
  })
})

describe('serializeReadinessQuery — the address the page keeps', () => {
  it('round-trips, and leaves out the defaults', () => {
    const q = parseReadinessQuery('?channel=AMAZON&market=it&state=blocked&q=gale&parent=root1&page=2&pageSize=100')
    const out = serializeReadinessQuery(q)
    expect(Object.fromEntries(new URLSearchParams(out))).toEqual({ channel: 'AMAZON', marketplace: 'IT', state: 'blocked', q: 'gale', parent: 'root1', page: '2', pageSize: '100' })
    expect(parseReadinessQuery(out)).toEqual(q)
    expect(serializeReadinessQuery(EMPTY_READINESS_QUERY)).toBe('')
  })
})

describe('the API parameters', () => {
  const q = parseReadinessQuery('?channel=AMAZON&q=gale&state=notChecked&parent=root1&page=4')
  it('families: the filters plus page and pageSize; never the family page or the address page', () => {
    expect(Object.fromEntries(familiesParams(q, 2, 100))).toEqual({ channel: 'AMAZON', q: 'gale', state: 'notChecked', page: '2', pageSize: '100' })
  })
  it('members: the filters plus limit and offset', () => {
    expect(Object.fromEntries(membersParams(q, 10, 0))).toEqual({ channel: 'AMAZON', q: 'gale', state: 'notChecked', limit: '10', offset: '0' })
  })
  it('one family’s page keeps the filters and starts on page 1', () => {
    const href = familyPageHref(parseReadinessQuery('?channel=EBAY&page=3'), 'root 2')
    const url = new URL(href, 'http://x')
    expect(url.pathname).toBe('/listings')
    expect(Object.fromEntries(url.searchParams)).toEqual({ channel: 'EBAY', parent: 'root 2' })
  })
})

describe('pageOfBlock — one AG block is one API page', () => {
  it('a block that lines up with the page', () => {
    expect(pageOfBlock(0, 50, 50)).toEqual({ page: 1, pageSize: 50, skip: 0, take: 50 })
    expect(pageOfBlock(200, 400, 200)).toEqual({ page: 2, pageSize: 200, skip: 0, take: 200 })
  })
  it('a block that does not line up reads its slice of the page', () => {
    expect(pageOfBlock(120, 220, 100)).toEqual({ page: 2, pageSize: 100, skip: 20, take: 80 })
  })
})

describe('withFilter — one filter changed', () => {
  const base = { ...EMPTY_READINESS_QUERY, channel: 'AMAZON', marketplace: 'DE', accountId: 'acc1', page: 3 }
  it('goes back to page 1', () => {
    expect(withFilter(base, 'language', 'de')).toMatchObject({ language: 'de', page: 1 })
  })
  it('a new channel drops the market and the store; a new market drops the store', () => {
    expect(withFilter(base, 'channel', 'EBAY')).toMatchObject({ channel: 'EBAY', marketplace: '', accountId: '' })
    expect(withFilter(base, 'marketplace', 'IT')).toMatchObject({ marketplace: 'IT', accountId: '' })
    expect(withFilter(base, 'channel', 'AMAZON')).toMatchObject({ marketplace: 'DE', accountId: 'acc1' })
  })
  it('a family replaces a link’s own selection', () => {
    const linked = { ...EMPTY_READINESS_QUERY, selector: { kind: 'productIds' as const, value: 'p1' } }
    expect(withFilter(linked, 'familyId', 'fam1')).toMatchObject({ familyId: 'fam1', selector: null })
  })
  it('Clear empties the five filters only', () => {
    const q = { ...base, language: 'de', familyId: 'f', state: 'blocked' as const, q: 'x', selector: { kind: 'job' as const, value: 'j' } }
    expect(activeFilterCount(q)).toBe(5)
    expect(withoutFilters(q)).toMatchObject({ channel: '', marketplace: '', accountId: '', language: '', familyId: '', state: 'blocked', q: 'x', selector: { kind: 'job', value: 'j' }, page: 1 })
  })
})

describe('saved views keep the filters, not the link’s selection', () => {
  it('round-trips the filters and the state', () => {
    const q = parseReadinessQuery('?channel=AMAZON&marketplace=DE&state=warn&productIds=p1')
    const filters = viewFiltersOf(q)
    expect(filters).toEqual({ channel: 'AMAZON', marketplace: 'DE', accountId: '', language: '', familyId: '', state: 'warn', live: [], flags: [] })
    expect(withViewFilters(EMPTY_READINESS_QUERY, filters)).toMatchObject({ channel: 'AMAZON', marketplace: 'DE', state: 'warn', page: 1 })
  })
  it('ignores junk from an old view', () => {
    expect(withViewFilters(EMPTY_READINESS_QUERY, { state: 'nope' as never, channel: 3 as never })).toMatchObject({ state: '', channel: '' })
  })
})

describe('the selection chip', () => {
  it('counts what the link names', () => {
    expect(selectorChipText({ kind: 'productIds', value: 'a,b,b,c' })).toBe('3 chosen products')
    expect(selectorChipText({ kind: 'productIds', value: 'a' })).toBe('1 chosen product')
    expect(selectorChipText({ kind: 'listingIds', value: 'l1,l2' })).toBe('2 chosen listings')
    expect(selectorChipText({ kind: 'skus', value: '["A","B"]' })).toBe('2 chosen SKUs')
    expect(selectorChipText({ kind: 'skus', value: 'GAL-1' })).toBe('1 chosen SKU')
    expect(selectorChipText({ kind: 'job', value: 'job_1' })).toBe('Products from one import')
    expect(selectorCount({ kind: 'skus', value: '[broken' })).toBe(1)
  })
})

describe('translateScope — only what the old scope can express', () => {
  it('passes the old endpoint’s keys and nothing else', () => {
    const q = parseReadinessQuery('?productIds=p1&channel=AMAZON&market=IT&language=it&state=blocked&accountId=a1&pageSize=100&page=2')
    expect(translateScope(q)).toEqual({ ok: true, query: { productIds: 'p1', channel: 'AMAZON', marketplace: 'IT', language: 'it', state: 'blocked', accountId: 'a1' } })
  })
  it('is held, with its reason, when the page narrows by something the old scope cannot', () => {
    expect(translateScope(parseReadinessQuery('?channel=AMAZON'))).toMatchObject({ ok: false, reason: expect.stringContaining('language') })
    expect(translateScope(parseReadinessQuery('?language=it&q=gale'))).toMatchObject({ ok: false, reason: expect.stringContaining('search') })
    expect(translateScope(parseReadinessQuery('?language=it&state=notChecked'))).toMatchObject({ ok: false, reason: expect.stringContaining('Not checked') })
    expect(translateScope(parseReadinessQuery('?language=it&parent=root1'))).toMatchObject({ ok: false, reason: expect.stringContaining('family') })
  })
  it('an older state value the old scope knows still passes', () => {
    expect(translateScope(parseReadinessQuery('?language=it&state=absent'))).toEqual({ ok: true, query: { language: 'it', state: 'absent' } })
  })
})

/* ── A store page's lock (2026-10-24, docs/listings/LISTINGS-STORE-PAGES-2026-10-24.md) ──────────────────────────── */

describe('a store page', () => {
  const AMAZON_IT: ReadinessLock = { channel: 'AMAZON', marketplace: 'IT' }
  const AMAZON: ReadinessLock = { channel: 'AMAZON', marketplace: '' }
  const SHOPIFY: ReadinessLock = { channel: 'SHOPIFY', marketplace: '' }

  it('shows its store and market whatever the address says', () => {
    const q = parseReadinessQuery('?channel=EBAY&marketplace=DE&language=it', AMAZON_IT)
    expect(q).toMatchObject({ channel: 'AMAZON', marketplace: 'IT', language: 'it', lock: AMAZON_IT })
    expect(apiFilterParams(q)).toEqual({ channel: 'AMAZON', marketplace: 'IT', language: 'it' })
  })

  it('a store page without a market lets the market be chosen; Shopify’s one market is fixed', () => {
    expect(parseReadinessQuery('?marketplace=de', AMAZON)).toMatchObject({ channel: 'AMAZON', marketplace: 'DE' })
    expect(parseReadinessQuery('?marketplace=IT', SHOPIFY)).toMatchObject({ channel: 'SHOPIFY', marketplace: '' })
  })

  it('writes an address without what the path already says', () => {
    const q = parseReadinessQuery('?state=blocked&language=de', AMAZON_IT)
    expect(serializeReadinessQuery(q)).toBe('language=de&state=blocked')
    expect(serializeReadinessQuery(parseReadinessQuery('?marketplace=DE', AMAZON))).toBe('marketplace=DE')
    expect(serializeReadinessQuery(parseReadinessQuery('', AMAZON_IT))).toBe('')
  })

  it('keeps a family’s own page on the store page', () => {
    expect(familyPageHref(parseReadinessQuery('?state=warn', AMAZON_IT), 'root-1')).toBe('/listings/amazon/it?state=warn&parent=root-1')
    expect(familyPageHref(parseReadinessQuery('', SHOPIFY), 'root-1')).toBe('/listings/shopify?parent=root-1')
  })

  it('a fixed filter does not change; Clear and a saved view keep the lock', () => {
    const q = parseReadinessQuery('?language=it', AMAZON_IT)
    expect(withFilter(q, 'channel', 'EBAY')).toBe(q)
    expect(withFilter(q, 'marketplace', 'DE')).toBe(q)
    expect(withFilter(q, 'language', 'de')).toMatchObject({ channel: 'AMAZON', marketplace: 'IT', language: 'de' })
    expect(withoutFilters(q)).toMatchObject({ channel: 'AMAZON', marketplace: 'IT', language: '' })
    expect(withViewFilters(q, { channel: 'EBAY', marketplace: 'DE', state: 'ready' })).toMatchObject({ channel: 'AMAZON', marketplace: 'IT', state: 'ready' })
  })

  it('counts and saves only the filters the page does not fix', () => {
    const q = parseReadinessQuery('?language=it&familyId=f1', AMAZON_IT)
    expect(activeFilterCount(q)).toBe(2)
    expect(viewFiltersOf(q)).toEqual({ channel: '', marketplace: '', accountId: '', language: 'it', familyId: 'f1', state: '', live: [], flags: [] })
    expect(viewFiltersOf(parseReadinessQuery('?marketplace=DE', AMAZON))).toMatchObject({ channel: '', marketplace: 'DE' })
  })

  it('withLock leaves an unlocked or already locked query as it is', () => {
    expect(withLock(EMPTY_READINESS_QUERY)).toBe(EMPTY_READINESS_QUERY)
    const q = parseReadinessQuery('', AMAZON_IT)
    expect(withLock(q)).toBe(q)
  })

  it('Translate and the Fix window keep the store and market', () => {
    const q = parseReadinessQuery('?language=it', AMAZON_IT)
    expect(translateScope(q)).toEqual({ ok: true, query: { channel: 'AMAZON', marketplace: 'IT', language: 'it' } })
  })
})

/* ── The live layer (step 3 of docs/listings/LISTINGS-LIVE-LAYER-PLAN-2026-10-25.md) ─────────────────────────────────── */

describe('the live filters in the address', () => {
  it('live and flags are comma lists; junk is dropped, each value once, in the API’s order', () => {
    const q = parseReadinessQuery('?live=ended,active,teleport,active&flags=lowStock,error,nope')
    expect(q.live).toEqual(['active', 'ended'])
    expect(q.flags).toEqual(['error', 'lowStock'])
    expect(parseReadinessQuery('?live=&flags=,').live).toEqual([])
  })
  it('every live state and flag of the contract is read', () => {
    expect(parseReadinessQuery('?live=active,paused,draft,not_listed,ended,unknown').live).toEqual(['active', 'paused', 'draft', 'not_listed', 'ended', 'unknown'])
    expect(parseReadinessQuery('?flags=error,suppressed,outOfSync,lowStock').flags).toEqual(['error', 'suppressed', 'outOfSync', 'lowStock'])
  })
  it('sent to the API under the same names, and kept in the address', () => {
    const q = parseReadinessQuery('?state=blocked&live=active,paused&flags=error&q=gale')
    expect(apiFilterParams(q)).toEqual({ state: 'blocked', live: 'active,paused', flags: 'error', q: 'gale' })
    expect(Object.fromEntries(familiesParams(q, 1, 50))).toMatchObject({ live: 'active,paused', flags: 'error' })
    expect(Object.fromEntries(membersParams(q, 10, 0))).toMatchObject({ live: 'active,paused', flags: 'error' })
    expect(serializeReadinessQuery(q)).toBe('state=blocked&live=active%2Cpaused&flags=error&q=gale')
    expect(parseReadinessQuery(serializeReadinessQuery(q))).toEqual(q)
  })
  it('a store page keeps them, and its family page too', () => {
    const lock: ReadinessLock = { channel: 'AMAZON', marketplace: 'IT' }
    const q = parseReadinessQuery('?live=active&flags=suppressed', lock)
    expect(apiFilterParams(q)).toEqual({ channel: 'AMAZON', marketplace: 'IT', live: 'active', flags: 'suppressed' })
    expect(serializeReadinessQuery(q)).toBe('live=active&flags=suppressed')
    expect(familyPageHref(q, 'root-1')).toBe('/listings/amazon/it?live=active&flags=suppressed&parent=root-1')
    expect(withFilter(q, 'language', 'it')).toMatchObject({ live: ['active'], flags: ['suppressed'] })
  })
  it('Clear empties Channel state and Stock (Low stock); the live tiles’ flags stay, as the readiness tile does', () => {
    const q = parseReadinessQuery('?language=it&live=paused&flags=error,lowStock&state=warn')
    expect(activeFilterCount(q)).toBe(3)
    expect(withoutFilters(q)).toMatchObject({ language: '', live: [], flags: ['error'], state: 'warn' })
    expect(activeFilterCount(parseReadinessQuery('?flags=error'))).toBe(0)
  })
  it('a saved view keeps them; a view saved before them shows every channel state', () => {
    const q = parseReadinessQuery('?live=active&flags=outOfSync')
    expect(viewFiltersOf(q)).toMatchObject({ live: ['active'], flags: ['outOfSync'] })
    expect(withViewFilters(EMPTY_READINESS_QUERY, viewFiltersOf(q))).toMatchObject({ live: ['active'], flags: ['outOfSync'] })
    expect(withViewFilters(q, { channel: 'EBAY' })).toMatchObject({ live: [], flags: [] })
    expect(withViewFilters(q, { live: ['nope', 'ended'] as never, flags: 'error' as never })).toMatchObject({ live: ['ended'], flags: [] })
  })
  it('Translate is held while they narrow the page: its scope cannot', () => {
    expect(translateScope(parseReadinessQuery('?language=it&live=active'))).toMatchObject({ ok: false, reason: expect.stringContaining('channel') })
    expect(translateScope(parseReadinessQuery('?language=it&flags=lowStock'))).toMatchObject({ ok: false, reason: expect.stringContaining('Stock') })
  })
})

describe('a search with several terms', () => {
  it('names the first terms that matched nothing, then how many more', () => {
    const unmatched = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7']
    expect(notFoundWords({ tokens: 40, unmatched })).toBe('7 of 40 not found: A1, A2, A3, A4, A5 and 2 more')
    expect(notFoundWords({ tokens: 40, unmatched: ['B0ABC', 'GAL-1', '1234'] })).toBe('3 of 40 not found: B0ABC, GAL-1, 1234')
  })
  it('says nothing when every term matched, for one word, or from an older API', () => {
    expect(notFoundWords({ tokens: 40, unmatched: [] })).toBeNull()
    expect(notFoundWords({ tokens: 1, unmatched: ['x'] })).toBeNull()
    expect(notFoundWords(undefined)).toBeNull()
  })
})

/* ── Step 4: the server's order, the column filters and the export ─────────────────────────────────────────────────── */

describe('the order and the column filters in the address', () => {
  const MARKET: ReadinessLock = { channel: 'AMAZON', marketplace: 'IT' }
  it('sort, dir and the five column filter keys are read, sent to the API under the same names, and kept in the address', () => {
    const q = parseReadinessQuery('?sort=price&dir=desc&priceMin=20&priceMax=30.5&qtyMin=1&qtyMax=9&channelId=B0AB&live=active', MARKET)
    expect(q).toMatchObject({ sort: 'price', dir: 'desc', priceMin: '20', priceMax: '30.5', qtyMin: '1', qtyMax: '9', channelId: 'B0AB', live: ['active'] })
    expect(apiFilterParams(q)).toEqual({ channel: 'AMAZON', marketplace: 'IT', live: 'active', sort: 'price', dir: 'desc', priceMin: '20', priceMax: '30.5', qtyMin: '1', qtyMax: '9', channelId: 'B0AB' })
    expect(Object.fromEntries(familiesParams(q, 1, 50))).toMatchObject({ sort: 'price', dir: 'desc', priceMin: '20' })
    expect(Object.fromEntries(membersParams(q, 10, 0))).toMatchObject({ sort: 'price', dir: 'desc' })
    expect(serializeReadinessQuery(q)).toBe('live=active&sort=price&dir=desc&priceMin=20&priceMax=30.5&qtyMin=1&qtyMax=9&channelId=B0AB')
    expect(parseReadinessQuery(serializeReadinessQuery(q), MARKET)).toEqual(q)
  })
  it('the default order is left out of the address; junk is dropped, never sent on', () => {
    expect(parseReadinessQuery('')).toMatchObject({ sort: '', dir: 'asc', priceMin: '', channelId: '' })
    expect(serializeReadinessQuery(parseReadinessQuery('?dir=desc'))).toBe('')
    const junk = parseReadinessQuery('?sort=cheapest&dir=sideways&priceMin=ten&priceMax=-3&qtyMin=1.5&qtyMax=99999999999')
    expect(junk).toMatchObject({ sort: '', dir: 'asc', priceMin: '', priceMax: '', qtyMin: '', qtyMax: '' })
    expect(apiFilterParams(junk)).toEqual({})
    expect(apiFilterParams(parseReadinessQuery('?sort=name'))).toEqual({ sort: 'name' })
  })
  it('a store page keeps them; Clear empties the column filters but keeps the order; they count as filters', () => {
    const q = parseReadinessQuery('?sort=checked&dir=desc&qtyMax=3&channelId=B0', MARKET)
    expect(familyPageHref(q, 'root-1')).toBe('/listings/amazon/it?sort=checked&dir=desc&qtyMax=3&channelId=B0&parent=root-1')
    expect(activeFilterCount(q)).toBe(2)
    expect(withoutFilters(q)).toMatchObject({ sort: 'checked', dir: 'desc', qtyMax: '', channelId: '', channel: 'AMAZON', marketplace: 'IT' })
    expect(withFilter(q, 'language', 'it')).toMatchObject({ sort: 'checked', qtyMax: '3' })
  })
  it('a saved view keeps them; a view saved before step 4 has the default order and no column filter', () => {
    const q = parseReadinessQuery('?sort=stock&dir=desc&priceMin=5', MARKET)
    expect(viewFiltersOf(q)).toMatchObject({ sort: 'stock', dir: 'desc', priceMin: '5' })
    expect(viewFiltersOf(parseReadinessQuery('', MARKET))).not.toHaveProperty('sort')
    expect(withViewFilters(parseReadinessQuery('', MARKET), viewFiltersOf(q))).toMatchObject({ sort: 'stock', dir: 'desc', priceMin: '5', page: 1 })
    expect(withViewFilters(q, { channel: 'EBAY' })).toMatchObject({ sort: '', dir: 'asc', priceMin: '' })
    expect(withViewFilters(q, { sort: 'cheapest' as never, priceMin: 'x' })).toMatchObject({ sort: '', priceMin: '' })
  })
  it('Translate is held while a column filter narrows the page; an order does not hold it', () => {
    expect(translateScope(parseReadinessQuery('?language=it&channelId=B0', MARKET))).toMatchObject({ ok: false, reason: expect.stringContaining('column filters') })
    expect(translateScope(parseReadinessQuery('?language=it&sort=name', MARKET))).toEqual({ ok: true, query: { channel: 'AMAZON', marketplace: 'IT', language: 'it' } })
  })
})

describe('the export link', () => {
  it('a plain download of the page\'s filters and order, with the format, the level and the business', () => {
    const q = parseReadinessQuery('?state=blocked&sort=price&dir=desc&q=gale', { channel: 'AMAZON', marketplace: 'IT' })
    const href = exportHref('https://api.test', q, 'xlsx', 'listing', 'ws_12345678')
    const url = new URL(href)
    expect(url.pathname).toBe('/api/catalog-transfer/readiness/export')
    expect(Object.fromEntries(url.searchParams)).toEqual({ channel: 'AMAZON', marketplace: 'IT', state: 'blocked', q: 'gale', sort: 'price', dir: 'desc',
      format: 'xlsx', level: 'listing', workspaceId: 'ws_12345678' })
    expect(new URL(exportHref('https://api.test', EMPTY_READINESS_QUERY, 'csv', 'family', null)).search).toBe('?format=csv&level=family')
  })
})
