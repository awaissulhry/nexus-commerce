import { describe, expect, it } from 'vitest'
import { Dec } from '../../tax/decimal'
import { consumptionCheck, storedByKind, toleranceFor, toleranceProblems, toleranceTable, type ToleranceRow } from './rules'

const row = (rule: ToleranceRow['consumptionTolerance'], pct: string | null = null, byKind: unknown = null): ToleranceRow => ({ consumptionTolerance: rule, consumptionTolerancePct: pct, consumptionToleranceByKind: byKind })
const figures = (estimated: string, confirmed: string, note: string | null = null) => ({ estimated: new Dec(estimated), confirmed: new Dec(confirmed), note, unit: 'm', what: 'fabric' })

describe('which tolerance applies (PRD-105)', () => {
  it('company per kind, company, tenant per kind, tenant, MAY_DIFFER', () => {
    const company = row('WARN_ABOVE', '3.0000', { LEATHER: { rule: 'WARN_ABOVE', percent: '5' }, TEXTILE: { rule: 'MAY_DIFFER' } })
    const tenant = row('MATCH', null, { LINING: { rule: 'WARN_ABOVE', percent: '2' } })
    expect(toleranceFor(company, tenant, 'LEATHER')).toEqual({ rule: 'WARN_ABOVE', percent: '5', source: 'COMPANY', byKind: true })
    expect(toleranceFor(company, tenant, 'TEXTILE')).toEqual({ rule: 'MAY_DIFFER', percent: null, source: 'COMPANY', byKind: true })
    expect(toleranceFor(company, tenant, 'LINING')).toEqual({ rule: 'WARN_ABOVE', percent: '3', source: 'COMPANY', byKind: false })
    expect(toleranceFor(null, tenant, 'LINING')).toEqual({ rule: 'WARN_ABOVE', percent: '2', source: 'TENANT', byKind: true })
    expect(toleranceFor(null, tenant, 'TRIM')).toEqual({ rule: 'MATCH', percent: null, source: 'TENANT', byKind: false })
    expect(toleranceFor(null, null, 'TRIM')).toEqual({ rule: 'MAY_DIFFER', percent: null, source: 'DEFAULT', byKind: false })
    expect(toleranceTable(company, tenant)).toHaveLength(12)
  })
})

describe('the confirmation against it', () => {
  it('MATCH refuses a different figure until a note explains it', () => {
    const match = { rule: 'MATCH' as const, percent: null }
    expect(consumptionCheck(match, figures('12', '12'))).toEqual({ outcome: 'OK' })
    expect(consumptionCheck(match, figures('12', '12.6'))).toEqual({
      outcome: 'REFUSED',
      code: 'CONSUMPTION_MUST_MATCH',
      message: 'The fabric used must match the estimate: 12.6 m is 0.6 m more than the estimate of 12 m (+5%). Say why in a note, or confirm 12 m.',
    })
    expect(consumptionCheck(match, figures('12', '12.6', 'A roll end was faulty'))).toEqual({ outcome: 'OK' })
  })

  it('WARN_ABOVE warns above the percent, either way; MAY_DIFFER never', () => {
    const warn = { rule: 'WARN_ABOVE' as const, percent: '3' }
    expect(consumptionCheck(warn, figures('12', '12.3'))).toEqual({ outcome: 'OK' })
    expect(consumptionCheck(warn, figures('12', '12.6'))).toEqual({ outcome: 'WARNING', code: 'CONSUMPTION_ABOVE_TOLERANCE', message: '12.6 m of fabric is 0.6 m more than the estimate of 12 m (+5%): above the 3% tolerance.' })
    expect(consumptionCheck(warn, figures('12', '11.4'))).toMatchObject({ outcome: 'WARNING', message: expect.stringContaining('0.6 m less than the estimate of 12 m (−5%)') })
    expect(consumptionCheck({ rule: 'MAY_DIFFER', percent: null }, figures('12', '20'))).toEqual({ outcome: 'OK' })
  })
})

describe('a change of the settings', () => {
  it('wants the percent exactly with WARN_ABOVE and known material kinds', () => {
    expect(toleranceProblems({ rule: 'WARN_ABOVE', percent: '3', byKind: { LEATHER: { rule: 'WARN_ABOVE', percent: '5' } } })).toEqual([])
    expect(toleranceProblems({ rule: 'WARN_ABOVE', percent: null, byKind: null }).map((issue) => issue.path)).toEqual(['body/consumptionTolerancePct'])
    expect(toleranceProblems({ rule: 'MATCH', percent: '3', byKind: null }).map((issue) => issue.path)).toEqual(['body/consumptionTolerancePct'])
    expect(toleranceProblems({ rule: null, percent: null, byKind: { WOOL: { rule: 'MATCH' }, TRIM: { rule: 'WARN_ABOVE', percent: '101' } } }).map((issue) => issue.path)).toEqual([
      'body/consumptionToleranceByKind/WOOL',
      'body/consumptionToleranceByKind/TRIM/percent',
    ])
    expect(storedByKind({ TEXTILE: { rule: 'MAY_DIFFER' }, LEATHER: { rule: 'WARN_ABOVE', percent: '5.0' } })).toEqual({ LEATHER: { rule: 'WARN_ABOVE', percent: '5' }, TEXTILE: { rule: 'MAY_DIFFER' } })
    expect(storedByKind({})).toBeNull()
  })
})
