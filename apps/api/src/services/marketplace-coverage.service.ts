import prisma from '../db.js'

export type TrafficLight = 'live' | 'override' | 'error' | 'none'

export interface MarketplaceCoverageCell {
  status: TrafficLight
  errorChildCount: number
  overrideChildCount: number
  totalChildren: number
}

// Key format: "AMAZON:IT", "EBAY:DE", "SHOPIFY:GLOBAL"
export type MarketplaceCoverageMap = Record<string, MarketplaceCoverageCell>

// Determine the traffic-light status of a single ChannelListing row.
function classifyListing(cl: {
  listingStatus: string
  syncStatus: string
  lastSyncStatus: string | null
  validationStatus: string
  isPublished: boolean
  followMasterTitle: boolean
  followMasterDescription: boolean
  followMasterPrice: boolean
  followMasterQuantity: boolean
  followMasterImages: boolean
  followMasterBulletPoints: boolean
}): TrafficLight {
  if (!cl.isPublished) return 'none'

  const isError =
    cl.syncStatus === 'FAILED' ||
    cl.validationStatus === 'ERROR' ||
    cl.listingStatus === 'ERROR' ||
    cl.lastSyncStatus === 'FAILED'

  if (isError) return 'error'

  if (cl.listingStatus !== 'ACTIVE') return 'none'

  const hasOverride =
    !cl.followMasterTitle ||
    !cl.followMasterDescription ||
    !cl.followMasterPrice ||
    !cl.followMasterQuantity ||
    !cl.followMasterImages ||
    !cl.followMasterBulletPoints

  return hasOverride ? 'override' : 'live'
}

const LISTING_SELECT = {
  productId: true,
  channel: true,
  marketplace: true,
  listingStatus: true,
  syncStatus: true,
  lastSyncStatus: true,
  validationStatus: true,
  isPublished: true,
  followMasterTitle: true,
  followMasterDescription: true,
  followMasterPrice: true,
  followMasterQuantity: true,
  followMasterImages: true,
  followMasterBulletPoints: true,
} as const

/**
 * For a set of product IDs (which may include parents), returns a map from
 * productId → MarketplaceCoverageMap.
 *
 * Parent rows get a roll-up: each cell reports the worst status across all
 * child variants for that (channel, marketplace), plus errorChildCount and
 * overrideChildCount so the UI can render "2 of 5" badges.
 *
 * Child rows (non-parent) report their own listing status directly, with
 * all child counts set to 0.
 */
export async function computeMarketplaceCoverage(
  productIds: string[],
): Promise<Record<string, MarketplaceCoverageMap>> {
  if (productIds.length === 0) return {}

  // Fetch own listings for all requested products.
  const ownListings = await prisma.channelListing.findMany({
    where: { productId: { in: productIds } },
    select: LISTING_SELECT,
  })

  // Find which of these products are parents.
  const parentIds = await prisma.product.findMany({
    where: { id: { in: productIds }, isParent: true },
    select: { id: true },
  })
  const parentIdSet = new Set(parentIds.map((p) => p.id))

  // Fetch child products' listings for parent rows.
  const childListings =
    parentIdSet.size > 0
      ? await prisma.channelListing.findMany({
          where: {
            product: { parentId: { in: [...parentIdSet] } },
          },
          select: {
            ...LISTING_SELECT,
            product: { select: { parentId: true } },
          },
        })
      : []

  const result: Record<string, MarketplaceCoverageMap> = {}

  // Non-parent products: use their own listings directly.
  for (const cl of ownListings) {
    if (parentIdSet.has(cl.productId)) continue
    const key = `${cl.channel}:${cl.marketplace}`
    result[cl.productId] ??= {}
    result[cl.productId][key] = {
      status: classifyListing(cl),
      errorChildCount: 0,
      overrideChildCount: 0,
      totalChildren: 0,
    }
  }

  // Parent products: aggregate child listings into roll-up cells.
  if (childListings.length > 0) {
    // Group child listing statuses by (parentId, channel:marketplace).
    type CellAgg = { statuses: TrafficLight[]; errors: number; overrides: number }
    const agg = new Map<string, Map<string, CellAgg>>()

    for (const cl of childListings) {
      const parentId = (cl as any).product?.parentId
      if (!parentId) continue
      const mKey = `${cl.channel}:${cl.marketplace}`
      if (!agg.has(parentId)) agg.set(parentId, new Map())
      const cellMap = agg.get(parentId)!
      if (!cellMap.has(mKey)) cellMap.set(mKey, { statuses: [], errors: 0, overrides: 0 })
      const cell = cellMap.get(mKey)!
      const status = classifyListing(cl)
      cell.statuses.push(status)
      if (status === 'error') cell.errors++
      if (status === 'override') cell.overrides++
    }

    for (const [parentId, cellMap] of agg) {
      result[parentId] ??= {}
      for (const [mKey, cell] of cellMap) {
        const { statuses, errors, overrides } = cell
        // Roll-up: worst status wins (error > override > live > none).
        let rollup: TrafficLight = 'none'
        if (statuses.includes('error')) rollup = 'error'
        else if (statuses.includes('override')) rollup = 'override'
        else if (statuses.includes('live')) rollup = 'live'
        result[parentId][mKey] = {
          status: rollup,
          errorChildCount: errors,
          overrideChildCount: overrides,
          totalChildren: statuses.length,
        }
      }
    }
  }

  return result
}

const TOP_LOCALES = ['it', 'en', 'de', 'fr', 'es']

export type TranslationsMap = Record<
  string,
  Partial<Record<string, { name: string | null; description: string | null }>>
>

/**
 * For a set of product IDs, returns a map from productId → locale → {name, description}.
 * Only the top supported locales are fetched (it, en, de, fr, es).
 */
export async function fetchProductTranslations(
  productIds: string[],
): Promise<TranslationsMap> {
  if (productIds.length === 0) return {}

  const rows = await prisma.productTranslation.findMany({
    where: {
      productId: { in: productIds },
      language: { in: TOP_LOCALES },
    },
    select: { productId: true, language: true, name: true, description: true },
  })

  const result: TranslationsMap = {}
  for (const row of rows) {
    result[row.productId] ??= {}
    result[row.productId][row.language] = { name: row.name ?? null, description: row.description ?? null }
  }
  return result
}
