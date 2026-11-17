import { FILES_READ, THREADS_READ } from '@nexus/factory-domain/auth/permissions/catalogue'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, type Actor } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { WORKORDERS_VIEW } from '@nexus/factory-domain/production/work-orders/permissions'
import { SALES_MEASUREMENTS_VIEW } from '@nexus/factory-domain/sales/measure-link/permissions'
import { WORKSHEET_KIND } from '@nexus/factory-domain/sales/mtm/worksheet'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { mayOnThread } from '../../../platform/threads/records'
import { artworkOf } from '../../sales/configurator/artwork'
import { PROFILE_RECORD } from '../../sales/mtm/store'
import { officeContextOf } from '../work-orders/access'
import { reachesWorkOrder } from '../work-orders/scope'
import { dayOf, type Reader } from '../work-orders/store'

/**
 * B-PR-44 (production plan L16; Owner point N1, 2026-11-16: "every order already has all its details in the PDF files or in the
 * thread"): production shows the order's own files, nobody re-types them. A work order reaches its orders through its cells
 * (WorkOrderSize.salesOrderLineId → the line → its order); for each order, ONE group:
 *
 *   - the sales order's files, its lines' files (the line's artwork and anything else filed on the line) and the artwork of the
 *     quote line each line was made from (modules/sales/configurator `artworkOf`: the artwork travels without a copy) — the
 *     current version of each AVAILABLE file, newest first;
 *   - the newest worksheet version of each made-to-measure line's measurement profile revision (GeneratedDocument MTM_WORKSHEET),
 *     opened only by its own recorded route;
 *   - its thread ("Order thread"): the sales order's thread, when the reader may read it.
 *
 * The brand wall (Owner rule 2026-11-16: "One brand must not be able to see anything related to any other brand. But we, as the
 * production unit, should be able to see it all. And manage it all as well."):
 *
 *   - the work order itself as every :workOrderId route (B-PR-03 `reachesWorkOrder`): another customer's is "Work order not
 *     found.", the words of an unknown id; a legacy mixed one (no customer) only for people who reach every customer;
 *   - each group only for people who hold files.read over that order's company AND customer: a legacy mixed work order lists one
 *     group per order, each only for who reaches its customer, the others counted (`ordersLeftOut`), never named;
 *   - each file again over ITS company and the order's customer (`filesLeftOut`); a worksheet or a body-data file (a measurement
 *     sheet, a body photo) only with sales.measurements.view over that customer — the others are counted
 *     (`measurementsLeftOut`), never named;
 *   - the generic `/files/:id/preview` is never linked: a file opens through ./open.ts, which finds it again in this very read.
 */

/** Categories that are a person's body data: listed and opened only with sales.measurements.view (each opening recorded). */
export const BODY_DATA_CATEGORIES: ReadonlySet<string> = new Set(['MEASUREMENTS', 'BODY_PHOTO', 'MTM_PHOTO', 'FITTING_PHOTO'])

/** At most this many files are read for one work order (an order has far fewer). */
const FILES_MAX = 500

const FILE_SELECT = {
  id: true,
  companyId: true,
  recordType: true,
  recordId: true,
  kind: true,
  category: true,
  originalName: true,
  contentType: true,
  sizeBytes: true,
  versionNo: true,
  availableAt: true,
  createdAt: true,
} as const

export interface OrderFile {
  readonly id: string
  readonly companyId: string | null
  readonly from: 'ORDER' | 'LINE' | 'QUOTE_LINE'
  readonly line: { readonly id: string; readonly seq: number } | null
  readonly name: string
  readonly contentType: string
  readonly kind: string
  readonly category: string | null
  readonly sizeBytes: number
  readonly versionNo: number
  readonly at: Date
  readonly bodyData: boolean
}

export interface OrderWorksheet {
  readonly documentId: string
  readonly profileId: string
  readonly line: { readonly id: string; readonly seq: number }
  readonly version: number
  readonly number: string | null
  readonly language: string
  readonly createdAt: Date
}

export interface OrderFilesGroup {
  readonly order: { readonly id: string; readonly number: string; readonly customerRef: string | null; readonly status: string; readonly orderDate: Date; readonly companyId: string; readonly partyId: string }
  readonly thread: { readonly recordType: 'SalesOrder'; readonly recordId: string; readonly threadId: string | null } | null
  readonly files: readonly OrderFile[]
  readonly worksheets: readonly OrderWorksheet[]
  readonly measurementsLeftOut: number
  readonly filesLeftOut: number
}

export interface WorkOrderOrderFiles {
  readonly workOrder: { readonly id: string; readonly number: string }
  readonly groups: readonly OrderFilesGroup[]
  readonly ordersLeftOut: number
}

const workOrderNotFound = (): NotFoundError => new NotFoundError('Work order not found.')

/** The work order the reader reaches with workorders.view (its company, site and customer), else not found. */
async function reachedWorkOrder(db: Reader, actor: Actor, workOrderId: string) {
  const row = isUuid(workOrderId) ? await db.workOrder.findUnique({ where: { id: workOrderId }, select: { id: true, number: true, companyId: true, siteId: true, partyId: true } }) : null
  if (!row || !reachesWorkOrder(actor, WORKORDERS_VIEW, row)) throw workOrderNotFound()
  return row
}

/** What the reader may see of one order's files (the wall per order and per file), read in one pass. */
interface Reach {
  readonly files: (scope: { readonly companyId?: string | null; readonly partyId: string }) => boolean
  readonly body: (scope: { readonly companyId?: string | null; readonly partyId: string }) => boolean
}

const reachOf = (actor: Actor): Reach => ({
  files: (scope) => can(actor, FILES_READ, scope),
  body: (scope) => can(actor, SALES_MEASUREMENTS_VIEW, scope),
})

/** GET /production/work-orders/:workOrderId/order-files: one group per order the work order's cells make. */
export async function readOrderFiles(caller: CommandCaller, workOrderId: string): Promise<WorkOrderOrderFiles> {
  const actor = actorOf(officeContextOf(caller))
  const reach = reachOf(actor)
  return caller.withClient(async (db) => {
    const workOrder = await reachedWorkOrder(db, actor, workOrderId)
    // Its cells' order lines (a SAMPLE cell of no line names no order), and the lines' orders.
    const cells = await db.workOrderSize.findMany({ where: { workOrderId: workOrder.id }, select: { salesOrderLineId: true, measurementProfileId: true } })
    const lineIds = [...new Set(cells.flatMap((cell) => (cell.salesOrderLineId ? [cell.salesOrderLineId] : [])))]
    const lines = lineIds.length === 0 ? [] : await db.salesOrderLine.findMany({ where: { id: { in: lineIds } }, select: { id: true, orderId: true, seq: true, quoteLineId: true, measurementProfileId: true } })
    const orderIds = [...new Set(lines.map((line) => line.orderId))]
    const orders = orderIds.length === 0 ? [] : await db.salesOrder.findMany({ where: { id: { in: orderIds } }, select: { id: true, number: true, customerRef: true, status: true, orderDate: true, companyId: true, partyId: true }, orderBy: [{ orderDate: 'asc' }, { number: 'asc' }] })
    // The wall per order: files.read over the order's company and customer, else the whole group is counted, never named.
    const shown = orders.filter((order) => reach.files({ companyId: order.companyId, partyId: order.partyId }))
    const shownIds = new Set(shown.map((order) => order.id))
    const shownLines = lines.filter((line) => shownIds.has(line.orderId))
    const lineRef = new Map(shownLines.map((line) => [line.id, { id: line.id, seq: line.seq }]))

    // The artwork each line takes from the quote line it was made from (and that quote line's earlier versions).
    const upstreamLineOf = new Map<string, string>()
    for (const line of shownLines) {
      if (!line.quoteLineId) continue
      for (const entry of await artworkOf(db, { kind: 'ORDER', line: { id: line.id, quoteLineId: line.quoteLineId } })) if (entry.from === 'QUOTE_LINE') upstreamLineOf.set(entry.fileId, line.id)
    }
    const files =
      shown.length === 0
        ? []
        : await db.storedFile.findMany({
            where: {
              status: 'AVAILABLE',
              supersededAt: null,
              OR: [
                { recordType: 'SalesOrder', recordId: { in: [...shownIds] } },
                ...(shownLines.length > 0 ? [{ recordType: 'SalesOrderLine', recordId: { in: shownLines.map((line) => line.id) } }] : []),
                ...(upstreamLineOf.size > 0 ? [{ id: { in: [...upstreamLineOf.keys()] } }] : []),
              ],
            },
            select: FILE_SELECT,
            orderBy: [{ availableAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
            take: FILES_MAX,
          })

    // The newest worksheet version of each made-to-measure line's profile revision (the cell's, else the line's).
    const profileOfLine = new Map<string, string>()
    for (const cell of cells) if (cell.salesOrderLineId && cell.measurementProfileId && lineRef.has(cell.salesOrderLineId)) profileOfLine.set(cell.salesOrderLineId, cell.measurementProfileId)
    for (const line of shownLines) if (line.measurementProfileId && !profileOfLine.has(line.id)) profileOfLine.set(line.id, line.measurementProfileId)
    const profileIds = [...new Set(profileOfLine.values())]
    const sheets =
      profileIds.length === 0
        ? []
        : await db.generatedDocument.findMany({ where: { recordType: PROFILE_RECORD, recordId: { in: profileIds }, kind: WORKSHEET_KIND }, select: { id: true, recordId: true, version: true, number: true, language: true, createdAt: true }, orderBy: [{ version: 'desc' }, { id: 'asc' }] })
    const newestSheet = new Map<string, (typeof sheets)[number]>()
    for (const sheet of sheets) if (!newestSheet.has(sheet.recordId)) newestSheet.set(sheet.recordId, sheet)

    // "Order thread": the sales order's thread, for a reader who may read it (threads.read over its company and customer).
    const readable = shown.filter((order) => mayOnThread(actor, THREADS_READ, 'SalesOrder', { companyId: order.companyId, siteId: null, partyId: order.partyId }))
    const threads = readable.length === 0 ? [] : await db.thread.findMany({ where: { recordType: 'SalesOrder', recordId: { in: readable.map((order) => order.id) } }, select: { id: true, recordId: true } })
    const threadOf = new Map(threads.map((thread) => [thread.recordId, thread.id]))
    const readableIds = new Set(readable.map((order) => order.id))

    const groups = shown.map((order): OrderFilesGroup => {
      const scope = { partyId: order.partyId }
      let measurementsLeftOut = 0
      let filesLeftOut = 0
      const own: OrderFile[] = []
      for (const file of files) {
        const lineId = file.recordType === 'SalesOrderLine' ? file.recordId : (upstreamLineOf.get(file.id) ?? null)
        const isOrders = file.recordType === 'SalesOrder' ? file.recordId === order.id : lineId !== null && shownLines.some((line) => line.id === lineId && line.orderId === order.id)
        if (!isOrders) continue
        const at = { companyId: file.companyId, ...scope }
        if (!reach.files(at)) {
          filesLeftOut += 1
          continue
        }
        const bodyData = file.category !== null && BODY_DATA_CATEGORIES.has(file.category)
        if (bodyData && !reach.body(at)) {
          measurementsLeftOut += 1
          continue
        }
        own.push({
          id: file.id,
          companyId: file.companyId,
          from: file.recordType === 'SalesOrder' ? 'ORDER' : file.recordType === 'SalesOrderLine' ? 'LINE' : 'QUOTE_LINE',
          line: lineId ? (lineRef.get(lineId) ?? null) : null,
          name: file.originalName,
          contentType: file.contentType,
          kind: file.kind,
          category: file.category,
          sizeBytes: file.sizeBytes,
          versionNo: file.versionNo,
          at: file.availableAt ?? file.createdAt,
          bodyData,
        })
      }
      // A worksheet: the made-to-measure route's own check (sales.measurements.view over the customer), else counted.
      const worksheets: OrderWorksheet[] = []
      for (const line of shownLines.filter((row) => row.orderId === order.id).sort((a, b) => a.seq - b.seq)) {
        const profileId = profileOfLine.get(line.id)
        const sheet = profileId ? newestSheet.get(profileId) : undefined
        if (!profileId || !sheet) continue
        if (!reach.body(scope)) {
          measurementsLeftOut += 1
          continue
        }
        worksheets.push({ documentId: sheet.id, profileId, line: { id: line.id, seq: line.seq }, version: sheet.version, number: sheet.number, language: sheet.language, createdAt: sheet.createdAt })
      }
      return {
        order,
        thread: readableIds.has(order.id) ? { recordType: 'SalesOrder', recordId: order.id, threadId: threadOf.get(order.id) ?? null } : null,
        files: own,
        worksheets,
        measurementsLeftOut,
        filesLeftOut,
      }
    })
    return { workOrder: { id: workOrder.id, number: workOrder.number }, groups, ordersLeftOut: orders.length - shown.length }
  })
}

/** The answer of the list route (no company or party ids beyond what the office screens draw). */
export function orderFilesView(read: WorkOrderOrderFiles) {
  return {
    workOrder: read.workOrder,
    groups: read.groups.map((group) => ({
      order: { id: group.order.id, number: group.order.number, customerRef: group.order.customerRef, status: group.order.status, orderDate: dayOf(group.order.orderDate) },
      thread: group.thread,
      files: group.files.map(({ companyId: _companyId, at, ...file }) => ({ ...file, at: toUtcIso(at) })),
      worksheets: group.worksheets.map(({ createdAt, ...sheet }) => ({ ...sheet, createdAt: toUtcIso(createdAt) })),
      measurementsLeftOut: group.measurementsLeftOut,
      filesLeftOut: group.filesLeftOut,
    })),
    ordersLeftOut: read.ordersLeftOut,
  }
}
