/**
 * IR.8 — Bulk image propagation service.
 *
 * Mirrors a source product's master gallery onto one or more target
 * products. Used by:
 *   - POST /api/products/:id/images/apply-to-children (parent action)
 *   - POST /api/products/images/bulk-apply (arbitrary target list)
 *
 * Mode semantics:
 *   - 'replace' (default): wipe target's existing ProductImage rows
 *     then create fresh mirrors. Predictable end state.
 *   - 'append': leave existing rows in place, only add what's missing
 *     (by publicId). Safer when targets may have hand-curated images.
 *
 * Idempotency: in 'append' mode, re-running is a no-op once mirrors
 * exist. In 'replace' mode, each call is a fresh wipe-and-replace.
 *
 * Audit: one AuditLog row per affected target with action =
 * 'bulk-image-apply' and metadata.sourceProductId for traceability.
 * No Cloudinary calls — mirrors reuse the source's publicId, so the
 * targets reference the same bytes without re-upload.
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { productEventService } from '../product-event.service.js'

export interface BulkApplyInput {
  sourceProductId: string
  targetProductIds: string[]
  mode?: 'replace' | 'append'
  userId?: string | null
}

export interface BulkApplyResult {
  sourceProductId: string
  targetsTotal: number
  targetsUpdated: number
  imagesCreated: number
  imagesDeleted: number
  errors: Array<{ targetProductId: string; message: string }>
}

export async function applyImagesToProducts(input: BulkApplyInput): Promise<BulkApplyResult> {
  const { sourceProductId, targetProductIds, mode = 'replace', userId } = input

  if (sourceProductId && targetProductIds.includes(sourceProductId)) {
    // Skip self-targeting silently — no value, only confusion.
    return {
      sourceProductId,
      targetsTotal: 0,
      targetsUpdated: 0,
      imagesCreated: 0,
      imagesDeleted: 0,
      errors: [],
    }
  }

  const source = await prisma.product.findUnique({
    where: { id: sourceProductId },
    select: { id: true },
  })
  if (!source) {
    throw new Error(`SOURCE_NOT_FOUND: ${sourceProductId}`)
  }

  const sourceImages = await prisma.productImage.findMany({
    where: { productId: sourceProductId, mediaType: 'IMAGE' },
    orderBy: { sortOrder: 'asc' },
  })

  const result: BulkApplyResult = {
    sourceProductId,
    targetsTotal: targetProductIds.length,
    targetsUpdated: 0,
    imagesCreated: 0,
    imagesDeleted: 0,
    errors: [],
  }

  // Per-target loop. Each target gets its own transaction so a single
  // failure doesn't roll back the whole batch — bulk ops on N products
  // need partial-success semantics.
  for (const targetProductId of targetProductIds) {
    try {
      await prisma.$transaction(async (tx) => {
        const target = await tx.product.findUnique({
          where: { id: targetProductId },
          select: { id: true },
        })
        if (!target) {
          throw new Error('target product not found')
        }

        const existing = await tx.productImage.findMany({
          where: { productId: targetProductId },
          select: { id: true, publicId: true },
        })

        let deletedCount = 0
        if (mode === 'replace' && existing.length > 0) {
          const deleted = await tx.productImage.deleteMany({
            where: { productId: targetProductId },
          })
          deletedCount = deleted.count
        }

        // In append mode, skip source images whose publicId already
        // exists on the target so we don't double-mirror.
        const existingPublicIds = new Set(
          existing.map((e) => e.publicId).filter((v): v is string => !!v),
        )

        let createdCount = 0
        const startSortOrder = mode === 'append' ? existing.length : 0
        for (let i = 0; i < sourceImages.length; i++) {
          const src = sourceImages[i]!
          if (mode === 'append' && src.publicId && existingPublicIds.has(src.publicId)) continue
          await tx.productImage.create({
            data: {
              productId: targetProductId,
              url: src.url,
              publicId: src.publicId,
              type: src.type,
              alt: src.alt,
              sortOrder: startSortOrder + createdCount,
              width: src.width,
              height: src.height,
              mimeType: src.mimeType,
              fileSize: src.fileSize,
              // Don't propagate AI analysis — each child can be its
              // own subject, so analysis should re-run if wanted.
            },
          })
          createdCount++
        }

        await tx.auditLog.create({
          data: {
            userId: userId ?? null,
            entityType: 'Product',
            entityId: targetProductId,
            action: 'bulk-image-apply',
            metadata: {
              sourceProductId,
              mode,
              imagesCreated: createdCount,
              imagesDeleted: deletedCount,
            } as object,
          },
        })

        result.targetsUpdated++
        result.imagesCreated += createdCount
        result.imagesDeleted += deletedCount
      })

      // PG.1b — fire IMAGES_UPDATED after the per-target txn commits so
      // the target's ProductReadCache.imageUrl refreshes within ~2s.
      // Outside the txn so a slow event write can't roll back the bulk
      // copy; void-cast because emit() is fail-open by design.
      void productEventService.emit({
        aggregateId: targetProductId,
        aggregateType: 'Product',
        eventType: 'IMAGES_UPDATED',
        data: { source: 'bulk-image-apply', sourceProductId, mode },
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error'
      logger.warn('bulk-apply: per-target failure', { targetProductId, sourceProductId, err: message })
      result.errors.push({ targetProductId, message })
    }
  }

  return result
}
