import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '../../auth/permissions/catalogue'
import { templateOf } from '../../auth/roles/templates'
import { EVENT_DEFINITIONS } from '../../events/catalogue'
import { shiftsOfDay, type ClockFact, type ClockFlag, type ClockKind, type ClockSource } from '../clock/rules'
import { TOO_FEW_WORDS } from '../privacy/groups'
import { absenceCodeProblems, documentRefProblems, missingStandardCodes, STANDARD_ABSENCE_CODES } from './absences'
import { PEOPLE_ATTENDANCE_PERMISSIONS } from './permissions'
import { presenceOf } from './presence'
import {
  anomalyWords,
  approvalHolds,
  computeDay,
  countedIn,
  DEFAULT_ATTENDANCE_SETTINGS,
  LAW_DAY_RULES,
  reasonProblems,
  reconcileAnomalies,
  roundInstant,
  ruleWords,
  settingsProblems,
  statusAfter,
  workedExample,
  type AttendanceSettings,
  type DayInput,
  type PlannedDay,
} from './rules'

/**
 * Attendance days (B-W2b-37; MES-225 rounding, tolerance and grace, MES-226 anomalies, MES-228 absence codes, MES-233 who
 * is in now, MES-238 manual entries). Made-up times on Wednesday 4 November 2026 in Europe/Rome (UTC+1): 06:00 Rome is
 * 05:00Z. The law the tests name: D.Lgs. 66/2003 art. 1 (night work), art. 7 (11 hours of daily rest), art. 8 (a break
 * after 6 hours); Statuto dei Lavoratori art. 4 (no group under the minimum size shows a count; ANA-075).
 */

const ROME = 'Europe/Rome'
const DAY = '2026-11-04'
const at = (local: string, date = DAY) => {
  const [hour, minute] = local.split(':').map(Number)
  return new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), hour! - 1, minute!))
}
let serial = 0
const ev = (kind: ClockKind, local: string, more: { source?: ClockSource; flags?: ClockFlag[]; voidsEventId?: string; date?: string; id?: string } = {}): ClockFact => ({
  id: more.id ?? `00000000-0000-7000-8000-${String(++serial).padStart(12, '0')}`,
  kind,
  source: more.source ?? 'BADGE',
  occurredAt: at(local, more.date),
  voidsEventId: more.voidsEventId ?? null,
  flags: more.flags ?? [],
})
const morning = (date = DAY, segments = true): PlannedDay => ({
  date,
  kind: 'WORK',
  shifts: shiftsOfDay({
    date,
    timeZone: ROME,
    roster: { kind: 'WORK', shiftLabel: 'Morning', startMinute: 360, endMinute: 840, breakMinutes: 30, patternSegments: segments ? [{ weekday: 3, kind: 'BREAK', label: 'Lunch', startMinute: 720, endMinute: 750 }] : null },
    defaultSegments: null,
  }),
})
const input = (events: ClockFact[], more: Partial<DayInput> = {}): DayInput => ({
  date: DAY,
  timeZone: ROME,
  now: at('23:00'),
  settings: DEFAULT_ATTENDANCE_SETTINGS,
  plans: [morning()],
  events,
  absenceMinutes: [],
  rules: LAW_DAY_RULES,
  ...more,
})
const kinds = (day: ReturnType<typeof computeDay>) => day.anomalies.map((anomaly) => anomaly.kind).sort()

describe('rounding, tolerance and grace (MES-225)', () => {
  it('counts an early clock-in from the shift start, deducts the fixed break, counts overtime in whole units', () => {
    const day = computeDay(input([ev('IN', '05:52'), ev('OUT', '14:20')]))
    expect(day.planned).toEqual({ label: 'Morning', startMinute: 360, endMinute: 840, minutes: 450 })
    expect(day.figures).toMatchObject({ presentMinutes: 470, breakMinutes: 30, ordinaryMinutes: 450, overtimeMinutes: 15, nightMinutes: 0, holidayMinutes: 0 })
    expect(day.figures.firstInAt?.toISOString()).toBe(at('05:52').toISOString())
    expect(day.anomalies).toEqual([])
  })

  it('without "early counts from shift start" the minutes before the shift count only as overtime candidates', () => {
    const settings: AttendanceSettings = { ...DEFAULT_ATTENDANCE_SETTINGS, earlyClockInFromShiftStart: false }
    const day = computeDay(input([ev('IN', '05:30'), ev('OUT', '14:00')], { settings }))
    expect(day.figures).toMatchObject({ presentMinutes: 480, ordinaryMinutes: 450, overtimeMinutes: 30 })
  })

  it('a clock-in within the lateness grace counts from the start; a later one counts from its minute', () => {
    const graced = { ...DEFAULT_ATTENDANCE_SETTINGS, lateGraceMinutes: 5 }
    expect(computeDay(input([ev('IN', '06:05'), ev('OUT', '14:00')], { settings: graced })).figures.ordinaryMinutes).toBe(450)
    expect(computeDay(input([ev('IN', '06:06'), ev('OUT', '14:00')], { settings: graced })).figures.ordinaryMinutes).toBe(444)
  })

  it('rounds clock events to the nearest 5 or 15 minutes', () => {
    expect(new Date(roundInstant(at('14:07').getTime(), 15)).toISOString()).toBe(at('14:00').toISOString())
    expect(new Date(roundInstant(at('14:08').getTime(), 15)).toISOString()).toBe(at('14:15').toISOString())
    expect(new Date(roundInstant(at('14:02').getTime() + 59_000, 0)).toISOString()).toBe(at('14:02').toISOString())
    const shift = morning().shifts[0]!
    expect(countedIn(at('06:20').getTime(), shift, { ...DEFAULT_ATTENDANCE_SETTINGS, roundingMinutes: 15 }, at('14:00').getTime())).toBe(at('06:15').getTime())
  })

  it('deducts a hand-typed shift break (none placed) once the day passes six hours', () => {
    const plans = [morning(DAY, false)]
    expect(computeDay(input([ev('IN', '06:00'), ev('OUT', '14:00')], { plans })).figures).toMatchObject({ presentMinutes: 450, breakMinutes: 30, ordinaryMinutes: 450 })
    expect(computeDay(input([ev('IN', '06:00'), ev('OUT', '11:00')], { plans })).figures).toMatchObject({ presentMinutes: 300, breakMinutes: 0 })
  })

  it('clocked breaks are deducted when breaks are not fixed', () => {
    const settings = { ...DEFAULT_ATTENDANCE_SETTINGS, fixedBreaks: false }
    const day = computeDay(input([ev('IN', '06:00'), ev('BREAK_OUT', '10:00'), ev('BREAK_IN', '10:20'), ev('OUT', '14:00')], { settings }))
    expect(day.figures).toMatchObject({ presentMinutes: 460, breakMinutes: 20 })
  })

  it('counts night minutes (22:00-06:00, D.Lgs. 66/2003 art. 1) on a night shift that belongs to the day it starts', () => {
    const night: PlannedDay = { date: DAY, kind: 'WORK', shifts: shiftsOfDay({ date: DAY, timeZone: ROME, roster: { kind: 'WORK', shiftLabel: 'Night', startMinute: 1320, endMinute: 1800, breakMinutes: 0, patternSegments: null }, defaultSegments: null }) }
    const day = computeDay(input([ev('IN', '21:55'), ev('OUT', '06:00', { date: '2026-11-05' })], { plans: [night], now: at('12:00', '2026-11-05') }))
    expect(day.planned).toMatchObject({ startMinute: 1320, endMinute: 1800 })
    expect(day.figures).toMatchObject({ presentMinutes: 480, nightMinutes: 480, ordinaryMinutes: 480 })
    // The same stretch is not the next day's.
    expect(computeDay(input([ev('IN', '21:55'), ev('OUT', '06:00', { date: '2026-11-05' })], { date: '2026-11-05', plans: [night], now: at('12:00', '2026-11-05') })).presence).toBe(false)
  })

  it('worked on a day off: holiday minutes, overtime in units, and the NO_SHIFT anomaly', () => {
    const day = computeDay(input([ev('IN', '08:00'), ev('OUT', '12:10')], { plans: [{ date: DAY, kind: 'OFF', shifts: [] }] }))
    expect(day.figures).toMatchObject({ presentMinutes: 250, ordinaryMinutes: 0, overtimeMinutes: 240, holidayMinutes: 250 })
    expect(kinds(day)).toEqual(['NO_SHIFT'])
  })

  it('validates the settings in words and gives the worked example', () => {
    expect(settingsProblems({ lateGraceMinutes: 61, overtimeUnitMinutes: 0, roundingMinutes: 10, autoClockOutAfterMinutes: 721 }).map((problem) => problem.path)).toEqual(['lateGraceMinutes', 'overtimeUnitMinutes', 'roundingMinutes', 'autoClockOutAfterMinutes'])
    expect(settingsProblems({ ...DEFAULT_ATTENDANCE_SETTINGS })).toEqual([])
    const example = workedExample({ ...DEFAULT_ATTENDANCE_SETTINGS, lateGraceMinutes: 5, roundingMinutes: 15, autoClockOutAfterMinutes: 15 })
    expect(example[0]).toBe('A clock-in at 05:52 for a 06:00 shift counts from 06:00.')
    expect(example[1]).toContain('06:05 still counts from 06:00')
    expect(example[2]).toContain('13:52 counts as 13:45, 13:53 as 14:00')
    expect(example[4]).toContain('15 minutes after the shift ends')
  })
})

describe('attendance anomalies with the rule that found them (MES-226)', () => {
  it('a clock-in open past 13 hours is a missing clock-out; a younger one is a running day', () => {
    const forgotten = computeDay(input([ev('IN', '06:00')], { now: at('20:00') }))
    expect(kinds(forgotten)).toEqual(['MISSING_CLOCK_OUT'])
    expect(forgotten.anomalies[0]).toMatchObject({ ruleKey: 'people.clock.openLimit' })
    expect(forgotten.figures.presentMinutes).toBe(0)
    const running = computeDay(input([ev('IN', '06:00')], { now: at('10:00') }))
    expect(running).toMatchObject({ running: true, anomalies: [] })
  })

  it('an automatic clock-out needs a look: MISSING_CLOCK_OUT with its rule and time in words', () => {
    const auto = ev('OUT', '14:15', { source: 'AUTO' })
    const day = computeDay(input([ev('IN', '06:00'), auto], { settings: { ...DEFAULT_ATTENDANCE_SETTINGS, autoClockOutAfterMinutes: 15 } }))
    expect(day.anomalies).toEqual([expect.objectContaining({ kind: 'MISSING_CLOCK_OUT', ruleKey: 'people.autoClockOutAfterMinutes', clockEventId: auto.id })])
    expect(anomalyWords('MISSING_CLOCK_OUT', day.anomalies[0]!.detail, ROME)).toBe('Clock-out missing; automatic clock-out at 14:15 after shift end + 15 min.')
    expect(ruleWords('MISSING_CLOCK_OUT', day.anomalies[0]!.detail, DEFAULT_ATTENDANCE_SETTINGS)).toContain('People settings')
  })

  it('finds a double clock-in, a clock-out with no clock-in, a flagged event', () => {
    const second = ev('IN', '06:10')
    const orphan = ev('OUT', '05:00')
    const flagged = ev('IN', '06:00', { source: 'NAME_PIN', flags: ['FORGOT_BADGE'] })
    const day = computeDay(input([orphan, flagged, second, ev('OUT', '14:00')]))
    expect(kinds(day)).toEqual(['DOUBLE_CLOCK_IN', 'FLAGGED_EVENT', 'MISSING_CLOCK_IN'])
    expect(day.anomalies.find((anomaly) => anomaly.kind === 'DOUBLE_CLOCK_IN')?.clockEventId).toBe(second.id)
    expect(day.figures.ordinaryMinutes).toBe(450)
  })

  it('a voided event no longer counts and no longer raises its anomaly', () => {
    const second = ev('IN', '06:10')
    const day = computeDay(input([ev('IN', '06:00'), second, ev('VOID', '06:10', { source: 'MANUAL', voidsEventId: second.id }), ev('OUT', '14:00')]))
    expect(day.anomalies).toEqual([])
    expect(day.eventIds).toContain(second.id)
  })

  it('a day over 16 hours, a short rest (art. 7) and no break (art. 8) each name their limit', () => {
    const settings = { ...DEFAULT_ATTENDANCE_SETTINGS, fixedBreaks: false }
    const long = computeDay(input([ev('IN', '05:00'), ev('OUT', '21:30')], { settings, now: at('23:30') }))
    expect(kinds(long)).toEqual(['LONG_DAY', 'NO_BREAK'])
    expect(long.anomalies.find((anomaly) => anomaly.kind === 'LONG_DAY')?.detail).toEqual({ limitMinutes: 960, foundMinutes: 990 })
    const rest = computeDay(input([ev('IN', '14:00', { date: '2026-11-03' }), ev('OUT', '22:00', { date: '2026-11-03' }), ev('IN', '06:00'), ev('OUT', '14:00')]))
    expect(rest.anomalies).toEqual([expect.objectContaining({ kind: 'SHORT_REST', ruleKey: 'time.rule.DAILY_REST', detail: { limitMinutes: 660, foundMinutes: 480 } })])
  })

  it('raises what is new, clears what is gone, never raises again what a person accepted', () => {
    const found = [
      { kind: 'NO_SHIFT' as const, ruleKey: 'people.attendance.noShift', clockEventId: null, workingTimeRuleId: null, detail: {} },
      { kind: 'FLAGGED_EVENT' as const, ruleKey: 'people.clock.flagged', clockEventId: 'e1', workingTimeRuleId: null, detail: {} },
    ]
    const plan = reconcileAnomalies(
      [
        { id: 'a1', kind: 'NO_SHIFT', clockEventId: null, resolution: null },
        { id: 'a2', kind: 'DOUBLE_CLOCK_IN', clockEventId: 'e2', resolution: null },
        { id: 'a3', kind: 'FLAGGED_EVENT', clockEventId: 'e1', resolution: 'ACCEPTED' },
      ],
      found,
    )
    expect(plan).toEqual({ raise: [], resolve: ['a2'], open: 1 })
    expect(statusAfter(plan.open)).toBe('NEEDS_FIX')
    expect(reconcileAnomalies([], found).raise).toHaveLength(2)
    expect(statusAfter(0)).toBe('OPEN')
  })
})

describe('approval, manual entries and absence codes (MES-228, MES-238)', () => {
  const base = { status: 'OPEN' as const, date: '2026-11-03', today: DAY, openAnomalies: 0, presence: true, plannedWork: true, absenceMinutes: 0, running: false, own: false }
  it('holds a day with anomalies, a running or future day, a planned day with no code, and one\'s own day', () => {
    expect(approvalHolds(base)).toEqual([])
    expect(approvalHolds({ ...base, openAnomalies: 1, own: true, date: DAY })).toEqual(['OWN_DAY', 'NOT_OVER', 'ANOMALIES_OPEN'])
    expect(approvalHolds({ ...base, presence: false })).toEqual(['NO_ABSENCE_CODE'])
    expect(approvalHolds({ ...base, presence: false, absenceMinutes: 450 })).toEqual([])
    expect(approvalHolds({ ...base, status: 'APPROVED' })).toEqual(['ALREADY_APPROVED'])
  })

  it('a manual entry always carries its reason', () => {
    expect(reasonProblems('')).toHaveLength(1)
    expect(reasonProblems('Forgot to clock out at the end of the shift')).toEqual([])
  })

  it("an absence code has an Italian name and a category; a document is only its reference, never a text", () => {
    expect(absenceCodeProblems({ code: 'fer', labelI18n: { en: 'Holiday' }, category: 'NAP', paid: 'yes' }, true).map((problem) => problem.path)).toEqual(['code', 'labelI18n', 'category', 'paid'])
    expect(absenceCodeProblems({ code: 'FER', labelI18n: { it: 'Ferie', en: 'Holiday' }, category: 'HOLIDAY', paid: true, lulCode: 'F01' }, true)).toEqual([])
    expect(documentRefProblems(undefined, true)).toHaveLength(1)
    expect(documentRefProblems('INPS-2026/123456', true)).toEqual([])
    expect(documentRefProblems('influenza with fever', true)).toHaveLength(1)
    expect(missingStandardCodes(['FER', 'MAL']).map((entry) => entry.code)).not.toContain('FER')
    expect(STANDARD_ABSENCE_CODES.filter((entry) => entry.category === 'SICKNESS' || entry.category === 'INJURY').every((entry) => entry.documentRequired)).toBe(true)
  })
})

describe('who is in now (MES-233)', () => {
  const names = { lines: new Map([['l1', { code: 'L1', name: 'Line 1', areaId: 'a1' }], ['l2', { code: 'L2', name: 'Line 2', areaId: 'a1' }]]), areas: new Map([['a1', { code: 'SEW', name: 'Sewing hall' }]]) }
  it('counts per site, area and line, and hides every group under the minimum (ANA-075)', () => {
    const people = [...Array.from({ length: 4 }, (_, i) => ({ employeeId: `p${i}`, lineId: 'l1', areaId: 'a1', onBreak: false })), { employeeId: 'p9', lineId: 'l2', areaId: 'a1', onBreak: true }]
    const presence = presenceOf(people, names, 3)
    expect(presence).toMatchObject({ people: 5, tooFew: false, hidden: 1, words: TOO_FEW_WORDS })
    expect(presence.areas[0]).toMatchObject({ code: 'SEW', people: 5, lines: [{ code: 'L1', people: 4, tooFew: false }, { code: 'L2', people: null, tooFew: true }] })
    expect(presenceOf(people.slice(0, 2), names, 3)).toMatchObject({ people: null, tooFew: true })
  })
})

describe('the catalogues', () => {
  it('declares the permissions, gives them to the templates, declares the events', () => {
    for (const name of PEOPLE_ATTENDANCE_PERMISSIONS) expect(FACTORY_PERMISSIONS.isDeclared(name)).toBe(true)
    expect(templateOf('admin')?.permissions).toEqual(expect.arrayContaining(['people.attendance.view', 'people.attendance.manage', 'people.attendance.approve', 'people.attendance.settings', 'people.attendance.rollcall']))
    expect(templateOf('floor_supervisor')?.permissions).toContain('people.attendance.rollcall')
    expect(templateOf('floor_supervisor')?.permissions).not.toContain('people.attendance.view')
    const types = EVENT_DEFINITIONS.map((definition) => definition.type)
    expect(types).toEqual(expect.arrayContaining(['attendance.day_changed', 'attendance.anomaly_raised', 'absence_code.changed', 'people_settings.attendance_changed']))
  })
})
