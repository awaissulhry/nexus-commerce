/**
 * IA.4 — Strict validation gate for Amazon publish.
 *
 * Runs after the resolver builds the per-(ASIN, slot) plan and BEFORE
 * the publisher submits the JSON_LISTINGS_FEED. Refuses to publish a
 * state that's almost certainly going to be rejected by Amazon
 * (missing MAIN, sub-1000px image, broken URL). Soft warnings let
 * the operator publish anyway — they're heuristic signals, not
 * Amazon spec violations.
 *
 * Hard fails (blocking):
 *   • MAIN_MISSING — ASIN has no MAIN image resolved. Amazon rejects
 *     the entire listing — there's no point submitting.
 *   • IMAGE_TOO_SMALL — resolved image's stored dimensions are below
 *     the Amazon minimum (PLATFORM_RULES.AMAZON.minDimensionPx).
 *   • URL_INVALID — resolved image has no URL or a malformed URL.
 *
 * Soft warnings (informational):
 *   • SWCH_MISSING_ON_COLOR — color variant has no SWCH (swatch);
 *     Amazon's UI shows a less-rich preview but the listing still
 *     publishes.
 *   • TOO_FEW_IMAGES — ASIN has fewer than 3 slots filled. Listing
 *     quality suffers but submission isn't blocked.
 *   • MAIN_NOT_WHITE_BG — vision analysis (when available) flagged the
 *     MAIN image as not having a clean white background.
 */

import prisma from '../../db.js'
import { PLATFORM_RULES } from '@nexus/shared/image-validation'
import { buildAmazonImagePreview } from './amazon-image-preview.service.js'

export interface ValidationIssue {
  sku: string
  asin: string | null
  slot: string | null
  code: string
  message: string
  /** Blocking issues prevent publish; warnings are informational only. */
  level: 'error' | 'warning'
}

export interface ValidationResult {
  productId: string
  marketplace: string
  activeAxis: string | null
  hardFails: ValidationIssue[]
  softWarnings: ValidationIssue[]
  /** ASINs with at least one hard fail. The publisher / ZIP exporter
   *  skips these so the operator can fix-and-resubmit without
   *  wholesale-rejecting the batch. */
  blockedAsins: Set<string>
  summary: {
    totalAsins: number
    asinsWithIssues: number
    asinsBlocked: number
  }
}

const AMAZON_MIN_DIM = PLATFORM_RULES.AMAZON.minDimensionPx
const MIN_IMAGES_RECOMMENDED = 3

function isLikelyUrl(s: string): boolean {
  if (!s) return false
  try { new URL(s); return true } catch { return false }
}

/**
 * Validate the per-ASIN per-slot publish plan for one marketplace.
 *
 * Returns a structured ValidationResult. Callers (publisher, ZIP
 * exporter, preview modal) decide what to do with hard fails:
 *   • publisher → 422 with the issues array; refuses to submit
 *   • ZIP exporter → skip blocked ASINs with a clear reason
 *   • preview modal → red banner with the issues, disables Publish
 *
 * The validator queries dimensions from ListingImage + ProductImage
 * (the master gallery) so the resolver's `listingImageId` resolves
 * to a real row with width/height. The IE.2 backfill populated these
 * on 4626 rows so most checks have real numbers to read.
 */
export async function validateAmazonPublish(input: {
  productId: string
  marketplace: string
  activeAxis?: string | null
  variantIds?: string[]
}): Promise<ValidationResult> {
  const preview = await buildAmazonImagePreview(input)

  // Batch-fetch dimensions for every listingImageId in the plan.
  // The preview ships the listingImageIds; we walk them once to
  // resolve width/height/hasWhiteBackground. Master rows feed back
  // when sourceProductImageId is set so IE.6's effective-URL
  // resolver lines up with the validator.
  const listingIds = new Set<string>()
  for (const row of preview.rows) {
    for (const slot of Object.keys(row.slots)) {
      const cell = row.slots[slot as keyof typeof row.slots]
      if (cell?.listingImageId) listingIds.add(cell.listingImageId)
    }
  }

  const listingImages = listingIds.size > 0
    ? await prisma.listingImage.findMany({
        where: { id: { in: Array.from(listingIds) } },
        select: { id: true, url: true, width: true, height: true, hasWhiteBackground: true, sourceProductImageId: true },
      })
    : []
  const listingById = new Map(listingImages.map((li) => [li.id, li]))

  // For listing images that link to a master, prefer the master's
  // dimensions — IE.6 made the master the source of truth for URL +
  // dimensions, so the publisher will send the master image and the
  // validator should check against that.
  const masterIds = Array.from(new Set(
    listingImages
      .map((li) => li.sourceProductImageId)
      .filter((v): v is string => !!v),
  ))
  const masters = masterIds.length > 0
    ? await prisma.productImage.findMany({
        where: { id: { in: masterIds } },
        select: { id: true, url: true, width: true, height: true, aiHasWhiteBackground: true },
      })
    : []
  const masterById = new Map(masters.map((m) => [m.id, m]))

  function dimsAndUrlFor(listingImageId: string): { url: string; width: number | null; height: number | null; hasWhiteBg: boolean | null } {
    const li = listingById.get(listingImageId)
    if (!li) return { url: '', width: null, height: null, hasWhiteBg: null }
    if (li.sourceProductImageId) {
      const m = masterById.get(li.sourceProductImageId)
      if (m) {
        return {
          url: m.url,
          width: m.width,
          height: m.height,
          hasWhiteBg: m.aiHasWhiteBackground ?? li.hasWhiteBackground ?? null,
        }
      }
    }
    return {
      url: li.url,
      width: li.width,
      height: li.height,
      hasWhiteBg: li.hasWhiteBackground ?? null,
    }
  }

  const hardFails: ValidationIssue[] = []
  const softWarnings: ValidationIssue[] = []
  const blockedAsins = new Set<string>()

  for (const row of preview.rows) {
    if (!row.amazonAsin) continue // No ASIN on this marketplace — already skipped by publisher

    // MAIN_MISSING — Amazon rejects the entire listing without a
    // MAIN. Blocking, no exceptions.
    if (!row.hasMain) {
      hardFails.push({
        sku: row.sku,
        asin: row.amazonAsin,
        slot: 'MAIN',
        code: 'MAIN_MISSING',
        message: 'Amazon requires a MAIN image on every listing. Add one before publishing.',
        level: 'error',
      })
      blockedAsins.add(row.amazonAsin)
    }

    // Per-slot dimension + URL checks. Each slot is checked
    // independently — a sub-1000px MAIN blocks the ASIN; a sub-
    // 1000px PT04 only blocks that slot's accept (Amazon will still
    // accept the ASIN with fewer images).
    let filledSlotCount = 0
    let swatchPresent = false
    const colorAttr = row.attributes.Color ?? row.attributes.color ?? null
    for (const [slot, cell] of Object.entries(row.slots)) {
      if (!cell) continue
      filledSlotCount++
      if (slot === 'SWCH') swatchPresent = true
      const dims = dimsAndUrlFor(cell.listingImageId)

      if (!isLikelyUrl(dims.url)) {
        hardFails.push({
          sku: row.sku,
          asin: row.amazonAsin,
          slot,
          code: 'URL_INVALID',
          message: `Image URL for ${slot} is missing or malformed.`,
          level: 'error',
        })
        blockedAsins.add(row.amazonAsin)
      }

      const longEdge = Math.max(dims.width ?? 0, dims.height ?? 0)
      if (longEdge > 0 && longEdge < AMAZON_MIN_DIM) {
        const issue: ValidationIssue = {
          sku: row.sku,
          asin: row.amazonAsin,
          slot,
          code: 'IMAGE_TOO_SMALL',
          message: `${slot} image is ${dims.width}×${dims.height} — Amazon requires at least ${AMAZON_MIN_DIM}px on the long edge.`,
          level: 'error',
        }
        hardFails.push(issue)
        // Only MAIN's failure blocks the ASIN; PT slot failures just
        // skip that slot but the rest of the ASIN can still publish.
        if (slot === 'MAIN') blockedAsins.add(row.amazonAsin)
      }

      if (slot === 'MAIN' && dims.hasWhiteBg === false) {
        softWarnings.push({
          sku: row.sku,
          asin: row.amazonAsin,
          slot: 'MAIN',
          code: 'MAIN_NOT_WHITE_BG',
          message: 'Amazon prefers a pure white background on the MAIN image.',
          level: 'warning',
        })
      }
    }

    if (filledSlotCount < MIN_IMAGES_RECOMMENDED) {
      softWarnings.push({
        sku: row.sku,
        asin: row.amazonAsin,
        slot: null,
        code: 'TOO_FEW_IMAGES',
        message: `Only ${filledSlotCount} image${filledSlotCount === 1 ? '' : 's'} resolved — Amazon recommends at least ${MIN_IMAGES_RECOMMENDED}.`,
        level: 'warning',
      })
    }

    if (colorAttr && !swatchPresent) {
      softWarnings.push({
        sku: row.sku,
        asin: row.amazonAsin,
        slot: 'SWCH',
        code: 'SWCH_MISSING_ON_COLOR',
        message: `Color variant "${colorAttr}" has no SWCH — Amazon's color picker UI looks less rich without one.`,
        level: 'warning',
      })
    }
  }

  const asinsWithIssues = new Set<string>()
  for (const i of [...hardFails, ...softWarnings]) {
    if (i.asin) asinsWithIssues.add(i.asin)
  }

  return {
    productId: input.productId,
    marketplace: preview.marketplace,
    activeAxis: preview.activeAxis,
    hardFails,
    softWarnings,
    blockedAsins,
    summary: {
      totalAsins: preview.variantsWithAsin,
      asinsWithIssues: asinsWithIssues.size,
      asinsBlocked: blockedAsins.size,
    },
  }
}
