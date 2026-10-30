import { z } from 'zod'
import { DELIVERY_STATES } from '@nexus/factory-domain/email-delivery/rules'
import { OUTBOUND_STATUSES, SUPPRESSION_REASONS } from '@nexus/factory-domain/email/rules'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'

/**
 * The calls of the delivery log and the blocked addresses (B-W2a-41; PLT-149; SCR-087 "Delivery log and blocked
 * addresses"), each answer checked against its shape. Mirrors apps/factory-api platform/email-out/delivery/contract.ts.
 * Never a body, a subject or a link: what a mail is about is its record; addresses arrive masked unless the reader manages
 * that company's mail (`fullAddresses`). Only the container (use-delivery.ts) calls these.
 */

export { DELIVERY_STATES, OUTBOUND_STATUSES, SUPPRESSION_REASONS }
export type DeliveryState = (typeof DELIVERY_STATES)[number]
export type OutboundStatus = (typeof OUTBOUND_STATUSES)[number]
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number]

export const DELIVERY_KINDS = ['RECORD', 'SIGN_IN', 'DIGEST'] as const
export type DeliveryKind = (typeof DELIVERY_KINDS)[number]

const recordRef = z.object({ type: z.string(), id: z.string(), label: z.string().nullable() })
export type DeliveryRecord = z.infer<typeof recordRef>

export const deliveryMailSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  kind: z.enum(DELIVERY_KINDS),
  templateKey: z.string(),
  record: recordRef.nullable(),
  to: z.array(z.string()),
  recipients: z.number(),
  fullAddresses: z.boolean(),
  state: z.enum(DELIVERY_STATES),
  status: z.enum(OUTBOUND_STATUSES),
  at: z.string(),
  queuedAt: z.string(),
  attempts: z.number(),
  problem: z.string().nullable(),
  link: z.string().nullable(),
  notifications: z.number().nullable(),
})
/** One mail the factory sent, where it is. */
export type DeliveryMail = z.infer<typeof deliveryMailSchema>

const counts = z.object(Object.fromEntries(DELIVERY_STATES.map((state) => [state, z.number()])) as Record<DeliveryState, z.ZodNumber>)
export type DeliveryCounts = z.infer<typeof counts>

const deliveryPage = z.object({ mails: z.array(deliveryMailSchema), nextBefore: z.string().nullable(), counts, blocked: z.number() })
export type DeliveryPage = z.infer<typeof deliveryPage>

export const blockedAddressSchema = z.object({
  id: z.string(),
  address: z.string(),
  fullAddress: z.boolean(),
  reason: z.enum(SUPPRESSION_REASONS),
  detail: z.string().nullable(),
  at: z.string(),
  mail: z.object({ id: z.string(), companyId: z.string(), record: recordRef.nullable() }).nullable(),
  unblocked: z.object({ at: z.string(), byId: z.string().nullable(), reason: z.string().nullable() }).nullable(),
  version: z.number(),
})
/** An address no mail goes to (or, unblocked, the record that one did). */
export type BlockedAddress = z.infer<typeof blockedAddressSchema>

const blockedPage = z.object({ addresses: z.array(blockedAddressSchema), nextBefore: z.string().nullable(), canUnblock: z.boolean() })
export type BlockedPage = z.infer<typeof blockedPage>

export interface DeliveryQuery {
  state?: DeliveryState | null
  about?: 'INVOICES' | 'LINKS' | null
  before?: string | null
  limit?: number
}

/** GET /email/delivery (email.delivery.view): newest first, 50 a page, with the counts per state over 30 days. */
export const listDelivery = (api: ApiClient, query: DeliveryQuery = {}): Promise<DeliveryPage> =>
  api.get('/email/delivery', { query: { state: query.state ?? undefined, about: query.about ?? undefined, before: query.before ?? undefined, limit: query.limit ?? 50 }, schema: deliveryPage })

/** GET /email/blocked (email.delivery.view): the addresses blocked now, or the unblocked ones. */
export const listBlocked = (api: ApiClient, query: { state?: 'BLOCKED' | 'UNBLOCKED'; before?: string | null; limit?: number } = {}): Promise<BlockedPage> =>
  api.get('/email/blocked', { query: { state: query.state ?? undefined, before: query.before ?? undefined, limit: query.limit ?? 50 }, schema: blockedPage })

/** POST /email/blocked/:id/unblock (email.delivery.unblock over every company): with the version read and the reason. */
export const unblockAddress = (api: ApiClient, suppressionId: string, body: { version: number; reason: string }): Promise<BlockedAddress> =>
  api
    .post(`/email/blocked/${encodeURIComponent(suppressionId)}/unblock`, { body, idempotencyKey: newIdempotencyKey(), schema: z.object({ address: blockedAddressSchema }) })
    .then((answer) => answer.address)
