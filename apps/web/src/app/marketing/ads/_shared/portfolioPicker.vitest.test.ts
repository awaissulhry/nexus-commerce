/**
 * CM-21 — the portfolio pickers offer only the campaign's own market's portfolios that exist on Amazon.
 *
 * The grid's "Portfolio" menu listed every market's portfolios plus ones created in Nexus while writes were closed
 * (`local-pf-…`). Amazon refuses another market's portfolio for a campaign, and a local-only id was never on Amazon.
 */
import { describe, expect, it } from 'vitest'
import { assignablePortfolios, isLocalOnlyPortfolio, sharedMarket, type PortfolioOption } from './portfolioPicker'

const ALL: PortfolioOption[] = [
  { portfolioId: '1001', name: 'Jackets IT', marketplace: 'IT' },
  { portfolioId: '1002', name: 'Gloves IT', marketplace: 'IT' },
  { portfolioId: '2001', name: 'Jackets DE', marketplace: 'DE' },
  { portfolioId: 'local-pf-local-IT-boots', name: 'Boots (Nexus only)', marketplace: 'IT' },
  { portfolioId: '3001', name: 'Unknown market', marketplace: '' },
]

describe('assignablePortfolios', () => {
  it('offers only the market\'s own portfolios that exist on Amazon', () => {
    expect(assignablePortfolios(ALL, 'IT').map((p) => p.portfolioId)).toEqual(['1001', '1002'])
    expect(assignablePortfolios(ALL, 'DE').map((p) => p.portfolioId)).toEqual(['2001'])
    expect(assignablePortfolios(ALL, 'FR')).toEqual([])
  })

  it('never offers a local-only portfolio, even with no market filter', () => {
    expect(assignablePortfolios(ALL, null).map((p) => p.portfolioId)).toEqual(['1001', '1002', '2001', '3001'])
    expect(isLocalOnlyPortfolio('local-pf-local-IT-boots')).toBe(true)
    expect(isLocalOnlyPortfolio('1001')).toBe(false)
  })
})

describe('sharedMarket — the selection must share one market', () => {
  it('one market', () => {
    expect(sharedMarket(['IT', 'IT'])).toEqual({ market: 'IT', mixed: false })
  })
  it('several markets: mixed, no market', () => {
    expect(sharedMarket(['IT', 'DE'])).toEqual({ market: null, mixed: true })
    expect(sharedMarket(['IT', null])).toEqual({ market: null, mixed: true })
  })
  it('unknown or empty: no market, not mixed', () => {
    expect(sharedMarket([null, undefined])).toEqual({ market: null, mixed: false })
    expect(sharedMarket([])).toEqual({ market: null, mixed: false })
  })
})
