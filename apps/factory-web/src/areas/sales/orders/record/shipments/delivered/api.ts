import { z } from 'zod'
import { DELIVERED_VIAS } from '@nexus/factory-domain/shipping/pod/rules'
import type { ApiClient } from '../../../../../../lib/api/client'

/**
 * An order's deliveries (B-W2b-398; apps/factory-api modules/sales/orders/delivered.ts; design sales.orders record ›
 * Shipments "Delivered (W2b, from carrier)"): each shipment that left — when it arrived, how we know (the carrier's
 * tracking or a status typed by a person), its proof of delivery (who signed, when, whether an image is kept), its open
 * tracking problems — the order's delivery time, and the payment steps that run from delivery. The proof's image is
 * downloaded from the shipment (`GET /shipping/shipments/:id/pod/file`, shipping.view): a presigned address of 60 seconds.
 */

export const deliveriesSchema = z.object({
  order: z.object({ id: z.string(), number: z.string(), status: z.string(), deliveredAt: z.string().nullable() }),
  shipments: z.array(
    z.object({
      id: z.string(),
      number: z.string(),
      status: z.string(),
      carrierName: z.string().nullable(),
      shippedAt: z.string().nullable(),
      deliveredAt: z.string().nullable(),
      deliveredVia: z.enum(DELIVERED_VIAS).nullable(),
      pod: z.object({ signedBy: z.string().nullable(), signedAt: z.string().nullable(), image: z.boolean() }).nullable(),
      openProblems: z.number(),
      mayOpen: z.boolean(),
    }),
  ),
  steps: z.array(z.object({ id: z.string(), seq: z.number(), status: z.string(), dueDate: z.string().nullable() })),
})
export type Deliveries = z.infer<typeof deliveriesSchema>
export type DeliveryRow = Deliveries['shipments'][number]

const downloadSchema = z.object({ fileId: z.string(), name: z.string(), download: z.object({ url: z.string() }) })

export const readDeliveries = (api: ApiClient, orderId: string, signal?: AbortSignal): Promise<Deliveries> =>
  api.get(`/sales/orders/${encodeURIComponent(orderId)}/deliveries`, { schema: deliveriesSchema, ...(signal ? { signal } : {}) })

/** The proof's image: a presigned address (60 s) to open at once. */
export const podDownload = (api: ApiClient, shipmentId: string): Promise<string> =>
  api.get(`/shipping/shipments/${encodeURIComponent(shipmentId)}/pod/file`, { schema: downloadSchema }).then((answer) => answer.download.url)
