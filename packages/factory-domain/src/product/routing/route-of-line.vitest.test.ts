import { describe, expect, it } from 'vitest'
import { routeOfLine, type RouteDepartment, type RouteStepFacts } from './route-of-line'

/** owb- (order workflow, b2.3): the line's steps with their departments — the step's own wins, else its kind's default. */
const DEPARTMENTS: RouteDepartment[] = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((number) => ({ id: `dept-${number}`, number }))
const step = (seq: number, workCentreKind: RouteStepFacts['workCentreKind'], departmentId: string | null = null): RouteStepFacts => ({ id: `step-${seq}`, seq, operationId: `op-${seq}`, code: `OP${seq}`, name: `Made-up step ${seq}`, workCentreKind, departmentId })

describe('routeOfLine', () => {
  it('a new revision: each step keeps its own department (Pattern on a CUTTING step, Design on a FINISHING step)', () => {
    const route = routeOfLine({ steps: [step(10, 'CUTTING', 'dept-1'), step(20, 'CUTTING', 'dept-2'), step(30, 'FINISHING', 'dept-7'), step(40, 'SEWING', 'dept-4')], departments: DEPARTMENTS })
    expect(route.source).toBe('REVISION')
    expect(route.steps.map((entry) => [entry.seq, entry.departmentNo, entry.departmentId, entry.from])).toEqual([
      [10, 1, 'dept-1', 'STEP'],
      [20, 2, 'dept-2', 'STEP'],
      [30, 7, 'dept-7', 'STEP'],
      [40, 4, 'dept-4', 'STEP'],
    ])
  })

  it('an old released routing (no departmentId): the kind\'s default department; a subcontracted step is outside', () => {
    const route = routeOfLine({ steps: [step(30, 'SEWING'), step(10, 'CUTTING'), step(20, 'SUBCONTRACT'), step(50, 'PACKING'), step(40, 'INSPECTION')], departments: DEPARTMENTS })
    expect(route.steps.map((entry) => [entry.seq, entry.departmentNo, entry.departmentId, entry.from])).toEqual([
      [10, 2, 'dept-2', 'KIND'],
      [20, null, null, 'OUTSIDE'],
      [30, 4, 'dept-4', 'KIND'],
      [40, 5, 'dept-5', 'KIND'],
      [50, 6, 'dept-6', 'KIND'],
    ])
  })

  it('keeps the step\'s facts; a kind whose default department the company lacks still has its number, no id', () => {
    const route = routeOfLine({ steps: [{ ...step(10, 'ASSEMBLY'), parallelGroup: 2 }], departments: [] })
    expect(route.steps).toEqual([{ routingOperationId: 'step-10', seq: 10, operationId: 'op-10', code: 'OP10', name: 'Made-up step 10', workCentreKind: 'ASSEMBLY', parallelGroup: 2, departmentNo: 9, departmentId: null, from: 'KIND' }])
    expect(routeOfLine({ steps: [], departments: DEPARTMENTS }).steps).toEqual([])
  })
})
