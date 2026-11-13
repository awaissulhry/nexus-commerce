import { z } from 'zod'
import { defineEvent } from '../events/define'

/**
 * The events of packing in depth (B-W2b-384; LOG-007, LOG-010, LOG-013; apps/factory-api modules/shipping/cartons). Context
 * `shipping-cartons`, its own module folder (the shipping events file is W1's). It reaches the office's shipment record
 * (shipping.view: design warehouse.shipments "pack station carton updates (new event shipping.carton_packed) → Cartons") and
 * the packing benches of the shipment's site (shipping.pack). No party, no address, no person.
 *
 *   shipping.carton_packed   a carton was closed: its contents stored, its packaging and its "n of N" set
 */
export const events = [
  defineEvent({
    type: 'shipping.carton_packed',
    context: 'shipping-cartons',
    description: 'A carton of a shipment was closed at the packing bench: its contents stored, its packaging and its number "n of N" set.',
    payload: z.strictObject({
      shipmentId: z.uuid(),
      number: z.string(),
      parcelId: z.uuid(),
      cartonNumber: z.number().int().min(1),
      cartonCount: z.number().int().min(1),
      garments: z.number().int().min(1),
    }),
    live: { permission: 'shipping.view', floor: 'shipping.pack', fields: ['shipmentId', 'number', 'parcelId', 'cartonNumber', 'cartonCount', 'garments'] },
  }),
] as const
