/**
 * IA.2 — Pre-publish preview for the Amazon Color×Slot matrix.
 *
 * Operator-facing read endpoint that answers "what would actually
 * publish if I click Submit right now?" — same resolver the
 * publisher + ZIP exporter use, but exposed as a per-(ASIN, slot)
 * table the FE can render before submission.
 *
 * Honors the same cascade as amazon-image-feed.service.ts (exact
 * variant → group → product-level, each at MARKETPLACE / PLATFORM /
 * GLOBAL scope). Joins variant attributes back from Product /
 * ProductVariation so the operator sees "Giallo · M" alongside the
 * ASIN, not just a hash.
 *
 * Coverage stats per ASIN:
 *   • filledSlots / totalSlots — how many of MAIN+PT01..PT08+SWCH
 *     have a resolved image.
 *   • hasMain — a missing MAIN is catastrophic; Amazon rejects the
 *     listing entirely. FE colours that row red.
 *   • missingSlots — which slots are empty, for the drill-down.
 */

import prisma from '../../db.js'
import {
  resolveAmazonImages,
  type ResolvedSlot,
} from './amazon-image-feed.service.js'

const AMAZON_SLOTS = ['MAIN', 'PT01', 'PT02', 'PT03', 'PT04', 'PT05', 'PT06', 'PT07', 'PT08', 'SWCH'] as const
type AmazonSlot = typeof AMAZON_SLOTS[number]

export interface PreviewSlotCell {
  url: string
  listingImageId: string
  origin: 'MARKETPLACE' | 'PLATFORM' | 'GLOBAL'
  scope: 'variation' | 'product'
}

export interface PreviewVariantRow {
  variationId: string
  sku: string
  amazonAsin: string | null
  /** Attribute key/value map joined from Product.variantAttributes or
   *  ProductVariation.variationAttributes. Used to render "Color: Black,
   *  Size: M" in the table without a second query. */
  attributes: Record<string, string>
  /** Per-slot resolved cell. NULL means the cascade found nothing —
   *  this ASIN won't have anything to publish for that slot. */
  slots: Partial<Record<AmazonSlot, PreviewSlotCell | null>>
  filledSlots: number
  totalSlots: number
  hasMain: boolean
  missingSlots: AmazonSlot[]
}

export interface AmazonImagePreviewOutput {
  productId: string
  marketplace: string
  activeAxis: string | null
  totalVariants: number
  variantsWithAsin: number
  variantsWithMain: number
  rows: PreviewVariantRow[]
}

/**
 * Build a publish preview for one marketplace. The FE calls this on
 * "Preview publish" click; PublishPreviewModal renders the rows
 * as a table with per-cell drill-down.
 */
export async function buildAmazonImagePreview(input: {
  productId: string
  marketplace: string
  activeAxis?: string | null
  variantIds?: string[]
}): Promise<AmazonImagePreviewOutput> {
  const { productId, marketplace, variantIds } = input
  const mkt = marketplace.toUpperCase()

  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { id: true, imageAxisPreference: true },
  })
  if (!product) throw new Error(`Product ${productId} not found`)
  const activeAxis = input.activeAxis ?? product.imageAxisPreference ?? null

  const resolved = await resolveAmazonImages(productId, mkt, variantIds, activeAxis ?? undefined)

  // Join attributes back. Prefer child Products (the canonical
  // variant model); fall back to ProductVariation for legacy data.
  const variationIds = resolved.map((r) => r.variationId)
  const [children, pvs] = await Promise.all([
    prisma.product.findMany({
      where: { id: { in: variationIds } },
      select: { id: true, variantAttributes: true, categoryAttributes: true },
    }),
    prisma.productVariation.findMany({
      where: { id: { in: variationIds } },
      select: { id: true, variationAttributes: true },
    }),
  ])
  const attrsById = new Map<string, Record<string, string>>()
  for (const c of children) {
    const raw = (c.variantAttributes as Record<string, string> | null)
      ?? ((c.categoryAttributes as Record<string, unknown> | null)?.variations as Record<string, string> | null)
      ?? null
    if (raw && typeof raw === 'object') attrsById.set(c.id, raw)
  }
  for (const v of pvs) {
    if (attrsById.has(v.id)) continue
    const raw = v.variationAttributes as Record<string, string> | null
    if (raw && typeof raw === 'object') attrsById.set(v.id, raw)
  }

  const rows: PreviewVariantRow[] = resolved.map((r) => {
    const slots: Partial<Record<AmazonSlot, PreviewSlotCell | null>> = {}
    const slotByName = new Map<string, ResolvedSlot>()
    for (const s of r.slots) slotByName.set(s.slot, s)
    let filled = 0
    const missing: AmazonSlot[] = []
    for (const slot of AMAZON_SLOTS) {
      const hit = slotByName.get(slot)
      if (hit) {
        slots[slot] = {
          url: hit.url,
          listingImageId: hit.listingImageId,
          origin: hit.origin,
          scope: hit.scope,
        }
        filled++
      } else {
        slots[slot] = null
        missing.push(slot)
      }
    }
    return {
      variationId: r.variationId,
      sku: r.sku,
      amazonAsin: r.amazonAsin,
      attributes: attrsById.get(r.variationId) ?? {},
      slots,
      filledSlots: filled,
      totalSlots: AMAZON_SLOTS.length,
      hasMain: slots.MAIN !== null && slots.MAIN !== undefined,
      missingSlots: missing,
    }
  })

  return {
    productId,
    marketplace: mkt,
    activeAxis,
    totalVariants: rows.length,
    variantsWithAsin: rows.filter((r) => !!r.amazonAsin).length,
    variantsWithMain: rows.filter((r) => r.hasMain).length,
    rows,
  }
}
