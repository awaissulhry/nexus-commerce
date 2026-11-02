import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '../../auth/permissions/catalogue'
import { templateOf } from '../../auth/roles/templates'
import { EVENT_DEFINITIONS } from '../../events/catalogue'
import { computeDay, DEFAULT_ATTENDANCE_SETTINGS, LAW_DAY_RULES, type DayInput, type PlannedDay } from '../attendance/rules'
import { shiftsOfDay, type ClockFact, type ClockKind } from '../clock/rules'
import { PERSON_DECISIONS } from '../privacy/decisions'
import { PEOPLE_OVERTIME_PERMISSIONS } from './permissions'
import { entryHolds, hasWork, OVERTIME_RULES, overtimeReasonProblems, overtimeSplit, planEntries, type StoredEntry } from './rules'
import { monthPeriod, stageOf, timesheetHolds } from './timesheets'

/**
 * Overtime worked and timesheets (B-W2b-42; MES-229, MES-230). Made-up times on Wednesday 4 November 2026 in Europe/Rome
 * (UTC+1). The law the tests name: D.Lgs. 66/2003 art. 1 (night work 22:00-06:00), art. 5 (overtime is paid and limited);
 * D.Lgs. 152/1997 art. 1-bis (a person decides, never about themselves).
 */

const ROME = 'Europe/Rome'
const DAY = '2026-11-04'
const NEXT = '2026-11-05'
const at = (local: string, date = DAY) => {
  const [hour, minute] = local.split(':').map(Number)
  return new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), hour! - 1, minute!))
}
let serial = 0
const ev = (kind: ClockKind, local: string, date = DAY): ClockFact => ({ id: `00000000-0000-7000-8000-${String(++serial).padStart(12, '0')}`, kind, source: 'BADGE', occurredAt: at(local, date), voidsEventId: null, flags: [] })
const shift = (startMinute: number, endMinute: number, date = DAY): PlannedDay => ({ date, kind: 'WORK', shifts: shiftsOfDay({ date, timeZone: ROME, roster: { kind: 'WORK', shiftLabel: 'Shift', startMinute, endMinute, breakMinutes: 0, patternSegments: null, source: 'ROSTER' }, defaultSegments: null }) })
const off = (date = DAY): PlannedDay => ({ date, kind: 'OFF', shifts: [] })
const input = (events: ClockFact[], plans: PlannedDay[]): DayInput => ({ date: DAY, timeZone: ROME, now: at('12:00', NEXT), settings: DEFAULT_ATTENDANCE_SETTINGS, plans, events, absenceMinutes: [], rules: LAW_DAY_RULES })
const stored = (entry: Partial<StoredEntry>): StoredEntry => ({ id: 'e1', kind: 'DAY', minutes: 60, requestId: null, status: 'PENDING', ...entry })
const none = { DAY: 0, NIGHT: 0, HOLIDAY: 0 }

describe('overtime by class (D.Lgs. 66/2003 art. 1 and art. 5)', () => {
  it('splits a day: all of it HOLIDAY on a day planned off, the night part NIGHT, the rest DAY', () => {
    expect(overtimeSplit({ overtimeMinutes: 90, nightOvertimeMinutes: 30, holidayMinutes: 0 })).toEqual({ DAY: 60, NIGHT: 30, HOLIDAY: 0 })
    expect(overtimeSplit({ overtimeMinutes: 90, nightOvertimeMinutes: 90, holidayMinutes: 0 })).toEqual({ DAY: 0, NIGHT: 90, HOLIDAY: 0 })
    expect(overtimeSplit({ overtimeMinutes: 240, nightOvertimeMinutes: 60, holidayMinutes: 480 })).toEqual({ DAY: 0, NIGHT: 0, HOLIDAY: 240 })
    expect(overtimeSplit({ overtimeMinutes: 0, nightOvertimeMinutes: 0, holidayMinutes: 0 })).toEqual(none)
    // Never more night than overtime.
    expect(overtimeSplit({ overtimeMinutes: 30, nightOvertimeMinutes: 60, holidayMinutes: 0 })).toEqual({ DAY: 0, NIGHT: 30, HOLIDAY: 0 })
  })

  it('counts as night only the overtime worked in the night window, in whole overtime units', () => {
    // An afternoon shift to 22:00 and out at 23:30: 90 minutes beyond it, all at night.
    const late = computeDay(input([ev('IN', '14:00'), ev('OUT', '23:30')], [shift(840, 1320)])).figures
    expect(late).toMatchObject({ overtimeMinutes: 90, nightOvertimeMinutes: 90 })
    // A night shift 22:00-06:00 and out at 07:00: the hour beyond it is daylight, though the shift itself is night.
    const morningAfter = computeDay(input([ev('IN', '22:00'), ev('OUT', '07:00', NEXT)], [shift(1320, 1800)])).figures
    expect(morningAfter).toMatchObject({ overtimeMinutes: 60, nightOvertimeMinutes: 0, nightMinutes: 480 })
    // 10 minutes past 22:00 is less than a unit of 15: no night overtime, as no overtime.
    expect(computeDay(input([ev('IN', '14:00'), ev('OUT', '22:10')], [shift(840, 1320)])).figures).toMatchObject({ overtimeMinutes: 0, nightOvertimeMinutes: 0 })
  })

  it('counts a planned day off whole as holiday overtime', () => {
    const figures = computeDay(input([ev('IN', '08:00'), ev('OUT', '12:00')], [off()])).figures
    expect(overtimeSplit(figures)).toEqual({ DAY: 0, NIGHT: 0, HOLIDAY: 240 })
  })
})

describe('keeping the entries in step (read first: nothing to do writes nothing)', () => {
  it('makes what is new, moves what is pending, removes what is left over', () => {
    expect(planEntries([], { ...none, DAY: 60 }, null)).toEqual({ create: [{ kind: 'DAY', minutes: 60 }], update: [], remove: [], takeBack: [] })
    expect(planEntries([stored({ minutes: 45 })], { ...none, DAY: 60 }, null).update).toEqual([{ id: 'e1', kind: 'DAY', minutes: 60 }])
    expect(planEntries([stored({})], none, null).remove).toEqual(['e1'])
    expect(hasWork(planEntries([stored({})], { ...none, DAY: 60 }, null))).toBe(false)
  })

  it('links a pending entry to the planned request the person agreed to', () => {
    expect(planEntries([stored({})], { ...none, DAY: 60 }, 'r1').update).toEqual([{ id: 'e1', kind: 'DAY', minutes: 60 }])
  })

  it('leaves a decided entry alone while it matches; takes the decision back when the figures moved (paid only on what a person saw)', () => {
    expect(hasWork(planEntries([stored({ status: 'APPROVED' })], { ...none, DAY: 60 }, null))).toBe(false)
    expect(hasWork(planEntries([stored({ status: 'REJECTED' })], { ...none, DAY: 60 }, 'r1'))).toBe(false)
    expect(planEntries([stored({ status: 'APPROVED' })], { ...none, DAY: 90 }, null).takeBack).toEqual([{ id: 'e1', kind: 'DAY', minutes: 90 }])
    expect(planEntries([stored({ status: 'APPROVED' })], none, null).takeBack).toEqual([{ id: 'e1', kind: 'DAY', minutes: 0 }])
  })
})

describe('deciding overtime: a person, on a day that no longer moves, never their own', () => {
  const facts = { status: 'PENDING' as const, dayStatus: 'APPROVED', own: false, monthClosed: false }

  it('lets a pending entry of an approved day be decided', () => {
    expect(entryHolds(facts)).toEqual([])
  })

  it('holds what is decided, an open day, a closed month and one’s own overtime', () => {
    expect(entryHolds({ ...facts, status: 'APPROVED' })).toEqual(['NOT_PENDING'])
    expect(entryHolds({ ...facts, dayStatus: 'OPEN' })).toEqual(['DAY_NOT_APPROVED'])
    expect(entryHolds({ ...facts, dayStatus: null })).toEqual(['DAY_NOT_APPROVED'])
    expect(entryHolds({ ...facts, own: true })).toEqual(['OWN_OVERTIME'])
    expect(entryHolds({ ...facts, dayStatus: 'CLOSED', monthClosed: true })).toEqual(['MONTH_CLOSED'])
    // A month being closed still decides what waits: the close cannot finish until it is.
    expect(entryHolds({ ...facts, dayStatus: 'CLOSED' })).toEqual([])
  })

  it('asks a reason of a few words', () => {
    expect(overtimeReasonProblems('  ', 'reason')).toHaveLength(1)
    expect(overtimeReasonProblems('x'.repeat(OVERTIME_RULES.reasonMax + 1), 'reason')).toHaveLength(1)
    expect(overtimeReasonProblems('Line stopped', 'reason')).toEqual([])
  })
})

describe('timesheets: the lead, then HR, two people, never your own', () => {
  const facts = { stage: 'LEAD' as const, status: 'PENDING' as const, periodEnd: '2026-10-31', today: '2026-11-02', daysOpen: 0, overtimePending: 0, own: false, approvedAsLead: false, monthClosed: false }

  it('goes lead → HR → done', () => {
    expect(stageOf('PENDING')).toBe('LEAD')
    expect(stageOf('LEAD_APPROVED')).toBe('HR')
    expect(stageOf('APPROVED')).toBe('DONE')
    expect(timesheetHolds(facts)).toEqual([])
    expect(timesheetHolds({ ...facts, stage: 'HR', status: 'LEAD_APPROVED' })).toEqual([])
  })

  it('holds what is not ready, in the order a person fixes it', () => {
    expect(timesheetHolds({ ...facts, periodEnd: '2026-11-02' })).toEqual(['PERIOD_NOT_OVER'])
    expect(timesheetHolds({ ...facts, daysOpen: 2, overtimePending: 1 })).toEqual(['DAYS_OPEN', 'OVERTIME_PENDING'])
    expect(timesheetHolds({ ...facts, stage: 'HR' })).toEqual(['WRONG_STAGE'])
    expect(timesheetHolds({ ...facts, monthClosed: true })).toEqual(['MONTH_CLOSED'])
  })

  it('refuses one’s own timesheet at both approvals, and the same person twice', () => {
    expect(timesheetHolds({ ...facts, own: true })).toEqual(['OWN_TIMESHEET'])
    expect(timesheetHolds({ ...facts, stage: 'HR', status: 'LEAD_APPROVED', own: true })).toEqual(['OWN_TIMESHEET'])
    expect(timesheetHolds({ ...facts, stage: 'HR', status: 'LEAD_APPROVED', approvedAsLead: true })).toEqual(['SAME_PERSON'])
  })

  it('reads a month', () => {
    expect(monthPeriod('2026-10')).toEqual({ periodStart: '2026-10-01', periodEnd: '2026-10-31' })
    expect(monthPeriod('2026-12')).toEqual({ periodStart: '2026-12-01', periodEnd: '2026-12-31' })
    expect(monthPeriod('2028-02')).toEqual({ periodStart: '2028-02-01', periodEnd: '2028-02-29' })
    expect(monthPeriod('2026-13')).toBeNull()
    expect(monthPeriod('October')).toBeNull()
  })
})

describe('the catalogues', () => {
  it('declares the permissions, the events and the two decisions a person makes', () => {
    for (const name of PEOPLE_OVERTIME_PERMISSIONS) expect(FACTORY_PERMISSIONS.isDeclared(name)).toBe(true)
    const types = EVENT_DEFINITIONS.map((event) => event.type)
    expect(types).toEqual(expect.arrayContaining(['overtime_entry.changed', 'timesheet.prepared', 'timesheet.changed', 'working_time_rule.changed']))
    expect(PERSON_DECISIONS).toEqual(expect.arrayContaining(['OVERTIME_DECISION', 'TIMESHEET_APPROVAL']))
  })

  it('gives HR the second approval, the manager the stand-in lead, the supervisor their team, and no read-only role a decision', () => {
    expect(templateOf('admin')?.permissions).toEqual(expect.arrayContaining(['people.overtime.review', 'people.timesheets.hr', 'people.limits.manage']))
    expect(templateOf('production_manager')?.permissions).toEqual(expect.arrayContaining(['people.overtime.review', 'people.timesheets.lead']))
    expect(templateOf('floor_supervisor')?.permissions).toContain('people.timesheets.team')
    expect(templateOf('floor_supervisor')?.permissions).not.toContain('people.overtime.review')
    // The supervisor confirms days: one person's hours stay behind people.attendance.view.
    expect(templateOf('floor_supervisor')?.permissions).not.toContain('people.attendance.view')
    expect(templateOf('read_only')?.permissions).not.toContain('people.overtime.review')
    expect(templateOf('read_only')?.permissions).not.toContain('people.timesheets.hr')
  })
})
