import { z } from 'zod'
import { BRAND_URGENCIES, URGENCY_ACTORS, URGENCY_OUTCOMES } from '@nexus/factory-domain/production-brand/urgency'
import type { ApiClient } from '../../../lib/api/client'

/**
 * F-CW-302 (customer Work tab plan §4; 13-backend §8; lead settles S7, S14, S35) — the customer's urgency as we steer it, its read and
 * its writes: MOVED here as they are from the work order's Customer card (F-PR-05b), because a second screen now sets an order back,
 * locks and unlocks it (the ONE Orders sheet: its row ⋯ and More ▾). One path per job: the card and the sheet call these.
 *
 *   urgency     GET /production/brands/:partyId/urgency (B-PR-22b; workorders.view): its switch, quota and open orders' marks
 *               POST /production/brand-orders/urgency/regular {orderIds, reason, lock} and …/unlock {orderIds}
 *               (production.brand.override, a fresh code, no second person: it is our own plan)
 *
 * Each answer's shape is checked (unknown fields dropped). The brand wall is the API's: an order the reader does not reach is
 * answered as unknown and only counted.
 */

const words = z.object({ it: z.string(), en: z.string() })
const person = z.object({ id: z.string(), name: z.string() })

// ---- the customer's urgency as we steer it (B-PR-22b) ---------------------------------------------------------------------------

const urgencyOrderSchema = z.object({
  id: z.string(),
  number: z.string(),
  customerRef: z.string().nullable(),
  status: z.string(),
  orderDate: z.string(),
  urgency: z.enum(BRAND_URGENCIES),
  /** It counts in our plan now (Urgent while the customer's switch is on). */
  counted: z.boolean(),
  urgentRank: z.number().nullable(),
  setBy: z.enum(URGENCY_ACTORS).nullable(),
  setAt: z.string().nullable(),
  setByPerson: person.nullable(),
  locked: z.boolean(),
  lockReason: z.string().nullable(),
  lockedAt: z.string().nullable(),
  lockedBy: person.nullable(),
  words,
})
export type UrgencyOrder = z.infer<typeof urgencyOrderSchema>

export const customerUrgencySchema = z.object({
  asOf: z.string(),
  customer: z.object({ id: z.string(), code: z.string(), name: z.string() }),
  urgency: z.object({ on: z.boolean(), max: z.number(), dormant: words.nullable() }),
  companies: z.array(
    z.object({
      company: z.object({ id: z.string(), code: z.string(), name: z.string() }),
      use: z.object({ used: z.number(), max: z.number(), agreed: z.number(), left: z.number(), over: z.boolean(), words }),
      mayOverride: z.boolean(),
      orders: z.array(urgencyOrderSchema),
    }),
  ),
})
export type CustomerUrgency = z.infer<typeof customerUrgencySchema>

export async function getCustomerUrgency(api: ApiClient, partyId: string, signal?: AbortSignal): Promise<CustomerUrgency> {
  return api.get(`/production/brands/${encodeURIComponent(partyId)}/urgency`, { schema: customerUrgencySchema, signal })
}

export const urgencyAnswerSchema = z.object({
  results: z.array(
    z.object({
      orderId: z.string(),
      number: z.string(),
      customerRef: z.string().nullable(),
      outcome: z.enum(URGENCY_OUTCOMES),
      done: z.boolean(),
      words: words.nullable(),
      urgency: z.enum(BRAND_URGENCIES).nullable(),
    }),
  ),
  notFound: z.number(),
  replayed: z.boolean(),
})
export type UrgencyAnswer = z.infer<typeof urgencyAnswerSchema>

/** Back to Regular (and locked, with the reason the customer reads): production.brand.override, a fresh code. */
export function setBackUrgency(api: ApiClient, body: { readonly orderIds: readonly string[]; readonly reason: string; readonly lock: boolean }, idempotencyKey: string): Promise<UrgencyAnswer> {
  return api.post('/production/brand-orders/urgency/regular', { body: { orderIds: [...body.orderIds], reason: body.reason, lock: body.lock }, schema: urgencyAnswerSchema, idempotencyKey })
}

/** Unlocked (the customer may mark it Urgent again): production.brand.override, a fresh code. */
export function unlockUrgency(api: ApiClient, body: { readonly orderIds: readonly string[] }, idempotencyKey: string): Promise<UrgencyAnswer> {
  return api.post('/production/brand-orders/urgency/unlock', { body: { orderIds: [...body.orderIds] }, schema: urgencyAnswerSchema, idempotencyKey })
}
