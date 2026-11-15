import { z } from 'zod'
import { defineEvent } from '../events/define'

/**
 * The events of pickups and the day's close (B-W2b-395; LOG-048, LOG-049; apps/factory-api modules/shipping/{pickups,manifest}).
 * Context `shipping-dispatch`, its own module folder (the shipping events file is W1's). They reach the office's shipments
 * screens (shipping.view: the cut-off strip's "pickup booked 16:00", End of day). No address, no person: ids and the state.
 * The customer's collection (LOG-053) changes the shipment and says so with W1's shipment.packing_changed (details), and its
 * delivery at the collection with W1's shipment.status_changed and shipment.tracking_recorded.
 *
 *   shipping.pickup_changed      a pickup was booked (through Sendcloud, the TEST pickup of test mode, or kept as booked by
 *                                phone), answered by Sendcloud, confirmed by hand, failed or called off
 *   shipping.day_sheet_closed    a site's day sheet for one carrier was closed with its PDF (by a person, or by the system
 *                                after the site's day ended): its shipments are fixed on it
 */
export const events = [
  defineEvent({
    type: 'shipping.pickup_changed',
    context: 'shipping-dispatch',
    description: 'A carrier pickup was booked (through Sendcloud, by the test pickup of test mode, or noted after a phone booking), answered, confirmed by hand, failed or called off.',
    payload: z.strictObject({
      pickupId: z.uuid(),
      siteId: z.uuid(),
      carrierCode: z.string(),
      status: z.enum(['REQUESTED', 'CONFIRMED', 'FAILED', 'CANCELLED']),
      via: z.enum(['SENDCLOUD', 'PHONE']),
      readyAt: z.string(),
      recurring: z.boolean(),
    }),
    live: { permission: 'shipping.view', fields: ['pickupId', 'siteId', 'carrierCode', 'status', 'readyAt'] },
  }),
  defineEvent({
    type: 'shipping.day_sheet_closed',
    context: 'shipping-dispatch',
    description: "A site's day sheet for one carrier was closed with its PDF, by a person or by the system after the day ended: the shipments handed over are fixed on it.",
    payload: z.strictObject({
      manifestId: z.uuid(),
      siteId: z.uuid(),
      carrierCode: z.string(),
      day: z.string(),
      shipments: z.number().int().min(0),
      parcels: z.number().int().min(0),
      bySystem: z.boolean(),
    }),
    live: { permission: 'shipping.view', fields: ['manifestId', 'siteId', 'carrierCode', 'day', 'shipments'] },
  }),
] as const
