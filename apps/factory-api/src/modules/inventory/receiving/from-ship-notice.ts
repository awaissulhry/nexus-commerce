import { ForbiddenError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { INVENTORY_RECEIVE, INVENTORY_STOCK_VIEW } from '@nexus/factory-domain/inventory/permissions'
import { blankText, differingLines, receivedPerLine, SHIP_NOTICE_LIMITS } from '@nexus/factory-domain/purchasing/ship-notices/rules'
import { Dec, ZERO } from '@nexus/factory-domain/tax/decimal'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { dayOf } from '../../purchasing/store'
import { checkOf, crViEvidenceOf, noticeView, orderLinesOf, readNotice, readNoticeLines } from '../../purchasing/ship-notices/store'
import { inboundBoard, type InboundQuery } from '../../purchasing/ship-notices/inbound'
import { officeContextOf } from '../ledger/access'

/**
 * Receiving from a ship notice (B-W2b-182; SCM-106, SCM-107, SCM-110; design warehouse.receipts sec:rc-inbound "'Receive'
 * on a card creates the receipt pre-filled", portal.supplier.asn live "Receipt posted by our warehouse → status 'Received'
 * or 'Received with differences' with the lines that differ"). The office:
 *
 *   GET  /inventory/receiving/inbound                       the inbound board (../../purchasing/ship-notices/inbound.ts)
 *   GET  /inventory/receiving/ship-notices/:id              the notice with its checks and the goods receipt prefilled from it:
 *                                                           its lines, a lot per lot / dye batch, each hide with the area the
 *                                                           tannery declared (the measured area stays the receiver's,
 *                                                           B-W2b-94); the receiving page posts it to POST /inventory/receipts
 *                                                           with `shipNoticeId`
 *   PATCH /inventory/receiving/ship-notices/:id             our dock note (the card's)
 *
 * And, INSIDE the receipt's own command (../receipts/record.ts, ../receipts/reverse.ts; B-W2b-158's rule "RECEIVED exactly
 * while a POSTED receipt names it"): `noticeForReceipt` (the receipt may name a SENT notice of its own order), then
 * `markNoticeReceived` once the receipt is POSTED (each line's received quantity while the notice is still SENT, then
 * RECEIVED), and `reopenNoticeAfterReversal` (back to SENT first, then the lines cleared). Floor receipts do not name a
 * notice yet (the floor role reads notices but may not change them: Gaps).
 */

const siteOf = (notice: { readonly companyId: string; readonly siteId: string }) => ({ companyId: notice.companyId, siteId: notice.siteId })

const NOTICE_HELD = {
  DRAFT: 'The supplier has not sent this notice yet.',
  RECEIVED: 'This delivery was received already.',
  CANCELLED: 'The supplier cancelled this delivery.',
} as const

/** GET /inventory/receiving/inbound */
export async function inbound(caller: CommandCaller, query: InboundQuery, now: Date) {
  return inboundBoard(caller, query, now)
}

/** GET /inventory/receiving/ship-notices/:shipNoticeId (inventory.stock.view over the notice's site). */
export async function officeNotice(caller: CommandCaller, noticeId: string, now: Date) {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  return caller.withClient(async (client) => {
    const notice = isUuid(noticeId) ? await readNotice(client, noticeId) : null
    if (!notice || notice.status === 'DRAFT' || !(can(actor, INVENTORY_STOCK_VIEW, siteOf(notice)) || can(actor, INVENTORY_RECEIVE, siteOf(notice)))) throw new NotFoundError('Ship notice not found.')
    const today = businessDate(now)
    const { lines, hides } = await readNoticeLines(client, notice.id)
    const order = await orderLinesOf(client, notice.purchaseOrderId, notice.id)
    const check = checkOf(order, lines, hides, await crViEvidenceOf(client, notice.id, notice.partyId, today))
    const extra = await client.shipNotice.findUnique({ where: { id: notice.id }, select: { internalNote: true, purchaseOrder: { select: { number: true, status: true } } } })
    const party = await client.party.findUnique({ where: { id: notice.partyId }, select: { id: true, legalName: true } })
    const view = noticeView(notice, lines, hides, order, check, extra?.purchaseOrder.number ?? '', today)
    const mayReceive = can(actor, INVENTORY_RECEIVE, siteOf(notice))
    const orderTakesGoods = ['SENT', 'CONFIRMED', 'PARTLY_RECEIVED'].includes(extra?.purchaseOrder.status ?? '')
    const receiveHeld = notice.status !== 'SENT' ? NOTICE_HELD[notice.status] : !mayReceive ? 'Receiving goods at this site needs inventory.receive.' : !orderTakesGoods ? 'The purchase order no longer takes goods.' : null
    const orders = new Map(order.map((line) => [line.id, line]))
    return {
      notice: { ...view, dockNote: extra?.internalNote ?? null, supplier: { id: notice.partyId, name: party?.legalName ?? '' } },
      prefill:
        notice.status === 'SENT'
          ? {
              purchaseOrderId: notice.purchaseOrderId,
              shipNoticeId: notice.id,
              supplierDdtNumber: notice.ddtNumber,
              supplierDdtDate: dayOf(notice.ddtDate),
              lines: lines.map((line) => {
                const orderLine = orders.get(line.purchaseOrderLineId)
                const own = hides.filter((hide) => hide.shipNoticeLineId === line.id)
                const leather = orderLine?.item.leather ?? false
                // One lot per dye batch (the line's own lot and batch for the hides without one).
                const batches = new Map<string, typeof own>()
                for (const hide of own) {
                  const batch = hide.dyeBatch ?? line.dyeBatch ?? ''
                  batches.set(batch, [...(batches.get(batch) ?? []), hide])
                }
                const tracking = orderLine?.item.tracking ?? 'NONE'
                const quantity = new Dec(line.quantity.toString()).toFixed(4)
                // Leather: a lot per dye batch with its hides (none listed: one lot, the receiver types the hides); a lot-kept
                // material: one lot of what was announced; anything else: the quantity.
                const lots = leather
                  ? own.length > 0
                    ? [...batches.entries()].map(([batch, rows]) => ({
                        supplierLotRef: line.supplierLot,
                        dyeBatch: batch || null,
                        quantity: null,
                        hides: rows.map((hide) => ({ supplierCode: hide.hideNumber, area: new Dec(hide.area.toString()).toFixed(4), areaUom: hide.areaUom, grade: hide.grade, thicknessMm: hide.thicknessMm === null ? null : hide.thicknessMm.toString() })),
                      }))
                    : [{ supplierLotRef: line.supplierLot, dyeBatch: line.dyeBatch, quantity: null, hides: [] }]
                  : tracking === 'LOT'
                    ? [{ supplierLotRef: line.supplierLot, dyeBatch: line.dyeBatch, quantity, hides: [] }]
                    : []
                return { purchaseOrderLineId: line.purchaseOrderLineId, quantity: leather || tracking === 'LOT' ? null : quantity, lots }
              }),
            }
          : null,
      canReceive: receiveHeld === null,
      receiveHeld,
    }
  })
}

/** PATCH /inventory/receiving/ship-notices/:shipNoticeId: our dock note (inventory.receive over the notice's site). */
export async function setDockNote(caller: CommandCaller, noticeId: string, body: { readonly version: number; readonly dockNote?: string | null | undefined }, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  const notice = isUuid(noticeId) ? await caller.withClient((client) => readNotice(client, noticeId)) : null
  if (!notice || notice.status === 'DRAFT' || !(can(actor, INVENTORY_STOCK_VIEW, siteOf(notice)) || can(actor, INVENTORY_RECEIVE, siteOf(notice)))) throw new NotFoundError('Ship notice not found.')
  if (!can(actor, INVENTORY_RECEIVE, siteOf(notice))) throw new ForbiddenError('The dock note is written by who receives goods at this site (inventory.receive).')
  const note = blankText(body.dockNote)
  if (note && note.length > SHIP_NOTICE_LIMITS.note) throw new ValidationError(`At most ${SHIP_NOTICE_LIMITS.note} characters.`, [{ path: 'body/dockNote', message: 'Too long.' }])
  const { result } = await command(caller, { name: 'inventory.shipNoticeDockNote', idempotencyKey, input: { noticeId, ...body }, record: { type: 'ShipNotice', id: notice.id, expectedVersion: body.version } }, async (tools) => {
    const before = await tools.tx.shipNotice.findUnique({ where: { id: notice.id }, select: { internalNote: true, version: true, number: true, status: true } })
    await tools.tx.shipNotice.update({ where: { id: notice.id }, data: { internalNote: note }, select: { id: true } })
    tools.audit({ action: 'inventory.shipNoticeDockNote', recordType: 'ShipNotice', recordId: notice.id, companyId: notice.companyId, siteId: notice.siteId, before: { dockNote: before?.internalNote ?? null }, after: { dockNote: note } })
    tools.emit({ type: 'ship_notice.changed', subject: notice.id, companyId: notice.companyId, siteId: notice.siteId, payload: { shipNoticeId: notice.id, number: notice.number!, purchaseOrderId: notice.purchaseOrderId, partyId: notice.partyId, status: before!.status, what: 'DOCK_NOTE', expectedDate: dayOf(notice.expectedDate) } })
    return { id: notice.id, dockNote: note, version: tools.record!.version }
  })
  return result
}

// ---- inside the receipt's command ----------------------------------------------------------------------------------------------

/** The notice a receipt names, checked inside the receipt's command: SENT, of the receipt's own order (office and system only). */
export async function noticeForReceipt(tools: Pick<CommandTools, 'tx' | 'context'>, noticeId: string, order: { readonly id: string; readonly number: string }): Promise<{ readonly id: string }> {
  if (tools.context.audience === 'floor') throw new ForbiddenError('A goods-in tablet does not receive from a ship notice yet: receive the order’s lines.')
  const notice = isUuid(noticeId) ? await tools.tx.shipNotice.findUnique({ where: { id: noticeId }, select: { id: true, status: true, number: true, purchaseOrderId: true } }) : null
  if (!notice || notice.status === 'DRAFT') throw new NotFoundError('Ship notice not found.')
  if (notice.purchaseOrderId !== order.id) throw new ValidationError(`Ship notice ${notice.number} announces goods of another order, not ${order.number}.`, [{ path: 'body/shipNoticeId', message: 'Another order’s notice.' }])
  if (notice.status !== 'SENT') throw new InvalidStateError(`Ship notice ${notice.number}: ${NOTICE_HELD[notice.status]}`)
  return { id: notice.id }
}

/**
 * The receipt that names the notice is POSTED: what it took of each order line, shared out over the notice's lines (written
 * while the notice is SENT: the lines freeze at RECEIVED), then the notice RECEIVED; `ship_notice.received` with the lines
 * that differ (the supplier's list shows "Received with differences").
 */
export async function markNoticeReceived(tools: CommandTools, noticeId: string, receiptId: string): Promise<void> {
  const { tx, now } = tools
  const notice = (await readNotice(tx, noticeId))!
  const lines = await tx.shipNoticeLine.findMany({ where: { shipNoticeId: noticeId }, orderBy: { seq: 'asc' }, select: { id: true, seq: true, purchaseOrderLineId: true, quantity: true } })
  const taken = await tx.goodsReceiptLine.findMany({ where: { receiptId }, select: { purchaseOrderLineId: true, baseQuantity: true, purchaseOrderLine: { select: { quantity: true, baseQuantity: true } } } })
  const byOrderLine = new Map<string, string>()
  for (const line of taken) {
    if (!line.purchaseOrderLineId || !line.purchaseOrderLine) continue
    const base = new Dec(line.purchaseOrderLine.baseQuantity.toString())
    const inLineUnit = base.isZero() ? ZERO : new Dec(line.baseQuantity.toString()).times(line.purchaseOrderLine.quantity.toString()).dividedBy(base)
    byOrderLine.set(line.purchaseOrderLineId, new Dec(byOrderLine.get(line.purchaseOrderLineId) ?? '0').plus(inLineUnit).toFixed(4))
  }
  const received = receivedPerLine(lines.map((line) => ({ id: line.id, seq: line.seq, purchaseOrderLineId: line.purchaseOrderLineId, quantity: line.quantity.toString() })), byOrderLine)
  for (const line of lines) await tx.shipNoticeLine.update({ where: { id: line.id }, data: { receivedQuantity: received.get(line.id) ?? '0', version: { increment: 1 } }, select: { id: true } })
  await tx.shipNotice.update({ where: { id: noticeId }, data: { status: 'RECEIVED', receivedAt: now, version: { increment: 1 } }, select: { id: true } })
  const differing = differingLines(lines.map((line) => ({ id: line.id, quantity: line.quantity.toString(), receivedQuantity: received.get(line.id) ?? '0' })))
  tools.audit({
    action: 'inventory.shipNoticeReceived',
    recordType: 'ShipNotice',
    recordId: noticeId,
    companyId: notice.companyId,
    siteId: notice.siteId,
    before: { status: 'SENT' },
    after: { status: 'RECEIVED', receiptId, lines: lines.map((line) => ({ id: line.id, quantity: line.quantity.toString(), receivedQuantity: received.get(line.id) ?? '0' })), differing: differing.map((line) => line.id) },
  })
  tools.emit({ type: 'ship_notice.received', subject: noticeId, companyId: notice.companyId, siteId: notice.siteId, payload: { shipNoticeId: noticeId, number: notice.number!, purchaseOrderId: notice.purchaseOrderId, partyId: notice.partyId, status: 'RECEIVED', receiptId, lines: lines.length, differing: differing.length } })
}

/**
 * The receipt is REVERSED: when no other posted receipt names its notice, the notice waits for the goods again (back to SENT
 * first, then its lines' received quantities cleared: they change only while SENT).
 */
export async function reopenNoticeAfterReversal(tools: CommandTools, receiptId: string): Promise<void> {
  const { tx } = tools
  const receipt = await tx.goodsReceipt.findUnique({ where: { id: receiptId }, select: { shipNoticeId: true } })
  if (!receipt?.shipNoticeId) return
  const notice = await readNotice(tx, receipt.shipNoticeId)
  if (!notice || notice.status !== 'RECEIVED') return
  const others = await tx.goodsReceipt.count({ where: { shipNoticeId: notice.id, status: 'POSTED' } })
  if (others > 0) return
  await tx.shipNotice.update({ where: { id: notice.id }, data: { status: 'SENT', receivedAt: null, version: { increment: 1 } }, select: { id: true } })
  await tx.shipNoticeLine.updateMany({ where: { shipNoticeId: notice.id }, data: { receivedQuantity: null, version: { increment: 1 } } })
  tools.audit({ action: 'inventory.shipNoticeReopened', recordType: 'ShipNotice', recordId: notice.id, companyId: notice.companyId, siteId: notice.siteId, before: { status: 'RECEIVED' }, after: { status: 'SENT', receiptId } })
  tools.emit({ type: 'ship_notice.reopened', subject: notice.id, companyId: notice.companyId, siteId: notice.siteId, payload: { shipNoticeId: notice.id, number: notice.number!, purchaseOrderId: notice.purchaseOrderId, partyId: notice.partyId, status: 'SENT', receiptId } })
}
