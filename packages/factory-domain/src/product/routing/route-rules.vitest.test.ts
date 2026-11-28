import { describe, expect, it } from 'vitest'
import { ROUTE_ERRORS, ROUTE_RULE_WORDS, ROUTE_WARNINGS, routeProblems, type RouteRuleDepartment } from './rules'

/** owb-pd2 2.2 (design § 5w, prototype `rbErrors`): the rules of a route — every code. */
const DEPARTMENTS: RouteRuleDepartment[] = [
  { id: 'cut', workCentreKind: 'CUTTING', status: 'ACTIVE' },
  { id: 'sew', workCentreKind: 'SEWING', status: 'ACTIVE' },
  { id: 'qc', workCentreKind: 'INSPECTION', status: 'ACTIVE' },
  { id: 'pack', workCentreKind: 'PACKING', status: 'ACTIVE' },
  { id: 'old', workCentreKind: 'ASSEMBLY', status: 'CLOSED' },
]
const route = (...ids: string[]) => ids.map((departmentId) => ({ departmentId }))

describe('routeProblems', () => {
  it('a good route: 2 steps or more, Packing last, a quality check — nothing to say', () => {
    expect(routeProblems(route('cut', 'sew', 'qc', 'pack'), DEPARTMENTS)).toEqual({ errors: [], warnings: [] })
  })

  it('TOO_FEW under 2 steps (an empty route too)', () => {
    expect(routeProblems(route('pack'), DEPARTMENTS).errors).toEqual(['TOO_FEW'])
    expect(routeProblems([], DEPARTMENTS)).toEqual({ errors: ['TOO_FEW'], warnings: [] })
  })

  it('LAST_NOT_PACKING when the last step is not of kind PACKING (an unknown department too)', () => {
    expect(routeProblems(route('cut', 'pack', 'qc'), DEPARTMENTS).errors).toEqual(['LAST_NOT_PACKING'])
    expect(routeProblems(route('cut', 'qc', 'nowhere'), DEPARTMENTS).errors).toEqual(['LAST_NOT_PACKING'])
  })

  it('DEPARTMENT_CLOSED only for a closed department added new; one kept where it was may stay', () => {
    expect(routeProblems([{ departmentId: 'cut' }, { departmentId: 'old', isNew: true }, { departmentId: 'qc' }, { departmentId: 'pack' }], DEPARTMENTS).errors).toEqual(['DEPARTMENT_CLOSED'])
    expect(routeProblems([{ departmentId: 'cut' }, { departmentId: 'old', isNew: false }, { departmentId: 'qc' }, { departmentId: 'pack' }], DEPARTMENTS).errors).toEqual([])
  })

  it('NO_QUALITY is a note: no step of kind INSPECTION', () => {
    expect(routeProblems(route('cut', 'sew', 'pack'), DEPARTMENTS)).toEqual({ errors: [], warnings: ['NO_QUALITY'] })
  })

  it('says each code once, errors in their order', () => {
    expect(routeProblems([{ departmentId: 'old', isNew: true }], DEPARTMENTS)).toEqual({ errors: ['TOO_FEW', 'LAST_NOT_PACKING', 'DEPARTMENT_CLOSED'], warnings: ['NO_QUALITY'] })
  })

  it('has English and Italian words for every code', () => {
    for (const code of [...ROUTE_ERRORS, ...ROUTE_WARNINGS]) {
      expect(ROUTE_RULE_WORDS[code].en.length, code).toBeGreaterThan(0)
      expect(ROUTE_RULE_WORDS[code].it.length, code).toBeGreaterThan(0)
    }
  })
})
