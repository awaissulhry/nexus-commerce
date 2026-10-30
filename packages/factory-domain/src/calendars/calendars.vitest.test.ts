import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '../auth/permissions/catalogue'
import { templateOf } from '../auth/roles/templates'
import { EVENT_CATALOGUE } from '../events/catalogue'
import { eachDay, isoWeekday, localInstant, plusDays } from './dates'
import { easterSunday, publicHolidays } from './holidays'
import { DEFAULT_PATTERN, describePattern, segmentProblems, shiftEndsOf, weekdayMinutes, type Pattern, type Segment } from './patterns'
import { dayProblems, rangeProblems, weekdaysProblems } from './rules'
import { arrivalDate, closedDaysOf, closedSpansOf, orderByDate, weeklyDaysOffOf } from './suppliers'
import { addWorkingDays, dayOf, nextWorkingDay, OutsideWindowError, workingCalendar, workingMinutesBetween, workingTimeOf, type CalendarLayer, type DayException, type DayKind } from './working-time'

const ROME = 'Europe/Rome'
const YEAR = { from: '2026-01-01', to: '2026-12-31' }

const shift = (weekday: number, startMinute: number, endMinute: number, label: string | null = null): Segment => ({ weekday, kind: 'SHIFT', label, startMinute, endMinute })
const pause = (weekday: number, startMinute: number, endMinute: number, label: string | null = 'Break'): Segment => ({ weekday, kind: 'BREAK', label, startMinute, endMinute })
const everyWeekday = (days: readonly number[], make: (weekday: number) => Segment[]): Segment[] => days.flatMap(make)

const ONE_SHIFT: Pattern = { id: 'p-1t', code: '1T', name: 'One shift', segments: everyWeekday([1, 2, 3, 4, 5], (d) => [shift(d, 480, 1020, 'Day'), pause(d, 720, 780, 'Lunch')]) }
const TWO_SHIFTS: Pattern = {
  id: 'p-2t',
  code: '2T',
  name: 'Two shifts',
  segments: everyWeekday([1, 2, 3, 4, 5], (d) => [shift(d, 360, 840, 'Morning'), pause(d, 600, 615), shift(d, 840, 1320, 'Afternoon'), pause(d, 1080, 1095)]),
}
const SATURDAY_MORNING: Pattern = { id: 'p-sat', code: 'SAT-AM', name: 'Saturday morning', segments: [shift(6, 480, 720, 'Morning')] }
const NIGHTS: Pattern = { id: 'p-night', code: 'NIGHT', name: 'Nights', segments: everyWeekday([1, 2, 3, 4, 5, 6], (d) => [shift(d, 1320, 1800, 'Night'), pause(d, 1560, 1590)]) }
const SUNDAY_EARLY: Pattern = { id: 'p-sun', code: 'SUN', name: 'Sunday early', segments: [shift(7, 0, 480, 'Early')] }
const PATTERNS = new Map([ONE_SHIFT, TWO_SHIFTS, SATURDAY_MORNING, NIGHTS, SUNDAY_EARLY].map((pattern) => [pattern.id, pattern]))

const days = (entries: readonly [string, DayKind, string, string?][]): Map<string, DayException> =>
  new Map(entries.map(([date, kind, name, shiftPatternId]) => [date, { date, kind, name, shiftPatternId: shiftPatternId ?? null }]))
const layer = (id: string, scope: CalendarLayer['scope'], shiftPatternId: string | null, exceptions: Map<string, DayException> = new Map(), workingWeekdays = [1, 2, 3, 4, 5]): CalendarLayer => ({
  id,
  scope,
  name: id,
  workingWeekdays,
  shiftPatternId,
  days: exceptions,
})

const company = layer('company', 'COMPANY', ONE_SHIFT.id, days([
  ['2026-06-02', 'HOLIDAY', 'Festa della Repubblica'],
  ['2026-06-24', 'HOLIDAY', 'Santo patrono'],
  ['2026-08-15', 'HOLIDAY', 'Ferragosto'],
]))
// The plant's town has another patron saint: it works on the company's 24 June.
const site = layer('site', 'SITE', null, days([['2026-06-24', 'WORKING', 'Not our patron saint']]))

describe('dates and wall-clock times in Europe/Rome', () => {
  it('counts days and ISO weekdays', () => {
    expect(plusDays('2026-02-28', 1)).toBe('2026-03-01')
    expect(plusDays('2026-08-01', -1)).toBe('2026-07-31')
    expect([isoWeekday('2026-06-01'), isoWeekday('2026-06-07')]).toEqual([1, 7])
    expect(eachDay('2026-07-30', '2026-08-02')).toEqual(['2026-07-30', '2026-07-31', '2026-08-01', '2026-08-02'])
  })

  it('turns a wall-clock minute into its instant across both clock changes', () => {
    expect(localInstant('2026-06-01', 480, ROME).toISOString()).toBe('2026-06-01T06:00:00.000Z')
    expect(localInstant('2026-01-12', 480, ROME).toISOString()).toBe('2026-01-12T07:00:00.000Z')
    // A night shift's end runs into the next day.
    expect(localInstant('2026-06-01', 1800, ROME).toISOString()).toBe('2026-06-02T04:00:00.000Z')
    // 29 March 2026: 02:30 does not exist; it moves forward to 03:30 (+02:00).
    expect(localInstant('2026-03-29', 150, ROME).toISOString()).toBe('2026-03-29T01:30:00.000Z')
    // 25 October 2026: 02:30 happens twice; the first one (+02:00).
    expect(localInstant('2026-10-25', 150, ROME).toISOString()).toBe('2026-10-25T00:30:00.000Z')
  })
})

describe('shift patterns', () => {
  it('counts a weekday as its shifts less their breaks, and says the pattern in one line', () => {
    expect(weekdayMinutes(ONE_SHIFT.segments, 1)).toBe(480)
    expect(weekdayMinutes(TWO_SHIFTS.segments, 3)).toBe(930)
    expect(weekdayMinutes(TWO_SHIFTS.segments, 6)).toBe(0)
    expect(weekdayMinutes(DEFAULT_PATTERN.segments, 2)).toBe(480)
    expect(describePattern(TWO_SHIFTS.segments)).toBe('06:00-14:00 and 14:00-22:00, Monday to Friday')
    expect(describePattern([...ONE_SHIFT.segments, ...SATURDAY_MORNING.segments])).toBe('08:00-17:00, Monday to Friday; 08:00-12:00, Saturday')
    expect(shiftEndsOf(TWO_SHIFTS.segments)).toEqual(['14:00', '22:00'])
    expect(shiftEndsOf(NIGHTS.segments)).toEqual(['06:00'])
  })

  it('saves the seeded patterns and a night shift with a break after midnight', () => {
    for (const pattern of [ONE_SHIFT, TWO_SHIFTS, SATURDAY_MORNING, NIGHTS]) expect(segmentProblems(pattern.segments)).toEqual([])
  })

  it('refuses what would count time twice or lies outside a shift, every problem at its path', () => {
    expect(segmentProblems([])).toEqual([{ path: 'segments', message: 'A shift pattern has at least one shift.' }])
    expect(segmentProblems([shift(1, 360, 840), shift(1, 800, 1200)]).map((issue) => issue.path)).toEqual(['segments/1'])
    expect(segmentProblems([shift(1, 360, 840), pause(1, 900, 915)])[0]?.message).toMatch(/not inside a shift of Monday/)
    expect(segmentProblems([shift(1, 360, 840), pause(1, 600, 630), pause(1, 620, 640)]).map((issue) => issue.path)).toEqual(['segments/2'])
    // A night shift that runs into the next morning's shift, Sunday into Monday too.
    expect(segmentProblems([shift(1, 1320, 1800), shift(2, 300, 600)])[0]?.message).toMatch(/runs into the shift Tuesday 05:00-10:00/)
    expect(segmentProblems([shift(7, 1320, 1800), shift(1, 300, 600)]).map((issue) => issue.path)).toEqual(['segments/0'])
    expect(segmentProblems([shift(1, 1440, 1500)]).map((issue) => issue.path)).toEqual(['segments/0/startMinute'])
    expect(segmentProblems([shift(1, 600, 2100)]).map((issue) => issue.path)).toEqual(['segments/0/endMinute'])
    expect(segmentProblems([shift(8, 600, 700)]).map((issue) => issue.path)).toEqual(['segments/0/weekday'])
    expect(segmentProblems([{ ...shift(1, 600, 700), label: ' ' }]).map((issue) => issue.path)).toEqual(['segments/0/label'])
  })
})

describe('Italian national holidays', () => {
  it('computes Easter and lists the holidays of a year, 4 October from 2026', () => {
    expect([easterSunday(2025), easterSunday(2026), easterSunday(2027)]).toEqual(['2025-04-20', '2026-04-05', '2027-03-28'])
    const y2026 = publicHolidays('IT', 2026)
    expect(y2026).toHaveLength(12)
    expect(y2026.map((day) => day.date)).toContain('2026-04-06')
    expect(y2026.find((day) => day.date === '2026-10-04')?.name).toMatch(/San Francesco/)
    expect(publicHolidays('IT', 2025).map((day) => day.date)).not.toContain('2025-10-04')
    expect(publicHolidays('IT', 2027).map((day) => day.date)).toContain('2027-03-29')
  })
})

describe('working time: the chain line → site → company', () => {
  // Line 3 has no calendar of its own: its day is the site's, then the company's.
  const line = workingCalendar({ layers: [site, company], patterns: PATTERNS, timeZone: ROME, window: YEAR })

  it('a line without its own calendar reads the site, then the company: a holiday on a weekday closes it', () => {
    const week = workingTimeOf(line, '2026-06-01', '2026-06-07')
    expect(week.days.map((day) => [day.date, day.reason, day.minutes])).toEqual([
      ['2026-06-01', 'WEEK', 480],
      ['2026-06-02', 'HOLIDAY', 0],
      ['2026-06-03', 'WEEK', 480],
      ['2026-06-04', 'WEEK', 480],
      ['2026-06-05', 'WEEK', 480],
      ['2026-06-06', 'DAY_OFF', 0],
      ['2026-06-07', 'DAY_OFF', 0],
    ])
    expect([week.workingDays, week.minutes]).toEqual([4, 1920])
    const holiday = dayOf(line, '2026-06-02')
    expect([holiday.name, holiday.decidedBy]).toEqual(['Festa della Repubblica', { calendarId: 'company', scope: 'COMPANY' }])
    // The week of the most specific calendar decides a plain day; the pattern comes from the company.
    expect(dayOf(line, '2026-06-01')).toMatchObject({ decidedBy: { calendarId: 'site', scope: 'SITE' }, pattern: { code: '1T', source: 'CALENDAR', calendarId: 'company' } })
  })

  it('the most specific exception wins: the site works on the company patron saint', () => {
    expect(dayOf(line, '2026-06-24')).toMatchObject({ reason: 'WORKING', working: true, minutes: 480, decidedBy: { calendarId: 'site' } })
    const companyOnly = workingCalendar({ layers: [company], patterns: PATTERNS, timeZone: ROME, window: YEAR })
    expect(dayOf(companyOnly, '2026-06-24')).toMatchObject({ reason: 'HOLIDAY', working: false })
  })

  it("a line's own calendar: its pattern and an extra Saturday; a WORKING day without a pattern works a normal day", () => {
    const ownLine = layer('line', 'LINE', TWO_SHIFTS.id, days([
      ['2026-11-07', 'WORKING', 'Extra Saturday', SATURDAY_MORNING.id],
      ['2026-11-14', 'WORKING', 'Another Saturday'],
    ]))
    const calendar = workingCalendar({ layers: [ownLine, site, company], patterns: PATTERNS, timeZone: ROME, window: YEAR })
    expect(dayOf(calendar, '2026-11-06')).toMatchObject({ minutes: 930, pattern: { code: '2T', calendarId: 'line' } })
    expect(dayOf(calendar, '2026-11-07')).toMatchObject({ minutes: 240, pattern: { code: 'SAT-AM', source: 'DAY' }, shiftsOfWeekday: 6 })
    expect(dayOf(calendar, '2026-11-14')).toMatchObject({ minutes: 930, pattern: { code: '2T' }, shiftsOfWeekday: 1 })
    // Ferragosto falls on a Saturday: closed by the company even for the line.
    expect(dayOf(calendar, '2026-08-15')).toMatchObject({ reason: 'HOLIDAY', working: false })
  })

  it('a weekday of the working week the pattern has no shift on is open without working time, and says so', () => {
    const sixDays = workingCalendar({ layers: [layer('site', 'SITE', ONE_SHIFT.id, new Map(), [1, 2, 3, 4, 5, 6])], patterns: PATTERNS, timeZone: ROME, window: YEAR })
    expect(dayOf(sixDays, '2026-06-06')).toMatchObject({ open: true, working: false, minutes: 0, issue: 'NO_SHIFTS' })
  })

  it('without any calendar: Monday to Friday, one shift (the planning default)', () => {
    const none = workingCalendar({ layers: [], patterns: PATTERNS, timeZone: ROME, window: YEAR })
    expect(dayOf(none, '2026-06-02')).toMatchObject({ working: true, minutes: 480, decidedBy: null, pattern: { source: 'DEFAULT' } })
    expect(dayOf(none, '2026-06-06')).toMatchObject({ working: false, reason: 'DAY_OFF', decidedBy: null })
  })

  it('the next working day and N working days skip the holiday; a search past the loaded dates says so', () => {
    expect(nextWorkingDay(line, '2026-06-01')).toEqual({ date: '2026-06-03' })
    expect(addWorkingDays(line, '2026-06-01', 4)).toEqual({ date: '2026-06-08' })
    expect(addWorkingDays(line, '2026-06-03', -1)).toEqual({ date: '2026-06-01' })
    expect(addWorkingDays(line, '2026-06-02', 0)).toEqual({ date: '2026-06-03' })
    expect(addWorkingDays(line, '2026-06-03', 0)).toEqual({ date: '2026-06-03' })
    expect(addWorkingDays(line, '2026-12-30', 5)).toEqual({ beyond: '2026-12-31' })
    expect(() => dayOf(line, '2027-01-04')).toThrow(OutsideWindowError)
  })

  it('working minutes between two times count the stretches inside them only', () => {
    // Monday 10:00 to Wednesday 09:00: 10-12 and 13-17 on Monday, the holiday nothing, 08-09 on Wednesday.
    expect(workingMinutesBetween(line, new Date('2026-06-01T08:00:00Z'), new Date('2026-06-03T07:00:00Z'))).toBe(420)
    expect(workingMinutesBetween(line, new Date('2026-06-03T07:00:00Z'), new Date('2026-06-01T08:00:00Z'))).toBe(0)
  })
})

describe('working time on the clock-change days (Europe/Rome)', () => {
  const nights = workingCalendar({ layers: [layer('line', 'LINE', NIGHTS.id, new Map(), [1, 2, 3, 4, 5, 6])], patterns: PATTERNS, timeZone: ROME, window: YEAR })

  it('a night shift across the change counts the minutes really worked: 7 hours in March, 9 in October', () => {
    expect(dayOf(nights, '2026-03-21').minutes).toBe(450)
    // Saturday 28 March 22:00 → Sunday 06:00: one hour less (the 30-minute break stays).
    expect(dayOf(nights, '2026-03-28').minutes).toBe(390)
    // Saturday 24 October 22:00 → Sunday 06:00: one hour more.
    expect(dayOf(nights, '2026-10-24').minutes).toBe(510)
    const october = dayOf(nights, '2026-10-24').shifts[0]!
    expect([october.start.toISOString(), october.end.toISOString()]).toEqual(['2026-10-24T20:00:00.000Z', '2026-10-25T05:00:00.000Z'])
  })

  it("an early shift on the change Sunday itself, and a night shift's minutes after midnight", () => {
    const sundays = workingCalendar({ layers: [layer('site', 'SITE', SUNDAY_EARLY.id, new Map(), [7])], patterns: PATTERNS, timeZone: ROME, window: YEAR })
    expect([dayOf(sundays, '2026-03-22').minutes, dayOf(sundays, '2026-03-29').minutes, dayOf(sundays, '2026-10-25').minutes]).toEqual([480, 420, 540])
    // Tuesday 00:00 to 06:00 holds Monday's night shift after midnight, less its 02:00-02:30 break.
    expect(workingMinutesBetween(nights, new Date('2026-06-08T22:00:00Z'), new Date('2026-06-09T04:00:00Z'))).toBe(330)
  })
})

describe("a supplier's closed days and the lead time across them", () => {
  // Closed from Monday 27 July to Tuesday 4 August: across the month end.
  const supplierLayer = layer('supplier', 'SUPPLIER', null, days(eachDay('2026-07-27', '2026-08-04').map((date) => [date, 'CLOSURE', 'Summer closure'] as [string, DayKind, string])))
  const supplier = workingCalendar({ layers: [supplierLayer], patterns: new Map(), timeZone: ROME, window: YEAR, supplier: true })

  it('lists the closed days as one span across the month end, and the weekly days off', () => {
    const closed = closedDaysOf(supplier, '2026-07-01', '2026-08-31')
    expect(closed).toHaveLength(9)
    expect(closedSpansOf(closed)).toEqual([{ from: '2026-07-27', to: '2026-08-04', kind: 'CLOSURE', name: 'Summer closure', days: 9 }])
    expect(weeklyDaysOffOf(supplier)).toEqual([6, 7])
    expect(weeklyDaysOffOf(null)).toEqual([6, 7])
    expect(closedDaysOf(null, '2026-07-01', '2026-08-31')).toEqual([])
    expect(dayOf(supplier, '2026-07-28')).toMatchObject({ open: false, working: false, minutes: null })
    expect(dayOf(supplier, '2026-07-24')).toMatchObject({ open: true, working: true, minutes: null })
  })

  it('orders by the need date less the lead time, not counting the closed days; arrives the same way', () => {
    const orderBy = orderByDate(supplier, '2026-08-10', 14)
    expect([orderBy.date, orderBy.skipped.length, orderBy.skipped[0]?.date, orderBy.skipped.at(-1)?.date, orderBy.capped]).toEqual(['2026-07-18', 9, '2026-07-27', '2026-08-04', false])
    // Without a calendar (or closures elsewhere): plain calendar days.
    expect(orderByDate(null, '2026-08-10', 14).date).toBe('2026-07-27')
    expect(orderByDate(supplier, '2026-10-10', 14)).toMatchObject({ date: '2026-09-26', skipped: [] })
    expect(arrivalDate(supplier, '2026-07-20', 14)).toMatchObject({ date: '2026-08-12', capped: false })
    expect(orderByDate(supplier, '2026-08-10', 0).date).toBe('2026-08-10')
    expect(() => orderByDate(supplier, '2026-08-10', -1)).toThrow(RangeError)
  })

  it("a supplier's calendar stands alone", () => {
    expect(() => workingCalendar({ layers: [supplierLayer, company], patterns: PATTERNS, timeZone: ROME, window: YEAR, supplier: true })).toThrow(/stands alone/)
    expect(() => workingCalendar({ layers: [site, supplierLayer], patterns: PATTERNS, timeZone: ROME, window: YEAR })).toThrow(/never in a chain/)
    expect(() => workingCalendar({ layers: [layer('x', 'SITE', 'missing')], patterns: PATTERNS, timeZone: ROME, window: YEAR })).toThrow(/not loaded/)
  })
})

describe('the rules of keeping calendars', () => {
  it('checks weekdays, ranges and what a day may carry', () => {
    expect(weekdaysProblems([])).toHaveLength(1)
    expect(weekdaysProblems([0, 1])).toHaveLength(1)
    expect(weekdaysProblems([1, 2, 3])).toEqual([])
    expect(rangeProblems('2026-01-01', '2026-12-31')).toEqual([])
    expect(rangeProblems('2026-01-01', '2027-01-01')).toEqual([])
    expect(rangeProblems('2026-01-01', '2027-01-02')[0]?.message).toMatch(/at most 366 days; this one has 367/)
    expect(rangeProblems('2026-02-02', '2026-02-01')[0]?.message).toMatch(/ends/)
    expect(dayProblems('SITE', { kind: 'CLOSURE', shiftPatternId: 'p' })).toHaveLength(1)
    expect(dayProblems('SUPPLIER', { kind: 'WORKING', shiftPatternId: 'p' })).toHaveLength(1)
    expect(dayProblems('LINE', { kind: 'WORKING', shiftPatternId: 'p' })).toEqual([])
  })
})

describe('the catalogues', () => {
  it('declares the permissions and gives them to the templates the design names', () => {
    for (const name of ['calendars.view', 'calendars.manage', 'calendars.suppliers.manage']) expect(FACTORY_PERMISSIONS.isDeclared(name)).toBe(true)
    const holds = (key: string) => templateOf(key)!.permissions.filter((permission) => permission.startsWith('calendars.'))
    expect(holds('planner')).toEqual(['calendars.manage', 'calendars.suppliers.manage', 'calendars.view'])
    expect(holds('admin')).toEqual(['calendars.manage', 'calendars.view'])
    expect(holds('buyer')).toEqual(['calendars.suppliers.manage', 'calendars.view'])
    for (const key of ['finance', 'sales', 'production_manager', 'floor_supervisor', 'read_only']) expect(holds(key)).toEqual(['calendars.view'])
    expect(holds('owner')).toHaveLength(3)
    for (const key of ['operator', 'team_leader', 'quality_inspector', 'warehouse']) expect(holds(key)).toEqual([])
  })

  it('declares the events with strict payloads', () => {
    const payload = { calendarId: '0190a0b0-0000-7000-8000-000000000001', scope: 'SITE', companyId: null, siteId: null, lineId: null, workCentreId: null, partyId: null, change: 'DAYS_SET', from: '2026-08-10', to: '2026-08-21', days: 10 }
    expect(EVENT_CATALOGUE.parse('calendar.changed', 1, payload)).toEqual(payload)
    expect(() => EVENT_CATALOGUE.parse('calendar.changed', 1, { ...payload, minutes: 3 })).toThrow()
    expect(EVENT_CATALOGUE.find('calendar.shift_pattern_changed', 1)?.live?.permission).toBe('calendars.view')
  })
})
