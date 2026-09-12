/**
 * ES.3 — ProductReadCache refresh service.
 *
 * Rebuilds one cache row from live Prisma data. Called by the
 * read-cache worker and catalog writes. Related parents refresh in the same snapshot.
 *
 * refresh(productId) is idempotent — safe to call repeatedly.
 * delete(productId) hard-removes the row (used when Product is purged).
 */

import prisma from '../db.js'
import type { Prisma } from '@prisma/client'
import { deriveFulfillmentMethod } from './fulfillment-derivation.service.js'

/**
 * PG.2 + PG.4 — Catalog thumbnail picker.
 *
 * Selects the single "face" image for a product row in priority order:
 *   1. isPrimary=true             (operator-curated hero, PG.4)
 *   2. type='MAIN' with lowest sortOrder
 *   3. lowest sortOrder regardless of type
 *   4. lowest createdAt           (tiebreaker for batch-inserted sets
 *      that share sortOrder=0)
 *
 * Pre-PG.2 we picked by createdAt ASC alone, which made the chosen
 * thumbnail random whenever Amazon's catalog backfill batch-inserted
 * a parent's image set (all rows share createdAt to the ms). PG.2
 * added type+sortOrder respect; PG.4 lets the operator override the
 * derived choice with an explicit ★ on the per-product images tab.
 *
 * Pass an already-sorted array (FACE_IMAGE_ORDER_BY); the helper folds
 * the isPrimary + MAIN preferences on top of the sort.
 */
export type FaceImageCandidate = {
  url: string
  type: string
  sortOrder: number
  createdAt: Date
  isPrimary: boolean
}

export function pickFaceImage(images: FaceImageCandidate[]): string | null {
  if (images.length === 0) return null
  // The caller sorted by [sortOrder ASC, createdAt ASC]. Operator-set
  // isPrimary wins outright; then we fall back to the first MAIN-type
  // we see; finally the lowest-sortOrder row of any type.
  const primary = images.find((i) => i.isPrimary)
  if (primary) return primary.url
  const main = images.find((i) => i.type === 'MAIN')
  return main?.url ?? images[0]?.url ?? null
}

export const FACE_IMAGE_ORDER_BY: Prisma.ProductImageOrderByWithRelationInput[] = [
  { sortOrder: 'asc' },
  { createdAt: 'asc' },
]

/** Common select shape so cache + direct paths pull the same columns. */
export const FACE_IMAGE_SELECT = {
  url: true,
  type: true,
  sortOrder: true,
  createdAt: true,
  isPrimary: true,
} as const satisfies Prisma.ProductImageSelect

const PRODUCT_SELECT = {
  id: true,
  sku: true,
  name: true,
  amazonAsin: true, // APS.1 — mirrored to ProductReadCache.asin
  brand: true,
  basePrice: true,
  totalStock: true,
  lowStockThreshold: true,
  status: true,
  syncChannels: true,
  productType: true,
  fulfillmentMethod: true,
  isParent: true,
  parentId: true,
  version: true,
  description: true,
  gtin: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
  familyId: true,
  family: {
    select: { id: true, code: true, label: true },
  },
  workflowStageId: true,
  workflowStage: {
    select: {
      id: true,
      code: true,
      label: true,
      isPublishable: true,
      isTerminal: true,
      workflow: { select: { id: true, code: true, label: true } },
    },
  },
  images: {
    // PG.2 + PG.4 — take enough rows to find a primary / MAIN if
    // one exists. The picker prefers isPrimary, then MAIN, then
    // lowest sortOrder, then createdAt. 12 covers Amazon's max
    // main+alt set; we don't need more.
    where: { mediaType: 'IMAGE' }, // MM — videos never become the catalog/search thumbnail
    take: 12,
    orderBy: FACE_IMAGE_ORDER_BY,
    select: FACE_IMAGE_SELECT,
  },
  _count: {
    select: {
      images: true,
      channelListings: true,
      variations: true,
      children: true,
    },
  },
} as const satisfies Prisma.ProductSelect

const LISTING_SELECT = {
  channel: true,
  marketplace: true,
  region: true,
  listingStatus: true,
  lastSyncStatus: true,
  isPublished: true,
  followMasterPrice: true,
  followMasterTitle: true,
  followMasterDescription: true,
  followMasterQuantity: true,
  followMasterImages: true,
  followMasterBulletPoints: true,
} as const satisfies Prisma.ChannelListingSelect

export class ProductReadCacheService {
  async refresh(productId: string): Promise<void> {
    await this.refreshMany([productId])
  }

  async refreshMany(productIds: readonly string[]): Promise<void> {
    // Concurrent refreshes must not overwrite a newer projection with an older snapshot.
    for (let attempt = 0; ; attempt++) {
      try {
        const refreshed = await prisma.$transaction(tx => this.refreshInTransaction(tx, productIds), {
          isolationLevel: 'Serializable', timeout: 30_000,
        })
        // Preserve the existing search-index fan-out for parents whose thumbnail/coverage changed.
        if (process.env.SEARCH_ENGINE_ENABLED === '1') {
          const { addJobSafely, searchIndexQueue } = await import('../lib/queue.js')
          for (const id of refreshed) if (!productIds.includes(id)) void addJobSafely(searchIndexQueue, 'index', { productId: id }, { jobId: `search:index:${id}`, delay: 2000 }).catch(() => {})
        }
        return
      } catch (error) {
        if (attempt < 2 && (error as { code?: string }).code === 'P2034') continue
        throw error
      }
    }
  }

  /** Batch source reads and refresh both former and current parents, without a queue dependency. */
  async refreshInTransaction(tx: Prisma.TransactionClient, productIds: readonly string[]): Promise<string[]> {
    const requested = [...new Set(productIds)]
    if (!requested.length) return []
    const [current, previous] = await Promise.all([
      tx.product.findMany({ where: { id: { in: requested } }, select: { parentId: true } }),
      tx.productReadCache.findMany({ where: { id: { in: requested } }, select: { parentId: true } }),
    ])
    const ids = [...new Set([...requested, ...[...current, ...previous].flatMap(row => row.parentId ? [row.parentId] : [])])]
    const products = await tx.product.findMany({ where: { id: { in: ids } }, select: PRODUCT_SELECT })
    const [allListings, allOffers, allStock, allMemberships, children, childListings] = await Promise.all([
      tx.channelListing.findMany({ where: { productId: { in: ids } }, select: { productId: true, ...LISTING_SELECT } }),
      tx.offer.findMany({ where: { isActive: true, channelListing: { productId: { in: ids } } }, select: { fulfillmentMethod: true, channelListing: { select: { productId: true } } } }),
      tx.stockLevel.findMany({ where: { productId: { in: ids } }, select: { productId: true, quantity: true, location: { select: { type: true } } } }),
      tx.productCategory.findMany({ where: { productId: { in: ids } }, select: { productId: true, categoryId: true, isPrimary: true } }),
      tx.product.findMany({ where: { parentId: { in: ids }, deletedAt: null, images: { some: { mediaType: 'IMAGE' } } }, orderBy: { sku: 'asc' },
        select: { parentId: true, images: { where: { mediaType: 'IMAGE' }, take: 12, orderBy: FACE_IMAGE_ORDER_BY, select: FACE_IMAGE_SELECT } } }),
      tx.channelListing.findMany({ where: { product: { parentId: { in: ids }, deletedAt: null } }, select: { channel: true, marketplace: true, region: true, product: { select: { parentId: true } } } }),
    ])
    const categoryIds = [...new Set(allMemberships.map(row => row.categoryId))]
    const closure = categoryIds.length ? await tx.categoryClosure.findMany({ where: { descendantId: { in: categoryIds } }, orderBy: { depth: 'desc' },
      select: { descendantId: true, ancestorId: true, ancestor: { select: { id: true, slug: true, name: true } } } }) : []
    const group = <T>(rows: T[], key: (row: T) => string | null) => {
      const grouped = new Map<string, T[]>()
      for (const row of rows) { const id = key(row); if (id) { const items = grouped.get(id) ?? []; items.push(row); grouped.set(id, items) } }
      return grouped
    }
    const listingsById = group(allListings, row => row.productId)
    const offersById = group(allOffers, row => row.channelListing.productId)
    const stockById = group(allStock, row => row.productId)
    const membershipsById = group(allMemberships, row => row.productId)
    const childrenById = group(children, row => row.parentId)
    const childListingsById = group(childListings, row => row.product.parentId)
    const closureById = group(closure, row => row.descendantId)
    for (const product of products) {
      const listings = listingsById.get(product.id) ?? []
      const offerRows = offersById.get(product.id) ?? []
      const stockRows = stockById.get(product.id) ?? []
      const offerMethods = new Set<'FBA' | 'FBM'>()
      for (const o of offerRows) offerMethods.add(o.fulfillmentMethod as 'FBA' | 'FBM')
      const stockBuckets = stockRows.reduce(
        (acc, s) => {
          if (s.location.type === 'AMAZON_FBA') acc.fba += s.quantity
          else acc.non += s.quantity
          return acc
        },
        { fba: 0, non: 0 },
      )
      const derivedFulfillment = deriveFulfillmentMethod({
        offerMethods,
        stock: stockBuckets,
        fallback: (product.fulfillmentMethod ?? null) as 'FBA' | 'FBM' | null,
      })


      const isParent = !product.parentId && (product.isParent || product._count.children > 0)
      const imageUrl = pickFaceImage(product.images) ?? (isParent ? pickFaceImage(childrenById.get(product.id)?.[0]?.images ?? []) : null)
      const channelKeys: string[] = []
      const coverageMap: Record<string, { live: number; draft: number; error: number; total: number }> = {}
      let driftCount = 0

      for (const l of listings) {
        // Key format: "AMAZON_IT", "EBAY_DE", "SHOPIFY_MAIN"
        const key = `${l.channel}_${l.marketplace ?? l.region ?? 'MAIN'}`
        if (!channelKeys.includes(key)) channelKeys.push(key)

        if (!coverageMap[l.channel]) {
          coverageMap[l.channel] = { live: 0, draft: 0, error: 0, total: 0 }
        }
        coverageMap[l.channel].total++
        if (l.isPublished && l.listingStatus === 'ACTIVE') {
          coverageMap[l.channel].live++
        } else if (l.lastSyncStatus === 'FAILED' || l.listingStatus === 'ERROR') {
          coverageMap[l.channel].error++
        } else {
          coverageMap[l.channel].draft++
        }

        // IN.4 — count listings with any active field override
        if (
          l.followMasterPrice === false ||
          l.followMasterTitle === false ||
          l.followMasterDescription === false ||
          l.followMasterQuantity === false ||
          l.followMasterImages === false ||
          l.followMasterBulletPoints === false
        ) {
          driftCount++
        }
      }


      const rollupSet = new Set(channelKeys)
      if (isParent) for (const listing of childListingsById.get(product.id) ?? []) rollupSet.add(`${listing.channel}_${listing.marketplace ?? listing.region ?? 'MAIN'}`)
      const rollupChannelKeys = [...rollupSet]
      const memberships = membershipsById.get(product.id) ?? []
      const primaryCategoryId = memberships.find(row => row.isPrimary)?.categoryId ?? memberships[0]?.categoryId ?? null
      const categoryIdSet = new Set<string>()
      for (const membership of memberships) {
        categoryIdSet.add(membership.categoryId)
        for (const path of closureById.get(membership.categoryId) ?? []) categoryIdSet.add(path.ancestorId)
      }
      const categoryPathJson = primaryCategoryId ? (closureById.get(primaryCategoryId) ?? []).map(path => path.ancestor) as Prisma.InputJsonValue : null
      const data = {
        sku: product.sku,
        name: product.name,
        asin: product.amazonAsin ?? null,
        brand: product.brand ?? null,
        basePrice: product.basePrice ?? null,
        totalStock: product.totalStock ?? 0,
        lowStockThreshold: product.lowStockThreshold ?? null,
        status: product.status,
        syncChannels: product.syncChannels,
        productType: product.productType ?? null,
        fulfillmentMethod: derivedFulfillment,
        isParent: !product.parentId && (product.isParent || product._count.children > 0),
        parentId: product.parentId ?? null,
        version: product.version ?? 0,
        familyId: product.familyId ?? null,
        familyJson: product.family
          ? (product.family as Prisma.InputJsonValue)
          : null,
        workflowStageId: product.workflowStageId ?? null,
        workflowStageJson: product.workflowStage
          ? (product.workflowStage as Prisma.InputJsonValue)
          : null,
        imageUrl,
        photoCount: product._count.images,
        channelCount: product._count.channelListings,
        variantCount: product._count.variations,
        childCount: product._count.children,
        hasDescription: !!product.description && product.description.trim().length > 0,
        hasBrand: !!product.brand && product.brand.trim().length > 0,
        hasGtin: !!product.gtin && product.gtin.trim().length > 0,
        hasPhotos: product._count.images > 0,
        channelKeys,
        rollupChannelKeys,
        driftCount,
        coverageJson: Object.keys(coverageMap).length > 0
          ? (coverageMap as Prisma.InputJsonValue)
          : null,
        primaryCategoryId,
        categoryIds: Array.from(categoryIdSet),
        categoryPathJson,
        createdAt: product.createdAt,
        updatedAt: product.updatedAt,
        deletedAt: product.deletedAt ?? null,
        cacheRefreshedAt: new Date(),
      }

      await tx.productReadCache.upsert({
        where: { id: product.id },
        create: { id: product.id, ...data },
        update: data,
      })

    }
    const found = new Set(products.map(product => product.id))
    await tx.productReadCache.deleteMany({ where: { id: { in: ids.filter(id => !found.has(id)) } } })
    return ids
  }

  /** Backfill all products in batches of 100. Returns count refreshed. */
  async backfillAll(): Promise<number> {
    let cursor: string | undefined
    let total = 0

    while (true) {
      const batch = await prisma.product.findMany({
        take: 100,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        orderBy: { id: 'asc' },
        select: { id: true },
      })
      if (batch.length === 0) break

      await this.refreshMany(batch.map(p => p.id))
      total += batch.length
      cursor = batch[batch.length - 1].id
    }

    return total
  }

  /** Remove a stale cache row (product permanently deleted). */
  async delete(productId: string): Promise<void> {
    await prisma.productReadCache.deleteMany({ where: { id: productId } })
  }
}

export const productReadCacheService = new ProductReadCacheService()
