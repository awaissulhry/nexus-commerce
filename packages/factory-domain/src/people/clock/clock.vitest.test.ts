import { describe, expect, it } from 'vitest'
import { DEFAULT_PATTERN } from '../../calendars/patterns'
import { FACTORY_PERMISSIONS } from '../../auth/permissions/catalogue'
import { EVENT_DEFINITIONS } from '../../events/catalogue'
import { FLOOR_SYNC_KINDS, QUEUED_ACTIONS } from '../../floor-sync/kinds'
import { summaryOf } from '../../floor-sync/rules'
import {
  actionRefusal,
  actionsOf,
  autoClockOutDue,
  autoClockOutReason,
  breakDueWords,
  clockAheadRefusal,
  CLOCK_RULES,
  countedEvents,
  LAW_BREAK_RULE,
  minutesSoFar,
  nextActionOf,
  nextBreakOf,
  repeatOf,
  shiftForClockIn,
  shiftsOfDay,
  shiftToShow,
  sourceAndFlags,
  standingOf,
  stateWords,
  todayFrom,
  type ClockFact,
  type ClockKind,
  type ClockSource,
} from './rules'

/**
 * Clock in and out (B-W2b-33; MES-223, MES-224, MES-227, MES-239, MES-199). Made-up times on Friday 30 October 2026 in
 * Europe/Rome (UTC+1 after the clocks went back on 25 October): 08:00 Rome is 07:00Z. The law the tests name: D.Lgs.
 * 66/2003 art. 7 (11 hours of daily rest: a clock-in older than 13 hours was never closed) and art. 8 (breaks).
 */

const ROME = 'Europe/Rome'
const at = (iso: string) => new Date(iso)
let serial = 0
const event = (kind: ClockKind, iso: string, extra: Partial<ClockFact> = {}): ClockFact => ({
  id: `e${String(++serial).padStart(3, '0')}`,
  kind,
  source: 'BADGE' as ClockSource,
  occurredAt: at(iso),
  voidsEventId: null,
  flags: [],
  ...extra,
})

describe('the state from the counted events', () => {
  it('leaves VOID events and the events they void out, oldest first', () => {
    const inn = event('IN', '2026-10-30T07:00:00Z')
    const twice = event('IN', '2026-10-30T07:01:00Z')
    const voids = event('VOID', '2026-10-30T07:01:00Z', { source: 'MANUAL', voidsEventId: twice.id })
    expect(countedEvents([voids, twice, inn]).map((row) => row.id)).toEqual([inn.id])
  })

  it('is IN after a clock-in, ON_BREAK after a break out, IN after the return, OUT after a clock-out', () => {
    const now = at('2026-10-30T12:00:00Z')
    const inn = event('IN', '2026-10-30T07:00:00Z')
    expect(standingOf([inn], now)).toMatchObject({ state: 'IN', since: inn.occurredAt, forgotten: null, openEventId: inn.id })
    const out = event('BREAK_OUT', '2026-10-30T10:00:00Z')
    expect(standingOf([inn, out], now)).toMatchObject({ state: 'ON_BREAK', breakSince: out.occurredAt })
    expect(standingOf([inn, out, event('BREAK_IN', '2026-10-30T10:15:00Z')], now).state).toBe('IN')
    expect(standingOf([inn, event('OUT', '2026-10-30T11:00:00Z')], now)).toMatchObject({ state: 'OUT', since: null, openSince: null })
  })

  it('a clock-out ends a break; a second clock-in keeps the first; a break with no clock-in is ignored', () => {
    const now = at('2026-10-30T16:00:00Z')
    expect(standingOf([event('IN', '2026-10-30T07:00:00Z'), event('BREAK_OUT', '2026-10-30T11:00:00Z'), event('OUT', '2026-10-30T11:05:00Z')], now).state).toBe('OUT')
    const first = event('IN', '2026-10-30T07:00:00Z')
    expect(standingOf([first, event('IN', '2026-10-30T07:30:00Z')], now).since).toEqual(first.occurredAt)
    expect(standingOf([event('BREAK_OUT', '2026-10-30T10:00:00Z')], now).state).toBe('OUT')
  })

  it('a clock-in older than 13 hours was never closed (D.Lgs. 66/2003 art. 7): it counts as OUT, forgotten, still open for the rule', () => {
    const inn = event('IN', '2026-10-29T07:00:00Z')
    const standing = standingOf([inn], at('2026-10-30T06:30:00Z'))
    expect(CLOCK_RULES.openLimitMinutes).toBe(13 * 60)
    expect(standing).toMatchObject({ state: 'OUT', since: null, forgotten: inn.occurredAt, openSince: inn.occurredAt })
    expect(nextActionOf(standing)).toBe('IN')
    const refusal = actionRefusal(standing, 'OUT', { fixedBreaks: true, timeZone: ROME, now: at('2026-10-30T06:30:00Z') })
    expect(refusal).toMatchObject({ code: 'NOT_IN', final: true })
    expect(refusal!.message).toContain('29 Oct 08:00')
    expect(refusal!.fix).toContain('team leader')
  })
})

describe('what a scan and the buttons do', () => {
  const now = at('2026-10-30T12:00:00Z')
  const out = standingOf([], now)
  const inn = standingOf([event('IN', '2026-10-30T07:00:00Z')], now)
  const onBreak = standingOf([event('IN', '2026-10-30T07:00:00Z'), event('BREAK_OUT', '2026-10-30T11:00:00Z')], now)

  it('a badge scan toggles: in, out, back from the break', () => {
    expect([out, inn, onBreak].map(nextActionOf)).toEqual(['IN', 'OUT', 'BREAK_IN'])
  })

  it('the buttons: Break only where breaks are clocked', () => {
    expect(actionsOf(out, true)).toEqual(['IN'])
    expect(actionsOf(inn, true)).toEqual(['OUT'])
    expect(actionsOf(inn, false)).toEqual(['OUT', 'BREAK_OUT'])
    expect(actionsOf(onBreak, false)).toEqual(['BREAK_IN', 'OUT'])
  })

  it('refuses in words what the state does not allow, and fixed breaks are never clocked (D.Lgs. 66/2003 art. 8)', () => {
    const facts = { fixedBreaks: false, timeZone: ROME, now }
    expect(actionRefusal(out, 'IN', facts)).toBeNull()
    expect(actionRefusal(out, 'BREAK_OUT', facts)?.code).toBe('NOT_IN')
    expect(actionRefusal(inn, 'IN', facts)).toMatchObject({ code: 'ALREADY_IN', message: 'You are clocked in since 08:00.' })
    expect(actionRefusal(inn, 'BREAK_IN', facts)?.code).toBe('NOT_ON_BREAK')
    expect(actionRefusal(inn, 'OUT', facts)).toBeNull()
    expect(actionRefusal(onBreak, 'BREAK_OUT', facts)?.code).toBe('ALREADY_ON_BREAK')
    expect(actionRefusal(onBreak, 'IN', facts)).toMatchObject({ code: 'ON_BREAK', message: 'You are on a break since 12:00.' })
    expect(actionRefusal(onBreak, 'OUT', facts)).toBeNull()
    const fixed = actionRefusal(inn, 'BREAK_OUT', { ...facts, fixedBreaks: true })
    expect(fixed).toMatchObject({ code: 'BREAKS_FIXED', final: true })
    expect(fixed!.message).toContain('D.Lgs. 66/2003 art. 8')
  })

  it('a badge scanned again within a minute answers the scan before; an automatic or manual event never counts as one', () => {
    const scan = event('IN', '2026-10-30T11:59:30Z')
    expect(repeatOf(standingOf([scan], now), now)?.id).toBe(scan.id)
    expect(repeatOf(standingOf([event('IN', '2026-10-30T11:58:30Z')], now), now)).toBeNull()
    expect(repeatOf(standingOf([event('OUT', '2026-10-30T11:59:50Z', { source: 'AUTO' })], now), now)).toBeNull()
  })
})

describe('who and when: badge, name and PIN, offline (MES-239, MES-199)', () => {
  it('a badge is BADGE, a name and PIN is NAME_PIN flagged for the team leader; offline keeps the way and flags a wrong clock', () => {
    expect(sourceAndFlags({ way: 'BADGE', offline: false })).toEqual({ source: 'BADGE', flags: [] })
    expect(sourceAndFlags({ way: 'NAME', offline: false })).toEqual({ source: 'NAME_PIN', flags: ['FORGOT_BADGE'] })
    expect(sourceAndFlags({ way: 'BADGE', offline: true, skewSeconds: 30 })).toEqual({ source: 'OFFLINE', flags: [] })
    expect(sourceAndFlags({ way: 'BADGE', offline: true, skewSeconds: -301 })).toEqual({ source: 'OFFLINE', flags: ['CLOCK_SKEW'] })
    expect(sourceAndFlags({ way: 'NAME', offline: true, skewSeconds: 900 })).toEqual({ source: 'OFFLINE', flags: ['FORGOT_BADGE', 'CLOCK_SKEW'] })
    expect(sourceAndFlags({ way: 'BADGE', offline: true })).toEqual({ source: 'OFFLINE', flags: [] })
  })

  it('a tablet time more than 2 minutes in the future is never kept', () => {
    const now = at('2026-10-30T07:00:00Z')
    expect(clockAheadRefusal(at('2026-10-30T07:01:59Z'), now)).toBeNull()
    expect(clockAheadRefusal(at('2026-10-30T07:10:00Z'), now)).toMatchObject({ code: 'CLOCK_AHEAD', final: true, message: "This tablet's clock was 10 min ahead: a clock event is never kept in the future." })
  })
})

describe('shifts, breaks and minutes (MES-224)', () => {
  const segments = DEFAULT_PATTERN.segments
  it('the published roster cell wins; a day off has no shift; else the default pattern of the weekday', () => {
    const roster = { kind: 'WORK' as const, shiftLabel: 'Morning', startMinute: 360, endMinute: 840, breakMinutes: 15, patternSegments: [{ weekday: 5, kind: 'BREAK' as const, label: 'Break', startMinute: 600, endMinute: 615 }] }
    const [cell] = shiftsOfDay({ date: '2026-10-30', timeZone: ROME, roster, defaultSegments: segments })
    expect(cell).toMatchObject({ label: 'Morning', source: 'ROSTER', breakMinutes: 15, startsAt: at('2026-10-30T05:00:00Z'), endsAt: at('2026-10-30T13:00:00Z') })
    expect(cell!.breaks).toEqual([{ label: 'Break', startsAt: at('2026-10-30T09:00:00Z'), endsAt: at('2026-10-30T09:15:00Z') }])
    expect(shiftsOfDay({ date: '2026-10-30', timeZone: ROME, roster: { ...roster, kind: 'OFF', startMinute: null, endMinute: null }, defaultSegments: segments })).toEqual([])
    // The planner's default shift (B-W2b-32) keeps its source.
    expect(shiftsOfDay({ date: '2026-10-30', timeZone: ROME, roster: { ...roster, source: 'DEFAULT' }, defaultSegments: null })[0]?.source).toBe('DEFAULT')
    const [day] = shiftsOfDay({ date: '2026-10-30', timeZone: ROME, roster: null, defaultSegments: segments })
    expect(day).toMatchObject({ label: 'Day', source: 'DEFAULT', breakMinutes: 60, startsAt: at('2026-10-30T07:00:00Z'), endsAt: at('2026-10-30T16:00:00Z') })
    expect(shiftsOfDay({ date: '2026-10-31', timeZone: ROME, roster: null, defaultSegments: segments })).toEqual([])
    expect(shiftsOfDay({ date: '2026-10-30', timeZone: ROME, roster: null, defaultSegments: null })).toEqual([])
  })

  it('a clock-in belongs to the shift that ends after it and starts at most 3 hours later; none after every shift ended', () => {
    const [day] = shiftsOfDay({ date: '2026-10-30', timeZone: ROME, roster: null, defaultSegments: segments })
    expect(shiftForClockIn([day!], at('2026-10-30T06:52:00Z'))).toBe(day)
    expect(shiftForClockIn([day!], at('2026-10-30T03:30:00Z'))).toBeNull()
    expect(shiftForClockIn([day!], at('2026-10-30T16:30:00Z'))).toBeNull()
    expect(shiftToShow([day!], { since: null }, at('2026-10-30T05:00:00Z'), ROME)).toBe(day)
    expect(nextBreakOf(day!, at('2026-10-30T10:00:00Z'))).toMatchObject({ label: 'Lunch' })
    expect(nextBreakOf(day!, at('2026-10-30T13:00:00Z'))).toBeNull()
  })

  it('counts present minutes less clocked breaks, and fixed breaks only where the person was in', () => {
    const now = at('2026-10-30T13:00:00Z')
    const events = [event('IN', '2026-10-30T07:00:00Z'), event('BREAK_OUT', '2026-10-30T09:00:00Z'), event('BREAK_IN', '2026-10-30T09:20:00Z')]
    expect(minutesSoFar(events, { from: at('2026-10-29T23:00:00Z'), now, fixedBreaks: [] })).toEqual({ present: 360, clockedBreaks: 20, fixedBreaks: 0, worked: 340, sinceBreak: 220 })
    const lunch = [{ startsAt: at('2026-10-30T11:00:00Z'), endsAt: at('2026-10-30T12:00:00Z') }]
    expect(minutesSoFar([event('IN', '2026-10-30T07:00:00Z')], { from: at('2026-10-29T23:00:00Z'), now, fixedBreaks: lunch })).toMatchObject({ present: 360, fixedBreaks: 60, worked: 300 })
    // Out over lunch, back after it: the fixed break is not deducted twice.
    const split = [event('IN', '2026-10-30T07:00:00Z'), event('OUT', '2026-10-30T11:00:00Z'), event('IN', '2026-10-30T12:00:00Z')]
    expect(minutesSoFar(split, { from: at('2026-10-29T23:00:00Z'), now, fixedBreaks: lunch })).toMatchObject({ present: 300, fixedBreaks: 0, worked: 300 })
  })

  it('the window of today starts at midnight, or at an open night clock-in', () => {
    const now = at('2026-10-30T02:00:00Z')
    expect(todayFrom({ since: null }, now, ROME)).toEqual(at('2026-10-29T23:00:00Z'))
    expect(todayFrom({ since: at('2026-10-29T21:00:00Z') }, now, ROME)).toEqual(at('2026-10-29T21:00:00Z'))
  })

  it('reminds a clocked break after 6 hours at a stretch (D.Lgs. 66/2003 art. 8)', () => {
    expect(breakDueWords(359, LAW_BREAK_RULE)).toBeNull()
    expect(breakDueWords(360, LAW_BREAK_RULE)).toBe('You have worked 6 h without a break: take at least 10 minutes (D.Lgs. 66/2003 art. 8).')
  })

  it('says the state in words', () => {
    const now = at('2026-10-30T11:12:00Z')
    expect(stateWords(standingOf([event('IN', '2026-10-30T06:58:00Z')], now), 252, now, ROME)).toBe('In since 07:58 · 4 h 12 min today')
    expect(stateWords(standingOf([], now), 0, now, ROME)).toBe('Not clocked in')
  })
})

describe('the automatic clock-out (MES-227)', () => {
  const [day] = shiftsOfDay({ date: '2026-10-30', timeZone: ROME, roster: null, defaultSegments: DEFAULT_PATTERN.segments })
  const inn = event('IN', '2026-10-30T06:55:00Z')

  it('closes an open clock-in at the shift end plus the tolerance, once that time has come', () => {
    expect(autoClockOutDue(standingOf([inn], at('2026-10-30T16:10:00Z')), day!, 15, at('2026-10-30T16:10:00Z'))).toBeNull()
    expect(autoClockOutDue(standingOf([inn], at('2026-10-30T16:20:00Z')), day!, 15, at('2026-10-30T16:20:00Z'))).toEqual(at('2026-10-30T16:15:00Z'))
    expect(autoClockOutReason(day!, 15, ROME)).toBe('Automatic clock-out: shift "Day" ended 17:00 + 15 min (People settings). The clock-out was missing.')
  })

  it('never without the setting, a shift, an open stretch, or after something recorded later; a forgotten one too', () => {
    const late = at('2026-10-31T09:00:00Z')
    expect(autoClockOutDue(standingOf([inn], late), day!, null, late)).toBeNull()
    expect(autoClockOutDue(standingOf([inn], late), null, 15, late)).toBeNull()
    expect(autoClockOutDue(standingOf([inn, event('OUT', '2026-10-30T16:00:00Z')], late), day!, 15, late)).toBeNull()
    expect(autoClockOutDue(standingOf([inn, event('BREAK_OUT', '2026-10-30T16:30:00Z')], late), day!, 15, late)).toBeNull()
    // Forgotten (older than 13 hours) still closes at its shift's end.
    expect(autoClockOutDue(standingOf([inn], late), day!, 15, late)).toEqual(at('2026-10-30T16:15:00Z'))
  })
})

describe('the catalogues', () => {
  it('declares people.attendance.view as a read, the two events, and the offline kind under floor.work', () => {
    expect(FACTORY_PERMISSIONS.get('people.attendance.view')?.risk).toBe('read')
    const types = EVENT_DEFINITIONS.map((definition) => definition.type as string)
    expect(types).toEqual(expect.arrayContaining(['attendance.clock_event', 'clock.out']))
    expect(FLOOR_SYNC_KINDS).toContain('people.clock.record')
    expect(QUEUED_ACTIONS['people.clock.record']).toMatchObject({ permission: 'floor.work', numbers: null })
    expect(summaryOf('people.clock.record', { action: 'IN', badgeCode: 'NEVER-SHOWN' })).toEqual({ code: 'IN' })
  })
})
