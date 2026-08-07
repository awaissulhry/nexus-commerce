/**
 * NAF.SB.W — the counting invariant, asserted.
 *
 * Twice now a feature touching the row set has produced a chip whose number
 * disagreed with the rows it revealed. Both times the cause was the same:
 * counting with `rows.length` instead of the view predicate. This makes the
 * next occurrence a failing test rather than something someone notices in a
 * screenshot.
 */
import { describe, expect, it } from 'vitest'
import { countIn, matchesView, type View, type ViewableWorker } from './views'

const ALL_VIEWS: View[] = ['all', 'live', 'attention', 'eligible', 'retired']

const w = (over: Partial<{
  enabled: boolean; autonomyLevel: string; retired: boolean
  word: string; needsAttention: boolean; promotionEligible: boolean
}> = {}): ViewableWorker => ({
  charter: {
    enabled: over.enabled ?? false,
    autonomyLevel: over.autonomyLevel ?? 'OFF',
    retired: over.retired ?? false,
  },
  status: { word: over.word ?? 'off', needsAttention: over.needsAttention ?? false },
  promotionEligible: over.promotionEligible ?? false,
})

/** A roster with one of everything the fleet can currently be. */
const ROSTER: ViewableWorker[] = [
  w(),                                                             // off
  w({ enabled: true, autonomyLevel: 'OBSERVE', word: 'working' }), // live
  w({ enabled: true, autonomyLevel: 'PROPOSE', word: 'paused', needsAttention: true }), // paused
  w({ enabled: true, autonomyLevel: 'OBSERVE', word: 'attention', needsAttention: true }), // failing
  w({ word: 'not-set-up', needsAttention: true }),                 // never seeded
  w({ enabled: true, autonomyLevel: 'OBSERVE', word: 'working', promotionEligible: true }),
  w({ retired: true }),                                            // retired
]

describe('the counting invariant', () => {
  it('countIn equals the number of rows the view actually shows — for every view', () => {
    for (const v of ALL_VIEWS) {
      const shown = ROSTER.filter((r) => matchesView(r, v))
      expect(countIn(ROSTER, v), `view "${v}"`).toBe(shown.length)
    }
  })

  it('every worker appears in exactly one of {all, retired} — none is lost, none double-counted', () => {
    expect(countIn(ROSTER, 'all') + countIn(ROSTER, 'retired')).toBe(ROSTER.length)
  })

  it('rows.length is NOT a correct count for "all" once anything is retired', () => {
    // The exact defect: "All 3" over two visible rows.
    expect(countIn(ROSTER, 'all')).toBeLessThan(ROSTER.length)
  })
})

describe('what each view means', () => {
  it('a retired worker appears ONLY under retired', () => {
    const r = w({ retired: true, enabled: true, autonomyLevel: 'OBSERVE', needsAttention: true, promotionEligible: true })
    for (const v of ALL_VIEWS) {
      expect(matchesView(r, v), `view "${v}"`).toBe(v === 'retired')
    }
  })

  it('a live worker is enabled, above OFF, and not paused', () => {
    expect(matchesView(w({ enabled: true, autonomyLevel: 'OBSERVE', word: 'working' }), 'live')).toBe(true)
    expect(matchesView(w({ enabled: false, autonomyLevel: 'OBSERVE' }), 'live')).toBe(false)
    expect(matchesView(w({ enabled: true, autonomyLevel: 'OFF' }), 'live')).toBe(false)
    // paused is the one a naive `enabled && !== OFF` gets wrong
    expect(matchesView(w({ enabled: true, autonomyLevel: 'PROPOSE', word: 'paused' }), 'live')).toBe(false)
  })

  it('attention follows the shared status derivation, not a local guess', () => {
    expect(matchesView(w({ needsAttention: true }), 'attention')).toBe(true)
    expect(matchesView(w({ needsAttention: false }), 'attention')).toBe(false)
  })

  it('an empty roster counts zero in every view rather than throwing', () => {
    for (const v of ALL_VIEWS) expect(countIn([], v)).toBe(0)
  })
})
