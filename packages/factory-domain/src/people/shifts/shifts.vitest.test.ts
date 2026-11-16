import { describe, expect, it } from 'vitest'
import { localInstant } from '../../calendars/dates'
import type { Pattern } from '../../calendars/patterns'
import { LAW_LIMITS, LIMIT_KINDS, nightWarnings, referenceWeeks, rosterWarnings, rulesInForce, warningKey, weeklyAverageWindowStart, weeklyRestWarnings, weeklyRestWindow, yearlyCapWarnings, type PlannedWork, type RuleRow } from './limits'
import { cellWords, choicesOf, defaultCellOf, mondayOf, overtimeActionRefusal, overtimePlanProblems, overtimeStageOf, sameCell, shiftFromPattern, windowProblems } from './rules'

/**
 * People › Shifts (B-W2b-32; MES-218, MES-222): the roster's cells, choices and defaults, planned overtime by agreement
 * (D.Lgs. 66/2003 art. 5), and the working-time warnings in words (arts. 4, 7, 8, 5). Made-up patterns only.
 */

const ROME = 'Europe/Rome'
const weekdays = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => from + index)
const ONE: Pattern = { id: 'p1', code: '1T', name: 'One shift', segments: weekdays(1, 5).flatMap((weekday) => [{ weekday, kind: 'SHIFT' as const, label: 'Day', startMinute: 480, endMinute: 1020 }, { weekday, kind: 'BREAK' as const, label: 'Lunch', startMinute: 720, endMinute: 780 }]) }
const TWO: Pattern = {
  id: 'p2',
  code: '2T',
  name: 'Two shifts',
  segments: weekdays(1, 5).flatMap((weekday) => [
    { weekday, kind: 'SHIFT' as const, label: 'Morning', startMinute: 360, endMinute: 840 },
    { weekday, kind: 'BREAK' as const, label: 'Break', startMinute: 600, endMinute: 615 },
    { weekday, kind: 'SHIFT' as const, label: 'Afternoon', startMinute: 840, endMinute: 1320 },
    { weekday, kind: 'BREAK' as const, label: 'Break', startMinute: 1080, endMinute: 1095 },
  ]),
}

describe('the roster cells (MES-218)', () => {
  it('offers each shift of each pattern once, with a letter only when one letter names one shift', () => {
    const choices = choicesOf([ONE, TWO])
    expect(choices.map((choice) => [choice.patternCode, choice.label, choice.startMinute, choice.endMinute, choice.breakMinutes, choice.key])).toEqual([
      ['2T', 'Morning', 360, 840, 15, 'M'],
      ['1T', 'Day', 480, 1020, 60, 'D'],
      ['2T', 'Afternoon', 840, 1320, 15, 'A'],
    ])
    expect(choices[0]!.weekdays).toEqual([1, 2, 3, 4, 5])
    // "Morning" twice with two windows: no letter for either; "O" is the day off's.
    const saturday: Pattern = { id: 'p4', code: 'SAT', name: 'Saturday', segments: [{ weekday: 6, kind: 'SHIFT', label: 'Morning', startMinute: 480, endMinute: 720 }] }
    const off: Pattern = { id: 'p5', code: 'O', name: 'Office', segments: [{ weekday: 1, kind: 'SHIFT', label: 'Office', startMinute: 540, endMinute: 1080 }] }
    expect(choicesOf([TWO, saturday, off]).filter((choice) => choice.key === null).map((choice) => `${choice.patternCode} ${choice.label}`).sort()).toEqual(['2T Morning', 'O Office', 'SAT Morning'])
  })

  it("takes a pattern's shift for a date by its label, on a weekday it does not have it the first weekday that has it", () => {
    expect(shiftFromPattern(TWO, '2027-03-09', { label: 'Afternoon' })).toEqual({ label: 'Afternoon', startMinute: 840, endMinute: 1320, breakMinutes: 15 })
    // A Saturday: the pattern has shifts Monday to Friday only.
    expect(shiftFromPattern(TWO, '2027-03-13', { label: 'Morning' })).toEqual({ label: 'Morning', startMinute: 360, endMinute: 840, breakMinutes: 15 })
    expect(shiftFromPattern(TWO, '2027-03-09', { label: 'Night' })).toBeNull()
    expect(shiftFromPattern(TWO, '2027-03-09', { label: 'Morning', startMinute: 840 })).toBeNull()
  })

  it('checks a typed window: it starts in its day, lasts up to 24 hours, the break shorter than the shift', () => {
    expect(windowProblems({ label: 'Night', startMinute: 1320, endMinute: 1800, breakMinutes: 30 })).toEqual([])
    expect(windowProblems({ label: null, startMinute: 1440, endMinute: 1500, breakMinutes: 0 }).map((issue) => issue.path)).toEqual(['startMinute'])
    expect(windowProblems({ label: null, startMinute: 600, endMinute: 600, breakMinutes: 0 }).map((issue) => issue.path)).toEqual(['endMinute'])
    expect(windowProblems({ label: null, startMinute: 600, endMinute: 700, breakMinutes: 100 }).map((issue) => issue.path)).toEqual(['breakMinutes'])
    expect(windowProblems({ label: ' ', startMinute: 600, endMinute: 700, breakMinutes: 0 }).map((issue) => issue.path)).toEqual(['label'])
  })

  it("gives the default shift: OFF on a closed day or a weekday without shifts, the weekday's one shift, none when two", () => {
    expect(defaultCellOf('2027-03-08', { pattern: ONE, open: true })).toEqual({ value: { kind: 'WORK', patternId: 'p1', shift: { label: 'Day', startMinute: 480, endMinute: 1020, breakMinutes: 60 } }, issue: null })
    expect(defaultCellOf('2027-03-08', { pattern: ONE, open: false })).toEqual({ value: { kind: 'OFF' }, issue: null })
    expect(defaultCellOf('2027-03-13', { pattern: ONE, open: true })).toEqual({ value: { kind: 'OFF' }, issue: null })
    expect(defaultCellOf('2027-03-08', { pattern: TWO, open: true })).toEqual({ value: null, issue: 'SEVERAL_SHIFTS' })
    expect(defaultCellOf('2027-03-08', { pattern: null, open: true })).toEqual({ value: null, issue: 'NO_DEFAULT' })
  })

  it('compares cells by window and break, and says them in words', () => {
    const day = { kind: 'WORK' as const, patternId: 'p1', shift: { label: 'Day', startMinute: 480, endMinute: 1020, breakMinutes: 60 } }
    expect(sameCell(day, { ...day, patternId: null })).toBe(true)
    expect(sameCell(day, { ...day, shift: { ...day.shift, breakMinutes: 30 } })).toBe(false)
    expect(sameCell({ kind: 'OFF' }, { kind: 'OFF' })).toBe(true)
    expect(sameCell(null, { kind: 'OFF' })).toBe(false)
    expect(cellWords(day)).toBe('Day 08:00-17:00')
    expect(cellWords({ kind: 'WORK', patternId: null, shift: { label: null, startMinute: 1320, endMinute: 1800, breakMinutes: 0 } })).toBe('22:00-06:00')
    expect(cellWords({ kind: 'OFF' })).toBe('Off')
    expect(cellWords(null)).toBe('No shift')
    expect(mondayOf('2027-03-14')).toBe('2027-03-08')
    expect(mondayOf('2027-03-08')).toBe('2027-03-08')
  })
})

describe('planned overtime by agreement (MES-222; D.Lgs. 66/2003 art. 5)', () => {
  it('shows an asked request as agreed once somebody said yes, and approves only then', () => {
    expect(overtimeStageOf('ASKED', 0)).toBe('ASKED')
    expect(overtimeStageOf('ASKED', 2)).toBe('AGREED')
    expect(overtimeStageOf('APPROVED', 2)).toBe('APPROVED')
    expect(overtimeActionRefusal('APPROVE', { status: 'ASKED', asked: 3, agreed: 0 })).toMatch(/only by agreement \(D\.Lgs\. 66\/2003 art\. 5\)/)
    expect(overtimeActionRefusal('APPROVE', { status: 'ASKED', asked: 3, agreed: 1 })).toBeNull()
    expect(overtimeActionRefusal('APPROVE', { status: 'DRAFT', asked: 3, agreed: 0 })).toMatch(/not asked/)
  })

  it('lets the answers change until the approval, the plan only while a draft, nothing once done or cancelled', () => {
    expect(overtimeActionRefusal('ANSWER', { status: 'ASKED', asked: 1, agreed: 0 })).toBeNull()
    expect(overtimeActionRefusal('ANSWER', { status: 'AGREED', asked: 1, agreed: 1 })).toBeNull()
    expect(overtimeActionRefusal('ANSWER', { status: 'APPROVED', asked: 1, agreed: 1 })).toMatch(/approved/)
    expect(overtimeActionRefusal('ANSWER', { status: 'DRAFT', asked: 1, agreed: 0 })).toMatch(/not asked/)
    expect(overtimeActionRefusal('EDIT', { status: 'DRAFT', asked: 1, agreed: 0 })).toBeNull()
    expect(overtimeActionRefusal('EDIT', { status: 'ASKED', asked: 1, agreed: 0 })).toMatch(/no longer changes/)
    expect(overtimeActionRefusal('ASK', { status: 'DRAFT', asked: 0, agreed: 0 })).toMatch(/Add the people/)
    expect(overtimeActionRefusal('ADD_PEOPLE', { status: 'ASKED', asked: 1, agreed: 0 })).toBeNull()
    expect(overtimeActionRefusal('ADD_PEOPLE', { status: 'APPROVED', asked: 1, agreed: 1 })).toMatch(/approved/)
    expect(overtimeActionRefusal('CANCEL', { status: 'APPROVED', asked: 1, agreed: 1 })).toBeNull()
    expect(overtimeActionRefusal('CANCEL', { status: 'DONE', asked: 1, agreed: 1 })).toMatch(/done/)
    expect(overtimeActionRefusal('CANCEL', { status: 'CANCELLED', asked: 1, agreed: 1 })).toMatch(/cancelled/)
  })

  it('checks the plan: 1 minute to 12 hours, a start in its day, a reason', () => {
    expect(overtimePlanProblems({ minutes: 120, startMinute: null, reason: 'Order for Friday' })).toEqual([])
    expect(overtimePlanProblems({ minutes: 721, startMinute: 1440, reason: ' ' }).map((issue) => issue.path)).toEqual(['minutes', 'startMinute', 'reason'])
  })
})

const row = (kind: string, fields: Partial<RuleRow> = {}): RuleRow => ({ id: `${kind}-${fields.siteId ?? fields.companyId ?? 'tenant'}`, companyId: null, siteId: null, kind, limitMinutes: LAW_LIMITS[kind as keyof typeof LAW_LIMITS]?.limitMinutes ?? 1, breakMinutes: null, referenceMonths: null, action: 'WARN', source: 'LAW', legalReference: 'D.Lgs. 66/2003', status: 'ACTIVE', ...fields })

const shift = (date: string, start: number, end: number, breakMinutes = 0): PlannedWork => {
  const from = localInstant(date, start, ROME)
  const to = localInstant(date, end, ROME)
  return { date, kind: 'SHIFT', start: from, end: to, minutes: (to.getTime() - from.getTime()) / 60_000 - breakMinutes, breakMinutes }
}

describe('working-time warnings in words (D.Lgs. 66/2003 arts. 4, 5, 7, 8)', () => {
  it('takes the most specific ACTIVE rule per kind (site, company, tenant), else the law as a warning', () => {
    const rules = rulesInForce(
      [row('DAILY_REST', { action: 'BLOCK', companyId: 'A', siteId: 'A1', legalReference: 'CCNL art. 9' }), row('DAILY_REST'), row('BREAK_AFTER', { companyId: 'A', breakMinutes: 15, source: 'CCNL' }), row('WEEKLY_AVERAGE', { status: 'ARCHIVED', limitMinutes: 1 })],
      { companyId: 'A', siteId: 'A1' },
    )
    expect(rules.DAILY_REST).toMatchObject({ action: 'BLOCK', scope: 'SITE', legalReference: 'CCNL art. 9' })
    expect(rules.BREAK_AFTER).toMatchObject({ breakMinutes: 15, scope: 'COMPANY', source: 'CCNL' })
    expect(rules.WEEKLY_AVERAGE).toMatchObject({ limitMinutes: 2880, referenceMonths: 4, action: 'WARN', source: 'DEFAULT', scope: 'DEFAULT', legalReference: 'D.Lgs. 66/2003 art. 4' })
    expect(rulesInForce([row('DAILY_REST', { action: 'BLOCK', companyId: 'A', siteId: 'A1' })], { companyId: 'A', siteId: 'A2' }).DAILY_REST.scope).toBe('DEFAULT')
  })

  const rules = rulesInForce([], { companyId: 'A', siteId: 'A1' })
  const report = (...dates: string[]) => new Set(dates)

  it('warns when the rest between two working days is under 11 hours, on the later day, with the times', () => {
    const work = [shift('2027-03-08', 840, 1320, 15), shift('2027-03-09', 360, 840, 15)]
    const warnings = rosterWarnings({ work, rules, report: report('2027-03-08', '2027-03-09'), timeZone: ROME, employedFrom: '2020-01-01' })
    expect(warnings).toEqual([
      expect.objectContaining({ rule: 'DAILY_REST', level: 'WARN', date: '2027-03-09', words: 'Rest 8 h between 22:00 (8 Mar) and 06:00 — minimum 11 h (D.Lgs. 66/2003 art. 7)', values: expect.objectContaining({ restMinutes: 480, limitMinutes: 660 }) }),
    ])
    // A night shift into the next morning is no rest; a day of 14 hours leaves less than 11 in 24.
    const night = rosterWarnings({ work: [shift('2027-03-08', 1320, 1800, 30), shift('2027-03-09', 360, 840, 15)], rules, report: report('2027-03-09'), timeZone: ROME, employedFrom: '2020-01-01' })
    expect(night.map((warning) => [warning.rule, warning.values.restMinutes])).toEqual([['DAILY_REST', 0]])
    const long = rosterWarnings({ work: [shift('2027-03-10', 360, 1200, 60)], rules, report: report('2027-03-10'), timeZone: ROME, employedFrom: '2020-01-01' })
    expect(long.map((warning) => warning.rule)).toEqual(['DAILY_REST'])
    expect(long[0]!.words).toMatch(/^A working day of 14 h \(06:00-20:00\) leaves less than 11 h of rest in 24 hours/)
  })

  it('warns when the working day passes 6 hours with less break than the rule asks (breaks and gaps count)', () => {
    const noBreak = rosterWarnings({ work: [shift('2027-03-08', 360, 840)], rules, report: report('2027-03-08'), timeZone: ROME, employedFrom: '2020-01-01' })
    expect(noBreak).toEqual([expect.objectContaining({ rule: 'BREAK_AFTER', words: '8 h of work 06:00-14:00 with 0 min of break — a break of at least 10 min once the day passes 6 h (D.Lgs. 66/2003 art. 8)' })])
    expect(rosterWarnings({ work: [shift('2027-03-08', 360, 840, 15)], rules, report: report('2027-03-08'), timeZone: ROME, employedFrom: '2020-01-01' })).toEqual([])
    // Two stretches with a gap between them: the gap is a break.
    expect(rosterWarnings({ work: [shift('2027-03-08', 360, 600), shift('2027-03-08', 630, 840)], rules, report: report('2027-03-08'), timeZone: ROME, employedFrom: '2020-01-01' })).toEqual([])
    // A CCNL asks 15 minutes.
    const ccnl = rulesInForce([row('BREAK_AFTER', { breakMinutes: 15, source: 'CCNL', legalReference: 'CCNL art. 8' })], { companyId: 'A', siteId: 'A1' })
    expect(rosterWarnings({ work: [shift('2027-03-08', 360, 840, 10)], rules: ccnl, report: report('2027-03-08'), timeZone: ROME, employedFrom: '2020-01-01' }).map((warning) => warning.law)).toEqual(['CCNL art. 8'])
  })

  it('warns when the weekly average over the reference period passes 48 hours (overtime included), counting only weeks since the start', () => {
    expect(referenceWeeks(4)).toBe(17)
    expect(weeklyAverageWindowStart('2027-03-10', rules.WEEKLY_AVERAGE)).toBe('2026-11-16')
    const tight = rulesInForce([row('WEEKLY_AVERAGE', { limitMinutes: 2400, referenceMonths: 1 })], { companyId: 'A', siteId: 'A1' })
    const weeks = ['2027-02-15', '2027-02-22', '2027-03-01', '2027-03-08']
    const work = weeks.flatMap((monday) => [0, 1, 2, 3, 4].map((offset) => shift(new Date(Date.parse(monday) + offset * 86_400_000).toISOString().slice(0, 10), 480, 1020, 60)))
    const report14 = report('2027-03-08', '2027-03-09', '2027-03-13', '2027-03-14')
    expect(rosterWarnings({ work, rules: tight, report: report14, timeZone: ROME, employedFrom: '2020-01-01' })).toEqual([])
    const saturday = [...work, shift('2027-03-13', 480, 720)]
    const warned = rosterWarnings({ work: saturday, rules: tight, report: report14, timeZone: ROME, employedFrom: '2020-01-01' })
    expect(warned).toEqual([expect.objectContaining({ rule: 'WEEKLY_AVERAGE', date: '2027-03-13', words: '44 h planned in the week of 8 Mar; 41 h a week on average over 4 weeks — at most 40 h a week on average over 1 month (D.Lgs. 66/2003)' })])
    // A newcomer since 8 March: one week, 44 h on average.
    expect(rosterWarnings({ work: saturday, rules: tight, report: report14, timeZone: ROME, employedFrom: '2027-03-08' })[0]!.values).toMatchObject({ averageMinutes: 2640, weeks: 1 })
  })

  it('warns when the planned overtime of the year passes the yearly cap', () => {
    expect(yearlyCapWarnings({ date: '2027-03-10', plannedMinutes: 15000 }, rules.OVERTIME_YEARLY_CAP)).toEqual([])
    expect(yearlyCapWarnings({ date: '2027-03-10', plannedMinutes: 15120 }, rules.OVERTIME_YEARLY_CAP)).toEqual([
      expect.objectContaining({ rule: 'OVERTIME_YEARLY_CAP', level: 'WARN', words: 'Planned overtime in 2027 would be 252 h — at most 250 h a year (D.Lgs. 66/2003 art. 5)' }),
    ])
    expect(warningKey({ rule: 'DAILY_REST', date: '2027-03-09' })).toBe('DAILY_REST|2027-03-09')
  })

  // B-W2b-GF2: the cap counts the overtime worked too, naming its hours only to a reader who may see them.
  it('counts the overtime worked this year in the yearly cap, its hours named only when shown', () => {
    expect(yearlyCapWarnings({ date: '2027-03-10', plannedMinutes: 600, workedMinutes: 14400 }, rules.OVERTIME_YEARLY_CAP)).toEqual([])
    const shown = yearlyCapWarnings({ date: '2027-03-10', plannedMinutes: 720, workedMinutes: 14400, showWorked: true }, rules.OVERTIME_YEARLY_CAP)
    expect(shown).toEqual([expect.objectContaining({ words: 'Overtime in 2027 would be 252 h (240 h worked, 12 h planned) — at most 250 h a year (D.Lgs. 66/2003 art. 5)', values: { plannedMinutes: 720, workedMinutes: 14400, limitMinutes: 15000, year: '2027' } })])
    const hidden = yearlyCapWarnings({ date: '2027-03-10', plannedMinutes: 720, workedMinutes: 14400 }, rules.OVERTIME_YEARLY_CAP)
    expect(hidden[0]!.words).toBe('Planned overtime in 2027 would pass the yearly cap together with the overtime already worked — at most 250 h a year (D.Lgs. 66/2003 art. 5)')
    expect(JSON.stringify(hidden)).not.toMatch(/14400|240 h/)
  })

  it('uses real minutes across a clock change (a night shift on the last Sunday of October is 9 hours)', () => {
    const night = shift('2026-10-24', 1320, 1800)
    expect(night.minutes).toBe(540)
  })
})

// ---- B-W2b-GF2: weekly rest (art. 9) and night work (art. 13) ----------------------------------------------------------

describe('weekly rest and night work (D.Lgs. 66/2003 arts. 9, 13)', () => {
  const rules = rulesInForce([], { companyId: 'A', siteId: 'A1' })
  const day = (from: string, offset: number) => new Date(Date.parse(`${from}T12:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10)
  /** 06:00-12:00 on each day of `from` … `days` days on, except the weekdays left off (1 Monday … 7 Sunday). */
  const mornings = (from: string, count: number, off: readonly number[] = []) =>
    Array.from({ length: count }, (_, index) => day(from, index))
      .filter((date) => !off.includes(((new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7) + 1))
      .map((date) => shift(date, 360, 720))
  const week = (monday: string) => new Set(Array.from({ length: 7 }, (_, index) => day(monday, index)))

  it('checks every limit People settings keep: the weekly rest and night work too, with the law\'s values', () => {
    expect(LIMIT_KINDS).toEqual(['DAILY_REST', 'BREAK_AFTER', 'WEEKLY_AVERAGE', 'OVERTIME_YEARLY_CAP', 'WEEKLY_REST', 'NIGHT_AVERAGE'])
    expect(rules.WEEKLY_REST).toMatchObject({ limitMinutes: 1440, legalReference: 'D.Lgs. 66/2003 art. 9', source: 'DEFAULT', action: 'WARN' })
    expect(rules.NIGHT_AVERAGE).toMatchObject({ limitMinutes: 480, legalReference: 'D.Lgs. 66/2003 art. 13', source: 'DEFAULT', action: 'WARN' })
    expect(weeklyRestWindow('2027-03-10', '2027-03-12')).toEqual({ from: '2027-02-28', to: '2027-03-22' })
  })

  it('a week off on Sunday has its rest: 24 h on top of the 11 h between shifts (42 h from Saturday noon to Monday 06:00)', () => {
    const window = weeklyRestWindow('2027-03-08', '2027-03-14')
    const work = mornings(window.from, 23, [7])
    expect(weeklyRestWarnings(work, rules.WEEKLY_REST, rules.DAILY_REST, week('2027-03-08'), window, ROME)).toEqual([])
  })

  it('warns on a week with no 35-hour rest when the 14 days around it do not make up for it, on the week\'s last day', () => {
    const window = weeklyRestWindow('2027-03-08', '2027-03-14')
    const work = mornings(window.from, 23)
    const warnings = rosterWarnings({ work, rules, report: week('2027-03-08'), timeZone: ROME, employedFrom: '2020-01-01', window })
    expect(warnings).toEqual([
      expect.objectContaining({
        rule: 'WEEKLY_REST',
        level: 'WARN',
        date: '2027-03-14',
        words: 'The longest rest in the week of 8 Mar is 18 h (from Mon 12:00 to Tue 06:00) — at least 24 h of consecutive rest every 7 days on top of the 11 h between shifts (35 h), as an average over 14 days (D.Lgs. 66/2003 art. 9)',
        values: expect.objectContaining({ restMinutes: 1080, neededMinutes: 2100, limitMinutes: 1440, dailyRestMinutes: 660, week: '2027-03-08' }),
      }),
    ])
    // A CCNL's weekly rest that BLOCKs holds the plan.
    const blocking = rulesInForce([row('WEEKLY_REST', { action: 'BLOCK', source: 'CCNL', legalReference: 'CCNL art. 12' })], { companyId: 'A', siteId: 'A1' })
    expect(weeklyRestWarnings(work, blocking.WEEKLY_REST, blocking.DAILY_REST, week('2027-03-08'), window, ROME)[0]).toMatchObject({ level: 'BLOCK', law: 'CCNL art. 12' })
  })

  it('averages over 14 days: a long rest the week before makes up for a week worked every day', () => {
    const window = weeklyRestWindow('2027-03-08', '2027-03-14')
    // Week of 1 Mar: Friday to Sunday off (90 h); week of 8 Mar: every day; week of 15 Mar: Sunday off.
    const work = [...mornings(window.from, 5), ...mornings('2027-03-08', 7), ...mornings('2027-03-15', 8, [7])]
    expect(weeklyRestWarnings(work, rules.WEEKLY_REST, rules.DAILY_REST, week('2027-03-08'), window, ROME)).toEqual([])
    // Without that long rest, the week of 8 Mar is short again.
    const tight = [...mornings(window.from, 15), ...mornings('2027-03-15', 8, [7])]
    expect(weeklyRestWarnings(tight, rules.WEEKLY_REST, rules.DAILY_REST, week('2027-03-08'), window, ROME).map((warning) => warning.date)).toEqual(['2027-03-14'])
  })

  it('never judges a week the window does not hold whole (a rest cut by the edge is not known)', () => {
    const work = mornings('2027-03-08', 7)
    expect(weeklyRestWarnings(work, rules.WEEKLY_REST, rules.DAILY_REST, week('2027-03-08'), { from: '2027-03-08', to: '2027-03-14' }, ROME)).toEqual([])
    expect(rosterWarnings({ work, rules, report: week('2027-03-08'), timeZone: ROME, employedFrom: '2020-01-01' }).filter((warning) => warning.rule === 'WEEKLY_REST')).toEqual([])
  })

  it('a night worker\'s day (3 h or more between 22:00 and 06:00) works at most 8 h; a long day shift is not night work', () => {
    const long = shift('2027-03-08', 1320, 1920, 30)
    expect(nightWarnings([long], rules.NIGHT_AVERAGE, new Set(['2027-03-08']), ROME)).toEqual([
      expect.objectContaining({ rule: 'NIGHT_AVERAGE', level: 'WARN', date: '2027-03-08', words: '9 h 30 min of work 22:00-08:00, 8 h of it at night — a night worker works at most 8 h in 24 hours (D.Lgs. 66/2003 art. 13)', values: { workMinutes: 570, nightMinutes: 480, limitMinutes: 480, from: '22:00', to: '08:00' } }),
    ])
    expect(nightWarnings([shift('2027-03-08', 1320, 1800, 30)], rules.NIGHT_AVERAGE, new Set(['2027-03-08']), ROME)).toEqual([])
    expect(nightWarnings([shift('2027-03-08', 360, 960, 30)], rules.NIGHT_AVERAGE, new Set(['2027-03-08']), ROME)).toEqual([])
    // Evening into the night: 18:00-03:00 with an hour's break is 8 h, 5 h of it at night: within the limit.
    expect(nightWarnings([shift('2027-03-08', 1080, 1620, 60)], rules.NIGHT_AVERAGE, new Set(['2027-03-08']), ROME)).toEqual([])
    // Two hours at night only: not a night worker's day, whatever its length.
    expect(nightWarnings([shift('2027-03-08', 840, 1440, 30)], rules.NIGHT_AVERAGE, new Set(['2027-03-08']), ROME)).toEqual([])
    expect(rosterWarnings({ work: [long], rules, report: new Set(['2027-03-08']), timeZone: ROME, employedFrom: '2020-01-01' }).map((warning) => warning.rule)).toEqual(['NIGHT_AVERAGE'])
  })
})
