import { z } from 'zod'
import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { MINIMUM_BASES } from '@nexus/factory-domain/inventory/low-stock/rules'
import { UOMS } from '@nexus/factory-domain/product/units/units'

/**
 * Below the minimum (B-W2b-314; SCM-281; design warehouse.stock st-metrics "Below minimum (W2b)"): the tile's count and the
 * list behind it, per site. Office, inventory.stock.view at the site; read only. Quantities in the material's base unit.
 */

const named = output({ id: id(), code: z.string(), name: z.string() })
const source = z.enum(['COMPANY', 'TENANT', 'DEFAULT'])

export const lowStockRow = output({
  site: named,
  item: output({ id: id(), code: z.string(), name: z.string(), kind: z.string(), baseUom: z.enum(UOMS) }),
  /** The colour the site keeps its own minimum for; null: every colour of the material together. */
  colour: named.nullable(),
  /** The planning parameters it comes from (POST|PATCH /planning/item-parameters keeps them). */
  itemPlanningId: id(),
  basis: z.enum(MINIMUM_BASES),
  minimum: z.string(),
  onHand: z.string(),
  onOrder: z.string(),
  reserved: z.string(),
  /** on hand + on order − reserved. */
  position: z.string(),
  below: z.boolean(),
  /** What is missing to reach the minimum (0 when not below). */
  short: z.string(),
  words: output({ en: z.string(), it: z.string() }),
})

export const lowStockContract = defineContract({
  querystring: input({
    siteId: id(),
    /** Default true: only what is below its minimum (the tile); false: every material with a minimum. */
    below: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
    /** Material code or name. */
    q: z.string().trim().min(1).max(80).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(200),
  }),
  response: {
    200: output({
      /** The tile: how many materials (and colours) are below their minimum at the site. */
      count: z.number().int().min(0),
      rows: z.array(lowStockRow),
      /** More rows than `limit` matched. */
      more: z.boolean(),
      /** Whether the site's company raises low-stock alerts (the warehouse rules), and from where. */
      alerts: output({ on: z.boolean(), source }),
    }),
  },
})
