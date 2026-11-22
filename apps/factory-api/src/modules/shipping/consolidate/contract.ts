import { z } from 'zod'
import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { JOIN_PROBLEM_CODES } from '@nexus/factory-domain/shipping/shipments'
import { SPLIT_LIMITS, SPLIT_REASONS } from '@nexus/factory-domain/shipping/split/split'
import { shipmentSchema } from '../views'

/**
 * Consolidate and split from the order's Shipments tab and Warehouse's record (B-OS-011 … B-OS-013; X1). A refusal is a 409
 * whose issue path names its code (`refusal/<CODE>`: factory-domain shipping/split MOVE_REFUSALS and TAKE_OFF_REFUSALS, or a
 * join reason of the target `refusal/JOIN_<CODE>`); garments that cannot move are a 400 per line. Every write sends the
 * version of each shipment it touches (COL-078). No money.
 */

const version = z.number().int().min(1).optional()
const shipmentParams = input({ shipmentId: id() })
/** The reason of a hand change: 3 to 500 characters (office words, never shown to the customer). */
const reason = z.string().trim().min(3).max(500)
const moved = output({ lines: z.number().int(), garments: z.number().int(), merged: z.boolean() })

export const moveTargetsContract = defineContract({
  params: shipmentParams,
  response: {
    200: output({
      shipmentId: id(),
      number: z.string(),
      version: z.number().int(),
      /** The other DRAFTs of the same customer, company and site (at most 50), by number. */
      targets: z.array(
        output({
          id: id(),
          number: z.string(),
          /** The orders it carries, the first (the one it was made for) first. */
          orders: z.array(output({ id: id(), number: z.string() })),
          garments: z.number().int(),
          /** For each order of the source: may its garments join this target (an order it carries already: yes), and why not. */
          verdicts: z.array(output({ orderId: id(), allowed: z.boolean(), code: z.enum(JOIN_PROBLEM_CODES).nullable(), why: z.string().nullable() })),
        }),
      ),
    }),
  },
})

export const moveContract = defineContract({
  params: shipmentParams,
  body: input({
    /** This shipment's version, and the target's. */
    version,
    toShipmentId: id(),
    toVersion: version,
    lines: z.array(input({ lineId: id(), quantity: z.number().int().min(1).max(100_000) })).min(1).max(SPLIT_LIMITS.lines),
    reason: z.enum(SPLIT_REASONS),
    /** The office's words beside the reason (optional; never shown to the customer). */
    words: z.string().trim().max(500).nullish(),
  }),
  /** `shipment` is the target, `from` this one. */
  response: { 200: output({ shipment: shipmentSchema, from: shipmentSchema, moved }) },
})

export const mergeContract = defineContract({
  params: shipmentParams,
  body: input({ version, intoShipmentId: id(), intoVersion: version, words: z.string().trim().max(500).nullish() }),
  /** `shipment` is the target, `from` this one (CANCELLED "Merged into …"). */
  response: { 200: output({ shipment: shipmentSchema, from: shipmentSchema, moved }) },
})

export const takeOffContract = defineContract({
  params: input({ shipmentId: id(), salesOrderId: id() }),
  body: input({ version, reason }),
  response: { 200: output({ shipment: shipmentSchema, takenOff: output({ salesOrderId: id(), lines: z.number().int(), garments: z.number().int() }) }) },
})
