import { describe, expect, it } from 'vitest'
import { absorb, figureProblems, holds, inForceWords, overheadKey, overlaps, perMinuteOf, periodProblems, rulesInForce, type OverheadRuleFacts } from './rules'

/** Overhead absorption rules (B-W2b-419; FIN-007), pure. Made-up rules and figures, worked out by hand. */

const rule = (id: string, over: Partial<OverheadRuleFacts>): OverheadRuleFacts => ({
  id,
  companyId: 'A',
  basis: 'PERCENT_OF_LABOUR',
  workCentreKind: null,
  value: '25',
  currency: null,
  periodStart: '2026-01-01',
  periodEnd: null,
  status: 'ACTIVE',
  ...over,
})

// Company A: 25 % of labour from January; 0.05 a sewing minute from November; every company: 2.50 a garment for the first
// half, 2.75 from July; every company's sewing: 0.03 a minute; company A's cutting: 30 % of labour; an archived one.
const RULES = [
  rule('a-labour', {}),
  rule('a-sewing-minute', { basis: 'PER_MINUTE', workCentreKind: 'SEWING', value: '0.05', currency: 'EUR', periodStart: '2026-11-01' }),
  rule('all-unit-h1', { companyId: null, basis: 'PER_UNIT', value: '2.5', currency: 'EUR', periodEnd: '2026-06-30' }),
  rule('all-unit-h2', { companyId: null, basis: 'PER_UNIT', value: '2.75', currency: 'EUR', periodStart: '2026-07-01' }),
  rule('all-sewing-minute', { companyId: null, basis: 'PER_MINUTE', workCentreKind: 'SEWING', value: '0.03', currency: 'EUR' }),
  rule('a-cutting-labour', { workCentreKind: 'CUTTING', value: '30' }),
  rule('a-archived', { basis: 'PER_MACHINE_HOUR', value: '4', currency: 'EUR', status: 'ARCHIVED' }),
]

describe('an overhead rule', () => {
  it('is a percent of labour above 0 and at most 1000 with no currency, or an amount above 0 with its currency', () => {
    expect(figureProblems({ basis: 'PERCENT_OF_LABOUR', value: '25', currency: null })).toEqual([])
    expect(figureProblems({ basis: 'PERCENT_OF_LABOUR', value: '1000.5', currency: 'EUR' }).map((issue) => issue.path)).toEqual(['body/value', 'body/currency'])
    expect(figureProblems({ basis: 'PER_MINUTE', value: '0.05', currency: 'EUR' })).toEqual([])
    expect(figureProblems({ basis: 'PER_UNIT', value: '0', currency: null }).map((issue) => issue.path)).toEqual(['body/value', 'body/currency'])
  })

  it('covers whole months, open-ended or to the last day of a month', () => {
    expect(periodProblems('2026-01-01', null)).toEqual([])
    expect(periodProblems('2026-01-01', '2026-06-30')).toEqual([])
    expect(periodProblems('2026-01-15', '2026-06-15').map((issue) => issue.path)).toEqual(['body/periodStart', 'body/periodEnd'])
  })

  it('has the key of the database, holds its days, and overlaps another period that shares a day', () => {
    expect(overheadKey(null, 'PER_UNIT', null)).toBe('overhead:all:PER_UNIT:all')
    expect(overheadKey('A', 'PER_MINUTE', 'SEWING')).toBe('overhead:A:PER_MINUTE:SEWING')
    expect([holds(RULES[2]!, '2026-06-30'), holds(RULES[2]!, '2026-07-01'), holds(RULES[6]!, '2026-07-01')]).toEqual([true, false, false])
    expect(overlaps({ periodStart: '2026-01-01', periodEnd: null }, { periodStart: '2027-01-01', periodEnd: '2027-01-31' })).toBe(true)
    expect(overlaps({ periodStart: '2026-01-01', periodEnd: '2026-06-30' }, { periodStart: '2026-07-01', periodEnd: null })).toBe(false)
  })
})

describe('the rules in force for a company and kind on a day', () => {
  it('take one rule per basis, the most specific: company and kind, company, every company and kind, every company', () => {
    const ids = (kind: Parameters<typeof rulesInForce>[2], on: string, companyId: string | null = 'A') => rulesInForce(RULES, companyId, kind, on).map((found) => found.id)
    // Sewing in November: company A's 25 %, A's own 0.05 a minute (before every company's 0.03), every company's 2.75 a garment.
    expect(ids('SEWING', '2026-11-15')).toEqual(['a-labour', 'a-sewing-minute', 'all-unit-h2'])
    // Sewing in October: A has no sewing minute rule yet, so every company's 0.03.
    expect(ids('SEWING', '2026-10-15')).toEqual(['a-labour', 'all-sewing-minute', 'all-unit-h2'])
    // Cutting in March: A's own cutting percent wins over its every-kind percent; the first half's garment rate.
    expect(ids('CUTTING', '2026-03-01')).toEqual(['a-cutting-labour', 'all-unit-h1'])
    // A garment's own overhead (no kind): the rules for every kind only.
    expect(ids(null, '2026-11-15')).toEqual(['a-labour', 'all-unit-h2'])
    // Company B: only every company's.
    expect(ids('SEWING', '2026-11-15', 'B')).toEqual(['all-sewing-minute', 'all-unit-h2'])
    expect(ids('SEWING', '2025-12-31')).toEqual([])
    expect([inForceWords(0), inForceWords(1), inForceWords(3)]).toEqual([
      "No overhead rule is in force here: the cost sheet keeps the costing settings' overhead percent on material + labour.",
      'One overhead rule is in force here.',
      '3 overhead rules are in force here, one per basis: they add up.',
    ])
  })

  it('absorb the overhead as cost sheet lines take it, one rounding per line, and say what is missing', () => {
    const sewing = rulesInForce(RULES, 'A', 'SEWING', '2026-11-15')
    // Labour 48.25: 25 % = 12.0625; 96.5 minutes × 0.05 = 4.825; 1 garment × 2.75 = 2.75; total 19.6375.
    expect(absorb(sewing, { labourCost: '48.25', minutes: '96.5', units: '1' }, 'EUR')).toEqual({
      lines: [
        { ruleId: 'a-labour', basis: 'PERCENT_OF_LABOUR', workCentreKind: null, quantity: '1', unitCost: '12.062500', pct: '25', amount: '12.062500', missing: null },
        { ruleId: 'a-sewing-minute', basis: 'PER_MINUTE', workCentreKind: 'SEWING', quantity: '96.5', unitCost: '0.05', pct: null, amount: '4.825000', missing: null },
        { ruleId: 'all-unit-h2', basis: 'PER_UNIT', workCentreKind: null, quantity: '1', unitCost: '2.75', pct: null, amount: '2.750000', missing: null },
      ],
      total: '19.637500',
    })
    // Without the minutes the total is not drawn (never a total that leaves a line out); 33.333 × 25 % = 8.33325.
    const partial = absorb(sewing, { labourCost: '33.333', units: '1' }, 'EUR')
    expect(partial.lines.map((line) => [line.amount, line.missing])).toEqual([
      ['8.333250', null],
      [null, 'MINUTES'],
      ['2.750000', null],
    ])
    expect(partial.total).toBeNull()
    // A company costed in Swiss francs: the euro amounts are missing, never converted here; the percent still applies.
    expect(absorb(sewing, { labourCost: '10', minutes: '1', units: '1' }, 'CHF').lines.map((line) => line.missing)).toEqual([null, 'CURRENCY', 'CURRENCY'])
    expect(absorb([], {}, 'EUR')).toEqual({ lines: [], total: '0.000000' })
    expect(perMinuteOf(sewing, 'EUR')).toBe('0.050000')
    expect(perMinuteOf(sewing, 'CHF')).toBe('0.000000')
  })
})
