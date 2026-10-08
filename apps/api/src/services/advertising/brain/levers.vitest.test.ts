/**
 * ONE BRAIN AB-1 — levers, levels, settings and lock vocabularies (brain/levers.ts).
 *
 *   levels    the brain owns a lever at PROPOSE and AUTO; every lever starts OBSERVE
 *   now       the bids lever takes OBSERVE and AUTO; the hours lever OFF, OBSERVE and PROPOSE (AB-13: a painted plan always
 *             asks, never AUTO); every other lever OFF or OBSERVE until its PR, with the reason
 *   settings  each setting's default is the design's and sits inside its bounds; a value outside, of the wrong type,
 *             or at a scope the setting does not take is refused with the reason
 *   locks     a ref in its lever's vocabulary (hour cell, lane, term normalised); a whole-lever lock takes the Owner's
 *             own value in its lever's shape, or nothing (as it is now)
 *
 * Values are made up (public repo).
 */
import { describe, expect, it } from 'vitest'
import {
  BRAIN_LEVERS, BRAIN_SETTINGS, DEFAULT_LEVEL, isCalendarDay, levelRefusal, lockRef, lockValueRefusal, ownsLever, readSnapshots, settingDefaults, settingRefusal,
} from './levers.js'

describe('levels', () => {
  it('the brain owns a lever at PROPOSE and AUTO only; every lever starts in shadow', () => {
    expect(['OFF', 'OBSERVE', 'PROPOSE', 'AUTO'].map((l) => ownsLever(l as never))).toEqual([false, false, true, true])
    expect(DEFAULT_LEVEL).toBe('OBSERVE')
  })

  it('a level is offered only once code runs it', () => {
    expect(levelRefusal('bids', 'AUTO')).toBeNull()
    expect(levelRefusal('bids', 'OBSERVE')).toBeNull()
    expect(levelRefusal('bids', 'PROPOSE')).toMatch(/no proposal path/)
    expect(levelRefusal('bids', 'OFF')).toMatch(/decides every allowlisted campaign in shadow/)
    // AB-8 — the money levers have their writer; AB-12 — the state lever too; AB-10 — the negatives lever too; AB-17 — the
    // bidding-strategy lever too: every level.
    for (const lever of ['budgets', 'portfolioCap', 'state', 'negatives', 'harvest', 'biddingStrategy'] as const) {
      for (const level of ['OFF', 'OBSERVE', 'PROPOSE', 'AUTO'] as const) expect(levelRefusal(lever, level), `${lever} ${level}`).toBeNull()
    }
    // AB-13 — the hours lever paints and asks (D3 = B+): PROPOSE yes, AUTO never.
    expect(levelRefusal('hours', 'PROPOSE')).toBeNull()
    expect(levelRefusal('hours', 'OFF')).toBeNull()
    expect(levelRefusal('hours', 'AUTO')).toMatch(/takes OFF or OBSERVE or PROPOSE today, not AUTO: .*never AUTO/)
    for (const lever of BRAIN_LEVERS.filter((l) => l !== 'bids' && l !== 'budgets' && l !== 'portfolioCap' && l !== 'state' && l !== 'hours' && l !== 'negatives' && l !== 'harvest' && l !== 'biddingStrategy')) {
      expect(levelRefusal(lever, 'OFF')).toBeNull()
      expect(levelRefusal(lever, 'OBSERVE')).toBeNull()
      expect(levelRefusal(lever, 'AUTO')).toMatch(/takes OFF or OBSERVE today, not AUTO: .*AB-\d+/)
      expect(levelRefusal(lever, 'PROPOSE')).toMatch(/not PROPOSE/)
    }
  })
})

describe('settings', () => {
  it('defaults are the design\'s, each inside its bounds', () => {
    expect(settingDefaults()).toMatchObject({
      negativesPerDay: 20, harvestPerDay: 10, negativesPerEntityMax: 950, negativesShadowDays: 14, paceTargetPct: 90,
      portfolioCapOn: true, portfolioCapPct: 115, portfolioCapCents: null, ownPortfolio: true, strategySwitchMode: 'PROPOSE_THEN_AUTO',
      // AB-13 — four weeks of hours researched; the Owner's own plan is a limit only when he says so.
      hourResearchWeeks: 4, hourPlanAsLimits: false, hourCellMovePct: 30, hourProposalsPerWeek: 1,
    })
    for (const [key, spec] of Object.entries(BRAIN_SETTINGS)) {
      if (spec.type === 'int') expect(spec.default >= spec.min && spec.default <= spec.max, key).toBe(true)
    }
  })

  it('refuses a value outside its bounds, of the wrong type, or at a scope it does not take', () => {
    expect(settingRefusal('negativesPerDay', 40, 'PRODUCT')).toBeNull()
    expect(settingRefusal('negativesPerEntityMax', 990, 'CAMPAIGN')).toMatch(/from 100 to 950, not 990/)
    expect(settingRefusal('paceTargetPct', 89.5, 'PRODUCT')).toMatch(/whole number/)
    expect(settingRefusal('portfolioCapCents', null, 'PRODUCT')).toBeNull()
    expect(settingRefusal('portfolioCapCents', 50, 'PRODUCT')).toMatch(/from 100 to 100000000 or empty/)
    expect(settingRefusal('portfolioCapOn', 'yes', 'PRODUCT')).toMatch(/true or false/)
    expect(settingRefusal('strategySwitchMode', 'ALWAYS_PROPOSE', 'CAMPAIGN')).toBeNull()
    expect(settingRefusal('strategySwitchMode', 'SOMETIMES', 'PRODUCT')).toMatch(/PROPOSE_THEN_AUTO or ALWAYS_PROPOSE/)
    // AB-17 — N4's 30 days are the Owner's own number, per product (0: AUTO switches alone at once).
    expect(settingDefaults().strategyApprovalDays).toBe(30)
    expect(settingRefusal('strategyApprovalDays', 0, 'PRODUCT')).toBeNull()
    expect(settingRefusal('strategyApprovalDays', 400, 'PRODUCT')).toMatch(/from 0 to 365/)
    expect(settingRefusal('strategyApprovalDays', 10, 'CAMPAIGN')).toMatch(/set per product, not per campaign/)
    expect(settingRefusal('paceTargetPct', 80, 'CAMPAIGN')).toMatch(/set per product, not per campaign/)
    expect(settingRefusal('mystery', 1, 'PRODUCT')).toMatch(/not a setting/)
    expect(settingRefusal('hourResearchWeeks', 9, 'PRODUCT')).toMatch(/from 2 to 8, not 9/)
    expect(settingRefusal('hourPlanAsLimits', true, 'CAMPAIGN')).toMatch(/set per product, not per campaign/)
  })

  it('AB-12 — the state lever\'s settings: 3 days at the least for a pause, weeks before an archive proposal, the Owner\'s long stop as a day', () => {
    expect(settingDefaults()).toMatchObject({ pauseMinDays: 3, archiveDeadWeeks: 4, longStopUntil: null })
    expect(settingRefusal('pauseMinDays', 7, 'CAMPAIGN')).toBeNull()
    expect(settingRefusal('pauseMinDays', 2, 'PRODUCT')).toMatch(/from 3 to 60, not 2/)
    expect(settingRefusal('archiveDeadWeeks', 1, 'PRODUCT')).toMatch(/from 2 to 52/)
    expect(settingRefusal('longStopUntil', '2026-11-02', 'CAMPAIGN')).toBeNull()
    expect(settingRefusal('longStopUntil', null, 'PRODUCT')).toBeNull()
    for (const bad of ['2026-02-30', '02/11/2026', '2026-11-2', 20261102, '1999-01-01']) {
      expect(settingRefusal('longStopUntil', bad, 'PRODUCT'), String(bad)).toMatch(/takes a day as YYYY-MM-DD \(2020 to 2099\) or empty/)
    }
    expect(isCalendarDay('2028-02-29')).toBe(true)
    expect(isCalendarDay('2026-02-29')).toBe(false)
  })
})

describe('locks', () => {
  it('a ref is the whole lever or one thing in the lever\'s vocabulary', () => {
    expect(lockRef('budgets', '')).toEqual({ ref: '' })
    expect(lockRef('hours', 'hourCell:d1h14')).toEqual({ ref: 'hourCell:d1h14' })
    expect(lockRef('negatives', 'term:  Moto   Jacket ')).toEqual({ ref: 'term:moto jacket' })
    expect(lockRef('placements', 'lane:TOP_OF_SEARCH')).toEqual({ ref: 'lane:TOP_OF_SEARCH' })
    expect(lockRef('hours', 'hourCell:d7h1')).toEqual({ refusal: expect.stringContaining('d1h14 = Monday') })
    expect(lockRef('placements', 'lane:TOP')).toEqual({ refusal: expect.stringContaining('TOP_OF_SEARCH') })
    expect(lockRef('budgets', 'term:x')).toEqual({ refusal: 'a lock on the budgets lever holds the whole lever only, not term:x' })
    expect(lockRef('bids', 'hourCell:d1h1')).toEqual({ refusal: expect.stringContaining('one adGroup / target') })
    expect(lockRef('bids', 'target:')).toHaveProperty('refusal')
  })

  it('a whole-lever lock takes the Owner\'s own value in its lever\'s shape, or nothing', () => {
    expect(lockValueRefusal('budgets', '', null, 'CAMPAIGN')).toBeNull()
    expect(lockValueRefusal('budgets', '', { dailyBudgetCents: 2500 }, 'CAMPAIGN')).toBeNull()
    expect(lockValueRefusal('budgets', '', { dailyBudgetCents: 50 }, 'CAMPAIGN')).toMatch(/dailyBudgetCents/)
    expect(lockValueRefusal('biddingStrategy', '', 'LEGACY_FOR_SALES', 'CAMPAIGN')).toBeNull()
    expect(lockValueRefusal('biddingStrategy', '', 'UP_ONLY', 'CAMPAIGN')).toMatch(/MANUAL, LEGACY_FOR_SALES, AUTO_FOR_SALES/)
    expect(lockValueRefusal('placements', '', { TOP_OF_SEARCH: 50, PRODUCT_PAGE: 0 }, 'CAMPAIGN')).toBeNull()
    expect(lockValueRefusal('placements', '', { TOP_OF_SEARCH: 950 }, 'CAMPAIGN')).toMatch(/0 to 900/)
    expect(lockValueRefusal('portfolioCap', '', { amountCents: 50000 }, 'PRODUCT')).toBeNull()
    expect(lockValueRefusal('portfolioCap', '', null, 'CAMPAIGN')).toMatch(/per product/)
    expect(lockValueRefusal('bids', '', { bidCents: 30 }, 'CAMPAIGN')).toMatch(/takes no value/)
    expect(lockValueRefusal('hours', 'hourCell:d1h14', 1.2, 'PRODUCT')).toMatch(/takes no value/)
  })
})

describe('snapshots', () => {
  it('keeps a well-formed snapshot per lever', () => {
    expect(readSnapshots({ bids: { takenAt: 't', by: 'user:owner', data: { enrolled: ['c-1'] } }, nope: { takenAt: 't', by: 'b' }, hours: { by: 'x' } }))
      .toEqual({ bids: { takenAt: 't', by: 'user:owner', data: { enrolled: ['c-1'] } } })
  })
})
