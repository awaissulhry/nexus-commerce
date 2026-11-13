import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '../../auth/permissions/catalogue'
import { templateOf } from '../../auth/roles/templates'
import { itemProfile } from '../item-profile/profile'
import { PLANNING_REPORTS_ADDS, PLANNING_REPORTS_VIEW } from './permissions'
import { adherenceFigures, adherenceOf, adherenceOrder, baselineOf, coverOf, coverOrder, earnedEntries, pctOf, periodProblems, reportWeeksOf, type PlanBar } from './rules'
import { Dec } from '../../tax/decimal'

const at = (iso: string) => new Date(iso)
const TZ = 'Europe/Rome'

describe('planning reports — who reads them', () => {
  it('is declared, read only, and given to the planner, the production manager and the buyer', () => {
    expect(FACTORY_PERMISSIONS.get(PLANNING_REPORTS_VIEW)).toMatchObject({ risk: 'read' })
    for (const key of Object.keys(PLANNING_REPORTS_ADDS)) expect(templateOf(key)!.permissions, key).toContain(PLANNING_REPORTS_VIEW)
    expect(templateOf('sales')!.permissions).not.toContain(PLANNING_REPORTS_VIEW)
    expect(templateOf('owner')!.permissions).toContain(PLANNING_REPORTS_VIEW)
    // Every holder already plans the site.
    for (const key of Object.keys(PLANNING_REPORTS_ADDS)) expect(templateOf(key)!.permissions, key).toContain('planning.view')
  })
})

describe('the period and its weeks', () => {
  it('refuses a period after today, reversed, too long or before 2020, in words', () => {
    expect(periodProblems({ from: '2026-10-01', to: '2026-10-31' }, '2026-11-12')).toEqual([])
    expect(periodProblems({ from: '2026-11-01', to: '2026-11-13' }, '2026-11-12')[0]!.message).toMatch(/cannot end after today/)
    expect(periodProblems({ from: '2026-11-05', to: '2026-11-01' }, '2026-11-12')[0]!.path).toBe('querystring/to')
    expect(periodProblems({ from: '2024-01-01', to: '2026-11-01' }, '2026-11-12')[0]!.message).toMatch(/at most 366/)
    expect(periodProblems({ from: '2019-12-31', to: '2020-01-02' }, '2026-11-12')[0]!.path).toBe('querystring/from')
  })

  it('clips the period’s weeks and adds whole weeks ahead, this week once with both parts', () => {
    const weeks = reportWeeksOf({ from: '2026-11-04', to: '2026-11-12' }, '2026-11-12', 2)
    expect(weeks.map((week) => [week.key, week.from, week.to, week.actual, week.ahead])).toEqual([
      ['2026-W45', '2026-11-04', '2026-11-08', true, false],
      ['2026-W46', '2026-11-09', '2026-11-15', true, true],
      ['2026-W47', '2026-11-16', '2026-11-22', false, true],
    ])
    expect(weeks[1]!.actualDays).toEqual({ from: '2026-11-09', to: '2026-11-12' })
    expect(reportWeeksOf({ from: '2026-10-01', to: '2026-10-11' }, '2026-11-12', 0).map((week) => week.key)).toEqual(['2026-W40', '2026-W41'])
  })
})

describe('schedule adherence (PLN-202)', () => {
  const bar = (versionId: string, kind: PlanBar['kind'], number: number | null, publishedAt: string | null, startAt: string, endAt: string): PlanBar => ({ versionId, kind, number, publishedAt: publishedAt ? at(publishedAt) : null, startAt: at(startAt), endAt: at(endAt) })

  it('measures against the version the floor had when the work started, never a later replan', () => {
    const bars = [
      bar('v1', 'PUBLISHED', 1, '2026-10-01T08:00:00Z', '2026-10-05T07:00:00Z', '2026-10-06T16:00:00Z'),
      bar('v1', 'PUBLISHED', 1, '2026-10-01T08:00:00Z', '2026-10-07T07:00:00Z', '2026-10-08T16:00:00Z'),
      bar('v2', 'PUBLISHED', 2, '2026-10-09T08:00:00Z', '2026-10-12T07:00:00Z', '2026-10-15T16:00:00Z'),
      bar('w', 'WORKING', null, null, '2026-10-12T07:00:00Z', '2026-10-16T16:00:00Z'),
    ]
    const span = baselineOf(bars, at('2026-10-05T09:00:00Z'))!
    expect(span).toMatchObject({ source: 'PUBLISHED', versionId: 'v1', number: 1 })
    expect(span.startAt.toISOString()).toBe('2026-10-05T07:00:00.000Z')
    expect(span.endAt.toISOString()).toBe('2026-10-08T16:00:00.000Z')
    // Started before any version was published: the first published version.
    expect(baselineOf(bars, at('2026-09-20T09:00:00Z'))!.versionId).toBe('v1')
    // Never published: the working plan; never on the board: none.
    expect(baselineOf([bars[3]!], at('2026-10-12T09:00:00Z'))!.source).toBe('WORKING')
    expect(baselineOf([], null)).toBeNull()
  })

  it('is on time when finished on or before the last bar’s day, in the site’s days', () => {
    const planned = { source: 'PUBLISHED' as const, versionId: 'v1', number: 1, startAt: at('2026-10-05T07:00:00Z'), endAt: at('2026-10-08T16:00:00Z') }
    expect(adherenceOf({ planned, actualStart: at('2026-10-05T08:00:00Z'), actualFinish: at('2026-10-08T18:30:00Z'), timeZone: TZ })).toEqual({ state: 'ON_TIME', startDays: 0, finishDays: 0 })
    // 23:30 UTC on the 8th is already the 9th in Rome: one day late.
    expect(adherenceOf({ planned, actualStart: at('2026-10-07T08:00:00Z'), actualFinish: at('2026-10-08T23:30:00Z'), timeZone: TZ })).toEqual({ state: 'LATE', startDays: 2, finishDays: 1 })
    expect(adherenceOf({ planned, actualStart: null, actualFinish: at('2026-10-06T10:00:00Z'), timeZone: TZ })).toEqual({ state: 'ON_TIME', startDays: null, finishDays: -2 })
    expect(adherenceOf({ planned: null, actualStart: null, actualFinish: at('2026-10-06T10:00:00Z'), timeZone: TZ }).state).toBe('NOT_PLANNED')
  })

  it('counts the work orders on no plan apart: never on time, never late', () => {
    const figures = adherenceFigures([
      { state: 'ON_TIME', startDays: 0, finishDays: -1 },
      { state: 'ON_TIME', startDays: 1, finishDays: 0 },
      { state: 'LATE', startDays: 3, finishDays: 4 },
      { state: 'NOT_PLANNED', startDays: null, finishDays: null },
    ])
    expect(figures).toEqual({ finished: 4, planned: 3, onTime: 2, late: 1, notPlanned: 1, onTimePct: '66.7', startedLate: 2, meanFinishDays: '1.0', meanStartDays: '1.3' })
    expect(adherenceFigures([]).onTimePct).toBeNull()
  })

  it('lists the latest against plan first, the unplanned last', () => {
    const rows = [
      { number: 'WO-3', state: 'NOT_PLANNED' as const, startDays: null, finishDays: null },
      { number: 'WO-1', state: 'ON_TIME' as const, startDays: 0, finishDays: -1 },
      { number: 'WO-2', state: 'LATE' as const, startDays: 2, finishDays: 3 },
    ]
    expect([...rows].sort(adherenceOrder).map((row) => row.number)).toEqual(['WO-2', 'WO-1', 'WO-3'])
  })
})

describe('the utilisation trend (PLN-204)', () => {
  it('earns the standing scans of whole garments per lane and week, never per person or station', () => {
    const weeks = [{ key: '2026-W45', from: '2026-11-02', to: '2026-11-08' }]
    const scans = [
      { id: 's1', kind: 'REPORT' as const, correctsId: null, bundleId: 'b1', operationId: 'op1', good: 5, stationId: 'st-line', at: at('2026-11-03T09:00:00Z') },
      { id: 's2', kind: 'REPORT' as const, correctsId: null, bundleId: 'b1', operationId: 'op2', good: 5, stationId: 'st-cut', at: at('2026-11-03T10:00:00Z') },
      { id: 's3', kind: 'REPORT' as const, correctsId: null, bundleId: 'b2', operationId: 'op1', good: 3, stationId: 'st-line', at: at('2026-11-04T09:00:00Z') },
      { id: 's4', kind: 'UNDO' as const, correctsId: 's3', bundleId: 'b2', operationId: 'op1', good: 0, stationId: 'st-line', at: at('2026-11-04T09:01:00Z') },
      { id: 's5', kind: 'REPORT' as const, correctsId: null, bundleId: 'b3', operationId: 'op1', good: 4, stationId: 'st-line', at: at('2026-11-04T09:00:00Z') },
      { id: 's6', kind: 'REPORT' as const, correctsId: null, bundleId: 'b1', operationId: 'op1', good: 2, stationId: 'st-line', at: at('2026-11-10T09:00:00Z') },
    ]
    const entries = earnedEntries({
      scans,
      bundles: new Map([
        ['b1', { part: null, status: 'ACTIVE' }],
        ['b2', { part: null, status: 'ACTIVE' }],
        ['b3', { part: 'SLEEVES', status: 'ACTIVE' }],
      ]),
      standardMinutes: new Map([
        ['op1', '12.5'],
        ['op2', '4'],
      ]),
      laneOfStation: new Map([
        ['st-line', 'LINE:l1'],
        ['st-cut', 'WORK_CENTRE:c1'],
      ]),
      weeks,
      timeZone: TZ,
    })
    expect(entries.map((entry) => [entry.lane, entry.week, entry.operationId, entry.good, entry.minutes.toFixed(1)])).toEqual([
      ['LINE:l1', '2026-W45', 'op1', 5, '62.5'],
      ['WORK_CENTRE:c1', '2026-W45', 'op2', 5, '20.0'],
    ])
    expect(pctOf(new Dec('62.5'), new Dec('250'))).toBe('25.0')
    expect(pctOf(new Dec('1'), new Dec('0'))).toBeNull()
  })
})

describe('material cover (PLN-207)', () => {
  const today = '2026-11-12'
  const profileOf = (onHand: string, demand: { day: string; quantity: string }[], receipts: { day: string; quantity: string }[], safetyStock: string | null = null) =>
    itemProfile({
      today,
      weeks: 4,
      onHand,
      safetyStock,
      demand: demand.map((entry, index) => ({ ...entry, ref: { orderId: 'o', orderNumber: 'SO-1', orderLineId: `l${index}`, lineSeq: index + 1, size: null, workOrderId: null, workOrderNumber: null, rank: null } })),
      receipts: receipts.map((entry) => ({ kind: 'PURCHASE_ORDER' as const, ...entry })),
      planned: [],
    })

  it('names the day of the profile’s first short week the stock falls below 0, receipts of a day first', () => {
    const demand = [
      { day: '2026-11-17', quantity: '30' },
      { day: '2026-11-19', quantity: '50' },
    ]
    const receipts = [{ day: '2026-11-19', quantity: '10' }]
    const profile = profileOf('60', demand, receipts)
    expect(profile.firstShort).toBe('2026-W47')
    const cover = coverOf({ today, profile, demand, receipts })
    expect(cover).toEqual({ demand: '80.0000', receipts: '10.0000', projectedEnd: '-10.0000', stockOutOn: '2026-11-19', belowSafetyOn: null, daysOfCover: 7, state: 'STOCK_OUT' })
  })

  it('is short now for late demand, below safety before a stock-out, covered otherwise', () => {
    const late = [{ day: '2026-11-02', quantity: '40' }]
    expect(coverOf({ today, profile: profileOf('10', late, []), demand: late, receipts: [] })).toMatchObject({ stockOutOn: today, daysOfCover: 0, state: 'SHORT_NOW' })
    // Earlier this week (Monday) but already gone: today.
    const monday = [{ day: '2026-11-09', quantity: '40' }]
    expect(coverOf({ today, profile: profileOf('10', monday, []), demand: monday, receipts: [] })).toMatchObject({ stockOutOn: today, state: 'SHORT_NOW' })
    const some = [{ day: '2026-11-24', quantity: '30' }]
    expect(coverOf({ today, profile: profileOf('50', some, [], '25'), demand: some, receipts: [] })).toMatchObject({ stockOutOn: null, belowSafetyOn: '2026-11-24', daysOfCover: null, state: 'BELOW_SAFETY' })
    expect(coverOf({ today, profile: profileOf('50', some, []), demand: some, receipts: [] })).toMatchObject({ state: 'COVERED', projectedEnd: '20.0000' })
    // Short only after the horizon: no stock-out in it.
    const later = [{ day: '2027-02-01', quantity: '80' }]
    expect(coverOf({ today, profile: profileOf('50', later, []), demand: later, receipts: [] })).toMatchObject({ stockOutOn: null, state: 'COVERED', demand: '0.0000' })
  })

  it('orders the grid: short now, the soonest stock-out, below safety, covered', () => {
    const rows = [
      { label: 'C', state: 'COVERED' as const, stockOutOn: null, belowSafetyOn: null },
      { label: 'B', state: 'STOCK_OUT' as const, stockOutOn: '2026-11-30', belowSafetyOn: null },
      { label: 'A', state: 'STOCK_OUT' as const, stockOutOn: '2026-11-20', belowSafetyOn: null },
      { label: 'D', state: 'BELOW_SAFETY' as const, stockOutOn: null, belowSafetyOn: '2026-11-18' },
      { label: 'E', state: 'SHORT_NOW' as const, stockOutOn: '2026-11-12', belowSafetyOn: null },
    ]
    expect([...rows].sort(coverOrder).map((row) => row.label)).toEqual(['E', 'A', 'B', 'D', 'C'])
  })
})
