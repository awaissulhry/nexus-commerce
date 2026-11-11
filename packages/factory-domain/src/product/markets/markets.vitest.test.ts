import { describe, expect, it } from 'vitest'
import { fitsStyle, marketChanges, marketCodesProblems, marketStanding, normaliseCode, orderedCodes, sellsThere, type MarketChoice } from './rules'

const market = (code: string, extra: Partial<MarketChoice> = {}): MarketChoice => ({ code, name: code, companyId: null, status: 'ACTIVE', switchedOn: true, ...extra })
const MARKETS = new Map([market('IT'), market('DE'), market('FR', { companyId: 'company-b' }), market('ES', { status: 'ARCHIVED' }), market('CH', { switchedOn: false })].map((entry) => [entry.code, entry]))

describe('where a style stands in a market (FU1:01)', () => {
  it('names no market: every market; a list: sold there or not', () => {
    expect(marketStanding([], 'DE')).toBe('EVERY_MARKET')
    expect(marketStanding(['IT', 'DE'], 'DE')).toBe('SOLD_THERE')
    expect(marketStanding(['IT'], 'DE')).toBe('NOT_SOLD_THERE')
    expect(marketStanding(['IT'], null)).toBe('NOT_SOLD_THERE')
  })

  it('the gate reads the language rules only where the style names the market (an empty list keeps today’s answer)', () => {
    expect(sellsThere([], 'DE')).toBe(false)
    expect(sellsThere(['DE'], 'DE')).toBe(true)
    expect(sellsThere(['IT'], 'DE')).toBe(false)
  })
})

describe('the pick', () => {
  it('offers the markets of the style’s company and every company’s; a tenant-wide style every market', () => {
    expect(fitsStyle({ companyId: null }, 'company-a')).toBe(true)
    expect(fitsStyle({ companyId: 'company-b' }, 'company-a')).toBe(false)
    expect(fitsStyle({ companyId: 'company-b' }, null)).toBe(true)
  })

  it('refuses in words what the database refuses, and the pick’s own rules', () => {
    const problems = (codes: string[], before: string[] = [], styleCompanyId: string | null = 'company-a') => marketCodesProblems({ codes, before, markets: MARKETS, styleCompanyId })
    expect(problems(['IT', 'DE'])).toEqual([])
    expect(problems(['IT', 'IT']).map((issue) => issue.path)).toEqual(['marketCodes/1'])
    expect(problems(['it'])[0]?.message).toContain('is not a market code')
    expect(problems(['XX'])[0]?.message).toContain('There is no market XX')
    expect(problems(['FR'])[0]?.message).toContain('another company')
    expect(problems(['FR'], [], null)).toEqual([])
    expect(problems(['ES'])[0]?.message).toContain('archived')
    // A market named before stays, whatever its state now (as the database checks only a code added).
    expect(problems(['ES', 'XX'], ['ES', 'XX'])).toEqual([])
    // A switched-off market may be picked: its own rules wait until it is on.
    expect(problems(['CH'])).toEqual([])
    expect(problems(Array.from({ length: 61 }, (_, index) => `I${String.fromCharCode(65 + (index % 26))}`))[0]?.path).toBe('marketCodes')
  })

  it('normalises a typed code, orders by the markets and says what changes', () => {
    expect(normaliseCode(' de ')).toBe('DE')
    expect(normaliseCode('us-CA')).toBe('US-CA')
    expect(orderedCodes(['XX', 'DE', 'IT'], [...MARKETS.values()])).toEqual(['IT', 'DE', 'XX'])
    expect(marketChanges(['IT', 'DE'], ['DE', 'FR'])).toEqual({ added: ['FR'], removed: ['IT'] })
  })
})
