import { describe, expect, it } from 'vitest'
import { evenShares, isOverLimit, orderTeamMode, suggestTeam, teamMarks, teamRowsProblems, type TeamRowIn } from './rules'

/** owb-ss5 step 5.1: the pure rules of an order's teams (written, not run in the build: Owner rule, checks at the end). */

const row = (teamId: string, inCharge: boolean, basketShare: number | null = null): TeamRowIn => ({ teamId, inCharge, basketShare })
const facts = (extra: Partial<{ plannedBaskets: number; printed: boolean; current: TeamRowIn[] }> = {}) => ({ plannedBaskets: 12, printed: false, current: [], ...extra })

describe('the mode of an order’s teams', () => {
  it('none, one, together, split', () => {
    expect(orderTeamMode([])).toBe('NONE')
    expect(orderTeamMode([row('a', true)])).toBe('ONE')
    expect(orderTeamMode([row('a', true), row('b', false)])).toBe('TOGETHER')
    expect(orderTeamMode([row('a', true, 7), row('b', false, 5)])).toBe('SPLIT')
  })
})

describe('teamRowsProblems', () => {
  it('a team once, exactly one in charge (none at all is fine: no team yet)', () => {
    expect(teamRowsProblems([], facts())).toEqual([])
    expect(teamRowsProblems([row('a', true), row('a', false)], facts())).toContain('TEAM_TWICE')
    expect(teamRowsProblems([row('a', false), row('b', false)], facts())).toContain('ONE_IN_CHARGE')
    expect(teamRowsProblems([row('a', true), row('b', true)], facts())).toContain('ONE_IN_CHARGE')
    expect(teamRowsProblems([row('a', true), row('b', false)], facts())).toEqual([])
  })

  it('a split: shares of 1 or more, every team its share, and they add up to the order’s baskets', () => {
    expect(teamRowsProblems([row('a', true, 7), row('b', false, 5)], facts())).toEqual([])
    expect(teamRowsProblems([row('a', true, 12), row('b', false, 0)], facts())).toContain('SHARE_TOO_SMALL')
    expect(teamRowsProblems([row('a', true, 7), row('b', false)], facts())).toContain('SHARE_MISSING')
    expect(teamRowsProblems([row('a', true, 7), row('b', false, 4)], facts())).toContain('SHARES_DO_NOT_ADD_UP')
    // Before any basket is planned the sum is not checked.
    expect(teamRowsProblems([row('a', true, 7), row('b', false, 4)], facts({ plannedBaskets: 0 }))).toEqual([])
  })

  it('after the first print the shares stay: only together rows are added or taken off', () => {
    const current = [row('a', true, 7), row('b', false, 5)]
    expect(teamRowsProblems([...current, row('c', false)], facts({ printed: true, current }))).toEqual([])
    expect(teamRowsProblems([row('a', true, 6), row('b', false, 6)], facts({ printed: true, current }))).toContain('SHARES_FIXED')
    expect(teamRowsProblems([row('a', true, 12)], facts({ printed: true, current }))).toContain('SHARES_FIXED')
    const together = [row('a', true), row('b', false)]
    expect(teamRowsProblems([row('a', true)], facts({ printed: true, current: together }))).toEqual([])
    expect(teamRowsProblems([row('a', true, 6), row('b', false, 6)], facts({ printed: true, current: together }))).toContain('SHARES_FIXED')
  })

  it('at most 20 teams', () => {
    const many = Array.from({ length: 21 }, (_, index) => row(`t${index}`, index === 0))
    expect(teamRowsProblems(many, facts())).toContain('TOO_MANY_TEAMS')
  })
})

describe('evenShares', () => {
  it('12 baskets between 5 teams: 3, 3, 2, 2, 2 (they add up)', () => {
    expect(evenShares(12, 5)).toEqual([3, 3, 2, 2, 2])
    expect(evenShares(12, 5).reduce((sum, share) => sum + share, 0)).toBe(12)
    expect(evenShares(10, 2)).toEqual([5, 5])
    expect(evenShares(3, 0)).toEqual([])
  })
})

describe('teamMarks', () => {
  it('over its limit, takes no new order, missing today, late — and nothing from an unknown figure', () => {
    expect(teamMarks({ inWork: 9, maxBaskets: 8, takesNewOrders: false, missingToday: 2, late: 1 })).toEqual(['OVER_LIMIT', 'NO_NEW_ORDERS', 'MISSING_TODAY:2', 'LATE:1'])
    expect(teamMarks({ inWork: 8, maxBaskets: 8, takesNewOrders: true, missingToday: 0, late: 0 })).toEqual([])
    // A team smaller than the smallest group: its figures are null, so it carries no figure mark.
    expect(teamMarks({ inWork: null, maxBaskets: 1, takesNewOrders: true, missingToday: null, late: null })).toEqual([])
    expect(isOverLimit({ inWork: 3, maxBaskets: null })).toBe(false)
  })
})

describe('suggestTeam', () => {
  it('the team that worked for this customer most recently, never one that takes no new order', () => {
    expect(suggestTeam([])).toBeNull()
    expect(
      suggestTeam([
        { teamId: 'a', at: '2026-10-01T08:00:00.000Z', takesNewOrders: true },
        { teamId: 'b', at: '2026-11-01T08:00:00.000Z', takesNewOrders: true },
        { teamId: 'a', at: '2026-09-01T08:00:00.000Z', takesNewOrders: true },
      ]),
    ).toBe('b')
    expect(suggestTeam([{ teamId: 'b', at: '2026-11-01T08:00:00.000Z', takesNewOrders: false }, { teamId: 'a', at: '2026-10-01T08:00:00.000Z', takesNewOrders: true }])).toBe('a')
    expect(suggestTeam([{ teamId: 'b', at: '2026-11-01T08:00:00.000Z', takesNewOrders: false }])).toBeNull()
  })
})
