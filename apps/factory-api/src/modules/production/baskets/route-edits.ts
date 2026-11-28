import { ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { holds } from '@nexus/factory-domain/core/permissions'
import { MAX_BASKETS_PER_ACT, noQualityLeft, ROUTE_EDIT_WORDS, routeEditDecision, stepOfDepartment, type RouteEditKind, type RouteReason } from '@nexus/factory-domain/production/baskets/moves'
import { PRODUCTION_BASKETS_ROUTE } from '@nexus/factory-domain/production/baskets/permissions'
import { basketRoute, ownRoute, type RouteEditFact } from '@nexus/factory-domain/production/baskets/route'
import type { ExtraReasonCode } from '@nexus/factory-domain/production/extraops/rules'
import { standingScans } from '@nexus/factory-domain/production/scans/rules'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, type FloorContext, type OfficeContext } from '../../../core/context'
import { lockBundleForScan } from '../bundles/store'
import { addExtraOperation } from '../extraops/extra'
import { floorOrOffice, scanWorkOrder, systemView } from '../scans/access'
import { deviceStationOf, lockBundleScans, readBundleScans, readOperations, scanWorkOrderLock, type OperationRow, type Reader, type ScanHeader } from '../scans/store'
import { floorRecordSubjectFor } from '../settings/subject'
import { employeesOf } from '../terminal/store'
import { departmentLooks, readEdits, stepDepartmentsOf } from './store'

/**
 * Changing a basket's route (owb- order workflow, S5 fl2; build/briefs/owb-fl2.md step 3; LF _owb-fl-common.md § 2 settle 6; § 3
 * "fl2"; web A's fl6: SKIP and PUT_BACK name `operationId` AND `departmentId`, ADD `departmentId` only):
 *
 *   POST /production/baskets/route          the baskets named (1 to 50), or every open basket of a sales order: each edit
 *                                           SKIP / PUT_BACK / ADD with one reason (and words). Many baskets across work
 *                                           orders: the edit takes the SAME DEPARTMENT's step in each basket's own route (the
 *                                           operation id names one work order's step). ADD = today's extra operation of the
 *                                           department's default library operation (extraops addExtraOperation, made at the
 *                                           END, not scanned; an extra step of it already on the work order is reused), then
 *                                           a BasketRouteEdit ADD per basket: basketRoute puts it right before the last
 *                                           step, for that basket only. What is done stays (a reported step is not skipped);
 *                                           the last step stays last. `NO_QUALITY_LEFT` warns (does not stop) when a basket's
 *                                           route keeps no quality step.
 *   POST /production/baskets/route/normal   the same baskets back to the work order's route (one NORMAL edit each).
 *
 * Online only (the phone has the network for it), production.baskets.route (the team leader; the office's production
 * manager and floor supervisor). ONE command in the scans' lock order; the edits of one act share a groupId. The office reads
 * the act on the order as "Changed on the floor" (an audit row on its SalesOrder); the customer never does.
 */

export interface RouteEditInput {
  readonly kind: RouteEditKind
  readonly operationId?: string | undefined
  readonly departmentId?: string | undefined
}

export interface RouteInput {
  readonly bundleIds?: readonly string[] | undefined
  readonly salesOrderId?: string | undefined
  readonly edits: readonly RouteEditInput[]
  readonly reason: RouteReason
  readonly note?: string | undefined
}

/** An ADD's extra operation reason, from the route change's (extraops EXTRA_REASON_CODES). */
const EXTRA_REASON_OF: Readonly<Record<RouteReason, ExtraReasonCode>> = Object.freeze({ NOT_NEEDED: 'MISSING_FROM_ROUTING', REDO: 'QUALITY_FIX', CUSTOMER: 'CUSTOMER_CHANGE', OTHER: 'OTHER' })

const words = (template: string, code: string) => template.replace('{code}', code)

/** The right, or a 403 in words. */
function mayRoute(context: FloorContext | OfficeContext): void {
  if (!holds(actorOf(context), PRODUCTION_BASKETS_ROUTE)) throw new ForbiddenError('Changing a basket’s route is the team leader’s.')
}

/** The baskets the change is for: those named, or every open basket of the sales order at the caller's reach. */
async function targetsOf(caller: CommandCaller, input: { readonly bundleIds?: readonly string[] | undefined; readonly salesOrderId?: string | undefined }) {
  if ((input.bundleIds === undefined) === (input.salesOrderId === undefined)) throw new ValidationError('Name the baskets, or the order.', [{ path: 'body', message: 'Send bundleIds or salesOrderId, one of them.' }])
  let ids = input.bundleIds ? [...new Set(input.bundleIds)] : []
  if (input.salesOrderId) {
    const cells = await systemView(caller).withClient(async (db: Reader) => {
      const lines = await db.salesOrderLine.findMany({ where: { orderId: input.salesOrderId }, select: { id: true } })
      return lines.length === 0 ? [] : db.workOrderSize.findMany({ where: { salesOrderLineId: { in: lines.map((line) => line.id) } }, select: { id: true } })
    })
    ids = cells.length === 0 ? [] : (await caller.withClient((db: Reader) => db.bundle.findMany({ where: { workOrderSizeId: { in: cells.map((cell) => cell.id) }, status: 'ACTIVE' }, select: { id: true }, take: MAX_BASKETS_PER_ACT + 1 }))).map((row) => row.id)
    if (ids.length > MAX_BASKETS_PER_ACT) throw new ValidationError(`An order of more than ${MAX_BASKETS_PER_ACT} baskets is changed by its work orders, a few at a time.`, [{ path: 'body/salesOrderId', message: `More than ${MAX_BASKETS_PER_ACT} baskets.` }])
  }
  if (ids.length === 0) throw new NotFoundError('No open basket of this site to change.')
  const rows = await caller.withClient((db: Reader) => db.bundle.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, workOrderId: true, workOrderSizeId: true, siteId: true, status: true } }))
  if (rows.length !== ids.length) throw new NotFoundError('Not a basket of this site: scan its ticket.')
  const workOrders = new Map<string, ScanHeader>()
  for (const workOrderId of new Set(rows.map((row) => row.workOrderId))) workOrders.set(workOrderId, await scanWorkOrder(caller, workOrderId, PRODUCTION_BASKETS_ROUTE))
  return { rows, workOrders }
}

/** The sales order of each cell (the order log's record), through the tenant's system view. */
async function ordersOf(caller: CommandCaller, cellIds: readonly string[]): Promise<Map<string, string>> {
  return systemView(caller).withClient(async (db: Reader) => {
    const cells = await db.workOrderSize.findMany({ where: { id: { in: [...new Set(cellIds)] } }, select: { id: true, salesOrderLineId: true } })
    const lineIds = [...new Set(cells.flatMap((cell) => (cell.salesOrderLineId ? [cell.salesOrderLineId] : [])))]
    const lines = new Map(lineIds.length === 0 ? [] : (await db.salesOrderLine.findMany({ where: { id: { in: lineIds } }, select: { id: true, orderId: true } })).map((line) => [line.id, line.orderId]))
    return new Map(cells.flatMap((cell) => (cell.salesOrderLineId && lines.has(cell.salesOrderLineId) ? [[cell.id, lines.get(cell.salesOrderLineId)!] as const] : [])))
  })
}

/** Who a route change names: the team leader where the site names workers, else no person; the office user. */
async function editorOf(tools: CommandTools, context: FloorContext | OfficeContext, siteId: string) {
  if (context.audience === 'office') return { workerId: null, employeeId: null, userId: context.actorId, deviceId: null }
  const stationId = await deviceStationOf(tools.tx, context.deviceId)
  const subject = await floorRecordSubjectFor(tools.tx, { siteId, workerId: context.actorId, stationId })
  const employees = subject.workerId ? await employeesOf(tools.tx, [subject.workerId]) : new Map<string, string | null>()
  return { workerId: subject.workerId, employeeId: subject.workerId ? (employees.get(subject.workerId) ?? null) : null, userId: null, deviceId: context.deviceId }
}

/** ADD: each work order's extra step of the department (its default library operation), made when it has none yet. */
async function extraStepsFor(caller: CommandCaller, workOrders: ReadonlyMap<string, ScanHeader>, departmentId: string, input: RouteInput): Promise<Map<string, string>> {
  const library = await caller.withClient((db: Reader) => db.operation.findFirst({ where: { departmentId, departmentDefault: true }, select: { id: true } }))
  if (!library) throw new NotFoundError('This department has no step to add yet: ask the office to set its default operation.')
  const out = new Map<string, string>()
  for (const workOrder of workOrders.values()) {
    const existing = await caller.withClient((db: Reader) => db.workOrderOperation.findFirst({ where: { workOrderId: workOrder.id, operationId: library.id }, select: { id: true } }))
    if (existing) {
      out.set(workOrder.id, existing.id)
      continue
    }
    const made = await addExtraOperation(caller, workOrder.id, { operationId: library.id, reasonCode: EXTRA_REASON_OF[input.reason], ...(input.note ? { note: input.note } : {}) }, `basket-add.${workOrder.id}.${library.id}`)
    out.set(workOrder.id, made.record.workOrderOperationId)
  }
  return out
}

/** POST /production/baskets/route (see the file's head). */
export async function changeRoute(caller: CommandCaller, input: RouteInput, idempotencyKey?: string) {
  const context = floorOrOffice(caller)
  mayRoute(context)
  const note = input.note?.trim() || null
  if (input.reason === 'OTHER' && !note) throw new ValidationError('Say in a few words why.', [{ path: 'body/note', message: 'OTHER needs a few words.' }])
  for (const [index, edit] of input.edits.entries()) {
    if (edit.kind === 'ADD' ? !edit.departmentId : !edit.operationId && !edit.departmentId) {
      throw new ValidationError('Name the step: its department (and, to skip or put back, its step).', [{ path: `body/edits/${index}`, message: edit.kind === 'ADD' ? 'ADD names departmentId.' : 'SKIP and PUT_BACK name operationId or departmentId.' }])
    }
  }
  const { rows, workOrders } = await targetsOf(caller, input)
  const orders = await ordersOf(caller, rows.map((row) => row.workOrderSizeId))
  // The department of each named step (its own work order's), so another work order's basket takes its own step of it.
  const named = await caller.withClient(async (db: Reader) => {
    const departments = await departmentLooks(db)
    const operations = new Map<string, OperationRow[]>()
    for (const workOrderId of workOrders.keys()) operations.set(workOrderId, await readOperations(db, workOrderId))
    const departmentOf = await stepDepartmentsOf(db, [...workOrders.keys()], [...operations.values()].flat(), departments)
    return { departmentOf: new Map([...departmentOf].map(([operationId, look]) => [operationId, look?.id ?? null])) }
  })
  const extras = new Map<string, Map<string, string>>()
  for (const edit of input.edits) if (edit.kind === 'ADD' && !extras.has(edit.departmentId!)) extras.set(edit.departmentId!, await extraStepsFor(caller, workOrders, edit.departmentId!, input))
  // Departments of the added steps (made after the read above).
  for (const [departmentId, byOrder] of extras) for (const operationId of byOrder.values()) named.departmentOf.set(operationId, departmentId)

  const { result, replayed } = await command(caller, { name: 'production.baskets.route', idempotencyKey: idempotencyKey ?? `${context.audience === 'floor' ? context.deviceId : 'office'}.route.${newId()}`, input }, async (tools) => {
    const groupId = newId()
    let changed = 0
    const stays: string[] = []
    const warnings = new Set<'NO_QUALITY_LEFT'>()
    const operationsOf = new Map<string, OperationRow[]>()
    for (const workOrderId of [...workOrders.keys()].sort()) {
      await scanWorkOrderLock(tools.tx, context.tenantId, workOrderId)
      operationsOf.set(workOrderId, await readOperations(tools.tx, workOrderId))
    }
    for (const row of [...rows].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      const locked = await lockBundleForScan(tools.tx, row.id)
      if (!locked || locked.bundle.status !== 'ACTIVE') {
        stays.push(`${row.code}: not an open basket.`)
        continue
      }
      await lockBundleScans(tools.tx, context.tenantId, locked.bundle.siteId, row.id)
      const operations = operationsOf.get(row.workOrderId)!
      const standing = standingScans(await readBundleScans(tools.tx, row.id))
      const edits: RouteEditFact[] = [...((await readEdits(tools.tx, [row.id])).get(row.id) ?? [])]
      const workOrder = workOrders.get(row.workOrderId)!
      const editor = await editorOf(tools, context, workOrder.siteId)
      let wrote = false
      for (const edit of input.edits) {
        const route = basketRoute(operations, edits)
        // The step in THIS basket's route: the operation named when it is of this work order, else the department's step.
        const departmentId = edit.departmentId ?? (edit.operationId ? (named.departmentOf.get(edit.operationId) ?? null) : null)
        const own = edit.kind === 'ADD' ? (extras.get(edit.departmentId!)?.get(row.workOrderId) ?? null) : edit.operationId && route.some((step) => step.id === edit.operationId) ? edit.operationId : departmentId ? (stepOfDepartment(route, named.departmentOf, departmentId, { skipped: edit.kind === 'PUT_BACK' })?.id ?? null) : null
        if (!own) {
          stays.push(words(ROUTE_EDIT_WORDS.NOT_ON_ROUTE, row.code))
          continue
        }
        const decision = routeEditDecision(edit.kind, { bundleId: row.id, route, standing }, own)
        if (!decision.ok) {
          stays.push(words(ROUTE_EDIT_WORDS[decision.code], row.code))
          continue
        }
        const id = newId()
        await tools.tx.basketRouteEdit.create({ data: { id, siteId: workOrder.siteId, workOrderId: workOrder.id, bundleId: row.id, operationId: own, kind: edit.kind, reason: input.reason, note, groupId, ...editor, deviceTime: null, serverTime: tools.now }, select: { id: true } })
        edits.push({ kind: edit.kind, operationId: own })
        wrote = true
        const after = { bundleId: row.id, code: row.code, kind: edit.kind, operationId: own, reason: input.reason, groupId, workerId: editor.workerId }
        tools.audit({ action: 'production.baskets.route', recordType: 'BasketRouteEdit', recordId: id, companyId: workOrder.companyId, siteId: workOrder.siteId, after, ...(note ? { reason: note } : {}) })
        const salesOrderId = orders.get(row.workOrderSizeId)
        if (salesOrderId) tools.audit({ action: 'production.baskets.route', recordType: 'SalesOrder', recordId: salesOrderId, companyId: workOrder.companyId, siteId: workOrder.siteId, after })
      }
      if (wrote) changed++
      if (noQualityLeft(basketRoute(operations, edits))) warnings.add('NO_QUALITY_LEFT')
    }
    return { groupId, changed, stay: stays.length, stayWords: stays, warnings: [...warnings] }
  })
  return { ...result, replayed }
}

/** POST /production/baskets/route/normal (see the file's head). */
export async function normalRoute(caller: CommandCaller, input: { readonly bundleIds?: readonly string[] | undefined; readonly salesOrderId?: string | undefined }, idempotencyKey?: string) {
  const context = floorOrOffice(caller)
  mayRoute(context)
  const { rows, workOrders } = await targetsOf(caller, input)
  const orders = await ordersOf(caller, rows.map((row) => row.workOrderSizeId))
  const { result, replayed } = await command(caller, { name: 'production.baskets.routeNormal', idempotencyKey: idempotencyKey ?? `${context.audience === 'floor' ? context.deviceId : 'office'}.normal.${newId()}`, input }, async (tools) => {
    const groupId = newId()
    let changed = 0
    for (const workOrderId of [...workOrders.keys()].sort()) await scanWorkOrderLock(tools.tx, context.tenantId, workOrderId)
    for (const row of [...rows].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      await lockBundleForScan(tools.tx, row.id)
      await lockBundleScans(tools.tx, context.tenantId, row.siteId, row.id)
      const edits = (await readEdits(tools.tx, [row.id])).get(row.id) ?? []
      if (!ownRoute(edits)) continue
      const workOrder = workOrders.get(row.workOrderId)!
      const last = (await readOperations(tools.tx, workOrder.id)).filter((step) => step.scanRequired).sort((a, b) => a.seq - b.seq).at(-1)
      if (!last) continue
      const editor = await editorOf(tools, context, workOrder.siteId)
      const id = newId()
      // NORMAL names the work order's last step (the edit's step must be one of its own: G5).
      await tools.tx.basketRouteEdit.create({ data: { id, siteId: workOrder.siteId, workOrderId: workOrder.id, bundleId: row.id, operationId: last.id, kind: 'NORMAL', reason: 'OTHER', note: 'Back to the normal route', groupId, ...editor, deviceTime: null, serverTime: tools.now }, select: { id: true } })
      const after = { bundleId: row.id, code: row.code, kind: 'NORMAL', groupId, workerId: editor.workerId }
      tools.audit({ action: 'production.baskets.routeNormal', recordType: 'BasketRouteEdit', recordId: id, companyId: workOrder.companyId, siteId: workOrder.siteId, after })
      const salesOrderId = orders.get(row.workOrderSizeId)
      if (salesOrderId) tools.audit({ action: 'production.baskets.routeNormal', recordType: 'SalesOrder', recordId: salesOrderId, companyId: workOrder.companyId, siteId: workOrder.siteId, after })
      changed++
    }
    return { groupId, changed }
  })
  return { ...result, replayed }
}
