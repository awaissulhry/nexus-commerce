/**
 * eBay Listing Cockpit API — the two reads/writes live pages still call.
 *
 *   GET   /api/ebay/cockpit/presentation-order  — the saved eBay presentation
 *   PUT   /api/ebay/cockpit/presentation-order    order for one destination
 *           (ebay-flat-file Presentation/OrderEditor).
 *   GET   /api/ebay/cockpit/variation-cells     — EC.6: per-child
 *           cell snapshots for the variation matrix (SKU, axis
 *           values, price, qty, listing status) for a given
 *           (parentProductId, marketplace). Read by EbayFlatFileClient.
 *
 * Kept in its OWN file to honour the EC-series hard constraint of
 * not touching ebay-flat-file.routes.ts or its callers.
 *
 * Step 7, part 3 deleted three writers that created a missing eBay listing
 * as a DRAFT and that only the unmounted old product editor called:
 * PATCH /category, PATCH /variation-matrix and POST /template-apply. The
 * old editor's deletion took the rest of its cockpit endpoints with it:
 * suggest-categories, category-map, aspects, file-exchange-csv,
 * offer-policies, snapshot, snapshot/restore, publish, ai-improve,
 * compatibility, template-candidates and promote-to-master.
 */

import type { FastifyInstance } from 'fastify'
import prisma from '../db.js'
import { parseThemeAxes } from '../services/ebay-theme-axes.js'
import { resolveFamilyAxes } from '../services/ebay-family-axes.service.js'
import { readPresentationOrder, savePresentationOrder, type PresentationDestinationInput, type PresentationOrderChange } from '../services/ebay-presentation-order.service.js'

export default async function ebayCockpitRoutes(fastify: FastifyInstance) {
  fastify.get<{ Querystring: PresentationDestinationInput }>('/ebay/cockpit/presentation-order', async request => readPresentationOrder(request.query))
  fastify.put<{ Body: PresentationDestinationInput & { expectedVersion: number; expectedToken: string; change: PresentationOrderChange } }>('/ebay/cockpit/presentation-order', async (request, reply) => {
    if (!request.body?.change || typeof request.body.expectedToken !== 'string' || !Number.isInteger(request.body.expectedVersion)) return reply.code(400).send({ error: 'A current listing version, input token and order change are required' })
    return savePresentationOrder(request.body, (request as any).user?.id ?? (request as any).authUser?.id ?? null)
  })
  // ── GET /api/ebay/cockpit/variation-cells ───────────────────────────
  // Per-child cell snapshot for the variation matrix. Returns one row
  // per child product with axis values, current eBay listing price /
  // quantity / status for the given marketplace, plus the parent
  // listing's saved axis choice + sort order.
  fastify.get<{
    Querystring: { parentProductId: string; marketplace: string }
  }>('/ebay/cockpit/variation-cells', async (request, reply) => {
    const { parentProductId, marketplace } = request.query
    if (!parentProductId || !marketplace) {
      return reply.code(400).send({ error: 'parentProductId, marketplace are required' })
    }

    const parent = await prisma.product.findUnique({
      where: { id: parentProductId },
      select: { id: true, variationAxes: true, variationTheme: true },
    })
    if (!parent) {
      return reply.code(404).send({ error: 'Parent product not found' })
    }

    const parentListing = await prisma.channelListing.findFirst({
      where: { productId: parentProductId, channel: 'EBAY', marketplace },
      select: { id: true, platformAttributes: true },
    })
    const parentPlatform = (parentListing?.platformAttributes ?? {}) as Record<string, unknown>
    const pickedAxes = Array.isArray(parentPlatform._variationAxes)
      ? (parentPlatform._variationAxes as string[]).filter((s) => typeof s === 'string')
      : []
    const axisSortOrder =
      typeof parentPlatform._axisSortOrder === 'object' && parentPlatform._axisSortOrder !== null
        ? (parentPlatform._axisSortOrder as Record<string, string[]>)
        : {}
    // EFX D1 — the VariationValueOrderModal's own value-order store (keyed by
    // axisSynonymKey: __dim0__/__dim1__/lowercase-custom). Returned so the modal
    // can reload exactly what it saved. Additive only.
    const axisValueOrder =
      typeof parentPlatform._axisValueOrder === 'object' && parentPlatform._axisValueOrder !== null
        ? (parentPlatform._axisValueOrder as Record<string, string[]>)
        : {}
    // EV.4 — eBay-only renames. Names: { Color: "Colour" }. Values:
    // { Color: { Giallo: "Yellow" } }. Display + publish overrides only;
    // the canonical variant data is never mutated.
    const axisNameLabels =
      typeof parentPlatform._axisNameLabels === 'object' && parentPlatform._axisNameLabels !== null
        ? (parentPlatform._axisNameLabels as Record<string, string>)
        : {}
    const axisValueLabels =
      typeof parentPlatform._axisValueLabels === 'object' && parentPlatform._axisValueLabels !== null
        ? (parentPlatform._axisValueLabels as Record<string, Record<string, string>>)
        : {}

    // EV.1 — axis values live in categoryAttributes.variations
    // ({ Size, Color }); variantAttributes is the deprecated/empty field
    // EC.6 wrongly read (which is why the matrix showed no variants).
    const children = await prisma.product.findMany({
      where: { parentId: parentProductId },
      select: {
        id: true,
        sku: true,
        variantAttributes: true,
        categoryAttributes: true,
      },
    })

    // Pull each child's eBay listing for this marketplace in one go.
    const childIds = children.map((c) => c.id)
    const childListings = await prisma.channelListing.findMany({
      where: { productId: { in: childIds }, channel: 'EBAY', marketplace },
      select: {
        id: true,
        productId: true,
        priceOverride: true,
        price: true,
        quantity: true,
        listingStatus: true,
        externalListingId: true,
        platformAttributes: true,
      },
    })
    const listingByProductId = new Map(childListings.map((l) => [l.productId, l]))

    const cells = children.map((c) => {
      const listing = listingByProductId.get(c.id)
      // EV.1 — prefer categoryAttributes.variations (the real axis map),
      // fall back to the legacy variantAttributes.
      const cat = (c.categoryAttributes ?? null) as { variations?: Record<string, string> } | null
      const attrs =
        (cat?.variations && typeof cat.variations === 'object'
          ? cat.variations
          : (c.variantAttributes as Record<string, string> | null)) ?? {}
      return {
        childProductId: c.id,
        sku: c.sku,
        variationAttributes: attrs,
        listing: listing
          ? {
              id: listing.id,
              priceOverride: listing.priceOverride ? Number(listing.priceOverride) : null,
              price: listing.price ? Number(listing.price) : null,
              quantity: listing.quantity ?? null,
              listingStatus: listing.listingStatus,
              externalListingId: listing.externalListingId,
            }
          : null,
      }
    })

    // EV.1 — declared axes: explicit variationAxes if set, else split the
    // variationTheme ("Size / Color"), else the union of the children's
    // variation keys (preserving first-seen order).
    let declaredAxes: string[] =
      Array.isArray(parent.variationAxes) && parent.variationAxes.length > 0
        ? (parent.variationAxes as string[])
        : []
    if (declaredAxes.length === 0 && parent.variationTheme) {
      declaredAxes = parseThemeAxes(parent.variationTheme) // EFX D4 — one parser (, / | ;)
    }
    if (declaredAxes.length === 0) {
      const seen: string[] = []
      for (const cell of cells) {
        for (const k of Object.keys(cell.variationAttributes)) {
          if (!seen.includes(k)) seen.push(k)
        }
      }
      declaredAxes = seen
    }

    // EFX Layer A (additive) — ONE theme-authoritative axis catalog + the
    // widest theme-input candidate list, from the shared server helper that
    // mirrors the push. `resolvedAxes` obeys the declared Variation Theme
    // (synonym+fingerprint-deduped, ghosts suppressed, one clean value list);
    // `axisCandidates` is the union for the theme combobox. Existing fields
    // above are untouched — clients migrate at their own pace.
    const { axes: resolvedAxes, warnings: resolvedAxisWarnings, suppressed: resolvedAxisSuppressed, candidates: axisCandidates } =
      await resolveFamilyAxes(parentProductId, marketplace)

    return reply.send({
      parentProductId,
      marketplace,
      declaredAxes,
      pickedAxes,
      axisSortOrder,
      axisValueOrder,
      axisNameLabels,
      axisValueLabels,
      cells,
      childCount: cells.length,
      // EFX Layer A — additive, theme-authoritative:
      resolvedAxes,
      resolvedAxisWarnings,
      resolvedAxisSuppressed,
      axisCandidates,
    })
  })
}
