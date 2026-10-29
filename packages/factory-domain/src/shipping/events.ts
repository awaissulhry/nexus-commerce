import { z } from 'zod'
import { defineEvent } from '../events/define'
import { TRACKING_SOURCES, TRACKING_STATUSES } from './labels/tracking'
import { SHIPMENT_STATUSES } from './shipments'

/**
 * The shipping module's events (plan A1 §3.4; LOG-001, LOG-039, LOG-117). apps/factory-api's modules/shipping emits
 * them in the commands that make the change. No money, no address, no party name in a payload.
 *
 *   shipment.created          a DRAFT shipment was planned for a sales order (office screens)
 *   shipment.status_changed   PACKED, unpacked (DRAFT), SHIPPED (the goods left, B-W1-47) or CANCELLED (office screens)
 *   shipment.packing_changed  its lines, parcels, serials, details or status changed (the packers: office and the
 *                             floor devices of its site, SCR-098)
 *   shipping.settings_saved   a site's shipping settings were created or changed
 *   ddt.issued                a shipment's DDT was issued with its number (B-W1-47; the label (B-W1-48) and the
 *                             deferred invoice (B-W1-51) follow it), `shipped` when the goods left in the same command
 *   ddt.cancelled             an issued DDT was cancelled (it keeps its number; a new one replaces it)
 *   shipment.labels_bought    carrier labels were bought for parcels of a shipment (B-W1-48; the packers print them)
 *   shipment.label_voided     a parcel's carrier label was voided (the parcel can change again)
 *   shipment.tracking_recorded  the carrier's tracking events were recorded (webhook or poll); `status` is the latest
 *   shipment.tracking_poll_due  the scheduler found parcels of the shipment with no news: the worker asks the carrier
 *   shipment.documents_attached   copies of the documents that travel (DDT, DoC, leaflet) were put on the shipment,
 *                                 shared with its party (B-W1-49)
 *   shipment.documents_link_sent  a link to them was mailed to the party: when the goods left, by the office, or because
 *                                 the party asked for a new one
 */
const status = z.enum(SHIPMENT_STATUSES)

export const PACKING_CHANGES = ['lines', 'parcels', 'serials', 'details', 'status'] as const
/** Why a documents link was sent. */
export const DOCUMENT_LINK_REASONS = ['SHIPPED', 'OFFICE', 'ASKED_AGAIN'] as const

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
    description: 'A shipment moved: packed, unpacked, shipped or cancelled.',
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
  defineEvent({
    type: 'ddt.issued',
    context: 'shipping',
    description: "A shipment's DDT was issued with the next number of its company's DDT series.",
    payload: z.strictObject({ ddtId: z.uuid(), shipmentId: z.uuid(), number: z.string(), documentDate: z.iso.date(), replacement: z.boolean(), shipped: z.boolean() }),
    live: { permission: 'shipping.view', fields: ['ddtId', 'shipmentId', 'number'] },
  }),
  defineEvent({
    type: 'ddt.cancelled',
    context: 'shipping',
    description: 'An issued DDT was cancelled with its reason; it keeps its number.',
    payload: z.strictObject({ ddtId: z.uuid(), shipmentId: z.uuid(), number: z.string() }),
    live: { permission: 'shipping.view', fields: ['ddtId', 'shipmentId', 'number'] },
  }),
  defineEvent({
    type: 'shipment.labels_bought',
    context: 'shipping',
    description: "Carrier labels were bought for parcels of a shipment through the company's Sendcloud account.",
    payload: z.strictObject({ shipmentId: z.uuid(), number: z.string(), bought: z.number().int().min(0), failed: z.number().int().min(0) }),
    live: { permission: 'shipping.pack', floor: true, fields: ['shipmentId', 'number', 'bought', 'failed'] },
  }),
  defineEvent({
    type: 'shipment.label_voided',
    context: 'shipping',
    description: "A parcel's carrier label was voided before the goods left (cancelled at the carrier, or queued there).",
    payload: z.strictObject({ shipmentId: z.uuid(), number: z.string(), parcelId: z.uuid(), seq: z.number().int().min(1), queued: z.boolean() }),
    live: { permission: 'shipping.pack', floor: true, fields: ['shipmentId', 'number', 'parcelId', 'seq'] },
  }),
  defineEvent({
    type: 'shipment.tracking_recorded',
    context: 'shipping',
    description: "The carrier's tracking events of a shipment were recorded (a Sendcloud webhook or a poll).",
    payload: z.strictObject({ shipmentId: z.uuid(), number: z.string(), events: z.number().int().min(1), status: z.enum(TRACKING_STATUSES), source: z.enum(TRACKING_SOURCES) }),
    live: { permission: 'shipping.view', fields: ['shipmentId', 'number', 'status'] },
  }),
  defineEvent({
    type: 'shipment.tracking_poll_due',
    context: 'shipping',
    description: 'Parcels of a shipment had no tracking news for hours: the worker asks the carrier.',
    payload: z.strictObject({ shipmentId: z.uuid(), parcels: z.number().int().min(0) }),
  }),
  defineEvent({
    type: 'shipment.documents_attached',
    context: 'shipping',
    description: "Copies of a shipment's travelling documents (DDT, declaration of conformity, user information) were put on the shipment, shared with its party.",
    payload: z.strictObject({ shipmentId: z.uuid(), number: z.string(), attached: z.number().int().min(0), missing: z.number().int().min(0) }),
    live: { permission: 'shipping.view', fields: ['shipmentId', 'number', 'attached', 'missing'] },
  }),
  defineEvent({
    type: 'shipment.documents_link_sent',
    context: 'shipping',
    description: "A link to a shipment's documents was mailed to its party's contacts.",
    payload: z.strictObject({ shipmentId: z.uuid(), number: z.string(), links: z.number().int().min(1), reason: z.enum(DOCUMENT_LINK_REASONS) }),
    live: { permission: 'shipping.view', fields: ['shipmentId', 'number', 'links', 'reason'] },
  }),
] as const
