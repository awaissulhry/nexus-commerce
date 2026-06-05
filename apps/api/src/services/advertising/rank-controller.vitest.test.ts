import { describe, it, expect } from 'vitest'
import { resolveActiveTargetKey, computeStep, stepFor, type RankTargetSpec } from './rank-controller.js'

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

  it('clamps at maxPct — already maxed holds', () => {
    const d = computeStep(T(), obs({ currentPct: 900, achievedISFraction: 0.4, achievedAcosFraction: 0.3 }))
    expect(d.action).toBe('hold'); expect(d.nextPct).toBe(900)
  })

  it('stepFor: all-out is more aggressive', () => {
    expect(stepFor(T())).toBe(15)
    expect(stepFor(T({ allOut: true }))).toBe(25)
  })
})
