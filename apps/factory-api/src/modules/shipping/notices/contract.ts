import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { NOTICE_HELD } from '@nexus/factory-domain/shipping/notices/rules'

/**
 * The shipping notice to the customer (B-W2b-398; LOG-061; design warehouse.shipments Tracking & delivery › Customer
 * notice). Codes only (NOTICE_HELD): the screens say them. The customer's contacts are the shipment's own customer's.
 */

const noticeSchema = output({
  shipment: output({ id: id(), number: z.string(), status: z.string(), siteId: id() }),
  /** The site's switch (Shipping settings): on, the notice goes by itself when the goods leave. */
  switchOn: z.boolean(),
  automaticHeld: z.enum(NOTICE_HELD).nullable(),
  sendHeld: z.enum(NOTICE_HELD).nullable(),
  mayManage: z.boolean(),
  recipients: z.array(output({ contactId: id(), name: z.string(), email: z.string() })),
  mails: z.array(
    output({
      id: id(),
      to: z.array(z.string()),
      locale: z.string(),
      status: z.string(),
      queuedAt: instant(),
      sentAt: instant().nullable(),
      deliveredAt: instant().nullable(),
      bouncedAt: instant().nullable(),
      failedAt: instant().nullable(),
      /** Sent by itself when the goods left (else by a person). */
      automatic: z.boolean(),
    }),
  ),
})

export const getNoticeContract = defineContract({
  params: input({ shipmentId: id() }),
  response: { 200: noticeSchema },
})

export const sendNoticeContract = defineContract({
  params: input({ shipmentId: id() }),
  /** Some of the customer's orders contacts; none: all of them. */
  body: input({ contactIds: z.array(id()).min(1).max(20).optional() }),
  response: { 200: output({ sent: z.number().int(), failed: z.number().int(), skipped: z.array(z.string()), notice: noticeSchema }) },
})
