import { describe, expect, it } from 'vitest'
import { routeOfLine, type RouteDepartment, type RouteLevelStep, type RouteStepFacts, type StyleRouteFacts } from './route-of-line'

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
    expect(route.steps).toEqual([{ routingOperationId: 'step-10', stepId: 'step-10', seq: 10, operationId: 'op-10', code: 'OP10', name: 'Made-up step 10', workCentreKind: 'ASSEMBLY', parallelGroup: 2, departmentNo: 9, departmentId: null, from: 'KIND', minutes: null }])
    expect(routeOfLine({ steps: [], departments: DEPARTMENTS }).steps).toEqual([])
  })
})

/** owb-pd2 2.4 (S4 settle 3): the most exact level wins — exception → picked model → customer route → the product's route. */
describe('routeOfLine levels (owb-pd2)', () => {
  const product = [step(10, 'CUTTING', 'dept-2'), step(20, 'SEWING', 'dept-4'), step(30, 'PACKING', 'dept-6')]
  const level = (departments: number[], minutes: string | null = null): RouteLevelStep[] =>
    departments.map((number, index) => ({ id: `rs-${number}-${index}`, seq: (index + 1) * 10, departmentId: `dept-${number}`, operationId: `DEPT-${number}`, code: `DEPT-${number}`, name: `Department ${number}`, workCentreKind: 'ASSEMBLY', minutes }))
  const model: StyleRouteFacts = { id: 'route-model', name: 'Racing model', kind: 'MODEL', steps: level([1, 2, 4, 5, 6], '12.5') }
  const customer: StyleRouteFacts = { id: 'route-customer', name: 'For Brand Alpha', kind: 'CUSTOMER', steps: level([2, 3, 4, 6]) }
  const exception = { reason: 'The customer sends the patches sewn.', steps: level([2, 4, 6]).map((entry) => ({ ...entry, id: null })) }
  const numbers = (route: ReturnType<typeof routeOfLine>) => route.steps.map((entry) => entry.departmentNo)

  it('the line exception wins over every other level', () => {
    const route = routeOfLine({ steps: product, departments: DEPARTMENTS, exception, picked: model, customer })
    expect(route).toMatchObject({ source: 'EXCEPTION', routeId: null, routeName: null })
    expect(numbers(route)).toEqual([2, 4, 6])
    expect(route.steps.every((entry) => entry.routingOperationId === null && entry.stepId === null && entry.from === 'STEP')).toBe(true)
  })

  it('the picked model wins over the customer route and the product', () => {
    const route = routeOfLine({ steps: product, departments: DEPARTMENTS, picked: model, customer })
    expect(route).toMatchObject({ source: 'MODEL', routeId: 'route-model', routeName: 'Racing model' })
    expect(numbers(route)).toEqual([1, 2, 4, 5, 6])
    expect(route.steps[0]).toMatchObject({ stepId: 'rs-1-0', operationId: 'DEPT-1', minutes: '12.5', departmentId: 'dept-1' })
  })

  it('the customer route wins over the product', () => {
    const route = routeOfLine({ steps: product, departments: DEPARTMENTS, customer })
    expect(route).toMatchObject({ source: 'CUSTOMER', routeId: 'route-customer', routeName: 'For Brand Alpha' })
    expect(numbers(route)).toEqual([2, 3, 4, 6])
  })

  it('a level without a step is no level; nothing else: the product route', () => {
    const route = routeOfLine({ steps: product, departments: DEPARTMENTS, exception: { reason: 'x', steps: [] }, picked: { ...model, steps: [] }, customer: null })
    expect(route).toMatchObject({ source: 'REVISION', routeId: null, routeName: null })
    expect(numbers(route)).toEqual([2, 4, 6])
    expect(route.steps[0]).toMatchObject({ routingOperationId: 'step-10', stepId: 'step-10' })
  })
})
