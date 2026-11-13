import { InvalidStateError } from '@nexus/factory-domain/core/errors'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { EMPTY_WORDS, NOT_PLANNED_WORDS, rowKey } from '@nexus/factory-domain/sales/customer-materials/rules'
import { ORDERS_MANAGE } from '@nexus/factory-domain/sales/orders/permissions'
import { Dec, type Decimal } from '@nexus/factory-domain/tax/decimal'
import { command, type CommandCaller } from '../../../core/command'
import { officeOrder } from '../orders/moves'
import type { OrderRow, Reader } from '../orders/store'
import { expectedOfOrder, MATERIAL_COLUMNS, materialView, planInCommand, recountInCommand } from './store'

/**
 * Customer-supplied materials of an order (B-W2b-309; SAL-306; design order.lines.owned "Customer-supplied materials":
 * Material · Colour · Expected · Received · Used · Left, "Links to the receipt and the lot"; follow-up SO2:01). Office only.
 *
 *   GET  /sales/orders/:orderId/customer-materials          orders.view: the rows kept on the order (expected per size,
 *                                                           received, used, returned, left), what the BOM asks that is not
 *                                                           kept yet, and the customer's own lots of those materials with
 *                                                           what is left of each and the receipt it came with — never a value
 *   POST /sales/orders/:orderId/customer-materials/plan     orders.manage: the rows made, changed or removed to what the
 *                                                           order's lines need now, then counted from the moves
 *   POST /sales/orders/:orderId/customer-materials/recount  orders.manage: received, used and returned counted again from the
 *                                                           customer's own lots (every order of the customer of those
 *                                                           materials: what it sent is shared oldest order first)
 *
 * The receipt from the customer and the return to it are modules/inventory/receipts/customer.ts (inventory.receive).
 */

/** Signed base quantity of a lot's move into (+) or out of (−) stock. */
const into = (move: { fromLocationId: string | null; toLocationId: string | null; baseQuantity: { toString(): string } }): Decimal => {
  const value = new Dec(move.baseQuantity.toString())
  if (move.toLocationId && !move.fromLocationId) return value
  if (move.fromLocationId && !move.toLocationId) return value.negated()
  return new Dec(0)
}

async function readMaterials(db: Reader, order: OrderRow) {
  const rows = await db.customerMaterial.findMany({ where: { orderId: order.id }, select: { ...MATERIAL_COLUMNS, orderLine: { select: { seq: true } } }, orderBy: [{ orderLine: { seq: 'asc' } }, { itemId: 'asc' }, { id: 'asc' }] })
  const expected = await expectedOfOrder(db, order)
  const kept = new Set(rows.map((row) => rowKey(row)))
  const missing = expected.rows.filter((row) => !kept.has(rowKey(row)))
  const itemIds = [...new Set([...rows.map((row) => row.itemId), ...missing.map((row) => row.itemId)])]
  const items = new Map((itemIds.length === 0 ? [] : await db.item.findMany({ where: { id: { in: itemIds } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, { code: row.code, name: row.name }]))
  const colourIds = [...new Set([...rows, ...missing].flatMap((row) => (row.itemColourId ? [row.itemColourId] : [])))]
  const colours = new Map((colourIds.length === 0 ? [] : await db.itemColour.findMany({ where: { id: { in: colourIds } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, { code: row.code, name: row.name }]))
  // The customer's own lots of these materials: what is left of each, and the receipt it came with.
  const lots = itemIds.length === 0 ? [] : await db.lot.findMany({ where: { ownerPartyId: order.partyId, itemId: { in: itemIds } }, select: { id: true, code: true, itemId: true, itemColourId: true, siteId: true, receiptLineId: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  const moves = lots.length === 0 ? [] : await db.stockMove.findMany({ where: { lotId: { in: lots.map((lot) => lot.id) } }, select: { lotId: true, fromLocationId: true, toLocationId: true, baseQuantity: true } })
  const receiptLines = lots.length === 0 ? [] : await db.goodsReceiptLine.findMany({ where: { id: { in: lots.flatMap((lot) => (lot.receiptLineId ? [lot.receiptLineId] : [])) } }, select: { id: true, receiptId: true, receipt: { select: { number: true, receivedAt: true } } } })
  const lineSeq = new Map(rows.map((row) => [row.id, row.orderLine.seq]))
  return {
    rows: rows.map((row) => ({ ...materialView(row, { items, colours }), seq: lineSeq.get(row.id) ?? 0 })),
    notPlanned: missing.map((row) => ({
      orderLineId: row.orderLineId,
      bomLineId: row.bomLineId,
      item: { id: row.itemId, code: items.get(row.itemId)?.code ?? '?', name: items.get(row.itemId)?.name ?? '' },
      colour: row.itemColourId ? { id: row.itemColourId, code: colours.get(row.itemColourId)?.code ?? '?', name: colours.get(row.itemColourId)?.name ?? null } : null,
      uom: row.uom,
      expected: row.expectedQuantity,
      expectedBySize: row.expectedBySize,
      words: NOT_PLANNED_WORDS,
    })),
    lots: lots.map((lot) => {
      const left = moves.filter((move) => move.lotId === lot.id).reduce((sum, move) => sum.plus(into(move)), new Dec(0))
      const receipt = receiptLines.find((line) => line.id === lot.receiptLineId)
      return { id: lot.id, code: lot.code, itemId: lot.itemId, itemColourId: lot.itemColourId, siteId: lot.siteId, onHand: (left.lt(0) ? new Dec(0) : left).toFixed(4), receiptId: receipt?.receiptId ?? null, receiptNumber: receipt?.receipt.number ?? null, receivedAt: receipt ? toUtcIso(receipt.receipt.receivedAt) : null }
    }),
    problems: expected.problems,
  }
}

/** GET /sales/orders/:orderId/customer-materials */
export async function listCustomerMaterials(caller: CommandCaller, orderId: string) {
  const order = await officeOrder(caller, orderId)
  const read = await caller.withClient((db) => readMaterials(db, order))
  return { orderId: order.id, number: order.number, partyId: order.partyId, ...read, empty: read.rows.length === 0 && read.notPlanned.length === 0 ? EMPTY_WORDS : null }
}

/** POST /sales/orders/:orderId/customer-materials/plan */
export async function planCustomerMaterials(caller: CommandCaller, orderId: string, idempotencyKey?: string) {
  const order = await officeOrder(caller, orderId, ORDERS_MANAGE)
  if (order.status === 'CLOSED' || order.status === 'CANCELLED') throw new InvalidStateError(`${order.number} is ${order.status.toLowerCase()}: its materials are no longer planned.`)
  const { result } = await command(caller, { name: 'orders.customerMaterials.plan', idempotencyKey, input: { orderId } }, async (tools) => {
    await tools.tx.$queryRaw`SELECT 1 FROM "SalesOrder" WHERE id = ${order.id}::uuid FOR UPDATE`
    const planned = await planInCommand(tools, order)
    const counted = await recountInCommand(tools, order.partyId)
    const rows = await tools.tx.customerMaterial.count({ where: { orderId: order.id } })
    tools.audit({ action: 'orders.customerMaterials.plan', recordType: 'SalesOrder', recordId: order.id, companyId: order.companyId, after: { ...planned, counted: counted.changed, rows } })
    tools.emit({ type: 'customer_material.changed', subject: order.id, companyId: order.companyId, payload: { orderId: order.id, number: order.number, change: 'PLANNED', rows } })
    for (const other of counted.orders.filter((entry) => entry.id !== order.id)) tools.emit({ type: 'customer_material.changed', subject: other.id, companyId: other.companyId, payload: { orderId: other.id, number: other.number, change: 'RECOUNTED', rows: other.rows } })
    return planned
  })
  return { ...(await listCustomerMaterials(caller, orderId)), planned: result }
}

/** POST /sales/orders/:orderId/customer-materials/recount */
export async function recountCustomerMaterials(caller: CommandCaller, orderId: string, idempotencyKey?: string) {
  const order = await officeOrder(caller, orderId, ORDERS_MANAGE)
  const { result } = await command(caller, { name: 'orders.customerMaterials.recount', idempotencyKey, input: { orderId } }, async (tools) => {
    const counted = await recountInCommand(tools, order.partyId)
    tools.audit({ action: 'orders.customerMaterials.recount', recordType: 'SalesOrder', recordId: order.id, companyId: order.companyId, after: { changed: counted.changed, orders: counted.orders.map((entry) => entry.id) } })
    for (const other of counted.orders) tools.emit({ type: 'customer_material.changed', subject: other.id, companyId: other.companyId, payload: { orderId: other.id, number: other.number, change: 'RECOUNTED', rows: other.rows } })
    return { changed: counted.changed }
  })
  return { ...(await listCustomerMaterials(caller, orderId)), changed: result.changed }
}
