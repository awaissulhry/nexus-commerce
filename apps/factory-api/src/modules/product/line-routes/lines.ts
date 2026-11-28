import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { DomainError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { LINE_ROUTE_REFUSALS, type LineRouteExceptionBody, type LineRoutesView, type LineRouteRefusal, type PickLineRouteBody } from '@nexus/factory-domain/product/routing/line-route-contracts'
import { PRODUCT_ROUTING_MANAGE } from '@nexus/factory-domain/product/routing/permissions'
import { ORDERS_MANAGE, ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import { command, StaleVersionError, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { assertOrdersReader, assertSees, mayOn, officeContextOf, type OrderScope } from '../../sales/orders/access'
import { routeStepViews, planRouteSteps } from '../routes/plan'
import { exceptionStepsOf, LINE_ROUTE_COLUMNS, lineRouteFacts, type LineRouteRow } from './facts'

/**
 * The route of each order line (owb-pd2 2.4; design § 5v, § 5z; S4 settles 2, 3, 5): read on the order's Production tab, a model
 * picked by sales, an exception made by the production manager — until the basket cards are printed (an OrderPrint FIRST: then every
 * write is refused, FROZEN 409; the wave's guard refuses it too).
 *
 *   GET    /sales/orders/:orderId/line-routes                              orders.view, or orders.view.own and on the order (S2's ONE
 *                                                                          rule, sales/orders/access assertSees); else 404 (brand wall)
 *   PUT    /sales/orders/:orderId/lines/:lineId/route { version?, routeId|null }   orders.manage over the order: a MODEL route of the
 *                                                                          line's revision for any customer or the order's (NOT_A_MODEL)
 *   PUT    …/lines/:lineId/route-exception { version?, steps, reason }      product.routing.manage over the order's company
 *   DELETE …/lines/:lineId/route-exception?version=                          (sales: 403 ONLY_PRODUCTION_MANAGER in words)
 *
 * `version` is the line route row's (SalesOrderLineRoute); a line without a row sends none, a line with one sends it (a stale or a
 * missing one is a 409). Audit actions `order.line.route_picked` and `order.line.route_exception` on the order — internal: never on
 * the customer's allow-list (D/sales/order-log/faces CUSTOMER_ALLOWED_ACTIONS), so the portal's log never shows them.
 */

function refused(code: LineRouteRefusal, kind: 'conflict' | 'forbidden' | 'validation_failed'): DomainError {
  const message = LINE_ROUTE_REFUSALS[code].en
  return new DomainError(kind, message, [{ path: `refusal/${code}`, message }])
}

/** The order as the person sees it (orders.view, or orders.view.own and on it), with its scope; else 404. */
async function seenOrder(caller: CommandCaller, orderId: string, permission = ORDERS_VIEW): Promise<{ context: OfficeContext; order: OrderScope & { id: string } }> {
  const context = officeContextOf(caller)
  assertOrdersReader(context)
  const order = isUuid(orderId) ? await caller.withClient((client) => client.salesOrder.findUnique({ where: { id: orderId }, select: { id: true, companyId: true, partyId: true } })) : null
  await caller.withClient((client) => assertSees(client, context, permission, order, { salesOrderId: orderId }))
  return { context, order: order! }
}

const printedFirst = async (db: FactoryClient | CommandTx, orderId: string): Promise<boolean> =>
  (await db.orderPrint.count({ where: { salesOrderId: orderId, kind: 'FIRST' } })) > 0

/** GET …/line-routes: each goods line with its route, where it comes from, the models sales may pick, and its exception. */
export async function readLineRoutes(caller: CommandCaller, orderId: string): Promise<LineRoutesView> {
  const { context, order } = await seenOrder(caller, orderId)
  return caller.withClient(async (client) => {
    const frozen = await printedFirst(client, orderId)
    const facts = await lineRouteFacts(client, orderId)
    const styles = await client.style.findMany({ where: { id: { in: [...new Set(facts.map((entry) => entry.styleId))] } }, select: { id: true, code: true, name: true } })
    const byId = new Map(styles.map((style) => [style.id, style]))
    const people = [...new Set(facts.flatMap((entry) => (entry.row?.exceptionById ? [entry.row.exceptionById] : [])))]
    const names = new Map((people.length === 0 ? [] : await client.user.findMany({ where: { id: { in: people } }, select: { id: true, displayName: true } })).map((user) => [user.id, user.displayName]))
    return {
      frozen,
      may: { pick: !frozen && mayOn(context, ORDERS_MANAGE, order), exception: !frozen && mayOn(context, PRODUCT_ROUTING_MANAGE, order) },
      lines: facts.map((entry) => ({
        lineId: entry.lineId,
        seq: entry.seq,
        product: byId.get(entry.styleId) ?? null,
        source: entry.route.source,
        routeName: entry.route.routeName,
        steps: routeStepViews(
          entry.route.steps.flatMap((step) => (step.departmentId ? [{ id: step.stepId, seq: step.seq, departmentId: step.departmentId, minutes: step.minutes }] : [])),
          entry.facts.departments,
        ),
        choices: [...entry.choices],
        pickedRouteId: entry.row?.styleRouteId ?? null,
        exception: entry.row?.exceptionReason && entry.row.exceptionAt ? { reason: entry.row.exceptionReason, by: entry.row.exceptionById ? (names.get(entry.row.exceptionById) ?? null) : null, at: toUtcIso(entry.row.exceptionAt) } : null,
        version: entry.row?.version ?? null,
      })),
    }
  })
}

/** The line of the order, its row (locked for the rest of the command) at the version sent; refused once the cards are printed. */
async function lineFor(tx: CommandTx, order: OrderScope & { id: string }, lineId: string, version: number | undefined): Promise<{ line: { id: string; styleId: string; styleRevisionId: string | null }; row: LineRouteRow | null }> {
  const line = isUuid(lineId) ? await tx.salesOrderLine.findUnique({ where: { id: lineId }, select: { id: true, orderId: true, kind: true, styleId: true, styleRevisionId: true } }) : null
  if (!line || line.orderId !== order.id || line.kind === 'FEE') throw new NotFoundError('Order line not found.')
  // The order's prints, then the row: a print and a route change wait for each other on the order.
  await tx.$queryRaw`SELECT "id" FROM "SalesOrder" WHERE "id" = ${order.id}::uuid FOR UPDATE`
  if (await printedFirst(tx, order.id)) throw refused('FROZEN', 'conflict')
  const row = await tx.salesOrderLineRoute.findUnique({ where: { salesOrderLineId: lineId }, select: LINE_ROUTE_COLUMNS })
  if (row) {
    if (version === undefined || version !== row.version) throw new StaleVersionError('SalesOrderLineRoute', row.id, row.version, version ?? 0)
    const { count } = await tx.salesOrderLineRoute.updateMany({ where: { id: row.id, version: row.version }, data: { version: row.version + 1 } })
    if (count !== 1) throw new StaleVersionError('SalesOrderLineRoute', row.id, row.version + 1, version)
  }
  return { line: { id: line.id, styleId: line.styleId, styleRevisionId: line.styleRevisionId }, row }
}

/** The line's row written: updated when it has one (its version already moved by `lineFor`), else made. */
async function writeRow(tools: CommandTools, order: OrderScope & { id: string }, lineId: string, row: LineRouteRow | null, data: Prisma.SalesOrderLineRouteUncheckedUpdateInput): Promise<void> {
  const { tx, now } = tools
  if (row) {
    await tx.salesOrderLineRoute.update({ where: { id: row.id }, data: { ...data, updatedAt: now }, select: { id: true } })
    return
  }
  await tx.salesOrderLineRoute.create({
    data: { id: newId(), companyId: order.companyId, partyId: order.partyId, salesOrderId: order.id, salesOrderLineId: lineId, ...(data as Prisma.SalesOrderLineRouteUncheckedCreateInput), createdAt: now, updatedAt: now, createdById: officeActor(tools) },
    select: { id: true },
  })
}

const officeActor = (tools: CommandTools): string | null => (tools.context.audience === 'office' ? tools.context.actorId : null)

/** order.line.route_picked: sales picks a model route for the line (null: back to the normal route). */
export async function pickLineRoute(caller: CommandCaller, orderId: string, lineId: string, body: PickLineRouteBody, idempotencyKey?: string): Promise<LineRoutesView> {
  const { order } = await seenOrder(caller, orderId, ORDERS_MANAGE)
  await command(caller, { name: 'order.line.route_picked', idempotencyKey, input: { orderId, lineId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const { line, row } = await lineFor(tx, order, lineId, body.version)
    if (body.routeId !== null) {
      const revisionId = line.styleRevisionId ?? (await tx.styleRevision.findFirst({ where: { styleId: line.styleId, status: 'RELEASED' }, select: { id: true } }))?.id ?? null
      const route = isUuid(body.routeId) ? await tx.styleRoute.findUnique({ where: { id: body.routeId }, select: { id: true, styleId: true, revisionId: true, kind: true, partyId: true } }) : null
      if (!route || route.styleId !== line.styleId || route.revisionId !== revisionId || route.kind !== 'MODEL' || (route.partyId !== null && route.partyId !== order.partyId)) throw refused('NOT_A_MODEL', 'validation_failed')
    }
    await writeRow(tools, order, lineId, row, { styleRouteId: body.routeId, pickedById: body.routeId === null ? null : officeActor(tools), pickedAt: body.routeId === null ? null : now })
    tools.audit({ action: 'order.line.route_picked', recordType: 'SalesOrder', recordId: orderId, companyId: order.companyId, before: { lineId, routeId: row?.styleRouteId ?? null }, after: { lineId, routeId: body.routeId } })
  })
  return readLineRoutes(caller, orderId)
}

/** Only the production manager makes or takes back a line's exception: product.routing.manage over the order (403 in words for sales). */
function assertProductionManager(context: OfficeContext, order: OrderScope): void {
  if (!mayOn(context, PRODUCT_ROUTING_MANAGE, order)) throw refused('ONLY_PRODUCTION_MANAGER', 'forbidden')
}

/** order.line.route_exception: the production manager's route for this one line, with why (the route rules hold). */
export async function putLineException(caller: CommandCaller, orderId: string, lineId: string, body: LineRouteExceptionBody, idempotencyKey?: string): Promise<LineRoutesView> {
  const { context, order } = await seenOrder(caller, orderId)
  assertProductionManager(context, order)
  await command(caller, { name: 'order.line.route_exception', idempotencyKey, input: { orderId, lineId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const { row } = await lineFor(tx, order, lineId, body.version)
    const before = row ? exceptionStepsOf(row.exceptionSteps).map((step) => step.departmentId) : []
    const plan = await planRouteSteps(tx, { steps: body.steps, companyId: order.companyId, before, withOperation: false })
    const steps = plan.steps.map((step) => ({ departmentId: step.departmentId, minutes: step.minutes }))
    await writeRow(tools, order, lineId, row, { exceptionSteps: steps, exceptionReason: body.reason, exceptionById: officeActor(tools), exceptionAt: now })
    tools.audit({ action: 'order.line.route_exception', recordType: 'SalesOrder', recordId: orderId, companyId: order.companyId, before: { lineId, steps: row ? exceptionStepsOf(row.exceptionSteps) : null }, after: { lineId, steps, reason: body.reason } })
  })
  return readLineRoutes(caller, orderId)
}

/** order.line.route_exception (taken back): "Back to the normal route". */
export async function dropLineException(caller: CommandCaller, orderId: string, lineId: string, version: number | undefined, idempotencyKey?: string): Promise<LineRoutesView> {
  const { context, order } = await seenOrder(caller, orderId)
  assertProductionManager(context, order)
  await command(caller, { name: 'order.line.route_exception', idempotencyKey, input: { orderId, lineId, version, dropped: true } }, async (tools) => {
    const { tx } = tools
    const { row } = await lineFor(tx, order, lineId, version)
    if (!row || !row.exceptionReason) {
      tools.audit({ action: 'order.line.route_exception', recordType: 'SalesOrder', recordId: orderId, companyId: order.companyId, after: { lineId, steps: null, unchanged: true } })
      return
    }
    await tx.$executeRaw`UPDATE "SalesOrderLineRoute" SET "exceptionSteps" = NULL, "exceptionReason" = NULL, "exceptionById" = NULL, "exceptionAt" = NULL, "updatedAt" = now() WHERE "id" = ${row.id}::uuid`
    tools.audit({ action: 'order.line.route_exception', recordType: 'SalesOrder', recordId: orderId, companyId: order.companyId, before: { lineId, steps: exceptionStepsOf(row.exceptionSteps), reason: row.exceptionReason }, after: { lineId, steps: null } })
  })
  return readLineRoutes(caller, orderId)
}

