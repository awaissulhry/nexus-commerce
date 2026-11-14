import { z } from 'zod'
import { defineEvent } from '../events/define'

/**
 * The events of delivery and return labels (B-W2b-398; LOG-061, LOG-063, LOG-065, LOG-112; apps/factory-api
 * modules/shipping/{notices,exceptions,pod,return-labels}). Context `shipping-delivery`, its own module folder (the shipping
 * events file is W1's). A shipment's events reach the office's shipping screens (shipping.view); a return label's the
 * returns screens (sales.returns.view). No person, no address, no money: ids, numbers, codes and counts. A delivered order
 * says so with W1's sales_order.status_changed (to DELIVERED).
 *
 *   shipment.customer_notice_sent        the shipping notice went to the customer (by itself when the goods left, or a
 *                                        person sent it again): how many mails
 *   shipment.tracking_problem_raised     a parcel is late, has an address problem, failed delivery or has no carrier news
 *                                        for days: the problem and the task a person works it in
 *   shipment.tracking_problem_resolved   a person resolved it, or the goods arrived
 *   shipment.pod_recorded                the proof of delivery (who signed, when, the image) came from the carrier or a person
 *   return_label.changed                 a return label made (BOOKED at once, or OFFERED by link), booked by its link, used
 *                                        (the goods came back) or cancelled
 */

const shipmentLive = { permission: 'shipping.view' } as const

export const events = [
  defineEvent({
    type: 'shipment.customer_notice_sent',
    context: 'shipping-delivery',
    description: 'The shipping notice went to the customer in their language (tracking numbers and the cartons\' contents): by itself when the goods left with the site\'s switch on, or sent again by a person.',
    payload: z.strictObject({ shipmentId: z.uuid(), number: z.string(), mails: z.number().int().min(0), automatic: z.boolean() }),
    live: { ...shipmentLive, fields: ['shipmentId', 'number', 'automatic'] },
  }),
  defineEvent({
    type: 'shipment.tracking_problem_raised',
    context: 'shipping-delivery',
    description: 'A tracking problem was raised on a shipment on its way (delayed, an address problem, a failed delivery, or no carrier news for days), with the task a person works it in.',
    payload: z.strictObject({ shipmentId: z.uuid(), number: z.string(), exceptionId: z.uuid(), kind: z.enum(['DELAYED', 'ADDRESS_PROBLEM', 'FAILED_DELIVERY', 'NO_SCAN']), taskId: z.uuid().nullable() }),
    live: { ...shipmentLive, fields: ['shipmentId', 'number', 'exceptionId', 'kind'] },
  }),
  defineEvent({
    type: 'shipment.tracking_problem_resolved',
    context: 'shipping-delivery',
    description: 'A tracking problem of a shipment was resolved by a person, or by itself when the goods arrived.',
    payload: z.strictObject({ shipmentId: z.uuid(), number: z.string(), exceptionId: z.uuid(), kind: z.enum(['DELAYED', 'ADDRESS_PROBLEM', 'FAILED_DELIVERY', 'NO_SCAN']), automatic: z.boolean() }),
    live: { ...shipmentLive, fields: ['shipmentId', 'number', 'exceptionId', 'kind'] },
  }),
  defineEvent({
    type: 'shipment.pod_recorded',
    context: 'shipping-delivery',
    description: "A delivered shipment's proof of delivery (who signed, when, the signature or photo) came from the carrier or was recorded by a person.",
    payload: z.strictObject({ shipmentId: z.uuid(), number: z.string(), via: z.enum(['CARRIER', 'OFFICE']), image: z.boolean() }),
    live: { ...shipmentLive, fields: ['shipmentId', 'number', 'via'] },
  }),
  defineEvent({
    type: 'return_label.changed',
    context: 'shipping-delivery',
    description: "A return's carrier label was booked at once or offered by link, booked by the customer through the link, used (the goods came back) or cancelled.",
    payload: z.strictObject({ returnId: z.uuid(), number: z.string(), labelId: z.uuid(), status: z.enum(['OFFERED', 'BOOKED', 'USED', 'CANCELLED']), via: z.enum(['OFFICE', 'LINK', 'DOCK']) }),
    live: { permission: 'sales.returns.view', fields: ['returnId', 'number', 'labelId', 'status'] },
  }),
] as const
