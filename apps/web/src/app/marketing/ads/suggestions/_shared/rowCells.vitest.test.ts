/**
 * 4i (review 4.7) — a Placement rule runs on the budget trigger by design (PLC-P7), so its proposals' signal read
 * "Budget performance". The suggestion's family (the server's one map) names it instead.
 */
import { describe, expect, it } from 'vitest'
import { prettyTrigger, weeklyVolume } from './rowCells'

describe('prettyTrigger — the Signal and Reason fallback', () => {
  it('🔴 a placement proposal on the budget trigger reads "Placement performance"', () => {
    expect(prettyTrigger('CAMPAIGN_PERFORMANCE_BUDGET', 'placement')).toBe('Placement performance')
  })

  it('a budget proposal on the same trigger, or one with no family, keeps the trigger\'s own words', () => {
    expect(prettyTrigger('CAMPAIGN_PERFORMANCE_BUDGET', 'budget')).toBe('Budget performance')
    expect(prettyTrigger('CAMPAIGN_PERFORMANCE_BUDGET')).toBe('Budget performance')
    expect(prettyTrigger('KEYWORD_HIGH_ACOS', 'placement')).toBe('High ACoS keyword')
    expect(prettyTrigger(null, 'placement')).toBe('Rule match')
  })
})

describe('weeklyVolume — search volume is one Brand Analytics week, and says which (F4)', () => {
  it('pairs the searches with the week they cover', () => {
    expect(weeklyVolume({ volume: 1200, searchVolumeWeekStart: '2026-10-04' })).toEqual({ volume: 1200, week: '4 Oct 2026' })
    expect(weeklyVolume({ searchVolume: 80, searchVolumeWeekStart: '2026-10-04' })).toEqual({ volume: 80, week: '4 Oct 2026' })
  })
  it('shows nothing when the volume or its week is missing — never a 0, never an unknown period as weekly', () => {
    expect(weeklyVolume({ volume: null, searchVolumeWeekStart: '2026-10-04' })).toBeNull()
    expect(weeklyVolume({ volume: 1200, searchVolumeWeekStart: null })).toBeNull()
    expect(weeklyVolume({ volume: 1200 })).toBeNull()
    expect(weeklyVolume({ volume: 1200, searchVolumeWeekStart: 'last week' })).toBeNull()
  })
  it('keeps a real zero', () => {
    expect(weeklyVolume({ volume: 0, searchVolumeWeekStart: '2026-10-04' })).toEqual({ volume: 0, week: '4 Oct 2026' })
  })
  it('names the Keyword Tracker signal by what it reads', () => {
    expect(prettyTrigger('KEYWORD_RANK_BID')).toBe('Keyword Tracker (search volume)')
  })
})
