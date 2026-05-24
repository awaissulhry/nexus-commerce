/**
 * eBay Listing Cockpit API
 *
 * Endpoints that back /products/[id]/edit?tab=EBAY's cockpit cards.
 * Kept in its OWN file to honour the EC-series hard constraint of
 * not touching ebay-flat-file.routes.ts or its callers.
 *
 *   POST  /api/ebay/cockpit/suggest-categories  — EC.4: eBay's
 *           get_category_suggestions wrapper that takes a free-text
 *           query (title + description). Returns ranked candidates.
 *   GET   /api/ebay/cockpit/category-map        — EC.4: given a
 *           source (marketplace, categoryId), return the best
 *           matching category in each requested target marketplace.
 *           Used by CategoryPickerModal's per-marketplace tab to
 *           auto-suggest sister categories.
 *   PATCH /api/ebay/cockpit/category            — EC.4: persist a
 *           picked category to ChannelListing.platformAttributes.
 *           {categoryId, categoryName} for one (productId, EBAY,
 *           marketplace). Preserves existing itemSpecifics so
 *           re-categorising never silently clears aspect work.
 *   PATCH /api/ebay/cockpit/aspects             — EC.5: persist the
 *           itemSpecifics map (aspectName → value[]) for one
 *           (productId, EBAY, marketplace). Merges into existing
 *           platformAttributes so unrelated keys (categoryId,
 *           policy refs, etc.) are untouched. Accepts BOTH single
 *           strings and string arrays — eBay aspects are
 *           multi-value at the wire level.
 *   GET   /api/ebay/cockpit/variation-cells     — EC.6: per-child
 *           cell snapshots for the variation matrix (SKU, axis
 *           values, price, qty, listing status) for a given
 *           (parentProductId, marketplace).
 *   PATCH /api/ebay/cockpit/variation-matrix    — EC.6: atomic
 *           save of axes + sort order on the parent listing AND
 *           per-cell price/qty overrides on each child listing.
 *   PATCH /api/ebay/cockpit/offer-policies      — EC.8: persist
 *           Best Offer settings (enabled / auto-accept / auto-
 *           decline) and policy refs (fulfillment / payment /
 *           return / merchantLocationKey) for one (productId,
 *           marketplace). Merges into platformAttributes — never
 *           touches categoryId, itemSpecifics, variation axes.
 *
 * All endpoints reuse the EbayCategoryService singleton (in-memory
 * 24h caches for search + aspects). No changes to flat-file routes.
 */

import type { FastifyInstance } from 'fastify'
import { Prisma } from '@nexus/database'
import prisma from '../db.js'
import { EbayCategoryService } from '../services/ebay-category.service.js'

const ebayCategoryService = new EbayCategoryService()

// Normalise marketplace codes the cockpit sends ("IT", "DE", ...) to
// the EBAY_<CODE> form the service expects. Idempotent — already
// prefixed values pass through.
function normaliseMarketplace(code: string): string {
  if (!code) return 'EBAY_IT'
  if (code.startsWith('EBAY_')) return code
  return `EBAY_${code.toUpperCase()}`
}

interface CategorySuggestion {
  id: string
  name: string
  path: string
  matchScore: number
}

export default async function ebayCockpitRoutes(fastify: FastifyInstance) {
  // ── POST /api/ebay/cockpit/suggest-categories ───────────────────────
  // Wraps EbayCategoryService.searchCategories with listing-friendly
  // inputs (title + description). Returns top N ranked candidates so
  // the picker can show all good matches, not just the top one.
  fastify.post<{
    Body: {
      marketplace: string
      title?: string
      description?: string
      limit?: number
    }
  }>('/ebay/cockpit/suggest-categories', async (request, reply) => {
    const { marketplace, title = '', description = '', limit = 8 } = request.body ?? {}

    if (!marketplace) {
      return reply.code(400).send({ error: 'marketplace is required' })
    }

    // Use the title as the primary query; descriptions are too long
    // for eBay's keyword endpoint and noise drowns out the signal.
    // Falls back to first N words of description if title is empty.
    let query = title.trim()
    if (!query && description) {
      query = description.trim().split(/\s+/).slice(0, 12).join(' ')
    }
    if (!query || query.length < 2) {
      return reply.send({ suggestions: [], query: '' })
    }

    try {
      const items = await ebayCategoryService.searchCategories(
        normaliseMarketplace(marketplace),
        query,
        { throwOnError: false, limit },
      )
      const suggestions: CategorySuggestion[] = items.map((item) => ({
        id: item.productType,
        name: item.displayName.split(' › ').pop() ?? item.displayName,
        path: item.displayName,
        matchScore: item.matchPercentage ?? 0,
      }))
      return reply.send({ suggestions, query })
    } catch (err) {
      request.log.error(err, 'ebay/cockpit/suggest-categories failed')
      return reply
        .code(500)
        .send({ error: err instanceof Error ? err.message : 'Suggest failed' })
    }
  })

  // ── GET /api/ebay/cockpit/category-map ──────────────────────────────
  // Given a source (marketplace, categoryId), search each target
  // marketplace's tree for the same category NAME and return the best
  // match. eBay category trees are roughly parallel across EU sites
  // but IDs differ, so name-match is the cheapest reliable mapping.
  //
  // Query: ?source=IT&categoryName=Motorbike+Helmets&targets=DE,FR,ES,UK
  fastify.get<{
    Querystring: {
      source: string
      categoryName: string
      targets: string
    }
  }>('/ebay/cockpit/category-map', async (request, reply) => {
    const { source, categoryName, targets } = request.query

    if (!source || !categoryName || !targets) {
      return reply
        .code(400)
        .send({ error: 'source, categoryName, targets are required' })
    }

    const targetCodes = targets
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (targetCodes.length === 0) {
      return reply.send({ map: {} })
    }

    const map: Record<
      string,
      { id: string; name: string; path: string; matchScore: number } | null
    > = {}

    await Promise.all(
      targetCodes.map(async (code) => {
        try {
          const items = await ebayCategoryService.searchCategories(
            normaliseMarketplace(code),
            categoryName,
            { throwOnError: false, limit: 1 },
          )
          const first = items[0]
          map[code] = first
            ? {
                id: first.productType,
                name: first.displayName.split(' › ').pop() ?? first.displayName,
                path: first.displayName,
                matchScore: first.matchPercentage ?? 0,
              }
            : null
        } catch {
          map[code] = null
        }
      }),
    )

    return reply.send({ map, source, categoryName })
  })

  // ── PATCH /api/ebay/cockpit/category ────────────────────────────────
  // Persist the picked category for one (productId, EBAY, marketplace).
  // Find-or-create the ChannelListing row, then merge categoryId +
  // categoryName into platformAttributes. itemSpecifics is LEFT ALONE
  // — the new category schema reconciliation happens at render time
  // (EC.5's Aspects card filters what's still valid). _categoryHistory
  // gets an audit entry so operators can see prior categories.
  fastify.patch<{
    Body: {
      productId: string
      marketplace: string
      categoryId: string
      categoryName?: string
      categoryPath?: string
    }
  }>('/ebay/cockpit/category', async (request, reply) => {
    const { productId, marketplace, categoryId, categoryName, categoryPath } =
      request.body ?? ({} as Record<string, string | undefined>)

    if (!productId || !marketplace || !categoryId) {
      return reply
        .code(400)
        .send({ error: 'productId, marketplace, categoryId are required' })
    }

    // Look up the product so we can hand a richer 404 to the operator
    // (vs. a Prisma constraint violation when find-or-create fires).
    const product = await prisma.product.findUnique({
      where: { id: productId },
      select: { id: true },
    })
    if (!product) {
      return reply.code(404).send({ error: 'Product not found' })
    }

    // Find or create the eBay ChannelListing for this marketplace.
    // channelMarket is the legacy composite key (CHANNEL_REGION).
    const channelMarket = `EBAY_${marketplace.toUpperCase()}`
    const existing = await prisma.channelListing.findFirst({
      where: { productId, channel: 'EBAY', marketplace },
    })

    const prevPlatform = (existing?.platformAttributes ?? {}) as Record<string, unknown>
    const prevHistory = Array.isArray((prevPlatform as { _categoryHistory?: unknown })._categoryHistory)
      ? ((prevPlatform as { _categoryHistory?: Array<unknown> })._categoryHistory ?? [])
      : []
    const nextHistory = [
      {
        ts: new Date().toISOString(),
        categoryId: (prevPlatform.categoryId as string | undefined) ?? null,
        categoryName: (prevPlatform.categoryName as string | undefined) ?? null,
      },
      ...prevHistory,
    ].slice(0, 10)

    const nextPlatform: Record<string, unknown> = {
      ...prevPlatform,
      categoryId,
      categoryName: categoryName ?? prevPlatform.categoryName ?? null,
      categoryPath: categoryPath ?? prevPlatform.categoryPath ?? null,
      _categoryHistory: nextHistory,
    }

    const saved = existing
      ? await prisma.channelListing.update({
          where: { id: existing.id },
          data: {
            platformAttributes: nextPlatform as Prisma.InputJsonValue,
          },
        })
      : await prisma.channelListing.create({
          data: {
            productId,
            channel: 'EBAY',
            region: marketplace.toUpperCase(),
            marketplace,
            channelMarket,
            listingStatus: 'DRAFT',
            isPublished: false,
            platformAttributes: nextPlatform as Prisma.InputJsonValue,
          },
        })

    return reply.send({
      listingId: saved.id,
      categoryId,
      categoryName: categoryName ?? null,
      categoryPath: categoryPath ?? null,
      historyDepth: nextHistory.length,
    })
  })

  // ── PATCH /api/ebay/cockpit/aspects ─────────────────────────────────
  // Persist itemSpecifics for one (productId, EBAY, marketplace).
  // Body shape: { aspects: Record<aspectName, string | string[]> }
  // Single strings are wrapped into arrays before persisting so the
  // wire format always matches eBay's Sell-Inventory contract
  // (Inventory API + Trading API both expect array values).
  //
  // The endpoint MERGES the supplied aspects into existing
  // itemSpecifics — keys present in the body overwrite, keys absent
  // are preserved. To CLEAR an aspect, send an empty array.
  // categoryId / policy refs / other platformAttributes keys are
  // never touched.
  fastify.patch<{
    Body: {
      productId: string
      marketplace: string
      aspects: Record<string, string | string[]>
    }
  }>('/ebay/cockpit/aspects', async (request, reply) => {
    const { productId, marketplace, aspects } = request.body ?? ({} as Record<string, unknown>)

    if (!productId || !marketplace || !aspects || typeof aspects !== 'object') {
      return reply
        .code(400)
        .send({ error: 'productId, marketplace, aspects are required' })
    }

    const existing = await prisma.channelListing.findFirst({
      where: { productId, channel: 'EBAY', marketplace },
    })
    if (!existing) {
      // We deliberately refuse to create a ChannelListing from the
      // aspects endpoint — the category should always be picked
      // first (EC.4 creates the row). Returning 409 makes the UI's
      // failure mode legible.
      return reply.code(409).send({ error: 'No eBay listing for this marketplace — pick a category first.' })
    }

    const prevPlatform = (existing.platformAttributes ?? {}) as Record<string, unknown>
    const prevItemSpecifics =
      typeof prevPlatform.itemSpecifics === 'object' && prevPlatform.itemSpecifics !== null
        ? (prevPlatform.itemSpecifics as Record<string, string[]>)
        : {}

    // Normalise: every value becomes string[] (eBay wire format).
    const normalised: Record<string, string[]> = { ...prevItemSpecifics }
    for (const [name, raw] of Object.entries(aspects)) {
      if (Array.isArray(raw)) {
        const cleaned = raw.map((v) => String(v ?? '').trim()).filter((v) => v.length > 0)
        if (cleaned.length === 0) delete normalised[name]
        else normalised[name] = cleaned
      } else if (raw == null || String(raw).trim() === '') {
        delete normalised[name]
      } else {
        normalised[name] = [String(raw).trim()]
      }
    }

    const nextPlatform: Record<string, unknown> = {
      ...prevPlatform,
      itemSpecifics: normalised,
    }

    const saved = await prisma.channelListing.update({
      where: { id: existing.id },
      data: { platformAttributes: nextPlatform as Prisma.InputJsonValue },
    })

    return reply.send({
      listingId: saved.id,
      aspectCount: Object.keys(normalised).length,
    })
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
      select: { id: true, variationAxes: true },
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

    const children = await prisma.product.findMany({
      where: { parentId: parentProductId },
      select: {
        id: true,
        sku: true,
        // ProductVariation rows are deprecated; the canonical shape is
        // child Product.variationAttributes JSON. Some product schemas
        // mirror axis values onto the child as well via Phase 31 —
        // either path lights up the matrix.
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

    // Also re-fetch the children with variationAttributes via raw SQL
    // since the field isn't typed on Product (it's JSON). Simpler:
    // re-query with raw select.
    const childAttrs = await prisma.$queryRaw<
      Array<{ id: string; variationAttributes: Record<string, string> | null }>
    >`SELECT id, "variationAttributes" FROM "Product" WHERE id = ANY(${childIds}::text[])`
    const attrsById = new Map(childAttrs.map((c) => [c.id, c.variationAttributes ?? {}]))

    const cells = children.map((c) => {
      const listing = listingByProductId.get(c.id)
      return {
        childProductId: c.id,
        sku: c.sku,
        variationAttributes: attrsById.get(c.id) ?? {},
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

    return reply.send({
      parentProductId,
      marketplace,
      declaredAxes: parent.variationAxes ?? [],
      pickedAxes,
      axisSortOrder,
      cells,
      childCount: cells.length,
    })
  })

  // ── PATCH /api/ebay/cockpit/variation-matrix ────────────────────────
  // Atomic save: parent's chosen axes + sort order + per-cell child
  // overrides. Anything missing from the body is left alone — partial
  // edits are safe. Returns the same shape as the GET so the UI can
  // refresh from the response without a second round-trip.
  //
  // Body:
  //   {
  //     parentProductId, marketplace,
  //     pickedAxes?:    string[]             // ≤ 2 axes
  //     axisSortOrder?: { [axis]: string[] }
  //     cells?:         [{ childProductId, priceOverride?, quantity? }]
  //   }
  fastify.patch<{
    Body: {
      parentProductId: string
      marketplace: string
      pickedAxes?: string[]
      axisSortOrder?: Record<string, string[]>
      cells?: Array<{
        childProductId: string
        priceOverride?: number | null
        quantity?: number | null
      }>
    }
  }>('/ebay/cockpit/variation-matrix', async (request, reply) => {
    const body = request.body
    if (!body || typeof body !== 'object') {
      return reply.code(400).send({ error: 'Body is required' })
    }
    const { parentProductId, marketplace, pickedAxes, axisSortOrder, cells } = body

    if (!parentProductId || !marketplace) {
      return reply.code(400).send({ error: 'parentProductId, marketplace are required' })
    }

    // ── Parent: axes + sort order on platformAttributes ────────────
    if (pickedAxes !== undefined || axisSortOrder !== undefined) {
      const parentListing = await prisma.channelListing.findFirst({
        where: { productId: parentProductId, channel: 'EBAY', marketplace },
      })
      const prevPlatform = (parentListing?.platformAttributes ?? {}) as Record<string, unknown>
      const nextPlatform: Record<string, unknown> = { ...prevPlatform }
      if (pickedAxes !== undefined) {
        nextPlatform._variationAxes = (pickedAxes ?? []).slice(0, 2)
      }
      if (axisSortOrder !== undefined) {
        nextPlatform._axisSortOrder = axisSortOrder
      }

      if (parentListing) {
        await prisma.channelListing.update({
          where: { id: parentListing.id },
          data: { platformAttributes: nextPlatform as Prisma.InputJsonValue },
        })
      } else {
        await prisma.channelListing.create({
          data: {
            productId: parentProductId,
            channel: 'EBAY',
            region: marketplace.toUpperCase(),
            marketplace,
            channelMarket: `EBAY_${marketplace.toUpperCase()}`,
            listingStatus: 'DRAFT',
            isPublished: false,
            platformAttributes: nextPlatform as Prisma.InputJsonValue,
          },
        })
      }
    }

    // ── Per-cell child overrides ───────────────────────────────────
    const updates: Array<{ childProductId: string; listingId: string }> = []
    if (Array.isArray(cells) && cells.length > 0) {
      for (const cell of cells) {
        if (!cell?.childProductId) continue
        const existing = await prisma.channelListing.findFirst({
          where: { productId: cell.childProductId, channel: 'EBAY', marketplace },
        })
        const data: Prisma.ChannelListingUpdateInput = {}
        if (cell.priceOverride !== undefined) {
          data.priceOverride = cell.priceOverride === null ? null : new Prisma.Decimal(cell.priceOverride)
        }
        if (cell.quantity !== undefined) {
          data.quantity = cell.quantity
        }
        const saved = existing
          ? await prisma.channelListing.update({
              where: { id: existing.id },
              data,
            })
          : await prisma.channelListing.create({
              data: {
                productId: cell.childProductId,
                channel: 'EBAY',
                region: marketplace.toUpperCase(),
                marketplace,
                channelMarket: `EBAY_${marketplace.toUpperCase()}`,
                listingStatus: 'DRAFT',
                isPublished: false,
                priceOverride: cell.priceOverride != null ? new Prisma.Decimal(cell.priceOverride) : null,
                quantity: cell.quantity ?? null,
              },
            })
        updates.push({ childProductId: cell.childProductId, listingId: saved.id })
      }
    }

    return reply.send({
      parentProductId,
      marketplace,
      updatedCells: updates.length,
      cells: updates,
    })
  })

  // ── PATCH /api/ebay/cockpit/offer-policies ──────────────────────────
  // Best Offer + policy refs for one (productId, EBAY, marketplace).
  // Body fields are all optional — supplied keys overwrite, omitted
  // keys are preserved. categoryId / itemSpecifics / variation axes
  // are never touched. Pricing stays in its own
  // (POST /api/products/:id/listings/:ch/:mp/pricing) endpoint —
  // not folded here because that endpoint also updates pricingRule
  // + priceAdjustmentPercent on dedicated ChannelListing columns.
  fastify.patch<{
    Body: {
      productId: string
      marketplace: string
      bestOfferEnabled?: boolean
      bestOfferAutoAcceptPrice?: number | null
      bestOfferMinAcceptPrice?: number | null
      fulfillmentPolicyId?: string | null
      paymentPolicyId?: string | null
      returnPolicyId?: string | null
      merchantLocationKey?: string | null
    }
  }>('/ebay/cockpit/offer-policies', async (request, reply) => {
    const body = request.body
    if (!body || typeof body !== 'object') {
      return reply.code(400).send({ error: 'Body is required' })
    }
    const { productId, marketplace, ...rest } = body
    if (!productId || !marketplace) {
      return reply.code(400).send({ error: 'productId, marketplace are required' })
    }

    const existing = await prisma.channelListing.findFirst({
      where: { productId, channel: 'EBAY', marketplace },
    })
    if (!existing) {
      return reply
        .code(409)
        .send({ error: 'No eBay listing for this marketplace — pick a category first.' })
    }

    const prevPlatform = (existing.platformAttributes ?? {}) as Record<string, unknown>
    const nextPlatform: Record<string, unknown> = { ...prevPlatform }

    const KEYS: Array<keyof typeof rest> = [
      'bestOfferEnabled',
      'bestOfferAutoAcceptPrice',
      'bestOfferMinAcceptPrice',
      'fulfillmentPolicyId',
      'paymentPolicyId',
      'returnPolicyId',
      'merchantLocationKey',
    ]
    for (const k of KEYS) {
      if (rest[k] !== undefined) {
        nextPlatform[k] = rest[k]
      }
    }

    const saved = await prisma.channelListing.update({
      where: { id: existing.id },
      data: { platformAttributes: nextPlatform as Prisma.InputJsonValue },
    })

    return reply.send({
      listingId: saved.id,
      applied: KEYS.filter((k) => rest[k] !== undefined),
    })
  })
}
