import { describe, expect, it } from 'vitest'
import { amountProblems, floorPriceRefusal, MESSAGE_AMOUNT_MAX, priceInWords } from './price-check'

/** B-TH-049 (gap N7): the amount field's rules and the price check of a note for the floor. Every word is made up. */
describe('B-TH-049 price check of a note for the floor', () => {
  it('finds a price written with a sign, a currency or a money word, in Italian or English', () => {
    for (const [text, found] of [
      ['Il cliente paga € 12,50 al pezzo', '€ 12,50'],
      ['Price agreed: 12.50€ each', '12.50€'],
      ['30 EUR per jacket', '30 EUR'],
      ['costa 18 euro', '18 euro'],
      ['prezzo: 42', 'prezzo: 42'],
      ['the cost of 7 per metre', 'cost of 7'],
      ['sconto 10% sul lotto', 'sconto 10'],
      ['USD 1,250.00 for the lot', 'USD 1,250.00'],
      ['$5 more than last season', '$5'],
    ] as const) expect(priceInWords(text), text).toBe(found)
  })

  it('leaves a note of pieces, sizes, dates and counts alone', () => {
    for (const text of ['Taglia 48: 30 pezzi entro venerdì', 'Totale 120 capi, 4 colli', 'Amount: 30 pieces in size 52', 'Europa 2026: cuciture rinforzate', 'Costura doppia sul fianco, 3 mm', 'Ordine 12/11, consegna 20/11']) expect(priceInWords(text), text).toBeNull()
  })

  it('names what looked like a price in the refusal, in both languages', () => {
    const refusal = floorPriceRefusal('Attenzione: il lotto vale € 1.200')
    expect(refusal?.code).toBe('FLOOR_PRICE')
    expect(refusal?.words.it).toContain('“€ 1.200”')
    expect(refusal?.words.en).toContain('the floor never sees money')
    expect(floorPriceRefusal('Cucire il collo prima delle maniche')).toBeNull()
  })
})

describe('B-TH-049 the amount field', () => {
  it('a whole number of cents from 0, in an ISO 4217 currency, never on a note for the floor', () => {
    expect(amountProblems({ value: 12_50, currency: 'EUR' }, { forFloor: false })).toEqual([])
    expect(amountProblems({ value: 0, currency: 'CHF' }, { forFloor: false })).toEqual([])
    expect(amountProblems({ value: -1, currency: 'EUR' }, { forFloor: false }).map((problem) => problem.path)).toEqual(['body/amount/value'])
    expect(amountProblems({ value: 1.5, currency: 'EUR' }, { forFloor: false }).map((problem) => problem.path)).toEqual(['body/amount/value'])
    expect(amountProblems({ value: MESSAGE_AMOUNT_MAX + 1, currency: 'EUR' }, { forFloor: false }).map((problem) => problem.path)).toEqual(['body/amount/value'])
    expect(amountProblems({ value: 100, currency: 'eur' }, { forFloor: false }).map((problem) => problem.path)).toEqual(['body/amount/currency'])
    expect(amountProblems({ value: 100, currency: 'EUR' }, { forFloor: true }).map((problem) => problem.path)).toEqual(['body/amount'])
  })
})
