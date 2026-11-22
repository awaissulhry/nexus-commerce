import { z } from 'zod'
import { defineEvent, /* B-SA-004 */ livePartyId } from '../events/define'
import { SHIPMENT_HOLD_REASONS } from '../shipping/holds/holds'
import { SPLIT_REASONS } from '../shipping/split/split'

/**
 * The events of the shipment queue in depth (B-W2b-386; LOG-005, LOG-017, LOG-018, FIN-079; apps/factory-api modules/shipping
 * holds, split, queue). Context `shipping-queue`, its own module folder (the shipping events file is W1's). A hold and a
 * split reach the office's queue and shipment record (shipping.view) and the packing benches of the shipment's site
 * (shipping.pack: B-W2b-387's bench shows a hold at once instead of on its next read). No party name (B-SA-004: the shipment's
 * customer by id only, `partyId`, for the office's live wall), no address, no words, no
 * person: ids, numbers and codes.
 *
 *   shipment.hold_placed     a shipment was put on hold with a reason (by a person, or by the system: the balance before
 *                            shipping, the customer's account on hold, over the credit limit)
 *   shipment.hold_released   a hold was released with words (by a person, or by the system when its cause is gone);
 *                            `stillHeld` when another hold is in force
 *   shipment.split           garments of a shipment moved onto a new shipment of the same order (by hand or by rule)
 *   shipment.garments_moved  B-OS-011/012: garments of a DRAFT moved onto another DRAFT of the customer (merged: the emptied one
 *                            cancelled)
 *   shipping.cut_offs_saved  a site's carrier cut-offs were saved
 */
const reason = z.enum(SHIPMENT_HOLD_REASONS)

export const events = [
  defineEvent({
    type: 'shipment.hold_placed',
    context: 'shipping-queue',
    description: 'A shipment that has not left was put on hold with a reason, by a person or by the system: it can no longer be packed, labelled or leave until the hold is released.',
    payload: z.strictObject({ shipmentId: z.uuid(), number: z.string(), holdId: z.uuid(), reason, bySystem: z.boolean(), partyId: livePartyId() /* B-SA-004 */ }),
    live: { permission: 'shipping.view', floor: 'shipping.pack', fields: ['shipmentId', 'number', 'holdId', 'reason'] },
  }),
  defineEvent({
    type: 'shipment.hold_released',
    context: 'shipping-queue',
    description: "A shipment's hold was released with words, by a person or by the system when its cause was gone; another hold may still be in force.",
    payload: z.strictObject({ shipmentId: z.uuid(), number: z.string(), holdId: z.uuid(), reason, bySystem: z.boolean(), stillHeld: z.boolean(), partyId: livePartyId() /* B-SA-004 */ }),
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
      partyId: livePartyId(), // B-SA-004: the shipment's customer (Shipment.partyId, read on the server)
    }),
    live: { permission: 'shipping.view', floor: 'shipping.pack', fields: ['shipmentId', 'number', 'splitFromId', 'fromNumber', 'reason'] },
  }),
  // ── B-OS-011, B-OS-012 (order shipments tab; 13-backend §5): garments of a DRAFT moved onto another DRAFT (or merged into it) ──
  defineEvent({
    type: 'shipment.garments_moved',
    context: 'shipping-queue',
    description: "Garments of a DRAFT shipment moved onto another DRAFT shipment of the same customer and site; merged: every garment moved and the emptied DRAFT was cancelled.",
    payload: z.strictObject({
      shipmentId: z.uuid(),
      number: z.string(),
      toShipmentId: z.uuid(),
      toNumber: z.string(),
      merged: z.boolean(),
      lines: z.number().int().min(1),
      garments: z.number().int().min(1),
      partyId: livePartyId(), // B-SA-004: the shipments' customer (Shipment.partyId, read on the server)
    }),
    live: { permission: 'shipping.view', floor: 'shipping.pack', fields: ['shipmentId', 'number', 'toShipmentId', 'toNumber', 'merged'] },
  }),
  // ── end B-OS-011, B-OS-012 ──
  defineEvent({
    type: 'shipping.cut_offs_saved',
    context: 'shipping-queue',
    description: "A site's carrier cut-offs (per carrier and weekday) were saved.",
    payload: z.strictObject({ siteId: z.uuid(), cutOffs: z.number().int().min(0) }),
    live: { permission: 'shipping.settings.view', fields: ['siteId', 'cutOffs'] },
  }),
] as const
