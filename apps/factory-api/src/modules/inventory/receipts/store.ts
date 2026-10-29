import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { hideTagPrefix } from '@nexus/factory-domain/inventory/receipts/rules'
import { Dec, ZERO, type Decimal } from '@nexus/factory-domain/tax/decimal'
import type { CommandTx } from '../../../core/command'

/**
 * The goods receipts' reads (factory-db inventory.prisma GoodsReceipt, GoodsReceiptLine, Lot, Hide; supply.prisma
 * PurchaseOrder, PurchaseOrderLine): the columns every read names, the order lines a receipt counts against with what
 * POSTED receipts brought them, and the tenant's hide-tag lock. Inside a command's transaction the reads select no
 * relation and run one after another on its one connection; row-level security decides what they find.
 */

export type Reader = FactoryClient | CommandTx

export const dec = (value: { toString(): string } | null | undefined): Decimal => (value === null || value === undefined ? ZERO : new Dec(value.toString()))
export const byId = <Row extends { id: string }>(rows: readonly Row[]): Map<string, Row> => new Map(rows.map((row) => [row.id, row]))
export const ids = (values: Iterable<string | null | undefined>): string[] => [...new Set([...values].filter((value): value is string => typeof value === 'string' && isUuid(value)))]

export const RECEIPT_COLUMNS = {
  id: true,
  companyId: true,
  siteId: true,
  number: true,
  supplierId: true,
  purchaseOrderId: true,
  supplierDdtNumber: true,
  supplierDdtDate: true,
  receivedAt: true,
  status: true,
  note: true,
  postedAt: true,
  postedById: true,
  reversedAt: true,
  reversedById: true,
  reversalReason: true,
  cancelledAt: true,
  version: true,
  createdAt: true,
  createdById: true,
} as const satisfies Prisma.GoodsReceiptSelect
export type ReceiptRow = Prisma.GoodsReceiptGetPayload<{ select: typeof RECEIPT_COLUMNS }>

export const RECEIPT_LINE_COLUMNS = {
  id: true,
  receiptId: true,
  seq: true,
  purchaseOrderLineId: true,
  itemId: true,
  itemColourId: true,
  quantity: true,
  uom: true,
  baseQuantity: true,
  hideCount: true,
  note: true,
} as const satisfies Prisma.GoodsReceiptLineSelect
export type ReceiptLineRow = Prisma.GoodsReceiptLineGetPayload<{ select: typeof RECEIPT_LINE_COLUMNS }>

export const LOT_COLUMNS = {
  id: true,
  siteId: true,
  itemId: true,
  itemColourId: true,
  code: true,
  supplierLotRef: true,
  dyeBatch: true,
  shade: true,
  receiptLineId: true,
  receivedAt: true,
  qualityStatus: true,
  qualityNote: true,
  qualityDecidedAt: true,
  requiresCrViTest: true,
  crViLimitMgKg: true,
  crViStatus: true,
  version: true,
} as const satisfies Prisma.LotSelect
export type LotRow = Prisma.LotGetPayload<{ select: typeof LOT_COLUMNS }>

export const HIDE_COLUMNS = {
  id: true,
  lotId: true,
  code: true,
  supplierCode: true,
  area: true,
  areaUom: true,
  baseArea: true,
  grade: true,
  shade: true,
  thicknessMm: true,
  defects: true,
  state: true,
} as const satisfies Prisma.HideSelect
export type HideRow = Prisma.HideGetPayload<{ select: typeof HIDE_COLUMNS }>

/** What a receipt reads of a material (with the cost columns only where the caller is the office). */
export const ITEM_COLUMNS = {
  id: true,
  code: true,
  name: true,
  kind: true,
  tracking: true,
  baseUom: true,
  purchaseUom: true,
  purchaseFactor: true,
  consumptionUom: true,
  consumptionFactor: true,
  currency: true,
  isPpeComponent: true,
  requiresCrViTest: true,
  crViLimitMgKg: true,
} as const satisfies Prisma.ItemSelect
export type ItemRow = Prisma.ItemGetPayload<{ select: typeof ITEM_COLUMNS }>

/** An order line as a receipt counts against it (its price only for the office: the floor's column grants hide it). */
export const ORDER_LINE_COLUMNS = {
  id: true,
  purchaseOrderId: true,
  seq: true,
  itemId: true,
  itemColourId: true,
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
  confirmedQuantity: true,
} as const satisfies Prisma.PurchaseOrderLineSelect
export type OrderLineRow = Prisma.PurchaseOrderLineGetPayload<{ select: typeof ORDER_LINE_COLUMNS }>

export async function readItems(db: Reader, itemIds: Iterable<string>): Promise<Map<string, ItemRow>> {
  return byId(await db.item.findMany({ where: { id: { in: ids(itemIds) } }, select: ITEM_COLUMNS }))
}

export async function readColours(db: Reader, colourIds: Iterable<string | null>): Promise<Map<string, { id: string; itemId: string; code: string; name: string }>> {
  return byId(await db.itemColour.findMany({ where: { id: { in: ids(colourIds) } }, select: { id: true, itemId: true, code: true, name: true } }))
}

/** The order's lines with what POSTED receipts brought each of them, in the base unit (a receipt being posted counts once POSTED). */
export async function readOrderLines(db: Reader, orderId: string): Promise<{ lines: OrderLineRow[]; received: Map<string, Decimal> }> {
  const lines = await db.purchaseOrderLine.findMany({ where: { purchaseOrderId: orderId }, select: ORDER_LINE_COLUMNS, orderBy: { seq: 'asc' } })
  const sums = await db.goodsReceiptLine.groupBy({
    by: ['purchaseOrderLineId'],
    where: { purchaseOrderLineId: { in: lines.map((line) => line.id) }, receipt: { status: 'POSTED' } },
    _sum: { baseQuantity: true },
  })
  return { lines, received: new Map(sums.map((row) => [row.purchaseOrderLineId!, dec(row._sum.baseQuantity)])) }
}

/** The hides a lot of the order line had in earlier receipts (for the estimate) and their dye batches. */
export async function readEarlierLots(db: Reader, orderLineIds: readonly string[]): Promise<Map<string, { dyeBatches: (string | null)[]; hides: number }>> {
  const result = new Map<string, { dyeBatches: (string | null)[]; hides: number }>()
  if (orderLineIds.length === 0) return result
  const lines = await db.goodsReceiptLine.findMany({ where: { purchaseOrderLineId: { in: [...orderLineIds] }, receipt: { status: 'POSTED' } }, select: { id: true, purchaseOrderLineId: true, hideCount: true } })
  const lots = await db.lot.findMany({ where: { receiptLineId: { in: lines.map((line) => line.id) } }, select: { receiptLineId: true, dyeBatch: true } })
  for (const line of lines) {
    const entry = result.get(line.purchaseOrderLineId!) ?? { dyeBatches: [], hides: 0 }
    entry.hides += line.hideCount ?? 0
    entry.dyeBatches.push(...lots.filter((lot) => lot.receiptLineId === line.id).map((lot) => lot.dyeBatch))
    result.set(line.purchaseOrderLineId!, entry)
  }
  return result
}

/**
 * The tenant's hide-tag lock: the next tags (HIDE scan ids, after the highest one) are read and inserted by one
 * receipt at a time. Taken after the order's locks. Returns the tenant's highest tag (null: none yet). The office reads
 * every hide of the tenant; a floor device reads only its site's (B-W1-33 needs a tenant-wide counter).
 */
export async function lockHideTags(tx: CommandTx, tenantId: string): Promise<string | null> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.hide-tag', ${tenantId}::uuid), 0))`
  const prefix = hideTagPrefix(tenantId)
  const [row] = await tx.$queryRaw<{ code: string }[]>`
    SELECT "code" FROM "Hide" WHERE "code" LIKE ${`${prefix}%`} ORDER BY length("code") DESC, "code" DESC LIMIT 1`
  return row?.code ?? null
}

/** The RECEIPT moves a receipt posted (not their reversals), in posting order. */
export async function readReceiptMoves(db: Reader, receiptId: string) {
  return db.stockMove.findMany({
    where: { reason: 'RECEIPT', reversalOfId: null, receiptLine: { receiptId } },
    select: {
      id: true,
      companyId: true,
      siteId: true,
      reason: true,
      itemId: true,
      itemColourId: true,
      lotId: true,
      hideId: true,
      fromLocationId: true,
      toLocationId: true,
      quantity: true,
      uom: true,
      baseQuantity: true,
      receiptLineId: true,
      workOrderId: true,
      reference: true,
      reversalOfId: true,
    },
    orderBy: { id: 'asc' },
  })
}
export type ReceiptMoveRow = Awaited<ReturnType<typeof readReceiptMoves>>[number]
