import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import { buildOrderLog, decodeLogCursor, encodeLogCursor, type LogAuditRow, type LogContext } from '@nexus/factory-domain/sales/order-log/build'
import type { OrderLogAnswerView } from '@nexus/factory-domain/sales/order-log/contract'
import type { FaceGate, LogAudience, LogDoor } from '@nexus/factory-domain/sales/order-log/faces'
import type { CommandCaller, CommandTx } from '../../../core/command'
import { workerGatesFor } from '../../people/privacy/worker-gate'
import { assertMay, officeContextOf } from './access'

/**
 * The ONE order log (owb- order workflow, b3.1; research R-base D; the Shapes of owb-b23.md): the AuditLog rows of ONE order's
 * records, through the per-record audit index (AuditLog @@index tenantId, recordType, recordId, at), built by the pure builder
 * (factory-domain sales/order-log/build) with the reader's face (sales/order-log/faces).
 *
 *   GET /sales/orders/:orderId/log            office, orders.view over the order's company AND customer (the brand wall: out of
 *                                             reach is 404 "Sales order not found."): the order, its lines, the request it came
 *                                             from and that request's lines, its shipments (its own and those carrying its
 *                                             lines), the files of all of them
 *   GET /sales/order-requests/:requestId/log  office, orders.view over the request's company AND customer (404 "Order request not
 *                                             found."): a Draft or Sent order — the request, its lines, their files
 *
 * The portal's two reads are ../portal-orders/log.ts (the same records, read in the tenant's scope after the partner read found
 * the record; the customer's face and the allow-list). S5's basket read uses floorFaceOf (faces.ts); no floor route here.
 * Names: an office person's and a customer person's by name in the office; a floor worker's only where the site's PERFORMANCE
 * gate is open (people/privacy worker-gate), else the department. Values are typed (a life word, a date, a count, a picture),
 * never a raw `after`: no price reaches a log value, whatever the reader's grains. `?cursor=` pages newest first.
 */

export type Reader = FactoryClient | CommandTx

/** The records of one order's log: per audit record type, the ids; and the label of each record. */
export interface LogRecords {
  readonly ids: ReadonlyMap<string, readonly string[]>
  readonly labels: ReadonlyMap<string, string>
  /** The files among them (StoredFile ids): the portal keeps only those shared with the customer. */
  readonly fileIds: readonly string[]
}

const FILE_PARENTS = ['SalesOrder', 'SalesOrderLine', 'PortalOrderRequest', 'PortalOrderRequestLine', 'Shipment'] as const

/** The records of a request (Draft or Sent): the request, its lines, their files. */
export async function requestRecordsOf(db: Reader, requestId: string): Promise<LogRecords> {
  const request = await db.portalOrderRequest.findUnique({ where: { id: requestId }, select: { id: true, number: true } })
  if (!request) return { ids: new Map(), labels: new Map(), fileIds: [] }
  const lines = await db.portalOrderRequestLine.findMany({ where: { requestId }, select: { id: true, seq: true } })
  return withFiles(db, new Map([['PortalOrderRequest', [request.id]], ['PortalOrderRequestLine', lines.map((line) => line.id)]]), new Map([...(request.number ? [[request.id, request.number] as const] : []), ...lines.map((line) => [line.id, `Line ${line.seq}`] as const)]))
}

/** The records of an order: the order, its lines, its request and that request's lines, its shipments, the files of all of them. */
export async function orderRecordsOf(db: Reader, orderId: string): Promise<LogRecords> {
  const order = await db.salesOrder.findUnique({ where: { id: orderId }, select: { id: true, number: true } })
  if (!order) return { ids: new Map(), labels: new Map(), fileIds: [] }
  const lines = await db.salesOrderLine.findMany({ where: { orderId }, select: { id: true, seq: true } })
  const requests = await db.portalOrderRequest.findMany({ where: { salesOrderId: orderId }, select: { id: true, number: true } })
  const requestLines = requests.length > 0 ? await db.portalOrderRequestLine.findMany({ where: { requestId: { in: requests.map((row) => row.id) } }, select: { id: true, seq: true } }) : []
  const lineIds = lines.map((line) => line.id)
  const carrying = lineIds.length > 0 ? await db.shipmentLine.findMany({ where: { salesOrderLineId: { in: lineIds } }, select: { shipmentId: true }, distinct: ['shipmentId'] }) : []
  const shipments = await db.shipment.findMany({ where: { OR: [{ salesOrderId: orderId }, { id: { in: carrying.map((row) => row.shipmentId) } }] }, select: { id: true, number: true } })
  const ids = new Map<string, readonly string[]>([
    ['SalesOrder', [order.id]],
    ['SalesOrderLine', lineIds],
    ['PortalOrderRequest', requests.map((row) => row.id)],
    ['PortalOrderRequestLine', requestLines.map((line) => line.id)],
    ['Shipment', shipments.map((row) => row.id)],
  ])
  const labels = new Map<string, string>([
    [order.id, order.number],
    ...lines.map((line) => [line.id, `Line ${line.seq}`] as const),
    ...requests.flatMap((row) => (row.number ? [[row.id, row.number] as const] : [])),
    ...requestLines.map((line) => [line.id, `Line ${line.seq}`] as const),
    ...shipments.map((row) => [row.id, row.number] as const),
  ])
  return withFiles(db, ids, labels)
}

/** The records' files (their labels: the file's name), added as StoredFile records. */
async function withFiles(db: Reader, ids: Map<string, readonly string[]>, labels: Map<string, string>): Promise<LogRecords> {
  const parents = FILE_PARENTS.flatMap((recordType) => ((ids.get(recordType) ?? []).length > 0 ? [{ recordType, recordId: { in: [...(ids.get(recordType) ?? [])] } }] : []))
  const files = parents.length > 0 ? await db.storedFile.findMany({ where: { OR: parents }, select: { id: true, originalName: true } }) : []
  ids.set('StoredFile', files.map((file) => file.id))
  for (const file of files) labels.set(file.id, file.originalName)
  return { ids, labels, fileIds: files.map((file) => file.id) }
}

/** An audit row as the log reads it (its site: the worker gate). */
type AuditRead = LogAuditRow & { readonly siteId: string | null }

/** Which rows a page reads (the portal: only allowed actions of customer record types; the builder filters again). */
export interface LogPageFilter {
  readonly actions?: readonly string[]
  readonly recordTypes?: ReadonlySet<string>
}

/** One page of the records' audit rows, newest first, after the cursor; and the cursor of the next page. */
export async function readLogPage(db: Reader, records: LogRecords, query: { readonly cursor?: string | undefined; readonly limit: number }, filter: LogPageFilter = {}): Promise<{ rows: AuditRead[]; nextCursor: string | null }> {
  const after = query.cursor === undefined ? null : decodeLogCursor(query.cursor)
  if (query.cursor !== undefined && !after) throw new ValidationError('This page of the history is not one we gave: read the history again from the top.', [{ path: 'querystring/cursor', message: 'Not a page of this history.' }])
  const which = [...records.ids.entries()].filter(([recordType, list]) => list.length > 0 && (filter.recordTypes?.has(recordType) ?? true)).map(([recordType, list]) => ({ recordType, recordId: { in: [...list] } }))
  if (which.length === 0) return { rows: [], nextCursor: null }
  const where: Prisma.AuditLogWhereInput = {
    AND: [
      { OR: which },
      ...(filter.actions ? [{ action: { in: [...filter.actions] } }] : []),
      ...(after ? [{ OR: [{ at: { lt: after.at } }, { at: after.at, id: { lt: after.id } }] }] : []),
    ],
  }
  const found = await db.auditLog.findMany({
    where,
    orderBy: [{ at: 'desc' }, { id: 'desc' }],
    take: query.limit + 1,
    select: { id: true, at: true, audience: true, actorId: true, action: true, recordType: true, recordId: true, before: true, after: true, reason: true, siteId: true },
  })
  const page = found.slice(0, query.limit)
  const rows = page.map((row): AuditRead => ({ id: row.id, at: toUtcIso(row.at), audience: row.audience as LogAudience, actorId: row.actorId, action: row.action, recordType: row.recordType, recordId: row.recordId, before: row.before, after: row.after, reason: row.reason, siteId: row.siteId }))
  const last = rows[rows.length - 1]
  return { rows, nextCursor: found.length > query.limit && last ? encodeLogCursor(last) : null }
}

/**
 * The names and parties of a page's actors: office users and customer people (User.displayName, their party); a floor worker's
 * name only on a row whose site's PERFORMANCE gate is open (the other rows are named in `hiddenWorkerRows`: never a name).
 */
export async function peopleOf(db: Reader, rows: readonly AuditRead[], door: LogDoor): Promise<Pick<LogContext, 'names' | 'actorParties' | 'hiddenWorkerRows'>> {
  const userIds = [...new Set(rows.filter((row) => row.audience === 'OFFICE' || row.audience === 'PARTNER' || row.audience === 'LINK').map((row) => row.actorId))]
  const users = userIds.length > 0 ? await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, displayName: true, partyId: true } }) : []
  const names = new Map<string, string>(users.map((user) => [user.id, user.displayName]))
  const actorParties = new Map<string, string>(users.flatMap((user) => (user.partyId ? [[user.id, user.partyId] as const] : [])))
  const floor = rows.filter((row) => row.audience === 'FLOOR')
  const hiddenWorkerRows = new Set<string>()
  if (floor.length > 0) {
    // The office alone may ever name a worker; the portal and the floor never read a worker's name (faces.ts).
    const gates = door === 'office' ? await workerGatesFor(db, floor.map((row) => row.siteId)) : null
    const open = floor.filter((row) => gates?.at(row.siteId).open === true)
    for (const row of floor) if (!open.includes(row)) hiddenWorkerRows.add(row.id)
    const workerIds = [...new Set(open.map((row) => row.actorId))]
    if (workerIds.length > 0) for (const worker of await db.worker.findMany({ where: { id: { in: workerIds } }, select: { id: true, displayName: true } })) names.set(worker.id, worker.displayName)
  }
  return { names, actorParties, hiddenWorkerRows }
}

/** One page of the log, as the office reads it. */
async function officeAnswer(db: Reader, records: LogRecords, query: { readonly cursor?: string | undefined; readonly limit: number }): Promise<OrderLogAnswerView> {
  const page = await readLogPage(db, records, query)
  const people = await peopleOf(db, page.rows, 'office')
  const gate: FaceGate = { workerNamesOpen: true }
  const rows = buildOrderLog(page.rows, { door: 'office', gate, ...people, labels: records.labels })
  return { rows: [...rows], nextCursor: page.nextCursor }
}

/** GET /sales/orders/:orderId/log (see the file's head). */
export async function officeOrderLog(caller: CommandCaller, orderId: string, query: { readonly cursor?: string | undefined; readonly limit: number }): Promise<OrderLogAnswerView> {
  const context = officeContextOf(caller)
  const order = isUuid(orderId) ? await caller.withClient((client) => client.salesOrder.findUnique({ where: { id: orderId }, select: { companyId: true, partyId: true } })) : null
  assertMay(context, ORDERS_VIEW, order, 'Sales order')
  return caller.withClient(async (client) => officeAnswer(client, await orderRecordsOf(client, orderId), query))
}

/** GET /sales/order-requests/:requestId/log (see the file's head). */
export async function officeRequestLog(caller: CommandCaller, requestId: string, query: { readonly cursor?: string | undefined; readonly limit: number }): Promise<OrderLogAnswerView> {
  const context = officeContextOf(caller)
  const request = isUuid(requestId) ? await caller.withClient((client) => client.portalOrderRequest.findUnique({ where: { id: requestId }, select: { companyId: true, partyId: true } })) : null
  if (!request) throw new NotFoundError('Order request not found.')
  assertMay(context, ORDERS_VIEW, request, 'Order request')
  return caller.withClient(async (client) => officeAnswer(client, await requestRecordsOf(client, requestId), query))
}
