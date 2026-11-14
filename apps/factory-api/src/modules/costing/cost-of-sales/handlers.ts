import { defineHandler, type EventHandler } from '../../../platform/outbox/dispatch'
import { postForEvent, reverseForEvent } from './actions'

/**
 * The worker's half of cost of goods sold (B-W2b-407; FIN-043), in the event's tenant's system context, keyed by the event
 * (a repeated event or a retried job posts nothing twice; the entries' own keys make sure of it too):
 *
 *   shipment.status_changed            to SHIPPED (the goods leave; DELIVERED too, for one that skipped it): its lines'
 *                                      cost of goods sold
 *   shipment.carrier_return_received   the carrier brought it back, its garments are in finished goods again: its live
 *                                      entries taken back
 * Nothing is written while the company's figures for the accountant are off (GATE-ACCOUNTANT); a line that cannot be
 * costed yet (no standard, a move not valued) is posted later by POST /costing/cost-of-sales/post.
 *
 * Listed in background.ts (B-W2b-407's line).
 */
export function costOfSalesHandlers(): EventHandler[] {
  return [
    defineHandler({
      name: 'costing.costOfSales',
      events: ['shipment.status_changed', 'shipment.carrier_return_received'],
      async handle(event, { caller }) {
        if (event.type === 'shipment.carrier_return_received') {
          await reverseForEvent(caller, (event.payload as { shipmentId: string }).shipmentId, event.eventId, 'The carrier brought the shipment back: its garments are in finished goods again.')
          return
        }
        const payload = event.payload as { shipmentId: string; to: string }
        if (payload.to !== 'SHIPPED' && payload.to !== 'DELIVERED') return
        await postForEvent(caller, payload.shipmentId, event.eventId)
      },
    }),
  ]
}
