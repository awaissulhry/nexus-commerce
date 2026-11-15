import { z } from 'zod'
import type { ApiClient } from '../../../../lib/api/client'
import { PICKUP_REFUSALS, PICKUP_STATUSES, PICKUP_VIAS, WEEKDAYS } from './model'

/**
 * Carrier pickups (B-W2b-412 on B-W2b-395's API; apps/factory-api modules/shipping/pickups): what comes to a site on a day,
 * the Book a pickup pop-up's start from the selected shipments, the booking, and a pickup's moves (confirmed by hand, failed
 * with why, called off). The API's English words (`words`, `message`, `errorWords`) are dropped by the schemas where a code
 * says the same; `errorWords` and `skipped[].words` are the carrier's or the API's own facts with no code, drawn as they are.
 * No money; no person in a row.
 */

const allowance = z.object({ allowed: z.boolean(), refusal: z.object({ code: z.enum(PICKUP_REFUSALS) }).nullable() })

export const pickupRowSchema = z.object({
  id: z.string(),
  siteId: z.string(),
  site: z.object({ code: z.string(), name: z.string() }),
  carrierCode: z.string(),
  carrierName: z.string(),
  readyAt: z.string(),
  /** The ready time on the site's clock (on a day asked for, that day's). */
  readyTime: z.string(),
  parcels: z.number(),
  pallets: z.number(),
  repeatWeekdays: z.array(z.enum(WEEKDAYS)),
  recurring: z.boolean(),
  status: z.enum(PICKUP_STATUSES),
  via: z.enum(PICKUP_VIAS),
  test: z.boolean(),
  providerReference: z.string().nullable(),
  /** Why it failed, as the carrier or the person said it (FAILED only). */
  errorWords: z.string().nullable(),
  /** A phone booking's note (with whom). */
  note: z.string().nullable(),
  version: z.number(),
  createdAt: z.string(),
  may: z.object({ confirm: allowance, fail: allowance, cancel: allowance }),
})
export type PickupRow = z.infer<typeof pickupRowSchema>

const listSchema = z.object({ pickups: z.array(pickupRowSchema), nextCursor: z.string().nullable() })

/** GET /shipping/pickups?siteId&day: what comes that day (one-offs, recurring rounds on their weekdays; a failure stays). */
export const pickupsOfDay = (api: ApiClient, siteId: string, day: string, signal?: AbortSignal): Promise<PickupRow[]> =>
  api.get('/shipping/pickups', { query: { siteId, day, limit: 200 }, schema: listSchema, signal }).then((answer) => answer.pickups)

const addressSchema = z.object({
  name: z.string().optional().default(''),
  line1: z.string().optional().default(''),
  line2: z.string().nullable().optional(),
  postalCode: z.string().optional().default(''),
  city: z.string().optional().default(''),
  province: z.string().nullable().optional(),
  country: z.string().optional().default(''),
  phone: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
})
export type PickupAddress = z.infer<typeof addressSchema>

export const draftSchema = z.object({
  siteId: z.string(),
  companyId: z.string(),
  site: z.object({ code: z.string(), name: z.string(), timeZone: z.string() }),
  /** The site's sender address (null: no shipping settings). */
  address: addressSchema.nullable(),
  carrierCode: z.string().nullable(),
  carrierName: z.string().nullable(),
  parcels: z.number(),
  pallets: z.number(),
  weightKg: z.string().nullable(),
  readyAt: z.string(),
  shipments: z.array(z.object({ id: z.string(), number: z.string(), parcels: z.number(), pallets: z.number() })),
  /** Selected shipments left out; `words` is the API's own sentence (the reason has no code). */
  skipped: z.array(z.object({ id: z.string(), number: z.string().nullable(), words: z.string() })),
  testMode: z.boolean(),
  vias: z.object({
    SENDCLOUD: allowance.extend({ test: z.boolean(), recurring: z.boolean() }),
    PHONE: allowance.extend({ recurring: z.boolean() }),
  }),
  alreadyToday: z.array(pickupRowSchema),
})
export type PickupDraft = z.infer<typeof draftSchema>

/** GET /shipping/pickups/draft: the pop-up's start from the site (and the selected shipments, the carrier asked). */
export function pickupDraft(api: ApiClient, query: { siteId: string; carrierCode?: string | null; shipmentIds?: readonly string[] }, signal?: AbortSignal): Promise<PickupDraft> {
  return api.get('/shipping/pickups/draft', {
    query: { siteId: query.siteId, carrierCode: query.carrierCode || undefined, shipmentIds: query.shipmentIds && query.shipmentIds.length > 0 ? query.shipmentIds.slice(0, 100).join(',') : undefined },
    schema: draftSchema,
    signal,
  })
}

export interface BookBody {
  siteId: string
  via: (typeof PICKUP_VIAS)[number]
  carrierCode: string
  readyAt: string
  parcels: number
  pallets: number
  address?: { name: string; line1: string; line2: string | null; postalCode: string; city: string; province: string | null; country: string; phone: string | null; email: string | null } | null
  repeatWeekdays?: string[]
  note?: string | null
  providerReference?: string | null
  weightKg?: string | null
}

const detailSchema = z.object({ pickup: pickupRowSchema, replayed: z.boolean() })

/** POST /shipping/pickups (shipping.pickups.book): 201 even when the carrier said no (status FAILED, its words). */
export const bookPickup = (api: ApiClient, body: BookBody, idempotencyKey: string): Promise<PickupRow> =>
  api.post('/shipping/pickups', { body, schema: detailSchema, idempotencyKey }).then((answer) => answer.pickup)

export interface MoveBody {
  version: number
  status: 'CONFIRMED' | 'FAILED' | 'CANCELLED'
  providerReference?: string | null
  words?: string | null
}

const moveSchema = z.object({ pickup: pickupRowSchema, carrier: z.object({ told: z.boolean() }).nullable() })

/** POST /shipping/pickups/:id/status: confirmed by hand, failed (why), called off; `carrier.told` false: call the carrier. */
export const movePickup = (api: ApiClient, pickupId: string, body: MoveBody, idempotencyKey: string): Promise<{ pickup: PickupRow; carrierTold: boolean | null }> =>
  api.post(`/shipping/pickups/${encodeURIComponent(pickupId)}/status`, { body, schema: moveSchema, idempotencyKey }).then((answer) => ({ pickup: answer.pickup, carrierTold: answer.carrier ? answer.carrier.told : null }))
