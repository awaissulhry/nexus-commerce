/**
 * #43 / #727 — the readiness pill's COLOUR comes from the STATE, never from the percentage.
 *
 * These four state cases came from PES.3's `aliasBarTone` and move here with the function, so the
 * rule keeps its tests rather than losing them to a deletion. The two percentage cases are the
 * regression: the first version of `CompletenessPill` computed `100 → full, <40 → low` from `pct`,
 * and on Amazon·DE an alias in state `errors` at 84% painted neutral grey while the pill's own
 * aria-label said "Error".
 */
import { describe, expect, it } from 'vitest'

import { readyPillTone, ROW_READINESS_STATES } from './readiness'

describe('readyPillTone — state, not percentage', () => {
  it('ready is success', () => {
    expect(readyPillTone('ready')).toBe('success')
  })
  it('errors is danger', () => {
    expect(readyPillTone('errors')).toBe('danger')
  })
  it('🔴 no state is NEUTRAL and does not guess', () => {
    // Master completeness is a ratio with no readiness behind it. Inventing a colour for it would
    // be the same invention #43 forbids in the other direction.
    expect(readyPillTone(null)).toBe('neutral')
    expect(readyPillTone(undefined)).toBe('neutral')
  })
  it('every row state in the vocabulary maps to a tone — none falls through', () => {
    for (const s of ROW_READINESS_STATES) {
      expect(readyPillTone(s)).toBeTruthy()
    }
  })

  /*
   * The two the regression would fail. They are about the ABSENCE of a percentage input: the
   * function cannot see one, which is the fix — a signature that cannot take a ratio cannot colour
   * by it. PES.3's scope had exactly this shape (`aliasBarTone(state)`) and was correct because of
   * it; the pill lost the property by computing its own tone inside the component.
   */
  it('🔴 `errors` is danger whatever the percentage would have suggested — 100% is NOT green', () => {
    expect(readyPillTone('errors')).not.toBe('success')
  })
  it('🔴 `ready` is success whatever the percentage would have suggested — 40% is NOT a warning', () => {
    expect(readyPillTone('ready')).not.toBe('warning')
  })
})
