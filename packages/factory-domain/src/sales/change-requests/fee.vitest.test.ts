import { describe, expect, it } from 'vitest'
import { cancelFeeFor, cancelFeeOf, cancelFeePctOf, cancelFeeProblems, cancelFeeWords } from './fee'

/** The cancel fee of a customer's cancel request (B-W2b-F14 on B-W2b-183; SalesSettings.cancelFeePct). */
describe('the cancel fee', () => {
  it('takes 0 to 100 with at most 4 decimals, or none; refuses the rest in words', () => {
    for (const fine of [null, '0', '15', '12.5', '99.9999', '100']) expect(cancelFeeProblems(fine)).toEqual([])
    for (const wrong of ['-1', '100.0001', '12.34567', 'fifteen', '', 15]) {
      expect(cancelFeeProblems(wrong)).toEqual([{ path: 'body/cancelFeePct', message: 'A percentage from 0 to 100, at most 4 decimals, or none (free).' }])
    }
  })

  it('is the line net × the percent, rounded once at the minor unit (the money rules: half up)', () => {
    expect(cancelFeeOf(120_000, '15', 'EUR')).toBe(18_000)
    // 333 × 15 % = 49.95 cents → 50; 1 × 50 % = 0.5 → 1; 1 × 12.5 % = 0.125 → 0.
    expect(cancelFeeOf(333, '15', 'EUR')).toBe(50)
    expect(cancelFeeOf(1, '50', 'EUR')).toBe(1)
    expect(cancelFeeOf(1, '12.5', 'EUR')).toBe(0)
    expect(cancelFeeOf(9_999, null, 'EUR')).toBe(0)
    expect(cancelFeeOf(9_999, '0', 'EUR')).toBe(0)
    // A currency without minor units rounds at the unit.
    expect(cancelFeeOf(1_005, '10', 'JPY')).toBe(101)
  })

  it('says the fee in both languages, the Italian with a decimal comma', () => {
    expect(cancelFeeWords(null)).toEqual({ it: 'Annullamento gratuito', en: 'Free to cancel' })
    expect(cancelFeeWords('0')).toEqual({ it: 'Annullamento gratuito', en: 'Free to cancel' })
    expect(cancelFeeWords('12.5')).toEqual({ it: 'Penale del 12,5% sul valore delle righe annullate', en: "Fee 12.5% of the cancelled lines' value" })
    expect(cancelFeePctOf('15.0000')).toBe('15')
    expect(cancelFeePctOf(null)).toBeNull()
  })

  it('per line in line order and the total; the whole order leaves out a line closed short', () => {
    const lines = [
      { id: 'b', seq: 20, netAmount: 10_000, closedShort: false },
      { id: 'a', seq: 10, netAmount: 333, closedShort: false },
      { id: 'c', seq: 30, netAmount: 50_000, closedShort: true },
    ]
    expect(cancelFeeFor(lines, ['b'], '15', 'EUR')).toMatchObject({ pct: '15', currency: 'EUR', lines: [{ lineId: 'b', seq: 20, fee: 1_500 }], totalFee: 1_500 })
    expect(cancelFeeFor(lines, null, '15', 'EUR')).toMatchObject({ lines: [{ lineId: 'a', fee: 50 }, { lineId: 'b', fee: 1_500 }], totalFee: 1_550 })
    expect(cancelFeeFor(lines, [], null, 'EUR')).toMatchObject({ pct: null, totalFee: 0, words: { en: 'Free to cancel' } })
  })
})
