import { describe, expect, it } from 'vitest'
import { dayAfter, dayBefore, freezePlan, partsProblems, periodProblems, standardOn, unitCostOf, type StandardPeriod } from './rules'

/** Standard costs (B-W2a-21; FIN-024), pure: the parts and their sum, the period, the freeze. Made-up figures. */

const frozen = (id: string, validFrom: string, validTo: string | null, currency = 'EUR'): StandardPeriod => ({ id, status: 'FROZEN', validFrom, validTo, currency })

describe('a standard cost', () => {
  it('is the exact sum of its parts, each 0 or more with at most 6 places', () => {
    expect(unitCostOf({ materialCost: '4.2', labourCost: '0.5', subcontractCost: '0', overheadCost: '0.123456' })).toBe('4.823456')
    expect(unitCostOf({ materialCost: '0', labourCost: '0', subcontractCost: '0', overheadCost: '0' })).toBe('0')
    expect(partsProblems({ materialCost: '-1', labourCost: '0.1234567' })).toEqual([
      { path: 'body/materialCost', message: 'A cost is 0 or more.' },
      { path: 'body/labourCost', message: 'Expected a decimal with at most 12 digits before and 6 after the dot.' },
    ])
    expect(partsProblems({ materialCost: '4.2' })).toEqual([])
  })

  it('has a period whose end is not before its start', () => {
    expect(periodProblems('2026-10-01', null)).toEqual([])
    expect(periodProblems('2026-10-01', '2026-09-30')).toEqual([{ path: 'body/validTo', message: 'The last day is not before the first day (2026-10-01).' }])
    expect(periodProblems('2026-13-01', null)[0]?.path).toBe('body/validFrom')
    expect(dayBefore('2027-01-01')).toBe('2026-12-31')
    expect(dayBefore('2026-03-01')).toBe('2026-02-28')
    expect(dayAfter('2026-12-31')).toBe('2027-01-01')
  })

  it('in force on a day: the newest frozen one holding it, in the currency', () => {
    const rows = [frozen('a', '2026-01-01', '2026-09-30'), frozen('b', '2026-10-01', null), { ...frozen('c', '2026-11-01', null), status: 'DRAFT' as const }, frozen('d', '2026-10-01', null, 'CHF')]
    expect(standardOn(rows, '2026-09-30')?.id).toBe('a')
    expect(standardOn(rows, '2026-12-01', 'EUR')?.id).toBe('b')
    expect(standardOn(rows, '2026-12-01', 'CHF')?.id).toBe('d')
    expect(standardOn(rows, '2025-12-31')).toBeNull()
  })
})

describe('freezing', () => {
  const target = { id: 't', validFrom: '2027-01-01', validTo: null }

  it('ends the open frozen standard before it on the day before its first day', () => {
    expect(freezePlan(target, [])).toEqual({ end: null, problem: null })
    expect(freezePlan(target, [frozen('a', '2026-10-01', null)])).toEqual({ end: { id: 'a', validTo: '2026-12-31' }, problem: null })
    // One that ended before needs nothing.
    expect(freezePlan(target, [frozen('a', '2026-01-01', '2026-06-30')])).toEqual({ end: null, problem: null })
  })

  it('is refused in words when another frozen standard would overlap', () => {
    expect(freezePlan(target, [frozen('later', '2027-04-01', null)]).problem).toBe('The standard frozen from 2027-04-01 covers part of this period: give this one a last day before 2027-04-01, or a first day after that one ends.')
    expect(freezePlan({ ...target, validTo: '2027-03-31' }, [frozen('later', '2027-04-01', null)])).toEqual({ end: null, problem: null })
    expect(freezePlan(target, [frozen('closed', '2026-10-01', '2027-02-28')]).problem).toBe('The standard frozen from 2026-10-01 to 2027-02-28 covers 2027-01-01; its end is set already: start this one after 2027-02-28.')
    expect(freezePlan(target, [frozen('same', '2027-01-01', null)]).problem).toMatch(/^The standard frozen from 2027-01-01 covers part of this period/)
  })
})
