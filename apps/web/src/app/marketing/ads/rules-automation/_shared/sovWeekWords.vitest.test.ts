/**
 * Free visibility numbers (2026-10-10, integration) — a Share of Voice market refused as too old is never said as
 * "no complete week": the strip and the rule preview say the week's real age (since it ended) and the limit.
 */
import { describe, expect, it } from 'vitest'
import { refusedSovMarkets, tooOldWords } from './sovWeekWords'

describe('refusedSovMarkets', () => {
  it('splits the refused markets by the gate\'s reason; a read market is in neither', () => {
    const out = refusedSovMarkets([
      { marketplace: 'IT', refused: false, reason: 'complete' },
      { marketplace: 'DE', refused: true, reason: 'incomplete-week' },
      { marketplace: 'ES', refused: true, reason: 'no-data' },
      { marketplace: 'FR', refused: true, reason: 'too-old', weekEndAgeDays: 20, maxAgeDays: 14 },
    ])
    expect(out.incomplete).toEqual(['DE', 'ES'])
    expect(out.tooOld).toEqual([{ marketplace: 'FR', words: 'newest complete week ended 20 days ago (limit 14 days)' }])
  })
  it('an older payload without a reason stays "no complete week" (what it meant then)', () => {
    expect(refusedSovMarkets([{ marketplace: 'DE', refused: true }])).toEqual({ incomplete: ['DE'], tooOld: [] })
  })
})

describe('tooOldWords', () => {
  it('falls back to the gate\'s own note (without the market prefix), never to "no complete week"', () => {
    expect(tooOldWords({ marketplace: 'FR', refused: true, reason: 'too-old', note: 'FR: the newest complete Brand Analytics week (week of 2026-09-06) ended 20 days ago; shares older than 14 days are not used' }))
      .toBe('the newest complete Brand Analytics week (week of 2026-09-06) ended 20 days ago; shares older than 14 days are not used')
    expect(tooOldWords({ marketplace: 'FR', refused: true, reason: 'too-old' })).toBe('newest complete week is older than the age limit')
    expect(tooOldWords({ marketplace: 'FR', refused: true, reason: 'too-old', weekEndAgeDays: 1, maxAgeDays: 0 })).toBe('newest complete week ended 1 day ago (limit 0 days)')
  })
})
