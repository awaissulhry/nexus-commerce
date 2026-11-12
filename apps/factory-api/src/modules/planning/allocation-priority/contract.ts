import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { ALLOCATIONS } from '@nexus/factory-domain/planning/allocation-priority/rank'
import { UOMS } from '@nexus/factory-domain/product/units/units'

/**
 * Scarce material by the backlog's priority (B-W2b-318; PLN-088, SCM-207; "this suit first"): GET /planning/allocation-priority,
 * read with planning.view over the site, from the site's plan computed now (the same netting as a run): every material
 * the orders need more of than stock and purchase orders bring, with who gets what in the order it was shared out — by
 * the orders' backlog rank (SalesOrder.backlogRank, PLN-177) when one is ranked, else by the day each needs it. A rank
 * changed (B-W2b-317's backlog) shows at the next read: nothing is stored here. Quantities in the material's base unit;
 * orders by their numbers (no customer), no money.
 */

const ref = output({ id: id(), code: z.string(), name: z.string() })
const siteView = output({ id: id(), companyId: id(), code: z.string(), name: z.string(), timeZone: z.string() })

export const allocationPriorityContract = defineContract({
  querystring: input({
    siteId: id(),
    itemId: id().optional(),
    /** With itemId: the colour; `none`: the material without colours. */
    itemColourId: z.union([id(), z.literal('none')]).optional(),
    /** true (default): the scarce materials only (short now); false: every material the plan nets. */
    scarceOnly: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
  }),
  response: {
    200: output({
      site: siteView,
      asOf: instant(),
      today: businessDate(),
      tiles: output({ scarce: z.number().int(), byPriority: z.number().int(), rankedOrders: z.number().int() }),
      materials: z.array(
        output({
          item: output({ id: id(), code: z.string(), name: z.string(), kind: z.string(), baseUom: z.enum(UOMS) }),
          colour: ref.nullable(),
          /** The latest DONE run's line (null: the run has none for it). */
          requirementId: id().nullable(),
          allocation: z.enum(ALLOCATIONS),
          /** At least one of its orders is ranked. */
          ranked: z.boolean(),
          gross: z.string(),
          usable: z.string(),
          onOrder: z.string(),
          net: z.string(),
          uncovered: z.string(),
          /** In the order the material was shared out. */
          parts: z.array(
            output({
              order: output({ id: id(), number: z.string(), rank: z.number().int().nullable() }),
              orderLine: output({ id: id(), seq: z.number().int() }),
              size: z.string().nullable(),
              workOrder: output({ id: id(), number: z.string() }).nullable(),
              day: businessDate(),
              need: z.string(),
              gets: output({ issued: z.string(), reserved: z.string(), stock: z.string(), purchaseOrders: z.string(), firm: z.string() }),
              short: z.string(),
              words: z.string(),
            }),
          ),
          words: z.string(),
        }),
      ),
    }),
  },
})
export type AllocationQuery = z.infer<typeof allocationPriorityContract.querystring>
