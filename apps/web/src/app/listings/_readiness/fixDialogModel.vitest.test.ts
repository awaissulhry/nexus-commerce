import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReadinessProblem } from '@nexus/shared/listing-readiness'
import {
  emptyWords, fixDetailPath, fixTitle, inBusiness, listingTotal, listingWords, moreWords, PROBLEM_KIND_LABELS, problemKindLabel,
  productTitle, requiredByWords, stateLine, stateParts,
} from './fixDialogModel'

const counts = (over: Partial<Record<'blocked' | 'warn' | 'notComputed' | 'absent' | 'ready', number>> = {}) =>
  ({ blocked: 0, warn: 0, notComputed: 0, absent: 0, ready: 0, ...over })
const problem = (over: Partial<ReadinessProblem> = {}): ReadinessProblem =>
  ({ field: 'size_chart', label: 'Size chart', kind: 'required', message: 'Add a size chart.', requiredBy: [], languages: ['it'], products: [], productCount: 0, href: null, ...over })

describe('the Fix window words', () => {
  it('names each kind of problem in plain words', () => {
    expect(PROBLEM_KIND_LABELS).toEqual({ required: 'Required', translation: 'Translation', setup: 'Setup', rule: 'Rule', check: 'Check' })
    expect(problemKindLabel('translation')).toBe('Translation')
    // A kind the page does not know is shown as it came, not as one of ours.
    expect(problemKindLabel('novel' as never)).toBe('novel')
  })
  it('counts listings, singular for one', () => {
    expect(listingWords(1)).toBe('1 product')
    expect(listingWords(20)).toBe('20 products')
    expect(listingWords(1240)).toBe('1,240 products')
  })
  it('says how many listings were left out of the list, and nothing when none were', () => {
    expect(moreWords(50, 80)).toBe('and 30 more')
    expect(moreWords(50, 1050)).toBe('and 1,000 more')
    expect(moreWords(3, 3)).toBeNull()
  })
  it('names who requires the field, or nothing', () => {
    expect(requiredByWords(['Amazon category JACKET', 'eBay item specifics'])).toBe('Required by Amazon category JACKET, eBay item specifics')
    expect(requiredByWords([])).toBeNull()
    expect(requiredByWords(['  '])).toBeNull()
  })
  it('lists listings by state worst first, only the states that have any, in the DS readiness words', () => {
    expect(stateParts(counts({ ready: 17, blocked: 3 })).map((part) => part.text)).toEqual(['3 blocked', '17 ready'])
    expect(stateParts(counts({ warn: 2, absent: 1, notComputed: 4 })).map((part) => [part.text, part.tone])).toEqual([
      ['2 warnings', 'warning'], ['4 not computed', 'neutral'], ['1 not set up', 'neutral'],
    ])
    expect(stateParts(counts())).toEqual([])
    expect(listingTotal(counts({ ready: 17, blocked: 3, absent: 1 }))).toBe(21)
  })
  it('titles the window product · destination', () => {
    expect(fixTitle('GALE-JACKET', 'Amazon DE')).toBe('GALE-JACKET · Amazon DE')
  })
  it('takes the title name from the caller, else the product itself among the listings, never another product', () => {
    const detail = { productId: 'p1', problems: [problem({ products: [{ id: 'v2', sku: 'GALE-M', name: 'Gale M' }] }), problem({ products: [{ id: 'p1', sku: 'GALE', name: null }] })] }
    expect(productTitle('Gale jacket', detail, true)).toBe('Gale jacket')
    expect(productTitle(null, detail, true)).toBe('GALE')
    expect(productTitle('  ', { productId: 'p1', problems: [problem({ products: [{ id: 'v2', sku: 'GALE-M', name: 'Gale M' }] })] }, true)).toBe('This family')
    expect(productTitle(undefined, null, false)).toBe('This product')
  })
  it('says "Nothing to fix" only when the check says Ready', () => {
    expect(emptyWords('ready', 'Amazon DE')).toEqual({ title: 'Nothing to fix on Amazon DE', description: null })
    expect(emptyWords('notComputed', 'eBay IT').title).toBe('Not computed on eBay IT')
    expect(emptyWords('notComputed', 'eBay IT').description).toMatch(/not a score of zero/)
    expect(emptyWords('absent', 'Shopify').title).toBe('Not set up on Shopify')
    expect(emptyWords('blocked', 'Amazon DE')).toEqual({ title: 'Blocked on Amazon DE', description: 'The check named no fields here. Open the studio to see its checks.' })
  })
})

describe('the Fix window read', () => {
  it('passes the page filters on, drops paging, and its own keys win', () => {
    const path = fixDetailPath({ channel: 'AMAZON', search: 'gale', page: '3', pageSize: '100', state: 'blocked', destination: 'old', language: '' }, { productId: 'p1', family: true, destinationKey: '["AMAZON","DE",null,""]' })
    const [base, search] = path.split('?')
    expect(base).toBe('catalog-transfer/readiness/detail')
    expect(Object.fromEntries(new URLSearchParams(search))).toEqual({ channel: 'AMAZON', search: 'gale', state: 'blocked', destination: '["AMAZON","DE",null,""]', productId: 'p1', family: '1' })
  })
  it('a single product asks for family=0', () => {
    expect(new URLSearchParams(fixDetailPath({}, { productId: 'p9', family: false, destinationKey: 'k' }).split('?')[1]).get('family')).toBe('0')
  })
})

describe('the Fix window links', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules() })
  it('keeps a bare studio path as it is when business profiles are off', () => {
    expect(inBusiness('/products/p1/edit/studio?scope=AMAZON', 'ws_12345678')).toBe('/products/p1/edit/studio?scope=AMAZON')
  })
  it('puts a bare studio path inside the current business, once', async () => {
    vi.stubEnv('NEXT_PUBLIC_WORKSPACES_ENABLED', '1')
    vi.resetModules()
    const { inBusiness: scoped } = await import('./fixDialogModel')
    expect(scoped('/products/p1/edit/studio?rec=p1&cell=name', 'ws_12345678')).toBe('/w/ws_12345678/products/p1/edit/studio?rec=p1&cell=name')
    expect(scoped('/w/ws_12345678/products/p1/edit/studio', 'ws_12345678')).toBe('/w/ws_12345678/products/p1/edit/studio')
    expect(scoped('/products/p1/edit/studio', null)).toBe('/products/p1/edit/studio')
  })
})

describe('the summary’s listings line', () => {
  const c = (over: Partial<Record<'blocked' | 'warn' | 'notComputed' | 'absent' | 'ready', number>>) => ({ blocked: 0, warn: 0, notComputed: 0, absent: 0, ready: 0, ...over })
  it('says "all" when every listing has one state, and lists the states otherwise', () => {
    expect(stateLine(c({ blocked: 21 }))).toBe('21 products, all blocked')
    expect(stateLine(c({ blocked: 18, ready: 3 }))).toBe('21 products: 18 blocked · 3 ready')
    expect(stateLine(c({ ready: 1 }))).toBe('1 product, ready')
  })
})
