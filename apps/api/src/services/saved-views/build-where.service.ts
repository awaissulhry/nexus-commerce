/**
 * H.8 — translate a SavedView.filters JSON into a Prisma where
 * clause that matches the /api/products GET endpoint.
 *
 * Two reasons to share this with /api/products instead of
 * duplicating: (a) the alert evaluator MUST use exactly the same
 * shape the user sees in the grid, otherwise alert counts drift
 * from on-screen reality. (b) it's a real piece of business logic
 * that deserves one home.
 *
 * Filter JSON shapes we accept (saved over time):
 *   canonical (parseFilters)  — { search, status, channel,
 *                                  marketplace, productTypes, brands,
 *                                  fulfillment, tags, stockLevel,
 *                                  hasPhotos }
 *   legacy CSV-list keys      — { statuses, channels, marketplaces,
 *                                  productTypes, brands, ... }
 *
 * Both fold to the same canonical arrays before building the where.
 *
 * Side effects: when `tags` is present we hit ProductTag to resolve
 * matching product ids — the where would otherwise need a relation
 * filter that Prisma can't express on a many-to-many through-table
 * without a composite expression. Cheap (indexed) but it does a DB
 * call, hence the async signature.
 */

import type { PrismaClient, Prisma } from '@prisma/client'

export interface SavedViewFiltersInput {
  search?: string
  // canonical singular keys
  status?: string[] | string
  channel?: string[] | string
  marketplace?: string[] | string
  // legacy plural keys
  statuses?: string[] | string
  channels?: string[] | string
  marketplaces?: string[] | string
  // shared
  productTypes?: string[] | string
  brands?: string[] | string
  tags?: string[] | string
  fulfillment?: string[] | string
  stockLevel?: string
  hasPhotos?: string | boolean
}

function asArray(v: unknown): string[] {
  if (v == null) return []
  if (Array.isArray(v)) {
    return v
      .filter((x): x is string => typeof x === 'string')
      .map((s) => s.trim())
      .filter(Boolean)
  }
  if (typeof v === 'string') {
    return v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  }
  return []
}

const upper = (a: string[]) => a.map((s) => s.toUpperCase())

export async function buildProductWhereFromSavedView(
  prisma: PrismaClient,
  filters: SavedViewFiltersInput | null | undefined,
): Promise<Prisma.ProductWhereInput> {
  const f = filters ?? {}
  const where: any = { parentId: null }

  const search = (f.search ?? '').trim()
  if (search) {
    where.OR = [
      { sku: { contains: search, mode: 'insensitive' } },
      { name: { contains: search, mode: 'insensitive' } },
      { brand: { contains: search, mode: 'insensitive' } },
      { gtin: { contains: search } },
    ]
  }

  const statusList = upper(asArray(f.status ?? f.statuses))
  if (statusList.length > 0) where.status = { in: statusList }

  const channelList = upper(asArray(f.channel ?? f.channels))
  if (channelList.length > 0) where.syncChannels = { hasSome: channelList }

  const productTypeList = asArray(f.productTypes)
  if (productTypeList.length > 0) where.productType = { in: productTypeList }

  const brandList = asArray(f.brands)
  if (brandList.length > 0) where.brand = { in: brandList }

  const fulfillmentList = upper(asArray(f.fulfillment))
  if (fulfillmentList.length > 0) {
    where.fulfillmentMethod = { in: fulfillmentList }
  }

  const marketplaceList = upper(asArray(f.marketplace ?? f.marketplaces))
  if (marketplaceList.length > 0) {
    where.channelListings = { some: { marketplace: { in: marketplaceList } } }
  }

  const tagIdList = asArray(f.tags)
  if (tagIdList.length > 0) {
    const productIds = (
      await prisma.productTag.findMany({
        where: { tagId: { in: tagIdList } },
        select: { productId: true },
        distinct: ['productId'],
      })
    ).map((r) => r.productId)
    where.id = { in: productIds }
  }

  const hasPhotos =
    typeof f.hasPhotos === 'string'
      ? f.hasPhotos === 'true'
      : f.hasPhotos === true
        ? true
        : f.hasPhotos === false
          ? false
          : null
  if (hasPhotos === true) where.images = { some: {} }
  else if (hasPhotos === false) where.images = { none: {} }

  const stockLevel = (f.stockLevel ?? '').toLowerCase()
  if (stockLevel === 'in') where.totalStock = { gt: 0 }
  else if (stockLevel === 'low') where.totalStock = { gt: 0, lte: 5 }
  else if (stockLevel === 'out') where.totalStock = 0

  return where as Prisma.ProductWhereInput
}
