import { z } from 'zod'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { notMoney } from '@nexus/factory-domain/money/marked'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { customerNumberOf, customerRefOf } from '@nexus/factory-domain/sales/customer-numbers'
import { KIND_RULES, type PortalDocumentKind } from '@nexus/factory-domain/sales/portal-documents/library'
import { contentWalledFor } from '../../../platform/files/content-wall'
import { ORDER_FILE_GROUP_WORDS, type OrderFileGroup } from '../orders/order-files'
import { readLibrary, visibleEntries, type LibraryEntry } from '../portal-documents/library'
import { partnerOrder, portalReader } from './access'

/**
 * B-SA-037 (Sales page plan N9, P14, R6, R7; 13-backend B11 "Portal face"; 13 §9.9): GET /portal/sales-orders/:orderId/files — the
 * customer's face of the order's files, drawn by the same Files component as the office's (F-SA-238), in the same groups — only the
 * groups a customer may hold:
 *
 *   ORDER      Order & thread         the order's files shared with the customer (the partner's own read: row-level security by party)
 *   LINES      Lines & artwork        its lines' files shared with it, and the library's artwork of the quote line a line was made from
 *   REQUESTS   Requests               the files of its own change requests on the order shared with it
 *   SHIPMENTS  Shipments & invoices   the order's entries of the customer-documents library: its shipments' documents, DDTs, its
 *                                     invoices (portal-documents/library readLibrary, by the person's own document rights)
 *   RETURNS    Returns & complaints   the library's entries of its returns and complaints on the order
 *
 * The brand wall (Owner rule 2026-11-16): the order is the party's own, read in the partner scope first (another customer's order is
 * "Order not found.", the words of an unknown id); every file is one shared with this party, and its CONTENT too — a copy whose
 * source chain names another customer (platform/files/content-wall contentWalledFor, the one rule of every portal read of files;
 * the library applies the same rule) is left out, uncounted. Never a work-order, hold or NCR file (never shared); never "also on"
 * (the office's record links); never "n hidden". No office number: the order and the lines by the customer's own numbers. A file
 * opens through the portal's own file routes (the content wall again). A read: no command, no event.
 */

export const CUSTOMER_FILE_GROUPS = ['ORDER', 'LINES', 'REQUESTS', 'SHIPMENTS', 'RETURNS'] as const satisfies readonly OrderFileGroup[]
export type CustomerFileGroup = (typeof CUSTOMER_FILE_GROUPS)[number]

/** At most this many own files of one order are read (an order has far fewer). */
const FILES_MAX = 500

const PORTAL_FILE_SELECT = { id: true, recordType: true, recordId: true, kind: true, category: true, originalName: true, contentType: true, sizeBytes: true, versionNo: true, availableAt: true, createdAt: true } as const

export interface PortalOrderFile {
  readonly id: string
  readonly group: CustomerFileGroup
  readonly name: string
  readonly kind: string
  readonly category: string | null
  /** The library's kind of document (a DDT, an invoice …); null: a plain file of the order. */
  readonly documentKind: PortalDocumentKind | null
  readonly contentType: string
  readonly sizeBytes: number
  readonly versionNo: number
  readonly at: Date
  readonly from: { readonly type: string; readonly id: string; readonly label: string | null }
  readonly line: { readonly id: string; readonly seq: number } | null
}

/** The group of a library entry: delivery and finance documents with the shipments and invoices, the rest by what they are for. */
export function groupOfEntry(entry: Pick<LibraryEntry, 'group' | 'for'>): CustomerFileGroup {
  if (entry.group === 'DELIVERY' || entry.group === 'FINANCE') return 'SHIPMENTS'
  switch (entry.for?.type) {
    case 'SalesOrderLine':
    case 'QuoteLine':
    case 'Style':
      return 'LINES'
    case 'Shipment':
    case 'Ddt':
    case 'Invoice':
      return 'SHIPMENTS'
    case 'ReturnAuthorisation':
    case 'ReturnLine':
    case 'Complaint':
      return 'RETURNS'
    case 'OrderChangeRequest':
      return 'REQUESTS'
    default:
      return 'ORDER'
  }
}

export async function portalOrderFiles(app: FastifyInstance, request: FastifyRequest, orderId: string, now: Date) {
  const reader = portalReader(app, request)
  // The partner read first: another customer's order is as unknown as a wrong id.
  const order = await partnerOrder(request, reader, orderId)
  const own = await request.withClient(async (client) => {
    const lines = await client.salesOrderLine.findMany({ where: { orderId: order.id }, select: { id: true, seq: true }, orderBy: { seq: 'asc' } })
    const requests = await client.orderChangeRequest.findMany({ where: { orderId: order.id }, select: { id: true } })
    const files = await client.storedFile.findMany({
      where: {
        status: 'AVAILABLE',
        supersededAt: null,
        visibility: { has: 'PARTNER' },
        // B-OF-005 (order files tab; P2-B1): a customer person who does not see prices is not told a priced file exists (left out,
        // uncounted: the Documents tab's prices note says it once) — opening it was refused already.
        ...(reader.seesPrices ? {} : { priced: false }),
        OR: [
          { recordType: 'SalesOrder', recordId: order.id },
          ...(lines.length > 0 ? [{ recordType: 'SalesOrderLine', recordId: { in: lines.map((line) => line.id) } }] : []),
          ...(requests.length > 0 ? [{ recordType: 'OrderChangeRequest', recordId: { in: requests.map((row) => row.id) } }] : []),
        ],
      },
      select: PORTAL_FILE_SELECT,
      orderBy: [{ availableAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      take: FILES_MAX,
    })
    return { lines, files }
  })
  // The content wall: a copy whose content is another customer's is left out, uncounted (read as the tenant, for exactly these).
  const walled = own.files.length === 0 ? new Set<string>() : await reader.inTenant((client) => contentWalledFor(client, reader.session.partyId, own.files.map((file) => file.id)))
  const lineOf = new Map(own.lines.map((line) => [line.id, line]))
  const orderLabel = customerRefOf('ORDER', order.customerSeq) ?? order.customerRef
  const byId = new Map<string, PortalOrderFile>()
  for (const file of own.files) {
    if (walled.has(file.id)) continue
    const line = file.recordType === 'SalesOrderLine' ? (lineOf.get(file.recordId) ?? null) : null
    const group: CustomerFileGroup = file.recordType === 'SalesOrderLine' ? 'LINES' : file.recordType === 'OrderChangeRequest' ? 'REQUESTS' : 'ORDER'
    byId.set(file.id, {
      id: file.id,
      group,
      name: file.originalName,
      kind: file.kind,
      category: file.category,
      documentKind: null,
      contentType: file.contentType,
      sizeBytes: file.sizeBytes,
      versionNo: file.versionNo,
      at: file.availableAt ?? file.createdAt,
      from: { type: file.recordType, id: file.recordId, label: line ? (orderLabel ? `${orderLabel} · ${line.seq}` : String(line.seq)) : orderLabel },
      line: line ? { id: line.id, seq: line.seq } : null,
    })
  }
  // The order's entries of the customer-documents library (by the person's own document rights; walled there too).
  const library = await readLibrary(app, request, now)
  for (const entry of visibleEntries(library)) {
    if (!entry.orderIds.includes(order.id) || entry.replacedById !== null) continue
    const group = groupOfEntry(entry)
    for (const ref of entry.files) {
      if (byId.has(ref.fileId)) continue
      byId.set(ref.fileId, {
        id: ref.fileId,
        group,
        name: ref.name,
        // A document of the library (its own format is in the content type).
        kind: 'DOCUMENT',
        category: null,
        documentKind: entry.kind,
        contentType: ref.contentType,
        sizeBytes: ref.sizeBytes,
        versionNo: entry.version,
        at: entry.date,
        from: { type: entry.for?.type ?? 'SalesOrder', id: entry.for?.id ?? order.id, label: entry.for?.label ?? orderLabel },
        line: null,
      })
    }
  }
  const files = [...byId.values()].sort((a, b) => b.at.getTime() - a.at.getTime() || (a.id < b.id ? -1 : 1))
  const groups = CUSTOMER_FILE_GROUPS.map((key) => ({
    key,
    words: ORDER_FILE_GROUP_WORDS[key],
    files: files.filter((file) => file.group === key).map(({ group: _group, at, documentKind, ...file }) => ({ ...file, documentKind, documentWords: documentKind ? KIND_RULES[documentKind].words : null, at: toUtcIso(at) })),
  }))
  return {
    asOf: toUtcIso(now),
    order: { id: order.id, customerRef: order.customerRef, yourNumber: customerNumberOf('ORDER', order.customerSeq) },
    groups,
    total: files.length,
  }
}

const words = output({ it: z.string(), en: z.string() })

export const portalOrderFilesContract = defineContract({
  params: input({ orderId: id() }),
  response: {
    200: output({
      asOf: instant(),
      /** The order by the customer's own numbers (never the office's series). */
      order: output({ id: id(), customerRef: z.string().nullable(), yourNumber: output({ seq: z.number().int(), words }).nullable() }),
      groups: z.array(
        output({
          key: z.enum(CUSTOMER_FILE_GROUPS),
          words,
          files: z.array(
            output({
              id: id(),
              name: z.string(),
              kind: z.string(),
              category: z.string().nullable(),
              documentKind: z.string().nullable(),
              documentWords: words.nullable(),
              contentType: z.string(),
              sizeBytes: z.number().int(),
              versionNo: z.number().int(),
              at: instant(),
              from: output({ type: z.string(), id: id(), label: z.string().nullable() }),
              line: output({ id: id(), seq: z.number().int() }).nullable(),
            }),
          ),
        }),
      ),
      /** How many files are listed (a count, not money). */
      total: notMoney(z.number().int()),
    }),
  },
})
