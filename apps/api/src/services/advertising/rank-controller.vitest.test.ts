import { describe, it, expect } from 'vitest'
import { resolveActiveTargetKey, computeStep, stepFor, isRankLoss, type RankTargetSpec } from './rank-controller.js'

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

describe('computeStep', () => {
  const obs = (over = {}) => ({ currentPct: 50, achievedISFraction: null, achievedAcosFraction: null, ...over })

  it('pause target → pause, no bid change', () => {
    expect(computeStep(T({ pause: true }), obs({ currentPct: 80 }))).toMatchObject({ action: 'pause', nextPct: 80 })
  })

  it('IS below target + ACOS ok → raise by the step', () => {
    const d = computeStep(T(), obs({ achievedISFraction: 0.4, achievedAcosFraction: 0.3 }))
    expect(d.action).toBe('raise'); expect(d.nextPct).toBe(65)
  })

  it('IS comfortably above target → lower (least cost)', () => {
    const d = computeStep(T(), obs({ currentPct: 80, achievedISFraction: 0.85, achievedAcosFraction: 0.3 }))
    expect(d.action).toBe('lower'); expect(d.nextPct).toBe(65)
  })

  it('non-all-out: ACOS just over cap → wont chase rank, holds', () => {
    // IS below target BUT ACOS 50% vs cap 45% (>1.1x, <1.2x) → cannot raise, not bad
    // enough to cut → holds. Profit ceiling stops us chasing rank into a loss.
    const d = computeStep(T(), obs({ achievedISFraction: 0.4, achievedAcosFraction: 0.5 }))
    expect(d.action).toBe('hold')
  })

  it('non-all-out: ACOS well over cap (>1.2x) → ease off even if IS is short', () => {
    const d = computeStep(T(), obs({ currentPct: 50, achievedISFraction: 0.4, achievedAcosFraction: 0.6 }))
    expect(d.action).toBe('lower'); expect(d.nextPct).toBe(35)
  })

  it('ALL-OUT ignores ACOS: raises for the slot even when ACOS is way over', () => {
    const d = computeStep(T({ allOut: true, acosCapPct: 45 }), obs({ achievedISFraction: 0.4, achievedAcosFraction: 0.9 }))
    expect(d.action).toBe('raise'); expect(d.nextPct).toBe(75) // step 25 for all-out
  })

  it('loss proxy → re-take aggressively (2x step)', () => {
    const d = computeStep(T(), obs({ achievedISFraction: 0.7, achievedAcosFraction: 0.3, lossDetected: true }))
    expect(d.action).toBe('raise'); expect(d.nextPct).toBe(80) // 50 + 2*15
  })

  it('no IS, ACOS well under cap → raise to capture more', () => {
    const d = computeStep(T(), obs({ achievedAcosFraction: 0.3 })) // cap 45, 0.3 <= 0.8*0.45=0.36
    expect(d.action).toBe('raise')
  })

  it('no IS, ACOS over cap → ease off', () => {
    const d = computeStep(T(), obs({ currentPct: 60, achievedAcosFraction: 0.6 }))
    expect(d.action).toBe('lower')
  })

  it('all-out with no signal → push for the slot', () => {
    const d = computeStep(T({ allOut: true }), obs({ currentPct: 0 }))
    expect(d.action).toBe('raise'); expect(d.nextPct).toBe(25)
  })

  it('RS.5.1: fresh own-top campaign with no signal ramps to the entry bias', () => {
    const d = computeStep(T(), obs({ currentPct: 0 })) // biasPct 100, no IS/ACOS
    expect(d.action).toBe('raise'); expect(d.nextPct).toBe(30); expect(d.reason).toMatch(/entry bias/)
  })

  it('RS.5.1: at the entry bias with no signal → hold (does not overshoot)', () => {
    const d = computeStep(T(), obs({ currentPct: 100 }))
    expect(d.action).toBe('hold')
  })

  it('RS.5.1b: no signal + bias ABOVE a low target (rest-of-search 0%) → snaps DOWN to it', () => {
    const d = computeStep(T({ biasPct: 0, targetISPct: 10, acosCapPct: 30 }), obs({ currentPct: 130 }))
    expect(d.action).toBe('lower'); expect(d.nextPct).toBe(0); expect(d.reason).toMatch(/entry bias/)
  })
  it('RS.5.1b: no signal + bias above own-top entry → snaps down to the entry bias', () => {
    const d = computeStep(T(), obs({ currentPct: 130 })) // biasPct 100
    expect(d.action).toBe('lower'); expect(d.nextPct).toBe(100)
  })
  it('RS.5.1b: all-out is exempt — maxed with no signal HOLDS, never eases down to biasPct', () => {
    const d = computeStep(T({ allOut: true, biasPct: 150 }), obs({ currentPct: 900 }))
    expect(d.action).toBe('hold'); expect(d.nextPct).toBe(900)
  })

  it('clamps at maxPct — already maxed holds', () => {
    const d = computeStep(T(), obs({ currentPct: 900, achievedISFraction: 0.4, achievedAcosFraction: 0.3 }))
    expect(d.action).toBe('hold'); expect(d.nextPct).toBe(900)
  })

  it('stepFor: all-out is more aggressive', () => {
    expect(stepFor(T())).toBe(15)
    expect(stepFor(T({ allOut: true }))).toBe(25)
  })
})

describe('MP — motion profile (jump / climb / ease / ceiling / keep-climbing)', () => {
  const obs = (over = {}) => ({ currentPct: 50, achievedISFraction: null, achievedAcosFraction: null, ...over })

  it('opening jump: jumpStartPct snaps to the opening in ONE cycle (no signal)', () => {
    const d = computeStep(T({ jumpStartPct: 75 }), obs({ currentPct: 0 }))
    expect(d.action).toBe('raise'); expect(d.nextPct).toBe(75); expect(d.reason).toMatch(/jump|opening/)
  })
  it('after the jump (no keep-climbing) it HOLDS at the opening', () => {
    const d = computeStep(T({ jumpStartPct: 75 }), obs({ currentPct: 75 }))
    expect(d.action).toBe('hold'); expect(d.nextPct).toBe(75)
  })

  it('custom climb step: stepUpPct drives the raise increment', () => {
    const d = computeStep(T({ stepUpPct: 30 }), obs({ currentPct: 50, achievedISFraction: 0.4, achievedAcosFraction: 0.3 }))
    expect(d.action).toBe('raise'); expect(d.nextPct).toBe(80) // 50 + 30
  })
  it('custom ease step: stepDownPct drives the signal-driven lower increment', () => {
    const d = computeStep(T({ stepDownPct: 5 }), obs({ currentPct: 80, achievedISFraction: 0.85, achievedAcosFraction: 0.3 }))
    expect(d.action).toBe('lower'); expect(d.nextPct).toBe(75) // 80 - 5
  })

  it('gradual down: stepDownPct set ⇒ ease −N to the floor instead of snapping', () => {
    const d = computeStep(T({ biasPct: 0, stepDownPct: 20 }), obs({ currentPct: 130 }))
    expect(d.action).toBe('lower'); expect(d.nextPct).toBe(110); expect(d.reason).toMatch(/easing/) // 130 - 20, not snap-to-0
  })
  it('snap down is still the default (stepDownPct null) — one cycle to the floor', () => {
    const d = computeStep(T({ biasPct: 0 }), obs({ currentPct: 130 }))
    expect(d.action).toBe('lower'); expect(d.nextPct).toBe(0)
  })

  it('ceiling: maxBiasPct caps the climb', () => {
    const d = computeStep(T({ maxBiasPct: 300 }), obs({ currentPct: 295, achievedISFraction: 0.4, achievedAcosFraction: 0.3 }))
    expect(d.action).toBe('raise'); expect(d.nextPct).toBe(300) // 295 + 15 clamped to 300
  })
  it('ceiling: at maxBiasPct with IS short → holds (does not exceed the ceiling)', () => {
    const d = computeStep(T({ maxBiasPct: 300 }), obs({ currentPct: 300, achievedISFraction: 0.4, achievedAcosFraction: 0.3 }))
    expect(d.action).toBe('hold'); expect(d.nextPct).toBe(300)
  })

  it('keepClimbing: climbs to the ceiling with NO signal, then holds at the ceiling', () => {
    const climb = computeStep(T({ keepClimbing: true, maxBiasPct: 300 }), obs({ currentPct: 100 }))
    expect(climb.action).toBe('raise'); expect(climb.nextPct).toBe(115); expect(climb.reason).toMatch(/climb|ceiling/)
    const top = computeStep(T({ keepClimbing: true, maxBiasPct: 300 }), obs({ currentPct: 300 }))
    expect(top.action).toBe('hold'); expect(top.nextPct).toBe(300) // does NOT fall back to the floor
  })
  it('keepClimbing is still bounded by the ACOS cap — eases when over', () => {
    const d = computeStep(T({ keepClimbing: true }), obs({ currentPct: 200, achievedAcosFraction: 0.6 }))
    expect(d.action).toBe('lower'); expect(d.reason).toMatch(/over cap/)
  })

  it('REGRESSION LOCK: an all-null motion spec == historical behaviour exactly', () => {
    const nul = { jumpStartPct: null, stepUpPct: null, stepDownPct: null, maxBiasPct: null, keepClimbing: false }
    // fresh, no signal → ramp +30 to the entry bias
    expect(computeStep(T(nul), obs({ currentPct: 0 }))).toMatchObject({ action: 'raise', nextPct: 30 })
    // IS below target → +15
    expect(computeStep(T(nul), obs({ currentPct: 50, achievedISFraction: 0.4, achievedAcosFraction: 0.3 })).nextPct).toBe(65)
    // bias above entry, no signal → snap to 100
    expect(computeStep(T(nul), obs({ currentPct: 130 }))).toMatchObject({ action: 'lower', nextPct: 100 })
    // all-out, no signal → +25, ceiling 900
    expect(computeStep(T({ ...nul, allOut: true }), obs({ currentPct: 0 })).nextPct).toBe(25)
  })
})

describe('isRankLoss (RS.6 hourly proxy)', () => {
  it('sharp drop vs a meaningful baseline → loss', () => { expect(isRankLoss(1, 20)).toBe(true) })
  it('within band → no loss', () => { expect(isRankLoss(15, 20)).toBe(false) })
  it('tiny baseline → no loss (not enough confidence to act)', () => { expect(isRankLoss(0, 3)).toBe(false) })
  it('exactly at the threshold → no loss (strict <)', () => { expect(isRankLoss(8, 20)).toBe(false) }) // 8 == 20*0.4
})
