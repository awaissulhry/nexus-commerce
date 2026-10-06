/**
 * Ads autonomy W0 — whose target ACoS a bid moves toward (ads-target-acos-resolver.ts). Pure: the order of the sources,
 * each field read in its own unit, a stored value that is not a target skipped (never converted) and named, and the
 * check the optimiser makes before it works out profit targets. Made-up values only.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../db.js', () => ({ default: {} }))

import {
  TARGET_ACOS_SOURCES, accountDefaultFraction, campaignTargetFraction, commonTargetOf, reachesSource, resolveTargetAcos,
  targetSourceNote, type TargetAcosInputs, type TargetAcosSubject,
} from './ads-target-acos-resolver.js'

const subject = (campaignTargetAcos: unknown, adGroupId = 'g1'): TargetAcosSubject => ({ adGroupId, campaignTargetAcos })
const inputs = (over: Partial<TargetAcosInputs> = {}): TargetAcosInputs => ({ accountDefaultPct: null, profitByAdGroup: null, flatTargetAcos: 0.3, ...over })

describe('the order: campaign → account → profit → flat', () => {
  it('lists the sources highest first, so the next wave can put product / category / market levels in front', () => {
    expect(TARGET_ACOS_SOURCES.map((s) => s.source)).toEqual(['campaign', 'account', 'profit', 'flat'])
  })

  it("the campaign's own target wins over the account default, profit data and the caller's target", () => {
    expect(resolveTargetAcos(subject(0.2), inputs({ accountDefaultPct: 25, profitByAdGroup: new Map([['g1', 0.12]]), flatTargetAcos: 0.5 })))
      .toEqual({ targetAcos: 0.2, source: 'campaign', skipped: [] })
  })

  it('without a campaign target, the account default wins over profit data and the caller', () => {
    expect(resolveTargetAcos(subject(undefined), inputs({ accountDefaultPct: 25, profitByAdGroup: new Map([['g1', 0.12]]), flatTargetAcos: 0.5 })))
      .toEqual({ targetAcos: 0.25, source: 'account', skipped: [] })
  })

  it('without either, profit data for its ad group (in profit mode), else the caller\'s flat target', () => {
    const profit = new Map([['g1', 0.12]])
    expect(resolveTargetAcos(subject(null, 'g1'), inputs({ profitByAdGroup: profit }))).toEqual({ targetAcos: 0.12, source: 'profit', skipped: [] })
    expect(resolveTargetAcos(subject(null, 'g2'), inputs({ profitByAdGroup: profit, flatTargetAcos: 0.45 }))).toEqual({ targetAcos: 0.45, source: 'flat', skipped: [] })
    // Not in profit mode: no profit source at all.
    expect(resolveTargetAcos(subject(null), inputs())).toEqual({ targetAcos: 0.3, source: 'flat', skipped: [] })
  })
})

describe('units: each field in its own unit, nonsense skipped, never guessed', () => {
  it('a campaign target is a FRACTION above 0 and at most 1', () => {
    expect(campaignTargetFraction(0.25)).toBe(0.25)
    expect(campaignTargetFraction(1)).toBe(1)
    expect(campaignTargetFraction(null)).toBeNull()
    expect(campaignTargetFraction(undefined)).toBeNull()
    // 30 is a percent in the wrong unit (3,000 % as a fraction); 1.5 is 150 %; 0 and below are no target; a string is not a number.
    for (const bad of [30, 1.5, 0, -0.2, Number.NaN, '0.3', {}]) expect(campaignTargetFraction(bad)).toEqual({ refused: bad })
  })

  it('the account default is an INTEGER PERCENT above 0 and at most 100, read as a fraction', () => {
    expect(accountDefaultFraction(25)).toBe(0.25)
    expect(accountDefaultFraction(100)).toBe(1)
    expect(accountDefaultFraction(null)).toBeNull()
    for (const bad of [0, -5, 150, 500, Number.NaN, '25']) expect(accountDefaultFraction(bad)).toEqual({ refused: bad })
  })

  it('a campaign storing 30 is skipped (not read as 0.3 or 3,000 %): the account default answers, and the skip is named', () => {
    const r = resolveTargetAcos(subject(30), inputs({ accountDefaultPct: 25 }))
    expect(r).toEqual({ targetAcos: 0.25, source: 'account', skipped: [{ source: 'campaign', stored: 30 }] })
    expect(targetSourceNote(r)).toBe(' (account default) [campaign target 30 skipped: not a fraction above 0 and at most 1]')
  })

  it('an account default above 100 is skipped too: profit data or the flat target answers', () => {
    const r = resolveTargetAcos(subject(undefined), inputs({ accountDefaultPct: 150, profitByAdGroup: new Map([['g1', 0.18]]) }))
    expect(r).toEqual({ targetAcos: 0.18, source: 'profit', skipped: [{ source: 'account', stored: 150 }] })
    expect(resolveTargetAcos(subject(2), inputs({ accountDefaultPct: 0 }))).toEqual({
      targetAcos: 0.3, source: 'flat', skipped: [{ source: 'campaign', stored: 2 }, { source: 'account', stored: 0 }],
    })
  })
})

describe('what the optimiser reads from it', () => {
  it('reachesSource: profit targets are worked out only for ad groups the Owner\'s targets leave open', () => {
    expect(reachesSource('profit', subject(0.2), inputs())).toBe(false)
    expect(reachesSource('profit', subject(undefined), inputs({ accountDefaultPct: 25 }))).toBe(false)
    expect(reachesSource('profit', subject(undefined), inputs())).toBe(true)
    // A skipped value does not cover the ad group.
    expect(reachesSource('profit', subject(30), inputs({ accountDefaultPct: 150 }))).toBe(true)
    expect(reachesSource('campaign', subject(0.2), inputs())).toBe(true)
  })

  it('the reason names whose target it is; a plain flat target reads as it always did', () => {
    expect(targetSourceNote({ source: 'campaign', skipped: [] })).toBe(' (campaign target)')
    expect(targetSourceNote({ source: 'account', skipped: [] })).toBe(' (account default)')
    expect(targetSourceNote({ source: 'profit', skipped: [] })).toBe(' (profit-derived)')
    expect(targetSourceNote({ source: 'flat', skipped: [] })).toBe('')
  })

  it('commonTargetOf: one target for a batch that moved toward the same one, null when they differ', () => {
    expect(commonTargetOf([])).toBeNull()
    expect(commonTargetOf([{ targetAcosUsed: 0.255, targetSource: 'campaign' }, { targetAcosUsed: 0.255, targetSource: 'campaign' }]))
      .toEqual({ targetAcosPct: 25.5, source: 'campaign' })
    expect(commonTargetOf([{ targetAcosUsed: 0.2, targetSource: 'profit' }, { targetAcosUsed: 0.3, targetSource: 'flat' }])).toBeNull()
  })
})
