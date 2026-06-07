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

describe('computeStep v2 — Placement % is the bid; snap to it both ways by default', () => {
  const obs = (over = {}) => ({ currentPct: 50, achievedISFraction: null, achievedAcosFraction: null, ...over })

  it('pause target → pause, no bid change', () => {
    expect(computeStep(T({ pause: true }), obs({ currentPct: 80 }))).toMatchObject({ action: 'pause', nextPct: 80 })
  })

  // ── Default (no Ceiling): snap to Placement %, both ways, hold ──
  it('below Placement % → SNAP up to it in one cycle', () => {
    const d = computeStep(T(), obs({ currentPct: 50 })) // floor 100
    expect(d.action).toBe('raise'); expect(d.nextPct).toBe(100); expect(d.reason).toMatch(/snap.*Placement/)
  })
  it('above Placement % → SNAP down to it in one cycle', () => {
    const d = computeStep(T(), obs({ currentPct: 130 }))
    expect(d.action).toBe('lower'); expect(d.nextPct).toBe(100); expect(d.reason).toMatch(/snap.*Placement/)
  })
  it('at Placement % → hold', () => {
    expect(computeStep(T(), obs({ currentPct: 100 }))).toMatchObject({ action: 'hold', nextPct: 100 })
  })
  it('a signal does NOT push above Placement % when no Ceiling is set', () => {
    // IS far below target, ACOS fine — but Ceiling = Placement %, so it just snaps to 100 and holds.
    const d = computeStep(T(), obs({ currentPct: 100, achievedISFraction: 0.2, achievedAcosFraction: 0.2 }))
    expect(d.action).toBe('hold'); expect(d.nextPct).toBe(100)
  })
  it('loss is ignored without a Ceiling (no chase) — holds at Placement %', () => {
    expect(computeStep(T(), obs({ currentPct: 100, lossDetected: true }))).toMatchObject({ action: 'hold', nextPct: 100 })
  })

  // ── Climb step / Ease step = gradual instead of snap ──
  it('Climb step set → ramp UP gradually to Placement %', () => {
    const d = computeStep(T({ stepUpPct: 20 }), obs({ currentPct: 50 }))
    expect(d.action).toBe('raise'); expect(d.nextPct).toBe(70); expect(d.reason).toMatch(/ramping/) // 50 + 20
  })
  it('Ease step set → ease DOWN gradually to Placement %', () => {
    const d = computeStep(T({ stepDownPct: 10 }), obs({ currentPct: 130 }))
    expect(d.action).toBe('lower'); expect(d.nextPct).toBe(120); expect(d.reason).toMatch(/ease/) // 130 - 10
  })
  it('rest-of-search style (floor 0) snaps a leftover bias down to 0', () => {
    const d = computeStep(T({ biasPct: 0, targetISPct: null, acosCapPct: null }), obs({ currentPct: 130 }))
    expect(d.action).toBe('lower'); expect(d.nextPct).toBe(0)
  })

  // ── Ceiling above Placement % → chase band [floor, ceiling] ──
  it('Ceiling set: first reaches the floor, then chases above on an IS signal', () => {
    expect(computeStep(T({ maxBiasPct: 300 }), obs({ currentPct: 50 })).nextPct).toBe(100) // reach floor first (snap)
    const d = computeStep(T({ maxBiasPct: 300 }), obs({ currentPct: 100, achievedISFraction: 0.4, achievedAcosFraction: 0.3 }))
    expect(d.action).toBe('raise'); expect(d.nextPct).toBe(115); expect(d.reason).toMatch(/below target/) // 100 + 15
  })
  it('Ceiling caps the climb — never exceeds it', () => {
    const d = computeStep(T({ maxBiasPct: 300 }), obs({ currentPct: 295, achievedISFraction: 0.4, achievedAcosFraction: 0.3 }))
    expect(d.nextPct).toBe(300)
    expect(computeStep(T({ maxBiasPct: 300 }), obs({ currentPct: 300, achievedISFraction: 0.4, achievedAcosFraction: 0.3 }))).toMatchObject({ action: 'hold', nextPct: 300 })
  })
  it('in the band, IS above target → eases back toward the floor (not below it)', () => {
    const d = computeStep(T({ maxBiasPct: 300 }), obs({ currentPct: 200, achievedISFraction: 0.85, achievedAcosFraction: 0.3 }))
    expect(d.action).toBe('lower'); expect(d.nextPct).toBe(100) // snap toward floor (no ease step)
  })
  it('in the band, ACOS over cap → eases toward the floor even if IS is short', () => {
    const d = computeStep(T({ maxBiasPct: 300 }), obs({ currentPct: 200, achievedISFraction: 0.4, achievedAcosFraction: 0.6 }))
    expect(d.action).toBe('lower'); expect(d.reason).toMatch(/over cap/)
  })
  it('in the band, no signal + keep-climbing OFF → settles back to the floor', () => {
    const d = computeStep(T({ maxBiasPct: 300 }), obs({ currentPct: 200 }))
    expect(d.action).toBe('lower'); expect(d.nextPct).toBe(100); expect(d.reason).toMatch(/no signal/)
  })
  it('no IS, ACOS well under cap → captures more (within the band)', () => {
    const d = computeStep(T({ targetISPct: null, maxBiasPct: 300 }), obs({ currentPct: 100, achievedAcosFraction: 0.3 }))
    expect(d.action).toBe('raise'); expect(d.nextPct).toBe(115)
  })

  // ── Keep climbing ──
  it('keep-climbing climbs to the Ceiling with NO signal, then holds there', () => {
    const climb = computeStep(T({ maxBiasPct: 300, keepClimbing: true }), obs({ currentPct: 100 }))
    expect(climb.action).toBe('raise'); expect(climb.nextPct).toBe(115); expect(climb.reason).toMatch(/climbing.*ceiling/)
    expect(computeStep(T({ maxBiasPct: 300, keepClimbing: true }), obs({ currentPct: 300 }))).toMatchObject({ action: 'hold', nextPct: 300 })
  })
  it('keep-climbing is still bounded by the ACOS cap — eases when over', () => {
    const d = computeStep(T({ maxBiasPct: 300, keepClimbing: true }), obs({ currentPct: 200, achievedAcosFraction: 0.6 }))
    expect(d.action).toBe('lower'); expect(d.reason).toMatch(/over cap/)
  })

  // ── All-out (Ceiling forced to 900) ──
  it('all-out reaches its floor then pushes toward 900, ignoring ACOS', () => {
    expect(computeStep(T({ allOut: true, biasPct: 150 }), obs({ currentPct: 0 })).nextPct).toBe(150) // reach floor
    const d = computeStep(T({ allOut: true, biasPct: 150, acosCapPct: 45 }), obs({ currentPct: 150, achievedISFraction: 0.4, achievedAcosFraction: 0.9 }))
    expect(d.action).toBe('raise'); expect(d.nextPct).toBe(175); expect(d.reason).toMatch(/all-out/) // 150 + 25
  })
  it('all-out at the ceiling holds 900', () => {
    expect(computeStep(T({ allOut: true, biasPct: 150 }), obs({ currentPct: 900 }))).toMatchObject({ action: 'hold', nextPct: 900 })
  })

  it('stepFor: all-out is more aggressive', () => {
    expect(stepFor(T())).toBe(15)
    expect(stepFor(T({ allOut: true }))).toBe(25)
  })

  it('REGRESSION LOCK (v2): an all-blank target snaps to Placement % both ways and NEVER exceeds it', () => {
    const blank = { jumpStartPct: null, stepUpPct: null, stepDownPct: null, maxBiasPct: null, keepClimbing: false }
    expect(computeStep(T(blank), obs({ currentPct: 0 }))).toMatchObject({ action: 'raise', nextPct: 100 }) // snap up
    expect(computeStep(T(blank), obs({ currentPct: 500 }))).toMatchObject({ action: 'lower', nextPct: 100 }) // snap down
    // even with a strong signal, no Ceiling ⇒ never above Placement %
    for (const cur of [0, 50, 100, 200, 800]) {
      const d = computeStep(T(blank), obs({ currentPct: cur, achievedISFraction: 0.1, achievedAcosFraction: 0.1 }))
      expect(d.nextPct).toBeLessThanOrEqual(100)
    }
  })
})

describe('isRankLoss (RS.6 hourly proxy)', () => {
  it('sharp drop vs a meaningful baseline → loss', () => { expect(isRankLoss(1, 20)).toBe(true) })
  it('within band → no loss', () => { expect(isRankLoss(15, 20)).toBe(false) })
  it('tiny baseline → no loss (not enough confidence to act)', () => { expect(isRankLoss(0, 3)).toBe(false) })
  it('exactly at the threshold → no loss (strict <)', () => { expect(isRankLoss(8, 20)).toBe(false) }) // 8 == 20*0.4
})
