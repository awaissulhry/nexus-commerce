import { z } from 'zod'
import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { ITEM_TRACKINGS } from '@nexus/factory-domain/inventory/ledger/moves'

/** Finished goods on hand (B-W2a-12; GAP-003): whole garments per SKU, place and batch. No cost anywhere. */
export const listFinishedContract = defineContract({
  querystring: input({
    siteId: id().optional(),
    styleId: id().optional(),
    /** Only the SKUs this work order put into stock (net of reversals). */
    workOrderId: id().optional(),
    q: z.string().trim().min(1).max(60).optional(),
  }),
  response: {
    200: output({
      items: z.array(
        output({
          itemId: id(),
          sku: z.string(),
          name: z.string(),
          tracking: z.enum(ITEM_TRACKINGS),
          styleId: id().nullable(),
          styleCode: z.string(),
          colourwayCode: z.string(),
          colourwayName: z.string(),
          size: z.string(),
          /** On hand over the places the caller may see (every move of the ledger). */
          onHand: z.number().int(),
          places: z.array(output({ siteId: id(), siteCode: z.string(), locationId: id(), locationCode: z.string(), onHand: z.number().int() })),
          /** The work orders (batches) it came in from: receipts less their reversals. */
          workOrders: z.array(output({ workOrderId: id(), number: z.string(), batchNumber: z.string().nullable(), received: z.number().int() })),
        }),
      ),
    }),
  },
})
