import type { FastifyInstance, FastifyRequest } from 'fastify'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { buildOrderLog, CUSTOMER_RECORD_TYPES } from '@nexus/factory-domain/sales/order-log/build'
import type { OrderLogAnswerView } from '@nexus/factory-domain/sales/order-log/contract'
import { CUSTOMER_ALLOWED_ACTIONS, PICTURE_SET_ACTION } from '@nexus/factory-domain/sales/order-log/faces'
import { contentWalledFor } from '../../../platform/files/content-wall'
import { orderRecordsOf, peopleOf, readLogPage, requestRecordsOf, type LogRecords, type Reader } from '../orders/log'
import { readRequest } from '../portal-ordering/store'
import { partnerOrder, portalReader } from './access'

/**
 * The order log, the customer's face (owb- order workflow, b3.1; S1 ask 23:36 named the paths):
 *
 *   GET /portal/sales-orders/:orderId/log        portal.salesOrders.view — the party's own order (the partner read; another
 *                                                customer's, or an unknown id: 404 "Order not found.")
 *   GET /portal/order-requests/:requestId/log    portal.orderDrafts.edit, like the request's own read — the party's own request
 *                                                in the portal's company (else 404 "Order request not found.")
 *
 * The partner role reads no AuditLog: after the partner read found the record, ONE record's rows are read in the tenant's scope
 * (the precedent: ./store orderHistory), the same records as the office's (../orders/log). What the customer reads: only the
 * actions of the ALLOW-list (factory-domain sales/order-log/faces CUSTOMER_ALLOWED_ACTIONS; own-rows-only actions written by
 * its own people), only its records' types (never a basket), a file only when it is shared with this customer and passes the
 * content wall; every factory person is "The factory", never a name; never a reason, an office note, a worker or a cost.
 */

/** The records' files the customer may see: shared with its party (PARTNER), available, and not walled by their content. */
async function sharedFiles(db: Reader, fileIds: readonly string[], partyId: string): Promise<Set<string>> {
  if (fileIds.length === 0) return new Set()
  const files = await db.storedFile.findMany({ where: { id: { in: [...new Set(fileIds)] }, status: 'AVAILABLE', partyId, visibility: { has: 'PARTNER' } }, select: { id: true } })
  const walled = files.length > 0 ? await contentWalledFor(db, partyId, files.map((file) => file.id)) : new Set<string>()
  return new Set(files.map((file) => file.id).filter((id) => !walled.has(id)))
}

/** The picture files a page names (from → to of a picture row): checked like the records' files. */
const pictureIdsOf = (rows: readonly { readonly action: string; readonly before: unknown; readonly after: unknown }[]): string[] =>
  rows.flatMap((row) => (row.action === PICTURE_SET_ACTION ? [row.before, row.after] : [])).flatMap((value) => {
    const fileId = value !== null && typeof value === 'object' ? (value as { pictureFileId?: unknown }).pictureFileId : null
    return typeof fileId === 'string' ? [fileId] : []
  })

/** One page of the customer's log, read in the tenant's scope. */
async function portalAnswer(db: Reader, records: LogRecords, partyId: string, query: { readonly cursor?: string | undefined; readonly limit: number }): Promise<OrderLogAnswerView> {
  const page = await readLogPage(db, records, query, { actions: [...CUSTOMER_ALLOWED_ACTIONS], recordTypes: CUSTOMER_RECORD_TYPES })
  const people = await peopleOf(db, page.rows, 'portal')
  const visibleFileIds = await sharedFiles(db, [...records.fileIds, ...pictureIdsOf(page.rows)], partyId)
  // A file's name labels its row only when the customer may see the file (its row is dropped otherwise).
  const labels = new Map([...records.labels].filter(([recordId]) => !records.fileIds.includes(recordId) || visibleFileIds.has(recordId)))
  const rows = buildOrderLog(page.rows, { door: 'portal', gate: { workerNamesOpen: false, viewerPartyId: partyId }, ...people, labels, visibleFileIds })
  return { rows: [...rows], nextCursor: page.nextCursor }
}

/** GET /portal/sales-orders/:orderId/log (see the file's head). */
export async function portalOrderLog(app: FastifyInstance, request: FastifyRequest, orderId: string, query: { readonly cursor?: string | undefined; readonly limit: number }): Promise<OrderLogAnswerView> {
  const reader = portalReader(app, request)
  const order = await partnerOrder(request, reader, orderId)
  return reader.inTenant(async (client) => portalAnswer(client, await orderRecordsOf(client, order.id), reader.session.partyId, query))
}

/** GET /portal/order-requests/:requestId/log (see the file's head). */
export async function portalRequestLog(app: FastifyInstance, request: FastifyRequest, requestId: string, query: { readonly cursor?: string | undefined; readonly limit: number }): Promise<OrderLogAnswerView> {
  const reader = portalReader(app, request)
  const row = await request.withClient((client) => readRequest(client, requestId))
  if (!row || row.companyId !== reader.session.company.id || row.partyId !== reader.session.partyId) throw new NotFoundError('Order request not found.')
  return reader.inTenant(async (client) => portalAnswer(client, await requestRecordsOf(client, row.id), reader.session.partyId, query))
}
