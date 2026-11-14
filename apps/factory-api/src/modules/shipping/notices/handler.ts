import { events as shippingEvents } from '@nexus/factory-domain/shipping/events'
import { serverClock, type Clock } from '../../../core/time'
import { processEmail, type EmailRuntime } from '../../../platform/email-out/service'
import { defineHandler, type EventHandler } from '../../../platform/outbox/dispatch'
import { sendNotice } from './notices'

/**
 * The worker's handler of the goods leaving for the shipping notice (B-W2b-398; LOG-061): shipment.status_changed → SHIPPED
 * sends the notice to the customer's ACTIVE orders contacts only while the site's switch ShippingSettings.customerNoticeOn is
 * on (OFF by default: the Owner's rule of 11-13), never for a shipment with a TEST label, once per shipment (the command's
 * key is the shipment's; a held notice writes nothing). FAKE e-mail locally and in tests.
 */

export const CUSTOMER_NOTICE_HANDLER = 'shipping.customerNotice'

const statusChanged = shippingEvents.find((event) => event.type === 'shipment.status_changed')!.payload

export function customerNoticeHandler(runtime: { readonly email?: () => EmailRuntime; readonly clock?: Clock } = {}): EventHandler {
  const email = runtime.email ?? processEmail
  const clock = runtime.clock ?? serverClock
  return defineHandler({
    name: CUSTOMER_NOTICE_HANDLER,
    events: ['shipment.status_changed'],
    async handle(event, tools) {
      const payload = statusChanged.parse(event.payload)
      if (payload.to !== 'SHIPPED') return
      await sendNotice({ caller: tools.caller, delivery: tools.caller, email: email(), clock, shipmentId: payload.shipmentId, automatic: true, sender: null, idempotencyKey: `customer-notice:${payload.shipmentId}`, causationId: event.eventId })
    },
  })
}
