/**
 * ES.3 — ProductReadCache refresh service.
 *
 * Rebuilds one cache row from live Prisma data. Called by the
 * read-cache BullMQ worker; never called inline on the hot path.
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

export class ProductReadCacheService {
  async refresh(productId: string): Promise<void> {
    const product = await prisma.product.findUnique({
      where: { id: productId },
      select: {
        id: true,
        sku: true,
        name: true,
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
      },
    })

    if (!product) {
      // Product was deleted — remove stale cache row.
      await prisma.productReadCache.deleteMany({ where: { id: productId } })
      return
    }

    // Build channel coverage and keys from ChannelListing
    const listings = await prisma.channelListing.findMany({
      where: { productId },
      select: {
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
      },
    })

    // Derive the effective fulfillment method (offers > stock > raw field).
    const [offerRows, stockRows] = await Promise.all([
      prisma.offer.findMany({
        where: { isActive: true, channelListing: { productId } },
        select: { fulfillmentMethod: true },
      }),
      prisma.stockLevel.findMany({
        where: { productId },
        select: {
          quantity: true,
          location: { select: { type: true } },
        },
      }),
    ])
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

    // PG.2 — pick this product's own face image first, then fall back
    // to a child's image if this is a parent with zero own ProductImage
    // rows. Without the fallback, parents like AIR-MESH-JACKET-MEN (12
    // variations, 0 own images) showed an empty thumb on /products
    // while every child had a full gallery. We pick the alphabetically
    // first child that has images (stable + deterministic) and reuse
    // pickFaceImage to choose its best one.
    let imageUrl = pickFaceImage(product.images)
    if (!imageUrl && product.isParent) {
      const firstChildWithImages = await prisma.product.findFirst({
        where: {
          parentId: product.id,
          deletedAt: null,
          images: { some: {} },
        },
        orderBy: { sku: 'asc' },
        select: {
          images: {
            take: 12,
            orderBy: FACE_IMAGE_ORDER_BY,
            select: FACE_IMAGE_SELECT,
          },
        },
      })
      if (firstChildWithImages) {
        imageUrl = pickFaceImage(firstChildWithImages.images)
      }
    }

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

    // ── PIM category facets ──────────────────────────────────────────
    // Direct memberships + closure ancestor rollup, so the fallback grid
    // path can filter by a parent category and match the whole subtree
    // (categoryIds via `hasSome`) — mirroring the Typesense doc.
    const memberships = await prisma.productCategory.findMany({
      where: { productId },
      select: { categoryId: true, isPrimary: true },
    })
    let primaryCategoryId: string | null = null
    const categoryIdSet = new Set<string>()
    let categoryPathJson: Prisma.InputJsonValue | null = null
    if (memberships.length > 0) {
      const directIds = memberships.map((m) => m.categoryId)
      primaryCategoryId =
        memberships.find((m) => m.isPrimary)?.categoryId ?? directIds[0]
      for (const id of directIds) categoryIdSet.add(id)
      // All ancestors (incl. self at depth 0) of every direct category.
      const closure = await prisma.categoryClosure.findMany({
        where: { descendantId: { in: directIds } },
        select: { ancestorId: true },
      })
      for (const c of closure) categoryIdSet.add(c.ancestorId)
      // Breadcrumb of the primary category: ancestor chain ordered
      // root→leaf (depth desc), with localized names.
      const path = await prisma.categoryClosure.findMany({
        where: { descendantId: primaryCategoryId },
        orderBy: { depth: 'desc' },
        select: {
          ancestor: { select: { id: true, slug: true, name: true } },
        },
      })
      categoryPathJson = path.map((p) => ({
        id: p.ancestor.id,
        slug: p.ancestor.slug,
        name: p.ancestor.name,
      })) as unknown as Prisma.InputJsonValue
    }

    const data = {
      sku: product.sku,
      name: product.name,
      brand: product.brand ?? null,
      basePrice: product.basePrice ?? null,
      totalStock: product.totalStock ?? 0,
      lowStockThreshold: product.lowStockThreshold ?? null,
      status: product.status,
      syncChannels: product.syncChannels,
      productType: product.productType ?? null,
      fulfillmentMethod: derivedFulfillment,
      isParent: product.isParent ?? false,
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

    await prisma.productReadCache.upsert({
      where: { id: productId },
      create: { id: productId, ...data },
      update: data,
    })

    // PG.2 — propagate to the parent's cache row. When a child's images
    // change, the parent's PG.2 fallback ("borrow the first child's MAIN
    // when I have none of my own") needs to re-pick. Lazy import the
    // queue to keep this module free of the BullMQ import chain at
    // bootstrap time (cache-service ← worker ← cache-service would be
    // a cycle if it loaded eagerly). Fire-and-forget; idempotent jobId
    // dedups rapid bursts.
    if (product.parentId) {
      void import('../lib/queue.js')
        .then(({ readCacheQueue, searchIndexQueue }) => {
          void readCacheQueue.add(
            'refresh',
            { productId: product.parentId },
            { jobId: `cache:refresh:${product.parentId}`, delay: 2000 },
          )
          // Mirror the re-index so the parent's borrowed-thumbnail doc
          // re-derives when a child's images change. Gated like the
          // primary enqueue path.
          if (process.env.SEARCH_ENGINE_ENABLED === '1') {
            void searchIndexQueue.add(
              'index',
              { productId: product.parentId },
              { jobId: `search:index:${product.parentId}`, delay: 2000 },
            )
          }
        })
        .catch(() => {/* parent re-enqueue is best-effort */})
    }
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

      await Promise.all(batch.map((p) => this.refresh(p.id)))
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
