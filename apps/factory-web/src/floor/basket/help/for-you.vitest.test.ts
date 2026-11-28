import { describe, expect, it } from 'vitest'
// fl5's device seen-state (settle 12; web A, F/basket/home/seen.ts): ONE store for the home's For you, no second copy here.
// This file needs owb-fl5 on main (it lands before owb-fl8).
import { seenKeyOf, unseenForYou } from '../home/seen'

/**
 * owb-fl8 step 2 — "An answer for you" stands on the home's For you ONCE: the server returns the item while the answer is new; this
 * phone hides it after it was shown (a key per item, on the device only: no read record of a worker, Statuto art. 4).
 */
describe('owb-fl8 — the answer shows on For you once (device seen-state)', () => {
  const answer = { kind: 'ANSWER', bundleId: 'bundle-0431', code: 'B-0431', words: 'Use the logo of the 2026 file.', at: '2026-11-28T09:00:00.000Z' }
  const problem = { kind: 'PROBLEM', bundleId: 'bundle-0412', code: 'B-0412', words: 'Material missing', at: '2026-11-28T09:01:00.000Z' }

  it('shows a new answer, then hides it once its key is seen on this phone', () => {
    expect(unseenForYou([answer, problem], [])).toEqual([answer, problem])
    const seen = [seenKeyOf(answer)]
    expect(unseenForYou([answer, problem], seen)).toEqual([problem])
  })

  it('shows a later answer to the same basket again (a new item, a new key)', () => {
    const later = { ...answer, words: 'Patch on the left sleeve.', at: '2026-11-28T11:00:00.000Z' }
    expect(seenKeyOf(later)).not.toBe(seenKeyOf(answer))
    expect(unseenForYou([later], [seenKeyOf(answer)])).toEqual([later])
  })
})
