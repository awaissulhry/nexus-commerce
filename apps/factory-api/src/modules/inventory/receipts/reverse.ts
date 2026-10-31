import type { PeriodLockOverride } from '@nexus/factory-domain/accounting/contracts'
import { DomainError, ForbiddenError, InvalidStateError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { reversalOf } from '@nexus/factory-domain/inventory/ledger/moves'
import { INVENTORY_REVERSE, INVENTORY_STOCK_VIEW } from '@nexus/factory-domain/inventory/permissions'
import { expectedBaseOf, orderStatusAfter } from '@nexus/factory-domain/inventory/receipts/rules'
import { ZERO } from '@nexus/factory-domain/tax/decimal'
import { command, type CommandCaller } from '../../../core/command'
import { lockOrderForReceipt, setOrderReceiptProgress } from '../../purchasing/receiving'
import { mayAt, officeContextOf, postedBy } from '../ledger/access'
import { lockStock, postMoves, type PostedMove } from '../ledger/post-moves'
import { blockersOf, receiptDetail } from './read'
import { readOrderLines, readReceiptMoves, RECEIPT_COLUMNS } from './store'

/**
 * Reverse a posted goods receipt (B-W1-32; SCM-121; design rc-reverse): the office, with inventory.reverse and the
 * reason, ONE command on the GoodsReceipt (its version is the edit-conflict guard and its bump locks the row) that posts
 * one mirror move per receipt move through the ledger's postMoves (valued at the original's cost, so the two cancel),
 * makes the receipt REVERSED, rejects its lots (nothing of them is in stock any more: they are never used) and reads the
 * order's progress again (PARTLY_RECEIVED, or back to CONFIRMED / SENT). Nothing is deleted.
 *
 * Only while its stock is untouched: under the stock locks (the ones an issue or a transfer takes), every other move of
 * its lots and hides is summed per place, and anything still at a work order, at another location, scrapped or
 * corrected refuses the reversal with what to do first (factory-domain receipts reversalBlockers). An issue that was
 * undone, or a transfer moved back, sums to nothing. Lock order: the receipt's row → the order's row → the order's
 * receiving lock → the stock locks.
 */

const STATE_WORDS = {
  OPEN: 'The receipt is open: nothing of it was posted, so there is nothing to reverse.',
  REVERSED: 'The receipt was reversed already.',
  CANCELLED: 'The receipt was cancelled: nothing of it was posted.',
} as const

export async function reverseReceipt(caller: CommandCaller, receiptId: string, body: { readonly version: number; readonly reason: string; readonly periodLockOverride?: PeriodLockOverride | undefined }, idempotencyKey?: string): Promise<{ receipt: Awaited<ReturnType<typeof receiptDetail>>; moves: PostedMove[] }> {
  const context = officeContextOf(caller)
  const found = isUuid(receiptId) ? await caller.withClient((client) => client.goodsReceipt.findUnique({ where: { id: receiptId }, select: { id: true, companyId: true, siteId: true } })) : null
  if (!found || !(mayAt(context, INVENTORY_STOCK_VIEW, found) || mayAt(context, INVENTORY_REVERSE, found))) throw new NotFoundError('Goods receipt not found.')
  if (!mayAt(context, INVENTORY_REVERSE, found)) throw new ForbiddenError('Reversing a receipt needs inventory.reverse.')
  const reason = body.reason.trim()
  const key = `inventory.reverseReceipt:${idempotencyKey ?? `g-${newId()}`}`
  const { result } = await command(
    caller,
    { name: 'inventory.reverseReceipt', idempotencyKey, input: { receiptId, ...body }, record: { type: 'GoodsReceipt', id: found.id, expectedVersion: body.version } },
    async (tools) => {
      const { tx, now } = tools
      const by = postedBy(context)
      const receipt = (await tx.goodsReceipt.findUnique({ where: { id: found.id }, select: RECEIPT_COLUMNS }))!
      if (receipt.status !== 'POSTED') throw new InvalidStateError(STATE_WORDS[receipt.status])
      const order = receipt.purchaseOrderId ? await lockOrderForReceipt(tools, receipt.purchaseOrderId) : null

      // Untouched? Under the stock locks of what it brought, every other move of its lots and hides.
      const moves = await readReceiptMoves(tx, receipt.id)
      await lockStock(tx, context.tenantId, moves.map((move) => ({ siteId: move.siteId, itemId: move.itemId, itemColourId: move.itemColourId, lotId: move.lotId, hideId: move.hideId, locationId: move.toLocationId! })))
      const blockers = await blockersOf(tx, moves)
      if (blockers.message) throw new DomainError('conflict', blockers.message, blockers.blockers.map((blocker) => ({ path: blocker.path, message: blocker.message })))

      const note = `Receipt ${receipt.number} reversed: ${reason}`
      const posted = await postMoves(
        tools,
        moves.map((move) => ({ ...reversalOf({ ...move, quantity: move.quantity.toString(), baseQuantity: move.baseQuantity.toString() }, note), uom: move.uom })),
        { key, issuePath: (index) => `moves/${index}`, periodLockOverride: body.periodLockOverride },
      )
      await tx.goodsReceipt.update({ where: { id: receipt.id }, data: { status: 'REVERSED', reversedAt: now, reversedById: by.createdById, reversalReason: reason }, select: { id: true } })

      // Its lots are rejected: nothing of them is in stock, and they are never used.
      const lines = await tx.goodsReceiptLine.findMany({ where: { receiptId: receipt.id }, select: { id: true } })
      const lots = await tx.lot.findMany({ where: { receiptLineId: { in: lines.map((line) => line.id) } }, select: { id: true, code: true, qualityStatus: true }, orderBy: { code: 'asc' } })
      for (const lot of lots) {
        if (lot.qualityStatus === 'REJECTED') continue
        // RELEASED → BLOCKED → REJECTED: the lot's state machine has no shorter way (the …_supply_guards trigger).
        if (lot.qualityStatus === 'RELEASED') await tx.lot.update({ where: { id: lot.id }, data: { qualityStatus: 'BLOCKED', qualityDecidedAt: now, qualityDecidedById: by.createdById, version: { increment: 1 } }, select: { id: true } })
        await tx.lot.update({ where: { id: lot.id }, data: { qualityStatus: 'REJECTED', qualityNote: note, qualityDecidedAt: now, qualityDecidedById: by.createdById, version: { increment: 1 } }, select: { id: true } })
        tools.audit({ action: 'inventory.lotRejected', recordType: 'Lot', recordId: lot.id, companyId: receipt.companyId, siteId: receipt.siteId, reason: note, before: { qualityStatus: lot.qualityStatus }, after: { qualityStatus: 'REJECTED' } })
      }

      let orderStatus = null
      if (order) {
        const after = await readOrderLines(tx, order.id)
        orderStatus = orderStatusAfter(
          { status: order.status, confirmed: order.confirmed },
          after.lines.map((line) => ({
            expected: expectedBaseOf({ quantity: line.quantity.toString(), baseQuantity: line.baseQuantity.toString(), confirmedQuantity: line.confirmedQuantity?.toString() ?? null }),
            received: after.received.get(line.id) ?? ZERO,
            tolerancePct: line.areaTolerancePct?.toString() ?? null,
            // B-W2a-52: a cancelled or closed-short line takes no more goods: it counts as complete.
            ended: line.cancelledAt !== null || line.closedShortAt !== null,
          })),
        )
        await setOrderReceiptProgress(tools, order, orderStatus, { id: receipt.id, number: receipt.number, reversed: true })
      }
      tools.audit({
        action: 'inventory.reverseReceipt',
        recordType: 'GoodsReceipt',
        recordId: receipt.id,
        companyId: receipt.companyId,
        siteId: receipt.siteId,
        reason,
        before: { status: 'POSTED' },
        after: { status: 'REVERSED', reversedAt: toUtcIso(now), moveIds: posted.map((move) => move.id), rejectedLotIds: lots.map((lot) => lot.id), purchaseOrderStatus: orderStatus },
      })
      tools.emit({
        type: 'inventory.receipt_reversed',
        subject: receipt.id,
        companyId: receipt.companyId,
        siteId: receipt.siteId,
        payload: { receiptId: receipt.id, number: receipt.number, purchaseOrderId: receipt.purchaseOrderId, purchaseOrderStatus: orderStatus, lotIds: lots.map((lot) => lot.id), moveIds: posted.map((move) => move.id), postedBy: by.audience },
      })
      const updated = (await tx.goodsReceipt.findUnique({ where: { id: receipt.id }, select: RECEIPT_COLUMNS }))!
      return { receipt: await receiptDetail(tx, tools.context, updated), moves: posted }
    },
  )
  return result
}
