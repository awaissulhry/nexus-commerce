import { describe, expect, it } from 'vitest'
import { HOLD_LIMITS } from '../holds/rules'
import { holdChunks, incomingHoldNote, notAcceptedOf } from './held'

/** B-W2b-GF5 (G367, G369): the hides an incoming inspection did not accept, worked by hand. */

const lot = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'h7']
const sample = [
  { hideId: 'h1', decision: 'ACCEPTED' },
  { hideId: 'h2', decision: 'REJECTED' },
  { hideId: 'h3', decision: 'TO_SORT' },
]

describe('the hides an incoming inspection did not accept (G367)', () => {
  it('names the sample’s rejected and to-sort hides; nothing outside the sample when every unit outside it is accepted', () => {
    expect(notAcceptedOf({ results: sample, lotHideIds: lot, rejected: '1', toSort: '1' })).toEqual({ sampled: ['h2', 'h3'], outside: [] })
  })

  it('holds every hide outside the sample when units outside it were not accepted (they are not told apart)', () => {
    // 7 hides, sample of 3: 1 accepted, 1 rejected, 1 to sort; the 4 outside to sort → 1 accepted, 1 rejected, 5 to sort.
    expect(notAcceptedOf({ results: sample, lotHideIds: lot, rejected: '1.0000', toSort: '5.0000' })).toEqual({ sampled: ['h2', 'h3'], outside: ['h4', 'h5', 'h6', 'h7'] })
    // A mixed split outside the sample (2 of the 4 accepted, 2 to sort): all 4 are held; quality releases the good ones.
    expect(notAcceptedOf({ results: sample, lotHideIds: lot, rejected: '1', toSort: '3' }).outside).toEqual(['h4', 'h5', 'h6', 'h7'])
  })

  it('a whole lot accepted holds nothing; undecided results count as nothing held', () => {
    expect(notAcceptedOf({ results: [{ hideId: 'h1', decision: 'ACCEPTED' }], lotHideIds: lot, rejected: '0', toSort: '0' })).toEqual({ sampled: [], outside: [] })
    expect(notAcceptedOf({ results: [{ hideId: 'h1', decision: null }], lotHideIds: ['h1'], rejected: '0', toSort: '0' })).toEqual({ sampled: [], outside: [] })
  })

  it('says the hold in words within the hold’s limit; a large set goes in holds of at most the limit', () => {
    expect(incomingHoldNote('IIN-2026-0002', ['H02', 'H05'])).toBe('Incoming inspection IIN-2026-0002: H02, H05 not accepted (rejected or to sort), held until quality decides.')
    const codes = Array.from({ length: 250 }, (_, index) => `LA-000101-H${String(index + 1).padStart(3, '0')}`)
    expect(incomingHoldNote('IIN-2026-0002', codes).length).toBeLessThanOrEqual(HOLD_LIMITS.reasonNote)
    expect(incomingHoldNote('IIN-2026-0002', codes)).toContain('and 230 more')
    expect(holdChunks(codes).map((chunk) => chunk.length)).toEqual([100, 100, 50])
  })
})
