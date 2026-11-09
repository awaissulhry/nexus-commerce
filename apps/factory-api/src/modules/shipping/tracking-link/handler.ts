import { events as shippingEvents } from '@nexus/factory-domain/shipping/events'
import { InvalidStateError } from '@nexus/factory-domain/core/errors'
import { SYSTEM_ACTOR_ID } from '../../../core/context'
import { serverClock, type Clock } from '../../../core/time'
import { processEmail, type EmailRuntime } from '../../../platform/email-out/service'
import { defineHandler, type EventHandler } from '../../../platform/outbox/dispatch'
import { readShipment } from '../store'
import { makeTrackingLinks } from './make'
import { recipientsOf } from './office'

/**
 * The worker's handler of the goods leaving for the tracking page (B-W2b-170; LOG-062; plan "a SHIPMENT_TRACK link made
 * when a shipment leaves (a handler on the shipped event)"): shipment.status_changed → SHIPPED mails the customer's ACTIVE
 * ORDERS contacts each their own tracking link (once per address: a repeated event finds the link and mails nothing; a
 * suppressed address is skipped). A customer with no such contact gets nothing (the office sends it from the shipment's
 * Tracking & delivery tab). The command takes a key made from the event, so a repeated job answers from its receipt.
 * Mail goes through the company's mail account: FAKE locally and in tests.
 */

export const TRACKING_LINK_HANDLER = 'shipping.trackingLink'

const statusChanged = shippingEvents.find((event) => event.type === 'shipment.status_changed')!.payload

export function trackingLinkHandler(runtime: { readonly email?: () => EmailRuntime; readonly clock?: Clock } = {}): EventHandler {
  const email = runtime.email ?? processEmail
  const clock = runtime.clock ?? serverClock
  return defineHandler({
    name: TRACKING_LINK_HANDLER,
    events: ['shipment.status_changed'],
    async handle(event, tools) {
      const payload = statusChanged.parse(event.payload)
      if (payload.to !== 'SHIPPED') return
      const shipment = await tools.caller.withClient((client) => readShipment(client, payload.shipmentId))
      // Delivered before the job ran: the link still goes (the page answers until 60 days after delivery).
      if (!shipment || (shipment.status !== 'SHIPPED' && shipment.status !== 'DELIVERED')) return
      const to = (await recipientsOf(tools.caller, shipment.partyId)).map(({ email: address, contactId, language }) => ({ email: address, contactId, language }))
      if (to.length === 0) return
      const runtimeEmail = email()
      try {
        await makeTrackingLinks({
          caller: tools.caller,
          delivery: tools.caller,
          email: runtimeEmail,
          clock,
          linkUrl: (token) => `${runtimeEmail.webOrigin}/l#token=${encodeURIComponent(token)}`,
          shipment,
          via: 'SHIPPED',
          to,
          sender: null,
          createdById: SYSTEM_ACTOR_ID,
          idempotencyKey: `tracking-link:${event.eventId}`,
          causationId: event.eventId,
        })
      } catch (error) {
        // The shipment moved on before the job ran (cancelled cannot happen after SHIPPED; delivered 60 days ago is long past).
        if (error instanceof InvalidStateError) return
        throw error
      }
    },
  })
}
