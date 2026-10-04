import { describe, expect, it } from 'vitest'
import type { HistoryRun } from '@nexus/shared/publication-history'
import {
  EMPTY_FILTERS, RUN_TILES, WHAT_CHIPS, activeFilterCount, activeFilterTokens, appendPage, applyTile, attentionOnly, countsPath, eventConcerns,
  filterOptionsFrom, historyPath, isFiltered, listView, mergeFresh, newlyFinished, readErrorText, startedWindow, tileActive, tileCount, toggleWhat,
  type RunFilters,
} from './usePublishRuns'

const NOW = Date.parse('2026-10-02T12:00:00Z')

const run = (id: string, over: Partial<HistoryRun> = {}): HistoryRun => ({
  id, source: 'studio', batchId: null, startedAt: '2026-10-02T10:00:00Z', finishedAt: null, state: 'succeeded', status: 'VERIFIED',
  kind: 'update', productId: 'fam-1', familySku: 'GALE', familyTitle: 'Gale jacket', channel: 'EBAY', marketplace: 'IT', accountId: 'acc-1',
  accountLabel: 'Shop', aliasKey: '', aliasLabel: null, fieldCount: 3, productCount: 2,
  counts: { accepted: 0, verified: 2, failed: 0, waiting: 0, notSent: 0, skipped: 0, unknown: 0 },
  userId: null, userName: null, reference: null, message: null, lastCheckedAt: null, needsCheck: false, checkedAt: null, checkedBy: null,
  ...over,
})

const params = (path: string) => new URL(path, 'http://x').searchParams

describe('historyPath — filters become the API query', () => {
  it('a business list with no filters asks for the first 50', () => {
    expect(historyPath({ scope: 'business' }, EMPTY_FILTERS, { now: NOW })).toBe('/api/publications?limit=50')
  })

  it('a product list reads its family route', () => {
    expect(historyPath({ scope: 'product', productId: 'p 1' }, EMPTY_FILTERS, { now: NOW })).toMatch(/^\/api\/products\/p%201\/publications\?/)
  })

  it('every filter maps to its parameter; states and sources are comma lists', () => {
    const f: RunFilters = {
      ...EMPTY_FILTERS, states: ['failed', 'partial'], sources: ['studio', 'photos'], channel: 'AMAZON', marketplace: 'IT', accountId: 'a1',
      by: 'me', q: '  GALE  ', started: '7d',
    }
    const p = params(historyPath({ scope: 'business' }, f, { now: NOW, cursor: 'c1', limit: 100 }))
    expect(p.get('state')).toBe('failed,partial')
    expect(p.get('source')).toBe('studio,photos')
    expect(p.get('channel')).toBe('AMAZON')
    expect(p.get('marketplace')).toBe('IT')
    expect(p.get('accountId')).toBe('a1')
    expect(p.get('by')).toBe('me')
    expect(p.get('q')).toBe('GALE')
    expect(p.get('from')).toBe(new Date(NOW - 7 * 86_400_000).toISOString())
    expect(p.get('to')).toBeNull()
    expect(p.get('cursor')).toBe('c1')
    expect(p.get('limit')).toBe('100')
  })

  it('"Anyone" and an empty search add nothing', () => {
    const p = params(historyPath({ scope: 'business' }, { ...EMPTY_FILTERS, by: 'anyone', q: '   ' }, { now: NOW }))
    expect(p.has('by')).toBe(false)
    expect(p.has('q')).toBe(false)
  })

  it('a custom range covers whole days, start to end', () => {
    const start = new Date(2026, 8, 1, 15, 0), end = new Date(2026, 8, 3, 9, 0)
    const w = startedWindow({ started: 'custom', range: { start, end } }, NOW)
    expect(new Date(w.from!).getHours()).toBe(0)
    expect(new Date(w.from!).getDate()).toBe(1)
    expect(new Date(w.to!).getHours()).toBe(23)
    expect(new Date(w.to!).getDate()).toBe(3)
  })

  it('"Any time" sends no window', () => {
    expect(startedWindow({ started: 'any', range: null }, NOW)).toEqual({})
  })
})

describe('paging and live refresh', () => {
  it('a further page joins the end; a run already shown keeps its place', () => {
    expect(appendPage([run('a'), run('b')], [run('b'), run('c')]).map(r => r.id)).toEqual(['a', 'b', 'c'])
  })

  it('a fresh first page replaces shown runs in place and puts new ones on top; loaded rows below stay', () => {
    const current = [run('b', { state: 'in_progress' }), run('c'), run('d')]
    const fresh = [run('a'), run('b', { state: 'failed' })]
    const merged = mergeFresh(current, fresh)
    expect(merged.map(r => r.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(merged[1].state).toBe('failed')
  })

  it('a run that was in progress and is not any more is reported once as finished', () => {
    const before = [run('a', { state: 'in_progress' }), run('b', { state: 'in_progress' }), run('c')]
    const after = [run('a', { state: 'partial' }), run('b', { state: 'in_progress' }), run('c', { state: 'failed' })]
    expect(newlyFinished(before, after).map(r => r.id)).toEqual(['a'])
  })

  it('a product list reacts only to its own family; a business list to every publish', () => {
    const rows = [run('a', { productId: 'fam-1' })]
    expect(eventConcerns({ scope: 'business' }, { meta: { productId: 'other' } }, rows)).toBe(true)
    expect(eventConcerns({ scope: 'product', productId: 'fam-1' }, { meta: { productId: 'fam-1' } }, [])).toBe(true)
    expect(eventConcerns({ scope: 'product', productId: 'child-1' }, { meta: { productId: 'fam-1' } }, rows)).toBe(true)
    expect(eventConcerns({ scope: 'product', productId: 'fam-1' }, { meta: { productId: 'fam-9' } }, rows)).toBe(false)
  })
})

describe('listView — a failed read is never an empty list', () => {
  it('an error with nothing shown is the error state, whatever else is true', () => {
    expect(listView({ loaded: true, error: 'down', rows: 0, filtered: false })).toBe('error')
    expect(listView({ loaded: false, error: 'down', rows: 0, filtered: true })).toBe('error')
  })
  it('loading until the first answer', () => {
    expect(listView({ loaded: false, error: null, rows: 0, filtered: false })).toBe('loading')
  })
  it('no rows: "no publishes yet" without filters, "no match" with them', () => {
    expect(listView({ loaded: true, error: null, rows: 0, filtered: false })).toBe('empty')
    expect(listView({ loaded: true, error: null, rows: 0, filtered: true })).toBe('no-match')
  })
  it('rows already shown stay shown when a later page fails', () => {
    expect(listView({ loaded: true, error: 'down', rows: 50, filtered: false })).toBe('rows')
  })
})

describe('filter tiles', () => {
  const attention = RUN_TILES.find(t => t.key === 'attention')!
  const done = RUN_TILES.find(t => t.key === 'done')!

  it('pressing a tile applies its states and window; pressing it again clears them, other filters stay', () => {
    const on = applyTile(attention, { ...EMPTY_FILTERS, channel: 'EBAY' })
    expect(on.states).toEqual(['failed', 'partial', 'needs_check'])
    expect(on.channel).toBe('EBAY')
    expect(tileActive(attention, on)).toBe(true)
    expect(tileActive(done, on)).toBe(false)
    const off = applyTile(attention, on)
    expect(off.states).toEqual([])
    expect(off.channel).toBe('EBAY')
  })

  it('"Done in the last 7 days" lists from the server\'s own window start, so its list equals its count', () => {
    const since = '2026-09-25T12:00:03.000Z'
    const on = applyTile(done, EMPTY_FILTERS, since)
    expect(params(historyPath({ scope: 'business' }, on, { now: NOW })).get('from')).toBe(since)
    // Without the server's start (counts not read yet) the browser's own 7 days stand in.
    expect(params(historyPath({ scope: 'business' }, applyTile(done, EMPTY_FILTERS), { now: NOW })).get('from')).toBe(new Date(NOW - 7 * 86_400_000).toISOString())
    expect(applyTile(done, on, since).since).toBeUndefined()
  })

  it('"Done in the last 7 days" needs its window too', () => {
    const on = applyTile(done, EMPTY_FILTERS)
    expect(on.started).toBe('7d')
    expect(tileActive(done, { ...on, started: 'any' })).toBe(false)
  })

  it('each tile shows the server\'s exact count — never "100+"', () => {
    const totals = { needsAttention: 1163, inProgress: 0, doneLast7Days: 3 }
    expect(tileCount(totals, 'attention')).toBe('1,163')
    expect(tileCount(totals, 'progress')).toBe('0')
    expect(tileCount(totals, 'done')).toBe('3')
  })

  it('the counts keep the OTHER filters (a tile press keeps them) and drop the result, window, paging', () => {
    const f: RunFilters = { ...EMPTY_FILTERS, states: ['failed'], started: '30d', channel: 'EBAY', marketplace: 'IT', by: 'me', q: ' GALE ' }
    const path = countsPath({ scope: 'business' }, f, NOW)
    expect(path.startsWith('/api/publications/counts?')).toBe(true)
    const p = params(path)
    expect(p.get('channel')).toBe('EBAY')
    expect(p.get('marketplace')).toBe('IT')
    expect(p.get('by')).toBe('me')
    expect(p.get('q')).toBe('GALE')
    for (const gone of ['state', 'from', 'to', 'limit', 'cursor', 'checked']) expect(p.has(gone)).toBe(false)
    expect(countsPath({ scope: 'product', productId: 'fam 1' }, EMPTY_FILTERS, NOW)).toBe('/api/products/fam%201/publications/counts')
  })

  it('the attention tile asks the server to leave out runs a person marked as checked', () => {
    const attention = RUN_TILES.find(t => t.key === 'attention')!
    const on = applyTile(attention, EMPTY_FILTERS)
    expect(attentionOnly(on)).toBe(true)
    expect(params(historyPath({ scope: 'business' }, on, { now: NOW })).get('checked')).toBe('false')
    // Only "Result unknown" chosen by hand: checked runs stay (that is how a person finds them).
    const unknownOnly = { ...EMPTY_FILTERS, states: ['needs_check' as const] }
    expect(attentionOnly(unknownOnly)).toBe(false)
    expect(params(historyPath({ scope: 'business' }, unknownOnly, { now: NOW })).has('checked')).toBe(false)
  })

  it('counts the filters that differ from empty', () => {
    expect(activeFilterCount(EMPTY_FILTERS)).toBe(0)
    expect(activeFilterCount({ ...EMPTY_FILTERS, states: ['failed'], by: 'me', q: 'x' })).toBe(3)
  })
})

describe('filters that are on, as removable tokens', () => {
  const words = {
    state: (s: string) => ({ failed: 'Failed', partial: 'Partly failed' } as Record<string, string>)[s] ?? s,
    channel: (v: string) => (v === 'EBAY' ? 'eBay' : v),
    market: (v: string) => (v === 'IT' ? 'IT · Italy' : v),
    account: (v: string) => (v === 'a1' ? 'eBay · Xavia' : v),
    source: (v: string) => (v === 'studio' ? 'Product sheet' : v),
    started: (p: string) => (p === '7d' ? 'Last 7 days' : p),
  }

  it('no filter on: no tokens', () => {
    expect(activeFilterTokens(EMPTY_FILTERS, words)).toEqual([])
  })

  it('every filter that is on has one token, in the panel\'s order, in words', () => {
    const f: RunFilters = { ...EMPTY_FILTERS, states: ['failed', 'partial'], channel: 'EBAY', marketplace: 'IT', accountId: 'a1',
      sources: ['studio'], started: '7d', by: 'me', q: ' gale ' }
    expect(activeFilterTokens(f, words).map(t => t.label)).toEqual([
      'Result: Failed, Partly failed', 'Channel: eBay', 'Market: IT · Italy', 'Account: eBay · Xavia', 'Source: Product sheet',
      'Started: Last 7 days', 'By: Me', 'Search: “gale”',
    ])
  })

  it('removing a token resets only that filter; the channel takes its market and account with it', () => {
    const f: RunFilters = { ...EMPTY_FILTERS, channel: 'EBAY', marketplace: 'IT', accountId: 'a1', started: 'custom', range: { start: new Date(NOW), end: new Date(NOW) } }
    const tokens = activeFilterTokens(f, words)
    expect(tokens.find(t => t.key === 'channel')!.clear).toEqual({ channel: '', marketplace: '', accountId: '' })
    expect(tokens.find(t => t.key === 'started')!.clear).toEqual({ started: 'any', range: null, since: undefined })
  })
})

describe('filter choices', () => {
  const accounts = [
    { id: 'a1', channel: 'AMAZON', label: 'Xavia EU' },
    { id: 'ads', channel: 'AMAZON_ADS', label: 'Ads' },
    { id: 'e1', channel: 'EBAY', label: 'xavia-racing' },
  ]
  const markets = [
    { channel: 'AMAZON', code: 'IT', name: 'Italy' }, { channel: 'EBAY', code: 'IT', name: 'Italy' },
    { channel: 'EBAY', code: 'DE', name: 'Germany' }, { channel: 'SHOPIFY', code: 'GLOBAL', name: 'Global' },
  ]

  it('the advertising connection is not a publishing channel', () => {
    const o = filterOptionsFrom(accounts, markets, '')
    expect(o.channels.map(c => c.value)).toEqual(['AMAZON', 'EBAY'])
    expect(o.accounts.map(a => a.value)).toEqual(['a1', 'e1'])
  })

  it('markets follow the chosen channel and are listed once per code', () => {
    expect(filterOptionsFrom(accounts, markets, 'EBAY').markets.map(m => m.value)).toEqual(['DE', 'IT'])
    expect(filterOptionsFrom(accounts, markets, '').markets.map(m => m.value)).toEqual(['DE', 'GLOBAL', 'IT'])
  })
})

it('a dropped connection is said in plain words, not as the browser\'s error', () => {
  expect(readErrorText(new TypeError('Failed to fetch'), 'x')).toMatch(/could not be reached/)
  expect(readErrorText(new Error('The publish history could not be read. Try again.'), 'x')).toBe('The publish history could not be read. Try again.')
  expect(readErrorText(null, 'fallback')).toBe('fallback')
})

describe('the What chips (build shape v2) — Updates · Selling changes · Deletes · Photos → what=', () => {
  it('four chips in a fixed order; pressing adds, pressing again removes, order stays the chips\' own', () => {
    expect(WHAT_CHIPS).toEqual(['updates', 'selling', 'deletes', 'photos'])
    expect(toggleWhat([], 'deletes')).toEqual(['deletes'])
    expect(toggleWhat(['deletes'], 'updates')).toEqual(['updates', 'deletes'])
    expect(toggleWhat(['updates', 'deletes'], 'updates')).toEqual(['deletes'])
  })
  it('the list and the tile counts both ask with what=; none pressed asks for every kind', () => {
    const f: RunFilters = { ...EMPTY_FILTERS, what: ['selling', 'deletes'] }
    expect(params(historyPath({ scope: 'business' }, f, { now: NOW })).get('what')).toBe('selling,deletes')
    expect(params(countsPath({ scope: 'product', productId: 'p1' }, f, NOW)).get('what')).toBe('selling,deletes')
    expect(params(historyPath({ scope: 'business' }, EMPTY_FILTERS, { now: NOW })).has('what')).toBe(false)
  })
  it('a pressed chip makes the list "filtered" but is not counted in the panel or shown as a token (the chip is in view)', () => {
    const f: RunFilters = { ...EMPTY_FILTERS, what: ['photos'] }
    expect(isFiltered(f)).toBe(true)
    expect(isFiltered(EMPTY_FILTERS)).toBe(false)
    expect(activeFilterCount(f)).toBe(0)
    const words = { state: String, channel: String, market: String, account: String, source: String, started: String }
    expect(activeFilterTokens(f, words)).toEqual([])
    // A tile press keeps the What chips (other filters stay).
    expect(applyTile(RUN_TILES[0], f).what).toEqual(['photos'])
  })
})
