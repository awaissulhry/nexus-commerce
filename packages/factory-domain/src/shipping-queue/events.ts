import { z } from 'zod'
import { defineEvent } from '../events/define'
import { SHIPMENT_HOLD_REASONS } from '../shipping/holds/holds'
import { SPLIT_REASONS } from '../shipping/split/split'

/**
 * The events of the shipment queue in depth (B-W2b-386; LOG-005, LOG-017, LOG-018, FIN-079; apps/factory-api modules/shipping
 * holds, split, queue). Context `shipping-queue`, its own module folder (the shipping events file is W1's). A hold and a
 * split reach the office's queue and shipment record (shipping.view) and the packing benches of the shipment's site
 * (shipping.pack: B-W2b-387's bench shows a hold at once instead of on its next read). No party, no address, no words, no
 * person: ids, numbers and codes.
 *
 *   shipment.hold_placed     a shipment was put on hold with a reason (by a person, or by the system: the balance before
 *                            shipping, the customer's account on hold, over the credit limit)
 *   shipment.hold_released   a hold was released with words (by a person, or by the system when its cause is gone);
 *                            `stillHeld` when another hold is in force
 *   shipment.split           garments of a shipment moved onto a new shipment of the same order (by hand or by rule)
 *   shipping.cut_offs_saved  a site's carrier cut-offs were saved
 */
const reason = z.enum(SHIPMENT_HOLD_REASONS)

export const events = [
  defineEvent({
    type: 'shipment.hold_placed',
    context: 'shipping-queue',
    description: 'A shipment that has not left was put on hold with a reason, by a person or by the system: it can no longer be packed, labelled or leave until the hold is released.',
    payload: z.strictObject({ shipmentId: z.uuid(), number: z.string(), holdId: z.uuid(), reason, bySystem: z.boolean() }),
    live: { permission: 'shipping.view', floor: 'shipping.pack', fields: ['shipmentId', 'number', 'holdId', 'reason'] },
  }),
  defineEvent({
    type: 'shipment.hold_released',
    context: 'shipping-queue',
    description: "A shipment's hold was released with words, by a person or by the system when its cause was gone; another hold may still be in force.",
    payload: z.strictObject({ shipmentId: z.uuid(), number: z.string(), holdId: z.uuid(), reason, bySystem: z.boolean(), stillHeld: z.boolean() }),
    live: { permission: 'shipping.view', floor: 'shipping.pack', fields: ['shipmentId', 'number', 'holdId', 'reason', 'stillHeld'] },
  }),
  defineEvent({
    type: 'shipment.split',
    context: 'shipping-queue',
    description: "Garments of a DRAFT shipment moved onto a new shipment of the same order, by hand or by the rule (by carrier, service, delivery address or promise date).",
    payload: z.strictObject({
      shipmentId: z.uuid(),
      number: z.string(),
      splitFromId: z.uuid(),
      fromNumber: z.string(),
      reason: z.enum(SPLIT_REASONS),
      byRule: z.boolean(),
      lines: z.number().int().min(1),
      garments: z.number().int().min(1),
    }),
    live: { permission: 'shipping.view', floor: 'shipping.pack', fields: ['shipmentId', 'number', 'splitFromId', 'fromNumber', 'reason'] },
  }),
  defineEvent({
    type: 'shipping.cut_offs_saved',
    context: 'shipping-queue',
    description: "A site's carrier cut-offs (per carrier and weekday) were saved.",
    payload: z.strictObject({ siteId: z.uuid(), cutOffs: z.number().int().min(0) }),
    live: { permission: 'shipping.settings.view', fields: ['siteId', 'cutOffs'] },
  }),
] as const
