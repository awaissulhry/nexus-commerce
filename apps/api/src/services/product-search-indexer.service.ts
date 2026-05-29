/**
 * Product search indexer — projects the canonical ProductReadCache row
 * into a Typesense document.
 *
 * Design: ProductReadCache is already the denormalized read model the
 * /products grid uses. Rather than re-deriving fields from Product (and
 * risking drift), the Typesense doc is mapped 1:1 from the cache row — so
 * the search index and the Postgres fallback are interchangeable by
 * construction. The only field not on the cache row is the Italian title
 * (for name_it), pulled via one light Product select.
 *
 * Fed by the search-index BullMQ worker, which is enqueued from the same
 * ProductEvent fan-out point as the read-cache refresh (with the same 2s
 * debounce + jobId dedupe). The read-cache row is therefore usually fresh
 * by the time we index; if it's missing we trigger a refresh first.
 */

import prisma from '../db.js'
import { productReadCacheService } from './product-read-cache.service.js'
import {
  ensureCollection,
  importDocuments,
  upsertDocument,
  deleteDocument,
  isSearchConfigured,
  type ProductSearchDoc,
} from '../lib/typesense.js'
import { logger } from '../utils/logger.js'

type CacheRow = NonNullable<
  Awaited<ReturnType<typeof prisma.productReadCache.findUnique>>
>

function italianTitle(localizedContent: unknown): string | undefined {
  if (!localizedContent || typeof localizedContent !== 'object') return undefined
  const it = (localizedContent as Record<string, unknown>).it
  if (!it || typeof it !== 'object') return undefined
  const title = (it as Record<string, unknown>).title
  return typeof title === 'string' && title.trim().length > 0 ? title : undefined
}

function toDoc(row: CacheRow, nameIt?: string): ProductSearchDoc {
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    name_it: nameIt,
    brand: row.brand ?? undefined,
    productType: row.productType ?? undefined,
    status: row.status,
    fulfillmentMethod: row.fulfillmentMethod ?? undefined,
    isParent: row.isParent,
    isChild: row.parentId != null,
    parentId: row.parentId ?? undefined,
    familyId: row.familyId ?? undefined,
    workflowStageId: row.workflowStageId ?? undefined,
    channelKeys: row.channelKeys ?? [],
    categoryIds: row.categoryIds ?? [],
    primaryCategoryId: row.primaryCategoryId ?? undefined,
    hasPhotos: row.hasPhotos,
    hasDescription: row.hasDescription,
    hasBrand: row.hasBrand,
    hasGtin: row.hasGtin,
    driftCount: row.driftCount,
    photoCount: row.photoCount,
    channelCount: row.channelCount,
    variantCount: row.variantCount,
    childCount: row.childCount,
    basePrice: row.basePrice != null ? Number(row.basePrice) : undefined,
    totalStock: row.totalStock,
    imageUrl: row.imageUrl ?? undefined,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    deletedAt: row.deletedAt ? row.deletedAt.getTime() : 0,
  }
}

export class ProductSearchIndexerService {
  /** Upsert one product's document. No-op when search isn't configured. */
  async indexProduct(productId: string): Promise<void> {
    if (!isSearchConfigured()) return

    let row = await prisma.productReadCache.findUnique({
      where: { id: productId },
    })
    if (!row) {
      // Cache not built yet (or product gone). Rebuild then re-read.
      await productReadCacheService.refresh(productId)
      row = await prisma.productReadCache.findUnique({ where: { id: productId } })
    }
    if (!row) {
      // Product was deleted — drop it from the index too.
      await deleteDocument(productId)
      return
    }

    const product = await prisma.product.findUnique({
      where: { id: productId },
      select: { localizedContent: true },
    })
    const nameIt = italianTitle(product?.localizedContent)

    await upsertDocument(toDoc(row, nameIt))
  }

  /** Remove one product's document. */
  async removeProduct(productId: string): Promise<void> {
    if (!isSearchConfigured()) return
    await deleteDocument(productId)
  }

  /**
   * Seed/rebuild the whole index from ProductReadCache in batches.
   * Returns the number of documents imported and any failures.
   */
  async backfillAll(): Promise<{ imported: number; failed: number }> {
    if (!isSearchConfigured()) {
      throw new Error('Search engine not configured (SEARCH_ENGINE_ENABLED + TYPESENSE_*)')
    }
    await ensureCollection()

    let cursor: string | undefined
    let imported = 0
    let failed = 0

    while (true) {
      const batch: CacheRow[] = await prisma.productReadCache.findMany({
        take: 200,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        orderBy: { id: 'asc' },
      })
      if (batch.length === 0) break

      // Italian titles for the batch in one query.
      const localized = await prisma.product.findMany({
        where: { id: { in: batch.map((b) => b.id) } },
        select: { id: true, localizedContent: true },
      })
      const nameItById = new Map<string, string | undefined>()
      for (const p of localized) {
        nameItById.set(p.id, italianTitle(p.localizedContent))
      }

      const docs = batch.map((r) => toDoc(r, nameItById.get(r.id)))
      failed += await importDocuments(docs)
      imported += docs.length
      cursor = batch[batch.length - 1].id
      logger.info('[search-indexer] backfill progress', { imported, failed })
    }

    return { imported, failed }
  }
}

export const productSearchIndexerService = new ProductSearchIndexerService()
