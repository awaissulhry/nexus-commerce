import { describe, expect, it } from 'vitest'
import {
  ALL_SCOPE,
  amazonTopicsInScope,
  insightsSearch,
  parseInsightsPeriod,
  parseInsightsScope,
  scopeApiParams,
  scopeFromKey,
  scopeKey,
  scopeLabel,
  scopeOptions,
  scopeWords,
} from './insightsScope'

describe('the Insights scope in the address', () => {
  it('reads channel, market and period; anything unknown is "all" or 30 days', () => {
    expect(parseInsightsScope('?channel=amazon&market=de&period=90d')).toEqual({ channel: 'AMAZON', market: 'DE', period: '90d' })
    expect(parseInsightsScope('')).toEqual(ALL_SCOPE)
    expect(parseInsightsScope('?channel=walmart&market=all&period=all')).toEqual(ALL_SCOPE)
    expect(parseInsightsScope('?channel=EBAY&marketplace=GB')).toEqual({ channel: 'EBAY', market: 'UK', period: '30d' })
    expect(parseInsightsScope(new URLSearchParams('market=d3'))).toEqual(ALL_SCOPE)
    expect(parseInsightsPeriod('12M')).toBe('12m')
  })

  it('writes the scope first, leaves the defaults out, then the page’s own values', () => {
    expect(insightsSearch(ALL_SCOPE)).toBe('')
    expect(insightsSearch({ channel: 'AMAZON', market: 'DE', period: '30d' })).toBe('?channel=AMAZON&market=DE')
    expect(insightsSearch({ channel: null, market: null, period: '7d' }, { sort: 'impact', product: null, open: true })).toBe('?period=7d&sort=impact&open=1')
    expect(insightsSearch(ALL_SCOPE, { kind: ['BULLETS', 'APLUS'], none: [] })).toBe('?kind=BULLETS%2CAPLUS')
    // A round trip keeps it.
    const scope = { channel: 'EBAY', market: 'IT', period: '12m' } as const
    expect(parseInsightsScope(insightsSearch(scope, { status: 'OPEN' }))).toEqual(scope)
  })

  it('always names the period to the API', () => {
    expect(scopeApiParams(ALL_SCOPE)).toEqual({ channel: null, market: null, period: '30d' })
  })
})

describe('the channel-and-market picker', () => {
  it('keys a scope and reads it back', () => {
    expect(scopeKey({ channel: 'AMAZON', market: 'DE' })).toBe('AMAZON|DE')
    expect(scopeKey({ channel: null, market: null })).toBe('|')
    expect(scopeFromKey('EBAY|')).toEqual({ channel: 'EBAY', market: null })
    expect(scopeFromKey('nonsense')).toEqual({ channel: null, market: null })
  })

  it('says a scope in the API’s words', () => {
    expect(scopeLabel({ channel: null, market: null })).toBe('All channels and markets')
    expect(scopeLabel({ channel: 'AMAZON', market: null })).toBe('Amazon — all markets')
    expect(scopeLabel({ channel: 'AMAZON', market: 'DE' })).toBe('Amazon Germany')
    expect(scopeLabel({ channel: 'SHOPIFY', market: null })).toBe('Shopify')
    expect(scopeLabel({ channel: null, market: 'IT' })).toBe('Every channel in Italy')
    expect(scopeWords({ channel: 'EBAY', market: 'IT', period: '90d' })).toBe('eBay Italy · last 90 days')
  })

  it('lists everything first, then each channel with its markets, and always the scope on screen', () => {
    const options = scopeOptions(
      [
        { channel: 'EBAY', marketplace: 'IT' },
        { channel: 'AMAZON', marketplace: null },
        { channel: null, marketplace: null, note: 'Brief from 26 Oct' },
        { channel: 'AMAZON', marketplace: 'DE', note: 'No brief yet' },
        { channel: 'WALMART', marketplace: null },
      ],
      { channel: 'SHOPIFY', market: null },
    )
    expect(options.map((o) => o.label)).toEqual(['All channels and markets', 'Amazon — all markets', 'Amazon Germany', 'eBay Italy', 'Shopify'])
    expect(options.every((o) => o.note === undefined)).toBe(true)
    const withNotes = scopeOptions([{ channel: null, marketplace: null, note: 'Brief from 26 Oct' }, { channel: 'AMAZON', marketplace: 'DE', note: 'No brief yet' }], { channel: null, market: null }, { notes: true })
    expect(withNotes).toEqual([
      { value: '|', label: 'All channels and markets', note: 'Brief from 26 Oct' },
      { value: 'AMAZON|DE', label: 'Amazon Germany', note: 'No brief yet' },
    ])
  })

  it('knows where Amazon’s weekly topics can show (never Amazon.nl, never another channel)', () => {
    expect(amazonTopicsInScope({ channel: null, market: null })).toBe(true)
    expect(amazonTopicsInScope({ channel: 'AMAZON', market: 'ES' })).toBe(true)
    expect(amazonTopicsInScope({ channel: 'AMAZON', market: 'NL' })).toBe(false)
    expect(amazonTopicsInScope({ channel: 'EBAY', market: null })).toBe(false)
  })
})
