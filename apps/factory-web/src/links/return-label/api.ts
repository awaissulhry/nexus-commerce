import { z } from 'zod'
import { RETURN_LABEL_REFUSALS, RETURN_LABEL_STATUSES } from '@nexus/factory-domain/shipping/return-labels/rules'
import type { ApiClient } from '../../lib/api/client'

/**
 * A return label by link (B-W2b-398; apps/factory-api modules/shipping/return-labels/link.ts; SCR-436): the page (the
 * return, what to send, the label's state, where the parcel goes), Book the carrier (once; nothing is booked before), and
 * the label's download (a presigned address of 60 seconds). The token stays in the client's `x-factory-link` header.
 */

export const returnLabelPageSchema = z.object({
  return: z.object({ number: z.string(), customerRef: z.string().nullable(), status: z.string(), goodsDueBy: z.string().nullable() }),
  companyName: z.string(),
  lines: z.array(z.object({ seq: z.number(), description: z.string(), size: z.string().nullable(), quantity: z.number() })),
  label: z.object({ status: z.enum(RETURN_LABEL_STATUSES), carrierCode: z.string(), bookingReference: z.string().nullable(), hasPdf: z.boolean(), usedAt: z.string().nullable() }),
  bookHeld: z.enum(RETURN_LABEL_REFUSALS).nullable(),
  from: z.object({ city: z.string(), postalCode: z.string(), country: z.string() }).nullable(),
  to: z.object({ name: z.string(), companyName: z.string().nullable(), line1: z.string(), line2: z.string().nullable(), postalCode: z.string(), city: z.string(), province: z.string().nullable(), country: z.string() }).nullable(),
  link: z.object({ expiresAt: z.string() }),
})
export type ReturnLabelPage = z.infer<typeof returnLabelPageSchema>

const downloadSchema = z.object({ fileId: z.string(), name: z.string(), download: z.object({ url: z.string() }) })

export const readReturnLabelPage = (api: ApiClient): Promise<ReturnLabelPage> => api.get('/link/return-label', { schema: returnLabelPageSchema })

/** Books the carrier (once): the page as it is after. */
export const bookReturnLabel = (api: ApiClient, idempotencyKey: string): Promise<ReturnLabelPage> => api.post('/link/return-label/book', { body: {}, schema: returnLabelPageSchema, idempotencyKey })

/** The label PDF: its address (60 s). */
export const downloadReturnLabel = (api: ApiClient, idempotencyKey: string): Promise<string> => api.post('/link/return-label/download', { body: {}, schema: downloadSchema, idempotencyKey }).then((answer) => answer.download.url)
