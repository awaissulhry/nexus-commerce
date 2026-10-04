import { describe, expect, it } from 'vitest'
import { keptServingWords, parseWriteProjections, writesBreakdownWords, writesCell, writesExplained, writesPerDayWords, type WriteProjection } from './writeProjection'

const p = (o: Partial<WriteProjection> = {}): WriteProjection => ({
  perDay: 24, perWeek: 168, byKind: { restore: 70, suppress: 70, placement: 28, base: 0 }, keptServing: 0, campaigns: 3, ...o,
})

describe('2c writeProjection — about how many changes a day a plan sends to Amazon', () => {
  it('reads the endpoint and leaves out what it cannot read', () => {
    expect(parseWriteProjections({ items: { g1: p(), bad: { perWeek: 3 }, nul: null } })).toEqual({ g1: p() })
    expect(parseWriteProjections({ items: { g1: { perDay: 2 } } }).g1).toEqual({ perDay: 2, perWeek: 0, keptServing: 0, campaigns: 0, byKind: { restore: 0, suppress: 0, placement: 0, base: 0 } })
    expect(parseWriteProjections(null)).toEqual({})
  })

  it('says "about" and the number, or that a flat plan sends nothing once set', () => {
    expect(writesPerDayWords(p())).toBe('about 24 changes a day sent to Amazon')
    expect(writesPerDayWords(p({ perDay: 1 }))).toBe('about 1 change a day sent to Amazon')
    expect(writesPerDayWords(p({ perDay: 0, perWeek: 3 }))).toBe('fewer than one change a day sent to Amazon')
    expect(writesPerDayWords(p({ perDay: 0, perWeek: 0 }))).toBe('no changes sent to Amazon once each hour’s values are set')
    expect([writesCell(p()), writesCell(p({ perDay: 1200, perWeek: 8400 })), writesCell(p({ perDay: 0, perWeek: 3 })), writesCell(p({ perDay: 0, perWeek: 0 }))]).toEqual(['about 24', 'about 1,200', 'under 1', 'none'])
  })

  it('names what the changes are, a day', () => {
    expect(writesBreakdownWords(p())).toBe('20 bid floors and give-backs, 4 placement changes')
    expect(writesBreakdownWords(p({ byKind: { restore: 0, suppress: 0, placement: 7, base: 14 } }))).toBe('1 placement change, 2 base-bid changes')
  })

  it('explains the estimate, and the Min-bid hours that keep serving when there are any', () => {
    expect(keptServingWords(p())).toBeNull()
    expect(writesExplained(p())).toBe('About 24 changes a day sent to Amazon across 3 campaigns (20 bid floors and give-backs, 4 placement changes). Each switch into or out of Min bid moves every bid in a campaign; each placement change is one change. Counted from the painted hours: a bid already at the floor does not move, so the real number can be lower.')
    expect(writesExplained(p({ perDay: 0, perWeek: 0 }))).toMatch(/^Once each hour’s values are set, this plan sends no changes to Amazon\. /)
    expect(writesExplained(p({ keptServing: 14 }))).toContain('A campaign is floored at most twice a day, so 14 of those hours a week keep serving.')
  })
})
