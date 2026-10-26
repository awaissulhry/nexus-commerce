/**
 * Listings — step 4 of the live layer: the per-listing columns per page scope, their words, the server's order and the
 * market page's column filters (`listingColumns.ts`).
 */
import { describe, expect, it } from 'vitest'
import type { ReadinessChip, ReadinessDestination, ReadinessLiveSummary } from '@nexus/shared/listing-readiness'

import { AG_AUTO_COL } from '@/design-system/grid/columns/columnPrefs'
import {
  channelIdWords,
  destinationColumnsReady,
  filterModelOf,
  filtersFromModel,
  gridStateToApply,
  initialColumnIds,
  initialGridState,
  lastPushMeta,
  listingChips,
  listingColumnLabel,
  listingColumnsFor,
  listingFacts,
  messageWords,
  pageScopeOf,
  pinnedWords,
  priceWords,
  qtyWords,
  readinessColumnSpecs,
  requestQuery,
  sortFromModel,
  sortModelOf,
  sortableColumns,
  statusWords,
} from './listingColumns'
import { destinationFromKey, destinationLookup } from './marketChips'
import { parseReadinessQuery } from './readinessQuery'

const AMAZON_IT = JSON.stringify(['AMAZON', 'IT', 'a1', null]), AMAZON_DE = JSON.stringify(['AMAZON', 'DE', 'a1', null])
const AMAZON_IT_ALIAS = JSON.stringify(['AMAZON', 'IT', 'a1', 'al1']), AMAZON_IT_GALE = JSON.stringify(['AMAZON', 'IT', 'a2', null])
const SHARED = JSON.stringify([null, null, null, null])

const live = (extra: Partial<ReadinessLiveSummary> = {}): ReadinessLiveSummary => ({
  state: 'active', listed: 1, notListed: 0, byState: { active: 1 }, externalId: 'B0X', url: 'https://www.amazon.it/dp/B0X', priceMin: 49.9, priceMax: 49.9,
  currency: 'EUR', quantity: 4, fulfillment: 'FBM', channelErrorCount: 0, suppressedCount: 0, outOfSyncCount: 0, syncFailedCount: 0, lastSyncedAt: '2026-10-24T10:00:00.000Z',
  duplicates: 0, channelWarningCount: 0, pricePinnedCount: 0, pricedCount: 1, push: { worst: 'done', failed: 0, waiting: 0, done: 1, other: 0 }, ...extra,
})
const chip = (destinationKey: string, summary: ReadinessLiveSummary | null): ReadinessChip => ({
  destinationKey, state: 'ready', counts: { blocked: 0, warn: 0, notComputed: 0, absent: 0, ready: 1 }, issueCount: 0, pending: false, computedAt: null, live: summary,
})
const lookup = destinationLookup([
  { ...destinationFromKey(AMAZON_IT), label: 'Amazon IT' }, { ...destinationFromKey(AMAZON_DE), label: 'Amazon DE' },
  { ...destinationFromKey(AMAZON_IT_ALIAS), label: 'Amazon IT · Old title' }, { ...destinationFromKey(SHARED), label: 'Shared' },
] as ReadinessDestination[])

describe('the columns per page scope', () => {
  it('/listings offers none; a store page offers all (Price only with one currency); a market page offers all', () => {
    expect(pageScopeOf(null)).toBe('all')
    expect(pageScopeOf({ channel: 'AMAZON', marketplace: '' })).toBe('store')
    expect(pageScopeOf({ channel: 'AMAZON', marketplace: 'IT' })).toBe('market')
    const ALL = ['status', 'price', 'qty', 'channelId', 'lastPush', 'synced', 'messages']
    expect(listingColumnsFor('all', { live: true, currencies: ['EUR'] })).toEqual([])
    expect(listingColumnsFor('market', { live: true, currencies: ['EUR', 'GBP'] })).toEqual(ALL)
    expect(listingColumnsFor('store', { live: true, currencies: ['EUR', 'EUR'] })).toEqual(ALL)
    expect(listingColumnsFor('store', { live: true, currencies: ['EUR', 'GBP', 'SEK'] })).toEqual(ALL.filter((c) => c !== 'price'))
    // Without live data none of them exist.
    for (const scope of ['all', 'store', 'market'] as const) expect(listingColumnsFor(scope, { live: false, currencies: ['EUR'] })).toEqual([])
  })

  it('Customise: a market page shows them (Readiness, the channel\'s own id word); a store page offers them hidden; On the channel waits on a market page', () => {
    const market = readinessColumnSpecs('market', { live: true, listingColumns: listingColumnsFor('market', { live: true, currencies: [] }), channel: 'AMAZON' })
    expect(market.map((c) => [c.key, c.label, c.shown])).toEqual([
      ['product', 'Product', true], ['markets', 'Readiness', true], ['status', 'Status', true], ['price', 'Price', true], ['qty', 'Qty', true], ['channelId', 'ASIN', true],
      ['lastPush', 'Last push', true], ['synced', 'Synced', true], ['messages', 'Channel messages', true], ['live', 'On the channel', false],
      ['nextStep', 'Next step', true], ['checked', 'Checked', true], ['actions', 'Actions', true],
    ])
    const store = readinessColumnSpecs('store', { live: true, listingColumns: listingColumnsFor('store', { live: true, currencies: ['EUR', 'GBP'] }), channel: 'EBAY' })
    expect(store.filter((c) => !c.shown).map((c) => c.key)).toEqual(['status', 'qty', 'channelId', 'lastPush', 'synced', 'messages'])
    expect(store.find((c) => c.key === 'channelId')!.label).toBe('Item ID')
    expect(store.find((c) => c.key === 'markets')!.label).toBe('Markets')
    // /listings and a page without live data: as before step 4.
    expect(readinessColumnSpecs('all', { live: true, listingColumns: [], channel: null }).map((c) => c.key)).toEqual(['product', 'markets', 'live', 'nextStep', 'checked', 'actions'])
    expect(readinessColumnSpecs('market', { live: false, listingColumns: [], channel: 'AMAZON' }).map((c) => c.key)).toEqual(['product', 'markets', 'nextStep', 'checked', 'actions'])
    expect(listingColumnLabel('channelId', null)).toBe('Channel ID')
  })
})

describe('what a row\'s columns read', () => {
  it('the main listings on the page\'s store and market: never Shared, an alias, a destination Nexus does not check, or another store', () => {
    const noted = JSON.stringify(['AMAZON', 'IT', 'gone', null])
    const withNote = destinationLookup([{ ...destinationFromKey(noted), label: 'Amazon IT · Old store', note: 'This account is not connected any more' }])
    const chips = [chip(SHARED, null), chip(AMAZON_IT, live()), chip(AMAZON_IT_ALIAS, live({ priceMin: 1, priceMax: 1 })), chip(AMAZON_DE, live({ priceMin: 30, priceMax: 30 })),
      chip(AMAZON_IT_GALE, live({ priceMin: 2, priceMax: 2 }))]
    const lock = { channel: 'AMAZON' as const, marketplace: 'IT' }
    expect(listingChips(chips, lookup, { lock }).map((c) => c.destinationKey)).toEqual([AMAZON_IT, AMAZON_IT_GALE])
    expect(listingChips(chips, lookup, { lock, accountId: 'a1' }).map((c) => c.destinationKey)).toEqual([AMAZON_IT])
    expect(listingChips(chips, lookup, { lock: { channel: 'AMAZON', marketplace: '' } }).map((c) => c.destinationKey)).toEqual([AMAZON_IT, AMAZON_DE, AMAZON_IT_GALE])
    expect(listingChips([chip(noted, live())], (key) => withNote(key), { lock })).toEqual([])
  })

  it('one destination: its own numbers; several (a store page): a state that differs is Mixed, a quantity is a range, never a sum', () => {
    const one = listingFacts([chip(AMAZON_IT, live({ state: 'mixed', listed: 18, notListed: 2, byState: { active: 18 }, priceMin: 49.9, priceMax: 59.9, quantity: 120 }))])!
    expect(one).toMatchObject({ state: 'mixed', priceMin: 49.9, priceMax: 59.9, qty: { min: 120, max: 120 }, places: 1, externalId: 'B0X' })
    expect(one.counts).toEqual([{ state: 'active', count: 18 }, { state: 'not_listed', count: 2 }])
    const two = listingFacts([chip(AMAZON_IT, live({ quantity: 20 })), chip(AMAZON_DE, live({ quantity: 20, state: 'paused', byState: { paused: 1 }, externalId: 'B0Y' }))])!
    expect(two).toMatchObject({ state: 'mixed', qty: { min: 20, max: 20 }, places: 2, externalId: null })
    expect(listingFacts([chip(AMAZON_IT, live({ quantity: 5 })), chip(AMAZON_DE, live({ quantity: 12 }))])!.qty).toEqual({ min: 5, max: 12 })
    expect(listingFacts([chip(SHARED, null)])).toBeNull()
  })
})

describe('the words', () => {
  it('Status: the design system\'s word and tone; Mixed with its counts in the tooltip', () => {
    const mixed = listingFacts([chip(AMAZON_IT, live({ state: 'mixed', listed: 18, notListed: 2, byState: { active: 18 } }))])!
    expect(statusWords(mixed)).toEqual({ label: 'Mixed', tone: 'warning', title: 'Mixed: 18 Active · 2 Not listed' })
    expect(statusWords(listingFacts([chip(AMAZON_IT, live())])!)).toEqual({ label: 'Active', tone: 'success', title: 'Active' })
    expect(statusWords(listingFacts([chip(AMAZON_IT, live({ state: 'not_listed', listed: 0, notListed: 1, byState: {} }))])!).label).toBe('Not listed')
  })

  it('Price: one price, a range, the listing\'s currency; Pinned when it does not follow the master price', () => {
    expect(priceWords({ priceMin: 49.9, priceMax: 49.9, currency: 'EUR' })).toBe('€49.90')
    expect(priceWords({ priceMin: 49.9, priceMax: 59.9, currency: 'EUR' })).toBe('€49.90–59.90')
    expect(priceWords({ priceMin: 20, priceMax: 20, currency: 'GBP' })).toBe('£20.00')
    expect(priceWords({ priceMin: null, priceMax: null, currency: 'EUR' })).toBeNull()
    expect(pinnedWords({ pricePinned: 0, priced: 3 })).toBeNull()
    expect(pinnedWords({ pricePinned: 3, priced: 3 })!.label).toBe('Pinned')
    expect(pinnedWords({ pricePinned: 2, priced: 20 })).toEqual({ label: '2 pinned', title: '2 of 20 prices are pinned on the listing; the rest follow the master price.' })
  })

  it('Qty: a family\'s total with "18 var.", the Amazon EU note; a range across markets says so', () => {
    const family = listingFacts([chip(AMAZON_IT, live({ listed: 18, notListed: 2, quantity: 120 }))])!
    expect(qtyWords(family, { family: true, channel: 'AMAZON' })).toEqual({ text: '120', aside: '18 var.',
      title: 'The total of 18 listed variations; 2 not listed here. Amazon EU shares one quantity across its markets.' })
    expect(qtyWords(listingFacts([chip(AMAZON_IT, live({ quantity: 4 }))])!, { family: false, channel: 'EBAY' })).toEqual({ text: '4', aside: null, title: 'Quantity 4' })
    const store = listingFacts([chip(AMAZON_IT, live({ quantity: 5 })), chip(AMAZON_DE, live({ quantity: 12 }))])!
    expect(qtyWords(store, { family: false, channel: null })).toEqual({ text: '5–12', aside: null, title: 'Each market or store has its own quantity; they are not added up.' })
    expect(qtyWords(listingFacts([chip(AMAZON_IT, live({ quantity: null }))])!, { family: false, channel: null })).toBeNull()
  })

  it('Channel ID: the id and its link; "per variation" when a family has none of its own; Last push: the worst, "3 of 20 failed"; messages', () => {
    expect(channelIdWords(listingFacts([chip(AMAZON_IT, live())])!)).toEqual({ id: 'B0X', url: 'https://www.amazon.it/dp/B0X' })
    expect(channelIdWords(listingFacts([chip(AMAZON_IT, live({ externalId: null, url: null, listed: 3 }))])!)).toEqual({ perVariation: true })
    expect(channelIdWords(listingFacts([chip(AMAZON_IT, live({ externalId: null, url: null, listed: 0, notListed: 1 }))])!)).toBeNull()
    expect(lastPushMeta({ worst: 'failed', failed: 3, waiting: 0, done: 17, other: 0 })).toMatchObject({ label: '3 of 20 failed', tone: 'warning' })
    expect(lastPushMeta({ worst: 'failed', failed: 2, waiting: 0, done: 0, other: 0 })).toMatchObject({ label: 'All 2 failed', tone: 'danger' })
    expect(lastPushMeta({ worst: 'failed', failed: 1, waiting: 0, done: 0, other: 0 })).toMatchObject({ label: 'Failed' })
    expect(lastPushMeta({ worst: 'waiting', failed: 0, waiting: 2, done: 1, other: 0 })).toMatchObject({ label: 'Waiting' })
    expect(lastPushMeta({ worst: 'done', failed: 0, waiting: 0, done: 4, other: 0 })).toMatchObject({ label: 'Accepted' })
    expect(lastPushMeta({ worst: null, failed: 0, waiting: 0, done: 0, other: 0 })).toBeNull()
    expect(messageWords({ errors: 3, warnings: 1 })).toEqual({ total: 4, title: '3 errors · 1 warning on the channel' })
  })
})

describe('the server\'s order', () => {
  it('a header click → sort and dir; the address → AG\'s sort model; the default is no sorted column', () => {
    expect(sortFromModel([{ colId: AG_AUTO_COL, sort: 'desc' }])).toEqual({ sort: 'name', dir: 'desc' })
    expect(sortFromModel([{ colId: 'qty', sort: 'asc' }])).toEqual({ sort: 'stock', dir: 'asc' })
    expect(sortFromModel([{ colId: 'nextStep', sort: 'desc' }])).toEqual({ sort: 'problems', dir: 'desc' })
    expect(sortFromModel([])).toEqual({ sort: '', dir: 'asc' })
    expect(sortModelOf({ sort: 'checked', dir: 'desc' })).toEqual([{ colId: 'checked', sort: 'desc' }])
    expect(sortModelOf({ sort: '', dir: 'asc' })).toEqual([])
  })

  it('the live sorts only on one destination: a market page, and its store when the market has two', () => {
    const lock = { channel: 'AMAZON' as const, marketplace: 'IT' }
    const two = [destinationFromKey(AMAZON_IT), destinationFromKey(AMAZON_IT_GALE), destinationFromKey(AMAZON_IT_ALIAS)]
    expect(destinationColumnsReady('market', lock, '', [destinationFromKey(AMAZON_IT), destinationFromKey(AMAZON_IT_ALIAS)])).toBe(true)
    expect(destinationColumnsReady('market', lock, '', two)).toBe(false)
    expect(destinationColumnsReady('market', lock, 'a2', two)).toBe(true)
    expect(destinationColumnsReady('store', { channel: 'AMAZON', marketplace: '' }, 'a1', two)).toBe(false)
    expect([...sortableColumns(true)].sort()).toEqual([AG_AUTO_COL, 'checked', 'markets', 'nextStep', 'price', 'qty', 'status', 'synced'].sort())
    expect([...sortableColumns(false)].sort()).toEqual([AG_AUTO_COL, 'checked', 'markets', 'nextStep'].sort())
  })
})

describe('the column filters', () => {
  const columns = new Set(['status', 'price', 'qty', 'channelId'])
  it('write the address\'s keys (Status writes the Filters bar\'s `live`) and read them back', () => {
    const query = parseReadinessQuery('?live=draft,not_listed,active&priceMin=20&priceMax=30.5&qtyMax=3&channelId=B0AB', { channel: 'AMAZON', marketplace: 'IT' })
    const model = filterModelOf(query, columns)
    expect(model).toEqual({
      status: { filterType: 'set', values: ['active', 'not_listed'] },
      price: { filterType: 'number', type: 'inRange', filter: 20, filterTo: 30.5 },
      qty: { filterType: 'number', type: 'inRange', filter: null, filterTo: 3 },
      channelId: { filterType: 'text', type: 'contains', filter: 'B0AB' },
    })
    expect(filtersFromModel(model, columns, { ...query, live: [], priceMin: '', priceMax: '', qtyMin: '', qtyMax: '', channelId: '' }))
      .toEqual({ live: ['active', 'draft', 'not_listed'], priceMin: '20', priceMax: '30.5', qtyMin: '', qtyMax: '3', channelId: 'B0AB' })
    // A column that is not there keeps the address's value; a value the API refuses is dropped.
    expect(filtersFromModel({ qty: { filterType: 'number', type: 'inRange', filter: 2.5, filterTo: null } }, new Set(['qty']), query))
      .toMatchObject({ live: query.live, priceMin: '20', qtyMin: '', qtyMax: '' })
    expect(filterModelOf(query, new Set())).toEqual({})
  })

  it('a request takes AG\'s sort and filters where AG owns them, the address\'s where the column is not there yet', () => {
    const query = parseReadinessQuery('?sort=price&dir=desc&priceMin=20', { channel: 'AMAZON', marketplace: 'IT' })
    // The live columns have not arrived: the address's order and filter.
    expect(requestQuery(query, { columns: new Set([AG_AUTO_COL, 'markets']) })).toMatchObject({ sort: 'price', dir: 'desc', priceMin: '20' })
    // They have: AG's (here the person cleared both).
    expect(requestQuery(query, { sortModel: [], filterModel: {}, columns: new Set([AG_AUTO_COL, 'markets', 'price']) })).toMatchObject({ sort: '', dir: 'asc', priceMin: '' })
    expect(requestQuery(query, { sortModel: [{ colId: AG_AUTO_COL, sort: 'asc' }], columns: new Set([AG_AUTO_COL, 'price']) })).toMatchObject({ sort: 'name', dir: 'asc' })
  })

  it('what to put into AG when the address changes (a saved view, the Filters bar, a column that arrived), and nothing when they agree', () => {
    const owned = new Set([AG_AUTO_COL, 'markets', 'checked', 'status', 'price'])
    const query = parseReadinessQuery('?sort=checked&dir=desc&live=active&priceMax=9', { channel: 'AMAZON', marketplace: 'IT' })
    const apply = gridStateToApply(query, { sortModel: [], filterModel: { other: { filterType: 'text', type: 'contains', filter: 'x' } }, columns: owned })
    expect(apply.sort).toEqual([{ colId: 'checked', sort: 'desc' }])
    expect(apply.filter).toEqual({ other: { filterType: 'text', type: 'contains', filter: 'x' }, status: { filterType: 'set', values: ['active'] },
      price: { filterType: 'number', type: 'inRange', filter: null, filterTo: 9 } })
    expect(gridStateToApply(query, { sortModel: [{ colId: 'checked', sort: 'desc' }], filterModel: apply.filter!, columns: owned })).toEqual({ sort: null, filter: null })
    // A sort whose column is not there: nothing to put into AG (the request reads the address).
    expect(gridStateToApply(parseReadinessQuery('?sort=stock'), { sortModel: [], filterModel: {}, columns: owned })).toEqual({ sort: null, filter: null })
  })

  it('the grid starts with the address\'s order and filters, for the columns it starts with', () => {
    const query = parseReadinessQuery('?sort=name&dir=desc&channelId=B0', { channel: 'AMAZON', marketplace: 'IT' })
    expect(initialGridState({ columnOrder: { orderedColIds: ['markets'] } }, query, initialColumnIds([]))).toEqual({
      columnOrder: { orderedColIds: ['markets'] }, sort: { sortModel: [{ colId: AG_AUTO_COL, sort: 'desc' }] } })
    expect(initialGridState(undefined, query, initialColumnIds(['channelId']))).toEqual({
      sort: { sortModel: [{ colId: AG_AUTO_COL, sort: 'desc' }] }, filter: { filterModel: { channelId: { filterType: 'text', type: 'contains', filter: 'B0' } } } })
    expect(initialGridState(undefined, parseReadinessQuery(''), initialColumnIds([]))).toBeUndefined()
  })
})

describe('the last-used layout per kind of page (2026-10-26)', () => {
  it('/listings keeps its key; store and market pages have their own, so a market page never hides a column on /listings', async () => {
    const { lastUsedSurface } = await import('./listingColumns')
    expect(lastUsedSurface(null)).toBe('listing-readiness')
    expect(lastUsedSurface({ channel: 'AMAZON', marketplace: '' })).toBe('listing-readiness:store')
    expect(lastUsedSurface({ channel: 'AMAZON', marketplace: 'IT' })).toBe('listing-readiness:market')
  })
})
