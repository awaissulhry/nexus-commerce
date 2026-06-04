import { describe, it, expect } from 'vitest'
import { bidAction } from './ad-dayparting.job.js'

// RC2.TR0 — protects the per-window bid-multiplier decision. The pre-TR0 cron
// only handled enter-from-off / exit-to-off, so a transition between two
// different multiplier windows on the same day fired NEITHER branch and the bids
// stuck at the first level — silently breaking per-hour (time × rank) control.
describe('RC2.TR0 bidAction — per-window bid multiplier decision', () => {
  it('ENTER: in a multiplier window with no base snapshot yet', () => {
    expect(bidAction({ inWindow: true, effMult: 50, hasBase: false, appliedMult: null })).toBe('enter')
  })

  it('TRANSITION: already adjusted, active multiplier changed (the bug TR0 fixed)', () => {
    expect(bidAction({ inWindow: true, effMult: 100, hasBase: true, appliedMult: 50 })).toBe('transition')
    // bid-down → bid-up transition too
    expect(bidAction({ inWindow: true, effMult: -40, hasBase: true, appliedMult: 50 })).toBe('transition')
  })

  it('NONE: same multiplier still applied → no churn', () => {
    expect(bidAction({ inWindow: true, effMult: 50, hasBase: true, appliedMult: 50 })).toBe('none')
  })

  it('EXIT: left all windows (paused) with bids adjusted → restore', () => {
    expect(bidAction({ inWindow: false, effMult: null, hasBase: true, appliedMult: 50 })).toBe('exit')
  })

  it('EXIT: entered a Normal (no-multiplier) window with bids adjusted → restore', () => {
    expect(bidAction({ inWindow: true, effMult: null, hasBase: true, appliedMult: 50 })).toBe('exit')
  })

  it('NONE: Normal window with no prior adjustment', () => {
    expect(bidAction({ inWindow: true, effMult: null, hasBase: false, appliedMult: null })).toBe('none')
    // paused with nothing applied
    expect(bidAction({ inWindow: false, effMult: null, hasBase: false, appliedMult: null })).toBe('none')
  })

  it('a full day walk: Normal → +50 → +100 → Pause applies enter, transition, exit', () => {
    // 02:00 Normal, nothing applied
    expect(bidAction({ inWindow: true, effMult: null, hasBase: false, appliedMult: null })).toBe('none')
    // 17:00 enter +50
    expect(bidAction({ inWindow: true, effMult: 50, hasBase: false, appliedMult: null })).toBe('enter')
    // 20:00 transition +50 → +100 (the core fix — two real multiplier windows)
    expect(bidAction({ inWindow: true, effMult: 100, hasBase: true, appliedMult: 50 })).toBe('transition')
    // 23:00 pause → exit
    expect(bidAction({ inWindow: false, effMult: null, hasBase: true, appliedMult: 100 })).toBe('exit')
  })
})
