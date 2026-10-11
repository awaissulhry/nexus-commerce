/**
 * Bid page programme, lane SHELL (2026-10-10) — the Rules & Automation frame's pure rules: the link tabs and the
 * header's market list. (`tabs.tsx` is checked as source by `rulesTabRoutes.vitest.test.ts`; here, the shapes.)
 */
import { describe, expect, it } from 'vitest'
import { activeTabFromPath } from '@/design-system/components/tabsRoute'
import { NO_MARKET, marketKey, rulesMarketOptions, rulesTabCounts, rulesTabItems, type CountedRule } from './rulesFrame'

const BASE = '/marketing/ads/rules-automation'
const TABS = [
  { key: 'rules', label: 'Apply Rules', path: 'apply-rules' },
  { key: 'automations', label: 'Automations' },
  { key: 'bid', label: 'Bid' },
  { key: 'dayparting', label: 'Hourly Bids' },
  { key: 'keyword-tracker', label: 'Keyword Tracker' },
]
const hrefOf = (t: { key: string; path?: string }) => `${BASE}/${t.path ?? t.key}`

describe('rulesTabItems — the link tabs', () => {
  it('keeps the list order, labels and hrefs (a tab routed under another segment keeps its path)', () => {
    const items = rulesTabItems(TABS, null, hrefOf)
    expect(items.map((t) => t.id)).toEqual(['rules', 'automations', 'bid', 'dayparting', 'keyword-tracker'])
    expect(items[0]).toMatchObject({ label: 'Apply Rules', href: `${BASE}/apply-rules` })
    expect(items[3]).toMatchObject({ label: 'Hourly Bids', href: `${BASE}/dayparting` })
  })

  it('no counts read yet (or the read failed) → no pill anywhere, never a 0', () => {
    expect(rulesTabItems(TABS, null, hrefOf).every((t) => t.count === null)).toBe(true)
  })

  it('a pill only where the provider counts something; 0 shows no pill, like a tab it does not count (S12)', () => {
    const items = rulesTabItems(TABS, { bid: 3, 'keyword-tracker': 0 }, hrefOf)
    expect(Object.fromEntries(items.map((t) => [t.id, t.count]))).toEqual({
      rules: null, automations: null, bid: 3, dayparting: null, 'keyword-tracker': null,
    })
  })

  it('a count that is not a number is unknown, not a pill', () => {
    const items = rulesTabItems(TABS, { bid: Number.NaN }, hrefOf)
    expect(items.find((t) => t.id === 'bid')?.count).toBeNull()
  })

  it('the tab you are on comes from the route, a sub-path and a query keep it', () => {
    const items = rulesTabItems(TABS, null, hrefOf)
    expect(activeTabFromPath(items, `${BASE}/bid`)).toBe('bid')
    expect(activeTabFromPath(items, `${BASE}/bid/rule-1?market=IT`)).toBe('bid')
    expect(activeTabFromPath(items, `${BASE}/apply-rules`)).toBe('rules')
    expect(activeTabFromPath(items, `${BASE}/dayparting?from=2026-10-01`)).toBe('dayparting')
    // A page no tab names (the builder) has no tab of its own — the caller's fallback decides.
    expect(activeTabFromPath(items, `${BASE}/builder/bid`)).toBeNull()
  })
})

describe('rulesMarketOptions — the header market list', () => {
  const markets = [{ code: 'IT' }, { code: 'DE', note: 'reading only', whyNot: 'Writes are off for DE' }]

  it('"All markets" first, then each market by name with its code at the end — no flags', () => {
    const o = rulesMarketOptions({ markets, value: 'IT', allowAll: true })
    expect(o.map((x) => x.value)).toEqual(['all', 'IT', 'DE'])
    expect(o[1]).toMatchObject({ label: 'Italy', trailing: 'IT' })
    expect(o.every((x) => !/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(x.label))).toBe(true)
  })

  it('a market Nexus only reads says so under its name, the reason on hover', () => {
    const de = rulesMarketOptions({ markets, value: 'IT', allowAll: true }).find((x) => x.value === 'DE')
    expect(de).toMatchObject({ label: 'Germany', note: 'reading only', title: 'Writes are off for DE' })
    expect(de?.heldReason).toBeUndefined()
  })

  it('a page that cannot serve every market offers no "All markets"', () => {
    expect(rulesMarketOptions({ markets, value: 'IT', allowAll: false }).map((x) => x.value)).toEqual(['IT', 'DE'])
  })

  it('the market in use is listed even when the list lacks it (a deep link), once', () => {
    const o = rulesMarketOptions({ markets, value: 'FR', allowAll: true })
    expect(o.map((x) => x.value)).toEqual(['all', 'IT', 'DE', 'FR'])
    expect(o.at(-1)).toMatchObject({ label: 'France', trailing: 'FR' })
    expect(rulesMarketOptions({ markets: [{ code: 'IT' }, { code: 'IT' }], value: 'IT', allowAll: false })).toHaveLength(1)
  })

  it('a page that cannot filter yet: only "All markets", with the reason under it', () => {
    const o = rulesMarketOptions({ markets, value: 'all', allowAll: true, notYet: 'This list has no market yet' })
    expect(o).toEqual([{ value: 'all', label: 'All markets', note: 'This list has no market yet' }])
  })

  it('no market at all: one held row says so and can never be chosen', () => {
    const o = rulesMarketOptions({ markets: [], value: 'all', allowAll: true })
    expect(o.map((x) => x.value)).toEqual(['all', NO_MARKET])
    expect(o[1]?.heldReason).toBeTruthy()
    expect(rulesMarketOptions({ markets: [], value: '', allowAll: false })).toEqual([
      { value: NO_MARKET, label: 'No connected markets', heldReason: 'No Amazon market is connected yet' },
    ])
  })
})

describe('rulesTabCounts — the counts follow the market in the header (S12)', () => {
  const belongs = (actions: unknown, key: string) => (actions as string[]).includes(key)
  const RULES: CountedRule[] = [
    { actions: ['bid'], market: 'IT' },
    { actions: ['bid'], market: 'it' },
    { actions: ['bid', 'budget'], market: null },
    { actions: ['budget'], market: 'DE' },
    { actions: ['bid'], market: 'GB' },
  ]
  const keys = ['bid', 'budget', 'placement']

  it('all markets (or none picked) counts every rule', () => {
    expect(rulesTabCounts(RULES, keys, belongs, 'all')).toEqual({ bid: 4, budget: 2, placement: 0 })
    expect(rulesTabCounts(RULES, keys, belongs, null)).toEqual({ bid: 4, budget: 2, placement: 0 })
  })

  it('one market counts its own rules and the rules that set no market', () => {
    expect(rulesTabCounts(RULES, keys, belongs, 'IT')).toEqual({ bid: 3, budget: 1, placement: 0 })
    expect(rulesTabCounts(RULES, keys, belongs, 'DE')).toEqual({ bid: 1, budget: 2, placement: 0 })
  })

  it('a market with no rule of its own still counts the every-market rules; UK and GB are one market', () => {
    expect(rulesTabCounts(RULES, keys, belongs, 'FR')).toEqual({ bid: 1, budget: 1, placement: 0 })
    expect(rulesTabCounts(RULES, keys, belongs, 'UK').bid).toBe(2)
  })

  it('reads a market from any shape: a code in any case, an Amazon marketplace id, all, blank', () => {
    expect(marketKey('it')).toBe('IT')
    expect(marketKey('APJ6JRA9NG5V4')).toBe('IT')
    expect(marketKey('GB')).toBe('UK')
    expect(marketKey('all')).toBeNull()
    expect(marketKey('  ')).toBeNull()
    expect(marketKey(null)).toBeNull()
  })
})
