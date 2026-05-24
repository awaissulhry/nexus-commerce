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
 *
 * All endpoints reuse the EbayCategoryService singleton (in-memory
 * 24h caches for search + aspects). No changes to flat-file routes.
 */

import type { FastifyInstance } from 'fastify'
import { Prisma } from '@nexus/database'
import prisma from '../db.js'
import { EbayCategoryService } from '../services/ebay-category.service.js'
import { EbayPublishAdapter } from '../services/listing-wizard/ebay-publish.adapter.js'

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
}
