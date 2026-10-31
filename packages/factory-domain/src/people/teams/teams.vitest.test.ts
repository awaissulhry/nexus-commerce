import { describe, expect, it } from 'vitest'
import { areaProblems, dayBefore, endLoanRefusal, loanProblems, loanStateOf, loansOverlap, movePlan, orgTreeOf, teamProblems } from './rules'

const at = (iso: string) => new Date(iso)

describe('teams and leads (MES-210, PLT-020)', () => {
  it('a team code is capitals without spaces (typed any case), a name is required', () => {
    expect(teamProblems({ code: 'l1-a', name: 'Line 1' })).toEqual([])
    expect(teamProblems({ code: 'L1 A', name: ' ' }).map((problem) => problem.path)).toEqual(['code', 'name'])
  })

  it('a move ends the old membership yesterday and starts the new one today; one begun today is removed', () => {
    const today = '2026-10-31'
    expect(movePlan({ id: 'm', teamId: 'a', isLead: false, since: '2026-01-01' }, 'a', today)).toEqual({ kind: 'NONE' })
    expect(movePlan({ id: 'm', teamId: 'a', isLead: true, since: '2026-01-01' }, 'b', today)).toEqual({ kind: 'MOVE', end: { id: 'm', until: '2026-10-30' }, remove: null, start: { teamId: 'b', since: today }, wasLead: true })
    expect(movePlan({ id: 'm', teamId: 'a', isLead: false, since: today }, 'b', today)).toEqual({ kind: 'MOVE', end: null, remove: 'm', start: { teamId: 'b', since: today }, wasLead: false })
    expect(movePlan(null, 'b', today)).toEqual({ kind: 'MOVE', end: null, remove: null, start: { teamId: 'b', since: today }, wasLead: false })
    expect(movePlan({ id: 'm', teamId: 'a', isLead: false, since: '2026-01-01' }, null, today)).toMatchObject({ kind: 'MOVE', start: null, end: { until: '2026-10-30' } })
    expect(dayBefore('2027-01-01')).toBe('2026-12-31')
  })
})

describe('loans to another line (MES-210)', () => {
  const loan = { startsAt: at('2026-11-03T07:00:00Z'), endsAt: at('2026-11-03T11:00:00Z') }

  it('a loan has a reason, ends after it starts, lasts at most 31 days and goes to another line', () => {
    expect(loanProblems({ ...loan, reason: 'Peak on line 2', fromLineId: 'l1', toLineId: 'l2' })).toEqual([])
    expect(loanProblems({ startsAt: loan.endsAt, endsAt: loan.startsAt, reason: ' ', fromLineId: 'l1', toLineId: 'l1' }).map((problem) => problem.path)).toEqual(['endsAt', 'reason', 'toLineId'])
    expect(loanProblems({ startsAt: at('2026-11-01T00:00:00Z'), endsAt: at('2026-12-05T00:00:00Z'), reason: 'x', fromLineId: null, toLineId: 'l2' }).map((problem) => problem.path)).toEqual(['endsAt'])
  })

  it('states, overlap (half-open) and ending early', () => {
    expect(loanStateOf(loan, at('2026-11-03T06:59:59Z'))).toBe('PLANNED')
    expect(loanStateOf(loan, at('2026-11-03T08:00:00Z'))).toBe('RUNNING')
    expect(loanStateOf(loan, at('2026-11-03T11:00:00Z'))).toBe('ENDED')
    expect(loansOverlap(loan, { startsAt: at('2026-11-03T11:00:00Z'), endsAt: at('2026-11-03T12:00:00Z') })).toBe(false)
    expect(loansOverlap(loan, { startsAt: at('2026-11-03T10:00:00Z'), endsAt: at('2026-11-03T12:00:00Z') })).toBe(true)
    expect(endLoanRefusal(loan, at('2026-11-03T09:00:00Z'), at('2026-11-03T08:00:00Z'))).toBeNull()
    expect(endLoanRefusal(loan, at('2026-11-03T09:00:00Z'), at('2026-11-03T06:00:00Z'))).toContain('remove it instead')
    expect(endLoanRefusal(loan, at('2026-11-03T12:00:00Z'), at('2026-11-03T08:00:00Z'))).toContain('before the planned end')
  })
})

describe('the org tree: site › area › line › station (PLT-005)', () => {
  it('an area code and order', () => {
    expect(areaProblems({ code: 'sew-hall', name: 'Sewing hall', sortOrder: 1 })).toEqual([])
    expect(areaProblems({ sortOrder: -1 }).map((problem) => problem.path)).toEqual(['sortOrder'])
  })

  it('areas in their order, lines by code, stations and teams under their line, the rest apart', () => {
    const tree = orgTreeOf({
      sites: [{ id: 's', code: 'A1', name: 'Plant', companyId: 'c', status: 'ACTIVE' }],
      areas: [
        { id: 'cut', siteId: 's', code: 'CUT', name: 'Cutting', sortOrder: 2, status: 'ACTIVE', version: 1 },
        { id: 'sew', siteId: 's', code: 'SEW', name: 'Sewing', sortOrder: 1, status: 'ACTIVE', version: 1 },
      ],
      lines: [
        { id: 'l2', siteId: 's', areaId: 'sew', code: 'L2', name: 'Line 2', status: 'ACTIVE', version: 1 },
        { id: 'l1', siteId: 's', areaId: 'sew', code: 'L1', name: 'Line 1', status: 'ACTIVE', version: 1 },
        { id: 'l3', siteId: 's', areaId: null, code: 'L3', name: 'Line 3', status: 'ACTIVE', version: 1 },
      ],
      stations: [
        { id: 'st1', siteId: 's', lineId: 'l1', code: 'SEW-01', name: 'Sew 1', status: 'ACTIVE' },
        { id: 'st2', siteId: 's', lineId: null, code: 'PACK-01', name: 'Pack', status: 'ACTIVE' },
      ],
      teams: [{ id: 't', siteId: 's', lineId: 'l1', code: 'L1-A', name: 'Team', members: 3 }],
    })
    expect(tree[0]!.areas.map((area) => [area.code, area.lines.map((line) => line.code)])).toEqual([['SEW', ['L1', 'L2']], ['CUT', []]])
    expect(tree[0]!.areas[0]!.lines[0]!.stations.map((station) => station.code)).toEqual(['SEW-01'])
    expect(tree[0]!.areas[0]!.lines[0]!.teams.map((team) => team.code)).toEqual(['L1-A'])
    expect(tree[0]!.linesWithoutArea.map((line) => line.code)).toEqual(['L3'])
    expect(tree[0]!.stationsWithoutLine.map((station) => station.code)).toEqual(['PACK-01'])
  })
})
