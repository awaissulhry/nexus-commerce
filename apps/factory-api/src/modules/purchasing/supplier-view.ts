import type { Prisma } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { purchaseOrderDocumentNumber } from '@nexus/factory-domain/purchasing/document'
import type { CommandCaller } from '../../core/command'
import { dayOf, decimal, officeOrder, quantityText, type Reader } from './store'

/**
 * What the supplier sees of its purchase order (PLAN §4.7 08-buy "no prices on the link"; Owner design answer C2: the
 * supplier's screens are price-free, the mailed PDF prints the prices): the order and its lines WITHOUT any price, amount,
 * internal note or who wrote it. The column sets below are exactly what the partner role may read
 * (ownership/supply.json hides netAmount, internalNote, sentById, createdById; unitPrice, netAmount on the lines), so the
 * same read works in a link session's party scope (B-W1-31's confirm page builds on `supplierView`) and in the office's
 * "What the supplier sees" preview (GET /purchasing/orders/:id/supplier-view, never a live token).
 *
 * The material's name and colour come from `labels` (Item and ItemColour are not the partner role's to read): the office
 * passes its own client; the link page passes the reader it decides (B-W1-31).
 */

export const SUPPLIER_ORDER_COLUMNS = {
  id: true,
  number: true,
  partyId: true,
  status: true,
  revision: true,
  orderDate: true,
  requestedDate: true,
  incoterms: true,
  paymentTerms: true,
  note: true,
  sentAt: true,
  confirmedAt: true,
  confirmedVia: true,
  confirmedByName: true,
  supplierRef: true,
  confirmNote: true,
  declinedAt: true,
  declineReason: true,
  cancelledAt: true,
  version: true,
} as const satisfies Prisma.PurchaseOrderSelect

export const SUPPLIER_LINE_COLUMNS = {
  id: true,
  seq: true,
  itemId: true,
  itemColourId: true,
  description: true,
  supplierArticleCode: true,
  supplierColourCode: true,
  quantity: true,
  uom: true,
  baseQuantity: true,
  needDate: true,
  grade: true,
  thicknessMinMm: true,
  thicknessMaxMm: true,
  oneDyeBatch: true,
  areaTolerancePct: true,
  estimatedHides: true,
  requiresCrViTest: true,
  note: true,
  confirmedQuantity: true,
  confirmedDate: true,
  // B-W2a-52: a line cancelled or closed short (the partner role reads when, never who or why).
  cancelledAt: true,
  closedShortAt: true,
  version: true,
} as const satisfies Prisma.PurchaseOrderLineSelect

const iso = (value: Date | null): string | null => (value === null ? null : toUtcIso(value))

/** The order as its supplier reads it: no price anywhere (see the module comment). */
export async function supplierView(db: Reader, orderId: string, labels: Reader = db) {
  const order = isUuid(orderId) ? await db.purchaseOrder.findUnique({ where: { id: orderId }, select: SUPPLIER_ORDER_COLUMNS }) : null
  if (!order) throw new NotFoundError('Purchase order not found.')
  const lines = await db.purchaseOrderLine.findMany({ where: { purchaseOrderId: order.id }, orderBy: { seq: 'asc' }, select: SUPPLIER_LINE_COLUMNS })
  const items = new Map((await labels.item.findMany({ where: { id: { in: [...new Set(lines.map((line) => line.itemId))] } }, select: { id: true, code: true, name: true, baseUom: true } })).map((item) => [item.id, item]))
  const colourIds = lines.flatMap((line) => (line.itemColourId ? [line.itemColourId] : []))
  const colours = new Map((colourIds.length === 0 ? [] : await labels.itemColour.findMany({ where: { id: { in: colourIds } }, select: { id: true, name: true } })).map((colour) => [colour.id, colour]))
  return {
    order: {
      id: order.id,
      number: order.number,
      documentNumber: purchaseOrderDocumentNumber(order.number, order.revision),
      status: order.status,
      revision: order.revision,
      orderDate: dayOf(order.orderDate)!,
      requestedDate: dayOf(order.requestedDate),
      incoterms: order.incoterms,
      paymentTerms: order.paymentTerms,
      note: order.note,
      sentAt: iso(order.sentAt),
      confirmedAt: iso(order.confirmedAt),
      confirmedVia: order.confirmedVia,
      confirmedByName: order.confirmedByName,
      supplierRef: order.supplierRef,
      confirmNote: order.confirmNote,
      declinedAt: iso(order.declinedAt),
      declineReason: order.declineReason,
      cancelledAt: iso(order.cancelledAt),
      version: order.version,
    },
    lines: lines.map((line) => {
      const item = items.get(line.itemId)
      const colour = line.itemColourId ? colours.get(line.itemColourId) : undefined
      return {
        id: line.id,
        seq: line.seq,
        code: line.supplierArticleCode ?? item?.code ?? null,
        name: item?.name ?? null,
        colour: line.itemColourId ? { name: colour?.name ?? null, supplierCode: line.supplierColourCode } : null,
        description: line.description,
        quantity: quantityText(line.quantity),
        uom: line.uom,
        baseQuantity: quantityText(line.baseQuantity),
        baseUom: item?.baseUom ?? null,
        needDate: dayOf(line.needDate)!,
        grade: line.grade,
        thicknessMinMm: decimal(line.thicknessMinMm),
        thicknessMaxMm: decimal(line.thicknessMaxMm),
        oneDyeBatch: line.oneDyeBatch,
        areaTolerancePct: decimal(line.areaTolerancePct),
        estimatedHides: line.estimatedHides,
        requiresCrViTest: line.requiresCrViTest,
        note: line.note,
        confirmedQuantity: line.confirmedQuantity === null ? null : quantityText(line.confirmedQuantity),
        confirmedDate: dayOf(line.confirmedDate),
        ended: line.cancelledAt ? ('CANCELLED' as const) : line.closedShortAt ? ('CLOSED_SHORT' as const) : null,
        version: line.version,
      }
    }),
  }
}

/** purchasing.view: the office's preview of what the supplier sees on its confirm link. */
export async function previewSupplierView(caller: CommandCaller, orderId: string) {
  const order = await officeOrder(caller, orderId)
  return caller.withClient((client) => supplierView(client, order.id))
}
