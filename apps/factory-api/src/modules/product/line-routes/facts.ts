import type { FactoryClient, Prisma } from '@nexus/factory-db'
import type { WorkCentreKind } from '@nexus/factory-domain/product/routing/operations'
import { routeOfLine, type LineRoute, type RouteLevelStep, type RouteOfLineFacts, type StyleRouteFacts } from '@nexus/factory-domain/product/routing/route-of-line'
import { decimalText } from '@nexus/factory-domain/product/units/units'
import type { CommandTx } from '../../../core/command'
import { readDepartments, type RoutingDepartment } from '../routing/read'
import { readRoutes, type RouteData } from '../routes/store'

/**
 * The facts of the route of each line of ONE sales order (owb-pd2 2.4; S4 settle 3): `lineRouteFacts(db, salesOrderId)` — exported
 * for S2 (the order's Production tab), S3 (the print: the basket cards' steps) and S5 (the basket's route): they read a line's route
 * ONLY through this function and factory-domain `routeOfLine()`, never the tables. Reads only; one query per table for the order.
 *
 *   revision   the line's style revision: the one the line fixes (SalesOrderLine.styleRevisionId), else the style's RELEASED one
 *   product    that revision's routing steps (RoutingOperation) with their minutes
 *   levels     the line's row (SalesOrderLineRoute): its exception steps (the departments' default operations, read here) and its
 *              picked MODEL route; the CUSTOMER route of the order's customer on the revision (its first by place); the revision's
 *              MODEL routes for any customer or for the order's customer are the line's `choices`
 *   departments the tenant's (closed ones too)
 *
 * A fee line has no route (it is never made): it is left out.
 */

type Reader = FactoryClient | CommandTx

export const LINE_ROUTE_COLUMNS = {
  id: true,
  salesOrderLineId: true,
  styleRouteId: true,
  exceptionSteps: true,
  exceptionReason: true,
  exceptionById: true,
  exceptionAt: true,
  version: true,
} as const satisfies Prisma.SalesOrderLineRouteSelect
export type LineRouteRow = Prisma.SalesOrderLineRouteGetPayload<{ select: typeof LINE_ROUTE_COLUMNS }>

/** One step of a line's exception as stored (SalesOrderLineRoute.exceptionSteps: [{ departmentId, minutes }]). */
export interface ExceptionStep {
  readonly departmentId: string
  readonly minutes: string | null
}

export const exceptionStepsOf = (value: Prisma.JsonValue | null): ExceptionStep[] =>
  Array.isArray(value)
    ? value.flatMap((entry) =>
        entry !== null && typeof entry === 'object' && !Array.isArray(entry) && typeof (entry as Record<string, unknown>)['departmentId'] === 'string'
          ? [{ departmentId: (entry as Record<string, string>)['departmentId']!, minutes: typeof (entry as Record<string, unknown>)['minutes'] === 'string' ? ((entry as Record<string, string>)['minutes'] ?? null) : null }]
          : [],
      )
    : []

export interface LineRouteFacts {
  readonly lineId: string
  readonly seq: number
  readonly styleId: string
  /** The style revision the line's route is read from; null: none released yet (the route is then empty). */
  readonly revisionId: string | null
  /** routeOfLine()'s answer. */
  readonly route: LineRoute
  /** The facts routeOfLine() was given (S3 adds its levels to them). */
  readonly facts: RouteOfLineFacts
  /** The model routes sales may pick on the line. */
  readonly choices: readonly { readonly routeId: string; readonly name: string }[]
  /** The line's row, when it has one. */
  readonly row: LineRouteRow | null
}

/** A style route as routeOfLine() reads it: each step with its operation's code, name and kind. */
function styleRouteFacts(route: RouteData, operations: ReadonlyMap<string, OperationRef>): StyleRouteFacts {
  return {
    id: route.id,
    name: route.name,
    kind: route.kind as StyleRouteFacts['kind'],
    steps: route.steps.flatMap((step): RouteLevelStep[] => {
      const operation = operations.get(step.operationId)
      return operation ? [{ id: step.id, seq: step.seq, departmentId: step.departmentId, operationId: operation.id, code: operation.code, name: operation.name, workCentreKind: operation.workCentreKind, minutes: step.minutes === null ? null : decimalText(step.minutes.toString()) }] : []
    }),
  }
}

interface OperationRef {
  readonly id: string
  readonly code: string
  readonly name: string
  readonly workCentreKind: WorkCentreKind
}

/** The route facts of every goods line of the order, in line order (see the header). */
export async function lineRouteFacts(db: Reader, salesOrderId: string): Promise<LineRouteFacts[]> {
  const order = await db.salesOrder.findUnique({ where: { id: salesOrderId }, select: { id: true, partyId: true } })
  if (!order) return []
  const lines = await db.salesOrderLine.findMany({ where: { orderId: salesOrderId, kind: { not: 'FEE' } }, select: { id: true, seq: true, styleId: true, styleRevisionId: true }, orderBy: { seq: 'asc' } })
  if (lines.length === 0) return []
  // The revision of each line: the one it fixes, else its style's RELEASED one.
  const released = await db.styleRevision.findMany({ where: { styleId: { in: [...new Set(lines.map((line) => line.styleId))] }, status: 'RELEASED' }, select: { id: true, styleId: true } })
  const releasedOf = new Map(released.map((revision) => [revision.styleId, revision.id]))
  const revisionOf = (line: (typeof lines)[number]): string | null => line.styleRevisionId ?? releasedOf.get(line.styleId) ?? null
  const revisionIds = [...new Set(lines.map(revisionOf).filter((id): id is string => id !== null))]

  const steps = revisionIds.length === 0 ? [] : await db.routingOperation.findMany({ where: { revisionId: { in: revisionIds } }, select: { id: true, revisionId: true, seq: true, operationId: true, code: true, name: true, workCentreKind: true, departmentId: true, parallelGroup: true, standardMinutes: true } })
  const routes = revisionIds.length === 0 ? [] : await readRoutes(db, { revisionId: { in: revisionIds } })
  const rows = await db.salesOrderLineRoute.findMany({ where: { salesOrderLineId: { in: lines.map((line) => line.id) } }, select: LINE_ROUTE_COLUMNS })
  const departments: RoutingDepartment[] = await readDepartments(db)

  // The operations the style route steps name, and the default operation of each department an exception names.
  const exceptionDepartments = [...new Set(rows.flatMap((row) => exceptionStepsOf(row.exceptionSteps).map((step) => step.departmentId)))]
  const operationIds = [...new Set(routes.flatMap((route) => route.steps.map((step) => step.operationId)))]
  const operations = await db.operation.findMany({
    where: { OR: [...(operationIds.length > 0 ? [{ id: { in: operationIds } }] : []), ...(exceptionDepartments.length > 0 ? [{ departmentId: { in: exceptionDepartments }, departmentDefault: true }] : [])] },
    select: { id: true, code: true, name: true, workCentreKind: true, departmentId: true, departmentDefault: true },
  })
  const operationOf = new Map(operations.map((operation) => [operation.id, operation]))
  const defaultOf = new Map(operations.filter((operation) => operation.departmentDefault && operation.departmentId).map((operation) => [operation.departmentId!, operation]))
  const rowOf = new Map(rows.map((row) => [row.salesOrderLineId, row]))

  return lines.map((line): LineRouteFacts => {
    const revisionId = revisionOf(line)
    const row = rowOf.get(line.id) ?? null
    const own = routes.filter((route) => route.revisionId === revisionId)
    const models = own.filter((route) => route.kind === 'MODEL' && (route.partyId === null || route.partyId === order.partyId))
    const picked = row?.styleRouteId ? own.find((route) => route.id === row.styleRouteId && route.kind === 'MODEL') : undefined
    const customer = own.find((route) => route.kind === 'CUSTOMER' && route.partyId === order.partyId)
    const exception = row && row.exceptionReason
      ? {
          reason: row.exceptionReason,
          steps: exceptionStepsOf(row.exceptionSteps).flatMap((step, index): RouteLevelStep[] => {
            const operation = defaultOf.get(step.departmentId)
            return operation ? [{ id: null, seq: (index + 1) * 10, departmentId: step.departmentId, operationId: operation.id, code: operation.code, name: operation.name, workCentreKind: operation.workCentreKind, minutes: step.minutes }] : []
          }),
        }
      : null
    const facts: RouteOfLineFacts = {
      steps: steps
        .filter((step) => step.revisionId === revisionId)
        .map((step) => ({ id: step.id, seq: step.seq, operationId: step.operationId, code: step.code, name: step.name, workCentreKind: step.workCentreKind, departmentId: step.departmentId, parallelGroup: step.parallelGroup, standardMinutes: decimalText(step.standardMinutes.toString()) })),
      departments,
      exception,
      picked: picked ? styleRouteFacts(picked, operationOf) : null,
      customer: customer ? styleRouteFacts(customer, operationOf) : null,
    }
    return { lineId: line.id, seq: line.seq, styleId: line.styleId, revisionId, route: routeOfLine(facts), facts, choices: models.map((route) => ({ routeId: route.id, name: route.name })), row }
  })
}
