import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { INVENTORY_RECEIVE } from '@nexus/factory-domain/inventory/permissions'
import type { LabelLanguage } from '@nexus/factory-domain/labels/model'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { recordReceiptInCommand, type LineBody } from '../receipts/record'
import { moveOrderAfterFloorReceipt } from './progress'
import { floorReceipt, receiverOf } from './read'
import { queueTags, reprintTags, type ReprintReason } from './tags'

/**
 * A goods-in tablet receives a delivery against a purchase order (B-W1-33; SCM-113, SCM-116, SCM-117, SCM-233, SCM-247;
 * PLAN §4.7 stage 09a-receive), in three steps, each its own transaction:
 *
 *   1. the receipt: ONE floor command (`inventory.receive`, the request's Idempotency-Key, inventory.receive at the
 *      device's site) running the office's own work (receipts/record.ts recordReceiptInCommand): the order's receiving
 *      lock, the order read under it (its version as the screen read it, else 409), GOODS_RECEIPT and LOT numbers from
 *      the company's series (numbers.ts, allocateNumber serves the floor for these kinds), the tenant's HIDE scan ids
 *      (allocateScanIds: an ONLINE block, so receipts are held while the tablet is offline), the lots (held lots to the
 *      site's quality-hold place when it has one), hides one by one, RECEIPT moves without a cost (the worker values them
 *      at the order line's price: ledger/valuation.ts), the receipt POSTED, `inventory.receipt_posted`;
 *   2. the order's move (PARTLY_RECEIVED, RECEIVED) in the tenant's system context (./progress.ts);
 *   3. the hide tags on the station's label printer (./tags.ts).
 * A failure of 2 or 3 never undoes 1: the answer is the receipt as it stands (its order and tags as they are), and a
 * resend of the same request runs 2 and 3 again where they did not finish.
 */

export interface FloorReceiveBody {
  readonly version: number
  readonly supplierDdtNumber?: string | null | undefined
  readonly supplierDdtDate?: string | null | undefined
  readonly receivedAt?: string | undefined
  readonly note?: string | null | undefined
  readonly lines: readonly LineBody[]
  readonly printerId?: string | null | undefined
  readonly language?: LabelLanguage | undefined
}

interface Logger {
  readonly log?: { warn(details: object, message: string): void }
}

/** POST /inventory/receiving/orders/:orderId/receipts. */
export async function receiveOnFloor(caller: CommandCaller & Logger, orderId: string, body: FloorReceiveBody, idempotencyKey: string | undefined) {
  const context = receiverOf(caller)
  const order = isUuid(orderId) ? await caller.withClient((client) => client.purchaseOrder.findUnique({ where: { id: orderId }, select: { companyId: true, siteId: true } })) : null
  if (!order || !can(actorOf(context), INVENTORY_RECEIVE, { companyId: order.companyId, siteId: order.siteId })) throw new NotFoundError('Purchase order not found.')
  const hold = await caller.withClient(async (client) => {
    const rows = await client.location.findMany({ where: { siteId: order.siteId, kind: 'QUARANTINE', status: 'ACTIVE' }, select: { id: true, code: true }, orderBy: { code: 'asc' }, take: 2 })
    return rows.length === 1 ? rows[0]! : null
  })

  const { result } = await command(caller, { name: 'inventory.receive', idempotencyKey, input: { orderId, ...body } }, async (tools) => {
    const recorded = await recordReceiptInCommand(
      tools,
      { purchaseOrderId: orderId, supplierDdtNumber: body.supplierDdtNumber, supplierDdtDate: body.supplierDdtDate, receivedAt: body.receivedAt, note: body.note, lines: body.lines },
      `inventory.receive:${idempotencyKey}`,
      { expectedVersion: body.version, heldLocation: hold },
    )
    return { receiptId: recorded.receiptId, number: recorded.number, notes: recorded.notes }
  })
  // command() refused a floor write without a key before this point.
  const key = idempotencyKey!

  try {
    await moveOrderAfterFloorReceipt(caller, context, { id: result.receiptId, number: result.number, purchaseOrderId: orderId }, key)
  } catch (error) {
    // The receipt stands; the order keeps its state until a resend of this request (or the next receipt) moves it.
    caller.log?.warn({ err: error, receiptId: result.receiptId, purchaseOrderId: orderId }, 'floor receipt: the order was not moved on')
  }
  const printing = body.printerId === null ? null : await queueTags(caller, context, result.receiptId, { printerId: body.printerId, language: body.language, requestKey: null })
  return { receipt: await floorReceipt(caller, context, result.receiptId, printing ?? {}), notes: result.notes }
}

/** POST /inventory/receiving/receipts/:receiptId/tags: print tags again (a reason logged on each hide). */
export async function printTagsAgain(
  caller: CommandCaller,
  receiptId: string,
  body: { readonly hideIds?: readonly string[] | undefined; readonly printerId?: string | null | undefined; readonly language?: LabelLanguage | undefined; readonly reason?: ReprintReason | undefined },
  idempotencyKey: string | undefined,
) {
  const context = receiverOf(caller)
  const printing = await reprintTags(caller, context, receiptId, body, idempotencyKey)
  return { receipt: await floorReceipt(caller, context, receiptId, printing) }
}
