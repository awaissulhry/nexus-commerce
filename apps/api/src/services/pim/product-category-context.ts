import prisma from '../../db.js'
import type { SheetChannel } from './sheet-columns.service.js'
import { categoryForListing, resolveCategoriesForProducts, type ResolvedCategory } from './mapping/category-mapping.service.js'
import { resolveChannelConnectionId } from '../connection-resolver.service.js'

/** Taxonomy defaults plus explicit listing assignments, shared by reads and writes. */
export async function productCategoryContext(productIds: string[], channel: string, marketplace: string, accountId?: string | null) {
  const connectionId = await resolveChannelConnectionId(channel, accountId)
  const [defaults, listings] = await Promise.all([
    resolveCategoriesForProducts({ productIds, channel, marketplace }),
    prisma.channelListing.findMany({
      where: { productId: { in: productIds }, channel: channel as SheetChannel, marketplace, channelConnectionId: connectionId ?? null },
      select: { productId: true, aliasId: true, platformAttributes: true },
    }),
  ])
  const byRow = new Map<string, ResolvedCategory>()
  for (const id of productIds) {
    const category = categoryForListing(defaults[id], channel, null)
    byRow.set(`${id}:`, category)
  }
  for (const listing of listings) {
    const category = categoryForListing(defaults[listing.productId], channel, listing.platformAttributes)
    byRow.set(`${listing.productId}:${listing.aliasId ?? ''}`, category)
  }
  const categories = new Set([...byRow.values()].map(c => c.channelCategoryId).filter((id): id is string => !!id))
  return { categories: [...categories].sort(), byRow, defaults, connectionId: connectionId ?? null }
}
