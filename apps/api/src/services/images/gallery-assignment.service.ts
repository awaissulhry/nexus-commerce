import prisma from '../../db.js'
import { WorkspaceScopeError } from '../pim/workspace-destination.js'

export type ImageScope = 'GLOBAL' | 'PLATFORM' | 'MARKETPLACE'

export interface ListingImageUpsert {
  id?: string                 // present = update existing row
  variationId?: string | null
  scope: ImageScope
  platform?: string | null
  marketplace?: string | null
  amazonSlot?: string | null
  variantGroupKey?: string | null
  variantGroupValue?: string | null
  url: string
  filename?: string | null
  role?: string
  position?: number
  sourceProductImageId?: string | null
  width?: number | null
  height?: number | null
  fileSize?: number | null
  mimeType?: string | null
  hasWhiteBackground?: boolean | null
  // IE.6 — per-row alt-text override. NULL means "inherit from master".
  altOverride?: string | null
}

export function normalizeScopeFields(
  scope: ImageScope,
  platform?: string | null,
  marketplace?: string | null,
) {
  const p = platform ? platform.toUpperCase() : null
  const m = marketplace ? marketplace.toUpperCase() : null
  if (scope === 'GLOBAL') return { platform: null, marketplace: null }
  if (scope === 'PLATFORM') return { platform: p, marketplace: null }
  return { platform: p, marketplace: m }
}

/** Save one product's pending gallery assignments as a single transaction. */
export async function saveGalleryAssignments(productId: string, upserts: ListingImageUpsert[], deletes: string[]) {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { id: true },
  })
  if (!product) throw new WorkspaceScopeError('Product not found', 404)

  const existingIds = [...new Set([...deletes, ...upserts.flatMap(row => row.id ? [row.id] : [])])]
  if (existingIds.length && await prisma.listingImage.count({ where: { id: { in: existingIds }, productId } }) !== existingIds.length)
    throw new WorkspaceScopeError('A gallery row changed or belongs to another product. Reload before saving.', 409)

  try { await prisma.$transaction(async (tx) => {
    // Deletes first to avoid position conflicts
    if (deletes.length > 0) {
      await tx.listingImage.deleteMany({
        where: { id: { in: deletes }, productId },
      })
    }

    for (const u of upserts) {
      const { platform, marketplace } = normalizeScopeFields(
        u.scope,
        u.platform,
        u.marketplace,
      )

      const data = {
        productId,
        variationId: u.variationId ?? null,
        scope: u.scope as any,
        platform,
        marketplace,
        amazonSlot: u.amazonSlot ?? null,
        variantGroupKey: u.variantGroupKey ?? null,
        variantGroupValue: u.variantGroupValue ?? null,
        url: u.url,
        filename: u.filename ?? null,
        role: (u.role ?? 'GALLERY') as any,
        position: u.position ?? 0,
        sourceProductImageId: u.sourceProductImageId ?? null,
        altOverride: u.altOverride ?? null,
        width: u.width ?? null,
        height: u.height ?? null,
        fileSize: u.fileSize ?? null,
        mimeType: u.mimeType ?? null,
        hasWhiteBackground: u.hasWhiteBackground ?? null,
        publishStatus: 'DRAFT',
        publishError: null,
      }

      if (u.id) {
        await tx.listingImage.update({ where: { id: u.id, productId }, data })
      } else {
        await tx.listingImage.create({ data })
      }
    }
  }) } catch (error) {
    if ((error as { code?: string }).code === 'P2025') throw new WorkspaceScopeError('The gallery changed while saving. Reload and review your changes.', 409)
    throw error
  }

  return {
    saved: upserts.length,
    deleted: deletes.length,
    total: upserts.length + deletes.length,
  }
}
