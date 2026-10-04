import { describe, it, expect } from 'vitest'
import { resolveActiveTargetKey, computeStep, biasBand, type RankTargetSpec, cpcCapPct, strategyHeadroom } from './rank-controller.js'

const T = (over: Partial<RankTargetSpec> = {}): RankTargetSpec => ({
  key: 'own-top', placement: 'PLACEMENT_TOP', targetISPct: 70, acosCapPct: 45,
  maxCpcCents: null, biasPct: 100, pause: false, allOut: false, ...over,
})

describe('resolveActiveTargetKey', () => {
  it('a covering window with a targetKey wins', () => {
    const w = [{ days: [1, 2, 3], startHour: 18, endHour: 22, targetKey: 'own-top' }]
    expect(resolveActiveTargetKey(w, 'rest-of-search', 2, 20)).toBe('own-top')
  })
  it('outside every window falls to the baseline', () => {
    const w = [{ days: [1, 2, 3], startHour: 18, endHour: 22, targetKey: 'own-top' }]
    expect(resolveActiveTargetKey(w, 'rest-of-search', 2, 9)).toBe('rest-of-search')
  })
  it('no windows → baseline; no baseline → null', () => {
    expect(resolveActiveTargetKey([], 'defend-top', 0, 0)).toBe('defend-top')
    expect(resolveActiveTargetKey([], null, 0, 0)).toBeNull()
  })
  it('a legacy multiplier window (no targetKey) is ignored → baseline', () => {
    const w = [{ days: [2], startHour: 0, endHour: 24, bidMultiplierPct: 50 }]
    expect(resolveActiveTargetKey(w, 'rest-of-search', 2, 12)).toBe('rest-of-search')
  })
  it('empty days array means every day', () => {
    const w = [{ days: [], startHour: 8, endHour: 17, targetKey: 'defend-top' }]
    expect(resolveActiveTargetKey(w, null, 5, 10)).toBe('defend-top')
  })
})

/**
 * 2e (Owner D1 = A) — an hour-of-day bid plan. computeStep sets the hour's fixed Placement % in one move and holds it;
 * nothing else is read. The tests that used to lock the chase (IS / ACoS / loss proxy / steps / keep-climbing / all-out)
 * now lock its absence: every one of those inputs, set to anything, leaves the answer at the Placement %.
 */
describe('computeStep (2e) — the hour holds its Placement %; nothing climbs', () => {
  const obs = (currentPct: number) => ({ currentPct })

  it('Min-bid target → pause, no placement move', () => {
    expect(computeStep(T({ pause: true }), obs(80))).toMatchObject({ action: 'pause', nextPct: 80 })
  })
  it('below Placement % → set to it in ONE move', () => {
    expect(computeStep(T(), obs(50))).toMatchObject({ action: 'raise', nextPct: 100 })
  })
  it('above Placement % → set to it in ONE move', () => {
    expect(computeStep(T(), obs(130))).toMatchObject({ action: 'lower', nextPct: 100 })
  })
  it('at Placement % → hold (so a tick inside the same hour writes nothing)', () => {
    const d = computeStep(T(), obs(100))
    expect(d).toMatchObject({ action: 'hold', nextPct: 100 })
    expect(d.reason).toMatch(/holding 100% Placement/)
  })
  it('blank Placement % holds 0% (a leftover multiplier is set back to 0)', () => {
    expect(computeStep(T({ biasPct: null }), obs(130))).toMatchObject({ action: 'lower', nextPct: 0 })
  })

  it('all-out no longer climbs: it holds its Placement % at every live value', () => {
    const allOut = T({ allOut: true, biasPct: 150, acosCapPct: null, targetISPct: 90 })
    expect(computeStep(allOut, obs(0))).toMatchObject({ action: 'raise', nextPct: 150 })
    expect(computeStep(allOut, obs(150))).toMatchObject({ action: 'hold', nextPct: 150 }) // before 2e: raise → 175
    expect(computeStep(allOut, obs(900))).toMatchObject({ action: 'lower', nextPct: 150 }) // before 2e: hold 900
  })
  it('a ceiling above Placement %, keep-climbing and steps are not read: no chase, no ramp', () => {
    const tuned = T({ maxBiasPct: 300, keepClimbing: true, stepUpPct: 20, stepDownPct: 10, jumpStartPct: 50 })
    expect(computeStep(tuned, obs(50))).toMatchObject({ action: 'raise', nextPct: 100 }) // before 2e: ramp 50 → 70
    expect(computeStep(tuned, obs(100))).toMatchObject({ action: 'hold', nextPct: 100 }) // before 2e: climb → 120
    expect(computeStep(tuned, obs(200))).toMatchObject({ action: 'lower', nextPct: 100 }) // before 2e: ease 200 → 190
  })
  it('signals passed by an old caller are ignored (the simulate route sends them)', () => {
    const old = { currentPct: 100, achievedISFraction: 0.1, achievedAcosFraction: 0.1, lossDetected: true }
    expect(computeStep(T({ maxBiasPct: 300 }), old as never)).toMatchObject({ action: 'hold', nextPct: 100 })
  })
  it('maxPct (a CPC cap) can only hold it LOWER, never lift it', () => {
    expect(computeStep(T(), obs(100), { maxPct: 60 })).toMatchObject({ action: 'lower', nextPct: 60 })
    expect(computeStep(T(), obs(100), { maxPct: 400 })).toMatchObject({ action: 'hold', nextPct: 100 })
  })
  it('the answer depends only on the hour\'s target and the live value — identical inputs, identical move', () => {
    for (const cur of [0, 50, 100, 200, 800]) {
      const a = computeStep(T({ allOut: true, maxBiasPct: 900, keepClimbing: true }), obs(cur))
      expect(a.nextPct).toBe(100)
      expect(computeStep(T(), obs(a.nextPct)).action).toBe('hold')
    }
  })
  it('biasBand: the ceiling IS the floor, whatever the stored ceiling or all-out flag say', () => {
    expect(biasBand({ biasPct: 150 })).toEqual({ floor: 150, ceiling: 150 })
    expect(biasBand(T({ allOut: true, maxBiasPct: 900, biasPct: 150 }))).toEqual({ floor: 150, ceiling: 150 })
    expect(biasBand({ biasPct: 2000 })).toEqual({ floor: 900, ceiling: 900 })
  })
})

/**
 * MB.4 — the CPC ceiling. This is the function that turns `maxCpcCents` from a stored
 * decoration into an enforced limit, so the property that matters is arithmetic: at the
 * returned cap, base bid × (1 + cap/100) × strategy headroom must not exceed the ceiling.
 * A rounding error here overspends on every click of every all-out hour.
 */
describe('MB.4 cpcCapPct — the placement % a CPC ceiling permits', () => {
  const effCpc = (base: number, pct: number, mult = 1) => base * (1 + pct / 100) * mult

  it('returns null when there is nothing to cap', () => {
    expect(cpcCapPct(null, 45)).toBeNull() // no ceiling set — today's behaviour for most targets
    expect(cpcCapPct(200, null)).toBeNull() // no bids known → cannot breach anything
    expect(cpcCapPct(200, 0)).toBeNull()
    expect(cpcCapPct(0, 45)).toBeNull()
  })

  it('computes the cap from base bid and ceiling', () => {
    // €0.45 base, €2.00 ceiling → 2.00/0.45 = 4.444× → +344%
    expect(cpcCapPct(200, 45)).toEqual({ capPct: 344, baseAlone: false })
  })

  it('the capped bid never exceeds the ceiling, and one point more would', () => {
    const cap = cpcCapPct(200, 45)!
    expect(effCpc(45, cap.capPct)).toBeLessThanOrEqual(200)
    expect(effCpc(45, cap.capPct + 1)).toBeGreaterThan(200)
  })

  it('FLOORS rather than rounds — rounding up would land over the ceiling', () => {
    // Any base/ceiling pair whose exact cap is fractional must round DOWN.
    for (const [ceil, base] of [[200, 45], [150, 37], [99, 13], [500, 111]] as const) {
      const cap = cpcCapPct(ceil, base)!
      expect(Number.isInteger(cap.capPct)).toBe(true)
      expect(effCpc(base, cap.capPct)).toBeLessThanOrEqual(ceil)
    }
  })

  it('halves the headroom for an up-and-down campaign, which Amazon may bid +100% again', () => {
    const legacy = cpcCapPct(200, 45, strategyHeadroom('LEGACY_FOR_SALES'))!
    const auto = cpcCapPct(200, 45, strategyHeadroom('AUTO_FOR_SALES'))!
    expect(auto.capPct).toBeLessThan(legacy.capPct)
    // the ceiling still holds once Amazon's own uplift is applied
    expect(effCpc(45, auto.capPct, 2)).toBeLessThanOrEqual(200)
  })

  it('an unknown / absent bidding strategy takes no extra headroom', () => {
    expect(strategyHeadroom(null)).toBe(1)
    expect(strategyHeadroom('SOMETHING_NEW')).toBe(1)
    expect(strategyHeadroom('MANUAL')).toBe(1)
  })

  it('base bid alone over the ceiling → cap 0 and SAY so; no multiplier can rescue it', () => {
    const cap = cpcCapPct(50, 120)!
    expect(cap).toEqual({ capPct: 0, baseAlone: true })
  })

  it('base bid exactly at the ceiling → 0%, and it is not a breach', () => {
    expect(cpcCapPct(45, 45)).toEqual({ capPct: 0, baseAlone: false })
  })

  it('a generous ceiling caps above the 900% Amazon maximum — the band clamp still applies', () => {
    // Not this function's job to know Amazon's 900 cap; it must not invent a limit either.
    expect(cpcCapPct(10_000, 45)!.capPct).toBeGreaterThan(900)
  })
})
