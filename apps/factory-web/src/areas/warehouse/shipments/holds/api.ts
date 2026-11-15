import { z } from 'zod'
import { HOLD_REFUSALS, SHIPMENT_HOLD_REASONS } from '@nexus/factory-domain/shipping/holds/holds'
import { SHIPMENT_STATUSES } from '@nexus/factory-domain/shipping/shipments'
import type { ApiClient } from '../../../../lib/api/client'

/**
 * A shipment's holds (B-W2b-386; LOG-017, FIN-079; apps/factory-api modules/shipping/holds): those in force and released,
 * who may release each, the reasons a person may place; place one, release one with the words why, hold many from the
 * list's selection. The API's English `reasonWords` and `words` of a choice are not drawn: the screen says the codes.
 */

const reason = z.enum(SHIPMENT_HOLD_REASONS)

const holdSchema = z.object({
  id: z.string(),
  reason,
  words: z.string().nullable(),
  inForce: z.boolean(),
  bySystem: z.boolean(),
  placedAt: z.string(),
  placedBy: z.string().nullable(),
  releasedAt: z.string().nullable(),
  releasedBySystem: z.boolean(),
  releasedBy: z.string().nullable(),
  releaseWords: z.string().nullable(),
  version: z.number(),
  mayRelease: z.boolean(),
})
export type Hold = z.infer<typeof holdSchema>

export const holdsSchema = z.object({
  shipmentId: z.string(),
  number: z.string(),
  status: z.enum(SHIPMENT_STATUSES),
  held: z.boolean(),
  reasons: z.array(reason),
  holds: z.array(holdSchema),
  mayPlace: z.boolean(),
  reasonChoices: z.array(z.object({ reason, wordsRequired: z.boolean(), releasedBy: z.string() })),
})
export type Holds = z.infer<typeof holdsSchema>
export type HoldReason = Holds['reasons'][number]

const base = (shipmentId: string) => `/shipping/shipments/${encodeURIComponent(shipmentId)}/holds`

export const readHolds = (api: ApiClient, shipmentId: string): Promise<Holds> => api.get(base(shipmentId), { schema: z.object({ holds: holdsSchema }) }).then((answer) => answer.holds)

export function placeHold(api: ApiClient, shipmentId: string, body: { reason: HoldReason; words: string | null }, idempotencyKey: string): Promise<Holds> {
  return api.post(base(shipmentId), { body, schema: z.object({ holdId: z.string(), holds: holdsSchema }), idempotencyKey }).then((answer) => answer.holds)
}

export function releaseHold(api: ApiClient, shipmentId: string, holdId: string, wordsWhy: string, idempotencyKey: string): Promise<Holds> {
  return api.post(`${base(shipmentId)}/${encodeURIComponent(holdId)}/release`, { body: { words: wordsWhy }, schema: z.object({ holds: holdsSchema }), idempotencyKey }).then((answer) => answer.holds)
}

const placedSchema = z.object({
  placed: z.array(z.object({ shipmentId: z.string(), number: z.string(), holdId: z.string() })),
  skipped: z.array(z.object({ shipmentId: z.string(), number: z.string(), code: z.enum(HOLD_REFUSALS) })),
})
export type Placed = z.infer<typeof placedSchema>

/** The list's selection "Hold": ONE command for every shipment picked (those already held or gone are skipped, said why). */
export function placeHolds(api: ApiClient, body: { shipmentIds: string[]; reason: HoldReason; words: string | null }, idempotencyKey: string): Promise<Placed> {
  return api.post('/shipping/holds', { body, schema: placedSchema, idempotencyKey })
}
