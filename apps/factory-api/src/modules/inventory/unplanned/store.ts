import { createHash } from 'node:crypto'
import type { Prisma } from '@nexus/factory-db'
import type { CommandTx } from '../../../core/command'
import { RECEIPT_COLUMNS, type Reader } from '../receipts/store'

/**
 * Goods without a purchase order (B-W2b-300; SCM-122): the rows this module reads. A GoodsReceipt of kind UNPLANNED (B-W2b-277)
 * carries its holding place and, once asked, its buyer's task; its lines name no order line until a buyer names the order.
 */

export const UNPLANNED_COLUMNS = {
  ...RECEIPT_COLUMNS,
  kind: true,
  holdingLocationId: true,
  buyerTaskId: true,
} as const satisfies Prisma.GoodsReceiptSelect
export type UnplannedRow = Prisma.GoodsReceiptGetPayload<{ select: typeof UNPLANNED_COLUMNS }>

export const UNPLANNED_LINE_COLUMNS = {
  id: true,
  seq: true,
  itemId: true,
  itemColourId: true,
  quantity: true,
  uom: true,
  baseQuantity: true,
  hideCount: true,
  note: true,
  purchaseOrderLineId: true,
} as const satisfies Prisma.GoodsReceiptLineSelect
export type UnplannedLineRow = Prisma.GoodsReceiptLineGetPayload<{ select: typeof UNPLANNED_LINE_COLUMNS }>

export const UNPLANNED_ITEM_COLUMNS = { id: true, code: true, name: true, kind: true, tracking: true, baseUom: true, purchaseUom: true, purchaseFactor: true, consumptionUom: true, consumptionFactor: true, status: true } as const satisfies Prisma.ItemSelect
export type UnplannedItemRow = Prisma.ItemGetPayload<{ select: typeof UNPLANNED_ITEM_COLUMNS }>

export const PLACE_COLUMNS = { id: true, siteId: true, code: true, name: true, kind: true, status: true, labelCode: true } as const satisfies Prisma.LocationSelect

/** One goods-without-a-PO receipt (null: no such receipt here, or not of that kind). */
export async function readUnplanned(db: Reader, receiptId: string): Promise<UnplannedRow | null> {
  const row = await db.goodsReceipt.findUnique({ where: { id: receiptId }, select: UNPLANNED_COLUMNS })
  return row && row.kind === 'UNPLANNED' ? row : null
}

/** Inside a command: the receipt's row locked to the commit, then read. */
export async function lockUnplanned(tx: CommandTx, receiptId: string): Promise<UnplannedRow | null> {
  await tx.$queryRaw`SELECT id FROM "GoodsReceipt" WHERE id = ${receiptId}::uuid FOR UPDATE`
  return readUnplanned(tx, receiptId)
}

export async function readUnplannedLines(db: Reader, receiptId: string): Promise<UnplannedLineRow[]> {
  return db.goodsReceiptLine.findMany({ where: { receiptId }, select: UNPLANNED_LINE_COLUMNS, orderBy: { seq: 'asc' } })
}

/** The site's suggested holding place: where its last goods without a PO waited, while it still takes them. */
export async function lastHoldingPlace(db: Reader, siteId: string) {
  const last = await db.goodsReceipt.findFirst({ where: { siteId, kind: 'UNPLANNED' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { holdingLocationId: true } })
  if (!last?.holdingLocationId) return null
  return db.location.findUnique({ where: { id: last.holdingLocationId }, select: PLACE_COLUMNS })
}

/** A place of the site by the label scanned, or its code as typed (either case). */
export async function placeOfScan(db: Reader, siteId: string, code: string) {
  const text = code.trim()
  return (
    (await db.location.findFirst({ where: { siteId, labelCode: { equals: text, mode: 'insensitive' } }, select: PLACE_COLUMNS })) ??
    (await db.location.findFirst({ where: { siteId, code: { equals: text, mode: 'insensitive' } }, select: PLACE_COLUMNS }))
  )
}

/** A UUID (version 8, RFC 9562) derived from a text: the same text, the same id (the buyer's task of a receipt is asked once). */
export function derivedId(text: string): string {
  const hex = createHash('sha256').update(text).digest('hex')
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

export const buyerTaskIdOf = (receiptId: string): string => derivedId(`unplanned-buyer|${receiptId}`)

/** "Line 10 (SEED-LIN-100 GRY)". */
export const lineLabel = (seq: number, item: { readonly code: string }, colour: { readonly code: string } | null | undefined): string => `Line ${seq} (${item.code}${colour ? ` ${colour.code}` : ''})`
