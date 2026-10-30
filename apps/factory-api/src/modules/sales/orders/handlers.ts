import { command } from '../../../core/command'
import { defineHandler, type EventHandler } from '../../../platform/outbox/dispatch'
import { followOrder } from './moves'
import { followDepositInCommand } from './schedule'

/**
 * The worker's handlers that keep a sales order's state with its facts (B-W1-25; SAL-204: the system is the one writer of
 * these moves), each as the system of the event's tenant (background.ts HANDLERS). They move on facts read again under
 * the order's lock (moves.ts `followOrder`), never on the event alone, so a repeat or a late event changes nothing.
 *
 *   sales.ordersFollowWorkOrders   workorder.released: the work order's orders start production (the release itself
 *                                  never moves an order: B-W1-38 leaves it to sales)
 *   sales.ordersFollowShipments    shipment.status_changed to SHIPPED, DELIVERED or RETURNED: the shipped quantities
 *                                  (PARTLY_SHIPPED, SHIPPED; back to PARTLY_SHIPPED when a shipment came back)
 *   sales.ordersFollowSettlement   order.fully_settled (B-W1-51, the money module): a SHIPPED order closes when the
 *                                  settlement port (the money module's computation, read again under the order's lock)
 *                                  says it is settled; the event is only the trigger. order.unsettled needs nothing
 *                                  here: the money module writes it on the order's history itself, and a CLOSED order
 *                                  never changes
 *   sales.ordersFollowDeposits     B-W2a-30 (SAL-216): payment.deposit_paid — the DEPOSIT step of the order's payment
 *                                  schedule that names the request becomes PAID (with the request's paidAt); nothing to
 *                                  do: no command
 */

const SHIPPED_MOVES = new Set(['SHIPPED', 'DELIVERED', 'RETURNED'])

export function orderHandlers(): EventHandler[] {
  return [
    defineHandler({
      name: 'sales.ordersFollowWorkOrders',
      events: ['workorder.released'],
      attempts: 10,
      async handle(event, { caller }) {
        const payload = event.payload as { number?: string; salesOrderIds?: string[] }
        for (const orderId of [...new Set(payload.salesOrderIds ?? [])].sort()) {
          await followOrder(caller, orderId, { what: payload.number ? `work order ${payload.number} released` : 'a work order released', causationId: event.eventId })
        }
      },
    }),
    defineHandler({
      name: 'sales.ordersFollowShipments',
      events: ['shipment.status_changed'],
      attempts: 10,
      async handle(event, { caller }) {
        const payload = event.payload as { shipmentId: string; number?: string; to: string }
        if (!SHIPPED_MOVES.has(payload.to)) return
        const shipment = await caller.withClient((client) => client.shipment.findUnique({ where: { id: payload.shipmentId }, select: { salesOrderId: true } }))
        if (!shipment) return
        await followOrder(caller, shipment.salesOrderId, { what: `shipment ${payload.number ?? payload.shipmentId} ${payload.to.toLowerCase()}`, causationId: event.eventId })
      },
    }),
    defineHandler({
      name: 'sales.ordersFollowSettlement',
      // Declared and emitted by the money module (B-W1-51 settleOrders); the trigger only: followOrder asks the port.
      events: ['order.fully_settled'],
      attempts: 10,
      async handle(event, { caller }) {
        const payload = event.payload as { orderId: string }
        await followOrder(caller, payload.orderId, { what: 'the order is settled', causationId: event.eventId })
      },
    }),
    defineHandler({
      name: 'sales.ordersFollowDeposits',
      // Declared and emitted by the money module (payments markDepositPaid).
      events: ['payment.deposit_paid'],
      attempts: 10,
      async handle(event, { caller }) {
        const payload = event.payload as { depositRequestId: string }
        const ready = await caller.withClient(async (client) => {
          const request = await client.depositRequest.findUnique({ where: { id: payload.depositRequestId }, select: { status: true } })
          return request?.status === 'PAID' && (await client.salesOrderMilestone.count({ where: { depositRequestId: payload.depositRequestId, status: 'OPEN' } })) > 0
        })
        if (!ready) return
        await command(caller, { name: 'orders.followDeposit', input: { depositRequestId: payload.depositRequestId }, causationId: event.eventId }, async (tools) => ({ paid: await followDepositInCommand(tools, payload.depositRequestId) }))
      },
    }),
  ]
}
