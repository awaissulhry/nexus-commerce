import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { HOLD_LIMITS, HOLD_REFUSALS, SHIPMENT_HOLD_REASONS } from '@nexus/factory-domain/shipping/holds/holds'
import { statusSchema } from '../views'

/**
 * Shipment holds (B-W2b-386; LOG-017, FIN-079; design warehouse.shipments selection row "Hold", the ready check "no hold").
 * No money. A refusal is a 409 whose issue path names its code (`refusal/<CODE>`, factory-domain shipping/holds
 * HOLD_REFUSALS); a request that misses its words is a 400.
 */

const reason = z.enum(SHIPMENT_HOLD_REASONS)
const words = z.string().max(HOLD_LIMITS.words + 200)

const holdSchema = output({
  id: id(),
  reason,
  reasonWords: z.string(),
  words: z.string().nullable(),
  inForce: z.boolean(),
  /** Placed by the system (the balance before shipping, the account on hold, over the credit limit). */
  bySystem: z.boolean(),
  placedAt: instant(),
  /** The person's name (null: the system), shown inside this one shipment only. */
  placedBy: z.string().nullable(),
  releasedAt: instant().nullable(),
  releasedBySystem: z.boolean(),
  releasedBy: z.string().nullable(),
  releaseWords: z.string().nullable(),
  version: z.number().int(),
  /** The reader may release it (its kind's permission: a money hold or the system's needs shipping.holds.release). */
  mayRelease: z.boolean(),
})

export const holdsSchema = output({
  shipmentId: id(),
  number: z.string(),
  status: statusSchema,
  /** A hold is in force: the ready check's "no hold" fails. */
  held: z.boolean(),
  reasons: z.array(reason),
  /** Those in force first, then the released ones (newest first). */
  holds: z.array(holdSchema),
  mayPlace: z.boolean(),
  reasonChoices: z.array(output({ reason, words: z.string(), wordsRequired: z.boolean(), releasedBy: z.string() })),
})

const shipmentParams = input({ shipmentId: id() })

export const getHoldsContract = defineContract({ params: shipmentParams, response: { 200: output({ holds: holdsSchema }) } })

export const placeHoldContract = defineContract({
  params: shipmentParams,
  body: input({ reason, words: words.nullish() }),
  response: { 201: output({ holdId: id(), holds: holdsSchema }) },
})

export const releaseHoldContract = defineContract({
  params: input({ shipmentId: id(), holdId: id() }),
  body: input({ words }),
  response: { 200: output({ holds: holdsSchema }) },
})

export const placeHoldsContract = defineContract({
  body: input({ shipmentIds: z.array(id()).min(1).max(HOLD_LIMITS.bulk), reason, words: words.nullish() }),
  response: {
    201: output({
      placed: z.array(output({ shipmentId: id(), number: z.string(), holdId: id() })),
      /** Left as they were: already held for that reason, or no longer open. */
      skipped: z.array(output({ shipmentId: id(), number: z.string(), code: z.enum(HOLD_REFUSALS), message: z.string() })),
    }),
  },
})

export const listHoldsContract = defineContract({
  querystring: input({
    siteId: id().optional(),
    reason: reason.optional(),
    /** IN_FORCE (default): held shipments that have not left; RELEASED; ALL. */
    state: z.enum(['IN_FORCE', 'RELEASED', 'ALL']).optional(),
    /** Only the system's (true) or only the people's (false). */
    bySystem: z.enum(['true', 'false']).optional(),
    cursor: id().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
  response: {
    200: output({
      holds: z.array(
        output({
          id: id(),
          reason,
          inForce: z.boolean(),
          bySystem: z.boolean(),
          placedAt: instant(),
          releasedAt: instant().nullable(),
          mayRelease: z.boolean(),
          shipment: output({
            id: id(),
            number: z.string(),
            status: statusSchema,
            siteId: id(),
            salesOrderId: id(),
            salesOrderNumber: z.string(),
            customerRef: z.string().nullable(),
            partyCode: z.string(),
            partyName: z.string(),
          }),
        }),
      ),
      nextCursor: id().nullable(),
    }),
  },
})
