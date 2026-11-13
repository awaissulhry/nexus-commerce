import { describe, expect, it } from 'vitest'
import { Dec } from '../../tax/decimal'
import type { WaterfallStep } from '../price-waterfall/rules'
import { discountNeeded, goalProblems, goalWords, restartOf, scaledPrice, TARGET_PRICE_REASON, totalFactor } from './rules'

describe('target price goal-seek (SAL-150)', () => {
  it('takes a target with the figure its kind needs', () => {
    expect(goalProblems({ kind: 'UNIT_PRICE', unitPrice: '395' })).toEqual([])
    expect(goalProblems({ kind: 'UNIT_PRICE' })[0]?.path).toBe('body/target/unitPrice')
    expect(goalProblems({ kind: 'DISCOUNT', pct: '100' })[0]?.path).toBe('body/target/pct')
    expect(goalProblems({ kind: 'MARGIN', marginPct: '35.5' })).toEqual([])
    expect(goalProblems({ kind: 'MARGIN', marginPct: '100' })).toHaveLength(1)
    expect(goalProblems({ kind: 'TOTAL', amount: '0' })[0]?.path).toBe('body/target/amount')
  })

  it('says the discount needed off the start, a raise below 0', () => {
    expect(discountNeeded('420', '399')).toBe('5')
    expect(discountNeeded('400', '410')).toBe('-2.5')
    expect(discountNeeded(null, '10')).toBeNull()
  })

  it('finds the factor that brings the chosen lines to the total', () => {
    expect((totalFactor('3000', new Dec('3190'), new Dec('0')) as { toFixed(places: number): string }).toFixed(6)).toBe('0.940439')
    expect(totalFactor('500', new Dec('400'), new Dec('600'))).toEqual({ problem: expect.stringContaining('other lines alone') })
    expect(totalFactor('500', new Dec('0'), new Dec('0'))).toEqual({ problem: expect.stringContaining('make nothing') })
    expect(scaledPrice('420', new Dec('0.940439'), 'EUR')).toBe('394.98')
  })

  it("keeps the line's start and discount; a line without a waterfall starts from its list, else its price now", () => {
    const listed: WaterfallStep[] = [
      { kind: 'LIST', unitPrice: '420', source: { type: 'PriceListEntry', id: '0190f8a6-0000-7000-8000-000000000001' } },
      { kind: 'DISCOUNT', unitPrice: '399', delta: '-21', pct: '5', reasonCode: 'VOLUME' },
      { kind: 'NET', unitPrice: '399' },
    ]
    expect(restartOf(listed, '420', '399')).toEqual({ start: 'LIST', startUnitPrice: '420', discount: { pct: '5', reasonCode: 'VOLUME', note: null } })
    const typed: WaterfallStep[] = [{ kind: 'MANUAL', unitPrice: '470', reasonCode: 'LOYALTY' }, { kind: 'NET', unitPrice: '470' }]
    expect(restartOf(typed, null, '470')).toEqual({ start: 'MANUAL', startPrice: '470', startReasonCode: 'LOYALTY', startUnitPrice: '470' })
    expect(restartOf(null, '430', '420')).toEqual({ start: 'LIST', startUnitPrice: '430' })
    expect(restartOf(null, null, '410')).toMatchObject({ start: 'MANUAL', startPrice: '410', startReasonCode: TARGET_PRICE_REASON })
    // A stored LIST start whose list no longer prices the line starts from the price now.
    expect(restartOf(listed, null, '399')).toMatchObject({ start: 'MANUAL', startPrice: '399' })
  })

  it('says the goal in words', () => {
    expect(goalWords({ kind: 'UNIT_PRICE', unitPrice: '395' }, 2, 'EUR')).toBe('Unit price 395.00 EUR on 2 lines')
    expect(goalWords({ kind: 'TOTAL', amount: '3000' }, 1, 'EUR')).toBe('A total of 3000.00 EUR from 1 line')
  })
})
