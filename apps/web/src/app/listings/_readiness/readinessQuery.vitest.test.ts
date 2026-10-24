import { describe, expect, it } from 'vitest'
import {
  DEFAULT_READINESS_PAGE_SIZE,
  EMPTY_READINESS_QUERY,
  activeFilterCount,
  apiFilterParams,
  familiesParams,
  familyPageHref,
  membersParams,
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
    expect(filters).toEqual({ channel: 'AMAZON', marketplace: 'DE', accountId: '', language: '', familyId: '', state: 'warn' })
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
    expect(viewFiltersOf(q)).toEqual({ channel: '', marketplace: '', accountId: '', language: 'it', familyId: 'f1', state: '' })
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
