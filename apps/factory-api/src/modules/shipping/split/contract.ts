import { z } from 'zod'
import { businessDate, defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { SPLIT_LIMITS, SPLIT_REASONS, SPLIT_RULES } from '@nexus/factory-domain/shipping/split/split'
import { shipmentSchema, statusSchema, transportBySchema } from '../views'

/**
 * Split one order into several shipments (B-W2b-386; LOG-005). A refusal is a 409 whose issue path names its code
 * (`refusal/<CODE>`, factory-domain shipping/split SPLIT_REFUSALS); garments that cannot move are a 400 per line.
 */

const version = z.number().int().min(1).optional()
const move = output({ lineId: id(), quantity: z.number().int() })
const shipmentParams = input({ shipmentId: id() })

export const splitPreviewContract = defineContract({
  params: shipmentParams,
  response: {
    200: output({
      shipmentId: id(),
      number: z.string(),
      status: statusSchema,
      version: z.number().int(),
      splittable: z.boolean(),
      held: z.boolean(),
      lines: z.array(
        output({
          id: id(),
          label: z.string(),
          workOrderSizeId: id(),
          size: z.string(),
          quantity: z.number().int(),
          /** Garments scanned into a carton (they stay). */
          packed: z.number().int(),
          /** Serials the line holds (they stay). */
          serials: z.number().int(),
          movable: z.number().int(),
          shipBy: businessDate().nullable(),
        }),
      ),
      reasons: z.array(z.enum(SPLIT_REASONS)),
      rules: z.array(
        output({
          rule: z.enum(SPLIT_RULES),
          /** The day the shipment keeps (null: no promise known). */
          stays: businessDate().nullable(),
          shipments: z.array(output({ shipBy: businessDate(), garments: z.number().int(), lines: z.array(move) })),
          kept: z.array(output({ lineId: id(), garments: z.number().int() })),
        }),
      ),
      mayManage: z.boolean(),
    }),
  },
})

// ── B-OS-010 (order shipments tab; X1 S1): one new shipment's garments and delivery (default: the one it is split from) ──
const asks = z.array(input({ lineId: id(), quantity: z.number().int().min(1).max(100_000) })).min(1).max(SPLIT_LIMITS.lines)
const delivery = {
  /** The new shipment's delivery; default the one it is split from (a new carrier drops the service). */
  transportBy: transportBySchema.optional(),
  carrierCode: z.string().trim().max(40).nullish(),
  serviceCode: z.string().trim().max(100).nullish(),
  shipToAddressId: id().optional(),
}
// ── end B-OS-010 ──

export const splitContract = defineContract({
  params: shipmentParams,
  body: input({
    version,
    // B-OS-010: `reason` + `lines` (one new shipment, as before) — or `groups`, several new shipments in one go (never both).
    reason: z.enum(SPLIT_REASONS).optional(),
    lines: asks.optional(),
    ...delivery,
    /** B-OS-010: 1 to 20 new shipments, each with its reason, garments and delivery; a line may give to several (never more than can move). */
    groups: z.array(input({ reason: z.enum(SPLIT_REASONS), lines: asks, ...delivery })).min(1).max(SPLIT_LIMITS.shipments).optional(),
  }),
  // B-OS-010: + `shipments`, every new shipment (`shipment` stays the first one).
  response: { 201: output({ shipment: shipmentSchema, from: shipmentSchema, shipments: z.array(shipmentSchema) }) },
})

export const splitByRuleContract = defineContract({
  params: shipmentParams,
  body: input({ version, rule: z.enum(SPLIT_RULES) }),
  response: { 201: output({ shipments: z.array(shipmentSchema), from: shipmentSchema }) },
})
