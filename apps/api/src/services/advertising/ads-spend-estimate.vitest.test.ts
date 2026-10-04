/**
 * 4d (review 4.4, Owner decision S11) — the projected EXTRA spend per day a rule write adds, the unit a rule's daily
 * spend ceiling sums. Pure arithmetic; the handlers' wiring is pinned in ads-bid-apply-cap and ads-placement-apply.
 */
import { describe, expect, it } from 'vitest'
import { bidExtraSpend, budgetExtraSpend, placementExtraSpend } from './ads-spend-estimate.js'

describe('budget — new minus current', () => {
  it('a raise adds the difference', () => {
    expect(budgetExtraSpend(1000, 1500)).toEqual({ extraCentsPerDay: 500, basis: 'raise' })
  })
  it('a cut and no change add nothing', () => {
    expect(budgetExtraSpend(1500, 1000)).toEqual({ extraCentsPerDay: 0, basis: 'cut' })
    expect(budgetExtraSpend(1500, 1500)).toEqual({ extraCentsPerDay: 0, basis: 'no_change' })
  })
})

describe('bid — (new − old) × clicks per day in the rule window', () => {
  it('35¢ → 40¢ on 70 clicks over 14 days is 5¢ × 5 clicks a day', () => {
    expect(bidExtraSpend({ oldBidCents: 35, newBidCents: 40, clicks: 70, windowDays: 14 })).toEqual({ extraCentsPerDay: 25, basis: 'raise' })
  })
  it('rounds a measured raise UP, so it never counts as free', () => {
    expect(bidExtraSpend({ oldBidCents: 35, newBidCents: 36, clicks: 1, windowDays: 14 })).toEqual({ extraCentsPerDay: 1, basis: 'raise' })
  })
  it('an exact figure is not nudged up by float noise', () => {
    // 3¢ × 70 / 30 = 7 exactly
    expect(bidExtraSpend({ oldBidCents: 30, newBidCents: 33, clicks: 70, windowDays: 30 }).extraCentsPerDay).toBe(7)
  })
  it('a cut and no change add nothing, whatever the clicks', () => {
    expect(bidExtraSpend({ oldBidCents: 40, newBidCents: 35, clicks: 700, windowDays: 14 })).toEqual({ extraCentsPerDay: 0, basis: 'cut' })
    expect(bidExtraSpend({ oldBidCents: 5, newBidCents: 5, clicks: 700, windowDays: 14 })).toEqual({ extraCentsPerDay: 0, basis: 'no_change' })
  })
  it('a raise with no measured clicks is 0 and says unmeasured', () => {
    expect(bidExtraSpend({ oldBidCents: 35, newBidCents: 90, clicks: 0, windowDays: 14 })).toEqual({ extraCentsPerDay: 0, basis: 'unmeasured' })
    expect(bidExtraSpend({ oldBidCents: 35, newBidCents: 90, clicks: Number.NaN, windowDays: 14 })).toEqual({ extraCentsPerDay: 0, basis: 'unmeasured' })
  })
  it('a zero-day window reads as one day, never a division by zero', () => {
    expect(bidExtraSpend({ oldBidCents: 35, newBidCents: 40, clicks: 4, windowDays: 0 }).extraCentsPerDay).toBe(20)
  })
})

describe('placement — lane spend per day × ((100 + new) / (100 + old) − 1)', () => {
  it('0% → 100% doubles what a click may cost: the lane’s whole daily spend again', () => {
    // 7,000¢ over 7 days = 1,000¢ a day
    expect(placementExtraSpend({ oldPct: 0, newPct: 100, laneSpendCents: 7000, windowDays: 7 })).toEqual({ extraCentsPerDay: 1000, basis: 'raise' })
  })
  it('30% → 50% on 1,000¢ a day is 1,000 × (150/130 − 1), rounded up', () => {
    expect(placementExtraSpend({ oldPct: 30, newPct: 50, laneSpendCents: 7000, windowDays: 7 })).toEqual({ extraCentsPerDay: 154, basis: 'raise' })
  })
  it('an exact figure is not nudged up by float noise', () => {
    // 200¢ a day × (120/100 − 1) = 40 exactly
    expect(placementExtraSpend({ oldPct: 0, newPct: 20, laneSpendCents: 1400, windowDays: 7 }).extraCentsPerDay).toBe(40)
  })
  it('a cut and no change add nothing', () => {
    expect(placementExtraSpend({ oldPct: 50, newPct: 30, laneSpendCents: 7000, windowDays: 7 })).toEqual({ extraCentsPerDay: 0, basis: 'cut' })
    expect(placementExtraSpend({ oldPct: 50, newPct: 50, laneSpendCents: 7000, windowDays: 7 })).toEqual({ extraCentsPerDay: 0, basis: 'no_change' })
  })
  it('a raise on a lane with no measured spend is 0 and says unmeasured', () => {
    expect(placementExtraSpend({ oldPct: 0, newPct: 900, laneSpendCents: 0, windowDays: 7 })).toEqual({ extraCentsPerDay: 0, basis: 'unmeasured' })
  })
})
