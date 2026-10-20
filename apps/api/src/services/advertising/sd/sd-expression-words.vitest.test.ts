/**
 * SD-AUD — every Sponsored Display expression shape of the SD 3.0 grammar reads in plain words, with Amazon's resolved
 * expression naming ids; an unknown type is shown as Amazon names it, never dropped. Fake ids only.
 */
import { describe, expect, it } from 'vitest'
import { sdExpressionInWords, sdTacticInWords } from './sd-expression-words.js'

describe('sdExpressionInWords — contextual (T00020 shapes)', () => {
  it('a product, similar products, and a category with every refinement', () => {
    expect(sdExpressionInWords([{ type: 'asinSameAs', value: 'B0FX000001' }])).toBe('product B0FX000001')
    expect(sdExpressionInWords([{ type: 'similarProduct' }])).toBe('products similar to the advertised products')
    expect(sdExpressionInWords([
      { type: 'asinCategorySameAs', value: '123' }, { type: 'asinBrandSameAs', value: '9' }, { type: 'asinPriceBetween', value: '10-20' },
      { type: 'asinReviewRatingGreaterThan', value: '4' }, { type: 'asinIsPrimeShippingEligible', value: 'true' },
    ])).toBe('products in category 123, brand 9, price 10 to 20, rating above 4 stars, Prime shipping eligible')
    expect(sdExpressionInWords([
      { type: 'asinCategorySameAs', value: '123' }, { type: 'asinPriceLessThan', value: '30' }, { type: 'asinPriceGreaterThan', value: '5' },
      { type: 'asinReviewRatingLessThan', value: '3' }, { type: 'asinReviewRatingBetween', value: '2-4' }, { type: 'asinAgeRangeSameAs', value: '77' }, { type: 'asinGenreSameAs', value: '88' },
    ])).toBe('products in category 123, price below 30, price above 5, rating below 3 stars, rating 2 to 4 stars, age range 77, genre 88')
  })

  it("Amazon's resolved expression names the ids; an id it names the same is shown once", () => {
    expect(sdExpressionInWords(
      [{ type: 'asinCategorySameAs', value: '123' }, { type: 'asinBrandSameAs', value: '9' }],
      [{ type: 'asinCategorySameAs', value: 'Helmets' }, { type: 'asinBrandSameAs', value: 'Acme' }],
    )).toBe('products in category "Helmets" (123), brand "Acme" (9)')
    expect(sdExpressionInWords([{ type: 'asinSameAs', value: 'B0FX000001' }], [{ type: 'asinSameAs', value: 'B0FX000001' }])).toBe('product B0FX000001')
    // A resolved expression of another length is not trusted to line up.
    expect(sdExpressionInWords([{ type: 'asinCategorySameAs', value: '123' }], [])).toBe('products in category 123')
  })

  it('entertainment content, and the legacy views form', () => {
    expect(sdExpressionInWords([{ type: 'contentCategorySameAs', value: 'amzn1.iab-content.325' }])).toBe('entertainment content category amzn1.iab-content.325')
    expect(sdExpressionInWords([{ type: 'exactProduct', eventType: 'views' }])).toBe('people who viewed the advertised products')
  })

  it('negative targets: an ASIN, a brand', () => {
    expect(sdExpressionInWords([{ type: 'asinSameAs', value: 'B0FX000009' }])).toBe('product B0FX000009')
    expect(sdExpressionInWords([{ type: 'asinBrandSameAs', value: '9' }], [{ type: 'asinBrandSameAs', value: 'Acme' }])).toBe('brand "Acme" (9)')
  })
})

describe('sdExpressionInWords — audiences (T00030 nested shapes)', () => {
  it('views and purchases remarketing at product grain, with the window', () => {
    expect(sdExpressionInWords([{ type: 'views', value: [{ type: 'exactProduct' }, { type: 'lookback', value: '30' }] }]))
      .toBe('people who viewed the advertised products in the last 30 days')
    expect(sdExpressionInWords([{ type: 'views', value: [{ type: 'similarProduct' }, { type: 'lookback', value: '14' }] }]))
      .toBe('people who viewed products similar to the advertised products in the last 14 days')
    expect(sdExpressionInWords([{ type: 'purchases', value: [{ type: 'relatedProduct' }, { type: 'lookback', value: '365' }] }]))
      .toBe('people who bought products related to the advertised products in the last 365 days')
  })

  it('category grain with refinements, named by the resolved expression', () => {
    expect(sdExpressionInWords(
      [{ type: 'purchases', value: [{ type: 'asinCategorySameAs', value: '123' }, { type: 'asinBrandSameAs', value: '9' }, { type: 'lookback', value: '90' }] }],
      [{ type: 'purchases', value: [{ type: 'asinCategorySameAs', value: 'Helmets' }, { type: 'asinBrandSameAs', value: 'Acme' }, { type: 'lookback', value: '90' }] }],
    )).toBe('people who bought products in category "Helmets" (123), brand "Acme" (9) in the last 90 days')
  })

  it('an Amazon audience, by id and by name', () => {
    expect(sdExpressionInWords([{ type: 'audience', value: [{ type: 'audienceSameAs', value: '365000000000000001' }] }])).toBe('Amazon audience 365000000000000001')
    expect(sdExpressionInWords(
      [{ type: 'audience', value: [{ type: 'audienceSameAs', value: '365000000000000001' }] }],
      [{ type: 'audience', value: [{ type: 'audienceSameAs', value: 'IM - Test Helmets' }] }],
    )).toBe('Amazon audience "IM - Test Helmets" (365000000000000001)')
  })

  it('a number value reads as its digits; an unknown type is named, never dropped; nothing is null', () => {
    expect(sdExpressionInWords([{ type: 'asinCategorySameAs', value: 45678 }])).toBe('products in category 45678')
    expect(sdExpressionInWords([{ type: 'somethingNew', value: 'x' }])).toBe('somethingNew x')
    expect(sdExpressionInWords([{ type: 'views', value: [{ type: 'somethingNew' }, { type: 'lookback', value: '7' }] }])).toBe('people who viewed somethingNew in the last 7 days')
    expect(sdExpressionInWords(null)).toBeNull()
    expect(sdExpressionInWords([])).toBeNull()
  })
})

describe('sdTacticInWords', () => {
  it('names both tactics and keeps an unknown one', () => {
    expect(sdTacticInWords('T00020')).toBe('contextual targeting (products and categories)')
    expect(sdTacticInWords('T00030')).toMatch(/^audiences/)
    expect(sdTacticInWords('T00099')).toBe('T00099')
    expect(sdTacticInWords(null)).toBeNull()
  })
})
