import { z } from 'zod'
import { ORDER_LIFE } from '@nexus/factory-domain/sales/order-life'
import { newIdempotencyKey, type ApiClient } from '../../../../../lib/api/client'
import type { LegFacts } from './model'

/**
 * owb-of5 — the order band's reads and its one command, each with this web's own zod (a field the server adds later is ignored):
 *  - S3's warehouse legs of an order (`GET /shipping/warehouse-legs?salesOrderId=`, owb-ss1 Shape, shipping.view): the band's
 *    "It arrived" / "Send on" at our warehouse. A reader without shipping.view, or a server before ss1: no leg (no act drawn).
 *  - S2's band of a Draft or Sent order (`GET /sales/orders/requests/:requestId/band`, owb-of1 Shape, FIXED).
 *  - S2's Restrict on the floor (`POST /sales/orders/:id/restrict { version, restricted }`, owb-of1 step 4, orders.manage).
 */

const legSchema = z.object({
  shipmentId: z.string(),
  version: z.number(),
  warehouse: z.object({ siteId: z.string(), name: z.string(), city: z.string().nullable() }).optional(),
  state: z.enum(['ON_THE_WAY', 'AT_OUR_WAREHOUSE', 'SENT_ON']),
  may: z.object({ arrived: z.boolean(), sendOn: z.boolean(), label: z.boolean().optional() }),
})
const legsSchema = z.object({ legs: z.array(legSchema) })

/** The order's warehouse legs as the band reads them. */
export async function readWarehouseLegs(api: ApiClient, orderId: string, signal?: AbortSignal): Promise<LegFacts[]> {
  const answer = await api.get('/shipping/warehouse-legs', { query: { salesOrderId: orderId }, schema: legsSchema, signal })
  return answer.legs.map((leg) => ({ shipmentId: leg.shipmentId, state: leg.state, may: { arrived: leg.may.arrived, sendOn: leg.may.sendOn } }))
}

const pictureSchema = z.object({ fileId: z.string(), contentType: z.string(), small: z.boolean() })

export const requestBandSchema = z.object({
  id: z.string(),
  version: z.number(),
  number: z.string().nullable(),
  subject: z.string().nullable(),
  party: z.object({ id: z.string(), code: z.string(), name: z.string() }),
  life: z.enum(ORDER_LIFE),
  picture: pictureSchema.nullable(),
  open: z.object({
    count: z.number(),
    confirmHeld: z.boolean(),
    lines: z.array(z.object({ lineId: z.string(), seq: z.number(), what: z.enum(['PRODUCT', 'MATERIAL', 'SIZES', 'PIECES']) })),
  }),
  may: z.object({ confirm: z.boolean(), picture: z.boolean() }),
})
export type RequestBand = z.infer<typeof requestBandSchema>

/** The band of a Draft or Sent order (the request's own number, subject, picture, life, open details and what this reader may do). */
export const readRequestBand = (api: ApiClient, requestId: string, signal?: AbortSignal): Promise<RequestBand> =>
  api.get(`/sales/orders/requests/${encodeURIComponent(requestId)}/band`, { schema: requestBandSchema, signal })

/** Restrict on the floor (only the named workers) or Open it to the department again; the page reads the order again after it. */
export const restrictOrder = (api: ApiClient, orderId: string, body: { version: number; restricted: boolean }, idempotencyKey: string = newIdempotencyKey()): Promise<unknown> =>
  api.post(`/sales/orders/${encodeURIComponent(orderId)}/restrict`, { body, idempotencyKey })

// ---- owb-of6 step 3: the customer's "I paid" notices (owb-of1 step 4 Shape, FIXED) --------------------------------------------------

export const paymentNoticeSchema = z.object({
  id: z.string(),
  version: z.number(),
  step: z.object({ id: z.string(), words: z.string() }).nullable(),
  paidOn: z.string(),
  method: z.string().nullable(),
  note: z.string().nullable(),
  fileId: z.string().nullable(),
  /** Only with the price grain (never for sales or the designer). */
  amount: z.number().optional(),
  currency: z.string(),
  state: z.enum(['OPEN', 'RECORDED', 'DISMISSED']),
  at: z.string(),
})
export type PaymentNotice = z.infer<typeof paymentNoticeSchema>
const noticesSchema = z.object({ notices: z.array(paymentNoticeSchema) })

/** The order's "I paid" notices (orders.view; the amount only with the price grain). */
export const readPaymentNotices = (api: ApiClient, orderId: string, signal?: AbortSignal): Promise<PaymentNotice[]> =>
  api.get(`/sales/orders/${encodeURIComponent(orderId)}/payment-notices`, { schema: noticesSchema, signal }).then((answer) => answer.notices)

/** Recorded (seen: the person then records the payment with Record a payment…) or Dismissed (payments.record). */
export const answerPaymentNotice = (api: ApiClient, orderId: string, noticeId: string, body: { version: number; state: 'RECORDED' | 'DISMISSED' }, idempotencyKey: string = newIdempotencyKey()): Promise<unknown> =>
  api.post(`/sales/orders/${encodeURIComponent(orderId)}/payment-notices/${encodeURIComponent(noticeId)}/answer`, { body, idempotencyKey })

// ---- owb-of6 step 4: Download all (owb-of1 step 5; L5: one zip of what the reader may open) ----------------------------------------

/** The zip's bytes and how many files were left out (`x-left-out`: priced without the grain, locked body data). */
export async function downloadOrderZip(api: ApiClient, orderId: string): Promise<{ bytes: Uint8Array; leftOut: number }> {
  let leftOut = 0
  const bytes = await api.bytes(`/sales/orders/${encodeURIComponent(orderId)}/files/zip`, {
    method: 'POST',
    body: {},
    idempotencyKey: newIdempotencyKey(),
    onHeaders: (headers) => {
      const value = Number(headers.get('x-left-out') ?? '0')
      leftOut = Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0
    },
  })
  return { bytes, leftOut }
}
