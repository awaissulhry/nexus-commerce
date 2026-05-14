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
          take: 1,
          orderBy: { createdAt: 'asc' },
          select: { url: true },
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
      },
    })

    const channelKeys: string[] = []
    const coverageMap: Record<string, { live: number; draft: number; error: number; total: number }> = {}

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
      fulfillmentMethod: product.fulfillmentMethod ?? null,
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
      imageUrl: product.images[0]?.url ?? null,
      photoCount: product._count.images,
      channelCount: product._count.channelListings,
      variantCount: product._count.variations,
      childCount: product._count.children,
      hasDescription: !!product.description && product.description.trim().length > 0,
      hasBrand: !!product.brand && product.brand.trim().length > 0,
      hasGtin: !!product.gtin && product.gtin.trim().length > 0,
      hasPhotos: product._count.images > 0,
      channelKeys,
      coverageJson: Object.keys(coverageMap).length > 0
        ? (coverageMap as Prisma.InputJsonValue)
        : null,
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
