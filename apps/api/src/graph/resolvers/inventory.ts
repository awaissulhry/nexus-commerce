// PH.3 — inventory facet.
//
// poolTotal is recomputed from the location rows rather than read from
// Product.totalStock, and deliberately: totalStock is a CACHE of exactly this
// sum, and a graph that reports the cache cannot show you when the cache is
// wrong. Summing WAREHOUSE rows here matches recomputeProductTotalStock's
// definition — FBA and channel-mirror locations are not stock we can promise.

import type { GraphContext, ProductSource } from '../types.js'
import type { StockRow } from '../loaders.js'

const POOL_LOCATION_TYPE = 'WAREHOUSE'

export const inventoryResolvers = {
  Product: {
    async inventory(p: ProductSource, _args: unknown, ctx: GraphContext) {
      const rows = await ctx.loaders.stockByProduct.load(p.id)
      const pool = rows.filter((r) => r.type === POOL_LOCATION_TYPE)
      return {
        poolTotal: pool.reduce((sum, r) => sum + r.quantity, 0),
        reservedTotal: pool.reduce((sum, r) => sum + r.reserved, 0),
        availableTotal: pool.reduce((sum, r) => sum + r.available, 0),
        // Every location, including FBA — excluded from the pool totals but
        // still shown, because hiding them would make the numbers look wrong
        // to anyone who knows the stock is there.
        locations: rows,
      }
    },
  },

  StockAtLocation: {
    locationId: (r: StockRow) => r.locationId,
    code: (r: StockRow) => r.code,
    type: (r: StockRow) => r.type,
  },
}
