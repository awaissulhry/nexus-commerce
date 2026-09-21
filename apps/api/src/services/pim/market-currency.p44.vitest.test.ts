/**
 * P4.4a — the currency a market prices in, from the `Marketplace` row.
 *
 * The facts this owns, which were spread across seven implementations before:
 *   - a market's currency is DATA, not a function of its code;
 *   - UK and GB are the same market, and a channel-prefixed id names one too;
 *   - an unconfigured market is REFUSED, never defaulted to EUR (or, in one of
 *     the seven, to USD).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({ findFirst: vi.fn(), findMany: vi.fn() }))
vi.mock('../../db.js', () => ({ default: { marketplace: { findFirst: m.findFirst, findMany: m.findMany } } }))

const {
  marketCurrency, marketCurrencyAcrossChannels, marketCurrencyRows, allMarketCurrencyRows,
} = await import('./market-currency.js')

/** The development database's real rows, and the four the old code got wrong. */
const ROWS = [
  { channel: 'AMAZON', code: 'IT', currency: 'EUR' },
  { channel: 'AMAZON', code: 'DE', currency: 'EUR' },
  { channel: 'AMAZON', code: 'UK', currency: 'GBP' },
  { channel: 'AMAZON', code: 'PL', currency: 'PLN' },
  { channel: 'AMAZON', code: 'SE', currency: 'SEK' },
  { channel: 'AMAZON', code: 'TR', currency: 'TRY' },
  { channel: 'AMAZON', code: 'US', currency: 'USD' },
  { channel: 'EBAY', code: 'IT', currency: 'EUR' },
  { channel: 'EBAY', code: 'UK', currency: 'GBP' },
]

describe('P4.4a marketCurrency (loaded rows)', () => {
  it.each([
    ['AMAZON', 'IT', 'EUR'],
    ['AMAZON', 'UK', 'GBP'],
    ['AMAZON', 'GB', 'GBP'],     // GB and UK are one market; the table stores UK
    ['EBAY', 'EBAY_IT', 'EUR'],  // a channel-prefixed marketplace id
    ['EBAY', 'EBAY_GB', 'GBP'],  // the exact shape `ebayCurrencyForMarket` used to hard-code
    ['ebay', 'uk', 'GBP'],       // case does not matter
  ])('%s/%s → %s', (channel, code, expected) => {
    expect(marketCurrency(channel, code, ROWS)).toBe(expected)
  })

  it.each([
    ['PL', 'PLN'],
    ['SE', 'SEK'],
    ['TR', 'TRY'],
    ['US', 'USD'],
  ])('🔴 %s is %s — every one of the seven old copies said EUR', (code, expected) => {
    expect(marketCurrency('AMAZON', code, ROWS)).toBe(expected)
    expect(marketCurrency('AMAZON', code, ROWS)).not.toBe('EUR')
  })

  it.each([
    ['a market with no row', 'AMAZON', 'NO'],
    ['the right market on the wrong channel', 'SHOPIFY', 'PL'],
  ])('%s is REFUSED, not defaulted', (_name, channel, code) => {
    expect(() => marketCurrency(channel, code, ROWS)).toThrow(/No currency is configured/)
    try { marketCurrency(channel, code, ROWS) } catch (e: any) {
      expect(e.statusCode).toBe(400)
      expect(e.code).toBe('market_currency_unconfigured')
    }
  })

  it.each([
    ['blank', ''],
    ['whitespace', '   '],
    ['not a currency code', 'EURO'],
    ['null', null],
  ])('a %s currency on the row is refused, not used', (_name, currency) => {
    expect(() => marketCurrency('AMAZON', 'IT', [{ channel: 'AMAZON', code: 'IT', currency }] as never))
      .toThrow(/No currency is configured/)
  })
})

describe('P4.4a marketCurrency (from the database)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('reads the row for the coordinate and returns its currency', async () => {
    m.findFirst.mockResolvedValue({ currency: 'PLN' })
    expect(await marketCurrency('AMAZON', 'PL')).toBe('PLN')
    expect(m.findFirst).toHaveBeenCalledExactlyOnceWith({ where: { channel: 'AMAZON', code: 'PL' }, select: { currency: true } })
  })

  it('normalises the coordinate before asking — GB is looked up as UK', async () => {
    m.findFirst.mockResolvedValue({ currency: 'GBP' })
    await marketCurrency('EBAY', 'EBAY_GB')
    expect(m.findFirst.mock.calls[0][0].where).toEqual({ channel: 'EBAY', code: 'UK' })
  })

  it('no row is a refusal, not EUR', async () => {
    m.findFirst.mockResolvedValue(null)
    await expect(marketCurrency('AMAZON', 'PL')).rejects.toThrow(/No currency is configured for AMAZON\/PL/)
  })

  it('marketCurrencyRows / allMarketCurrencyRows select only what they need', async () => {
    m.findMany.mockResolvedValue(ROWS)
    await marketCurrencyRows('amazon')
    expect(m.findMany).toHaveBeenCalledWith({ where: { channel: 'AMAZON' }, select: { channel: true, code: true, currency: true } })
    await allMarketCurrencyRows()
    expect(m.findMany.mock.calls[1][0]).toEqual({ select: { channel: true, code: true, currency: true } })
  })
})

describe('P4.4a marketCurrencyAcrossChannels', () => {
  it('returns the currency when every channel configuring the market agrees', () => {
    expect(marketCurrencyAcrossChannels('IT', ROWS)).toBe('EUR')
    expect(marketCurrencyAcrossChannels('UK', ROWS)).toBe('GBP')
    expect(marketCurrencyAcrossChannels('GB', ROWS)).toBe('GBP')
    expect(marketCurrencyAcrossChannels('PL', ROWS)).toBe('PLN')
  })

  it('🔴 two channels disagreeing is REFUSED, not resolved by picking one', () => {
    // Picking one is how a guess gets written down as a fact.
    const conflicting = [...ROWS, { channel: 'SHOPIFY', code: 'UK', currency: 'USD' }]
    expect(() => marketCurrencyAcrossChannels('UK', conflicting))
      .toThrow(/configured with more than one currency \(GBP, USD\)/)
  })

  it('an unknown market is refused', () => {
    expect(() => marketCurrencyAcrossChannels('NO', ROWS)).toThrow(/No currency is configured for the NO market/)
  })

  it('a row with a blank currency does not count as agreement', () => {
    expect(() => marketCurrencyAcrossChannels('AT', [{ channel: 'AMAZON', code: 'AT', currency: '' }]))
      .toThrow(/No currency is configured/)
  })
})
