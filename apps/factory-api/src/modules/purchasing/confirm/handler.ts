import { purchaseOrderDocumentNumber } from '@nexus/factory-domain/purchasing/document'
import { answerSummary } from '@nexus/factory-domain/purchasing/confirm/answer'
import { buyerNote, type BuyerNoteFacts } from '@nexus/factory-domain/purchasing/confirm/notes'
import { events as purchasingEvents } from '@nexus/factory-domain/purchasing/events'
import { cleanBody } from '@nexus/factory-domain/threads/rules'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { defineHandler, type EventHandler } from '../../../platform/outbox/dispatch'
import { ensureThread, mentionProblems, writeMessage } from '../../../platform/threads/threads'
import { readLines, readOrder, type Reader } from '../store'

/**
 * The worker's handler that tells the buyer (B-W1-31; design plan-buy-pay "the answer lands on the PO at once"): a link
 * session writes no thread message (the partner role reads threads only), so the supplier's answer reaches the order's
 * thread here, as an internal note of the system that mentions the person who sent the order (when they still read it):
 *
 *   purchase_order.confirmed (through the link)   who confirmed, their reference, "all 3 lines as asked", their note
 *   purchase_order.declined                       the reasons in words, and what to do next
 *
 * The note is made from what the order keeps (its answer is set once), in ONE command keyed by the event, so a repeated
 * job answers from its receipt and writes nothing twice.
 */

export const TELL_BUYER_HANDLER = 'purchasing.tellBuyer'

const payloadOf = (type: string) => purchasingEvents.find((event) => event.type === type)!.payload

/** The note's facts from the order as it is kept, or null when there is nothing to tell. */
async function noteFacts(db: Reader, type: string, orderId: string, linkId: string | null): Promise<BuyerNoteFacts | null> {
  const order = await readOrder(db, orderId)
  if (!order) return null
  const documentNumber = purchaseOrderDocumentNumber(order.number, order.revision)
  if (type === 'purchase_order.confirmed') {
    if (!order.confirmedAt) return null
    const lines = (await readLines(db, order.id)).length
    return { documentNumber, outcome: 'CONFIRMED', byName: order.confirmedByName, supplierRef: order.supplierRef, note: order.confirmNote, summary: answerSummary({ lines, asAsked: lines, laterDate: 0, earlierDate: 0, otherQuantity: 0, split: 0, cannotDeliver: 0 }) }
  }
  if (type === 'purchase_order.declined') {
    if (!order.declinedAt) return null
    const evidence = linkId ? await db.linkEvidence.findFirst({ where: { linkId, action: 'DECLINED' }, orderBy: [{ at: 'desc' }, { id: 'desc' }], select: { typedName: true } }) : null
    return { documentNumber, outcome: 'DECLINED', byName: evidence?.typedName ?? null, supplierRef: null, note: null, summary: null, declineReason: order.declineReason }
  }
  return null
}

/** Inside the command: the internal note on the order's thread, mentioning its sender when they may read the thread. */
export async function writeBuyerNote(tools: CommandTools, orderId: string, text: string): Promise<{ messageId: string }> {
  const { thread } = await ensureThread(tools, { type: 'PurchaseOrder', id: orderId }, null)
  const order = await tools.tx.purchaseOrder.findUnique({ where: { id: orderId }, select: { sentById: true } })
  const mentions = order?.sentById && (await mentionProblems(tools.tx, tools.context, thread, [order.sentById], tools.now)).length === 0 ? [order.sentById] : []
  const message = await writeMessage(tools, thread, { direction: 'INTERNAL_NOTE', channel: 'APP', author: { kind: 'SYSTEM', id: null, name: null }, bodyText: cleanBody(text), mentions })
  return { messageId: message.id }
}

/** The note for one event (also called by tests with the system caller). */
export async function tellBuyer(caller: CommandCaller, event: { readonly eventId: string; readonly type: string; readonly payload: unknown }): Promise<void> {
  const payload = payloadOf(event.type).parse(event.payload) as { purchaseOrderId: string; channel?: string; linkId: string | null; proposalAccepted?: boolean }
  if (event.type === 'purchase_order.confirmed' && (payload.channel !== 'LINK' || payload.proposalAccepted)) return
  const facts = await caller.withClient((client) => noteFacts(client, event.type, payload.purchaseOrderId, payload.linkId ?? null))
  if (!facts) return
  await command(caller, { name: 'purchasing.tellBuyer', idempotencyKey: `tell-buyer-${event.eventId}`, input: { eventId: event.eventId, purchaseOrderId: payload.purchaseOrderId } }, (tools) => writeBuyerNote(tools, payload.purchaseOrderId, buyerNote(facts)))
}

export function tellBuyerHandler(): EventHandler {
  return defineHandler({
    name: TELL_BUYER_HANDLER,
    events: ['purchase_order.confirmed', 'purchase_order.declined'],
    async handle(event, tools) {
      await tellBuyer(tools.caller, event)
    },
  })
}
