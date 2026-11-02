import { describe, expect, it } from 'vitest'
import type { ClockFact } from '../clock/rules'
import { guaranteedPayOf } from '../schemes/pay'
import { reportRows } from '../reports/earnings/report'
import { baseKey, entryKey, frozenBases, periodMakeUp, piecesAmount, planLedger, samePay, type LedgerRow, type Wanted } from './ledger'
import { clockAt, clockRuleApplies, lockPhrase, monthAfter, moveRefusal, paidRuleOf, payablePieces, paysOn, periodChecks, rateFor, skillWeightOf, traineeOn, voidedScans, windowsOf, type PeriodFacts, type RateCandidate } from './rules'
import { statementOf, type PayLine } from './statement'

/** Earnings and pay periods (B-W2b-43), pure. Figures are made up. The law: c.c. arts. 2100-2101. */

const at = (text: string): Date => new Date(`2026-03-10T${text}:00.000Z`)
const clock = (id: string, kind: ClockFact['kind'], time: string, more: Partial<ClockFact> = {}): ClockFact => ({ id, kind, source: 'BADGE', occurredAt: at(time), voidsEventId: null, flags: [], ...more })
const row = (over: Partial<LedgerRow> & { id: string; idempotencyKey: string }): LedgerRow => ({ pieces: 2, minutes: null, rate: '1.5', amount: 300, reversalOfId: null, ...over })
const want = (over: Partial<Wanted> & { key: string }): Wanted => ({ pieces: 2, minutes: null, rate: '1.5', amount: 300, ...over })
const rate = (over: Partial<RateCandidate> & { entryId: string }): RateCandidate => ({ operationId: 'SEW', sizeBand: 'ALL', ratePerPiece: '1.5', standardMinutes: '10', currency: 'EUR', status: 'PUBLISHED', effectiveFrom: '2026-01-01', effectiveTo: null, styleId: null, lineId: null, ...over })

describe('piece-pay windows (GATE-PIECE-PAY)', () => {
  it('pays inside the latest window and the earlier ones, and never outside them', () => {
    const windows = windowsOf({ onFrom: '2026-03-10', offFrom: '2026-04-01', earlierWindows: [{ from: '2026-01-05', to: '2026-02-01' }] })
    expect(paysOn(windows, '2026-01-05')).toBe(true)
    expect(paysOn(windows, '2026-01-31')).toBe(true)
    expect(paysOn(windows, '2026-02-01')).toBe(false)
    expect(paysOn(windows, '2026-03-31')).toBe(true)
    expect(paysOn(windows, '2026-04-01')).toBe(false)
  })

  it('a site with no window pays nothing, and an open window has no end', () => {
    expect(paysOn(windowsOf({ onFrom: null, offFrom: null, earlierWindows: [] }), '2026-03-10')).toBe(false)
    expect(paysOn(windowsOf({ onFrom: '2026-03-10', offFrom: null, earlierWindows: [] }), '2030-01-01')).toBe(true)
  })
})

describe('scans pay only while clocked in (MES-264)', () => {
  it('reads where the person stood at the moment of the scan', () => {
    const events = [clock('in', 'IN', '06:00'), clock('break', 'BREAK_OUT', '10:00'), clock('back', 'BREAK_IN', '10:15'), clock('out', 'OUT', '14:00')]
    expect(clockAt(events, at('05:59')).hold).toBe('NOT_CLOCKED_IN')
    expect(clockAt(events, at('09:00'))).toEqual({ hold: null, clockEventId: 'in' })
    expect(clockAt(events, at('10:05')).hold).toBe('ON_BREAK')
    expect(clockAt(events, at('13:00')).hold).toBe(null)
    expect(clockAt(events, at('14:30')).hold).toBe('NOT_CLOCKED_IN')
  })

  it('takes into account a void written later: the clock-in it voids never was', () => {
    const events = [clock('in', 'IN', '06:00'), clock('void', 'VOID', '20:00', { source: 'MANUAL', voidsEventId: 'in' })]
    expect(clockAt(events, at('09:00')).hold).toBe('NOT_CLOCKED_IN')
  })

  it('a MANUAL clock-in (no floor worker on it) counts like any other', () => {
    expect(clockAt([clock('hr', 'IN', '06:00', { source: 'MANUAL' })], at('09:00'))).toEqual({ hold: null, clockEventId: 'hr' })
  })

  it('holds only where the rule can be read: the scheme asks for it and the clock is on', () => {
    expect(clockRuleApplies({ payOnlyWhileClockedIn: true, attendanceGateOpen: true })).toBe(true)
    expect(clockRuleApplies({ payOnlyWhileClockedIn: false, attendanceGateOpen: true })).toBe(false)
    expect(clockRuleApplies({ payOnlyWhileClockedIn: true, attendanceGateOpen: false })).toBe(false)
    expect(clockRuleApplies({ payOnlyWhileClockedIn: null, attendanceGateOpen: true })).toBe(true)
  })
})

describe('what a bundle pays', () => {
  const scan = (id: string, kind: string, good: number, correctsId: string | null = null) => ({ id, kind, correctsId, goodQuantity: good })

  it('a report pays what the partials did not', () => {
    expect([...payablePieces([scan('p', 'PARTIAL', 4), scan('r', 'REPORT', 10)])]).toEqual([['p', 4], ['r', 6]])
  })

  it('an undone report pays nothing; a correction pays its own count', () => {
    expect(payablePieces([scan('r', 'REPORT', 10), scan('u', 'UNDO', 0, 'r')]).size).toBe(0)
    expect([...payablePieces([scan('r', 'REPORT', 10), scan('c', 'CORRECTION', 8, 'r')])]).toEqual([['c', 8]])
    expect([...voidedScans([scan('r', 'REPORT', 10), scan('c', 'CORRECTION', 8, 'r')])]).toEqual(['r'])
  })

  it('never pays a report below nothing', () => {
    expect(payablePieces([scan('p', 'PARTIAL', 9), scan('r', 'REPORT', 5)]).get('r')).toBe(0)
  })

  it('finds the rate in force, the closest one first', () => {
    const work = { day: '2026-03-10', operationId: 'SEW', styleId: 'S1', lineId: 'L1', size: 'M' }
    const general = rate({ entryId: 'general' })
    const style = rate({ entryId: 'style', styleId: 'S1' })
    const line = rate({ entryId: 'line', styleId: 'S1', lineId: 'L1' })
    const size = rate({ entryId: 'size', styleId: 'S1', lineId: 'L1', sizeBand: 'M' })
    expect(rateFor([general], work)?.entryId).toBe('general')
    expect(rateFor([general, style], work)?.entryId).toBe('style')
    expect(rateFor([general, style, line], work)?.entryId).toBe('line')
    expect(rateFor([general, style, line, size], work)?.entryId).toBe('size')
  })

  it('never pays a draft, a cancelled version, another operation, style or line, or a day outside the version', () => {
    const work = { day: '2026-03-10', operationId: 'SEW', styleId: 'S1', lineId: 'L1', size: 'M' }
    for (const bad of [rate({ entryId: 'a', status: 'DRAFT' }), rate({ entryId: 'b', status: 'CANCELLED' }), rate({ entryId: 'c', operationId: 'PACK' }), rate({ entryId: 'd', styleId: 'S2' }), rate({ entryId: 'e', lineId: 'L2' }), rate({ entryId: 'f', effectiveFrom: '2026-03-11' }), rate({ entryId: 'g', effectiveTo: '2026-03-09' }), rate({ entryId: 'h', sizeBand: 'XL' })]) expect(rateFor([bad], work)).toBe(null)
    expect(rateFor([rate({ entryId: 'old', status: 'SUPERSEDED', effectiveTo: '2026-03-10' })], work)?.entryId).toBe('old')
  })
})

describe('waiting does not cut pay (MES-148; c.c. art. 2100)', () => {
  const average = { waitingPay: 'AVERAGE' } as const
  const guaranteed = { waitingPay: 'GUARANTEED' } as const

  it('waiting on a help call is paid by the scheme, even with a code that says unpaid', () => {
    expect(paidRuleOf({ waiting: true, payRule: 'UNPAID' }, average)).toBe('AVERAGE')
    expect(paidRuleOf({ waiting: true, payRule: 'UNPAID' }, guaranteed)).toBe('GUARANTEED')
  })

  it('other time pays by its code, and only an unpaid code pays nothing', () => {
    expect(paidRuleOf({ waiting: false, payRule: 'AVERAGE' }, guaranteed)).toBe('AVERAGE')
    expect(paidRuleOf({ waiting: false, payRule: 'BASE' }, average)).toBe('GUARANTEED')
    expect(paidRuleOf({ waiting: false, payRule: 'UNPAID' }, average)).toBe(null)
  })
})

describe('the append-only ledger (MES-256)', () => {
  const key = entryKey.scan('s1')

  it('adds what is missing, under its own key', () => {
    expect(planLedger([], [want({ key })], () => true)).toEqual({ reverse: [], add: [{ ...want({ key }), entryKey: key }] })
  })

  it('leaves an entry that already pays this: a repeated event writes nothing', () => {
    const rows = [row({ id: 'e1', idempotencyKey: key })]
    expect(samePay(rows[0]!, want({ key, rate: '1.500000' }))).toBe(true)
    expect(planLedger(rows, [want({ key, rate: '1.500000' })], () => true)).toEqual({ reverse: [], add: [] })
  })

  it('corrects by a reversal and a new entry, never an edit', () => {
    const rows = [row({ id: 'e1', idempotencyKey: key })]
    const plan = planLedger(rows, [want({ key, pieces: 3, amount: 450 })], () => true)
    expect(plan.reverse.map((item) => item.id)).toEqual(['e1'])
    expect(plan.add.map((item) => item.entryKey)).toEqual([`${key}#2`])
  })

  it('counts a third round after a reversed second', () => {
    const rows = [row({ id: 'e1', idempotencyKey: key }), row({ id: 'r1', idempotencyKey: entryKey.reverse('e1'), reversalOfId: 'e1', pieces: -2, amount: -300 }), row({ id: 'e2', idempotencyKey: `${key}#2`, pieces: 3, amount: 450 })]
    const plan = planLedger(rows, [want({ key, pieces: 4, amount: 600 })], () => true)
    expect(plan.reverse.map((item) => item.id)).toEqual(['e2'])
    expect(plan.add[0]!.entryKey).toBe(`${key}#3`)
    expect(baseKey(`${key}#3`)).toBe(key)
  })

  it('reverses what nothing wants any more, only in the families it manages', () => {
    const rows = [row({ id: 'e1', idempotencyKey: key }), row({ id: 'e2', idempotencyKey: entryKey.makeUp('p', 'x') })]
    expect(planLedger(rows, [], (base) => base.startsWith('scan:')).reverse.map((item) => item.id)).toEqual(['e1'])
  })

  it('leaves a source a person corrected: a later run does not pay it again', () => {
    const rows = [row({ id: 'e1', idempotencyKey: key }), row({ id: 'r1', idempotencyKey: entryKey.correct('e1'), reversalOfId: 'e1', pieces: -2, amount: -300 })]
    expect(planLedger(rows, [want({ key })], () => true)).toEqual({ reverse: [], add: [] })
  })

  it('says which sources a person froze: the statement must leave them out too', () => {
    const rows = [row({ id: 'e1', idempotencyKey: `${key}#2` }), row({ id: 'r1', idempotencyKey: entryKey.correct('e1'), reversalOfId: 'e1' }), row({ id: 'e2', idempotencyKey: entryKey.makeUp('p', 'x') }), row({ id: 'r2', idempotencyKey: entryKey.reverse('e2'), reversalOfId: 'e2' })]
    expect([...frozenBases(rows)]).toEqual([key])
  })

  it('a reversal by the system does not freeze the source', () => {
    const rows = [row({ id: 'e1', idempotencyKey: key }), row({ id: 'r1', idempotencyKey: entryKey.reverse('e1'), reversalOfId: 'e1', pieces: -2, amount: -300 })]
    expect(planLedger(rows, [want({ key })], () => true).add.map((item) => item.entryKey)).toEqual([`${key}#2`])
  })

  it('rounds pieces × rate half up, once', () => {
    expect(piecesAmount(3, '11.583333', 'EUR')).toBe(3475)
    expect(piecesAmount(1, '0.005', 'EUR')).toBe(1)
  })
})

describe('the make-up to guaranteed pay', () => {
  const scheme = { id: 'a', guaranteedHourlyRate: '9', traineeHourlyRate: '6', currency: 'EUR' }
  const later = { id: 'b', guaranteedHourlyRate: '12', traineeHourlyRate: null, currency: 'EUR' }

  it('tops up to the guaranteed pay of the paid minutes', () => {
    expect(periodMakeUp([{ scheme, minutes: 480, trainee: false }], 5000)).toMatchObject({ minutes: 480, guaranteed: 7200, earned: 5000, makeUp: 2200 })
  })

  it('never goes below zero: what was earned stands', () => {
    expect(periodMakeUp([{ scheme, minutes: 480, trainee: false }], 9000)?.makeUp).toBe(0)
  })

  it('counts a trainee day at the trainee rate', () => {
    expect(periodMakeUp([{ scheme, minutes: 480, trainee: true }, { scheme, minutes: 480, trainee: false }], 0)?.guaranteed).toBe(4800 + 7200)
  })

  it('counts each scheme for its own days', () => {
    const made = periodMakeUp([{ scheme, minutes: 60, trainee: false }, { scheme: later, minutes: 60, trainee: false }], 0)!
    expect(made.guaranteed).toBe(guaranteedPayOf(scheme, { minutesPresent: 60 }) + guaranteedPayOf(later, { minutesPresent: 60 }))
    expect(made.minutes).toBe(120)
    expect(made.ratePerMinute).toBe('0.175')
  })

  it('no minute, no make-up', () => {
    expect(periodMakeUp([], 0)).toBe(null)
    expect(periodMakeUp([{ scheme, minutes: 0, trainee: false }], 0)).toBe(null)
  })
})

describe('trainees and skill weights', () => {
  it('a trainee until the day, unless signed off before', () => {
    const spans = [{ since: '2026-03-01', traineeUntil: '2026-03-31', signedOffOn: '2026-03-15' }]
    expect(traineeOn(spans, '2026-03-14')).toBe(true)
    expect(traineeOn(spans, '2026-03-15')).toBe(false)
    expect(traineeOn(spans, '2026-02-28')).toBe(false)
  })

  it('weighs a level, and an unknown level as learning', () => {
    expect(['LEARNING', 'CAN_DO', 'EXPERT', 'TRAINER', null, 'OTHER'].map(skillWeightOf)).toEqual(['1', '2', '3', '3', '1', '1'])
  })
})

describe('the period', () => {
  it('moves only as the guard allows, in words', () => {
    expect(moveRefusal('OPEN', 'RUN')).toBe(null)
    expect(moveRefusal('PREVIEW', 'RUN')).toBe(null)
    expect(moveRefusal('REVIEW', 'RUN')?.code).toBe('WRONG_STATE')
    expect(moveRefusal('OPEN', 'START_REVIEW')?.code).toBe('WRONG_STATE')
    expect(moveRefusal('PREVIEW', 'LOCK')?.code).toBe('WRONG_STATE')
    expect(moveRefusal('REVIEW', 'LOCK')).toBe(null)
    expect(moveRefusal('LOCKED', 'RUN')?.message).toContain('never changes')
  })

  it('names the next month across a year and the phrase to type', () => {
    expect(monthAfter('2026-12')).toBe('2027-01')
    expect(lockPhrase('2026-10')).toBe('LOCK 2026-10')
  })

  it('blocks on what would change the pay and only tells the rest', () => {
    const none: PeriodFacts = { heldOpen: 0, daysOpen: 0, overtimePending: 0, blocksWaiting: 0, bonusSchemes: 0, scansWithoutRate: 0, workersWithoutEmployee: 0, disputesOpen: 0, sitesWithoutClock: 0 }
    expect(periodChecks(none)).toEqual([])
    expect(periodChecks({ ...none, heldOpen: 2, daysOpen: 1, overtimePending: 1, blocksWaiting: 3, bonusSchemes: 1 }).every((check) => check.blocking)).toBe(true)
    expect(periodChecks({ ...none, scansWithoutRate: 1, workersWithoutEmployee: 2, disputesOpen: 1, sitesWithoutClock: 1 }).some((check) => check.blocking)).toBe(false)
    expect(periodChecks({ ...none, heldOpen: 1 })[0]!.words).toBe('1 scan is held: resolve them.')
  })
})

describe('the worker statement (MES-261; c.c. art. 2101 c.3)', () => {
  const line = (over: Partial<PayLine>): PayLine => ({ kind: 'SCAN', operationCode: 'SEW', operationName: 'Sew', standardMinutes: '10', pieces: 2, minutes: null, rate: '1.5', sharePct: null, amount: 300, code: null, correctsMonth: null, words: null, ...over })
  const facts = { currency: 'EUR', attendance: null, makeUp: null, held: { open: 0, counted: 0, notPaid: 0 }, disputes: { open: 0, answered: 0 }, defects: { scrap: 0, rework: 0 } }

  it('gives pieces per operation, minutes, rates and earnings', () => {
    const built = statementOf({ ...facts, lines: [line({}), line({ pieces: 3, amount: 450 }), line({ operationCode: 'PACK', operationName: 'Pack', standardMinutes: '2', pieces: 5, rate: '0.3', amount: 150 })] })
    expect(built.summary.lines).toEqual([
      { operationCode: 'PACK', operationName: 'Pack', pieces: 5, minutes: '10.000', rate: '0.3', sharePct: null, amount: 150 },
      { operationCode: 'SEW', operationName: 'Sew', pieces: 5, minutes: '50.000', rate: '1.5', sharePct: null, amount: 750 },
    ])
    expect(built.earningsAmount).toBe(900)
  })

  it('a line reported and reversed leaves nothing', () => {
    const built = statementOf({ ...facts, lines: [line({}), line({ pieces: -2, amount: -300 })] })
    expect(built.summary.lines).toEqual([])
    expect(built.earningsAmount).toBe(0)
  })

  it('with no make-up computed, the statement carries none', () => {
    expect(statementOf({ ...facts, lines: [line({})] }).makeUpAmount).toBe(0)
  })

  it('keeps paid time, corrections and make-up apart, and the make-up out of the earnings', () => {
    const built = statementOf({
      ...facts,
      makeUp: { minutes: 480, ratePerMinute: '0.15', guaranteed: 7200, earned: 1000, amount: 6200 },
      lines: [line({ amount: 700 }), line({ kind: 'OFF_STANDARD', operationCode: null, code: 'WAIT_HELP', pieces: null, minutes: '20.000', rate: '0.15', amount: 300 }), line({ kind: 'ADJUSTMENT', operationCode: null, pieces: null, rate: null, amount: -50, words: 'Made-up correction' }), line({ correctsMonth: '2026-02', amount: 150 })],
    })
    expect(built.summary.time).toEqual([{ code: 'WAIT_HELP', minutes: '20.000', rate: '0.15', amount: 300 }])
    expect(built.summary.corrections.map((item) => [item.kind, item.month, item.amount])).toEqual([['ADJUSTMENT', null, -50], ['SCAN', '2026-02', 150]])
    expect(built.earningsAmount).toBe(700 + 300 - 50 + 150)
    expect(built.makeUpAmount).toBe(6200)
  })
})

describe('the earnings report (MES-304)', () => {
  it('sums per group: earnings, make-up and its share, a team share as its part of the pieces', () => {
    const rows = reportRows([
      { group: 'L1', kind: 'SCAN', employeeId: 'a', pieces: 10, sharePct: null, amount: 7500 },
      { group: 'L1', kind: 'TEAM_SPLIT', employeeId: 'b', pieces: 4, sharePct: '25', amount: 500 },
      { group: 'L1', kind: 'MAKE_UP', employeeId: 'a', pieces: null, sharePct: null, amount: 2000 },
      { group: 'L2', kind: 'OFF_STANDARD', employeeId: 'c', pieces: null, sharePct: null, amount: 100 },
    ])
    expect(rows).toEqual([
      { key: 'L1', people: 2, pieces: '11.000', earnings: 8000, makeUp: 2000, makeUpSharePct: '20.00' },
      { key: 'L2', people: 1, pieces: '0.000', earnings: 100, makeUp: 0, makeUpSharePct: '0.00' },
    ])
  })

  it('a reversal counts against its entry, so a corrected scan is counted once', () => {
    const rows = reportRows([
      { group: 'L1', kind: 'SCAN', employeeId: 'a', pieces: 10, sharePct: null, amount: 1000 },
      { group: 'L1', kind: 'SCAN', employeeId: 'a', pieces: -10, sharePct: null, amount: -1000 },
      { group: 'L1', kind: 'SCAN', employeeId: 'a', pieces: 8, sharePct: null, amount: 800 },
    ])
    expect(rows[0]).toMatchObject({ pieces: '8.000', earnings: 800 })
  })

  it('with no pay there is no share', () => {
    expect(reportRows([{ group: 'L1', kind: 'SCAN', employeeId: 'a', pieces: 0, sharePct: null, amount: 0 }])[0]!.makeUpSharePct).toBe(null)
  })
})
