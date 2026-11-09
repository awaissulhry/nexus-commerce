import { z } from 'zod'
import { SHIPMENT_STATUSES } from '@nexus/factory-domain/shipping/shipments'
import { MAKE_HELD, TRACKING_VIAS } from '@nexus/factory-domain/shipping/tracking-link/rules'
import type { ApiClient } from '../../../../lib/api/client'

/**
 * The shipment's tracking links, office side (B-W2b-170; apps/factory-api modules/shipping/tracking-link; design
 * warehouse.shipments page.conn "the tracking link (links.tracking)"): who gets the branded tracking page by default, the
 * links made (never a token), the public search's one-day links as a count, why none can be made now; send it, take a link
 * to pass on (its address in that answer only), withdraw one.
 */

const linkSchema = z.object({
  id: z.string(),
  email: z.string().nullable(),
  via: z.enum(TRACKING_VIAS).nullable(),
  state: z.enum(['LIVE', 'REVOKED', 'USED_UP', 'EXPIRED', 'ENDED']),
  createdAt: z.string(),
  endsAt: z.string(),
  lastOpenedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  automatic: z.boolean(),
})

export const trackingLinksSchema = z.object({
  shipment: z.object({ id: z.string(), number: z.string(), status: z.enum(SHIPMENT_STATUSES), partyId: z.string() }),
  recipients: z.array(z.object({ contactId: z.string(), name: z.string(), email: z.string() })),
  links: z.array(linkSchema),
  searches: z.object({ count: z.number(), lastAt: z.string().nullable() }),
  held: z.enum(MAKE_HELD).nullable(),
  mayManage: z.boolean(),
})
export type TrackingLinks = z.infer<typeof trackingLinksSchema>
export type TrackingLinkRow = TrackingLinks['links'][number]

const readSchema = z.object({ tracking: trackingLinksSchema })
const madeSchema = z.object({
  links: z.array(z.object({ id: z.string(), email: z.string().nullable(), expiresAt: z.string(), delivery: z.enum(['QUEUED', 'SENT', 'FAILED']).nullable() })),
  skipped: z.array(z.object({ email: z.string(), reason: z.enum(['SUPPRESSED', 'ALREADY_SENT', 'ASKED_RECENTLY']) })),
  url: z.string().nullable(),
  tracking: trackingLinksSchema,
})
export type Made = z.infer<typeof madeSchema>

const base = (shipmentId: string) => `/shipping/shipments/${encodeURIComponent(shipmentId)}/tracking-links`

export const readTrackingLinks = (api: ApiClient, shipmentId: string): Promise<TrackingLinks> => api.get(base(shipmentId), { schema: readSchema }).then((answer) => answer.tracking)

/** Mail it (to the customer's orders contacts, or one address), or take one link to pass on (`send: false`). */
export function makeTrackingLink(api: ApiClient, shipmentId: string, body: { send: boolean; email?: string }, idempotencyKey: string): Promise<Made> {
  return api.post(base(shipmentId), { body, schema: madeSchema, idempotencyKey })
}

export function revokeTrackingLink(api: ApiClient, shipmentId: string, linkId: string, idempotencyKey: string): Promise<TrackingLinks> {
  return api.post(`${base(shipmentId)}/${encodeURIComponent(linkId)}/revoke`, { body: {}, schema: readSchema, idempotencyKey }).then((answer) => answer.tracking)
}
