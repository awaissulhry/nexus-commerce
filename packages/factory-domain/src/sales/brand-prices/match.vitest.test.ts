import { describe, expect, it } from 'vitest'
import { PRICE_MATCHES, brandAmountOf, priceCheckOf, type BrandPriceRow, type PriceCheckLine } from './match'

/**
 * The price check (customer page lane B-CP-010; D4, D5; review G5, B4): our price beside the customer's, per line and per
 * order, net of VAT, in the order's currency, exact to the cent. Made-up figures in minor units (EUR cents).
 */

const line = (lineId: string, pieces: number, ourNet: number): PriceCheckLine => ({ lineId, pieces, ourNet })
const unit = (lineId: string, unitPrice: string, currency = 'EUR'): BrandPriceRow => ({ lineId, unitPrice, netAmount: null, currency })
const lineTotal = (lineId: string, netAmount: number, currency = 'EUR'): BrandPriceRow => ({ lineId, unitPrice: null, netAmount, currency })
const orderTotal = (netAmount: number, currency = 'EUR'): BrandPriceRow => ({ lineId: null, unitPrice: null, netAmount, currency })

// Two lines: 10 jackets at €120.00 and 5 trousers at €80.00 → €1,200.00 + €400.00 = €1,600.00.
const LINES = [line('l1', 10, 120_000), line('l2', 5, 40_000)]
const OUR_NET = 160_000

describe('the price check of an order', () => {
  it('names the three outcomes, in this order', () => {
    expect(PRICE_MATCHES).toEqual(['EQUAL', 'NOT_EQUAL', 'NO_BRAND_PRICE'])
  })

  it('equal: every line equal and the sum equal, no difference', () => {
    const check = priceCheckOf({ currency: 'EUR', ourNet: OUR_NET, lines: LINES, brand: [unit('l1', '120.00'), unit('l2', '80')] })
    expect(check.lines).toEqual([
      { lineId: 'l1', brandAmount: 120_000, priceMatch: 'EQUAL', priceDiff: 0 },
      { lineId: 'l2', brandAmount: 40_000, priceMatch: 'EQUAL', priceDiff: 0 },
    ])
    expect(check.total).toEqual({ ourPrice: OUR_NET, brandPrice: OUR_NET, priceMatch: 'EQUAL', priceDiff: 0, priceNotEqualLines: 0, priceMissingLines: 0, priceOtherCurrency: 0 })
  })

  it('one cent off is not equal (tolerance 0), on the line and on the order', () => {
    const check = priceCheckOf({ currency: 'EUR', ourNet: OUR_NET, lines: LINES, brand: [unit('l1', '120.00'), lineTotal('l2', 39_999)] })
    expect(check.lines[1]).toEqual({ lineId: 'l2', brandAmount: 39_999, priceMatch: 'NOT_EQUAL', priceDiff: 1 })
    expect(check.total).toMatchObject({ brandPrice: 159_999, priceMatch: 'NOT_EQUAL', priceDiff: 1, priceNotEqualLines: 1, priceMissingLines: 0 })
  })

  it('a total row only: the order is checked on it, the lines have no customer price', () => {
    const equal = priceCheckOf({ currency: 'EUR', ourNet: OUR_NET, lines: LINES, brand: [orderTotal(160_000)] })
    expect(equal.total).toMatchObject({ brandPrice: 160_000, priceMatch: 'EQUAL', priceDiff: 0, priceMissingLines: 2 })
    expect(equal.lines.map((row) => row.priceMatch)).toEqual(['NO_BRAND_PRICE', 'NO_BRAND_PRICE'])
    const off = priceCheckOf({ currency: 'EUR', ourNet: OUR_NET, lines: LINES, brand: [orderTotal(150_000)] })
    expect(off.total).toMatchObject({ brandPrice: 150_000, priceMatch: 'NOT_EQUAL', priceDiff: 10_000 })
  })

  it('the total row wins over the sum of the lines, but a line that differs still makes the order not equal', () => {
    const check = priceCheckOf({ currency: 'EUR', ourNet: OUR_NET, lines: LINES, brand: [orderTotal(160_000), unit('l1', '119.00')] })
    expect(check.total).toMatchObject({ brandPrice: 160_000, priceMatch: 'NOT_EQUAL', priceDiff: 0, priceNotEqualLines: 1, priceMissingLines: 1 })
  })

  it('a line total is taken as it is; a unit price is multiplied by the pieces and rounded half up to the cent', () => {
    expect(brandAmountOf({ unitPrice: null, netAmount: 12_345 }, 7, 'EUR')).toBe(12_345)
    // 3 × 10.335 = 31.005 → 31.01 (half up); 3 × 10.3349 = 31.0047 → 31.00.
    expect(brandAmountOf({ unitPrice: '10.335', netAmount: null }, 3, 'EUR')).toBe(3_101)
    expect(brandAmountOf({ unitPrice: '10.3349', netAmount: null }, 3, 'EUR')).toBe(3_100)
    // A currency without decimals: 2 × 1000.5 JPY = 2001 JPY.
    expect(brandAmountOf({ unitPrice: '1000.5', netAmount: null }, 2, 'JPY')).toBe(2_001)
    expect(brandAmountOf({ unitPrice: null, netAmount: null }, 2, 'EUR')).toBeNull()
    // The line total wins when a row carries both (the store refuses it; the rule stays defined).
    expect(brandAmountOf({ unitPrice: '1.00', netAmount: 500 }, 2, 'EUR')).toBe(500)
  })

  it('a line total and unit × pieces that reach the same amount are both equal', () => {
    const check = priceCheckOf({ currency: 'EUR', ourNet: 3_101, lines: [line('l1', 3, 3_101)], brand: [unit('l1', '10.335')] })
    expect(check.total.priceMatch).toBe('EQUAL')
    const byTotal = priceCheckOf({ currency: 'EUR', ourNet: 3_101, lines: [line('l1', 3, 3_101)], brand: [lineTotal('l1', 3_101)] })
    expect(byTotal.total.priceMatch).toBe('EQUAL')
  })

  it('partial lines: no customer price yet, never equal — even when the lines given are equal', () => {
    const check = priceCheckOf({ currency: 'EUR', ourNet: OUR_NET, lines: LINES, brand: [unit('l1', '120.00')] })
    expect(check.lines.map((row) => row.priceMatch)).toEqual(['EQUAL', 'NO_BRAND_PRICE'])
    expect(check.total).toEqual({ ourPrice: OUR_NET, brandPrice: null, priceMatch: 'NO_BRAND_PRICE', priceDiff: null, priceNotEqualLines: 0, priceMissingLines: 1, priceOtherCurrency: 0 })
  })

  it('no customer price at all: no customer price yet', () => {
    const check = priceCheckOf({ currency: 'EUR', ourNet: OUR_NET, lines: LINES, brand: [] })
    expect(check.total).toMatchObject({ brandPrice: null, priceMatch: 'NO_BRAND_PRICE', priceDiff: null, priceMissingLines: 2 })
  })

  it('a known difference wins over a missing price', () => {
    const check = priceCheckOf({ currency: 'EUR', ourNet: OUR_NET, lines: LINES, brand: [unit('l1', '110.00')] })
    expect(check.lines[0]).toEqual({ lineId: 'l1', brandAmount: 110_000, priceMatch: 'NOT_EQUAL', priceDiff: 10_000 })
    expect(check.total).toMatchObject({ brandPrice: null, priceMatch: 'NOT_EQUAL', priceDiff: null, priceNotEqualLines: 1, priceMissingLines: 1 })
  })

  it('a size-surcharge line: its amount (with the surcharge) is compared, not its base unit price', () => {
    // 8 pieces at €100.00 plus 2 pieces of a large size at €110.00: our line net €1,020.00.
    const lines = [line('l1', 10, 102_000)]
    const withSurcharge = priceCheckOf({ currency: 'EUR', ourNet: 102_000, lines, brand: [lineTotal('l1', 102_000)] })
    expect(withSurcharge.total.priceMatch).toBe('EQUAL')
    const baseOnly = priceCheckOf({ currency: 'EUR', ourNet: 102_000, lines, brand: [unit('l1', '100.00')] })
    expect(baseOnly.lines[0]).toEqual({ lineId: 'l1', brandAmount: 100_000, priceMatch: 'NOT_EQUAL', priceDiff: 2_000 })
  })

  it('a free line with no customer price and a 0-piece line are skipped (never a false not equal)', () => {
    const lines = [line('l1', 10, 120_000), line('free', 1, 0), line('emptied', 0, 0)]
    // The customer's row stays on the line a split emptied: it is not read.
    const check = priceCheckOf({ currency: 'EUR', ourNet: 120_000, lines, brand: [unit('l1', '120.00'), unit('emptied', '50.00')] })
    expect(check.lines.slice(1)).toEqual([
      { lineId: 'free', brandAmount: null, priceMatch: null, priceDiff: null },
      { lineId: 'emptied', brandAmount: null, priceMatch: null, priceDiff: null },
    ])
    expect(check.total).toMatchObject({ brandPrice: 120_000, priceMatch: 'EQUAL', priceMissingLines: 0, priceNotEqualLines: 0 })
  })

  it('a free line the customer did price is checked', () => {
    const check = priceCheckOf({ currency: 'EUR', ourNet: 120_000, lines: [line('l1', 10, 120_000), line('free', 1, 0)], brand: [unit('l1', '120.00'), unit('free', '5.00')] })
    expect(check.lines[1]).toEqual({ lineId: 'free', brandAmount: 500, priceMatch: 'NOT_EQUAL', priceDiff: -500 })
    expect(check.total).toMatchObject({ brandPrice: 120_500, priceMatch: 'NOT_EQUAL', priceDiff: -500 })
  })

  it('an order whose lines are all skipped and no total row: no customer price yet', () => {
    const check = priceCheckOf({ currency: 'EUR', ourNet: 0, lines: [line('free', 1, 0)], brand: [] })
    expect(check.total).toMatchObject({ brandPrice: null, priceMatch: 'NO_BRAND_PRICE', priceMissingLines: 0 })
  })

  it("a customer's price in another currency is never used, only counted", () => {
    const check = priceCheckOf({ currency: 'EUR', ourNet: OUR_NET, lines: LINES, brand: [unit('l1', '120.00'), unit('l2', '80.00', 'USD'), orderTotal(160_000, 'CHF')] })
    expect(check.lines[1]).toEqual({ lineId: 'l2', brandAmount: null, priceMatch: 'NO_BRAND_PRICE', priceDiff: null })
    expect(check.total).toMatchObject({ brandPrice: null, priceMatch: 'NO_BRAND_PRICE', priceMissingLines: 1, priceOtherCurrency: 2 })
  })

  it('the difference is our price minus the customer\'s: + we ask more, − we ask less', () => {
    const more = priceCheckOf({ currency: 'EUR', ourNet: OUR_NET, lines: LINES, brand: [orderTotal(155_000)] })
    expect(more.total.priceDiff).toBe(5_000)
    const less = priceCheckOf({ currency: 'EUR', ourNet: OUR_NET, lines: LINES, brand: [orderTotal(165_000)] })
    expect(less.total.priceDiff).toBe(-5_000)
    const lineLess = priceCheckOf({ currency: 'EUR', ourNet: OUR_NET, lines: LINES, brand: [unit('l1', '121.00'), unit('l2', '80.00')] })
    expect(lineLess.lines[0]!.priceDiff).toBe(-1_000)
    expect(lineLess.total.priceDiff).toBe(-1_000)
  })

  it('a row for a line that is not on the order is not read; a second row for the same line neither', () => {
    const check = priceCheckOf({ currency: 'EUR', ourNet: OUR_NET, lines: LINES, brand: [unit('l1', '120.00'), unit('l1', '1.00'), unit('l2', '80.00'), unit('gone', '9.00')] })
    expect(check.total).toMatchObject({ brandPrice: OUR_NET, priceMatch: 'EQUAL' })
  })

  it('every output key has a money-looking name (review B4: the grain guard catches price/amount/total)', () => {
    const check = priceCheckOf({ currency: 'EUR', ourNet: OUR_NET, lines: LINES, brand: [unit('l1', '120.00')] })
    const money = /cost|margin|price|amount|total|wage/i
    for (const key of Object.keys(check.total)) expect(key, key).toMatch(money)
    for (const key of Object.keys(check.lines[0]!).filter((key) => key !== 'lineId')) expect(key, key).toMatch(money)
  })
})
