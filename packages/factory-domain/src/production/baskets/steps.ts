import type { WorkCentreKind } from '../../product/routing/operations'
import { departmentOfKind } from '../departments/kinds'
import { scannedOperations, type ScanOperation } from '../scans/rules'
import type { BasketPlace } from './place'
import type { RouteMarks } from './route'

/**
 * A basket's steps as its page shows them (owb- order workflow, S5 fl1; LF _owb-fl-common.md § 3 "fl1": route.steps, here,
 * next; § 2 settles 2, 7, 8; design "the basket on a phone", the step bar). Pure; the API reads the facts (the route from
 * ./route.ts, the place from ./place.ts, each step's department) and the web draws the answer.
 *
 *   departmentOfStep   a step's department: its route step's (RoutingOperation.departmentId, frozen with its revision), else its
 *                      library operation's (Operation.departmentId), else the default department of its work centre's kind
 *                      (departments/kinds departmentOfKind; a subcontracted step: none)
 *   stepStates         every scanned step of the route and every step skipped for the basket, in route order: DONE before
 *                      the place (passed: reported, or moved past by hand), HERE, NEXT (the scanned step after it), TODO, and
 *                      SKIPPED; Ready to ship: every scanned step DONE
 *   hereOf             the phone's department pick against the route (settle 8): the same department as the place; on the
 *                      route, and then the step "Take it here" moves the basket to (the first step of that department from
 *                      the place on, else the last one before it); not on the route ("Not on its route")
 */

/** A department as every screen draws it (the base's `useDepartments` / DeptChip shape). */
export interface DepartmentLook {
  readonly id: string
  readonly number: number
  readonly name: string
  readonly shortName: string
  readonly tone: string
  readonly icon: string
  readonly nameI18n: Readonly<Record<string, string>>
}

/** What decides a step's department. */
export interface StepDepartmentFacts {
  /** RoutingOperation.departmentId of the work order's route step (null: an old step, or an extra operation). */
  readonly routingDepartmentId: string | null
  /** Operation.departmentId of its library operation (null: none named). */
  readonly operationDepartmentId: string | null
  readonly workCentreKind: WorkCentreKind
}

/** A step's department (see the file's head), or null (a subcontracted step, or a department the reader cannot see). */
export function departmentOfStep(step: StepDepartmentFacts, departments: readonly DepartmentLook[]): DepartmentLook | null {
  const byId = (id: string | null): DepartmentLook | null => (id === null ? null : (departments.find((department) => department.id === id) ?? null))
  const named = byId(step.routingDepartmentId) ?? byId(step.operationDepartmentId)
  if (named) return named
  const number = departmentOfKind(step.workCentreKind)
  return typeof number === 'number' ? (departments.find((department) => department.number === number) ?? null) : null
}

export const STEP_STATES = ['DONE', 'HERE', 'NEXT', 'TODO', 'SKIPPED'] as const
export type StepState = (typeof STEP_STATES)[number]

export interface StepOfBasket {
  readonly operationId: string
  readonly state: StepState
  /** Added for this basket (a route edit ADD). */
  readonly added: boolean
}

/** The basket's steps with their state (see the file's head). */
export function stepStates(route: readonly (ScanOperation & RouteMarks)[], place: BasketPlace): StepOfBasket[] {
  const shown = [...route].filter((operation) => operation.scanRequired || operation.skipped === true).sort((a, b) => a.seq - b.seq)
  const scanned = scannedOperations(route)
  const at = place.operationId === null ? scanned.length : scanned.findIndex((operation) => operation.id === place.operationId)
  const indexOf = new Map(scanned.map((operation, index) => [operation.id, index]))
  return shown.map((operation) => {
    const added = operation.added === true
    if (operation.skipped === true) return { operationId: operation.id, state: 'SKIPPED' as const, added }
    const index = indexOf.get(operation.id) ?? -1
    const state: StepState = at < 0 ? 'TODO' : index < at ? 'DONE' : index === at ? 'HERE' : index === at + 1 ? 'NEXT' : 'TODO'
    return { operationId: operation.id, state, added }
  })
}

/** The scanned step after the place (NEXT), or null (at the last step, or Ready to ship). */
export function nextOfPlace(route: readonly ScanOperation[], place: BasketPlace): string | null {
  if (place.operationId === null) return null
  const scanned = scannedOperations(route)
  const at = scanned.findIndex((operation) => operation.id === place.operationId)
  return at < 0 ? null : (scanned[at + 1]?.id ?? null)
}

export interface HereAnswer {
  readonly departmentId: string | null
  readonly sameDepartment: boolean
  readonly onRoute: boolean
  readonly takeHereOperationId: string | null
}

/** The phone's department against the basket's route (see the file's head); no department picked: all false. */
export function hereOf(route: readonly ScanOperation[], place: BasketPlace, departmentOf: ReadonlyMap<string, string | null>, departmentId: string | null): HereAnswer {
  if (departmentId === null) return { departmentId: null, sameDepartment: false, onRoute: false, takeHereOperationId: null }
  const scanned = scannedOperations(route)
  const ofHere = scanned.filter((operation) => departmentOf.get(operation.id) === departmentId)
  const sameDepartment = place.operationId !== null && departmentOf.get(place.operationId) === departmentId
  if (ofHere.length === 0 || sameDepartment) return { departmentId, sameDepartment, onRoute: ofHere.length > 0, takeHereOperationId: null }
  const at = place.operationId === null ? scanned.length : scanned.findIndex((operation) => operation.id === place.operationId)
  const ahead = ofHere.find((operation) => scanned.indexOf(operation) >= at)
  return { departmentId, sameDepartment: false, onRoute: true, takeHereOperationId: (ahead ?? ofHere.at(-1))!.id }
}
