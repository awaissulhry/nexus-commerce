import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '../../auth/permissions/catalogue'
import { templateOf } from '../../auth/roles/templates'
import { EVENT_CATALOGUE } from '../../events/catalogue'
import { events } from '../../plant-statutory/events'
import { PLANT_CHECKS_MANAGE } from './permissions'
import { checkReport, intervalWords, reportFingerprintText, type CheckReportInput } from './report'
import {
  addInterval,
  addMonths,
  checkTypeProblems,
  daysBetween,
  dueStateOf,
  INTERVAL_MAX,
  jobDefaultsOf,
  jobProblemOf,
  keptUntilOf,
  lockWordsOf,
  nextDueAfter,
  projectedDates,
  reminderDue,
  reminderFromOf,
  resultProblems,
  STATUTORY_REFUSALS,
  takesJob,
  takesLock,
} from './rules'

describe('calendar days, as the database adds them', () => {
  it('adds months on the last day of a shorter month, and years from 29 February to 28 February', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28')
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29')
    expect(addMonths('2026-11-20', 3)).toBe('2027-02-20')
    expect(addMonths('2026-12-15', -12)).toBe('2025-12-15')
    expect(addInterval('2024-02-29', 3, 'YEAR')).toBe('2027-02-28')
    expect(addInterval('2026-11-20', 2, 'WEEK')).toBe('2026-12-04')
    expect(addInterval('2026-12-31', 1, 'DAY')).toBe('2027-01-01')
    expect(daysBetween('2026-11-03', '2026-12-03')).toBe(30)
    expect(daysBetween('2026-11-03', '2026-11-01')).toBe(-2)
  })
})

describe('check types', () => {
  it('asks a code, words in both languages, the law in words, an interval up to ten years and three to thirty years of keeping', () => {
    expect(checkTypeProblems({ code: 'PRESS_GUARDS', labelIt: 'Protezioni', labelEn: 'Guards', legalBasis: 'D.Lgs. 81/2008 art. 71', defaultInterval: 3, defaultIntervalUnit: 'MONTH', retentionYears: 3 }, true)).toEqual([])
    const problems = checkTypeProblems({ code: 'press guards', labelIt: ' ', labelEn: 'Guards', legalBasis: '', defaultInterval: 11, defaultIntervalUnit: 'YEAR', retentionYears: 2, labelI18n: { en: 'x', ro: '' } }, true)
    expect(problems.map((problem) => problem.path)).toEqual(['code', 'labelIt', 'labelI18n/en', 'labelI18n/ro', 'legalBasis', 'defaultInterval', 'retentionYears'])
    expect(problems.find((problem) => problem.path === 'retentionYears')?.message).toContain('D.Lgs. 81/2008 art. 71')
    // A change names only what changes; the code is never asked again.
    expect(checkTypeProblems({ legalBasis: 'DPR 462/2001' }, false)).toEqual([])
    expect(checkTypeProblems({ defaultInterval: 4 }, false).map((problem) => problem.path)).toEqual(['defaultInterval'])
    expect(INTERVAL_MAX).toEqual({ DAY: 3660, WEEK: 520, MONTH: 120, YEAR: 10 })
  })
})

describe('plans and results', () => {
  const plan = { interval: 3, intervalUnit: 'MONTH' as const, firstDueOn: '2026-08-20' }

  it('keeps a result at least three years, longer when its type says so', () => {
    expect(keptUntilOf('2026-11-20', 3)).toBe('2029-11-20')
    expect(keptUntilOf('2026-11-20', 1)).toBe('2029-11-20')
    expect(keptUntilOf('2026-11-20', 5)).toBe('2031-11-20')
  })

  it("moves the plan to the result's date, else to the day it was done plus the interval, never before the first date", () => {
    expect(nextDueAfter(plan, { performedOn: '2026-11-20', nextDueOn: null })).toBe('2027-02-20')
    expect(nextDueAfter(plan, { performedOn: '2026-11-20', nextDueOn: '2027-01-10' })).toBe('2027-01-10')
    expect(nextDueAfter(plan, { performedOn: '2026-01-01', nextDueOn: null })).toBe('2026-08-20')
  })

  it('says overdue, due within 30 days, planned or ended', () => {
    expect(dueStateOf({ status: 'ACTIVE', nextDueOn: '2026-11-01' }, '2026-11-03')).toEqual({ state: 'OVERDUE', days: -2 })
    expect(dueStateOf({ status: 'ACTIVE', nextDueOn: '2026-12-03' }, '2026-11-03')).toEqual({ state: 'DUE_SOON', days: 30 })
    expect(dueStateOf({ status: 'ACTIVE', nextDueOn: '2026-12-04' }, '2026-11-03').state).toBe('PLANNED')
    expect(dueStateOf({ status: 'ENDED', nextDueOn: '2026-11-01' }, '2026-11-03').state).toBe('ENDED')
  })

  it('reminds once per due date, when its window opens', () => {
    const due = { status: 'ACTIVE' as const, nextDueOn: '2026-12-01', reminderDays: 14, lastRemindedAt: null }
    expect(reminderFromOf(due)).toBe('2026-11-17')
    expect(reminderDue(due, '2026-11-16')).toBe(false)
    expect(reminderDue(due, '2026-11-17')).toBe(true)
    expect(reminderDue({ ...due, lastRemindedAt: new Date('2026-11-17T06:00:00Z') }, '2026-11-20')).toBe(false)
    expect(reminderDue({ ...due, status: 'ENDED' }, '2026-11-20')).toBe(false)
    expect(reminderDue({ ...due, reminderDays: 0 }, '2026-12-01')).toBe(true)
  })

  it('projects the coming checks of a plan on the calendar, from its next due date', () => {
    expect(projectedDates({ nextDueOn: '2026-11-30', interval: 1, intervalUnit: 'MONTH' }, '2026-12-01', '2027-03-31')).toEqual(['2026-12-30', '2027-01-30', '2027-02-28', '2027-03-30'])
    expect(projectedDates({ nextDueOn: '2026-11-30', interval: 1, intervalUnit: 'YEAR' }, '2026-12-01', '2027-03-31')).toEqual([])
  })

  it("checks a result's own fields: done by today, remarks unless passed, who did it, a next due date after the day, a correction with why", () => {
    expect(resultProblems({ performedOn: '2026-11-03', outcome: 'PASSED', performedBy: 'Inspector (made-up)' }, '2026-11-03')).toEqual([])
    const problems = resultProblems({ performedOn: '2026-11-04', outcome: 'FAILED', performedBy: ' ', nextDueOn: '2026-11-04', correctsId: '018f0000-0000-7000-8000-000000000001' }, '2026-11-03')
    expect(problems.map((problem) => problem.path)).toEqual(['performedOn', 'remarks', 'performedBy', 'nextDueOn', 'correctionReason'])
    expect(resultProblems({ performedOn: '2026-11-03', outcome: 'PASSED', performedBy: 'x', correctionReason: 'typo' }, '2026-11-03').map((problem) => problem.path)).toEqual(['correctsId'])
  })

  it('makes a job of a failed check or of remarks, and locks only on a failed one', () => {
    expect([takesJob('FAILED'), takesJob('PASSED_WITH_REMARKS'), takesJob('PASSED')]).toEqual([true, true, false])
    expect([takesLock('FAILED'), takesLock('PASSED_WITH_REMARKS')]).toEqual([true, false])
    expect(jobDefaultsOf('FAILED')).toEqual({ type: 'SAFETY', priority: 'P1' })
    expect(jobDefaultsOf('PASSED_WITH_REMARKS')).toEqual({ type: 'CORRECTIVE', priority: 'P2' })
    expect(jobProblemOf({ outcome: 'FAILED', typeLabel: 'Guards', performedOn: '2026-11-20', remarks: 'Front guard off' })).toBe('Failed check "Guards" of 2026-11-20: Front guard off')
    expect(lockWordsOf({ typeLabel: 'Guards', performedOn: '2026-11-20', remarks: 'Front guard off', note: null })).toBe('Locked as unsafe after the failed check "Guards" of 2026-11-20: Front guard off')
  })

  it('names every refusal once', () => {
    expect(new Set(STATUTORY_REFUSALS).size).toBe(STATUTORY_REFUSALS.length)
  })
})

describe('the check report', () => {
  const result = { id: 'r2', performedOn: '2026-11-20', outcome: 'FAILED' as const, remarks: 'Front guard off its hinges', performedBy: 'In house (made-up)', outsideBody: null, nextDueOn: null, keptUntil: '2029-11-20', correctsOn: null, correctionReason: null, correctedOn: null }
  const input: CheckReportInput = {
    language: 'en',
    createdAt: '2026-11-21T08:00:00.000Z',
    company: { name: 'Made-up Leather S.r.l.', lines: ['Registered office: Via Esempio 1'], legal: 'Made-up Leather S.r.l.' },
    machine: { assetNumber: 'SEED-CP-01', make: 'Made-up', modelName: 'Press 20', serialNumber: null, site: 'A1 Main plant' },
    checkType: { code: 'PRESS_GUARDS', labelIt: 'Protezioni', labelEn: 'Guards and two-hand control', legalBasis: 'D.Lgs. 81/2008 art. 71', retentionYears: 3 },
    plan: { interval: 3, intervalUnit: 'MONTH', nextDueOn: '2027-02-20', ended: false },
    result,
    files: [],
    register: [result, { ...result, id: 'r1', performedOn: '2026-08-20', outcome: 'PASSED', remarks: null, nextDueOn: '2026-11-20', keptUntil: '2029-08-20' }],
    sample: false,
  }

  it('prints the result, the law, the next due date of the plan, the register with this one marked', () => {
    const report = checkReport(input)
    expect(report.title).toBe('Periodic check report')
    expect(report.sample).toBeNull()
    expect(report.facts).toContainEqual({ label: 'Legal basis', value: 'D.Lgs. 81/2008 art. 71' })
    expect(report.facts).toContainEqual({ label: 'Next due', value: '20/02/2027' })
    expect(report.facts).toContainEqual({ label: 'Plan interval', value: 'every 3 months' })
    expect(report.facts).toContainEqual({ label: 'Reports on file', value: 'no report uploaded' })
    expect(report.rows.map((row) => [row.seq, row.material, row.kind])).toEqual([
      ['2', '20/11/2026 (this one)', 'Failed'],
      ['1', '20/08/2026', 'Passed'],
    ])
    expect(report.intro).toContain('D.Lgs. 81/2008 art. 71: results kept at least 3 years')
    expect(checkReport({ ...input, checkType: { ...input.checkType, retentionYears: 5 } }).intro).toContain("this check's results are kept 5 years")
    expect(report.fileName).toBe('Check-report-SEED-CP-01-PRESS_GUARDS-2026-11-20.pdf')
    const italian = checkReport({ ...input, language: 'it', sample: true })
    expect(italian.sample).toBe('ANTEPRIMA - non conservato')
    expect(italian.facts[0]).toEqual({ label: 'Verifica', value: 'Protezioni (PRESS_GUARDS)' })
    expect(intervalWords('it', 1, 'YEAR')).toBe('ogni anno')
  })

  it('has the same fingerprint text for the same contents, whatever the day it is made', () => {
    const { createdAt: _at, sample: _sample, ...contents } = input
    expect(reportFingerprintText(contents)).toBe(reportFingerprintText({ ...contents }))
    expect(reportFingerprintText({ ...contents, files: ['report.pdf'] })).not.toBe(reportFingerprintText(contents))
  })
})

describe('catalogues', () => {
  it('declares plant.checks.manage and gives it to the maintenance and production manager templates', () => {
    expect(FACTORY_PERMISSIONS.isDeclared(PLANT_CHECKS_MANAGE)).toBe(true)
    expect(templateOf('maintenance')?.permissions).toContain(PLANT_CHECKS_MANAGE)
    expect(templateOf('production_manager')?.permissions).toContain(PLANT_CHECKS_MANAGE)
    expect(templateOf('owner')?.permissions).toContain(PLANT_CHECKS_MANAGE)
    expect(templateOf('planner')?.permissions).not.toContain(PLANT_CHECKS_MANAGE)
  })

  it('assembles the four events, office screens only', () => {
    expect(events.map((event) => event.type)).toEqual(['machine_check_type.changed', 'machine_check_plan.changed', 'machine_check.recorded', 'machine_check.due'])
    for (const event of events) {
      expect(EVENT_CATALOGUE.get(event.type, 1)).toBeDefined()
      expect(event.live?.floor ?? null).toBeNull()
    }
  })
})
