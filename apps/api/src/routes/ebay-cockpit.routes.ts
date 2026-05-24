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
 *   POST  /api/ebay/cockpit/snapshot            — EC.10: capture
 *           the listing's current platformAttributes + price +
 *           quantity into _versionHistory[]. Capped at 10 most
 *           recent. Used by the Version History drawer + auto-
 *           snapshot timer + the pre-publish gate (EC.11).
 *   POST  /api/ebay/cockpit/snapshot/restore    — EC.10: replays
 *           a named snapshot back onto the listing. Atomic update;
 *           the current state itself is snapshotted FIRST so undo
 *           is one click.
 *   POST  /api/ebay/cockpit/publish             — EC.11: publishes
 *           one (productId, marketplace) eBay listing via the
 *           EbayPublishAdapter's three-step Inventory API flow.
 *           Pre-snapshots first (reason="pre-publish") so a failed
 *           publish leaves a rollback point. On success persists
 *           externalListingId + listingUrl + listingStatus on the
 *           ChannelListing. Returns the adapter's structured
 *           per-step result.
 *   POST  /api/ebay/cockpit/ai-improve          — EC.12: Claude-
 *           backed listing assistant. Three operations:
 *           "essentials" (title + description), "aspects" (fills
 *           empty itemSpecifics), "compatibility" (EC.13 — suggests
 *           motorcycle year/make/model fitments from product type +
 *           brand). Returns structured JSON the AiImproveModal /
 *           CompatibilityCard render as selective-apply diffs.
 *   PATCH /api/ebay/cockpit/compatibility       — EC.13: persists
 *           motors compatibility — { universal: bool, fitments:
 *           [{year, make, model, submodel?}] } — to
 *           platformAttributes.compatibility. Used by the
 *           CompatibilityCard which only mounts for motors-relevant
 *           categories. Trading API sync (ItemCompatibilityList)
 *           deferred to EC.13b — the data persists here; the
 *           publish path picks it up when the wire format is wired.
 *   GET   /api/ebay/cockpit/template-candidates — EC.14: returns
 *           same-productType products with current eBay listing
 *           snapshot for diff preview. Used by the Apply-to-Siblings
 *           modal.
 *   POST  /api/ebay/cockpit/template-apply      — EC.14: copies
 *           layout (aspects + policies + best offer + variation
 *           axes + compatibility) from a donor listing to N target
 *           listings. Per-target pre-apply snapshot for rollback.
 *           Scoped — operator picks which layers to copy.
 *   POST  /api/ebay/cockpit/promote-to-master   — EC.15: pushes
 *           cockpit-edited title / description / basePrice back
 *           into the Product master record. Closes the loop so
 *           the cockpit isn't a divergence factory. Operator opts
 *           in per field via the MasterDivergenceBanner.
 *
 * All endpoints reuse the EbayCategoryService singleton (in-memory
 * 24h caches for search + aspects). No changes to flat-file routes.
 */

import type { FastifyInstance } from 'fastify'
import { Prisma } from '@nexus/database'
import prisma from '../db.js'
import { EbayCategoryService } from '../services/ebay-category.service.js'
import { EbayPublishAdapter } from '../services/listing-wizard/ebay-publish.adapter.js'
import { getProvider, isAiKillSwitchOn } from '../services/ai/providers/index.js'

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

  // ── POST /api/ebay/cockpit/snapshot ─────────────────────────────────
  // Capture the listing's current state as a versioned snapshot.
  // Snapshots live inside platformAttributes._versionHistory as a
  // capped array (10 most recent). Each entry:
  //   { id, ts, reason, snapshot: { platformAttributes, priceOverride,
  //                                 quantity } }
  // The `reason` field is free-text so the UI can label snapshots
  // ("auto", "pre-publish", "operator").
  fastify.post<{
    Body: {
      productId: string
      marketplace: string
      reason?: string
    }
  }>('/ebay/cockpit/snapshot', async (request, reply) => {
    const body = request.body
    if (!body) return reply.code(400).send({ error: 'Body is required' })
    const { productId, marketplace, reason = 'manual' } = body
    if (!productId || !marketplace) {
      return reply.code(400).send({ error: 'productId, marketplace are required' })
    }
    const listing = await prisma.channelListing.findFirst({
      where: { productId, channel: 'EBAY', marketplace },
    })
    if (!listing) {
      return reply.code(404).send({ error: 'No eBay listing for this marketplace yet' })
    }
    const prevPlatform = (listing.platformAttributes ?? {}) as Record<string, unknown>
    // Strip the existing _versionHistory from the snapshot itself so
    // we don't snapshot snapshots (storage blows up otherwise).
    const { _versionHistory: prevHistoryRaw, ...snapshotPlatform } = prevPlatform
    const prevHistory = Array.isArray(prevHistoryRaw) ? (prevHistoryRaw as unknown[]) : []
    const newEntry = {
      id: `snap_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      ts: new Date().toISOString(),
      reason: String(reason).slice(0, 40),
      snapshot: {
        platformAttributes: snapshotPlatform,
        priceOverride: listing.priceOverride != null ? Number(listing.priceOverride) : null,
        quantity: listing.quantity ?? null,
      },
    }
    const nextHistory = [newEntry, ...prevHistory].slice(0, 10)
    const nextPlatform: Record<string, unknown> = {
      ...prevPlatform,
      _versionHistory: nextHistory,
    }
    await prisma.channelListing.update({
      where: { id: listing.id },
      data: { platformAttributes: nextPlatform as Prisma.InputJsonValue },
    })
    return reply.send({
      listingId: listing.id,
      snapshotId: newEntry.id,
      historyDepth: nextHistory.length,
    })
  })

  // ── POST /api/ebay/cockpit/snapshot/restore ─────────────────────────
  // Replays a named snapshot. The CURRENT state gets snapshotted
  // first under reason="pre-restore" so the operator can undo with
  // one more click.
  fastify.post<{
    Body: {
      productId: string
      marketplace: string
      snapshotId: string
    }
  }>('/ebay/cockpit/snapshot/restore', async (request, reply) => {
    const body = request.body
    if (!body) return reply.code(400).send({ error: 'Body is required' })
    const { productId, marketplace, snapshotId } = body
    if (!productId || !marketplace || !snapshotId) {
      return reply.code(400).send({ error: 'productId, marketplace, snapshotId are required' })
    }
    const listing = await prisma.channelListing.findFirst({
      where: { productId, channel: 'EBAY', marketplace },
    })
    if (!listing) {
      return reply.code(404).send({ error: 'No eBay listing for this marketplace' })
    }
    const prevPlatform = (listing.platformAttributes ?? {}) as Record<string, unknown>
    const history = Array.isArray(prevPlatform._versionHistory)
      ? (prevPlatform._versionHistory as Array<{
          id: string
          ts: string
          reason: string
          snapshot: {
            platformAttributes: Record<string, unknown>
            priceOverride: number | null
            quantity: number | null
          }
        }>)
      : []
    const target = history.find((h) => h.id === snapshotId)
    if (!target) {
      return reply.code(404).send({ error: 'Snapshot not found in history' })
    }

    // 1) Snapshot the CURRENT state first under reason="pre-restore"
    //    so undo is one click. (Same shape as the regular snapshot.)
    const { _versionHistory: _ignore, ...currentPlatform } = prevPlatform
    const undoEntry = {
      id: `snap_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      ts: new Date().toISOString(),
      reason: 'pre-restore',
      snapshot: {
        platformAttributes: currentPlatform,
        priceOverride: listing.priceOverride != null ? Number(listing.priceOverride) : null,
        quantity: listing.quantity ?? null,
      },
    }

    // 2) Build the restored platformAttributes from target.snapshot,
    //    preserving _versionHistory (current + undo) so the operator
    //    can keep working on history after the restore.
    const restoredPlatform: Record<string, unknown> = {
      ...target.snapshot.platformAttributes,
      _versionHistory: [undoEntry, ...history].slice(0, 10),
    }

    const saved = await prisma.channelListing.update({
      where: { id: listing.id },
      data: {
        platformAttributes: restoredPlatform as Prisma.InputJsonValue,
        priceOverride: target.snapshot.priceOverride != null
          ? new Prisma.Decimal(target.snapshot.priceOverride)
          : null,
        quantity: target.snapshot.quantity ?? null,
      },
    })

    return reply.send({
      listingId: saved.id,
      restoredSnapshotId: snapshotId,
      undoSnapshotId: undoEntry.id,
    })
  })

  // ── POST /api/ebay/cockpit/publish ──────────────────────────────────
  // Drives the EbayPublishAdapter's three-step Inventory API flow
  // from the cockpit. Before firing the publish we auto-snapshot the
  // listing (reason="pre-publish") so a botched publish leaves a
  // one-click rollback point. On success we write the new externalIds
  // back to the ChannelListing so the cockpit's live preview surfaces
  // the public URL immediately.
  fastify.post<{
    Body: {
      productId: string
      marketplace: string
    }
  }>('/ebay/cockpit/publish', async (request, reply) => {
    const body = request.body
    if (!body) return reply.code(400).send({ error: 'Body is required' })
    const { productId, marketplace } = body
    if (!productId || !marketplace) {
      return reply.code(400).send({ error: 'productId, marketplace are required' })
    }

    // Load the product + its eBay listing for this marketplace.
    const product = await prisma.product.findUnique({
      where: { id: productId },
      include: {
        images: {
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
          select: { url: true, type: true, isPrimary: true },
        },
      },
    })
    if (!product) return reply.code(404).send({ error: 'Product not found' })
    const listing = await prisma.channelListing.findFirst({
      where: { productId, channel: 'EBAY', marketplace },
    })
    if (!listing) {
      return reply.code(409).send({
        error: 'No eBay listing for this marketplace — pick a category and aspects first.',
      })
    }
    const platform = (listing.platformAttributes ?? {}) as Record<string, unknown>

    // ── Pre-publish snapshot ────────────────────────────────────────
    // Same shape as POST /snapshot; inlined so we can guarantee it
    // runs in the same Prisma transaction-window as the persist below.
    const { _versionHistory: prevHistoryRaw, ...snapshotPlatform } = platform
    const prevHistory = Array.isArray(prevHistoryRaw) ? (prevHistoryRaw as unknown[]) : []
    const prePublishEntry = {
      id: `snap_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      ts: new Date().toISOString(),
      reason: 'pre-publish',
      snapshot: {
        platformAttributes: snapshotPlatform,
        priceOverride: listing.priceOverride != null ? Number(listing.priceOverride) : null,
        quantity: listing.quantity ?? null,
      },
    }
    const historyWithPrePublish = [prePublishEntry, ...prevHistory].slice(0, 10)
    await prisma.channelListing.update({
      where: { id: listing.id },
      data: {
        platformAttributes: {
          ...platform,
          _versionHistory: historyWithPrePublish,
        } as Prisma.InputJsonValue,
      },
    })

    // ── Build payload from cockpit state ────────────────────────────
    const categoryId = (platform.categoryId as string | undefined) ?? null
    const conditionId = (platform.conditionId as string | undefined) ?? null
    const itemSpecifics =
      typeof platform.itemSpecifics === 'object' && platform.itemSpecifics !== null
        ? (platform.itemSpecifics as Record<string, string[]>)
        : {}
    const imageUrls = product.images.map((i) => i.url).slice(0, 24)

    if (!categoryId) {
      return reply.code(409).send({
        error: 'Category not set — pick a category in the cockpit first.',
        snapshotId: prePublishEntry.id,
      })
    }
    const priceVal = listing.priceOverride != null
      ? Number(listing.priceOverride)
      : listing.price != null
      ? Number(listing.price)
      : product.basePrice != null
      ? Number(product.basePrice)
      : null
    if (priceVal == null || priceVal <= 0) {
      return reply.code(409).send({
        error: 'Price not set — set a price in the Pricing card first.',
        snapshotId: prePublishEntry.id,
      })
    }

    // eBay condition strings: NEW / NEW_OTHER / USED_EXCELLENT / etc.
    // Cockpit currently stores numeric IDs in platformAttributes.
    // Map the common ones; fall back to NEW when blank.
    const CONDITION_MAP: Record<string, string> = {
      '1000': 'NEW',
      '1500': 'NEW_OTHER',
      '1750': 'NEW_WITH_DEFECTS',
      '2000': 'CERTIFIED_REFURBISHED',
      '2500': 'SELLER_REFURBISHED',
      '3000': 'USED_EXCELLENT',
      '4000': 'USED_VERY_GOOD',
      '5000': 'USED_GOOD',
      '6000': 'USED_ACCEPTABLE',
      '7000': 'FOR_PARTS_OR_NOT_WORKING',
    }
    const condition = conditionId ? CONDITION_MAP[conditionId] ?? 'NEW' : 'NEW'

    const marketplaceId = normaliseMarketplace(marketplace)
    const adapter = new EbayPublishAdapter()
    const result = await adapter.publish({
      sku: product.sku,
      marketplaceId,
      categoryId,
      condition,
      product: {
        title: ((platform.title as string | undefined) ?? listing.title ?? product.name ?? '').slice(0, 80),
        description: (platform.description as string | undefined) ?? listing.description ?? product.description ?? '',
        aspects: itemSpecifics,
        imageUrls,
      },
      availability: {
        shipToLocationAvailability: { quantity: listing.quantity ?? 1 },
      },
      price: {
        value: priceVal,
        currency: marketplace.toUpperCase() === 'UK' ? 'GBP' : 'EUR',
      },
      policies: {
        fulfillmentPolicyId: (platform.fulfillmentPolicyId as string | undefined) ?? undefined,
        paymentPolicyId: (platform.paymentPolicyId as string | undefined) ?? undefined,
        returnPolicyId: (platform.returnPolicyId as string | undefined) ?? undefined,
        merchantLocationKey: (platform.merchantLocationKey as string | undefined) ?? undefined,
      },
    })

    // ── Persist outcome ────────────────────────────────────────────
    if (result.ok) {
      // ChannelListing has externalListingId but no listingUrl
      // column — the URL is derived at render time from
      // marketplace.domainUrl + /itm/{itemId}. We persist the
      // adapter's URL into platformAttributes for traceability.
      const nextPlatformAfterPublish: Record<string, unknown> = {
        ...platform,
        _versionHistory: historyWithPrePublish,
      }
      if (result.listingUrl) nextPlatformAfterPublish._lastPublishedUrl = result.listingUrl
      if (result.offerId) nextPlatformAfterPublish._lastPublishedOfferId = result.offerId
      nextPlatformAfterPublish._lastPublishedAt = new Date().toISOString()
      await prisma.channelListing.update({
        where: { id: listing.id },
        data: {
          externalListingId: result.listingId ?? listing.externalListingId,
          isPublished: true,
          listingStatus: 'ACTIVE',
          platformAttributes: nextPlatformAfterPublish as Prisma.InputJsonValue,
        },
      })
    } else {
      // Don't flip status to ERROR globally — many failures are
      // recoverable (missing aspect, bad image). Surface the failed
      // step in the response so the cockpit can highlight the card
      // that needs attention.
    }

    return reply.send({
      ...result,
      snapshotId: prePublishEntry.id,
    })
  })

  // ── POST /api/ebay/cockpit/ai-improve ───────────────────────────────
  // Claude-backed listing assistant. Two operations covering the two
  // surfaces that benefit most from AI improvement: free-text content
  // (essentials = title + description) and structured aspects.
  //
  // Body:
  //   {
  //     operation: 'essentials' | 'aspects',
  //     productId, marketplace,
  //     current: { title, description, ... } | { itemSpecifics, ... }
  //   }
  //
  // Returns:
  //   essentials → { title, description, rationale, projectedUplift }
  //   aspects    → { aspects: { [aspectId]: value }, rationale,
  //                   projectedUplift }
  //
  // Per-marketplace language: prompt asks for native-language output
  // (IT → italiano, DE → deutsch, FR → français, ES → español, UK →
  // English). Brand voice is supplied implicitly via current values +
  // product context; EC.12b can wire the dedicated BrandVoice profile.
  fastify.post<{
    Body: {
      operation: 'essentials' | 'aspects' | 'compatibility'
      productId: string
      marketplace: string
    }
  }>('/ebay/cockpit/ai-improve', {
    config: { rateLimit: { max: 12, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const body = request.body
    if (!body) return reply.code(400).send({ error: 'Body is required' })
    const { operation, productId, marketplace } = body
    if (!operation || !productId || !marketplace) {
      return reply.code(400).send({ error: 'operation, productId, marketplace are required' })
    }
    if (operation !== 'essentials' && operation !== 'aspects' && operation !== 'compatibility') {
      return reply.code(400).send({ error: 'operation must be "essentials", "aspects", or "compatibility"' })
    }

    if (isAiKillSwitchOn()) {
      return reply.code(503).send({ error: 'AI features are currently disabled (kill switch active).' })
    }
    const provider = getProvider('anthropic')
    if (!provider) {
      return reply.code(500).send({ error: 'Anthropic provider not configured. Set ANTHROPIC_API_KEY.' })
    }

    // Load context — product + listing + (for aspects) the category
    // schema so the AI knows which aspects exist + which are missing.
    const product = await prisma.product.findUnique({
      where: { id: productId },
      select: {
        id: true, sku: true, name: true, description: true, brand: true,
        productType: true,
      },
    })
    if (!product) return reply.code(404).send({ error: 'Product not found' })
    const listing = await prisma.channelListing.findFirst({
      where: { productId, channel: 'EBAY', marketplace },
    })
    const platform = (listing?.platformAttributes ?? {}) as Record<string, unknown>
    const categoryId = (platform.categoryId as string | undefined) ?? null
    const categoryName = (platform.categoryName as string | undefined) ?? null

    const LANG: Record<string, string> = {
      IT: 'Italian',  DE: 'German', FR: 'French',
      ES: 'Spanish',  UK: 'British English', US: 'American English',
    }
    const targetLang = LANG[marketplace.toUpperCase()] ?? 'English'

    if (operation === 'essentials') {
      const currentTitle = (listing?.title ?? product.name ?? '').slice(0, 200)
      const currentDesc = listing?.description ?? product.description ?? ''
      const prompt = [
        `You are an eBay listing copywriter for marketplace EBAY_${marketplace.toUpperCase()} (${targetLang}).`,
        `Product context:`,
        `  SKU: ${product.sku}`,
        `  Brand: ${product.brand ?? '(unset)'}`,
        `  Product type: ${product.productType ?? '(unset)'}`,
        `  Master name: ${product.name ?? '(unset)'}`,
        `  Category: ${categoryName ?? categoryId ?? '(none picked)'}`,
        ``,
        `Current eBay title (${currentTitle.length} chars): "${currentTitle}"`,
        `Current eBay description (${currentDesc.length} chars): """${currentDesc.slice(0, 1200)}"""`,
        ``,
        `Task: rewrite the title and description to be best-in-class for eBay search ranking + buyer conversion on this marketplace.`,
        ``,
        `Rules:`,
        `- Title: max 80 chars, no ALL CAPS, front-load the most-searched keywords for ${product.productType ?? 'this product'}, end with brand + key spec.`,
        `- Description: 200-1500 chars, plain text (no HTML in output), in ${targetLang}. Include a short opening hook, 3-5 bullet-style benefits, key specs, and a brief shipping/returns reassurance.`,
        `- Match Italian motorcycle gear ecommerce voice (the brand is Xavia) — confident but not hyperbolic, focused on protection and craftsmanship for jackets/helmets/gloves/boots.`,
        `- Use ${targetLang} exclusively for the visible text. Brand names and SKUs stay in their original form.`,
        ``,
        `Respond with ONLY this JSON shape (no prose before or after):`,
        `{"title": string, "description": string, "rationale": string, "projectedUplift": string}`,
        ``,
        `projectedUplift is a short hint like "+12% est. CTR" or "+8% search visibility" based on what improved.`,
      ].join('\n')

      try {
        const res = await provider.generate({
          prompt,
          jsonMode: true,
          maxOutputTokens: 1024,
          temperature: 0.3,
          feature: 'ebay-cockpit-ai-improve-essentials',
          entityType: 'product',
          entityId: productId,
        })
        const parsed = parseAiJson(res.text)
        return reply.send({
          operation,
          ...parsed,
          usage: res.usage,
        })
      } catch (err) {
        request.log.error(err, '[ebay/cockpit/ai-improve essentials] failed')
        return reply.code(500).send({ error: err instanceof Error ? err.message : 'AI call failed' })
      }
    }

    // ── operation: compatibility (EC.13) ─────────────────────────────
    if (operation === 'compatibility') {
      const isMotors = /helmet|casco|jacket|giacca|giubbotto|glove|guanto|boot|stivali|motor|moto/i
        .test(`${categoryName ?? ''} ${product.productType ?? ''} ${product.name ?? ''}`)
      if (!isMotors) {
        return reply.send({
          operation: 'compatibility',
          fitments: [],
          rationale: 'Product does not appear to be motorcycle gear — no compatibility suggested.',
        })
      }
      const compatPrompt = [
        `You are an eBay Motors compatibility assistant for ${targetLang}-language listings.`,
        `Product context:`,
        `  Brand: ${product.brand ?? '(unset)'}`,
        `  Product type: ${product.productType ?? '(unset)'}`,
        `  Name: ${product.name ?? '(unset)'}`,
        `  Category: ${categoryName ?? '(none)'}`,
        `  Description: """${(product.description ?? '').slice(0, 800)}"""`,
        ``,
        `Task: suggest motorcycle fitments for this gear. Motorcycle GEAR (helmets, jackets, gloves, boots, suits) is usually UNIVERSAL FIT — set "universal": true and skip the fitments list. Only return specific year/make/model fitments when the description explicitly names compatible bikes (e.g., "fits Ducati Panigale V4 2018-2024" or "designed for Harley-Davidson Sportster").`,
        ``,
        `When fitments are warranted, prefer 3-12 well-targeted entries over 100 speculative ones. Use real motorcycle make+model names (Ducati / Honda / Kawasaki / Yamaha / Suzuki / BMW / Triumph / Harley-Davidson / KTM / Aprilia / MV Agusta).`,
        ``,
        `Respond with ONLY this JSON (no prose):`,
        `{"universal": boolean, "fitments": [{"year": "2020", "make": "Ducati", "model": "Panigale V4"}], "rationale": string}`,
        ``,
        `Set fitments to [] when universal=true.`,
      ].join('\n')
      try {
        const res = await provider.generate({
          prompt: compatPrompt,
          jsonMode: true,
          maxOutputTokens: 1024,
          temperature: 0.2,
          feature: 'ebay-cockpit-ai-improve-compatibility',
          entityType: 'product',
          entityId: productId,
        })
        const parsed = parseAiJson(res.text)
        return reply.send({
          operation: 'compatibility',
          ...parsed,
          usage: res.usage,
        })
      } catch (err) {
        request.log.error(err, '[ebay/cockpit/ai-improve compatibility] failed')
        return reply.code(500).send({ error: err instanceof Error ? err.message : 'AI call failed' })
      }
    }

    // ── operation: aspects ─────────────────────────────────────────
    if (!categoryId) {
      return reply.code(409).send({ error: 'No category picked — AI aspect suggestions need a category.' })
    }
    let schemaAspects: Array<{ id: string; label: string; required: boolean; recommended: boolean; options?: string[] }> = []
    try {
      const schema = await ebayCategoryService.getCategoryAspectsRich(
        categoryId,
        normaliseMarketplace(marketplace),
        { throwOnError: false },
      )
      schemaAspects = schema.map((a) => {
        const isEnum = a.mode === 'SELECTION_ONLY' && a.values.length > 0
        return {
          id: `aspect_${a.name.replace(/\s+/g, '_')}`,
          label: a.englishName ? `${a.name} (${a.englishName})` : a.name,
          required: a.required || a.usage === 'REQUIRED',
          recommended: a.usage === 'RECOMMENDED',
          options: isEnum ? a.values : undefined,
        }
      })
    } catch {
      // Schema fetch failure — AI still helps if we know nothing, but
      // the result will be lower-quality. Continue with empty schema.
    }

    const currentSpecs = (platform.itemSpecifics ?? {}) as Record<string, string[] | string>
    const currentLines = Object.entries(currentSpecs).map(([k, v]) => `  ${k}: ${Array.isArray(v) ? v.join('; ') : v}`).join('\n')
    const schemaLines = schemaAspects.slice(0, 60).map((a) => {
      const tag = a.required ? '[REQUIRED]' : a.recommended ? '[recommended]' : '[optional]'
      const opts = a.options && a.options.length > 0 ? ` (one of: ${a.options.slice(0, 12).join(' | ')}${a.options.length > 12 ? '…' : ''})` : ''
      return `  ${a.id}: ${a.label} ${tag}${opts}`
    }).join('\n')

    const prompt = [
      `You are an eBay aspects assistant for marketplace EBAY_${marketplace.toUpperCase()} (${targetLang}).`,
      `Product context:`,
      `  Brand: ${product.brand ?? '(unset)'}`,
      `  Master name: ${product.name ?? '(unset)'}`,
      `  Product type: ${product.productType ?? '(unset)'}`,
      `  Category: ${categoryName ?? categoryId}`,
      `  Master description: """${(product.description ?? '').slice(0, 800)}"""`,
      ``,
      `Currently filled aspects:`,
      currentLines || '  (none filled yet)',
      ``,
      `Available aspects in this category's schema:`,
      schemaLines || '  (schema unavailable — infer common eBay aspects from product type)',
      ``,
      `Task: suggest values for as many EMPTY aspects as you can with high confidence, focusing on REQUIRED then recommended. Skip aspects whose value you'd be guessing. Use the localised aspect IDs (left of the colon) as keys.`,
      ``,
      `Rules:`,
      `- For SELECTION_ONLY aspects (with enum options), suggest one of the listed values exactly.`,
      `- For free-text aspects, write the value in ${targetLang}.`,
      `- Do NOT touch aspects already filled.`,
      `- Brand-name aspects always use "${product.brand ?? '(brand)'}".`,
      `- If unsure, skip the aspect — false confidence hurts more than a missing aspect.`,
      ``,
      `Respond with ONLY this JSON shape (no prose):`,
      `{"aspects": {"aspect_Brand": "Xavia", "aspect_Size": "M"}, "rationale": string, "projectedUplift": string}`,
    ].join('\n')

    try {
      const res = await provider.generate({
        prompt,
        jsonMode: true,
        maxOutputTokens: 2048,
        temperature: 0.2,
        feature: 'ebay-cockpit-ai-improve-aspects',
        entityType: 'product',
        entityId: productId,
      })
      const parsed = parseAiJson(res.text)
      return reply.send({
        operation,
        ...parsed,
        usage: res.usage,
      })
    } catch (err) {
      request.log.error(err, '[ebay/cockpit/ai-improve aspects] failed')
      return reply.code(500).send({ error: err instanceof Error ? err.message : 'AI call failed' })
    }
  })

  // ── PATCH /api/ebay/cockpit/compatibility ───────────────────────────
  // EC.13 — persist eBay Motors compatibility list for one (productId,
  // EBAY, marketplace). Body:
  //   { universal: boolean, fitments: [{year, make, model, submodel?}] }
  // Universal=true means "fits all motorcycles" — eBay surfaces this
  // as a single catch-all in the buyer's vehicle-search filter and
  // the fitments array is ignored.
  fastify.patch<{
    Body: {
      productId: string
      marketplace: string
      universal: boolean
      fitments?: Array<{
        year: string | number
        make: string
        model: string
        submodel?: string | null
      }>
    }
  }>('/ebay/cockpit/compatibility', async (request, reply) => {
    const body = request.body
    if (!body) return reply.code(400).send({ error: 'Body is required' })
    const { productId, marketplace, universal, fitments } = body
    if (!productId || !marketplace) {
      return reply.code(400).send({ error: 'productId, marketplace are required' })
    }
    if (typeof universal !== 'boolean') {
      return reply.code(400).send({ error: 'universal (boolean) is required' })
    }
    const existing = await prisma.channelListing.findFirst({
      where: { productId, channel: 'EBAY', marketplace },
    })
    if (!existing) {
      return reply.code(409).send({
        error: 'No eBay listing yet — pick a category first.',
      })
    }
    const cleanedFitments = (Array.isArray(fitments) ? fitments : [])
      .map((f) => ({
        year: String(f?.year ?? '').trim(),
        make: String(f?.make ?? '').trim(),
        model: String(f?.model ?? '').trim(),
        submodel: f?.submodel ? String(f.submodel).trim() : null,
      }))
      .filter((f) => f.year && f.make && f.model)
      // Cap at 1000 fitments (eBay's effective limit on compatibility
      // list size — go higher and the Trading API rejects).
      .slice(0, 1000)

    const prevPlatform = (existing.platformAttributes ?? {}) as Record<string, unknown>
    const nextPlatform: Record<string, unknown> = {
      ...prevPlatform,
      compatibility: {
        universal,
        fitments: universal ? [] : cleanedFitments,
        updatedAt: new Date().toISOString(),
      },
    }
    await prisma.channelListing.update({
      where: { id: existing.id },
      data: { platformAttributes: nextPlatform as Prisma.InputJsonValue },
    })
    return reply.send({
      listingId: existing.id,
      universal,
      fitmentCount: universal ? 0 : cleanedFitments.length,
    })
  })

  // ── GET /api/ebay/cockpit/template-candidates ───────────────────────
  // EC.14 — returns same-productType products (excluding the donor)
  // with their current eBay listing state for diff preview. Used by
  // the Apply-to-Siblings modal to show "which products will get
  // changed and by how much".
  //
  // Filters by productType OR by donor's eBay categoryId — whichever
  // is set. Returns at most `limit` rows (default 50, max 200).
  fastify.get<{
    Querystring: {
      productId: string
      marketplace: string
      limit?: string
    }
  }>('/ebay/cockpit/template-candidates', async (request, reply) => {
    const { productId, marketplace } = request.query
    const limit = Math.min(parseInt(request.query.limit ?? '50', 10) || 50, 200)
    if (!productId || !marketplace) {
      return reply.code(400).send({ error: 'productId, marketplace are required' })
    }

    const donor = await prisma.product.findUnique({
      where: { id: productId },
      select: { id: true, sku: true, productType: true, parentId: true },
    })
    if (!donor) return reply.code(404).send({ error: 'Donor product not found' })

    const donorListing = await prisma.channelListing.findFirst({
      where: { productId, channel: 'EBAY', marketplace },
      select: { platformAttributes: true },
    })
    const donorPlatform = (donorListing?.platformAttributes ?? {}) as Record<string, unknown>
    const donorCategoryId = (donorPlatform.categoryId as string | undefined) ?? null

    // Candidates: same productType (when set), excluding the donor
    // itself + child variants of the donor. Keeps the candidate list
    // small + relevant.
    const where: Record<string, unknown> = {
      id: { not: productId },
      deletedAt: null,
      // Exclude children of the donor (we don't apply a parent's
      // layout to its own variants — that's what EC.6 handles).
      parentId: donor.parentId ?? { not: productId },
    }
    if (donor.productType) where.productType = donor.productType

    const candidates = await prisma.product.findMany({
      where,
      take: limit,
      orderBy: { sku: 'asc' },
      select: { id: true, sku: true, name: true, productType: true },
    })

    // Pull each candidate's eBay listing snapshot in one query.
    const candidateListings = await prisma.channelListing.findMany({
      where: {
        productId: { in: candidates.map((c) => c.id) },
        channel: 'EBAY',
        marketplace,
      },
      select: { productId: true, platformAttributes: true, listingStatus: true, externalListingId: true },
    })
    const byProduct = new Map(candidateListings.map((l) => [l.productId, l]))

    return reply.send({
      donor: {
        id: donor.id,
        sku: donor.sku,
        productType: donor.productType,
        categoryId: donorCategoryId,
      },
      candidates: candidates.map((c) => {
        const l = byProduct.get(c.id)
        const p = (l?.platformAttributes ?? {}) as Record<string, unknown>
        const itemSpecifics = (p.itemSpecifics ?? {}) as Record<string, unknown>
        return {
          productId: c.id,
          sku: c.sku,
          name: c.name,
          productType: c.productType,
          hasListing: !!l,
          listingStatus: l?.listingStatus ?? null,
          externalListingId: l?.externalListingId ?? null,
          summary: {
            categoryId: (p.categoryId as string | undefined) ?? null,
            categoryName: (p.categoryName as string | undefined) ?? null,
            aspectCount: Object.keys(itemSpecifics).length,
            hasBestOffer: p.bestOfferEnabled === true,
            hasPolicies:
              !!p.fulfillmentPolicyId || !!p.paymentPolicyId || !!p.returnPolicyId,
            variationAxes: Array.isArray(p._variationAxes) ? (p._variationAxes as string[]) : [],
            hasCompatibility:
              !!p.compatibility && typeof p.compatibility === 'object',
          },
        }
      }),
      total: candidates.length,
    })
  })

  // ── POST /api/ebay/cockpit/template-apply ───────────────────────────
  // EC.14 — copies donor's layout (scope-filtered) onto each target.
  // Each target gets its own pre-apply snapshot in _versionHistory
  // under reason="pre-template-apply" so undo is one click per
  // target via the existing snapshot/restore endpoint.
  //
  // Scope flags pick which layers to copy. All default to true:
  //   aspects      — itemSpecifics (the heaviest layer, usually wanted)
  //   policies     — fulfillment/payment/return policy refs + location
  //   bestOffer    — bestOfferEnabled + auto-accept/decline thresholds
  //   variations   — _variationAxes + _axisSortOrder
  //   compatibility — Motors compatibility object
  //   category     — categoryId/Name/Path (OFF by default — risky if
  //                  siblings are in a slightly different sub-category)
  fastify.post<{
    Body: {
      donorProductId: string
      marketplace: string
      targetProductIds: string[]
      scope?: {
        aspects?: boolean
        policies?: boolean
        bestOffer?: boolean
        variations?: boolean
        compatibility?: boolean
        category?: boolean
      }
    }
  }>('/ebay/cockpit/template-apply', async (request, reply) => {
    const body = request.body
    if (!body) return reply.code(400).send({ error: 'Body is required' })
    const { donorProductId, marketplace, targetProductIds, scope = {} } = body
    if (!donorProductId || !marketplace) {
      return reply.code(400).send({ error: 'donorProductId, marketplace are required' })
    }
    if (!Array.isArray(targetProductIds) || targetProductIds.length === 0) {
      return reply.code(400).send({ error: 'targetProductIds must be a non-empty array' })
    }
    if (targetProductIds.length > 200) {
      return reply.code(400).send({ error: 'Max 200 targets per call' })
    }
    const flags = {
      aspects:        scope.aspects        !== false,
      policies:       scope.policies       !== false,
      bestOffer:      scope.bestOffer      !== false,
      variations:     scope.variations     !== false,
      compatibility:  scope.compatibility  !== false,
      category:       scope.category       === true, // opt-IN
    }

    const donor = await prisma.channelListing.findFirst({
      where: { productId: donorProductId, channel: 'EBAY', marketplace },
    })
    if (!donor) {
      return reply.code(404).send({ error: 'Donor has no eBay listing for this marketplace' })
    }
    const donorPlatform = (donor.platformAttributes ?? {}) as Record<string, unknown>

    // Build the layout slice to copy.
    const layout: Record<string, unknown> = {}
    if (flags.aspects && donorPlatform.itemSpecifics) {
      layout.itemSpecifics = donorPlatform.itemSpecifics
    }
    if (flags.policies) {
      for (const k of ['fulfillmentPolicyId', 'paymentPolicyId', 'returnPolicyId', 'merchantLocationKey']) {
        if (donorPlatform[k] !== undefined) layout[k] = donorPlatform[k]
      }
    }
    if (flags.bestOffer) {
      for (const k of ['bestOfferEnabled', 'bestOfferAutoAcceptPrice', 'bestOfferMinAcceptPrice']) {
        if (donorPlatform[k] !== undefined) layout[k] = donorPlatform[k]
      }
    }
    if (flags.variations) {
      if (donorPlatform._variationAxes !== undefined) layout._variationAxes = donorPlatform._variationAxes
      if (donorPlatform._axisSortOrder !== undefined) layout._axisSortOrder = donorPlatform._axisSortOrder
    }
    if (flags.compatibility && donorPlatform.compatibility !== undefined) {
      layout.compatibility = donorPlatform.compatibility
    }
    if (flags.category) {
      for (const k of ['categoryId', 'categoryName', 'categoryPath']) {
        if (donorPlatform[k] !== undefined) layout[k] = donorPlatform[k]
      }
    }

    if (Object.keys(layout).length === 0) {
      return reply.code(400).send({ error: 'Nothing to copy — every scope flag is off or donor has no data.' })
    }

    const results: Array<{ productId: string; ok: boolean; snapshotId?: string; error?: string }> = []

    for (const targetId of targetProductIds) {
      try {
        if (targetId === donorProductId) {
          results.push({ productId: targetId, ok: false, error: 'Cannot apply to donor itself' })
          continue
        }
        const target = await prisma.channelListing.findFirst({
          where: { productId: targetId, channel: 'EBAY', marketplace },
        })

        // Find-or-create the target listing.
        const isCreate = !target
        const prevPlatform = ((target?.platformAttributes ?? {}) as Record<string, unknown>)
        const { _versionHistory: prevHistRaw, ...snapshotPlatform } = prevPlatform
        const prevHistory = Array.isArray(prevHistRaw) ? (prevHistRaw as unknown[]) : []
        const snapshotEntry = {
          id: `snap_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
          ts: new Date().toISOString(),
          reason: 'pre-template-apply',
          snapshot: {
            platformAttributes: snapshotPlatform,
            priceOverride: target?.priceOverride != null ? Number(target.priceOverride) : null,
            quantity: target?.quantity ?? null,
          },
        }
        const nextHistory = [snapshotEntry, ...prevHistory].slice(0, 10)
        const nextPlatform: Record<string, unknown> = {
          ...prevPlatform,
          ...layout,
          _versionHistory: nextHistory,
        }
        if (isCreate) {
          await prisma.channelListing.create({
            data: {
              productId: targetId,
              channel: 'EBAY',
              region: marketplace.toUpperCase(),
              marketplace,
              channelMarket: `EBAY_${marketplace.toUpperCase()}`,
              listingStatus: 'DRAFT',
              isPublished: false,
              platformAttributes: nextPlatform as Prisma.InputJsonValue,
            },
          })
        } else {
          await prisma.channelListing.update({
            where: { id: target!.id },
            data: { platformAttributes: nextPlatform as Prisma.InputJsonValue },
          })
        }
        results.push({ productId: targetId, ok: true, snapshotId: snapshotEntry.id })
      } catch (err) {
        results.push({
          productId: targetId,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    return reply.send({
      donorProductId,
      marketplace,
      scope: flags,
      layerKeys: Object.keys(layout),
      results,
      okCount: results.filter((r) => r.ok).length,
      failCount: results.filter((r) => !r.ok).length,
    })
  })

  // ── POST /api/ebay/cockpit/promote-to-master ────────────────────────
  // EC.15 — Push cockpit-improved content back up to the Product
  // master record. The cockpit is per-channel-per-marketplace, but
  // when an operator writes a better title (or generates one via AI)
  // they often want that title to be the master, not a per-channel
  // override that silently diverges from every other channel.
  //
  // Body: { productId, fields: { name?, description?, basePrice? } }
  // Only the supplied fields update; omitted ones are untouched.
  // Returns the updated product slice so the cockpit can refresh
  // without re-fetching the full payload.
  fastify.post<{
    Body: {
      productId: string
      fields: {
        name?: string | null
        description?: string | null
        basePrice?: number | null
      }
    }
  }>('/ebay/cockpit/promote-to-master', async (request, reply) => {
    const body = request.body
    if (!body) return reply.code(400).send({ error: 'Body is required' })
    const { productId, fields } = body
    if (!productId || !fields || typeof fields !== 'object') {
      return reply.code(400).send({ error: 'productId, fields are required' })
    }

    const data: Record<string, unknown> = {}
    if (fields.name !== undefined) {
      const trimmed = String(fields.name ?? '').trim()
      if (trimmed.length === 0) {
        return reply.code(400).send({ error: 'name cannot be empty when promoting' })
      }
      data.name = trimmed
    }
    if (fields.description !== undefined) {
      data.description = fields.description === null
        ? null
        : String(fields.description)
    }
    if (fields.basePrice !== undefined) {
      if (fields.basePrice === null) {
        data.basePrice = null
      } else {
        const n = Number(fields.basePrice)
        if (!Number.isFinite(n) || n < 0) {
          return reply.code(400).send({ error: 'basePrice must be a non-negative number' })
        }
        data.basePrice = new Prisma.Decimal(n)
      }
    }
    if (Object.keys(data).length === 0) {
      return reply.code(400).send({ error: 'No supported fields supplied (name/description/basePrice).' })
    }

    try {
      const updated = await prisma.product.update({
        where: { id: productId },
        data,
        select: { id: true, sku: true, name: true, description: true, basePrice: true, updatedAt: true },
      })
      return reply.send({
        product: {
          ...updated,
          basePrice: updated.basePrice != null ? Number(updated.basePrice) : null,
        },
        promotedFields: Object.keys(data),
      })
    } catch (err) {
      request.log.error(err, '[ebay/cockpit/promote-to-master] failed')
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes('Record to update not found')) {
        return reply.code(404).send({ error: 'Product not found' })
      }
      return reply.code(500).send({ error: message })
    }
  })
}

// JSON parse that tolerates a stray prose intro or markdown fence —
// Anthropic occasionally wraps JSON in ```json ... ``` despite the
// system prompt's "ONLY this JSON" instruction.
function parseAiJson(raw: string): Record<string, unknown> {
  const trimmed = raw.trim()
  const cleaned = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim()
  try {
    return JSON.parse(cleaned)
  } catch {
    // Try to extract the first {...} block.
    const m = cleaned.match(/\{[\s\S]*\}/)
    if (!m) throw new Error(`AI returned non-JSON: ${cleaned.slice(0, 200)}`)
    return JSON.parse(m[0])
  }
}
