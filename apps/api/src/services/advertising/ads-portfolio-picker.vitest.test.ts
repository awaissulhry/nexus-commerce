/**
 * CM-21 — a portfolio stored in Nexus is listed under its own profile's market, and a market filter applies to it.
 *
 * `GET /advertising/portfolios` added every stored portfolio the live list did not return, labelled with the asked
 * market (or 'IT'), and with no market filter. So an Italian campaign's picker offered a German portfolio.
 */
import { describe, expect, it } from 'vitest'
import { storedPortfolioMarket, storedPortfoliosForPicker } from './ads-portfolio-picker.js'

const markets = new Map([['P-IT-TEST', 'IT'], ['P-DE-TEST', 'DE']])
const STORED = [
  { externalPortfolioId: '1001', name: 'Jackets IT', profileId: 'P-IT-TEST' },
  { externalPortfolioId: '2001', name: 'Jackets DE', profileId: 'P-DE-TEST' },
  { externalPortfolioId: 'local-pf-local-FR-boots', name: 'Boots FR', profileId: 'local-FR' },
  { externalPortfolioId: '9001', name: 'Old profile', profileId: 'P-GONE-TEST' },
]

describe('storedPortfolioMarket', () => {
  it('the profile\'s connection, else the market a local-<MK> profile names, else unknown', () => {
    expect(storedPortfolioMarket('P-DE-TEST', markets)).toBe('DE')
    expect(storedPortfolioMarket('local-FR', markets)).toBe('FR')
    expect(storedPortfolioMarket('local-', markets)).toBeNull()
    expect(storedPortfolioMarket('P-GONE-TEST', markets)).toBeNull()
  })
})

describe('storedPortfoliosForPicker', () => {
  it('with a market asked: only that market\'s stored portfolios, never another market\'s', () => {
    const seen = new Set<string>()
    expect(storedPortfoliosForPicker(STORED, { seen, marketplace: 'IT', marketOfProfile: markets })).toEqual([
      { portfolioId: '1001', name: 'Jackets IT', marketplace: 'IT' },
    ])
    expect([...seen]).toEqual(['1001'])
  })

  it('with no market asked: each under its own market (unknown stays empty, never "IT")', () => {
    const rows = storedPortfoliosForPicker(STORED, { seen: new Set(), marketplace: null, marketOfProfile: markets })
    expect(rows.map((r) => [r.portfolioId, r.marketplace])).toEqual([
      ['1001', 'IT'], ['2001', 'DE'], ['local-pf-local-FR-boots', 'FR'], ['9001', ''],
    ])
  })

  it('a portfolio the live list already returned is not added twice', () => {
    const seen = new Set(['2001'])
    const rows = storedPortfoliosForPicker(STORED, { seen, marketplace: 'DE', marketOfProfile: markets })
    expect(rows).toEqual([])
  })

  it('the sandbox fallback names the market of a row whose profile is unknown', () => {
    const rows = storedPortfoliosForPicker([STORED[3]!], { seen: new Set(), marketplace: 'IT', marketOfProfile: new Map(), fallbackMarket: 'IT' })
    expect(rows).toEqual([{ portfolioId: '9001', name: 'Old profile', marketplace: 'IT' }])
  })
})
