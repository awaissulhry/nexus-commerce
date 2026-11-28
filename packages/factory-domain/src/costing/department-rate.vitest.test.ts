import { describe, expect, it } from 'vitest'
import { pickRate, type LabourRate } from './inputs'

/** owb-pd2 2.5: a department's own labour rate wins for a step in it; the kind's rate stays the fallback. */
const rate = (id: string, extra: Partial<LabourRate> = {}): LabourRate => ({
  id,
  companyId: null,
  workCentreKind: 'CUTTING',
  costPerMinute: '0.50',
  currency: 'EUR',
  plannedEfficiencyPct: '100',
  validFrom: '2026-10-01',
  status: 'ACTIVE',
  departmentId: null,
  ...extra,
})
const PATTERN = 'dept-pattern'
const CUTTING = 'dept-cutting'
const RATES: LabourRate[] = [
  rate('kind'),
  rate('kind-company', { companyId: 'company-a', costPerMinute: '0.55' }),
  rate('pattern', { departmentId: PATTERN, costPerMinute: '0.80' }),
  rate('pattern-later', { departmentId: PATTERN, costPerMinute: '0.90', validFrom: '2027-01-01' }),
]

describe('pickRate with a department (owb-pd2 2.5)', () => {
  it("a step in a department with its own rate valid on the day takes that rate", () => {
    expect(pickRate(RATES, 'CUTTING', null, '2026-11-28', PATTERN)?.id).toBe('pattern')
    expect(pickRate(RATES, 'CUTTING', 'company-a', '2026-11-28', PATTERN)?.id).toBe('pattern')
    // A later rate of the department wins from its first day.
    expect(pickRate(RATES, 'CUTTING', null, '2027-02-01', PATTERN)?.id).toBe('pattern-later')
  })

  it("a department without a rate of its own, or no department: the kind's rate (the company's first)", () => {
    expect(pickRate(RATES, 'CUTTING', null, '2026-11-28', CUTTING)?.id).toBe('kind')
    expect(pickRate(RATES, 'CUTTING', 'company-a', '2026-11-28', CUTTING)?.id).toBe('kind-company')
    expect(pickRate(RATES, 'CUTTING', 'company-a', '2026-11-28')?.id).toBe('kind-company')
  })

  it("a department's rate never stands in for its kind, nor before its first day", () => {
    const onlyDepartment = [rate('pattern', { departmentId: PATTERN })]
    expect(pickRate(onlyDepartment, 'CUTTING', null, '2026-11-28')).toBeNull()
    expect(pickRate(onlyDepartment, 'CUTTING', null, '2026-11-28', CUTTING)).toBeNull()
    expect(pickRate(RATES, 'CUTTING', null, '2026-09-01', PATTERN)).toBeNull()
  })

  it('an archived department rate is not used', () => {
    expect(pickRate([rate('kind'), rate('pattern', { departmentId: PATTERN, status: 'ARCHIVED' })], 'CUTTING', null, '2026-11-28', PATTERN)?.id).toBe('kind')
  })
})
