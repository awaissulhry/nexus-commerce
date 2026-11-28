import { departmentOfKind, OUTSIDE } from '../../production/departments/kinds'
import type { WorkCentreKind } from './operations'
import { inOrder } from './rules'

/**
 * The route of ONE order line: its steps, in order, each with its department (owb- order workflow, PL-split § 1 b2 step 3;
 * PL-schema § 2; the design word table "route" and "step"). S3's print (the basket's card shows the steps), S5's basket read
 * and S2's Production tab read a line's route ONLY through this function, so S4 can add style routes and exceptions in one
 * place. Pure: the API reads the facts (modules/product/line-routes `lineRouteFacts`) and passes them in.
 *
 * owb-pd2 2.4 (S4 settle 3; design prototype prod.js `lineRoute`): the most exact level wins —
 *
 *   EXCEPTION   the line's own route, made by the production manager with a reason (until the basket cards are printed)
 *   MODEL       the model route sales picked on the line (a MODEL StyleRoute of the line's style revision)
 *   (STRUCTURE) S3: an order structure's route — none in v1 (its steps are "as the product says"); S3 adds the level here
 *   CUSTOMER    the customer route of the order's customer on the line's revision (a CUSTOMER StyleRoute), used by itself
 *   (RULE)      S3: a structure rule's route — none in v1; S3 adds the level here
 *   REVISION    the product's route: the line's style revision's routing steps (RoutingOperation), in `seq` order
 *
 * A level with no step is no level (the next one answers). A step's department: on the product's route its own
 * `RoutingOperation.departmentId` wins (copied when the step was made, frozen with the revision), a step without one (an old
 * released routing) takes its kind's default department (production/departments/kinds departmentOfKind), a SUBCONTRACT step is
 * OUTSIDE (no department); on every other level the step names its department itself.
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
  /** owb-pd2: the step's standard minutes per garment (a plain decimal string); left out: not read. */
  readonly standardMinutes?: string | null
}

/** A department of the company, as the API reads it (only what the route needs). */
export interface RouteDepartment {
  readonly id: string
  readonly number: number
}

/**
 * owb-pd2: a step of a route that is not the revision's routing (a model or customer route, a line's exception), as the API reads
 * it: its department, and the library operation it is worked with (a style route step's own; an exception step's department's
 * default operation, which the API reads).
 */
export interface RouteLevelStep {
  /** The StyleRouteStep's id; null for a step of a line's exception (kept on the line, no row of its own). */
  readonly id: string | null
  readonly seq: number
  readonly departmentId: string
  readonly operationId: string
  readonly code: string
  readonly name: string
  readonly workCentreKind: WorkCentreKind
  /** Minutes per garment for this route (a plain decimal string); null: none said. */
  readonly minutes: string | null
}

/** owb-pd2: a model or customer route (StyleRoute) as the API reads it. */
export interface StyleRouteFacts {
  readonly id: string
  readonly name: string
  readonly kind: 'MODEL' | 'CUSTOMER'
  readonly steps: readonly RouteLevelStep[]
}

/** owb-pd2: a line's own route (its exception), with why. */
export interface LineExceptionFacts {
  readonly reason: string
  readonly steps: readonly RouteLevelStep[]
}

export interface RouteOfLineFacts {
  /** The style revision's routing steps (any order; the answer sorts them by seq). */
  readonly steps: readonly RouteStepFacts[]
  /** The company's departments (closed ones too: an old step may name one). */
  readonly departments: readonly RouteDepartment[]
  /** owb-pd2: the line's exception (null or left out: none). */
  readonly exception?: LineExceptionFacts | null
  /** owb-pd2: the MODEL route sales picked on the line (null or left out: none). */
  readonly picked?: StyleRouteFacts | null
  /** owb-pd2: the CUSTOMER route of the order's customer on the line's revision (null or left out: none). */
  readonly customer?: StyleRouteFacts | null
}

export interface LineRouteStep {
  /** The revision's routing step (RoutingOperation); null on a step of another level (a style route, an exception). */
  readonly routingOperationId: string | null
  /** owb-pd2: the step's own row — the RoutingOperation or the StyleRouteStep; null on a line's exception step. */
  readonly stepId: string | null
  readonly seq: number
  readonly operationId: string
  readonly code: string
  readonly name: string
  readonly workCentreKind: WorkCentreKind
  readonly parallelGroup: number | null
  /** The department's number (the number on its wall); null: OUTSIDE (a subcontracted step), or a department not known. */
  readonly departmentNo: number | null
  /** The department's id when one is known (the step's own, or the kind's default department of the company); else null. */
  readonly departmentId: string | null
  /** Where the department came from: the step's own departmentId (STEP), its kind's default (KIND), or a workshop (OUTSIDE). */
  readonly from: 'STEP' | 'KIND' | 'OUTSIDE'
  /** owb-pd2: minutes per garment on this route (a plain decimal string); null: none said / not read. */
  readonly minutes: string | null
}

/** owb-pd2: where a line's steps come from (the HTTP answer of GET /sales/orders/:orderId/line-routes uses the same words). */
export const LINE_ROUTE_SOURCES = ['REVISION', 'MODEL', 'CUSTOMER', 'EXCEPTION'] as const
export type LineRouteSource = (typeof LINE_ROUTE_SOURCES)[number]

export interface LineRoute {
  /** Where the steps came from: the product's route (REVISION), the picked model, the customer route, the line's exception. */
  readonly source: LineRouteSource
  /** owb-pd2: the StyleRoute the steps come from (MODEL, CUSTOMER), its name; null on REVISION and EXCEPTION. */
  readonly routeId: string | null
  readonly routeName: string | null
  readonly steps: readonly LineRouteStep[]
}

/** The steps of a level that names its departments (a style route, an exception). */
function levelSteps(steps: readonly RouteLevelStep[], departments: readonly RouteDepartment[]): LineRouteStep[] {
  const byId = new Map(departments.map((department) => [department.id, department]))
  return inOrder(steps).map((step): LineRouteStep => {
    const department = byId.get(step.departmentId)
    return {
      routingOperationId: null,
      stepId: step.id,
      seq: step.seq,
      operationId: step.operationId,
      code: step.code,
      name: step.name,
      workCentreKind: step.workCentreKind,
      parallelGroup: null,
      departmentNo: department?.number ?? null,
      departmentId: step.departmentId,
      from: 'STEP',
      minutes: step.minutes,
    }
  })
}

/** The line's steps with their departments, in route order: the most exact level that has steps (see the header). */
export function routeOfLine(facts: RouteOfLineFacts): LineRoute {
  // ── S4 (owb-pd2 2.4): the line's exception, then the picked model, then (S3: the order structure) the customer route, then
  //    (S3: the structure rule) the product's route. ──
  if (facts.exception && facts.exception.steps.length > 0) return { source: 'EXCEPTION', routeId: null, routeName: null, steps: levelSteps(facts.exception.steps, facts.departments) }
  if (facts.picked && facts.picked.steps.length > 0) return { source: 'MODEL', routeId: facts.picked.id, routeName: facts.picked.name, steps: levelSteps(facts.picked.steps, facts.departments) }
  if (facts.customer && facts.customer.steps.length > 0) return { source: 'CUSTOMER', routeId: facts.customer.id, routeName: facts.customer.name, steps: levelSteps(facts.customer.steps, facts.departments) }
  return { source: 'REVISION', routeId: null, routeName: null, steps: revisionSteps(facts) }
}

/** The product's route: the revision's routing steps, each with its own department or its kind's. */
function revisionSteps(facts: RouteOfLineFacts): LineRouteStep[] {
  const byId = new Map(facts.departments.map((department) => [department.id, department]))
  const byNumber = new Map(facts.departments.map((department) => [department.number, department]))
  return inOrder(facts.steps).map((step): LineRouteStep => {
    const base = {
      routingOperationId: step.id,
      stepId: step.id,
      seq: step.seq,
      operationId: step.operationId,
      code: step.code,
      name: step.name,
      workCentreKind: step.workCentreKind,
      parallelGroup: step.parallelGroup ?? null,
      minutes: step.standardMinutes ?? null,
    }
    const own = step.departmentId === null ? undefined : byId.get(step.departmentId)
    if (own) return { ...base, departmentNo: own.number, departmentId: own.id, from: 'STEP' }
    const kind = departmentOfKind(step.workCentreKind)
    if (kind === OUTSIDE) return { ...base, departmentNo: null, departmentId: null, from: 'OUTSIDE' }
    return { ...base, departmentNo: kind, departmentId: byNumber.get(kind)?.id ?? null, from: 'KIND' }
  })
}
