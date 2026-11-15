import { z } from 'zod'
import { SHIPMENT_STATUSES } from '@nexus/factory-domain/shipping/shipments'
import { SPLIT_REASONS, SPLIT_RULES } from '@nexus/factory-domain/shipping/split/split'
import type { ApiClient } from '../../../../../lib/api/client'

/**
 * Split a shipment (B-W2b-386; LOG-005; `GET|POST /shipping/shipments/:id/split`, `POST …/split-by-rule`): what may move
 * (garments not in a carton and without a serial), the rule's proposal (garments promised for different days leave apart),
 * and the split itself as ONE command on the shipment's version. The answers' full shipments are read only for their
 * number (the record reads itself again).
 */

const move = z.object({ lineId: z.string(), quantity: z.number() })

export const splitPreviewSchema = z.object({
  shipmentId: z.string(),
  number: z.string(),
  status: z.enum(SHIPMENT_STATUSES),
  version: z.number(),
  splittable: z.boolean(),
  held: z.boolean(),
  lines: z.array(z.object({ id: z.string(), label: z.string(), size: z.string(), quantity: z.number(), packed: z.number(), serials: z.number(), movable: z.number(), shipBy: z.string().nullable() })),
  reasons: z.array(z.enum(SPLIT_REASONS)),
  rules: z.array(z.object({ rule: z.enum(SPLIT_RULES), stays: z.string().nullable(), shipments: z.array(z.object({ shipBy: z.string(), garments: z.number(), lines: z.array(move) })), kept: z.array(z.object({ lineId: z.string(), garments: z.number() })) })),
  mayManage: z.boolean(),
})
export type SplitPreview = z.infer<typeof splitPreviewSchema>
export type SplitReason = SplitPreview['reasons'][number]

const made = z.object({ id: z.string(), number: z.string() })

const base = (shipmentId: string) => `/shipping/shipments/${encodeURIComponent(shipmentId)}`

export const readSplit = (api: ApiClient, shipmentId: string): Promise<SplitPreview> => api.get(`${base(shipmentId)}/split`, { schema: splitPreviewSchema })

export interface SplitBody {
  version: number
  reason: SplitReason
  lines: { lineId: string; quantity: number }[]
  transportBy?: 'CARRIER' | 'SENDER' | 'RECIPIENT'
  carrierCode?: string | null
  serviceCode?: string | null
}

export function splitByHand(api: ApiClient, shipmentId: string, body: SplitBody, idempotencyKey: string): Promise<{ id: string; number: string }[]> {
  return api.post(`${base(shipmentId)}/split`, { body, schema: z.object({ shipment: made }), idempotencyKey }).then((answer) => [answer.shipment])
}

export function splitByRule(api: ApiClient, shipmentId: string, version: number, idempotencyKey: string): Promise<{ id: string; number: string }[]> {
  return api.post(`${base(shipmentId)}/split-by-rule`, { body: { version, rule: 'PROMISE_DATE' }, schema: z.object({ shipments: z.array(made) }), idempotencyKey }).then((answer) => answer.shipments)
}
