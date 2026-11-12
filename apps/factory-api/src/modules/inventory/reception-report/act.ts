import { THREADS_POST } from '@nexus/factory-domain/auth/permissions/catalogue'
import { ConflictError, ForbiddenError, InvalidStateError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { can } from '@nexus/factory-domain/core/permissions'
import { demandOfKey, demandWords, receptionNoteText, REPORT_LIMITS, type NoteLine } from '@nexus/factory-domain/inventory/reception-report/rules'
import { INVENTORY_RESERVE } from '@nexus/factory-domain/inventory/reservations/permissions'
import { cleanBody } from '@nexus/factory-domain/threads/rules'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { ensureThread, mentionProblems, writeMessage } from '../../../platform/threads/threads'
import { reserveInCommand } from '../reservations/reserve'
import { RECEIPT_COLUMNS } from '../receipts/store'
import { readReport, reportCan, visibleReceipt, type ReceptionReport } from './report'

/**
 * The reception report's two acts (B-W2b-300; SCM-119 "shown on the receipt and sent to the buyer"; design pop:rc-reception
 * "Reserve for 3 work orders"), each ONE command:
 *
 *   reserve   the demands chosen (`WORK_ORDER:<id>` / `ORDER_LINE:<id>` of a line of the receipt): the report is read again INSIDE
 *             the command and each chosen demand gets what it proposes now, from this receipt's lots, through the reservations'
 *             own work (reservations/reserve.ts reserveInCommand: its locks, availability, shade rule and refusals in words are
 *             the last word); a demand that has nothing to take now is said, not reserved. inventory.reserve at the site.
 *   send      the report as an internal note on the purchase order's thread, naming its buyer (the order's maker) when they may
 *             read it (a mention: their bell); with `tellBuyer` on reserve it goes in the same command. threads.post over the
 *             order.
 *
 * Audit `inventory.receptionReported` on the receipt; event `inventory.reception_reported` (the reservations also emit
 * inventory.reserved, the note thread.message_posted / thread.user_mentioned).
 */

export interface ReserveBody {
  readonly demands: readonly { readonly receiptLineId: string; readonly key: string }[]
  readonly tellBuyer?: boolean | undefined
  readonly note?: string | null | undefined
}

/** The note's lines: what came, whom it serves (and what was reserved now), what is left to stock. */
function noteLinesOf(report: ReceptionReport, reserved: ReadonlyMap<string, string>, locale: string): NoteLine[] {
  const en = locale.startsWith('en')
  return report.lines.map((line) => ({
    label: `${en ? 'Line' : 'Riga'} ${line.seq} ${line.item.code}${line.colour ? ` ${line.colour.code}` : ''}`,
    received: line.received,
    uom: line.item.baseUom,
    serves: line.serves
      .filter((serve) => new Dec(serve.open).gt(0) || new Dec(reserved.get(`${line.receiptLineId}|${serve.key}`) ?? '0').gt(0))
      .map((serve) => ({
        label: serve.workOrder ? demandWords(locale, { kind: 'WORK_ORDER', number: serve.workOrder.number }) : demandWords(locale, { kind: 'ORDER_LINE', number: serve.orderLine!.number, seq: serve.orderLine!.seq }),
        open: serve.open,
        reservedNow: reserved.get(`${line.receiptLineId}|${serve.key}`) ?? '0',
      })),
    left: Dec.max(0, new Dec(line.received).minus(line.serves.reduce((sum, serve) => sum.plus(new Dec(reserved.get(`${line.receiptLineId}|${serve.key}`) ?? '0')).plus(new Dec(serve.reservedHere)), new Dec(0)))).toFixed(4),
  }))
}

/** Inside a command: the note on the order's thread, naming the buyer when they may read it. */
async function sendInCommand(tools: CommandTools, context: OfficeContext, report: ReceptionReport, reserved: ReadonlyMap<string, string>, note: string | null | undefined): Promise<{ messageId: string; told: boolean }> {
  const order = report.receipt.purchaseOrder!
  const { thread } = await ensureThread(tools, { type: 'PurchaseOrder', id: order.id }, context.actorId)
  if (!can(actorOf(context), THREADS_POST, { companyId: thread.companyId, siteId: thread.siteId, partyId: thread.partyId })) throw new ForbiddenError("Sending the reception report needs threads.post over the purchase order.")
  if (thread.status !== 'OPEN') throw new InvalidStateError(`The thread of ${order.number} is closed: reopen it to send the reception report.`)
  const buyer = report.buyer && report.buyer.id !== context.actorId && (await mentionProblems(tools.tx, context, thread, [report.buyer.id], tools.now)).length === 0 ? report.buyer : null
  const locale = (buyer ? (await tools.tx.user.findUnique({ where: { id: buyer.id }, select: { locale: true } }))?.locale : null) ?? (await tools.tx.user.findUnique({ where: { id: context.actorId }, select: { locale: true } }))?.locale ?? 'it'
  const author = await tools.tx.user.findUnique({ where: { id: context.actorId }, select: { displayName: true } })
  const message = await writeMessage(tools, thread, {
    direction: 'INTERNAL_NOTE',
    channel: 'APP',
    author: { kind: 'USER', id: context.actorId, name: author?.displayName ?? null },
    bodyText: cleanBody(receptionNoteText(locale, { receipt: report.receipt.number, order: order.number, lines: noteLinesOf(report, reserved, locale), note })),
    mentions: buyer ? [buyer.id] : [],
  })
  return { messageId: message.id, told: buyer !== null }
}

/** POST /inventory/receipts/:receiptId/reception-report/reserve */
export async function reserveFromReport(caller: CommandCaller, receiptId: string, body: ReserveBody, idempotencyKey?: string) {
  const { context, receipt: seen } = await visibleReceipt(caller, receiptId)
  if (!can(actorOf(context), INVENTORY_RESERVE, { companyId: seen.companyId, siteId: seen.siteId })) throw new ForbiddenError(`Reserving needs ${INVENTORY_RESERVE} at the site.`)
  if (body.demands.length === 0 || body.demands.length > REPORT_LIMITS.demands) throw new ValidationError(`Choose 1 to ${REPORT_LIMITS.demands} work orders or orders.`, [{ path: 'body/demands', message: `1 to ${REPORT_LIMITS.demands}.` }])
  const { result } = await command(caller, { name: 'inventory.reserveFromReception', idempotencyKey, input: { receiptId, ...body } }, async (tools) => {
    const receipt = (await tools.tx.goodsReceipt.findUnique({ where: { id: seen.id }, select: RECEIPT_COLUMNS }))!
    const report = await readReport(tools.tx, receipt)
    if (report.held) throw new InvalidStateError(report.held === 'NOT_POSTED' ? `${receipt.number} is not posted: its goods are not in stock yet.` : `${receipt.number} names no purchase order: it has no reception report.`)
    const problems: Issue[] = []
    const reservationIds: string[] = []
    const reserved = new Map<string, string>()
    const skipped: { receiptLineId: string; key: string; held: string }[] = []
    for (const [index, chosen] of body.demands.entries()) {
      const line = report.lines.find((entry) => entry.receiptLineId === chosen.receiptLineId)
      const serve = line?.serves.find((entry) => entry.key === chosen.key)
      const demand = demandOfKey(chosen.key)
      if (!line || !serve || !demand) {
        problems.push({ path: `body/demands/${index}`, message: 'Not a work order or order these goods serve.' })
        continue
      }
      if (!new Dec(serve.proposed).gt(0)) {
        skipped.push({ receiptLineId: line.receiptLineId, key: serve.key, held: serve.held ?? 'NOTHING_LEFT' })
        continue
      }
      const lines = serve.lots.map((lot) => (lot.lotId ? { lotId: lot.lotId, quantity: lot.quantity, uom: line.item.baseUom } : { itemId: line.item.id, itemColourId: line.colour?.id ?? null, quantity: lot.quantity, uom: line.item.baseUom }))
      const made = await reserveInCommand(tools, context, { id: receipt.siteId, companyId: receipt.companyId }, {
        siteId: receipt.siteId,
        ...(demand.kind === 'WORK_ORDER' ? { workOrderId: demand.id } : { salesOrderLineId: demand.id }),
        note: `Reception report ${receipt.number}${body.note ? `: ${body.note.trim()}` : ''}`.slice(0, 500),
        lines,
      })
      reservationIds.push(...made.reservations.map((row) => row.id))
      reserved.set(`${line.receiptLineId}|${serve.key}`, serve.proposed)
    }
    if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : 'These cannot be reserved from this receipt.', problems)
    if (reservationIds.length === 0 && !body.tellBuyer) throw new ConflictError('Nothing of these goods is free for the chosen work orders or orders now: read the report again.')
    const sent = body.tellBuyer && report.receipt.purchaseOrder ? await sendInCommand(tools, context, report, reserved, body.note) : null
    tools.audit({ action: 'inventory.receptionReported', recordType: 'GoodsReceipt', recordId: receipt.id, companyId: receipt.companyId, siteId: receipt.siteId, after: { reservationIds, reserved: Object.fromEntries(reserved), skipped, messageId: sent?.messageId ?? null, buyerTold: sent?.told ?? false } })
    tools.emit({ type: 'inventory.reception_reported', subject: receipt.id, companyId: receipt.companyId, siteId: receipt.siteId, payload: { receiptId: receipt.id, purchaseOrderId: report.receipt.purchaseOrder!.id, reservationIds, messageId: sent?.messageId ?? null } })
    return { reservationIds, skipped, sent: sent ? { messageId: sent.messageId, buyerTold: sent.told } : null }
  })
  return result
}

/** POST /inventory/receipts/:receiptId/reception-report/send */
export async function sendReport(caller: CommandCaller, receiptId: string, body: { readonly note?: string | null | undefined }, idempotencyKey?: string) {
  const { context, receipt: seen } = await visibleReceipt(caller, receiptId)
  const { result } = await command(caller, { name: 'inventory.sendReceptionReport', idempotencyKey, input: { receiptId, ...body } }, async (tools) => {
    const receipt = (await tools.tx.goodsReceipt.findUnique({ where: { id: seen.id }, select: RECEIPT_COLUMNS }))!
    const report = await readReport(tools.tx, receipt)
    if (report.held) throw new InvalidStateError(report.held === 'NOT_POSTED' ? `${receipt.number} is not posted: its goods are not in stock yet.` : `${receipt.number} names no purchase order: it has no buyer to tell.`)
    if (!reportCan(context, report).send) throw new ForbiddenError("Sending the reception report needs threads.post over the purchase order.")
    const sent = await sendInCommand(tools, context, report, new Map(), body.note)
    tools.audit({ action: 'inventory.receptionReported', recordType: 'GoodsReceipt', recordId: receipt.id, companyId: receipt.companyId, siteId: receipt.siteId, after: { reservationIds: [], messageId: sent.messageId, buyerTold: sent.told } })
    tools.emit({ type: 'inventory.reception_reported', subject: receipt.id, companyId: receipt.companyId, siteId: receipt.siteId, payload: { receiptId: receipt.id, purchaseOrderId: report.receipt.purchaseOrder!.id, reservationIds: [], messageId: sent.messageId } })
    return { sent: { messageId: sent.messageId, buyerTold: sent.told } }
  })
  return result
}
