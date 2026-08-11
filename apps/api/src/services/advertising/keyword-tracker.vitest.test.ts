/**
 * KT.1 — the two decisions the Keyword Tracker page rests on.
 *
 * Both fixtures below are the shape of real prod data, measured 2026-08-11 with
 * `apps/api/scripts/_kt1-probe.mts` and `_kt1-period.mts`:
 *   · 220 campaigns, of which only 72 carry a portfolioId — the portfolio grain's hole;
 *   · IT's newest SQP period (2026-07-26) holds 8 rows, the one before it (2026-07-19) holds 655.
 *
 * The second is why `pickTermPeriod` exists at all: reading one period for the whole grid renders
 * 105 of 107 watchlist terms as "not measured" while the answer sits one week back.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../../db.js', () => ({ default: {} }))

const { resolveScope, pickTermPeriod } = await import('./keyword-tracker.service.js')

const D = (s: string) => new Date(`${s}T00:00:00.000Z`)

const graph = {
  campaigns: [
    { id: 'c-it-gale-1', name: 'IT GALE 1', marketplace: 'IT', portfolioId: 'pf-gale' },
    { id: 'c-it-gale-2', name: 'IT GALE 2', marketplace: 'IT', portfolioId: 'pf-gale' },
    { id: 'c-it-loose', name: 'IT no portfolio', marketplace: 'IT', portfolioId: null },
    { id: 'c-it-loose-2', name: 'IT no portfolio 2', marketplace: 'IT', portfolioId: null },
    { id: 'c-de-gale', name: 'DE GALE', marketplace: 'DE', portfolioId: 'pf-gale-de' },
  ],
  ads: [
    { productId: 'p-gale-s', asin: 'ASIN-GALE-S', campaignId: 'c-it-gale-1' },
    { productId: 'p-gale-m', asin: 'ASIN-GALE-M', campaignId: 'c-it-gale-2' },
    { productId: 'p-moss-s', asin: 'ASIN-MOSS-S', campaignId: 'c-it-loose' },
    // the same child advertised in two campaigns — one ASIN, not two
    { productId: 'p-gale-s', asin: 'ASIN-GALE-S', campaignId: 'c-it-loose-2' },
    { productId: 'p-gale-s', asin: 'ASIN-GALE-S-DE', campaignId: 'c-de-gale' },
  ],
  products: [
    { id: 'p-gale-s', parentId: 'line-gale' },
    { id: 'p-gale-m', parentId: 'line-gale' },
    { id: 'p-moss-s', parentId: 'line-moss' },
  ],
}

describe('resolveScope', () => {
  it('market scope takes every campaign in the market and does not restrict ASINs', () => {
    const s = resolveScope(graph, { market: 'IT' })
    expect(s.boundBy).toBe('market')
    expect(s.campaignIds).toHaveLength(4)
    expect(s.asinScoped).toBe(false)
  })

  it('never crosses a market boundary — DE campaigns and DE ASINs stay out of an IT scope', () => {
    const s = resolveScope(graph, { market: 'IT' })
    expect(s.campaignIds).not.toContain('c-de-gale')
    expect(s.asins).not.toContain('ASIN-GALE-S-DE')
  })

  it('a line resolves through Product.parentId to its children ASINs, deduplicated', () => {
    const s = resolveScope(graph, { market: 'IT', line: 'line-gale' })
    expect(s.boundBy).toBe('line')
    expect(s.asins).toEqual(['ASIN-GALE-M', 'ASIN-GALE-S'])
    // one ASIN advertised in two campaigns pulls BOTH campaigns into the scope
    expect(s.campaignIds.sort()).toEqual(['c-it-gale-1', 'c-it-gale-2', 'c-it-loose-2'])
    expect(s.asinScoped).toBe(true)
  })

  it('a portfolio resolves through the EXTERNAL portfolio id on Campaign', () => {
    const s = resolveScope(graph, { market: 'IT', portfolio: 'pf-gale' })
    expect(s.boundBy).toBe('portfolio')
    expect(s.campaignIds).toEqual(['c-it-gale-1', 'c-it-gale-2'])
    expect(s.asins).toEqual(['ASIN-GALE-M', 'ASIN-GALE-S'])
  })

  it('states what the portfolio grain cannot reach — the campaigns carrying no portfolio', () => {
    const s = resolveScope(graph, { market: 'IT', portfolio: 'pf-gale' })
    expect(s.campaignsInMarket).toBe(4)
    expect(s.campaignsWithoutPortfolio).toBe(2)
  })

  it('most specific wins: a campaign overrides a portfolio and a line supplied with it', () => {
    const s = resolveScope(graph, { market: 'IT', line: 'line-moss', portfolio: 'pf-gale', campaign: 'c-it-gale-1' })
    expect(s.boundBy).toBe('campaign')
    expect(s.campaignIds).toEqual(['c-it-gale-1'])
    expect(s.asins).toEqual(['ASIN-GALE-S'])
  })

  it('a campaign from another market resolves to nothing rather than silently ignoring the market', () => {
    const s = resolveScope(graph, { market: 'IT', campaign: 'c-de-gale' })
    expect(s.campaignIds).toEqual([])
    expect(s.asins).toEqual([])
    expect(s.asinScoped).toBe(true)
  })
})

describe('pickTermPeriod', () => {
  const row = (startDate: Date, impressionShare = 0) => ({
    searchQuery: 'giacca moto uomo', asin: 'A1', startDate,
    searchQueryVolume: 1707, searchQueryRank: 2, impressionShare,
  })

  it('picks the newest period present, not the newest period the market has', () => {
    // the real 2026-08-11 IT shape: the market's newest period holds no row for this term
    expect(pickTermPeriod([row(D('2026-07-19')), row(D('2026-07-12'))])).toEqual(D('2026-07-19'))
  })

  it('prefers the newest when the term IS in the market-latest period', () => {
    expect(pickTermPeriod([row(D('2026-07-19')), row(D('2026-07-26'))])).toEqual(D('2026-07-26'))
  })

  it('a term with no row at all returns null — the "not measured" fact, distinct from a zero share', () => {
    expect(pickTermPeriod([])).toBeNull()
  })

  it('a row measured at zero share still yields a period — zero is a measurement', () => {
    expect(pickTermPeriod([row(D('2026-07-19'), 0)])).toEqual(D('2026-07-19'))
  })
})
