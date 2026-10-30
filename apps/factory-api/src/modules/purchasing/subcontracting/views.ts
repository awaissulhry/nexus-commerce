import type { Prisma } from '@nexus/factory-db'
import { toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { asMoney } from '@nexus/factory-domain/money/marked'
import {
  atWorkshopOf,
  backOf,
  cancelProblems,
  closeProblems,
  isLate,
  issueProblems,
  kitStateOf,
  receiveProblems,
  reopenProblems,
  sendProblems,
  type SubcontractOrderStatus,
} from '@nexus/factory-domain/purchasing/subcontracting/rules'
import { dayOf, quantityText, type Reader } from '../store'
import { KIT_COLUMNS, nameOf, OPERATION_COLUMNS, sizesOf, type KitRow, type OperationRow, type OrderRow } from './store'

/**
 * The subcontract orders as the screens read them (design purchasing.subcontracting: the grid, the record's tabs
 * "Operations & quantities", "Kit sent", "Received back", "Documents"). Fees and amounts are marked money.cost: the API
 * drops them for a caller without the cost grain. Reads run one after another (a reader may be a transaction's one
 * connection: no Promise.all on it).
 */

const unique = <T>(values: readonly (T | null | undefined)[]): T[] => [...new Set(values.filter((value): value is T => value !== null && value !== undefined))]
const named = <Row extends { id: string }>(rows: readonly Row[]) => new Map(rows.map((row) => [row.id, row]))
const ref = (row: { id: string; code: string; name: string } | undefined, id: string) => row ?? { id, code: '', name: '' }

/** The audit action whose rows are the order's receipts (one row per receipt: what came back, bundle by bundle). */
export const RECEIPT_ACTION = 'purchasing.subcontract.receiveBack'

interface Lookups {
  readonly sites: Map<string, { id: string; code: string }>
  readonly parties: Map<string, { id: string; code: string; name: string }>
  readonly locations: Map<string, { id: string; code: string; name: string }>
  readonly workOrders: Map<string, { id: string; number: string; status: string; style: { id: string; code: string; name: string } }>
  readonly operations: Map<string, OperationRow[]>
  readonly kit: Map<string, KitRow[]>
  readonly woOperations: Map<string, { id: string; seq: number; code: string; name: string }>
}

async function lookups(db: Reader, orders: readonly OrderRow[]): Promise<Lookups> {
  const orderIds = orders.map((order) => order.id)
  const sites = await db.site.findMany({ where: { id: { in: unique(orders.map((order) => order.siteId)) } }, select: { id: true, code: true } })
  const parties = await db.party.findMany({ where: { id: { in: unique(orders.map((order) => order.partyId)) } }, select: { id: true, code: true, legalName: true, tradeName: true } })
  const locations = await db.location.findMany({ where: { id: { in: unique(orders.map((order) => order.locationId)) } }, select: { id: true, code: true, name: true } })
  const workOrders = await db.workOrder.findMany({ where: { id: { in: unique(orders.map((order) => order.workOrderId)) } }, select: { id: true, number: true, status: true, styleId: true } })
  const styles = await db.style.findMany({ where: { id: { in: unique(workOrders.map((row) => row.styleId)) } }, select: { id: true, code: true, name: true } })
  const operations = await db.subcontractOperation.findMany({ where: { subcontractOrderId: { in: orderIds } }, select: OPERATION_COLUMNS, orderBy: [{ subcontractOrderId: 'asc' }, { seq: 'asc' }] })
  const kit = await db.subcontractKitLine.findMany({ where: { subcontractOrderId: { in: orderIds } }, select: KIT_COLUMNS, orderBy: [{ subcontractOrderId: 'asc' }, { seq: 'asc' }] })
  const woOperations = await db.workOrderOperation.findMany({ where: { id: { in: unique(operations.map((row) => row.workOrderOperationId)) } }, select: { id: true, seq: true, code: true, name: true } })
  const styleOf = named(styles)
  const group = <Row extends { subcontractOrderId: string }>(rows: readonly Row[]) => {
    const out = new Map<string, Row[]>()
    for (const row of rows) out.set(row.subcontractOrderId, [...(out.get(row.subcontractOrderId) ?? []), row])
    return out
  }
  return {
    sites: named(sites),
    parties: new Map(parties.map((party) => [party.id, { id: party.id, code: party.code, name: nameOf(party) }])),
    locations: named(locations),
    workOrders: new Map(workOrders.map((row) => [row.id, { id: row.id, number: row.number, status: row.status, style: ref(styleOf.get(row.styleId), row.styleId) }])),
    operations: group(operations),
    kit: group(kit),
    woOperations: named(woOperations),
  }
}

function countsOf(operations: readonly OperationRow[]) {
  const sum = (pick: (row: OperationRow) => number) => operations.reduce((total, row) => total + pick(row), 0)
  return {
    ordered: sum((row) => row.pieces),
    sent: sum((row) => row.piecesSent),
    backGood: sum((row) => row.piecesBackGood),
    backDefective: sum((row) => row.piecesBackDefective),
    scrapped: sum((row) => row.piecesScrapped),
    atWorkshop: sum((row) => atWorkshopOf(row)),
  }
}

function summaryOf(order: OrderRow, found: Lookups, today: BusinessDate) {
  const operations = found.operations.get(order.id) ?? []
  const kit = found.kit.get(order.id) ?? []
  const expectedBackDate = dayOf(order.expectedBackDate)
  return {
    id: order.id,
    number: order.number,
    status: order.status,
    companyId: order.companyId,
    site: found.sites.get(order.siteId) ?? { id: order.siteId, code: '' },
    workshop: ref(found.parties.get(order.partyId), order.partyId),
    location: ref(found.locations.get(order.locationId), order.locationId),
    workOrder: found.workOrders.get(order.workOrderId) ?? { id: order.workOrderId, number: '', status: '', style: { id: order.workOrderId, code: '', name: '' } },
    orderDate: dayOf(order.orderDate)!,
    expectedBackDate,
    late: isLate(order.status, expectedBackDate, today),
    services: operations.map((row) => {
      const operation = found.woOperations.get(row.workOrderOperationId)
      return { seq: operation?.seq ?? row.seq, code: operation?.code ?? '', name: operation?.name ?? '' }
    }),
    pieces: countsOf(operations),
    kit: {
      state: kitStateOf(kit),
      planned: kit.filter((line) => line.status === 'PLANNED').length,
      sent: kit.filter((line) => line.status === 'SENT').length,
      cancelled: kit.filter((line) => line.status === 'CANCELLED').length,
    },
    currency: order.currency,
    netAmount: asMoney('cost', order.netAmount),
    version: order.version,
    createdAt: toUtcIso(order.createdAt),
    updatedAt: toUtcIso(order.updatedAt),
  }
}
export type OrderSummaryView = ReturnType<typeof summaryOf>

/** The list's rows, in the order given. */
export async function orderSummaries(db: Reader, orders: readonly OrderRow[], today: BusinessDate): Promise<OrderSummaryView[]> {
  if (orders.length === 0) return []
  const found = await lookups(db, orders)
  return orders.map((order) => summaryOf(order, found, today))
}

// ---- the receipts (from the audit rows of their command) -----------------------------------------------------------------

interface StoredReceiptLine {
  readonly operationId: string
  readonly seq: number
  readonly code: string
  readonly bundleId: string | null
  readonly good: number
  readonly defective: number
  readonly scrapped: number
  readonly reason: string | null
}
interface StoredReturn {
  readonly moveId: string
  readonly itemId: string
  readonly itemColourId: string | null
  readonly lotId: string | null
  readonly hideId: string | null
  readonly quantity: string
  readonly uom: string
  readonly toLocationId: string
}
export interface StoredReceipt {
  readonly receiptId: string
  readonly receivedAt: string
  readonly lines: readonly StoredReceiptLine[]
  readonly returns: readonly StoredReturn[]
  readonly supplierDdt: { readonly number: string; readonly date: string | null } | null
  readonly note: string | null
}

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const str = (value: unknown): string | null => (typeof value === 'string' ? value : null)
const int = (value: unknown): number => (typeof value === 'number' && Number.isInteger(value) ? value : 0)

/** A receipt as its audit row stored it (written by receive.ts; anything else is skipped). */
export function storedReceiptOf(after: Prisma.JsonValue | null): StoredReceipt | null {
  if (!isObject(after) || typeof after.receiptId !== 'string' || typeof after.receivedAt !== 'string') return null
  const lines = (Array.isArray(after.lines) ? after.lines : []).flatMap((line) => (isObject(line) ? [line] : [])).map((line) => ({
    operationId: str(line.operationId) ?? '',
    seq: int(line.seq),
    code: str(line.code) ?? '',
    bundleId: str(line.bundleId),
    good: int(line.good),
    defective: int(line.defective),
    scrapped: int(line.scrapped),
    reason: str(line.reason),
  }))
  const returns = (Array.isArray(after.returns) ? after.returns : []).flatMap((row) => (isObject(row) ? [row] : [])).map((row) => ({
    moveId: str(row.moveId) ?? '',
    itemId: str(row.itemId) ?? '',
    itemColourId: str(row.itemColourId),
    lotId: str(row.lotId),
    hideId: str(row.hideId),
    quantity: str(row.quantity) ?? '0',
    uom: str(row.uom) ?? 'PCS',
    toLocationId: str(row.toLocationId) ?? '',
  }))
  const ddt = isObject(after.supplierDdt) && typeof after.supplierDdt.number === 'string' ? { number: after.supplierDdt.number, date: str(after.supplierDdt.date) } : null
  return { receiptId: after.receiptId, receivedAt: after.receivedAt, lines, returns, supplierDdt: ddt, note: str(after.note) }
}

/** The order's receipts, oldest first, with when and by whom they were recorded. */
export async function storedReceipts(db: Reader, orderId: string): Promise<(StoredReceipt & { recordedAt: Date; byId: string | null })[]> {
  const rows = await db.auditLog.findMany({ where: { recordType: 'SubcontractOrder', recordId: orderId, action: RECEIPT_ACTION }, select: { at: true, actorId: true, audience: true, after: true }, orderBy: [{ at: 'asc' }, { id: 'asc' }] })
  return rows.flatMap((row) => {
    const receipt = storedReceiptOf(row.after)
    return receipt ? [{ ...receipt, recordedAt: row.at, byId: row.audience === 'OFFICE' ? row.actorId : null }] : []
  })
}

/** Receipts as the record shows them (bundles, cells, materials and places named). */
export async function receiptViews(db: Reader, receipts: Awaited<ReturnType<typeof storedReceipts>>) {
  const bundleIds = unique(receipts.flatMap((receipt) => receipt.lines.map((line) => line.bundleId)))
  const bundles = await db.bundle.findMany({ where: { id: { in: bundleIds } }, select: { id: true, code: true, workOrderSizeId: true } })
  const cells = await db.workOrderSize.findMany({ where: { id: { in: unique(bundles.map((bundle) => bundle.workOrderSizeId)) } }, select: { id: true, size: true, colourwayId: true } })
  const colourways = named(await db.colourway.findMany({ where: { id: { in: unique(cells.map((cell) => cell.colourwayId)) } }, select: { id: true, code: true } }))
  const returns = receipts.flatMap((receipt) => receipt.returns)
  const items = named(await db.item.findMany({ where: { id: { in: unique(returns.map((row) => row.itemId)) } }, select: { id: true, code: true, name: true } }))
  const colours = named(await db.itemColour.findMany({ where: { id: { in: unique(returns.map((row) => row.itemColourId)) } }, select: { id: true, code: true, name: true } }))
  const lots = named(await db.lot.findMany({ where: { id: { in: unique(returns.map((row) => row.lotId)) } }, select: { id: true, code: true } }))
  const hides = named(await db.hide.findMany({ where: { id: { in: unique(returns.map((row) => row.hideId)) } }, select: { id: true, code: true } }))
  const locations = named(await db.location.findMany({ where: { id: { in: unique(returns.map((row) => row.toLocationId)) } }, select: { id: true, code: true, name: true } }))
  const bundleOf = named(bundles)
  const cellOf = named(cells)
  return receipts.map((receipt) => ({
    id: receipt.receiptId,
    receivedAt: receipt.receivedAt,
    recordedAt: toUtcIso(receipt.recordedAt),
    byId: receipt.byId,
    lines: receipt.lines.map((line) => {
      const bundle = line.bundleId ? bundleOf.get(line.bundleId) : undefined
      const cell = bundle ? cellOf.get(bundle.workOrderSizeId) : undefined
      return {
        operationId: line.operationId,
        seq: line.seq,
        code: line.code,
        bundle: bundle ? { id: bundle.id, code: bundle.code, workOrderSizeId: bundle.workOrderSizeId, colourway: cell ? (colourways.get(cell.colourwayId)?.code ?? '') : '', size: cell?.size ?? '' } : null,
        good: line.good,
        defective: line.defective,
        scrapped: line.scrapped,
        reason: line.reason,
      }
    }),
    returns: receipt.returns.map((row) => ({
      moveId: row.moveId,
      item: { id: row.itemId, code: items.get(row.itemId)?.code ?? '', name: items.get(row.itemId)?.name ?? '' },
      colour: row.itemColourId ? (colours.get(row.itemColourId) ?? { id: row.itemColourId, code: '', name: '' }) : null,
      lot: row.lotId ? { id: row.lotId, code: lots.get(row.lotId)?.code ?? '', name: lots.get(row.lotId)?.code ?? '' } : null,
      hide: row.hideId ? { id: row.hideId, code: hides.get(row.hideId)?.code ?? '', name: hides.get(row.hideId)?.code ?? '' } : null,
      quantity: row.quantity,
      uom: row.uom as 'PCS',
      toLocation: ref(locations.get(row.toLocationId), row.toLocationId),
    })),
    supplierDdt: receipt.supplierDdt,
    note: receipt.note,
  }))
}

// ---- the record -------------------------------------------------------------------------------------------------------

/** The order's kit DDTs (live and cancelled), newest first. */
async function ddtsOf(db: Reader, orderId: string) {
  const rows = await db.ddt.findMany({
    where: { sourceType: 'SubcontractOrder', sourceId: orderId },
    select: { id: true, number: true, documentDate: true, lines: true, cancellations: { select: { id: true }, take: 1 } },
    orderBy: { id: 'desc' },
  })
  return rows.map((row) => ({
    id: row.id,
    number: row.number,
    documentDate: dayOf(row.documentDate)!,
    cancelled: row.cancellations.length > 0,
    kitLineIds: (Array.isArray(row.lines) ? row.lines : []).flatMap((line) => {
      const id = isObject(line) ? line.sourceLineId : null
      return typeof id === 'string' ? [id] : []
    }),
  }))
}

const heldOf = (problems: readonly string[]): string | null => (problems.length === 0 ? null : problems.join(' '))

/** The whole order as the record shows it. */
export async function orderDetailOf(db: Reader, order: OrderRow, today: BusinessDate) {
  const found = await lookups(db, [order])
  const summary = summaryOf(order, found, today)
  const operations = found.operations.get(order.id) ?? []
  const kit = found.kit.get(order.id) ?? []
  const cells = await db.workOrderSize.findMany({ where: { workOrderId: order.workOrderId }, select: { id: true, size: true, colourwayId: true } })
  const colourways = named(await db.colourway.findMany({ where: { id: { in: unique(cells.map((cell) => cell.colourwayId)) } }, select: { id: true, code: true } }))
  const cellOf = new Map(cells.map((cell) => [cell.id, { colourway: colourways.get(cell.colourwayId)?.code ?? '', size: cell.size }]))
  const items = named(await db.item.findMany({ where: { id: { in: unique(kit.map((line) => line.itemId)) } }, select: { id: true, code: true, name: true, baseUom: true, tracking: true } }))
  const colours = named(await db.itemColour.findMany({ where: { id: { in: unique(kit.map((line) => line.itemColourId)) } }, select: { id: true, code: true, name: true } }))
  const lots = named(await db.lot.findMany({ where: { id: { in: unique(kit.map((line) => line.lotId)) } }, select: { id: true, code: true, qualityStatus: true } }))
  const hides = named(await db.hide.findMany({ where: { id: { in: unique(kit.map((line) => line.hideId)) } }, select: { id: true, code: true } }))
  const ddts = await ddtsOf(db, order.id)
  const ddtOf = named(ddts)
  const receipts = await receiptViews(db, await storedReceipts(db, order.id))
  const party = await db.party.findUnique({ where: { id: order.partyId }, select: { status: true } })
  const location = await db.location.findUnique({ where: { id: order.locationId }, select: { status: true } })
  const workOrderStatus = found.workOrders.get(order.workOrderId)?.status ?? ''
  const facts = {
    status: order.status as SubcontractOrderStatus,
    expectedBackDate: dayOf(order.expectedBackDate),
    orderDate: dayOf(order.orderDate)!,
    currency: order.currency,
    workshopActive: party?.status === 'ACTIVE',
    locationActive: location?.status === 'ACTIVE',
    workOrderStatus,
    operations: operations.map((row) => ({ seq: row.seq, code: found.woOperations.get(row.workOrderOperationId)?.code, pieces: row.pieces, pricePerPiece: row.pricePerPiece.toString(), piecesSent: row.piecesSent })),
    kitLines: kit.map((line) => ({ status: line.status })),
  }
  const somethingAtWorkshop = operations.some((row) => atWorkshopOf(row) > 0) || kit.some((line) => line.status === 'SENT')
  return {
    ...summary,
    note: order.note,
    internalNote: order.internalNote,
    issuedAt: order.issuedAt ? toUtcIso(order.issuedAt) : null,
    issuedById: order.issuedById,
    closedAt: order.closedAt ? toUtcIso(order.closedAt) : null,
    cancelledAt: order.cancelledAt ? toUtcIso(order.cancelledAt) : null,
    cancelReason: order.cancelReason,
    operations: operations.map((row) => {
      const operation = found.woOperations.get(row.workOrderOperationId)
      return {
        id: row.id,
        seq: row.seq,
        workOrderOperation: { id: row.workOrderOperationId, seq: operation?.seq ?? 0, code: operation?.code ?? '', name: operation?.name ?? '' },
        pieces: row.pieces,
        sizes: sizesOf(row.sizes).map((size) => ({ ...size, colourway: cellOf.get(size.workOrderSizeId)?.colourway ?? '', size: cellOf.get(size.workOrderSizeId)?.size ?? '' })),
        pricePerPiece: asMoney('cost', row.pricePerPiece.toFixed(6)),
        netAmount: asMoney('cost', row.netAmount),
        expectedBackDate: dayOf(row.expectedBackDate),
        piecesSent: row.piecesSent,
        piecesBackGood: row.piecesBackGood,
        piecesBackDefective: row.piecesBackDefective,
        piecesScrapped: row.piecesScrapped,
        atWorkshop: row.piecesSent - backOf(row),
        note: row.note,
        version: row.version,
      }
    }),
    kitLines: kit.map((line) => {
      const item = items.get(line.itemId)
      const ddt = line.ddtId ? ddtOf.get(line.ddtId) : undefined
      return {
        id: line.id,
        seq: line.seq,
        item: item ?? { id: line.itemId, code: '', name: '', baseUom: line.uom, tracking: 'NONE' as const },
        colour: line.itemColourId ? (colours.get(line.itemColourId) ?? { id: line.itemColourId, code: '', name: '' }) : null,
        lot: line.lotId ? (lots.get(line.lotId) ?? { id: line.lotId, code: '', qualityStatus: '' }) : null,
        hide: line.hideId ? (hides.get(line.hideId) ?? { id: line.hideId, code: '' }) : null,
        quantity: quantityText(line.quantity),
        uom: line.uom,
        baseQuantity: quantityText(line.baseQuantity),
        status: line.status,
        sentAt: line.sentAt ? toUtcIso(line.sentAt) : null,
        moveId: line.moveId,
        ddt: ddt ? { id: ddt.id, number: ddt.number, cancelled: ddt.cancelled } : null,
        note: line.note,
        version: line.version,
      }
    }),
    receipts,
    ddts,
    actions: {
      issue: heldOf(issueProblems(facts)),
      reopen: heldOf(reopenProblems(facts)),
      cancel: heldOf(cancelProblems(facts)),
      close: heldOf(closeProblems(facts)),
      send: heldOf(sendProblems(facts)),
      receive: heldOf(somethingAtWorkshop ? receiveProblems(facts, true) : [order.status === 'RECEIVED' ? 'Every piece is back.' : 'Nothing is at the workshop yet: send the kit or the pieces first.']),
    },
  }
}
export type OrderDetailView = Awaited<ReturnType<typeof orderDetailOf>>
