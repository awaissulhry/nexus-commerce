// PH.3 — resolver composition.
//
// Each facet owns its own file and its own Product.* fields; they are merged
// here rather than written into one object, so a facet moving to its own
// service later is a file move rather than an untangling.

import { productResolvers } from './product.js'
import { inventoryResolvers } from './inventory.js'
import { channelResolvers } from './channels.js'

export const resolvers = {
  Query: { ...productResolvers.Query },
  Product: {
    ...productResolvers.Product,
    ...inventoryResolvers.Product,
    ...channelResolvers.Product,
  },
  StockAtLocation: { ...inventoryResolvers.StockAtLocation },
}
