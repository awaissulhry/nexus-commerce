import { z } from 'zod'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'

/**
 * The options follow-ups' office calls (B-W2b-374): a typed line's options are read and checked through B-W2b-340's style
 * configurator (GET /sales/configurator/styles/:styleId) and B-W2b-229's check (quotes/record/configurator/api.ts), and sent
 * with the line (the New order's and the amendment's bodies); an order line's artwork is shown in the portal here.
 */

const enc = encodeURIComponent

const artworkSchema = z.object({ fileId: z.string(), name: z.string(), contentType: z.string(), sizeBytes: z.number(), createdAt: z.string(), portal: z.boolean(), from: z.enum(['LINE', 'QUOTE_LINE']) })

/** PUT /sales/orders/:orderId/lines/:lineId/artwork/:fileId/portal (orders.manage): shown in (or out of) the portal. */
export function shareArtwork(api: ApiClient, orderId: string, lineId: string, fileId: string, shown: boolean, idempotencyKey = newIdempotencyKey()) {
  return api.request('PUT', `/sales/orders/${enc(orderId)}/lines/${enc(lineId)}/artwork/${enc(fileId)}/portal`, { body: { shown }, schema: z.object({ artwork: z.array(artworkSchema) }), idempotencyKey })
}
