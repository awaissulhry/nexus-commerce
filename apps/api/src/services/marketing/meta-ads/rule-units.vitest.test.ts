/**
 * Meta step 29 — ONE helper for the money a rule writes (minor units of the account currency → Meta's base unit), the
 * inverse of step 8's metaBudgetCents: exact both ways, the sign kept (a cut), refused where Meta cannot hold an amount.
 */
import { describe, expect, it } from 'vitest'
import { ruleMoneyParam, ruleMoneyRange } from './rule-units.js'
import { metaBudgetCents } from './live-optimize.js'
import { MetaUnitError } from './settings-units.js'

describe('ruleMoneyParam', () => {
  it('EUR / USD: minor units are Meta\'s base unit (1000 = 10.00), a cut keeps its sign', () => {
    expect(ruleMoneyParam(5000, 'EUR')).toBe(5000)
    expect(ruleMoneyParam(-3000, 'USD')).toBe(-3000)
    expect(ruleMoneyParam(0, 'EUR')).toBe(0)
    expect(ruleMoneyRange([4000, 6000], 'EUR')).toEqual([4000, 6000])
  })
  it('JPY and HUF: Meta counts whole units, and so do their minor units', () => {
    expect(ruleMoneyParam(500, 'JPY')).toBe(500)
    expect(ruleMoneyParam(1200, 'HUF')).toBe(1200)
  })
  it('BHD: three decimals, Meta counts hundredths — exact amounts convert, others are refused (never rounded)', () => {
    expect(ruleMoneyParam(1230, 'BHD')).toBe(123)
    expect(() => ruleMoneyParam(1234, 'BHD')).toThrow(MetaUnitError)
    expect(() => ruleMoneyParam(1.5, 'EUR')).toThrow(/whole number of minor units/)
  })
  it('is exactly the inverse of step 8\'s metaBudgetCents', () => {
    for (const [cents, currency] of [[5000, 'EUR'], [-2500, 'EUR'], [700, 'JPY'], [1230, 'BHD'], [99, 'USD']] as const) {
      expect(metaBudgetCents(ruleMoneyParam(cents, currency), currency), `${cents} ${currency}`).toBe(cents)
    }
  })
})
