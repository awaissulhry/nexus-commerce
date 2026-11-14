import { z } from 'zod'
import { RETURN_LABEL_MODES, RETURN_LABEL_REFUSALS, RETURN_LABEL_STATUSES } from '@nexus/factory-domain/shipping/return-labels/rules'
import type { ApiClient } from '../../../../../lib/api/client'

/**
 * A return's carrier labels, office side (B-W2b-398; apps/factory-api modules/shipping/return-labels; design sales.returns
 * RMA › Shipments "Return label or link", "Make return label", the Return label PDF window): the labels (booked now or
 * offered by a link; used; withdrawn), what stops a new one, the customer's orders contacts; make one (a label now, or a
 * link mailed or passed on: its address in that answer only), withdraw one, and the label PDF. Each answer checked with a
 * zod shape that mirrors the API's contract (the web never imports the API source). Codes only: the screens say them.
 */

const labelSchema = z.object({
  id: z.string(),
  status: z.enum(RETURN_LABEL_STATUSES),
  mode: z.enum(RETURN_LABEL_MODES),
  carrierCode: z.string(),
  bookingReference: z.string().nullable(),
  file: z.object({ id: z.string(), name: z.string() }).nullable(),
  link: z.object({ email: z.string().nullable(), expiresAt: z.string(), revoked: z.boolean(), lastOpenedAt: z.string().nullable() }).nullable(),
  usedAt: z.string().nullable(),
  createdAt: z.string(),
  changedAt: z.string(),
})
export type ReturnLabelRow = z.infer<typeof labelSchema>

export const returnLabelsSchema = z.object({
  return: z.object({ id: z.string(), number: z.string(), status: z.string() }),
  labels: z.array(labelSchema),
  make: z.object({
    held: z.enum(RETURN_LABEL_REFUSALS).nullable(),
    shipment: z.object({ id: z.string(), number: z.string() }).nullable(),
    shipments: z.array(z.object({ id: z.string(), number: z.string() })),
    carrierCode: z.string().nullable(),
    linkDays: z.number(),
  }),
  recipients: z.array(z.object({ contactId: z.string(), name: z.string(), email: z.string() })),
  mayManage: z.boolean(),
})
export type ReturnLabels = z.infer<typeof returnLabelsSchema>

const madeSchema = z.object({ url: z.string().nullable(), labels: returnLabelsSchema })
const cancelledSchema = z.object({ labels: returnLabelsSchema })

const base = (returnId: string) => `/sales/returns/${encodeURIComponent(returnId)}/return-labels`

export const readReturnLabels = (api: ApiClient, returnId: string, signal?: AbortSignal): Promise<ReturnLabels> => api.get(base(returnId), { schema: returnLabelsSchema, ...(signal ? { signal } : {}) })

export interface MakeBody {
  readonly mode: 'LABEL' | 'LINK'
  readonly shipmentId?: string
  readonly send?: boolean
}

/** A label booked now (LABEL), or offered by a link mailed to the orders contacts or passed on (`send: false`: its address once). */
export const makeReturnLabel = (api: ApiClient, returnId: string, body: MakeBody, idempotencyKey: string): Promise<z.infer<typeof madeSchema>> => api.post(base(returnId), { body, schema: madeSchema, idempotencyKey })

export const cancelReturnLabel = (api: ApiClient, returnId: string, labelId: string, idempotencyKey: string): Promise<ReturnLabels> =>
  api.post(`${base(returnId)}/${encodeURIComponent(labelId)}/cancel`, { body: {}, schema: cancelledSchema, idempotencyKey }).then((answer) => answer.labels)

/** The label PDF's bytes (the window shows and prints them). */
export const returnLabelPdf = (api: ApiClient, returnId: string, labelId: string, signal?: AbortSignal): Promise<Uint8Array> => api.bytes(`${base(returnId)}/${encodeURIComponent(labelId)}/pdf`, signal ? { signal } : {})
