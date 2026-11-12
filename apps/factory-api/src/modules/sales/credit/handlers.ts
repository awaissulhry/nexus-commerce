import { isUuid } from '@nexus/factory-domain/core/ids'
import { command, type CommandCaller } from '../../../core/command'
import { defineHandler, type EventHandler } from '../../../platform/outbox/dispatch'
import { recheckHeldOrders } from './override'

/**
 * A payment lets held orders go on by themselves (B-W2b-304; SAL-241): on `payment.allocated` (a payment placed on an
 * invoice or a deposit), the customer's orders with the payment's company that wait for credit are checked again in the
 * tenant's system context; those that now pass (or only warn) are CONFIRMED and the yes asked on their hold is withdrawn.
 * One that is still held stays as it is (no new row: a person checks it again or the yes decides). Releases and
 * shipments are checked again when someone releases or ships them.
 */

/** The work of one payment, in its own command; how many orders went on. */
export async function recheckAfterPayment(caller: CommandCaller, paymentId: string, idempotencyKey?: string): Promise<number> {
  if (!isUuid(paymentId)) return 0
  const at = await caller.withClient(async (db) => {
    const payment = await db.payment.findUnique({ where: { id: paymentId }, select: { partyId: true, companyId: true } })
    if (!payment?.partyId) return null
    const waiting = await db.salesOrder.count({ where: { partyId: payment.partyId, companyId: payment.companyId, status: 'PENDING_APPROVAL' } })
    return waiting > 0 ? { partyId: payment.partyId, companyId: payment.companyId } : null
  })
  if (!at) return 0
  const { result } = await command(caller, { name: 'credit.recheckOnPayment', idempotencyKey: idempotencyKey ?? null, input: { paymentId } }, async (tools) => {
    const moved = await recheckHeldOrders(tools, at.partyId, at.companyId, true)
    tools.audit({ action: 'credit.recheckOnPayment', recordType: 'Payment', recordId: paymentId, companyId: at.companyId, after: { partyId: at.partyId, ordersGoingOn: moved } })
    return { moved }
  })
  return result.moved
}

export function creditHandlers(): EventHandler[] {
  return [
    defineHandler({
      name: 'credit.recheckOnPayment',
      events: ['payment.allocated'],
      async handle(event, { caller }) {
        const paymentId = (event.payload as { paymentId?: unknown }).paymentId
        if (typeof paymentId === 'string') await recheckAfterPayment(caller, paymentId, `credit-payment:${event.eventId}`)
      },
    }),
  ]
}
