import { describe, expect, it } from 'vitest'
import { localInstant } from '../../calendars/dates'
import type { CompanyLegal } from '../../documents/model'
import type { StatementSummary } from '../earnings/statement'
import { MYDAY_CLOSE_AFTER_MS, MYDAY_REFUSALS, monthPays, myPaceOf, officePrinterOf, targetHours } from './rules'
import { myStatementDocument } from './statement-document'

/** My day's pure rules (B-W2b-68; MES-111, MES-112): a person's pace against the line's target, and when money may show. */

const ZONE = 'Europe/Rome'
const DAY = '2026-10-29'
const at = (hour: number, minute = 0): Date => localInstant(DAY, hour * 60 + minute, ZONE)
const target = (hour: number, targetPieces: number) => ({ id: `t${hour}`, hour, targetPieces, version: 1 })
const hours = (now: Date) => targetHours({ day: DAY, timeZone: ZONE, now, targets: [target(8, 30), target(9, 30), target(10, 30), target(11, 30)] })

describe('the pace (MES-112)', () => {
  it('the worker\'s pieces against the line\'s target for the hours gone by, the running hour by its share', () => {
    const now = at(10, 30)
    expect(myPaceOf({ hours: hours(now), done: 70, since: at(8, 10), now })).toEqual({ done: 70, target: 120, targetSoFar: 75, hourTarget: 30, percent: 93, pace: 'ON_PACE' })
  })

  it('below nine tenths of it is under the target', () => {
    const now = at(10, 30)
    expect(myPaceOf({ hours: hours(now), done: 40, since: at(8, 10), now }).pace).toBe('BEHIND')
  })

  it('someone who started later is not held to the hours before their first report', () => {
    const now = at(11)
    const late = myPaceOf({ hours: hours(now), done: 28, since: at(10, 5), now })
    expect(late.targetSoFar).toBe(30)
    expect(late.pace).toBe('ON_PACE')
  })

  it('no report yet, no target or a target of nothing so far: nothing to measure, never a zero', () => {
    const now = at(10, 30)
    expect(myPaceOf({ hours: hours(now), done: 0, since: null, now })).toMatchObject({ targetSoFar: null, percent: null, pace: 'NO_TARGET' })
    expect(myPaceOf({ hours: [], done: 12, since: at(8), now })).toMatchObject({ target: null, percent: null, pace: 'NO_TARGET' })
    expect(myPaceOf({ hours: hours(at(8)), done: 1, since: at(8), now: at(8) })).toMatchObject({ targetSoFar: null, pace: 'NO_TARGET' })
  })

  it('takes no line output: the hours it builds carry none, so none can reach the answer (Owner answer F2)', () => {
    for (const hour of hours(at(10))) expect(hour.done).toBe(0)
    expect(Object.keys(myPaceOf({ hours: hours(at(10)), done: 5, since: at(8), now: at(10) })).sort()).toEqual(['done', 'hourTarget', 'pace', 'percent', 'target', 'targetSoFar'])
  })
})

describe('money and the printer', () => {
  it('a month shows money when a window of the switch touches it, and only then', () => {
    expect(monthPays([], '2026-10')).toBe(false)
    expect(monthPays([{ from: '2026-10-15', to: null }], '2026-10')).toBe(true)
    expect(monthPays([{ from: '2026-10-15', to: null }], '2026-09')).toBe(false)
    expect(monthPays([{ from: '2026-08-01', to: '2026-09-01' }], '2026-09')).toBe(false)
    expect(monthPays([{ from: '2026-08-01', to: '2026-09-02' }], '2026-09')).toBe(true)
    expect(monthPays([{ from: '2026-11-01', to: null }], '2026-10')).toBe(false)
    expect(monthPays([{ from: '2026-12-31', to: null }], '2026-12')).toBe(true)
  })

  it('one A4 printer is the office\'s; several are not guessed at: one person\'s pay stays out of the dock', () => {
    expect(officePrinterOf([])).toBeNull()
    expect(officePrinterOf(['A4'])).toBe('A4')
    expect(officePrinterOf(['A4', 'DOCK'])).toBeNull()
  })

  it('closes after a minute, shorter than a station\'s idle time; every refusal says what to do', () => {
    expect(MYDAY_CLOSE_AFTER_MS).toBe(60_000)
    for (const refusal of Object.values(MYDAY_REFUSALS)) expect(refusal.fix.length).toBeGreaterThan(5)
  })
})

describe('my statement as a document (c.c. art. 2101 c.3)', () => {
  const company: CompanyLegal = { legalName: 'Demo Factory S.r.l.', tradeName: null, address: { line1: 'Via Finta 1', postalCode: '00100', city: 'Roma', province: 'RM', country: 'IT' }, vatNumber: 'IT00000000000', fiscalCode: '00000000000', reaOffice: 'RM', reaNumber: '000000', shareCapital: '10000.00', currency: 'EUR' }
  const summary: StatementSummary = {
    currency: 'EUR',
    lines: [{ operationCode: 'SEW', operationName: 'Cucitura', pieces: 100, minutes: '150.000', rate: '0.300000', sharePct: '50', amount: 3000 }],
    time: [{ code: 'WAIT_HELP', minutes: '30.000', rate: '0.150000', amount: 450 }],
    corrections: [],
    attendance: { ordinaryMinutes: 480, approvedOvertimeMinutes: 0 },
    makeUp: { minutes: 480, ratePerMinute: '0.15', guaranteed: 7200, earned: 3450, amount: 3750 },
    held: { open: 0, counted: 1, notPaid: 0 },
    disputes: { open: 0, answered: 0 },
    defects: { scrap: 1, rework: 0 },
  }
  const input = { language: 'it' as const, company, person: { name: 'Ada Demo', code: 'E-001' }, month: '2026-09', revision: 2, approvedOn: '2026-10-05', summary, earningsAmount: 3450, makeUpAmount: 3750 }

  it('pieces, minutes, rates, earnings and make-up, in the worker\'s language, on the letterhead', () => {
    const document = myStatementDocument(input)
    expect(document.title).toBe('Il mio prospetto')
    expect(document.issuer.name).toBe('Demo Factory S.r.l.')
    expect(document.table.rows[0]).toContain('100')
    expect(document.table.rows[1]![0]).toBe('WAIT_HELP')
    expect(document.totals.at(-1)).toMatchObject({ strong: true, value: expect.stringContaining('72,00') })
    expect(document.meta.createdAt).toContain('2026-10-0')
  })

  it('the same statement gives the same document', () => {
    expect(myStatementDocument(input)).toEqual(myStatementDocument(input))
    expect(myStatementDocument({ ...input, language: 'en' }).title).toBe('My statement')
  })

  it('refuses a company without its legal data, as every company document', () => {
    expect(() => myStatementDocument({ ...input, company: { ...company, legalName: '' } })).toThrow()
  })
})
