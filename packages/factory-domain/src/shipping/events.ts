import { z } from 'zod'
import { defineEvent } from '../events/define'
import { SHIPMENT_STATUSES } from './shipments'

/**
 * The shipping module's events (plan A1 §3.4; LOG-001, LOG-039, LOG-117). apps/factory-api's modules/shipping emits
 * them in the commands that make the change. No money, no address, no party name in a payload.
 *
 *   shipment.created          a DRAFT shipment was planned for a sales order (office screens)
 *   shipment.status_changed   PACKED, unpacked (DRAFT) or CANCELLED (office screens)
 *   shipment.packing_changed  its lines, parcels, serials, details or status changed (the packers: office and the
 *                             floor devices of its site, SCR-098)
 *   shipping.settings_saved   a site's shipping settings were created or changed
 */
const status = z.enum(SHIPMENT_STATUSES)

export const PACKING_CHANGES = ['lines', 'parcels', 'serials', 'details', 'status'] as const

export const events = [
  defineEvent({
    type: 'shipment.created',
    context: 'shipping',
    description: "A DRAFT shipment was planned for a sales order's released garments.",
    payload: z.strictObject({ shipmentId: z.uuid(), number: z.string(), salesOrderId: z.uuid(), siteId: z.uuid(), lines: z.number().int().min(0), garments: z.number().int().min(0) }),
    live: { permission: 'shipping.view', fields: ['shipmentId', 'number', 'salesOrderId'] },
  }),
  defineEvent({
    type: 'shipment.status_changed',
    context: 'shipping',
    description: 'A shipment moved: packed, unpacked or cancelled.',
    payload: z.strictObject({ shipmentId: z.uuid(), number: z.string(), from: status, to: status }),
    live: { permission: 'shipping.view', fields: ['shipmentId', 'number', 'from', 'to'] },
  }),
  defineEvent({
    type: 'shipment.packing_changed',
    context: 'shipping',
    description: "A shipment's lines, parcels, serials, details or status changed (the packing screens refresh it).",
    payload: z.strictObject({ shipmentId: z.uuid(), number: z.string(), status, change: z.enum(PACKING_CHANGES) }),
    live: { permission: 'shipping.pack', floor: true, fields: ['shipmentId', 'number', 'status', 'change'] },
  }),
  defineEvent({
    type: 'shipping.settings_saved',
    context: 'shipping',
    description: "A site's shipping settings were created or changed.",
    payload: z.strictObject({ siteId: z.uuid(), created: z.boolean() }),
    live: { permission: 'shipping.settings.view', fields: ['siteId'] },
  }),
] as const
