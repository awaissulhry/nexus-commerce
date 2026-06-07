/**
 * M6 — "Fill from gallery".
 *
 * Maps the master ProductImage gallery onto Amazon slots so the exact-mirror
 * publish makes Amazon show exactly the Nexus gallery ("gallery = Amazon")
 * with one action — no manual per-slot dragging. Primary/MAIN image → MAIN,
 * the rest → PT01..PT{cap} in gallery order. Writes product-level, Amazon-
 * platform ListingImage rows linked to the master (sourceProductImageId) so
 * they track the master URL; the resolver's product-level cascade then applies
 * them to every variant/child + every EU market. Per-market/variant overrides
 * (the matrix) still win over these.
 *
 * Gap-only by default (won't clobber existing assignments); `overwrite` rewires
 * the product-level slots from the gallery.
 */

import prisma from '../../db.js'
import { resolveSlotTaxonomy } from './amazon-slot-taxonomy.service.js'
import { slotToRole } from './amazon-adopt.service.js'

export interface GalleryImage {
  id: string
  url: string
  type: string | null
  isPrimary: boolean
  sortOrder: number
}

export interface FillPlanItem {
  slot: string
  sourceProductImageId: string
  url: string
}

/**
 * PURE — map an ordered gallery to slot assignments. MAIN = the primary image
 * (else type 'MAIN', else first); the remaining images fill PT01..PT{ptCap}
 * in order. Exported for tests.
 */
export function planGalleryFill(gallery: GalleryImage[], ptCap: number): FillPlanItem[] {
  if (gallery.length === 0) return []
  let mainIdx = gallery.findIndex((g) => g.isPrimary)
  if (mainIdx < 0) mainIdx = gallery.findIndex((g) => g.type === 'MAIN')
  if (mainIdx < 0) mainIdx = 0

  const main = gallery[mainIdx]!
  const out: FillPlanItem[] = [{ slot: 'MAIN', sourceProductImageId: main.id, url: main.url }]
  const rest = gallery.filter((_, i) => i !== mainIdx)
  rest.slice(0, Math.max(0, ptCap)).forEach((g, i) => {
    out.push({ slot: `PT${String(i + 1).padStart(2, '0')}`, sourceProductImageId: g.id, url: g.url })
  })
  return out
}

export interface FillResult {
  dryRun: boolean
  productId: string
  galleryCount: number
  ptCap: number
  created: number
  skippedExisting: number
  plan: FillPlanItem[]
}

export async function fillSlotsFromGallery(opts: {
  productId: string
  dryRun?: boolean
  overwrite?: boolean
  /** Market whose taxonomy sets the PT cap; slot codes are market-agnostic. */
  marketplace?: string
}): Promise<FillResult> {
  const dryRun = opts.dryRun ?? false
  const overwrite = opts.overwrite ?? false

  const product = await prisma.product.findUnique({
    where: { id: opts.productId },
    select: { productType: true },
  })
  const productType = product?.productType ?? 'PRODUCT'
  const taxonomy = await resolveSlotTaxonomy((opts.marketplace ?? 'IT').toUpperCase(), productType)
  const ptCap = taxonomy.slots.filter((s) => s.kind === 'OTHER' && s.writable).length || 8

  const gallery = await prisma.productImage.findMany({
    // MM — only IMAGE media fills image slots; videos never map into MAIN/PT.
    where: { productId: opts.productId, mediaType: 'IMAGE' },
    select: { id: true, url: true, type: true, isPrimary: true, sortOrder: true },
    orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }],
  })

  const plan = planGalleryFill(gallery, ptCap)

  let created = 0
  let skippedExisting = 0
  for (const item of plan) {
    const existing = await prisma.listingImage.findFirst({
      where: {
        productId: opts.productId,
        variationId: null,
        scope: 'PLATFORM',
        platform: 'AMAZON',
        amazonSlot: item.slot,
      },
      select: { id: true },
    })
    if (existing && !overwrite) {
      skippedExisting += 1
      continue
    }
    if (!dryRun) {
      if (existing) {
        await prisma.listingImage.update({
          where: { id: existing.id },
          data: { url: item.url, sourceProductImageId: item.sourceProductImageId, publishStatus: 'DRAFT' },
        })
      } else {
        await prisma.listingImage.create({
          data: {
            productId: opts.productId,
            variationId: null,
            scope: 'PLATFORM',
            platform: 'AMAZON',
            amazonSlot: item.slot,
            url: item.url,
            sourceProductImageId: item.sourceProductImageId,
            position: item.slot === 'MAIN' ? 0 : Number(item.slot.replace(/\D/g, '')) || 0,
            role: slotToRole(item.slot),
            publishStatus: 'DRAFT',
          },
        })
      }
    }
    created += 1
  }

  return { dryRun, productId: opts.productId, galleryCount: gallery.length, ptCap, created, skippedExisting, plan }
}
