/**
 * Ads autonomy W0 — whose target ACoS a bid moves toward (ads-target-acos-resolver.ts). Pure: the order of the sources
 * (a number someone configured beats a more general one), each field read in its own unit and range, a stored value
 * outside it skipped (never converted) and named, and the check the optimiser makes before it works out profit targets.
 * Made-up values only.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../db.js', () => ({ default: {} }))

import {
  MAX_ACCOUNT_DEFAULT_PCT, MAX_TARGET_ACOS_FRACTION, TARGET_ACOS_SOURCES, accountDefaultFraction, commonTargetOf, reachesSource,
  resolveTargetAcos, targetFraction, targetSourceNote, type TargetAcosInputs, type TargetAcosSubject,
} from './ads-target-acos-resolver.js'

const subject = (campaignTargetAcos: unknown, adGroupId = 'g1'): TargetAcosSubject => ({ adGroupId, campaignTargetAcos })
const inputs = (over: Partial<TargetAcosInputs> = {}): TargetAcosInputs => ({ explicitTargetAcos: undefined, accountDefaultPct: null, profitByAdGroup: null, flatTargetAcos: 0.3, ...over })
const all = { accountDefaultPct: 25, profitByAdGroup: new Map([['g1', 0.12]]), flatTargetAcos: 0.5 }

describe('the order: explicit → campaign → account → profit → flat', () => {
  it('lists the sources highest first; W1 inserts product / category / market between campaign and account', () => {
    expect(TARGET_ACOS_SOURCES.map((s) => s.source)).toEqual(['explicit', 'campaign', 'account', 'profit', 'flat'])
  })

  it("the caller's explicit target (a rule's, a plan's, a typed one) wins over the campaign's and everything after", () => {
    expect(resolveTargetAcos(subject(0.2), inputs({ ...all, explicitTargetAcos: 0.35 }))).toEqual({ targetAcos: 0.35, source: 'explicit', skipped: [] })
  })

  it("without one, the campaign's own target wins over the account default, profit data and the fallback", () => {
    expect(resolveTargetAcos(subject(0.2), inputs(all))).toEqual({ targetAcos: 0.2, source: 'campaign', skipped: [] })
  })

  it('without a campaign target, the account default wins over profit data and the fallback', () => {
    expect(resolveTargetAcos(subject(undefined), inputs(all))).toEqual({ targetAcos: 0.25, source: 'account', skipped: [] })
  })

  it("without either, profit data for its ad group (in profit mode), else the caller's fallback, else 30 %", () => {
    const profit = new Map([['g1', 0.12]])
    expect(resolveTargetAcos(subject(null, 'g1'), inputs({ profitByAdGroup: profit }))).toEqual({ targetAcos: 0.12, source: 'profit', skipped: [] })
    expect(resolveTargetAcos(subject(null, 'g2'), inputs({ profitByAdGroup: profit, flatTargetAcos: 0.45 }))).toEqual({ targetAcos: 0.45, source: 'flat', skipped: [] })
    expect(resolveTargetAcos(subject(null), inputs())).toEqual({ targetAcos: 0.3, source: 'flat', skipped: [] })
  })
})

describe('units and range: what the screens accept, nothing converted', () => {
  it('the ranges are the writers\': a fraction up to 5 (500 %), an account percent up to 500', () => {
    expect(MAX_TARGET_ACOS_FRACTION).toBe(5)
    expect(MAX_ACCOUNT_DEFAULT_PCT).toBe(500)
  })

  it('an explicit or campaign target is a FRACTION above 0 and at most 5 — a launch target above 100 % is read', () => {
    for (const ok of [0.25, 1, 1.5, 5]) expect(targetFraction(ok)).toBe(ok)
    expect(targetFraction(null)).toBeNull()
    expect(targetFraction(undefined)).toBeNull()
    // 30 is a percent in the wrong unit (3,000 % as a fraction); 0 and below are no target; a string is not a number.
    for (const bad of [30, 5.01, 0, -0.2, Number.NaN, '0.3', {}]) expect(targetFraction(bad)).toEqual({ refused: bad })
  })

  it('the account default is an INTEGER PERCENT above 0 and at most 500, read as a fraction', () => {
    expect(accountDefaultFraction(25)).toBe(0.25)
    expect(accountDefaultFraction(150)).toBe(1.5)
    expect(accountDefaultFraction(500)).toBe(5)
    expect(accountDefaultFraction(null)).toBeNull()
    for (const bad of [0, -5, 501, Number.NaN, '25']) expect(accountDefaultFraction(bad)).toEqual({ refused: bad })
  })

  it('a campaign storing 30 is skipped (not read as 0.3 or 3,000 %): the account default answers, and the skip is named', () => {
    const r = resolveTargetAcos(subject(30), inputs({ accountDefaultPct: 25 }))
    expect(r).toEqual({ targetAcos: 0.25, source: 'account', skipped: [{ source: 'campaign', stored: 30 }] })
    expect(targetSourceNote(r)).toBe(' (account default) [campaign target 30 skipped: not a fraction above 0 and at most 5]')
  })

  it("a caller's explicit value out of range is skipped too, named in the caller's words", () => {
    const r = resolveTargetAcos(subject(0.2), inputs({ explicitTargetAcos: 30 }))
    expect(r).toEqual({ targetAcos: 0.2, source: 'campaign', skipped: [{ source: 'explicit', stored: 30 }] })
    expect(targetSourceNote(r, "this rule's target")).toBe(" (campaign target) [this rule's target 30 skipped: not a fraction above 0 and at most 5]")
  })

  it('an account default of 0 or above 500 is skipped: profit data or the fallback answers', () => {
    expect(resolveTargetAcos(subject(undefined), inputs({ accountDefaultPct: 600, profitByAdGroup: new Map([['g1', 0.18]]) })))
      .toEqual({ targetAcos: 0.18, source: 'profit', skipped: [{ source: 'account', stored: 600 }] })
    expect(resolveTargetAcos(subject(9), inputs({ accountDefaultPct: 0 }))).toEqual({
      targetAcos: 0.3, source: 'flat', skipped: [{ source: 'campaign', stored: 9 }, { source: 'account', stored: 0 }],
    })
  })
})

describe('what the optimiser reads from it', () => {
  it("reachesSource: profit targets are worked out only for ad groups a configured target leaves open", () => {
    expect(reachesSource('profit', subject(undefined), inputs({ explicitTargetAcos: 0.3 }))).toBe(false)
    expect(reachesSource('profit', subject(0.2), inputs())).toBe(false)
    expect(reachesSource('profit', subject(undefined), inputs({ accountDefaultPct: 25 }))).toBe(false)
    expect(reachesSource('profit', subject(undefined), inputs())).toBe(true)
    // A skipped value does not cover the ad group.
    expect(reachesSource('profit', subject(30), inputs({ accountDefaultPct: 600 }))).toBe(true)
  })

  it('the reason names whose target it is; a plain flat target reads as it always did', () => {
    expect(targetSourceNote({ source: 'explicit', skipped: [] }, "this plan's target")).toBe(" (this plan's target)")
    expect(targetSourceNote({ source: 'explicit', skipped: [] })).toBe(' (the target asked for)')
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
