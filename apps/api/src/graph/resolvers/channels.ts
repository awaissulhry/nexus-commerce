// PH.3 — channel facet.

import type { GraphContext, ProductSource } from '../types.js'

export const channelResolvers = {
  Product: {
    channels: (p: ProductSource, _args: unknown, ctx: GraphContext) =>
      ctx.loaders.listingsByProduct.load(p.id),
  },
}
