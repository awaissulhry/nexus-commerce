import { departmentOfKind, OUTSIDE } from '../../production/departments/kinds'
import type { WorkCentreKind } from './operations'
import { inOrder } from './rules'

/**
 * The route of ONE order line: its steps, in order, each with its department (owb- order workflow, PL-split § 1 b2 step 3;
 * PL-schema § 2; the design word table "route" and "step"). S3's print (the basket's card shows the steps), S5's basket read
 * and S2's Production tab read a line's route ONLY through this function, so S4 can add style routes and exceptions in one
 * place. Pure: the API reads the facts (the style revision's routing steps, the company's departments) and passes them in.
 *
 *   today    the line's style revision's routing steps (RoutingOperation), in `seq` order
 *   a step's department   its own `RoutingOperation.departmentId` wins (copied when the step was made, frozen with the
 *            revision); a step without one (an old released routing) takes its kind's default department
 *            (production/departments/kinds departmentOfKind); a SUBCONTRACT step is OUTSIDE (no department)
 *   later    S4 (PL-split pd2): the line's picked style route and its exception route win over the revision's steps — the
 *            marked place below; the answer's shape stays
 */

/** A routing step of the line's style revision, as the API reads it. */
export interface RouteStepFacts {
  readonly id: string
  readonly seq: number
  readonly operationId: string
  readonly code: string
  readonly name: string
  readonly workCentreKind: WorkCentreKind
  /** RoutingOperation.departmentId: set on a step made since the Department table; null on an old released routing. */
  readonly departmentId: string | null
  readonly parallelGroup?: number | null
}

/** A department of the company, as the API reads it (only what the route needs). */
export interface RouteDepartment {
  readonly id: string
  readonly number: number
}

export interface RouteOfLineFacts {
  /** The style revision's routing steps (any order; the answer sorts them by seq). */
  readonly steps: readonly RouteStepFacts[]
  /** The company's departments (closed ones too: an old step may name one). */
  readonly departments: readonly RouteDepartment[]
}

export interface LineRouteStep {
  readonly routingOperationId: string
  readonly seq: number
  readonly operationId: string
  readonly code: string
  readonly name: string
  readonly workCentreKind: WorkCentreKind
  readonly parallelGroup: number | null
  /** The department's number (the number on its wall); null: OUTSIDE (a subcontracted step). */
  readonly departmentNo: number | null
  /** The department's id when one is known (the step's own, or the kind's default department of the company); else null. */
  readonly departmentId: string | null
  /** Where the department came from: the step's own departmentId (STEP), its kind's default (KIND), or a workshop (OUTSIDE). */
  readonly from: 'STEP' | 'KIND' | 'OUTSIDE'
}

export interface LineRoute {
  /** Where the steps came from. S4 adds 'STYLE_ROUTE' and 'EXCEPTION' with the style routes. */
  readonly source: 'REVISION'
  readonly steps: readonly LineRouteStep[]
}

/** The line's steps with their departments, in route order. */
export function routeOfLine(facts: RouteOfLineFacts): LineRoute {
  // ── S4 (pd2): the line's picked style route and its exception route win here, before the revision's steps. ──
  const byId = new Map(facts.departments.map((department) => [department.id, department]))
  const byNumber = new Map(facts.departments.map((department) => [department.number, department]))
  const steps = inOrder(facts.steps).map((step): LineRouteStep => {
    const base = { routingOperationId: step.id, seq: step.seq, operationId: step.operationId, code: step.code, name: step.name, workCentreKind: step.workCentreKind, parallelGroup: step.parallelGroup ?? null }
    const own = step.departmentId === null ? undefined : byId.get(step.departmentId)
    if (own) return { ...base, departmentNo: own.number, departmentId: own.id, from: 'STEP' }
    const kind = departmentOfKind(step.workCentreKind)
    if (kind === OUTSIDE) return { ...base, departmentNo: null, departmentId: null, from: 'OUTSIDE' }
    return { ...base, departmentNo: kind, departmentId: byNumber.get(kind)?.id ?? null, from: 'KIND' }
  })
  return { source: 'REVISION', steps }
}
