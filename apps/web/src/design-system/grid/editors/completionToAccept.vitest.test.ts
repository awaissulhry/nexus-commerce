import { describe, expect, it } from 'vitest'

import { completionToAccept } from './formulaEditing'

/**
 * The point of this file is the FIRST test: it fails if `completionToAccept` indexes the array it
 * was passed instead of the list the panel draws. PES.4 asked for exactly that pin after measuring
 * the same hazard on the drawer's copy, and it is the only assertion here that a plausible wrong
 * implementation still passes today — on a short, already-ordered list the two agree.
 */
describe('completionToAccept', () => {
  it('takes the highlighted row from the SHOWN order, not the passed order', () => {
    // The panel re-ranks and regroups: `shown` is deliberately a different order from `passed`.
    const passed = ['a', 'b', 'c'] as const
    const shown = ['c', 'a', 'b'] as const
    // Mutating the implementation to `passed[active]` returns 'b' and fails here.
    expect(completionToAccept(shown, passed, 1)).toBe('a')
    expect(completionToAccept(shown, passed, 0)).toBe('c')
    expect(completionToAccept(shown, passed, 2)).toBe('b')
  })

  it('falls back to the first SHOWN row when the index is past the end', () => {
    expect(completionToAccept(['x', 'y'], ['y', 'x'], 9)).toBe('x')
  })

  it('falls back to the passed list only while the panel has not reported yet', () => {
    // The first Tab after the list opens: `onMatchesChange` lands one effect later.
    expect(completionToAccept([], ['p', 'q'], 0)).toBe('p')
  })

  it('returns null rather than guessing when there is nothing to accept', () => {
    expect(completionToAccept([], [], 0)).toBeNull()
    expect(completionToAccept([], [], 3)).toBeNull()
  })

  it('does not treat a legitimately falsy entry as absent', () => {
    // `??` not `||` — an empty-string option is a real row, and `||` would skip to the fallback.
    expect(completionToAccept([''], ['zzz'], 0)).toBe('')
  })
})
