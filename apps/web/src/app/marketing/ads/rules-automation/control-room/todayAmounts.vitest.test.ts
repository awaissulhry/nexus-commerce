/** 7b (review 8.6) — Today never adds two currencies, and says each in its own. */
import { describe, expect, it } from 'vitest'
import { headlineAmount, money, rowAmounts } from './todayAmounts'

describe('Today money', () => {
  it('says each currency in its own sign and never adds them', () => {
    const wasted = [{ currency: 'EUR', cents: 24_761 }, { currency: 'GBP', cents: 1_230 }]
    expect(headlineAmount({ wastedSpend30dCents: null, wasted })).toBe('€247.61 · £12.30')
    expect(rowAmounts({ amountCents: null, amounts: wasted }).map(money)).toEqual(['€247.61', '£12.30'])
  })

  it('a single non-euro currency is not shown as euros', () => {
    expect(headlineAmount({ wastedSpend30dCents: 1_230, wasted: [{ currency: 'GBP', cents: 1_230 }] })).toBe('£12.30')
  })

  it('an older answer (euros only) still reads, and no waste is a dash, not €0', () => {
    expect(headlineAmount({ wastedSpend30dCents: 7_620 })).toBe('€76.20')
    expect(headlineAmount({ wastedSpend30dCents: null, wasted: [] })).toBe('—')
    expect(rowAmounts({ amountCents: null })).toEqual([])
    expect(rowAmounts({ amountCents: 500 })).toEqual([{ currency: 'EUR', cents: 500 }])
  })
})
