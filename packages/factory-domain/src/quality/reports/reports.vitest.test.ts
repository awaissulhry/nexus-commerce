import { describe, expect, it } from 'vitest'
import { QUALITY_REPORTS_PERMISSIONS, QUALITY_REPORTS_VIEW } from './permissions'
import {
  averageDays,
  changeOf,
  daysOf,
  doneOnTime,
  fpyOf,
  headcountOf,
  heldAt,
  oldHoldAt,
  openAt,
  operationKeyOf,
  passRateOf,
  pct,
  peopleShown,
  periodOf,
  periodProblems,
  previousOf,
  quarantineDaysOf,
  rowFigures,
  spanOf,
  unitsInspectedOf,
  weeksOf,
  type Tally,
} from './rules'

const at = (iso: string) => new Date(iso)

describe('quality reports: the period', () => {
  it('defaults to the 30 days up to today; a lone end starts 29 days before it', () => {
    expect(periodOf({}, '2026-11-03')).toEqual({ from: '2026-10-05', to: '2026-11-03' })
    expect(periodOf({ to: '2026-10-31' }, '2026-11-03')).toEqual({ from: '2026-10-02', to: '2026-10-31' })
    expect(periodOf({ from: '2026-10-01' }, '2026-11-03')).toEqual({ from: '2026-10-01', to: '2026-11-03' })
    expect(daysOf(periodOf({}, '2026-11-03'))).toBe(30)
  })

  it('refuses an end before the start, after today, or more than 366 days, in words', () => {
    expect(periodProblems({ from: '2026-10-01', to: '2026-10-31' }, '2026-11-03')).toEqual([])
    expect(periodProblems({ from: '2026-10-10', to: '2026-10-01' }, '2026-11-03')[0]).toMatchObject({ path: 'querystring/to', message: 'The period ends before it starts.' })
    expect(periodProblems({ from: '2026-10-10', to: '2026-11-04' }, '2026-11-03')[0]?.message).toMatch(/cannot end after today/)
    expect(periodProblems({ from: '2025-10-01', to: '2026-11-03' }, '2026-11-03')[0]?.message).toBe('A report covers at most 366 days.')
    expect(periodProblems({ from: '2026-02-30', to: '2026-03-01' }, '2026-11-03')[0]?.path).toBe('querystring/from')
  })

  it('the previous period is as long and ends the day before', () => {
    expect(previousOf({ from: '2026-10-05', to: '2026-11-03' })).toEqual({ from: '2026-09-05', to: '2026-10-04' })
    expect(previousOf({ from: '2026-10-01', to: '2026-10-01' })).toEqual({ from: '2026-09-30', to: '2026-09-30' })
  })

  it('weeks are ISO weeks clipped to the period; the span is the site\'s days', () => {
    expect(weeksOf({ from: '2026-10-28', to: '2026-11-10' })).toEqual([
      { key: '2026-W44', from: '2026-10-28', to: '2026-11-01' },
      { key: '2026-W45', from: '2026-11-02', to: '2026-11-08' },
      { key: '2026-W46', from: '2026-11-09', to: '2026-11-10' },
    ])
    // Rome is UTC+1 in November: the day starts at 23:00 UTC the day before.
    expect(spanOf({ from: '2026-11-02', to: '2026-11-02' }, 'Europe/Rome')).toEqual({ start: at('2026-11-01T23:00:00.000Z'), end: at('2026-11-02T23:00:00.000Z') })
  })
})

describe('quality reports: the figures', () => {
  it('percent with one decimal, never a made-up 0 for nothing', () => {
    expect(pct(27, 28)).toBe('96.4')
    expect(pct(0, 0)).toBeNull()
    expect(fpyOf(40, 2)).toBe('95.0')
    expect(fpyOf(0, 0)).toBeNull()
    expect(passRateOf(3, 4)).toBe('75.0')
    expect(passRateOf(0, 0)).toBeNull()
  })

  it('a plan inspection counts its pieces, a W1 inspection its sample', () => {
    expect(unitsInspectedOf({ planVersionId: null, sampleSize: 13, checklist: null })).toBe(13)
    expect(unitsInspectedOf({ planVersionId: 'v', sampleSize: 13, checklist: [{ code: 'AQL_SAMPLE', ok: null, inspected: 8 }] })).toBe(8)
    expect(unitsInspectedOf({ planVersionId: 'v', sampleSize: 13, checklist: [] })).toBe(13)
  })

  it('a CAPA action is on time when done before its due day ends at the site', () => {
    expect(doneOnTime(at('2026-11-02T22:59:00Z'), '2026-11-02', 'Europe/Rome')).toBe(true)
    expect(doneOnTime(at('2026-11-02T23:00:00Z'), '2026-11-02', 'Europe/Rome')).toBe(false)
  })

  it('NCRs open and holds standing at a moment; a hold is old after 7 days', () => {
    const end = at('2026-11-03T12:00:00Z')
    expect(openAt({ foundOn: at('2026-10-01T00:00:00Z'), closedAt: null, cancelledAt: null }, end)).toBe(true)
    expect(openAt({ foundOn: at('2026-10-01T00:00:00Z'), closedAt: at('2026-11-01T00:00:00Z'), cancelledAt: null }, end)).toBe(false)
    expect(openAt({ foundOn: at('2026-10-01T00:00:00Z'), closedAt: at('2026-11-05T00:00:00Z'), cancelledAt: null }, end)).toBe(true)
    expect(openAt({ foundOn: at('2026-11-04T00:00:00Z'), closedAt: null, cancelledAt: null }, end)).toBe(false)
    expect(heldAt({ placedAt: at('2026-10-01T00:00:00Z'), releasedAt: at('2026-10-02T00:00:00Z'), closedAt: null }, end)).toBe(false)
    expect(oldHoldAt({ placedAt: at('2026-10-27T11:59:00Z'), releasedAt: null, closedAt: null }, end)).toBe(true)
    expect(oldHoldAt({ placedAt: at('2026-10-27T12:01:00Z'), releasedAt: null, closedAt: null }, end)).toBe(false)
  })

  it('days in quarantine: receipt to the decision, else to now; averages with one decimal', () => {
    const now = at('2026-11-03T00:00:00Z')
    expect(quarantineDaysOf({ receivedAt: at('2026-10-30T00:00:00Z'), qualityDecidedAt: at('2026-11-01T12:00:00Z') }, now)).toBe(2.5)
    expect(quarantineDaysOf({ receivedAt: at('2026-10-31T00:00:00Z'), qualityDecidedAt: null }, now)).toBe(3)
    expect(quarantineDaysOf({ receivedAt: null, qualityDecidedAt: null }, now)).toBeNull()
    expect(averageDays([2.5, 3])).toBe('2.8')
    expect(averageDays([])).toBeNull()
  })

  it('the change against the previous period says which way and whether it is good news', () => {
    expect(changeOf('fpy', '96.4', '95.2')).toEqual({ direction: 'UP', by: '1.2', better: true })
    expect(changeOf('dhu', '4.0', '5.5')).toEqual({ direction: 'DOWN', by: '1.5', better: true })
    expect(changeOf('holdsOld', 3, 1)).toEqual({ direction: 'UP', by: '2.0', better: false })
    expect(changeOf('aqlPass', '90.0', '90.0')).toEqual({ direction: 'SAME', by: '0.0', better: null })
    expect(changeOf('fpy', null, '95.0')).toBeNull()
  })
})

describe('quality reports: never per worker (ANA-075)', () => {
  it('a group below the minimum, or with no known headcount, shows nothing', () => {
    expect(peopleShown(3, 3)).toBe(true)
    expect(peopleShown(2, 3)).toBe(false)
    expect(peopleShown(4, 5)).toBe(false)
    expect(peopleShown(null, 3)).toBe(false)
    expect(peopleShown(2, 1)).toBe(false) // never below the floor of 3
    expect(headcountOf(['a', 'b', 'a', null, undefined])).toBe(2)
  })

  it('a row of a small group has no figure; each dimension fills its own columns', () => {
    const tally: Tally = { inspected: 40, defects: 3, passed: 2, decided: 3, ncrs: 1 }
    const all = { counts: true, aql: true, ncrs: true }
    expect(rowFigures('line', tally, false, all)).toEqual({ inspected: 40, defects: 3, dhu: '7.5', aql: { passed: 2, decided: 3, pct: '66.7' }, ncrs: 1 })
    expect(rowFigures('line', tally, true, all)).toEqual({ inspected: null, defects: null, dhu: null, aql: null, ncrs: null })
    expect(rowFigures('operation', tally, false, all)).toEqual({ inspected: 40, defects: 3, dhu: '7.5', aql: null, ncrs: null })
    // A column whose records the reader may not see stays empty.
    expect(rowFigures('style', tally, false, { counts: true, aql: true, ncrs: false }).ncrs).toBeNull()
  })

  it('operations group by the library operation, else by code', () => {
    expect(operationKeyOf({ operationId: 'op-1', code: 'sew' })).toBe('op-1')
    expect(operationKeyOf({ operationId: null, code: ' sew ' })).toBe('code:SEW')
  })

  it('one read permission, quality.reports.view', () => {
    expect(QUALITY_REPORTS_VIEW).toBe('quality.reports.view')
    expect(QUALITY_REPORTS_PERMISSIONS).toEqual(['quality.reports.view'])
  })
})
