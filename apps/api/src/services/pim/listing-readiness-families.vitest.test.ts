/**
 * Listing readiness, family view (rebuild 2026-10-23) — the pure parts: query checks, the language fold, the
 * not-computed fill, chips, destination order and words, problem kinds, the next step and the studio links. No database.
 */
import { describe, expect, it, vi } from 'vitest'
vi.mock('../../db.js', () => ({ default: {} }))
import {
  chipsOf, compareRows, describeDestinations, detailProblems, detailQuery, destinationInfos, familiesOf, familiesQuery, fillNotComputed, foldListings,
  matchesState, membersQuery, nextStepOf, pickNextStep, problemSummaries, searchScope, studioHref, summarizeMembers, channelName, aliasNameOf, countStates,
  NOT_CHECKED_MESSAGE, NOT_SET_UP_MESSAGE, type LightRow, type ProblemSummary, type ProblemAggregateRow,
} from './listing-readiness-families.service.js'
import { listingIssueKind, readinessProblemKind } from './listing-readiness.service.js'

const at = (minute: number) => new Date(Date.UTC(2026, 9, 23, 10, minute))
const key = (channel: string | null, market: string | null = null, accountId: string | null = null, aliasId: string | null = null) => JSON.stringify([channel, market, accountId, aliasId])
let n = 0
const row = (productId: string, coordinate: [string | null, string | null?, string | null?, string | null?], language: string, state: string, extra: Partial<LightRow> = {}): LightRow => {
  const [channel, market = null, accountId = null, aliasId = null] = coordinate
  return { id: `r${++n}`, productId, coordinateKey: key(channel, market, accountId, aliasId), channel, market, accountId, aliasId, language,
    label: channel ? `${channel} · ${market}` : 'Shared product', state, computedAt: at(0), pendingSince: null, ...extra }
}
const SHARED = key(null), AMAZON_IT = key('AMAZON', 'IT', 'a1'), AMAZON_DE = key('AMAZON', 'DE', 'a1')

describe('problem kind — one mapping from what the producers stamp', () => {
  it('maps every stored kind and the requiredEmpty flag; a required untranslated field is a translation', () => {
    expect(readinessProblemKind({ requiredEmpty: true })).toBe('required')
    expect(readinessProblemKind({ kind: 'value-missing' })).toBe('required')
    expect(readinessProblemKind({ kind: 'language-fallback' })).toBe('translation')
    expect(readinessProblemKind({ kind: 'language-fallback', requiredEmpty: true })).toBe('translation')
    for (const kind of ['theme-unset', 'theme-deprecated', 'attribute-unbound']) expect(readinessProblemKind({ kind })).toBe('setup')
    expect(readinessProblemKind({ kind: 'collision' })).toBe('rule')
    expect(readinessProblemKind({})).toBe('check')
    expect(readinessProblemKind({ kind: 'something-new' })).toBe('check')
  })
  it('the old page says the same in its own words, never "missing" for everything', () => {
    expect([{ requiredEmpty: true }, { kind: 'language-fallback' }, { kind: 'theme-unset' }, { kind: 'collision' }, {}].map(listingIssueKind))
      .toEqual(['missing', 'translation', 'schema', 'invalid', 'check'])
  })
})

describe('fold, families, not-computed fill', () => {
  it('folds languages per product and destination: worst wins, oldest check, pending when any row is', () => {
    const folded = foldListings([
      row('p1', ['AMAZON', 'IT', 'a1'], 'it', 'ready', { computedAt: at(5) }),
      row('p1', ['AMAZON', 'IT', 'a1'], 'de', 'blocked', { computedAt: at(2), pendingSince: at(3) }),
      row('p1', [null], 'it', 'warn'), row('p1', [null], 'de', 'warn'),
    ])
    expect(folded.size).toBe(2)
    expect(folded.get(`p1\u0000${AMAZON_IT}`)).toMatchObject({ state: 'blocked', language: 'de', computedAt: at(2), pending: true })
    expect(folded.get(`p1\u0000${AMAZON_IT}`)!.rowIds).toHaveLength(2)
    expect(folded.get(`p1\u0000${SHARED}`)).toMatchObject({ state: 'warn', language: 'de', pending: false })
  })
  it('an unknown stored state is not a verdict: it reads as not computed', () => {
    expect([...foldListings([row('p1', [null], 'it', 'checks-passed')]).values()][0].state).toBe('notComputed')
  })
  it('groups by the family root and marks a member that lacks a sibling destination not computed', () => {
    const parents: Record<string, string | null> = { v1: 'root', v2: 'root', root: null, solo: null }
    const families = familiesOf(foldListings([
      row('root', [null], 'it', 'ready'), row('v1', [null], 'it', 'ready'), row('v1', ['AMAZON', 'IT', 'a1'], 'it', 'warn'),
      row('v2', [null], 'it', 'blocked'), row('solo', [null], 'it', 'ready'),
    ]).values(), id => parents[id])
    expect([...families.keys()].sort()).toEqual(['root', 'solo'])
    const family = fillNotComputed(families.get('root')!)
    expect(family.get('v2')!.get(AMAZON_IT)).toMatchObject({ state: 'notComputed', filled: true, rowIds: [], language: null })
    expect(family.get('root')!.get(AMAZON_IT)).toMatchObject({ state: 'notComputed', filled: true })
    expect(family.get('v1')!.get(AMAZON_IT)).toMatchObject({ state: 'warn' })
    expect(fillNotComputed(families.get('solo')!).get('solo')!.size).toBe(1)
  })
  it('counts listings by state; Not checked = absent + not computed', () => {
    expect(countStates([{ state: 'ready' }, { state: 'absent' }, { state: 'notComputed' }, { state: 'absent' }])).toEqual({ blocked: 0, warn: 0, notComputed: 1, absent: 2, ready: 1 })
    expect(['absent', 'notComputed', 'warn'].map(s => matchesState(s as never, 'notChecked'))).toEqual([true, true, false])
    expect(matchesState('warn', undefined)).toBe(true)
    expect(matchesState('warn', 'blocked')).toBe(false)
  })
})

describe('destinations — chip order and words', () => {
  const infos = destinationInfos([
    row('p', ['ETSY', 'GLOBAL', 'e1'], 'en', 'ready'), row('p', ['WOOCOMMERCE', 'GLOBAL', 'w1'], 'it', 'ready'), row('p', ['BOL_COM', 'NL', 'b1'], 'nl', 'ready'),
    row('p', ['SHOPIFY', 'GLOBAL', 's1'], 'it', 'ready'), row('p', ['EBAY', 'IT', 'e2'], 'it', 'ready'),
    row('p', ['EBAY', 'IT', 'e2', 'al2'], 'it', 'ready', { label: 'eBay · IT · Second item' }),
    row('p', ['AMAZON', 'IT', 'a1'], 'it', 'ready'), row('p', ['AMAZON', 'DE', 'a1'], 'de', 'ready'), row('p', [null], 'it', 'ready'),
  ])
  it('Shared first, then Amazon, eBay, Shopify, Etsy, the rest A–Z; market A–Z; the main listing before an alias', () => {
    expect(describeDestinations(infos.values()).map(d => d.label)).toEqual(['Shared', 'Amazon DE', 'Amazon IT', 'eBay IT', 'eBay IT · Second item', 'Shopify', 'Etsy', 'Bol Com NL', 'WooCommerce'])
  })
  it('carries the coordinate as the contract spells it: Shared is channel SHARED, marketplace empty', () => {
    const [shared, , amazonIt] = describeDestinations(infos.values())
    expect(shared).toEqual({ key: SHARED, channel: 'SHARED', marketplace: '', accountId: null, aliasKey: '', label: 'Shared' })
    expect(amazonIt).toEqual({ key: AMAZON_IT, channel: 'AMAZON', marketplace: 'IT', accountId: 'a1', aliasKey: '', label: 'Amazon IT' })
  })
  it('names the store only when two stores share a channel and market', () => {
    const two = destinationInfos([row('p', ['AMAZON', 'IT', 'a1'], 'it', 'ready'), row('p', ['AMAZON', 'IT', 'a2'], 'it', 'ready'), row('p', ['AMAZON', 'DE', 'a1'], 'de', 'ready')])
    expect(describeDestinations(two.values(), new Map([['a1', 'Xavia'], ['a2', 'Gale']])).map(d => d.label)).toEqual(['Amazon DE', 'Amazon IT · Gale', 'Amazon IT · Xavia'])
    expect(describeDestinations(two.values(), new Map()).map(d => d.label)).toEqual(['Amazon DE', 'Amazon IT · Store …a1', 'Amazon IT · Store …a2'])
    // The Fix window shows one destination; the other store on that market still names it.
    const one = destinationInfos([row('p', ['AMAZON', 'IT', 'a1'], 'it', 'ready')])
    expect(describeDestinations(one.values(), new Map([['a1', 'Xavia']]), [{ channel: 'AMAZON', market: 'IT', accountId: 'a2' }])[0].label).toBe('Amazon IT · Xavia')
  })
  it('reads an alias name off the index label and title-cases an unknown channel', () => {
    expect(aliasNameOf('Amazon · IT · Seller A · Outlet', 'Amazon · IT · Seller A', 'al1')).toBe('Outlet')
    expect(aliasNameOf('Amazon · IT · Outlet', undefined, 'al1')).toBe('Outlet')
    expect(aliasNameOf('Listing', undefined, 'al1')).toBe('al1')
    expect(channelName('EBAY')).toBe('eBay')
    expect(channelName('BOL_COM')).toBe('Bol Com')
  })
})

describe('studio links — the same bare paths the web built (issueFieldHref / studioFieldHref)', () => {
  const amazon = { channel: 'AMAZON', market: 'IT', accountId: 'acc1', aliasId: null }
  it('a destination without a field opens its errors tab, exactly like the old editorHref', () => {
    expect(studioHref('p1', amazon, 'it')).toBe('/products/p1/edit/studio?scope=AMAZON&locale=it&tab=errors&market=IT&account=acc1')
    expect(studioHref('p1', { channel: null, market: null, accountId: null, aliasId: null }, 'it')).toBe('/products/p1/edit/studio?scope=master&locale=it&tab=errors')
  })
  it('a field opens its exact cell: no tab, rec=<alias or primary>:<product> on a channel, the product id on Shared', () => {
    expect(studioHref('p1', amazon, 'it', 'manufacturer')).toBe('/products/p1/edit/studio?scope=AMAZON&locale=it&market=IT&account=acc1&rec=primary%3Ap1&cell=manufacturer')
    expect(studioHref('p1', { channel: 'EBAY', market: 'IT', accountId: null, aliasId: 'al2' }, 'it', 'brand')).toBe('/products/p1/edit/studio?scope=EBAY&locale=it&market=IT&alias=al2&rec=al2%3Ap1&cell=brand')
    expect(studioHref('p1', { channel: null, market: null, accountId: null, aliasId: null }, 'it', 'name')).toBe('/products/p1/edit/studio?scope=master&locale=it&rec=p1&cell=name')
    const url = new URL(studioHref('a b', amazon, 'it', 'x'), 'http://x')
    expect(url.pathname).toBe('/products/a%20b/edit/studio')
  })
})

describe('chips and the next step', () => {
  const order = new Map([SHARED, AMAZON_DE, AMAZON_IT].map((k, i) => [k, i]))
  const listing = (productId: string, destinationKey: string, state: string, extra = {}) => ({ productId, destinationKey, state: state as never, language: 'it', worstRowId: `${productId}-${destinationKey}`, rowIds: [], computedAt: at(1), pending: false, ...extra })
  const problem = (destinationKey: string, field: string, kind: ProblemSummary['kind'], affected = 1): ProblemSummary => ({ destinationKey, field, label: field, kind, message: `${field} needs work`, affected, productId: 'v1', locale: 'de' })
  it('one chip per destination in order: counts by state, worst state, oldest check, pending, problems', () => {
    const chips = chipsOf([listing('v1', AMAZON_IT, 'ready'), listing('v2', AMAZON_IT, 'blocked', { computedAt: at(0), pending: true }), listing('v1', SHARED, 'warn')], order,
      new Map([[AMAZON_IT, [problem(AMAZON_IT, 'title', 'required'), problem(AMAZON_IT, 'brand', 'check')]]]))
    expect(chips.map(c => c.destinationKey)).toEqual([SHARED, AMAZON_IT])
    expect(chips[1]).toEqual({ destinationKey: AMAZON_IT, state: 'blocked', counts: { blocked: 1, warn: 0, notComputed: 0, absent: 0, ready: 1 }, issueCount: 2, pending: true, computedAt: at(0).toISOString() })
  })
  it('the worst chip, then kind, then most listings, then destination order, then field', () => {
    const chips = chipsOf([listing('v1', SHARED, 'warn'), listing('v1', AMAZON_DE, 'blocked'), listing('v1', AMAZON_IT, 'blocked')], order)
    const problems = new Map([
      [SHARED, [problem(SHARED, 'title', 'required', 9)]],
      [AMAZON_DE, [problem(AMAZON_DE, 'size', 'check', 9), problem(AMAZON_DE, 'title', 'translation', 2)]],
      [AMAZON_IT, [problem(AMAZON_IT, 'title', 'translation', 2), problem(AMAZON_IT, 'colour', 'translation', 3)]],
    ])
    expect(pickNextStep(chips, problems, order)!.problem).toMatchObject({ destinationKey: AMAZON_IT, field: 'colour' })
    problems.get(AMAZON_IT)!.pop()
    expect(pickNextStep(chips, problems, order)!.problem).toMatchObject({ destinationKey: AMAZON_DE, field: 'title' })
    problems.set(AMAZON_DE, [problem(AMAZON_DE, 'b', 'setup', 2), problem(AMAZON_DE, 'a', 'setup', 2)])
    problems.set(AMAZON_IT, [])
    expect(pickNextStep(chips, problems, order)!.problem).toMatchObject({ field: 'a' })
    expect(pickNextStep(chipsOf([listing('v1', SHARED, 'ready')], order), problems, order)).toBeNull()
  })
  it('a pick with a problem links its exact field', () => {
    const chips = chipsOf([listing('v1', AMAZON_IT, 'blocked')], order)
    const step = nextStepOf(pickNextStep(chips, new Map([[AMAZON_IT, [problem(AMAZON_IT, 'title', 'required', 4)]]]), order), () => ({ channel: 'AMAZON', market: 'IT', accountId: 'a1', aliasId: null }), undefined)
    expect(step).toEqual({ destinationKey: AMAZON_IT, field: 'title', label: 'title', message: 'title needs work', kind: 'required', affected: 4, productId: 'v1', locale: 'de',
      href: '/products/v1/edit/studio?scope=AMAZON&locale=de&market=IT&account=a1&rec=primary%3Av1&cell=title' })
  })
  it('a worst chip without a recorded problem uses the row note, else plain words, and opens the errors tab', () => {
    const coordinate = () => ({ channel: 'AMAZON', market: 'IT', accountId: 'a1', aliasId: null })
    const notComputed = chipsOf([listing('v1', AMAZON_IT, 'notComputed'), listing('v2', AMAZON_IT, 'notComputed'), listing('v1', SHARED, 'ready')], order)
    expect(nextStepOf(pickNextStep(notComputed, new Map(), order), coordinate, { productId: 'v1', locale: 'it' })).toEqual({ destinationKey: AMAZON_IT, field: null, label: 'Not computed',
      message: NOT_CHECKED_MESSAGE, kind: 'check', affected: 2, productId: 'v1', locale: 'it', href: '/products/v1/edit/studio?scope=AMAZON&locale=it&tab=errors&market=IT&account=a1' })
    const absent = chipsOf([listing('v1', AMAZON_IT, 'absent')], order)
    expect(nextStepOf(pickNextStep(absent, new Map(), order), coordinate, { productId: 'v1', locale: 'it' })).toMatchObject({ message: NOT_SET_UP_MESSAGE, kind: 'setup', label: 'Not set up' })
    expect(nextStepOf(pickNextStep(absent, new Map(), order), coordinate, { productId: 'v1', locale: 'it', note: 'Category metadata is incomplete: COAT' })).toMatchObject({ message: 'Category metadata is incomplete: COAT' })
  })
})

describe('order', () => {
  const p = (id: string, name: string | null, sku: string, isParent = false) => ({ id, name, sku, parentId: id === 'root' ? null : 'root', isParent })
  it('top level: worst first, then name case-insensitively, SKU, id', () => {
    const rows = [
      { id: 'c', name: 'beta', sku: 'B', state: 'ready' as const }, { id: 'b', name: 'Alpha', sku: 'Z', state: 'ready' as const },
      { id: 'a', name: 'alpha', sku: 'Z', state: 'ready' as const }, { id: 'd', name: 'zulu', sku: 'A', state: 'blocked' as const }, { id: 'e', name: 'Alpha', sku: 'A', state: 'ready' as const },
    ]
    expect(rows.sort(compareRows).map(r => r.id)).toEqual(['d', 'e', 'a', 'b', 'c'])
  })
  it('members: the parent listing first, then variants worst first, then name and SKU; the state filter marks matches', () => {
    const products = new Map([p('root', 'Jacket', 'J', true), p('v1', 'Jacket M', 'J-M'), p('v2', 'Jacket L', 'J-L'), p('v3', 'Jacket S', 'J-S')].map(x => [x.id, x]))
    const family = familiesOf(foldListings([row('root', [null], 'it', 'ready'), row('v1', [null], 'it', 'ready'), row('v2', [null], 'it', 'ready'), row('v3', [null], 'it', 'blocked')]).values(), id => products.get(id)!.parentId).get('root')!
    const members = summarizeMembers(family, 'root', true, id => products.get(id), 'blocked')
    expect(members.map(m => [m.product.id, m.isParentListing, m.matches])).toEqual([['root', true, false], ['v3', false, true], ['v2', false, false], ['v1', false, false]])
    expect(summarizeMembers(family, 'root', false, id => products.get(id))[0].isParentListing).toBe(false)
  })
})

describe('problems', () => {
  const agg = (field: string, pair: string | null, affected: number, extra: Partial<ProblemAggregateRow> = {}): ProblemAggregateRow =>
    ({ groupId: 'root', coordinateKey: AMAZON_IT, field, pair, level: pair === null ? 1 : 0, affected, label: field.toUpperCase(), reason: `${field}:${pair}`, productId: 'v1', language: 'it', ...extra })
  it('one problem per field: its most urgent kind, that group\'s sentence and sample, the field\'s distinct listings', () => {
    const summaries = problemSummaries([
      agg('title', '|0', 5), agg('title', 'language-fallback|1', 2, { productId: 'v2', language: 'de' }), agg('title', null, 6),
      agg('brand', '|0', 1), agg('brand', '|1', 1), agg('brand', null, 1),
    ]).get('root')!.get(AMAZON_IT)!
    expect(summaries).toEqual([
      { destinationKey: AMAZON_IT, field: 'title', label: 'TITLE', kind: 'translation', message: 'title:language-fallback|1', affected: 6, productId: 'v2', locale: 'de' },
      { destinationKey: AMAZON_IT, field: 'brand', label: 'BRAND', kind: 'required', message: 'brand:|1', affected: 1, productId: 'v1', locale: 'it' },
    ])
  })
  it('the Fix window: required → translation → setup → rule → check, then listings touched; products capped at 50', () => {
    const rows = [
      ...Array.from({ length: 60 }, (_, i) => ({ productId: `v${String(i).padStart(2, '0')}`, language: 'it', missing: [{ field: 'colour', label: 'Colour', reason: 'No colour', kind: 'collision' }] })),
      { productId: 'v01', language: 'de', missing: [{ field: 'title', label: 'Title', reason: 'de content is missing', kind: 'language-fallback', requiredEmpty: true, requiredBy: ['Amazon · DE'] }] },
      { productId: 'v02', language: 'it', missing: [{ field: 'brand', label: 'Brand', reason: 'Required and empty', requiredEmpty: true, requiredBy: ['Family: Jackets'] }, { field: 'title', label: 'Title', reason: 'Too long' }] },
      { productId: 'v03', language: 'it', missing: [{ field: 'brand', label: 'Brand', reason: 'Required and empty', requiredEmpty: true, requiredBy: ['Amazon · DE'] }] },
    ]
    const problems = detailProblems(rows, id => Number(id.slice(1)), id => ({ sku: id.toUpperCase(), name: null }), (productId, locale, field) => `${productId}/${locale}/${field}`)
    expect(problems.map(p => [p.field, p.kind, p.productCount])).toEqual([['brand', 'required', 2], ['title', 'translation', 2], ['colour', 'rule', 60]])
    expect(problems[0]).toMatchObject({ requiredBy: ['Family: Jackets', 'Amazon · DE'], languages: ['it'], href: 'v02/it/brand', products: [{ id: 'v02', sku: 'V02', name: null }, { id: 'v03', sku: 'V03', name: null }] })
    expect(problems[1]).toMatchObject({ message: 'de content is missing', languages: ['de', 'it'], href: 'v01/de/title' })
    expect(problems[2].products).toHaveLength(50)
  })
})

describe('query checks (answered 400 by the route)', () => {
  it('takes everything readinessQuery takes plus search, the state tile and the page size', () => {
    expect(familiesQuery({})).toMatchObject({ page: 1, pageSize: 50, q: undefined, state: undefined })
    expect(familiesQuery({ q: '  gale ', state: 'notChecked', pageSize: '200', page: '2', channel: 'amazon', market: 'it' })).toMatchObject({ q: 'gale', state: 'notChecked', pageSize: 200, page: 2, channel: 'AMAZON', marketplace: 'IT' })
    expect(() => familiesQuery({ pageSize: '25' })).toThrow('50, 100 or 200')
    expect(() => familiesQuery({ state: 'checks-passed' })).toThrow('readiness state')
    // Live layer step 3: a search may be a pasted list — 4,000 characters (and 500 terms).
    expect(familiesQuery({ q: 'x'.repeat(4000) }).q).toHaveLength(4000)
    expect(() => familiesQuery({ q: 'x'.repeat(4001) })).toThrow('Invalid search')
    expect(() => familiesQuery({ q: ['a', 'b'] })).toThrow('Invalid search')
    expect(() => familiesQuery({ familyId: 'f', skus: 'A' })).toThrow('Choose one')
    expect(() => familiesQuery({ page: '0' })).toThrow('positive')
  })
  it('members: limit 1–200 (10 by default) and an offset', () => {
    expect(membersQuery('root', {})).toMatchObject({ rootId: 'root', limit: 10, offset: 0 })
    expect(membersQuery('root', { limit: '200', offset: '10' })).toMatchObject({ limit: 200, offset: 10 })
    expect(() => membersQuery('root', { limit: '0' })).toThrow('1–200')
    expect(() => membersQuery('root', { limit: '201' })).toThrow('1–200')
    expect(() => membersQuery('root', { offset: '-1' })).toThrow('offset')
  })
  it('detail: a product, family 1 or 0, and a destination coordinate key', () => {
    expect(detailQuery({ productId: 'p1', family: '1', destination: AMAZON_IT })).toMatchObject({ productId: 'p1', family: true, destination: { key: AMAZON_IT, channel: 'AMAZON', market: 'IT', accountId: 'a1', aliasId: null } })
    expect(detailQuery({ productId: 'p1', destination: SHARED })).toMatchObject({ family: false, destination: { key: SHARED, channel: null } })
    expect(() => detailQuery({ destination: SHARED })).toThrow('Select a product')
    expect(() => detailQuery({ productId: 'p1', family: 'yes', destination: SHARED })).toThrow('family')
    for (const destination of [undefined, 'AMAZON', '[1,2,3,4]', '["AMAZON","IT"]', '["",null,null,null]']) expect(() => detailQuery({ productId: 'p1', destination })).toThrow('Select a destination')
  })
  it('search: a product matches itself, a matching root brings its family', () => {
    expect(searchScope([{ id: 'root', parentId: null }, { id: 'v9', parentId: 'other' }])).toEqual({ product: { OR: [{ id: { in: ['root', 'v9'] } }, { parentId: { in: ['root'] } }] } })
  })
})

