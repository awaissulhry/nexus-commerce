import { z } from 'zod'
import { OUTBOUND_STATUSES } from '@nexus/factory-domain/email/rules'
import { NOTICE_HELD } from '@nexus/factory-domain/shipping/notices/rules'
import type { ApiClient } from '../../../../lib/api/client'

/**
 * The shipping notice to the customer (B-W2b-398; LOG-061; `GET|POST /shipping/shipments/:id/notice`): the site's switch,
 * why it does not go by itself or cannot be sent by hand (codes), the customer's orders contacts, the mails sent with their
 * delivery state. Nothing reaches a real customer locally (the FAKE e-mail provider).
 */

export const noticeSchema = z.object({
  shipment: z.object({ id: z.string(), number: z.string(), status: z.string(), siteId: z.string() }),
  switchOn: z.boolean(),
  automaticHeld: z.enum(NOTICE_HELD).nullable(),
  sendHeld: z.enum(NOTICE_HELD).nullable(),
  mayManage: z.boolean(),
  recipients: z.array(z.object({ contactId: z.string(), name: z.string(), email: z.string() })),
  mails: z.array(
    z.object({
      id: z.string(),
      to: z.array(z.string()),
      locale: z.string(),
      status: z.enum(OUTBOUND_STATUSES),
      queuedAt: z.string(),
      sentAt: z.string().nullable(),
      deliveredAt: z.string().nullable(),
      bouncedAt: z.string().nullable(),
      failedAt: z.string().nullable(),
      automatic: z.boolean(),
    }),
  ),
})
export type Notice = z.infer<typeof noticeSchema>

const path = (shipmentId: string) => `/shipping/shipments/${encodeURIComponent(shipmentId)}/notice`

export const readNotice = (api: ApiClient, shipmentId: string): Promise<Notice> => api.get(path(shipmentId), { schema: noticeSchema })

const sentSchema = z.object({ sent: z.number(), failed: z.number(), skipped: z.array(z.string()), notice: noticeSchema })
export type NoticeSent = z.infer<typeof sentSchema>

/** Send again by hand: to some of the customer's orders contacts, or all of them. */
export function sendNotice(api: ApiClient, shipmentId: string, contactIds: readonly string[] | null, idempotencyKey: string): Promise<NoticeSent> {
  return api.post(path(shipmentId), { body: contactIds && contactIds.length > 0 ? { contactIds } : {}, schema: sentSchema, idempotencyKey })
}
