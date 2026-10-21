/**
 * Meta step 18 — one helper per field, each with its unit: minor units of the account currency → Meta's offset unit
 * (budgets, bids, caps, minimum spend), the no-cap value, ROAS × 10,000, a scheduled increase by an amount in WHOLE units
 * (the safe reading of an undocumented unit) or a percentage, times as UTC Unix seconds.
 */
import { describe, expect, it } from 'vitest'
import {
  adSetSpendCapParam, bidAmountMeaning, bidAmountParam, budgetParam, campaignSpendCapParam, metaUnitsToMinor, MetaUnitError, minSpendTargetParam,
  roasFloorParam, roasOfFloor, scheduleAbsoluteCents, scheduleAbsoluteParam, schedulePercentParam, unixSecondsParam,
} from './settings-units.js'

describe('budgets and bids: minor units → Meta\'s offset unit', () => {
  it('EUR: cents are Meta\'s unit (offset 100)', () => {
    expect(budgetParam(5000, 'EUR')).toBe('5000')
    expect(bidAmountParam(150, 'EUR')).toBe('150')
    expect(metaUnitsToMinor('5000', 'EUR')).toBe(5000)
  })
  it('JPY and HUF: whole units both sides (offset 1, no decimals)', () => {
    expect(budgetParam(1200, 'JPY')).toBe('1200')
    expect(budgetParam(3000, 'HUF')).toBe('3000')
    expect(metaUnitsToMinor('1200', 'JPY')).toBe(1200)
  })
  it('BHD (3 decimals, Meta counts hundredths): only amounts Meta can hold — never rounded', () => {
    expect(budgetParam(12340, 'BHD')).toBe('1234')
    expect(() => budgetParam(12345, 'BHD')).toThrow(MetaUnitError)
    expect(metaUnitsToMinor('1234', 'BHD')).toBe(12340)
  })
  it('refuses nothing, negatives and fractions', () => {
    expect(() => budgetParam(0, 'EUR')).toThrow(/at least 1/)
    expect(() => bidAmountParam(0, 'EUR')).toThrow(/at least 1/)
    expect(() => budgetParam(10.5, 'EUR')).toThrow(/whole number/)
  })
  it('a bid is per 1,000 impressions when billed on impressions', () => {
    expect(bidAmountMeaning('IMPRESSIONS')).toBe('per 1,000 impressions')
    expect(bidAmountMeaning('LINK_CLICKS')).toBe('per result')
  })
})

describe('spend caps and minimum spend', () => {
  it('a campaign spend cap in minor units; null removes it with Meta\'s 922337203685478', () => {
    expect(campaignSpendCapParam(1_000_000, 'EUR')).toBe('1000000')
    expect(campaignSpendCapParam(null, 'EUR')).toBe('922337203685478')
    expect(() => campaignSpendCapParam(0, 'EUR')).toThrow(MetaUnitError)
  })
  it('an ad set spend cap the same way; a minimum spend of 0 removes it', () => {
    expect(adSetSpendCapParam(2500, 'EUR')).toBe('2500')
    expect(adSetSpendCapParam(null, 'EUR')).toBe('922337203685478')
    expect(minSpendTargetParam(0, 'EUR')).toBe('0')
    expect(minSpendTargetParam(1000, 'EUR')).toBe('1000')
  })
})

describe('ROAS goal: × 10,000, 100 … 10,000,000', () => {
  it('converts both ways', () => {
    expect(roasFloorParam(1.5)).toBe(15000)
    expect(roasFloorParam(0.01)).toBe(100)
    expect(roasFloorParam(1000)).toBe(10_000_000)
    expect(roasOfFloor(25000)).toBe(2.5)
  })
  it('refuses out of range and more than 4 decimals', () => {
    expect(() => roasFloorParam(0.005)).toThrow(/between 0.01 and 1000/)
    expect(() => roasFloorParam(1001)).toThrow(/between/)
    expect(() => roasFloorParam(1.23456)).toThrow(/4 decimals/)
  })
})

describe('scheduled increases', () => {
  it('by an amount: whole currency units only (the safe reading of Meta\'s undocumented unit)', () => {
    expect(scheduleAbsoluteParam(2000, 'EUR')).toBe('20')
    expect(scheduleAbsoluteCents(20, 'EUR')).toBe(2000)
    expect(() => scheduleAbsoluteParam(2050, 'EUR')).toThrow(/whole/)
    expect(() => scheduleAbsoluteParam(50, 'EUR')).toThrow(/at least one whole/)
    expect(scheduleAbsoluteParam(500, 'JPY')).toBe('500')
  })
  it('by a percentage: 1 … 700 (the total stays at most 8 daily budgets)', () => {
    expect(schedulePercentParam(40)).toBe('40')
    expect(() => schedulePercentParam(0)).toThrow(MetaUnitError)
    expect(() => schedulePercentParam(701)).toThrow(/700/)
    expect(() => schedulePercentParam(12.5)).toThrow(MetaUnitError)
  })
})

describe('times', () => {
  it('ISO → UTC Unix seconds', () => {
    expect(unixSecondsParam('2026-11-01T08:00:00Z')).toBe('1793520000')
    expect(unixSecondsParam('2026-11-01T09:00:00+01:00')).toBe('1793520000')
    expect(() => unixSecondsParam('tomorrow')).toThrow(/not a time/)
  })
})
