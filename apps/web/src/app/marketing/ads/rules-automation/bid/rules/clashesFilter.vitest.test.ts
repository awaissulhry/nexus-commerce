import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BidTiles } from './BidTiles'
import type { BidRulesTotals } from './bidRulesModel'
import { fetchBrainDiff, fetchRules } from './ruleApi'

/** 2026-10-12 — the Bid page's "Clashes · 7 d" tile and the Brain's Clashes tab follow the filter bar (made-up numbers). */

const TOTALS: BidRulesTotals = { rules: 3, on: 2, waiting: 0, bidsChanged7d: 4, clashes: 2, archived: 0, otherMarkets: 0 }
const tiles = (clashesReading: boolean) => renderToStaticMarkup(createElement(BidTiles, {
  view: 'rules', totals: TOTALS, clashesReading, bids: null, tile: null, bidsShow: null, onQuery: () => {}, onWaiting: () => {},
}))
/** The value under the Clashes label, as drawn. */
const clashValue = (html: string) => /Clashes[\s\S]*?class="[^"]*tileValue[^"]*">([^<]*)</.exec(html)?.[1]

describe('the Clashes tile', () => {
  it('shows the count read for the filter on screen', () => {
    expect(clashValue(tiles(false))).toBe('2')
  })
  it('shows a dash while the new filter\'s count is read, never the count of the filter before', () => {
    expect(clashValue(tiles(true))).toBe('—')
  })
})

describe('the reads send the filter bar\'s lists', () => {
  const urls: string[] = []
  afterEach(() => { urls.length = 0; vi.unstubAllGlobals() })
  const stub = (body: unknown) => vi.stubGlobal('fetch', vi.fn(async (url: string) => { urls.push(url); return new Response(JSON.stringify(body), { status: 200 }) }))

  it('the rules read: the market and only the lists with a pick', async () => {
    stub({ market: 'IT', rules: [], totals: TOTALS })
    await fetchRules('IT', { portfolioIds: 'p1', campaignIds: 'c1,c2' })
    await fetchRules('all', null)
    const [filtered, plain] = urls.map((u) => new URL(u, 'http://x').searchParams)
    expect(Object.fromEntries(filtered)).toEqual({ market: 'IT', portfolioIds: 'p1', campaignIds: 'c1,c2' })
    expect([...plain.keys()]).toEqual([])
  })

  it('the Brain\'s Clashes tab: seven days, the market and the lists', async () => {
    stub({ mode: 'shadow', owned: [], days: [] })
    await fetchBrainDiff('IT', { adGroupIds: 'g1' })
    expect(Object.fromEntries(new URL(urls[0], 'http://x').searchParams)).toEqual({ days: '7', market: 'IT', adGroupIds: 'g1' })
  })
})
