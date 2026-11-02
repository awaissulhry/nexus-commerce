import { describe, expect, it } from 'vitest'
import { rulesInForce, type LimitRule, type PlannedWork } from '../shifts/limits'
import { averageCheck, blockingChecks, limitChecks, raisedChecks, restCheck, workOfDays, yearlyCapCheck, type WorkedDay } from './checks'
import { LAW_VALUES, ruleProblems, type RuleInput } from './rules'

/**
 * Working-time limits against worked time (B-W2b-42; MES-232; D.Lgs. 66/2003 arts. 4, 5, 7, 8). The Rome clock is UTC+1 on
 * these made-up days of November 2026 (Monday the 2nd to Sunday the 8th).
 */

const ROME = 'Europe/Rome'
const place = { companyId: 'c', siteId: 's' }
const rules = rulesInForce([], place)
const blocking = (rule: LimitRule): LimitRule => ({ ...rule, action: 'BLOCK' })
const at = (date: string, local: string) => {
  const [hour, minute] = local.split(':').map(Number)
  return new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), hour! - 1, minute!))
}
const day = (date: string, from: string, to: string, presentMinutes = 450): WorkedDay => ({ date, firstInAt: at(date, from), lastOutAt: at(date, to), presentMinutes, breakMinutes: 30 })
const planned = (date: string, from: string, to: string): PlannedWork => ({ date, kind: 'SHIFT', start: at(date, from), end: at(date, to), minutes: 450, breakMinutes: 30 })
const rule = (input: Partial<RuleInput>): RuleInput => ({ kind: 'DAILY_REST', limitMinutes: 660, breakMinutes: null, referenceMonths: null, action: 'WARN', alertRoles: [], source: 'LAW', legalReference: 'D.Lgs. 66/2003 art. 7', ...input })

describe('a limit a company keeps', () => {
  it('takes the law or something stricter when it says LAW', () => {
    expect(ruleProblems(rule({}))).toEqual([])
    expect(ruleProblems(rule({ limitMinutes: 720 }))).toEqual([])
    expect(ruleProblems(rule({ kind: 'OVERTIME_YEARLY_CAP', limitMinutes: 12000, legalReference: 'D.Lgs. 66/2003 art. 5' }))).toEqual([])
  })

  it('refuses a looser value without the CCNL that allows it (rest in one direction, hours in the other)', () => {
    expect(ruleProblems(rule({ limitMinutes: 600 })).map((problem) => problem.path)).toEqual(['limitMinutes'])
    expect(ruleProblems(rule({ limitMinutes: 600 }))[0]!.message).toContain('needs the CCNL article')
    expect(ruleProblems(rule({ kind: 'OVERTIME_YEARLY_CAP', limitMinutes: 18000 })).map((problem) => problem.path)).toEqual(['limitMinutes'])
    expect(ruleProblems(rule({ limitMinutes: 600, source: 'CCNL', legalReference: 'SAMPLE CCNL art. 12' }))).toEqual([])
  })

  it('keeps each part to its kind: the break, the reference period, the law named', () => {
    expect(ruleProblems(rule({ breakMinutes: 10 })).map((problem) => problem.path)).toEqual(['breakMinutes'])
    expect(ruleProblems(rule({ referenceMonths: 4 })).map((problem) => problem.path)).toEqual(['referenceMonths'])
    expect(ruleProblems(rule({ kind: 'BREAK_AFTER', limitMinutes: 360, breakMinutes: 5 })).map((problem) => problem.path)).toEqual(['breakMinutes'])
    expect(ruleProblems(rule({ kind: 'WEEKLY_AVERAGE', limitMinutes: 2880, referenceMonths: 6 })).map((problem) => problem.path)).toEqual(['referenceMonths'])
    expect(ruleProblems(rule({ kind: 'WEEKLY_AVERAGE', limitMinutes: 2880, referenceMonths: 6, source: 'CCNL' }))).toEqual([])
    expect(ruleProblems(rule({ kind: 'WEEKLY_AVERAGE', limitMinutes: 2880 })).map((problem) => problem.path)).toEqual(['referenceMonths'])
    expect(ruleProblems(rule({ legalReference: '  ' })).map((problem) => problem.path)).toEqual(['legalReference'])
  })

  it('names whom it alerts once each, by the role’s key', () => {
    expect(ruleProblems(rule({ alertRoles: ['admin', 'floor_supervisor'] }))).toEqual([])
    expect(ruleProblems(rule({ alertRoles: ['admin', 'admin'] })).map((problem) => problem.path)).toEqual(['alertRoles'])
    expect(ruleProblems(rule({ alertRoles: ['Not a key'] })).map((problem) => problem.path)).toEqual(['alertRoles'])
  })

  it('keeps the same figures as the limit engine for the law', () => {
    expect(LAW_VALUES.DAILY_REST.limitMinutes).toBe(rules.DAILY_REST.limitMinutes)
    expect(LAW_VALUES.WEEKLY_AVERAGE.limitMinutes).toBe(rules.WEEKLY_AVERAGE.limitMinutes)
    expect(LAW_VALUES.OVERTIME_YEARLY_CAP.limitMinutes).toBe(rules.OVERTIME_YEARLY_CAP.limitMinutes)
    expect(LAW_VALUES.BREAK_AFTER.breakMinutes).toBe(rules.BREAK_AFTER.breakMinutes)
  })
})

describe('the yearly overtime cap (art. 5 c.3)', () => {
  const cap = rules.OVERTIME_YEARLY_CAP
  it('turns NEAR at 90% and OVER past the limit, in words with the law', () => {
    expect(yearlyCapCheck({ date: '2026-11-04', minutes: 13499 }, cap).state).toBe('OK')
    expect(yearlyCapCheck({ date: '2026-11-04', minutes: 13500 }, cap).state).toBe('NEAR')
    expect(yearlyCapCheck({ date: '2026-11-04', minutes: 15000 }, cap).state).toBe('NEAR')
    const over = yearlyCapCheck({ date: '2026-11-04', minutes: 15060 }, cap)
    expect(over.state).toBe('OVER')
    expect(over.words).toBe('Overtime in 2026: 251 h of 250 h — at most 250 h a year (D.Lgs. 66/2003 art. 5)')
    expect(over.values).toMatchObject({ year: '2026', usedMinutes: 15060, limitMinutes: 15000 })
  })
})

describe('the rest (art. 7)', () => {
  const rest = rules.DAILY_REST
  it('is OVER when the days as worked broke it', () => {
    const check = restCheck({ work: workOfDays([day('2026-11-04', '14:00', '23:30'), day('2026-11-05', '06:00', '14:00')]), date: '2026-11-04', workedDates: new Set(['2026-11-04', '2026-11-05']), timeZone: ROME }, rest)
    expect(check.state).toBe('OVER')
    expect(check.date).toBe('2026-11-05')
    expect(check.words).toBe('Rest 6 h 30 min between 23:30 (4 Nov) and 06:00 — minimum 11 h (D.Lgs. 66/2003 art. 7)')
  })

  it('is NEAR when tomorrow’s planned shift would break it: the warning comes before', () => {
    const work = [...workOfDays([day('2026-11-04', '14:00', '23:30')]), planned('2026-11-05', '06:00', '14:00')]
    expect(restCheck({ work, date: '2026-11-04', workedDates: new Set(['2026-11-04']), timeZone: ROME }, rest).state).toBe('NEAR')
  })

  it('is OK with 11 hours or more, also for a day entered by hand with no clock-out on the next day', () => {
    const workedDates = new Set(['2026-11-04', '2026-11-05'])
    expect(restCheck({ work: workOfDays([day('2026-11-04', '06:00', '14:00'), day('2026-11-05', '06:00', '14:00')]), date: '2026-11-04', workedDates, timeZone: ROME }, rest).state).toBe('OK')
    expect(restCheck({ work: workOfDays([day('2026-11-04', '06:00', '14:00'), { date: '2026-11-05', firstInAt: at('2026-11-05', '06:00'), lastOutAt: null, presentMinutes: 0, breakMinutes: 0 }]), date: '2026-11-04', workedDates, timeZone: ROME }, rest).state).toBe('OK')
  })
})

describe('the weekly average (art. 4)', () => {
  const average = rules.WEEKLY_AVERAGE
  const week = (monday: string, minutes: number): PlannedWork => ({ date: monday, kind: 'SHIFT', start: null, end: null, minutes, breakMinutes: 0 })

  it('averages the worked weeks since the person started (17 weeks at most)', () => {
    const fortyEight = averageCheck({ work: [week('2026-10-26', 2880), week('2026-11-02', 2880)], date: '2026-11-04', employedFrom: '2026-10-26' }, average)
    expect(fortyEight).toMatchObject({ state: 'NEAR', values: { averageMinutes: 2880, weeks: 2 } })
    const over = averageCheck({ work: [week('2026-10-26', 2880), week('2026-11-02', 3060)], date: '2026-11-04', employedFrom: '2026-10-26' }, average)
    expect(over.state).toBe('OVER')
    expect(over.words).toBe('49 h 30 min a week on average over 2 weeks — at most 48 h a week on average over 4 months (D.Lgs. 66/2003 art. 4)')
    expect(averageCheck({ work: [week('2026-11-02', 2400)], date: '2026-11-04', employedFrom: '2026-01-05' }, average).state).toBe('OK')
  })

  it('counts a newcomer’s empty weeks before their first day for nothing', () => {
    expect(averageCheck({ work: [week('2026-11-02', 3000)], date: '2026-11-04', employedFrom: '2026-11-02' }, average).state).toBe('OVER')
  })
})

describe('what the checks do', () => {
  const input = { date: '2026-11-04', workedDates: new Set<string>(), timeZone: ROME, employedFrom: '2026-01-05', work: [] as PlannedWork[], overtimeMinutes: 0 }

  it('always gives the three the design lists, in its order', () => {
    expect(limitChecks({ ...input, rules }).map((check) => [check.rule, check.state])).toEqual([
      ['OVERTIME_YEARLY_CAP', 'OK'],
      ['DAILY_REST', 'OK'],
      ['WEEKLY_AVERAGE', 'OK'],
    ])
  })

  it('holds an approval only when a blocking rule is passed: WARN shows, NEAR never holds', () => {
    const near = limitChecks({ ...input, rules: { ...rules, OVERTIME_YEARLY_CAP: blocking(rules.OVERTIME_YEARLY_CAP) }, overtimeMinutes: 14000 })
    expect(blockingChecks(near)).toEqual([])
    expect(raisedChecks(near).map((check) => check.rule)).toEqual(['OVERTIME_YEARLY_CAP'])
    const warned = limitChecks({ ...input, rules, overtimeMinutes: 16000 })
    expect(blockingChecks(warned)).toEqual([])
    const held = limitChecks({ ...input, rules: { ...rules, OVERTIME_YEARLY_CAP: blocking(rules.OVERTIME_YEARLY_CAP) }, overtimeMinutes: 16000 })
    expect(blockingChecks(held).map((check) => check.rule)).toEqual(['OVERTIME_YEARLY_CAP'])
  })
})
