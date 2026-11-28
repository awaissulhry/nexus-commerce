import { describe, expect, it } from 'vitest'
import { WORK_CENTRE_KINDS } from '../../product/routing/operations'
import { DEPARTMENT_OF_KIND, departmentOfKind, OUTSIDE } from './kinds'

/** owb- (order workflow, b2.3): an old released step's department, from its work centre kind (PL-schema § 2). */
describe('departmentOfKind', () => {
  it('maps every work centre kind: CUTTING 2, SEWING 4, ASSEMBLY 9, FINISHING 3, INSPECTION 5, PACKING 6, SUBCONTRACT outside', () => {
    expect(Object.fromEntries(WORK_CENTRE_KINDS.map((kind) => [kind, departmentOfKind(kind)]))).toEqual({ CUTTING: 2, SEWING: 4, ASSEMBLY: 9, FINISHING: 3, INSPECTION: 5, PACKING: 6, SUBCONTRACT: OUTSIDE })
    expect(Object.keys(DEPARTMENT_OF_KIND).sort()).toEqual([...WORK_CENTRE_KINDS].sort())
  })

  it('never gives a department that shares a kind with the default (1 Pattern, 7 Design, 8 Molding come only from a step\'s own departmentId)', () => {
    const numbers = WORK_CENTRE_KINDS.map(departmentOfKind)
    for (const shared of [1, 7, 8]) expect(numbers).not.toContain(shared)
    expect(new Set(numbers.filter((value) => value !== OUTSIDE)).size).toBe(6)
  })
})
