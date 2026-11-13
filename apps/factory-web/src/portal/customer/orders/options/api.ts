import { z } from 'zod'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'

/**
 * The options and artwork of the customer's order lines (B-W2b-374; XF3:04): GET /portal/sales-orders/:orderId/options (each
 * line's options in words, the artwork the office shows in the portal) and POST …/artwork/:fileId/open (logged; a presigned
 * GET of 60 seconds).
 */

const enc = encodeURIComponent
const words = z.object({ it: z.string(), en: z.string() })

export const portalOptionsSchema = z.object({
  orderId: z.string(),
  lines: z.array(
    z.object({
      lineId: z.string(),
      seq: z.number(),
      options: z.array(words),
      artwork: z.array(z.object({ fileId: z.string(), name: z.string(), contentType: z.string(), sizeBytes: z.number(), picture: z.boolean() })),
    }),
  ),
})
export type PortalOptions = z.infer<typeof portalOptionsSchema>
export type PortalArtwork = PortalOptions['lines'][number]['artwork'][number]

const openSchema = z.object({
  file: z.object({ fileId: z.string(), name: z.string(), contentType: z.string() }),
  download: z.object({ mode: z.enum(['inline', 'download']), method: z.literal('GET'), url: z.string(), headers: z.record(z.string(), z.string()), expiresAt: z.string() }),
})

export function readPortalOptions(api: ApiClient, orderId: string, signal?: AbortSignal): Promise<PortalOptions> {
  return api.get(`/portal/sales-orders/${enc(orderId)}/options`, { schema: portalOptionsSchema, signal })
}

export function openPortalArtwork(api: ApiClient, orderId: string, fileId: string, mode: 'preview' | 'download') {
  return api.post(`/portal/sales-orders/${enc(orderId)}/artwork/${enc(fileId)}/open`, { body: { mode }, schema: openSchema, idempotencyKey: newIdempotencyKey() })
}
