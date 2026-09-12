/**
 * PES.1 — the collapsing header's arming rule (v2 spec §4.2).
 *
 * Written because the rule was exported with the comment "exported for test" and no test existed —
 * FE.1's scan found two files, neither a test, and zero references. The hook now CALLS these, so
 * there is one definition and this is the thing that runs in the browser, not a parallel copy.
 *
 * Defaults under test: `C` (freed by collapsing) = 16, `T` (threshold) = 32, so armed needs an
 * expanded range of at least 48.
 */

import { describe, expect, it } from 'vitest'

import { collapseIsArmed,
  collapseSurvivesReplacement, expandedScrollRange } from './useHeaderCollapse'

describe('the arming rule', () => {
  it('needs the range to survive the collapse, not merely to exist', () => {
    // 47 would let it collapse and then leave 31 — below the threshold that caused the collapse.
    expect(collapseIsArmed(47)).toBe(false)
    expect(collapseIsArmed(48)).toBe(true)
  })

  it('refuses a sheet with no scroll at all', () => {
    expect(collapseIsArmed(0)).toBe(false)
  })

  it('🔴 the boundary is where the oscillation would start', () => {
    // At exactly 48: collapse frees 16, leaving 32 — still exactly the threshold, so the scroll
    // position that caused the collapse is still reachable and it stays collapsed. One pixel less
    // and it could not, which is the loop.
    expect(48 - 16).toBe(32)
    expect(collapseIsArmed(48)).toBe(true)
    expect(collapseIsArmed(47)).toBe(false)
  })

  it('holds for the real measurements taken on GALE-JACKET', () => {
    expect(collapseIsArmed(36)).toBe(false)   // v2 at 28px rows — never collapses, correctly
    expect(collapseIsArmed(92)).toBe(true)    // before the AppTopBar was dropped
    expect(collapseIsArmed(204)).toBe(true)   // after the 36px row landed
  })
})

describe('the expanded-geometry rule', () => {
  it('is the identity while expanded', () => {
    expect(expandedScrollRange(100, false)).toBe(100)
  })

  it('🔴 adds back what collapsing freed, so the test never reads its own effect', () => {
    // This is the whole invariant. Collapsing shrinks the range by C; measuring the shrunken range
    // and re-deciding from it is the loop — collapse, lose the range, expand, regain it, collapse.
    expect(expandedScrollRange(100, true)).toBe(116)
  })

  it('keeps a marginal case armed once collapsed, instead of flapping', () => {
    const expandedR = 50
    expect(collapseIsArmed(expandedR)).toBe(true)
    const collapsedR = expandedR - 16              // what the DOM now reports
    expect(collapseIsArmed(collapsedR)).toBe(false)          // ← naive recompute would DISARM
    expect(collapseIsArmed(expandedScrollRange(collapsedR, true))).toBe(true)  // ← correct
  })
})

describe('collapseSurvivesReplacement — hub #549, the ONE question a scroller swap asks', () => {
  it('lets a collapsed header survive a sheet that can still sustain it', () => {
    // 135px was the real range on GALE-JACKET/Master. Collapsed, so the expanded range is 151;
    // 151 - 16 = 135 >= 32. Nothing moves, which is §3.5a's whole point.
    expect(collapseSurvivesReplacement(135, true)).toBe(true)
  })

  it('expands when the new sheet cannot scroll far enough to sustain the collapse', () => {
    // The exception. Staying collapsed here is not conservative, it is unreachable: there is no
    // scroll gesture available that could ever get the header back, so it would hide content for
    // no reason.
    expect(collapseSurvivesReplacement(0, true)).toBe(false)
    expect(collapseSurvivesReplacement(20, true)).toBe(false)
  })

  it('measures against EXPANDED geometry, so the answer does not depend on the current state', () => {
    /*
     * The oscillation trap in one assertion. A range of 40 read while COLLAPSED means the expanded
     * range is 56 (the collapse gave back 16), and 56 - 16 = 40 >= 32 → survives. Reading the same
     * 40 as if expanded gives 40 - 16 = 24 < 32 → expand, the header pops open, the range returns
     * to 56, it re-arms, and it collapses again. Same number, opposite answers.
     */
    expect(collapseSurvivesReplacement(40, true)).toBe(true)
    expect(collapseSurvivesReplacement(40, false)).toBe(false)
  })

  it('is the boundary at exactly R - C === T', () => {
    expect(collapseSurvivesReplacement(48, false)).toBe(true)
    expect(collapseSurvivesReplacement(47, false)).toBe(false)
  })
})
