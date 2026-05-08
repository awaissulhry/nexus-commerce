import type { FastifyPluginAsync } from 'fastify'
import { Prisma } from '@prisma/client'
import prisma from '../db.js'
import {
  getAvailableFields,
  getFieldDefinition,
} from '../services/pim/field-registry.service.js'
import {
  buildUploadPlan,
  parseUploadBuffer,
  summarisePlan,
  type PlanRow,
} from '../services/products/bulk-upload.service.js'
import { parseZipUpload } from '../services/products/bulk-zip-upload.service.js'
import { auditLogService } from '../services/audit-log.service.js'
import { idempotencyService } from '../services/idempotency.service.js'
import { masterPriceService } from '../services/master-price.service.js'
import { applyStockMovement } from '../services/stock-movement.service.js'
import { listEtag, matches } from '../utils/list-etag.js'

/**
 * Routes for bulk-operations: optimized fetch + atomic patch.
 * Mounted at /api in index.ts → endpoints are /api/products/bulk-fetch
 * and /api/products/bulk.
 */
const productsRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/pim/fields — return field definitions for the column
  // selector. Optional filters:
  //   ?channels=AMAZON,EBAY      — include those channels' fields
  //   ?productTypes=OUTERWEAR    — include category-specific fields
  //   ?marketplace=IT            — pull dynamic Amazon schema fields
  //                                from cached CategorySchema rows
  // Cached 5 min — registry is mostly static; dynamic fields are
  // already DB-backed so the cost of refetching is small.
  fastify.get('/pim/fields', async (request, reply) => {
    reply.header('Cache-Control', 'private, max-age=300')
    const q = request.query as {
      channels?: string
      productTypes?: string
      marketplace?: string
      ebayCategoryIds?: string
    }
    const fields = await getAvailableFields({
      channels: q.channels?.split(',').map((s) => s.trim()).filter(Boolean),
      productTypes: q.productTypes
        ?.split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      marketplace: q.marketplace ?? null,
      // AA.2 — eBay categoryIds in the active context's listings;
      // the registry pulls cached aspects per id and merges them as
      // attr_* fields with channel='EBAY'.
      ebayCategoryIds: q.ebayCategoryIds
        ?.split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    })
    return { fields, count: fields.length }
  })

  // BB.1 — prewarm the eBay aspect cache for a list of categoryIds.
  // /api/pim/fields is cache-only on its eBay branch so cold ids
  // return [] fast; this endpoint runs the (slow) live fetches in
  // parallel out-of-band so the next /api/pim/fields tick sees the
  // populated cache. Mirrors U.1's Amazon prewarm pattern.
  fastify.post<{
    Body: { marketplace?: string; categoryIds?: string[] }
  }>('/pim/ebay-prewarm', async (request, reply) => {
    const body = request.body ?? {}
    const marketplace = (body.marketplace ?? '').trim() || null
    const ids = Array.isArray(body.categoryIds)
      ? body.categoryIds.filter(
          (s): s is string => typeof s === 'string' && s.length > 0,
        )
      : []
    if (ids.length === 0) {
      return { warmed: 0, skipped: 0 }
    }
    try {
      const { EbayCategoryService } = await import(
        '../services/ebay-category.service.js'
      )
      const svc = new EbayCategoryService()
      const results = await Promise.allSettled(
        ids.map((id) =>
          svc.getCategoryAspectsRich(id, marketplace).then(
            (aspects) => ({ id, ok: aspects.length > 0 }),
          ),
        ),
      )
      let warmed = 0
      let skipped = 0
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value.ok) warmed++
        else skipped++
      }
      return { warmed, skipped }
    } catch (e) {
      return reply.code(500).send({
        error: e instanceof Error ? e.message : String(e),
      })
    }
  })

  // GET /api/products — paginated catalog list for the /products page.
  //
  // Distinct from /products/bulk-fetch (bulk-ops, returns everything)
  // and /amazon/products/list (Amazon-only, hard-capped at 50). This
  // is the "browse the master catalog" endpoint:
  //
  //   ?page=1&limit=50&search=airmesh
  //   ?status=ACTIVE,DRAFT&channels=AMAZON,EBAY&stockLevel=low
  //   ?sort=updated|created|sku|name|price-asc|price-desc|stock-asc|stock-desc
  //
  // limit is clamped to 200 to prevent accidental fetch-all calls.
  //
  // Default scope is top-level products (parentId=null) so variation
  // children don't flood the page. The grid expand-on-chevron flow
  // re-uses this endpoint with ?parentId=<id> to lazy-load a parent's
  // children — same response shape, same filter set, just a different
  // scope.
  fastify.get<{
    Querystring: {
      page?: string
      limit?: string
      search?: string
      status?: string
      channels?: string
      stockLevel?: string
      sort?: string
      // C.2 — new filters
      productTypes?: string
      brands?: string
      tags?: string
      fulfillment?: string
      marketplaces?: string
      hasPhotos?: string
      hasDescription?: string
      hasBrand?: string
      hasGtin?: string
      includeCoverage?: string
      includeTags?: string
      // Lazy-load children of this parent. Pass the parent's ID
      // verbatim. Disables the default parentId=null filter.
      parentId?: string
      // P.10 — products that are NOT listed on any of these channels.
      // Comma-separated channel names (AMAZON, EBAY, ...). Used by
      // the "Missing on..." filter chips to surface coverage gaps.
      // Distinct from the positive `channels` filter, which uses
      // syncChannels intent rather than actual ChannelListing
      // presence.
      missingChannels?: string
    }
  }>('/products', async (request, reply) => {
    try {
      const q = request.query
      const page = Math.max(parseInt(q.page ?? '1', 10) || 1, 1)
      const limit = Math.max(
        Math.min(parseInt(q.limit ?? '50', 10) || 50, 500),
        1,
      )
      const search = (q.search ?? '').trim()
      const statusList = (q.status ?? '')
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean)
      const channelList = (q.channels ?? '')
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean)
      const productTypeList = (q.productTypes ?? '').split(',').map((s) => s.trim()).filter(Boolean)
      const brandList = (q.brands ?? '').split(',').map((s) => s.trim()).filter(Boolean)
      const tagIdList = (q.tags ?? '').split(',').map((s) => s.trim()).filter(Boolean)
      const fulfillmentList = (q.fulfillment ?? '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
      const marketplaceList = (q.marketplaces ?? '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
      // P.10 — channels we want products NOT to be listed on. Coverage-gap surface.
      const missingChannelList = (q.missingChannels ?? '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
      const stockLevel = (q.stockLevel ?? 'all').toLowerCase()
      const sort = q.sort ?? 'updated'
      const includeCoverage = q.includeCoverage === 'true' || q.includeCoverage === '1'
      const includeTags = q.includeTags === 'true' || q.includeTags === '1'

      // Default scope: top-level rows only. Override with ?parentId=<id>
      // to fetch children of a specific parent (used by the grid's
      // expand-on-chevron flow).
      const where: any = q.parentId ? { parentId: q.parentId } : { parentId: null }
      if (search) {
        where.OR = [
          { sku: { contains: search, mode: 'insensitive' } },
          { name: { contains: search, mode: 'insensitive' } },
          { brand: { contains: search, mode: 'insensitive' } },
          { gtin: { contains: search } },
        ]
      }
      if (statusList.length > 0) {
        where.status = { in: statusList }
      }
      if (channelList.length > 0) {
        where.syncChannels = { hasSome: channelList }
      }
      if (productTypeList.length > 0) where.productType = { in: productTypeList }
      if (brandList.length > 0) where.brand = { in: brandList }
      if (fulfillmentList.length > 0) where.fulfillmentMethod = { in: fulfillmentList }
      if (marketplaceList.length > 0) {
        where.channelListings = { some: { marketplace: { in: marketplaceList } } }
      }
      // P.10 — products NOT listed on the given channels. Cleanly
      // composes with the existing marketplace filter via Prisma's
      // implicit AND on `where` keys, except both target the same
      // relation, so we use AND[] when both are set.
      if (missingChannelList.length > 0) {
        const missingClause = {
          channelListings: { none: { channel: { in: missingChannelList } } },
        } as const
        if (where.channelListings) {
          where.AND = [
            ...((where.AND as any[]) ?? []),
            { channelListings: where.channelListings },
            missingClause,
          ]
          delete where.channelListings
        } else {
          where.channelListings = missingClause.channelListings
        }
      }
      if (tagIdList.length > 0) {
        // Filter products that have AT LEAST ONE of the selected tags
        where.id = {
          in: (await prisma.productTag.findMany({
            where: { tagId: { in: tagIdList } },
            select: { productId: true },
            distinct: ['productId'],
          })).map((r) => r.productId),
        }
      }
      if (q.hasPhotos === 'true') where.images = { some: {} }
      if (q.hasPhotos === 'false') where.images = { none: {} }
      // Catalog hygiene tri-states. Treat empty strings as missing
      // (Postgres distinguishes NULL from '', but the operator wants
      // both classes flagged for cleanup). We push these into AND[]
      // rather than touching where.OR — the OR slot is already owned
      // by `search` and combining the two via OR would mix "matches
      // search" with "missing description" semantically.
      const hygieneClauses: any[] = []
      if (q.hasDescription === 'true') {
        hygieneClauses.push({ description: { not: null }, NOT: { description: '' } })
      } else if (q.hasDescription === 'false') {
        hygieneClauses.push({ OR: [{ description: null }, { description: '' }] })
      }
      if (q.hasBrand === 'true') {
        hygieneClauses.push({ brand: { not: null }, NOT: { brand: '' } })
      } else if (q.hasBrand === 'false') {
        hygieneClauses.push({ OR: [{ brand: null }, { brand: '' }] })
      }
      if (q.hasGtin === 'true') {
        hygieneClauses.push({ gtin: { not: null }, NOT: { gtin: '' } })
      } else if (q.hasGtin === 'false') {
        hygieneClauses.push({ OR: [{ gtin: null }, { gtin: '' }] })
      }
      if (hygieneClauses.length > 0) {
        where.AND = [...((where.AND as any[]) ?? []), ...hygieneClauses]
      }
      if (stockLevel === 'in') {
        where.totalStock = { gt: 0 }
      } else if (stockLevel === 'low') {
        where.totalStock = { gt: 0, lte: 5 }
      } else if (stockLevel === 'out') {
        where.totalStock = 0
      }

      const orderBy: any = (() => {
        switch (sort) {
          case 'created':
            return { createdAt: 'desc' }
          case 'sku':
            return { sku: 'asc' }
          case 'name':
            return { name: 'asc' }
          case 'price-asc':
            return { basePrice: 'asc' }
          case 'price-desc':
            return { basePrice: 'desc' }
          case 'stock-asc':
            return { totalStock: 'asc' }
          case 'stock-desc':
            return { totalStock: 'desc' }
          case 'updated':
          default:
            return { updatedAt: 'desc' }
        }
      })()

      // Phase 10b — short-circuit with 304 when nothing has changed.
      // /products grid polls every 30s + on visibility-change; without
      // ETag every poll re-runs the heavy product list with relations.
      const { etag, count: etagCount } = await listEtag(prisma, {
        model: 'product',
        where,
        filterContext: {
          page,
          limit,
          sort: q.sort,
          includeCoverage,
          includeTags,
          parentId: q.parentId ?? null,
        },
      })
      reply.header('ETag', etag)
      reply.header('Cache-Control', 'private, max-age=0, must-revalidate')
      if (matches(request, etag)) {
        return reply.code(304).send()
      }

      const [rawProducts, total, statsRows] = await Promise.all([
        prisma.product.findMany({
          where,
          orderBy,
          take: limit,
          skip: (page - 1) * limit,
          select: {
            id: true,
            sku: true,
            name: true,
            brand: true,
            basePrice: true,
            totalStock: true,
            lowStockThreshold: true,
            status: true,
            syncChannels: true,
            updatedAt: true,
            createdAt: true,
            isParent: true,
            parentId: true,
            productType: true,
            fulfillmentMethod: true,
            // P.7 — version for inline-edit optimistic concurrency.
            // The grid sends it as If-Match on PATCH; on a 409 we
            // know another change landed first and can prompt.
            version: true,
            // Use ProductImage (the table that actually exists in
            // Postgres) — the Image model is in schema.prisma but its
            // table was never migrated. Order by createdAt so the
            // oldest upload (typically the MAIN image) wins ties.
            images: {
              select: { url: true, type: true },
              orderBy: { createdAt: 'asc' },
              take: 1,
            },
            _count: {
              select: { images: true, channelListings: true, variations: true, children: true },
            },
            ...(includeCoverage
              ? {
                  channelListings: {
                    select: {
                      channel: true,
                      marketplace: true,
                      listingStatus: true,
                      lastSyncStatus: true,
                      isPublished: true,
                    },
                  },
                }
              : {}),
          },
        }),
        Promise.resolve(etagCount),
        // Stats reflect the FILTERED set so the header counts match
        // what's actually browsable. Five small aggregates.
        Promise.all([
          prisma.product.count({ where }),
          prisma.product.count({
            where: { ...where, status: 'ACTIVE' },
          }),
          prisma.product.count({
            where: { ...where, status: 'DRAFT' },
          }),
          prisma.product.count({
            where: { ...where, totalStock: { gt: 0 } },
          }),
          prisma.product.count({
            where: { ...where, totalStock: 0 },
          }),
        ]),
      ])

      // Optional tag rollup — single grouped query, fan out client-side
      let tagsByProduct: Map<string, Array<{ id: string; name: string; color: string | null }>> = new Map()
      if (includeTags) {
        const productIds = rawProducts.map((p) => p.id)
        const rows = await prisma.productTag.findMany({
          where: { productId: { in: productIds } },
          select: {
            productId: true,
            tag: { select: { id: true, name: true, color: true } },
          },
        })
        for (const r of rows) {
          const arr = tagsByProduct.get(r.productId) ?? []
          arr.push(r.tag)
          tagsByProduct.set(r.productId, arr)
        }
      }

      const products = rawProducts.map((p: any) => {
        const photoCount = p._count?.images ?? 0
        // Channel coverage rollup: per-channel { live, draft, error, total }
        let coverage: Record<string, { live: number; draft: number; error: number; total: number }> | null = null
        if (includeCoverage && Array.isArray(p.channelListings)) {
          coverage = {}
          for (const cl of p.channelListings) {
            const c = (coverage[cl.channel] ??= { live: 0, draft: 0, error: 0, total: 0 })
            c.total++
            if (cl.listingStatus === 'ACTIVE' && cl.isPublished) c.live++
            else if (cl.listingStatus === 'DRAFT') c.draft++
            else if (cl.listingStatus === 'ERROR' || cl.lastSyncStatus === 'FAILED') c.error++
          }
        }
        return {
          id: p.id,
          sku: p.sku,
          name: p.name,
          brand: p.brand,
          basePrice: Number(p.basePrice),
          totalStock: p.totalStock,
          lowStockThreshold: p.lowStockThreshold,
          status: p.status,
          syncChannels: p.syncChannels,
          updatedAt: p.updatedAt,
          createdAt: p.createdAt,
          isParent: p.isParent,
          parentId: p.parentId,
          productType: p.productType,
          fulfillmentMethod: p.fulfillmentMethod,
          // P.7 — version for inline-edit If-Match.
          version: p.version,
          imageUrl: p.images[0]?.url ?? null,
          photoCount,
          channelCount: p._count?.channelListings ?? 0,
          variantCount: p._count?.variations ?? 0,
          childCount: p._count?.children ?? 0,
          coverage,
          tags: includeTags ? (tagsByProduct.get(p.id) ?? []) : undefined,
        }
      })

      return {
        products,
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
        stats: {
          total: statsRows[0],
          active: statsRows[1],
          draft: statsRows[2],
          inStock: statsRows[3],
          outOfStock: statsRows[4],
        },
      }
    } catch (err: any) {
      fastify.log.error({ err }, '[products list] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  // GET /api/products/bulk-fetch — single optimized SELECT for the
  // bulk-operations table. Plain Decimal coercion to numbers so the
  // client can sort/edit without parseFloat-ing everywhere.
  //
  // D.3d: optional ?channel=AMAZON&marketplace=IT params. When both
  // are set, each product gets a `_channelListing` field with the
  // matching ChannelListing row (or null if none exists). Used by the
  // bulk-ops table to render amazon_*/ebay_* cell values.
  fastify.get<{
    Querystring: {
      channel?: string
      marketplace?: string
      // P.9 — narrow the bulk-fetch to a specific id set so deep
      // links from /products' bulk-action bar ("Power edit") land
      // on a filtered grid instead of the full catalog. CSV of
      // Product.id values; capped at BULK_FETCH_IDS_MAX so a
      // bookmarked URL can't cause an OOM. Empty = all products.
      productIds?: string
    }
  }>('/products/bulk-fetch', async (request, reply) => {
    try {
      const channelParam = request.query.channel?.toUpperCase()
      const marketplaceParam = request.query.marketplace?.toUpperCase()
      const includeChannelListing =
        !!channelParam && !!marketplaceParam

      // P.9 — productIds filter. CSV → trimmed unique id list. Cap
      // ensures a runaway URL can't blow up the SELECT or the
      // ETag context.
      const BULK_FETCH_IDS_MAX = 1000
      const productIdsRaw = (request.query.productIds ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      const productIds = Array.from(new Set(productIdsRaw)).slice(
        0,
        BULK_FETCH_IDS_MAX,
      )
      const hasIdFilter = productIds.length > 0

      // Phase 10b — ETag short-circuit. Bulk-ops grid is the heaviest
      // single read in the app (no pagination — fetches every product
      // every poll); ETag turns repeat polls without changes into
      // 304s instead of multi-MB findMany + relation fans.
      // P.9 — id-list folded into the ETag context so the cache key
      // differentiates "all products" vs "these N products".
      const { etag } = await listEtag(prisma, {
        model: 'product',
        ...(hasIdFilter ? { where: { id: { in: productIds } } } : {}),
        filterContext: {
          channel: channelParam ?? null,
          marketplace: marketplaceParam ?? null,
          productIdsHash: hasIdFilter
            ? productIds.slice().sort().join(',')
            : null,
        },
      })
      reply.header('ETag', etag)
      reply.header('Cache-Control', 'private, max-age=0, must-revalidate')
      if (matches(request, etag)) {
        return reply.code(304).send()
      }

      const rows = await prisma.product.findMany({
        ...(hasIdFilter ? { where: { id: { in: productIds } } } : {}),
        select: {
          id: true,
          sku: true,
          name: true,
          basePrice: true,
          costPrice: true,
          minMargin: true,
          minPrice: true,
          maxPrice: true,
          totalStock: true,
          lowStockThreshold: true,
          brand: true,
          manufacturer: true,
          upc: true,
          ean: true,
          weightValue: true,
          weightUnit: true,
          // D.3j: dimensions
          dimLength: true,
          dimWidth: true,
          dimHeight: true,
          dimUnit: true,
          status: true,
          fulfillmentChannel: true,
          isParent: true,
          parentId: true,
          amazonAsin: true,
          ebayItemId: true,
          syncChannels: true,
          variantAttributes: true,
          updatedAt: true,
          // ── D.3a additions — verify migration applied ────────────
          gtin: true,
          cascadedFields: true,
          // ── D.3e: needed for category-specific attribute display
          categoryAttributes: true,
          productType: true,
        },
        // Parents first via parentId asc (NULLs first in Postgres asc),
        // then SKU.
        orderBy: [{ parentId: 'asc' }, { sku: 'asc' }],
      })

      // Coerce Decimal → number for JSON safety + cheap client compares
      let products: any[] = rows.map((p) => ({
        ...p,
        basePrice: Number(p.basePrice),
        costPrice: p.costPrice == null ? null : Number(p.costPrice),
        minMargin: p.minMargin == null ? null : Number(p.minMargin),
        minPrice: p.minPrice == null ? null : Number(p.minPrice),
        maxPrice: p.maxPrice == null ? null : Number(p.maxPrice),
        weightValue: p.weightValue == null ? null : Number(p.weightValue),
        dimLength: p.dimLength == null ? null : Number(p.dimLength),
        dimWidth: p.dimWidth == null ? null : Number(p.dimWidth),
        dimHeight: p.dimHeight == null ? null : Number(p.dimHeight),
      }))

      // Attach _channelListing for the requested context so the table
      // can render amazon_*/ebay_* cells from real data.
      if (includeChannelListing) {
        const productIds = products.map((p) => p.id)
        const listings = await prisma.channelListing.findMany({
          where: {
            productId: { in: productIds },
            channel: channelParam!,
            marketplace: marketplaceParam!,
          },
          select: {
            productId: true,
            title: true,
            description: true,
            price: true,
            quantity: true,
            listingStatus: true,
            // AA.2 — surface platformAttributes so the bulk grid can
            // derive eBay categoryIds in data and render the
            // schema-driven aspect columns.
            platformAttributes: true,
          },
        })
        const byProductId = new Map(
          listings.map((l) => [
            l.productId,
            {
              title: l.title,
              description: l.description,
              price: l.price == null ? null : Number(l.price),
              quantity: l.quantity,
              listingStatus: l.listingStatus,
              platformAttributes: l.platformAttributes ?? null,
            },
          ])
        )
        products = products.map((p) => ({
          ...p,
          _channelListing: byProductId.get(p.id) ?? null,
        }))
      }

      return {
        products,
        count: products.length,
        channelContext: includeChannelListing
          ? { channel: channelParam, marketplace: marketplaceParam }
          : null,
      }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[products/bulk-fetch] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // GET /api/products/:id/children — channel-agnostic variant fetch.
  // Lifts categoryAttributes.variations to a top-level `variations` field
  // so the frontend can render axis badges without re-parsing JSON.
  // Aliased at /api/amazon/products/:id/children for backward compat.
  fastify.get<{ Params: { id: string } }>('/products/:id/children', async (request, reply) => {
    try {
      const { id } = request.params
      // Phase 10b — ETag short-circuit. Grid expand-on-chevron is
      // chatty (every parent click) and the children change rarely,
      // so 304s collapse the round-trip to ~50 bytes.
      const { etag } = await listEtag(prisma, {
        model: 'product',
        where: { parentId: id },
        filterContext: { parentId: id },
      })
      reply.header('ETag', etag)
      reply.header('Cache-Control', 'private, max-age=0, must-revalidate')
      if (matches(request, etag)) {
        return reply.code(304).send()
      }

      const children = await prisma.product.findMany({
        where: { parentId: id },
        orderBy: { sku: 'asc' },
      })
      const enriched = children.map((c) => {
        const ca = c.categoryAttributes
        const variations =
          ca && typeof ca === 'object' && !Array.isArray(ca) && (ca as any).variations
            ? ((ca as any).variations as Record<string, string>)
            : null
        return { ...c, variations }
      })
      return { success: true, children: enriched }
    } catch (error) {
      return reply.code(500).send({ success: false, error: error instanceof Error ? error.message : 'Unknown error' })
    }
  })

  // PATCH /api/products/bulk
  //
  // Body: { changes: Array<{ id, field, value, cascade? }> }
  //
  // - Validates against ALLOWED_FIELDS, type-coerces, atomically
  //   applies survivors in a single Prisma transaction.
  // - cascade=true (D.3c): finds children of `id`, applies the same
  //   change to each, and pushes `field` onto each child's
  //   `cascadedFields` array (deduped on read).
  // - cascade=false on a child product: also removes `field` from
  //   that child's `cascadedFields` array — direct edit overrides
  //   any prior parent-cascaded value.
  //
  // Audit row captures:
  //   cascadeCount       — how many cascade fan-outs ran
  //   affectedChildren   — every child id touched by a cascade
  fastify.patch<{
    Body: {
      changes: Array<{
        id: string
        field: string
        value: unknown
        cascade?: boolean
      }>
      marketplaceContext?: {
        channel: 'AMAZON' | 'EBAY'
        marketplace: string
      }
      /** R.1 — multi-target fan-out. When set (and non-empty), every
       *  channel-field upsert runs once per matching context, so a
       *  single edit lands on AMAZON:IT + AMAZON:DE + AMAZON:FR in
       *  one PATCH. Falls back to `marketplaceContext` (singular) for
       *  backwards compat. */
      marketplaceContexts?: Array<{
        channel: 'AMAZON' | 'EBAY'
        marketplace: string
      }>
    }
  }>('/products/bulk', {
    // NN.16 — explicit body limit. Fastify's default is 1MB; bulk
    // pastes from large catalogs can legitimately reach a few MB,
    // but anything past 5MB is suspicious (a 5MB JSON body is ~50k
    // single-field changes, well past the per-request cap on the
    // changes loop). Reject early with 413 instead of letting the
    // request OOM the API process.
    bodyLimit: 5 * 1024 * 1024,
    // NN.5 / OO.1 — per-route rate limit. Loosened to 300/min after
    // the initial 30/min was too tight for genuine bulk-edit
    // sessions (multiple PATCHes per second when a user is typing
    // through 50 cells). 300/min still blocks the runaway-loop
    // case but doesn't get in a real user's way.
    config: {
      rateLimit: { max: 300, timeWindow: '1 minute' },
    },
  }, async (request, reply) => {
    const { changes, marketplaceContext, marketplaceContexts } =
      request.body ?? {}
    // Effective context list: prefer the new array, fall back to the
    // singular form, dedupe.
    const rawContexts: Array<{ channel: 'AMAZON' | 'EBAY'; marketplace: string }> =
      Array.isArray(marketplaceContexts) && marketplaceContexts.length > 0
        ? marketplaceContexts
        : marketplaceContext
        ? [marketplaceContext]
        : []
    const effectiveContexts = (() => {
      const seen = new Set<string>()
      const out: typeof rawContexts = []
      for (const c of rawContexts) {
        if (!c?.channel || !c?.marketplace) continue
        const k = `${c.channel}:${c.marketplace}`
        if (seen.has(k)) continue
        seen.add(k)
        out.push(c)
      }
      return out
    })()
    // First context drives schema lookups (registry validation needs ONE
    // marketplace; rule of thumb is the schema is consistent across the
    // selected fan-out targets — selectors that mix incompatible
    // schemas get rejected per change anyway).
    const primaryContext = effectiveContexts[0] ?? null
    if (!Array.isArray(changes) || changes.length === 0) {
      return reply.code(400).send({ error: 'No changes provided' })
    }
    if (changes.length > 1000) {
      return reply.code(400).send({ error: 'Max 1000 changes per request' })
    }

    const ALLOWED_FIELDS = new Set([
      'name',
      'description', // D.5: ZIP upload + grid editing
      'basePrice',
      'costPrice',
      'minMargin',
      'minPrice',
      'maxPrice',
      'totalStock',
      'lowStockThreshold',
      'brand',
      'manufacturer',
      'upc',
      'ean',
      'weightValue',
      // D.3j: weight/dim units + dim values
      'weightUnit',
      'dimLength',
      'dimWidth',
      'dimHeight',
      'dimUnit',
      // D.3k: master-level GTIN
      'gtin',
      'status',
      'fulfillmentChannel',
      // CC.1 — master Amazon productType. Drives the schema-driven
      // attribute set; per-listing override stays in
      // platformAttributes.productType (Q.5).
      'productType',
    ])
    // D.3d: prefixed channel fields write to ChannelListing instead of
    // Product. Only the suffixes in this set are wired today; the rest
    // of amazon_*/ebay_* are still read-only in the registry.
    const CHANNEL_FIELD_MAP: Record<string, string> = {
      amazon_title: 'title',
      amazon_description: 'description',
      ebay_title: 'title',
      ebay_description: 'description',
      // CC.1 — variationTheme on ChannelListing, surfaced per-channel
      // in the registry. Same target column for both prefixes.
      amazon_variationTheme: 'variationTheme',
      ebay_variationTheme: 'variationTheme',
    }
    const isChannelField = (f: string) =>
      Object.prototype.hasOwnProperty.call(CHANNEL_FIELD_MAP, f)
    const channelOf = (f: string): 'AMAZON' | 'EBAY' | null =>
      f.startsWith('amazon_') ? 'AMAZON' : f.startsWith('ebay_') ? 'EBAY' : null
    const isCategoryAttrField = (f: string) => f.startsWith('attr_')
    const NUMERIC_FIELDS = new Set([
      'basePrice',
      'costPrice',
      'minMargin',
      'minPrice',
      'maxPrice',
      'weightValue',
      // D.3j
      'dimLength',
      'dimWidth',
      'dimHeight',
    ])
    const INTEGER_FIELDS = new Set(['totalStock', 'lowStockThreshold'])
    const STATUS_VALUES = new Set(['ACTIVE', 'DRAFT', 'INACTIVE'])
    const CHANNEL_VALUES = new Set(['FBA', 'FBM'])
    // D.3j: unit enums for the editable weightUnit / dimUnit fields.
    const WEIGHT_UNIT_VALUES = new Set(['kg', 'g', 'lb', 'oz'])
    const DIM_UNIT_VALUES = new Set(['cm', 'mm', 'in'])
    // Locale-tolerant numeric coercion: accept Italian / European
    // decimal commas ("5,5") alongside the canonical period.
    const numericFromLocale = (raw: unknown): number => {
      if (typeof raw === 'number') return raw
      if (raw == null) return NaN
      const s = String(raw).trim()
      if (s === '') return NaN
      // Only swap commas to periods when there's no period already
      // (avoids "1,000.00" → "1.000.00"). For our domain, raw user
      // inputs like "5,5" or "5.5" are the common cases.
      if (s.includes('.') || !s.includes(',')) return Number(s)
      return Number(s.replace(',', '.'))
    }

    interface Validated {
      id: string
      field: string
      value: any
      cascade: boolean
    }
    interface ChangeError {
      id: string
      field: string
      error: string
    }

    const validated: Validated[] = []
    const errors: ChangeError[] = []

    for (const c of changes) {
      if (!c?.id || typeof c.id !== 'string') {
        errors.push({ id: c?.id ?? '', field: c?.field ?? '', error: 'Missing id' })
        continue
      }
      const isCh = isChannelField(c.field ?? '')
      const isAttr = isCategoryAttrField(c.field ?? '')
      if (
        !c.field ||
        (!ALLOWED_FIELDS.has(c.field) && !isCh && !isAttr)
      ) {
        errors.push({ id: c.id, field: c.field ?? '', error: 'Field not editable' })
        continue
      }
      // For attr_* fields, the registry must have it AND be editable.
      // D.3g: getFieldDefinition is now async and falls back to the
      // cached Amazon schemas when the id isn't in the static
      // hardcoded list — so any field exposed by /api/pim/fields with
      // a marketplace context is also acceptable here.
      if (isAttr) {
        const def = await getFieldDefinition(c.field, {
          marketplace: primaryContext?.marketplace ?? null,
        })
        if (!def || !def.editable) {
          errors.push({
            id: c.id,
            field: c.field,
            error: 'Unknown or read-only category attribute',
          })
          continue
        }
        // Validate select options
        if (def.type === 'select' && def.options && c.value !== null) {
          if (!def.options.includes(String(c.value))) {
            errors.push({
              id: c.id,
              field: c.field,
              error: `Must be one of: ${def.options.join(', ')}`,
            })
            continue
          }
        }
      }
      // Channel fields require at least one marketplace context whose
      // channel matches the field's prefix (amazon_* → AMAZON, ebay_*
      // → EBAY). With R.1 multi-targets, a request that selects e.g.
      // AMAZON:IT + EBAY:UK can carry both `amazon_title` and
      // `ebay_title` changes — each routes to its matching contexts.
      if (isCh) {
        if (effectiveContexts.length === 0) {
          errors.push({
            id: c.id,
            field: c.field,
            error: 'marketplaceContexts required for channel fields',
          })
          continue
        }
        const expectedChannel = channelOf(c.field)
        const matching = expectedChannel
          ? effectiveContexts.filter((ctx) => ctx.channel === expectedChannel)
          : effectiveContexts
        if (matching.length === 0) {
          errors.push({
            id: c.id,
            field: c.field,
            error: `Field belongs to ${expectedChannel} but no ${expectedChannel} target was selected`,
          })
          continue
        }
      }

      let value: any = c.value

      // Category attributes (attr_*) — text + select fields. Trim text,
      // pass select values through (validation already gated above).
      if (isAttr) {
        if (typeof value !== 'string' && value !== null && value !== undefined) {
          value = String(value)
        }
        if (typeof value === 'string') {
          const trimmed = value.trim()
          value = trimmed === '' ? null : trimmed
        }
        validated.push({
          id: c.id,
          field: c.field,
          value,
          cascade: !!c.cascade,
        })
        continue
      }

      // Channel fields are all text in D.3d (title, description). Trim,
      // null on empty.
      if (isCh) {
        if (typeof value !== 'string' && value !== null && value !== undefined) {
          value = String(value)
        }
        if (typeof value === 'string') {
          const trimmed = value.trim()
          value = trimmed === '' ? null : trimmed
        }
        // Length validation (lightweight — frontend already enforces)
        if (
          typeof value === 'string' &&
          c.field === 'amazon_title' &&
          value.length > 200
        ) {
          errors.push({
            id: c.id,
            field: c.field,
            error: 'Amazon title max 200 characters',
          })
          continue
        }
        if (
          typeof value === 'string' &&
          c.field === 'ebay_title' &&
          value.length > 80
        ) {
          errors.push({
            id: c.id,
            field: c.field,
            error: 'eBay title max 80 characters',
          })
          continue
        }
        validated.push({ id: c.id, field: c.field, value, cascade: !!c.cascade })
        continue
      }

      if (NUMERIC_FIELDS.has(c.field)) {
        if (value === '' || value === null || value === undefined) {
          value = null
        } else {
          const n = numericFromLocale(value)
          if (Number.isNaN(n)) {
            errors.push({ id: c.id, field: c.field, error: 'Invalid number' })
            continue
          }
          if (n < 0) {
            errors.push({ id: c.id, field: c.field, error: 'Must be ≥ 0' })
            continue
          }
          value = n
        }
      } else if (c.field === 'weightUnit') {
        const v = String(value ?? '').toLowerCase()
        if (!WEIGHT_UNIT_VALUES.has(v)) {
          errors.push({
            id: c.id,
            field: c.field,
            error: `Weight unit must be one of ${Array.from(WEIGHT_UNIT_VALUES).join(', ')}`,
          })
          continue
        }
        value = v
      } else if (c.field === 'dimUnit') {
        const v = String(value ?? '').toLowerCase()
        if (!DIM_UNIT_VALUES.has(v)) {
          errors.push({
            id: c.id,
            field: c.field,
            error: `Dimension unit must be one of ${Array.from(DIM_UNIT_VALUES).join(', ')}`,
          })
          continue
        }
        value = v
      } else if (c.field === 'gtin') {
        // Empty / null clears it.
        if (value === '' || value === null || value === undefined) {
          value = null
        } else {
          const digits = String(value).replace(/\D/g, '')
          if (digits.length < 8 || digits.length > 14) {
            errors.push({
              id: c.id,
              field: c.field,
              error: 'GTIN must be 8–14 digits',
            })
            continue
          }
          value = digits
        }
      } else if (INTEGER_FIELDS.has(c.field)) {
        if (value === '' || value === null || value === undefined) {
          value = 0
        } else {
          const n = parseInt(String(value), 10)
          if (Number.isNaN(n)) {
            errors.push({ id: c.id, field: c.field, error: 'Invalid integer' })
            continue
          }
          if (n < 0) {
            errors.push({ id: c.id, field: c.field, error: 'Must be ≥ 0' })
            continue
          }
          value = n
        }
      } else if (c.field === 'status') {
        const v = String(value ?? '').toUpperCase()
        if (!STATUS_VALUES.has(v)) {
          errors.push({
            id: c.id,
            field: c.field,
            error: `Status must be one of ${Array.from(STATUS_VALUES).join(', ')}`,
          })
          continue
        }
        value = v
      } else if (c.field === 'fulfillmentChannel') {
        if (value === '' || value === null || value === undefined) {
          value = null
        } else {
          const v = String(value).toUpperCase()
          if (!CHANNEL_VALUES.has(v)) {
            errors.push({
              id: c.id,
              field: c.field,
              error: `Channel must be one of ${Array.from(CHANNEL_VALUES).join(', ')}`,
            })
            continue
          }
          value = v
        }
      } else {
        // text fields — trim, coerce empty string to null only for
        // optional fields. name is required, leave as-is.
        if (typeof value !== 'string' && value !== null && value !== undefined) {
          value = String(value)
        }
        if (c.field === 'name') {
          if (!value || (typeof value === 'string' && value.trim().length === 0)) {
            errors.push({ id: c.id, field: c.field, error: 'Name cannot be empty' })
            continue
          }
          value = (value as string).trim()
        } else if (typeof value === 'string') {
          const trimmed = value.trim()
          value = trimmed === '' ? null : trimmed
        }
      }

      validated.push({ id: c.id, field: c.field, value, cascade: !!c.cascade })
    }

    // Nothing survived validation — do not open a transaction
    if (validated.length === 0) {
      await prisma.bulkOperation.create({
        data: {
          changeCount: changes.length,
          productCount: new Set(changes.map((c) => c.id)).size,
          changes: changes as any,
          status: 'FAILED',
          errors: errors as any,
        },
      })
      return reply.code(400).send({ errors })
    }

    // Apply survivors atomically. Per-row updates in a single
    // transaction (array form). With serverless max:1 connection and
    // sequential transactions, this is ~13ms per row.
    //
    // D.3c additions:
    //   - cascade=true: pre-fetches children for each cascading parent,
    //     adds extra updates for each child. cascadedFields gets the
    //     field name appended (deduped on read; allowing dups is fine
    //     and avoids an extra round-trip per child).
    //   - cascade=false on a child: removes the field from the child's
    //     cascadedFields array via raw SQL array_remove, so a direct
    //     edit cleanly overrides any prior cascade.
    try {
      const startTs = Date.now()
      const productIds = new Set(validated.map((v) => v.id))

      // Pre-fetch which validated targets are children (parentId set).
      // Used to decide whether to call array_remove on cascadedFields
      // when applying a non-cascade change.
      const targetIds = Array.from(productIds)
      const targetProducts = await prisma.product.findMany({
        where: { id: { in: targetIds } },
        select: { id: true, parentId: true, isParent: true },
      })
      const childIdSet = new Set(
        targetProducts.filter((p) => p.parentId).map((p) => p.id)
      )

      // Pre-fetch children for cascading parents.
      const cascadingParents = validated.filter((v) => v.cascade)
      const childrenByParent = new Map<string, string[]>()
      let totalAffectedChildren = 0
      const allAffectedChildIds = new Set<string>()
      if (cascadingParents.length > 0) {
        const parentIds = Array.from(
          new Set(cascadingParents.map((v) => v.id))
        )
        const kids = await prisma.product.findMany({
          where: { parentId: { in: parentIds } },
          select: { id: true, parentId: true },
        })
        for (const k of kids) {
          if (!k.parentId) continue
          let arr = childrenByParent.get(k.parentId)
          if (!arr) {
            arr = []
            childrenByParent.set(k.parentId, arr)
          }
          arr.push(k.id)
          allAffectedChildIds.add(k.id)
        }
        totalAffectedChildren = allAffectedChildIds.size
      }

      // Build the transaction's update list. One Prisma promise per
      // statement; runs serially in array-form $transaction.
      const updates: any[] = []

      // Helper for ChannelListing upsert by (productId, channel,
      // marketplace). R.1 — fans out to every effectiveContext whose
      // channel matches the field's prefix, so one change targets all
      // selected markets in a single transaction. Returns an array of
      // Prisma promises (possibly empty) rather than a single one.
      const upsertChannelListings = (
        productId: string,
        field: string,
        value: any,
      ) => {
        if (effectiveContexts.length === 0) return []
        const stripped = CHANNEL_FIELD_MAP[field]
        if (!stripped) return []
        const expected = channelOf(field)
        const targets = expected
          ? effectiveContexts.filter((ctx) => ctx.channel === expected)
          : effectiveContexts
        return targets.map((ctx) => {
          const channelMarket = `${ctx.channel}_${ctx.marketplace}`
          return prisma.channelListing.upsert({
            where: {
              productId_channel_marketplace: {
                productId,
                channel: ctx.channel,
                marketplace: ctx.marketplace,
              },
            },
            create: {
              productId,
              channel: ctx.channel,
              channelMarket,
              region: ctx.marketplace,
              marketplace: ctx.marketplace,
              listingStatus: 'DRAFT',
              [stripped]: value,
            } as any,
            update: { [stripped]: value } as any,
          })
        })
      }

      // ── D.3e: pre-group attr_* changes per product ────────────────
      // We MERGE everything for one product into a single jsonb in
      // one UPDATE rather than emitting one statement per attr.
      // Map<productId, Record<strippedKey, value>> — separate maps
      // for direct vs cascade so cascade fan-out can read its own group.
      const attrDirectByProduct = new Map<string, Record<string, any>>()
      const attrCascadeByProduct = new Map<string, Record<string, any>>()
      const attrCascadeFieldNames = new Map<string, string[]>() // for cascadedFields tracking

      // Phase 13d — basePrice and totalStock changes route through
      // dedicated services (MasterPriceService / applyStockMovement)
      // AFTER the bulk transaction commits, so the cascade to
      // ChannelListing fires atomically per product. We collect them
      // here, skip the direct prisma.product.update inside the bulk
      // transaction, and process them post-commit. Cascade fan-out to
      // children + cascadedFields markers stay inside the bulk
      // transaction (same place as other field cascades).
      type MasterDataDelta = { productId: string; newValue: number }
      const priceDeltas: MasterDataDelta[] = []
      const stockDeltas: MasterDataDelta[] = []
      const isMasterDataField = (f: string) =>
        f === 'basePrice' || f === 'totalStock'

      for (const v of validated) {
        if (!isCategoryAttrField(v.field)) continue
        const stripped = v.field.replace(/^attr_/, '')
        const target = v.cascade ? attrCascadeByProduct : attrDirectByProduct
        let bag = target.get(v.id)
        if (!bag) {
          bag = {}
          target.set(v.id, bag)
        }
        bag[stripped] = v.value
        if (v.cascade) {
          let names = attrCascadeFieldNames.get(v.id)
          if (!names) {
            names = []
            attrCascadeFieldNames.set(v.id, names)
          }
          names.push(v.field)
        }
      }

      // attr_* writers — use jsonb merge: COALESCE ensures null becomes
      // empty object first; the || operator does shallow merge so
      // existing keys not in the patch are preserved.
      const writeAttrMerge = (productId: string, patch: Record<string, any>) =>
        prisma.$executeRaw`
          UPDATE "Product"
          SET "categoryAttributes" = COALESCE("categoryAttributes", '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb
          WHERE id = ${productId}
        `

      for (const v of validated) {
        const isCh = isChannelField(v.field)
        const isAttr = isCategoryAttrField(v.field)

        // Skip individual attr_* loop iterations — handled in batched
        // writes below the main loop.
        if (isAttr) continue

        // Phase 13d — master-data fields (basePrice, totalStock) get
        // collected for post-commit service dispatch instead of being
        // pushed straight into the bulk transaction. The cascadedFields
        // bookkeeping for children stays in the bulk transaction; only
        // the actual master-data write is hoisted out so the service
        // can run its cascade as a single atomic transaction per
        // product.
        if (isMasterDataField(v.field)) {
          const collector = v.field === 'basePrice' ? priceDeltas : stockDeltas
          const numericValue =
            v.field === 'basePrice'
              ? Number(v.value)
              : Math.max(0, Math.floor(Number(v.value) || 0))
          if (v.field === 'basePrice' && (!Number.isFinite(numericValue) || numericValue < 0)) {
            errors.push({
              id: v.id,
              field: v.field,
              error: 'basePrice must be a non-negative number',
            })
            continue
          }
          if (v.cascade) {
            collector.push({ productId: v.id, newValue: numericValue })
            const kids = childrenByParent.get(v.id) ?? []
            for (const childId of kids) {
              collector.push({ productId: childId, newValue: numericValue })
              // cascadedFields marker for the child stays in the bulk
              // transaction so the visual "inheriting" state lands
              // atomically with the rest of the patch.
              updates.push(
                prisma.product.update({
                  where: { id: childId },
                  data: { cascadedFields: { push: v.field } } as any,
                }),
              )
            }
          } else if (childIdSet.has(v.id)) {
            // Direct edit on a child — service handles the value
            // write; cascadedFields removal stays here so the
            // "inherited" badge clears atomically.
            collector.push({ productId: v.id, newValue: numericValue })
            updates.push(
              prisma.$executeRaw`
                UPDATE "Product"
                SET "cascadedFields" = array_remove("cascadedFields", ${v.field})
                WHERE id = ${v.id}
              `,
            )
          } else {
            // Direct edit on a parent or standalone.
            collector.push({ productId: v.id, newValue: numericValue })
          }
          continue
        }

        if (v.cascade) {
          // Cascade applies to the parent itself + all its children.
          // For channel fields, each "update" is a ChannelListing
          // upsert in the active marketplace context. cascadedFields
          // tracking still goes on the Product row so children can be
          // visually distinguished as inheriting.
          if (isCh) {
            updates.push(...upsertChannelListings(v.id, v.field, v.value))
            const kids = childrenByParent.get(v.id) ?? []
            for (const childId of kids) {
              updates.push(
                ...upsertChannelListings(childId, v.field, v.value),
              )
              // Track on Product.cascadedFields with the prefixed name
              updates.push(
                prisma.product.update({
                  where: { id: childId },
                  data: { cascadedFields: { push: v.field } } as any,
                })
              )
            }
          } else {
            updates.push(
              prisma.product.update({
                where: { id: v.id },
                data: { [v.field]: v.value } as any,
              })
            )
            const kids = childrenByParent.get(v.id) ?? []
            for (const childId of kids) {
              updates.push(
                prisma.product.update({
                  where: { id: childId },
                  data: {
                    [v.field]: v.value,
                    cascadedFields: { push: v.field },
                  } as any,
                })
              )
            }
          }
        } else if (isCh) {
          // Direct channel-field edit. With R.1 multi-targets this
          // upserts one ChannelListing row per matching context. For
          // children, also remove the prefixed field from
          // cascadedFields so future renders don't show "inherited."
          updates.push(...upsertChannelListings(v.id, v.field, v.value))
          if (childIdSet.has(v.id)) {
            updates.push(
              prisma.$executeRaw`
                UPDATE "Product"
                SET "cascadedFields" = array_remove("cascadedFields", ${v.field})
                WHERE id = ${v.id}
              `
            )
          }
        } else if (childIdSet.has(v.id)) {
          // Direct edit on a child Product field — also remove the
          // field from cascadedFields if it's there (override).
          updates.push(
            prisma.$executeRaw`
              UPDATE "Product"
              SET ${Prisma.raw(`"${v.field}"`)} = ${v.value as any},
                  "cascadedFields" = array_remove("cascadedFields", ${v.field})
              WHERE id = ${v.id}
            `
          )
        } else {
          // Direct edit on a parent or standalone Product field
          updates.push(
            prisma.product.update({
              where: { id: v.id },
              data: { [v.field]: v.value } as any,
            })
          )
        }
      }

      // ── D.3e: emit batched attr_* writes ───────────────────────────
      // Direct attr edits — one merged UPDATE per product. For children
      // we also array_remove the attr_* field names from cascadedFields
      // so a direct override clears the "inherited" marker (matching
      // the non-attr child override semantics above).
      for (const [productId, patch] of attrDirectByProduct) {
        updates.push(writeAttrMerge(productId, patch))
        if (childIdSet.has(productId)) {
          for (const stripped of Object.keys(patch)) {
            const fieldName = `attr_${stripped}`
            updates.push(
              prisma.$executeRaw`
                UPDATE "Product"
                SET "cascadedFields" = array_remove("cascadedFields", ${fieldName})
                WHERE id = ${productId}
              `
            )
          }
        }
      }

      // Cascade attr edits — merge into parent + every child, then
      // push the prefixed field names onto each child's cascadedFields.
      for (const [parentId, patch] of attrCascadeByProduct) {
        updates.push(writeAttrMerge(parentId, patch))
        const kids = childrenByParent.get(parentId) ?? []
        const fieldNames = attrCascadeFieldNames.get(parentId) ?? []
        for (const childId of kids) {
          updates.push(writeAttrMerge(childId, patch))
          for (const fieldName of fieldNames) {
            updates.push(
              prisma.product.update({
                where: { id: childId },
                data: { cascadedFields: { push: fieldName } } as any,
              })
            )
          }
        }
      }

      await prisma.$transaction(updates, {
        isolationLevel: 'ReadCommitted',
      })

      // Phase 13d — process master-data cascades after the bulk
      // transaction commits. Each call is its own transaction
      // (price service / stock movement) and runs the
      // ChannelListing fan-out + outbound queue + audit log
      // atomically per product. Failures here don't roll back the
      // bulk transaction (which already committed); they're
      // surfaced via the errors array so the client can highlight
      // the affected cells. ChannelListing and listings cascade
      // are still atomic per-product — the partial-failure window
      // is per-row, not per-listing.
      if (priceDeltas.length > 0) {
        // Pre-deduplicate: a product appearing twice in the same PATCH
        // (say cascade=true and a separate direct edit on the same
        // child) collapses to the last value, since the master-data
        // write is idempotent and we want the no-op short-circuit in
        // the service to do its job rather than enqueueing the same
        // sync twice.
        const dedup = new Map<string, number>()
        for (const d of priceDeltas) dedup.set(d.productId, d.newValue)
        for (const [productId, newValue] of dedup) {
          try {
            await masterPriceService.update(productId, newValue, {
              actor: null,
              reason: 'bulk-grid-patch',
              idempotencyKey: `bulk:${startTs}:${productId}:basePrice`,
            })
          } catch (err) {
            errors.push({
              id: productId,
              field: 'basePrice',
              error: err instanceof Error ? err.message : String(err),
            })
          }
        }
      }
      if (stockDeltas.length > 0) {
        const dedup = new Map<string, number>()
        for (const d of stockDeltas) dedup.set(d.productId, d.newValue)
        // Read all current totals in one query so we can compute deltas
        // without N round-trips. The values may have shifted between
        // the bulk commit and now (concurrent stock movement), but
        // applyStockMovement reads its own current value transactionally
        // before applying the delta, so this is just a starting point.
        const productIds = Array.from(dedup.keys())
        const currentRows = await prisma.product.findMany({
          where: { id: { in: productIds } },
          select: { id: true, totalStock: true },
        })
        const currentTotalById = new Map<string, number>(
          currentRows.map((r) => [r.id, r.totalStock ?? 0]),
        )
        for (const [productId, newValue] of dedup) {
          const current = currentTotalById.get(productId) ?? 0
          const delta = newValue - current
          if (delta === 0) continue
          try {
            await applyStockMovement({
              productId,
              change: delta,
              reason: 'MANUAL_ADJUSTMENT',
              notes: 'bulk grid edit',
              actor: undefined,
            })
          } catch (err) {
            errors.push({
              id: productId,
              field: 'totalStock',
              error: err instanceof Error ? err.message : String(err),
            })
          }
        }
      }

      const elapsedMs = Date.now() - startTs

      const overallStatus =
        errors.length === 0 ? 'SUCCESS' : 'PARTIAL'

      const bulkOp = await prisma.bulkOperation.create({
        data: {
          changeCount: changes.length,
          productCount: productIds.size,
          changes: validated as any,
          status: overallStatus,
          errors: errors.length ? (errors as any) : undefined,
          cascadeCount: cascadingParents.length,
          affectedChildren: Array.from(allAffectedChildIds),
        },
      })

      // NN.4 — append-only audit log. One row per (productId, field)
      // touched in this PATCH so future audits can answer "who
      // changed price on SKU X last Tuesday." metadata pins the
      // bulkOperation id so the two tables join cleanly.
      const auditRows = validated.map((c: any) => ({
        userId: null,
        ip: request.ip ?? null,
        entityType: 'Product',
        entityId: c.id,
        action: 'update',
        after: { field: c.field, value: c.value },
        metadata: {
          bulkOperationId: bulkOp.id,
          cascade: !!c.cascade,
          source: 'bulk-patch',
        },
      }))
      void auditLogService.writeMany(auditRows)

      return {
        success: true,
        // NN.7 — surface the BulkOperation row id so the client can
        // show "operation id: bulk_xxx" in the failure toast and a
        // future "view audit log" panel can drill in. errors already
        // carry per-(id, field) attribution; the client maps them
        // into cell-level error highlights.
        operationId: bulkOp.id,
        updated: validated.length,
        cascadeCount: cascadingParents.length,
        affectedChildren: totalAffectedChildren,
        errors: errors.length ? errors : undefined,
        elapsedMs,
      }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[products/bulk] transaction failed')
      await prisma.bulkOperation
        .create({
          data: {
            changeCount: changes.length,
            productCount: new Set(changes.map((c) => c.id)).size,
            changes: changes as any,
            status: 'FAILED',
            errors: [{ error: error?.message ?? String(error) }] as any,
          },
        })
        .catch(() => {
          /* don't mask the real error with an audit-log failure */
        })
      return reply.code(500).send({
        error: 'Bulk update failed',
        message: error?.message ?? String(error),
      })
    }
  })

  // ── Performance-test seeding (admin-only — no auth gate but uses
  // ── importSource = 'PERFORMANCE_TEST' so cleanup can wipe them) ──
  //
  // POST /api/admin/seed-bulk-test  body: { target?: number }
  // Inserts batched test rows up to `target` (capped at 20k).
  // Idempotent via skipDuplicates on SKU unique.
  fastify.post<{ Body: { target?: number } }>(
    '/admin/seed-bulk-test',
    {
      // Phase 10/A2 — admin endpoint inserts up to 20k Product rows
      // per call. Single-digit/min cap so this can never be triggered
      // accidentally from a runaway script. NOTE: still no auth gate;
      // tracked separately in TECH_DEBT once auth lands.
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const target = Math.min(
        Math.max(parseInt(String(request.body?.target ?? 10000), 10) || 10000, 0),
        20000
      )

      const existing = await prisma.product.count()
      const needed = target - existing
      if (needed <= 0) {
        return { ok: true, inserted: 0, total: existing, target }
      }

      const BRANDS = ['Xavia Racing', 'Test Brand A', 'Test Brand B', 'Performance Test']
      const STATUSES = ['ACTIVE', 'DRAFT', 'INACTIVE']
      const CHANNELS: string[][] = [['AMAZON'], ['EBAY'], ['AMAZON', 'EBAY'], []]

      const BATCH = 500
      let totalInserted = 0
      const startTs = Date.now()
      for (let i = 0; i < needed; i += BATCH) {
        const chunk = Math.min(BATCH, needed - i)
        const data = Array.from({ length: chunk }, (_, idx) => {
          const num = existing + i + idx
          return {
            sku: `TEST-${String(num).padStart(6, '0')}`,
            name: `Performance Test Product ${num} - ${BRANDS[num % 4]} Edition`,
            basePrice: parseFloat((10 + (num % 100) * 1.5).toFixed(2)),
            costPrice: parseFloat((5 + (num % 50) * 0.8).toFixed(2)),
            minMargin: 0.2,
            totalStock: num % 200,
            lowStockThreshold: 10,
            brand: BRANDS[num % 4],
            manufacturer: BRANDS[num % 4],
            upc: `${1000000000 + num}`,
            status: STATUSES[num % 3],
            syncChannels: CHANNELS[num % 4],
            isParent: false,
            amazonAsin:
              num % 3 === 0 ? `B0TEST${String(num).padStart(5, '0')}` : null,
            importSource: 'PERFORMANCE_TEST',
          }
        })
        try {
          const r = await prisma.product.createMany({ data, skipDuplicates: true })
          totalInserted += r.count
        } catch (error: any) {
          fastify.log.error(
            { err: error, batchOffset: i },
            '[seed-bulk-test] batch failed'
          )
          return reply.code(500).send({
            error: error?.message ?? String(error),
            partialInserted: totalInserted,
          })
        }
      }

      const elapsedMs = Date.now() - startTs
      const total = await prisma.product.count()
      return { ok: true, inserted: totalInserted, total, target, elapsedMs }
    }
  )

  // Helper: delete a set of Products + every dependent row whose FK
  // doesn't cascade. Five tables in the schema reference Product
  // without `onDelete: Cascade` (ProductImage, MarketplaceSync,
  // Listing, StockLog, FBAShipmentItem) — bare deleteMany on Product
  // hits a FK violation if any of those have rows. This wraps the
  // dependents + the Product delete in a single transaction.
  const cascadeDeleteProducts = async (
    where: Prisma.ProductWhereInput,
  ): Promise<{
    deleted: number
    dependents: {
      productImages: number
      marketplaceSyncs: number
      listings: number
      stockLogs: number
      fbaShipmentItems: number
    }
  }> => {
    const products = await prisma.product.findMany({
      where,
      select: { id: true },
    })
    const ids = products.map((p) => p.id)
    if (ids.length === 0) {
      return {
        deleted: 0,
        dependents: {
          productImages: 0,
          marketplaceSyncs: 0,
          listings: 0,
          stockLogs: 0,
          fbaShipmentItems: 0,
        },
      }
    }
    const productIdFilter = { productId: { in: ids } }
    const result = await prisma.$transaction(async (tx) => {
      const productImages = await tx.productImage.deleteMany({
        where: productIdFilter,
      })
      const marketplaceSyncs = await tx.marketplaceSync.deleteMany({
        where: productIdFilter,
      })
      const listings = await tx.listing.deleteMany({
        where: productIdFilter,
      })
      const stockLogs = await tx.stockLog.deleteMany({
        where: productIdFilter,
      })
      const fbaShipmentItems = await tx.fBAShipmentItem.deleteMany({
        where: productIdFilter,
      })
      const products = await tx.product.deleteMany({
        where: { id: { in: ids } },
      })
      return {
        deleted: products.count,
        dependents: {
          productImages: productImages.count,
          marketplaceSyncs: marketplaceSyncs.count,
          listings: listings.count,
          stockLogs: stockLogs.count,
          fbaShipmentItems: fbaShipmentItems.count,
        },
      }
    })
    return result
  }

  // DELETE /api/admin/cleanup-bulk-test
  // Removes every Product row marked importSource = 'PERFORMANCE_TEST'.
  // Cascades manually to dependents that don't FK-cascade.
  fastify.delete(
    '/admin/cleanup-bulk-test',
    {
      // Phase 10/A2 — destructive admin endpoint. Same 5/min cap as
      // its sibling seed endpoint to keep accidental re-runs cheap.
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    },
    async (_request, reply) => {
    try {
      const result = await cascadeDeleteProducts({
        importSource: 'PERFORMANCE_TEST',
      })
      return { ok: true, ...result }
    } catch (error: any) {
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // ── D.4: CSV / XLSX bulk upload ────────────────────────────────
  // PP — Single-product create wizard endpoint.
  //
  // POST /api/products/create-wizard
  //   Body: master product fields + optional variations[]. Creates
  //   the Product row and (optionally) per-variant ProductVariation
  //   rows in one transaction so a partial create can't leave
  //   orphaned variants. Channel listings are NOT created here —
  //   that's the listing wizard's job; the user can chain into it
  //   from the success page.
  //
  // Returns { product: { id, sku, ... }, variationCount } on 201.
  fastify.post<{
    Body: {
      sku: string
      name: string
      brand?: string | null
      productType?: string | null
      description?: string | null
      basePrice: number
      costPrice?: number | null
      totalStock?: number | null
      lowStockThreshold?: number | null
      upc?: string | null
      ean?: string | null
      gtin?: string | null
      weightValue?: number | null
      weightUnit?: string | null
      dimLength?: number | null
      dimWidth?: number | null
      dimHeight?: number | null
      dimUnit?: string | null
      manufacturer?: string | null
      categoryAttributes?: Record<string, unknown>
      variations?: Array<{
        sku: string
        name?: string | null
        variationAttributes?: Record<string, string>
        price?: number | null
        stock?: number | null
      }>
    }
  }>('/products/create-wizard', async (request, reply) => {
    const body = request.body ?? ({} as any)
    // Required-field guards. Mirror the catalog endpoint so error
    // shape matches and clients can branch the same way.
    if (!body.sku?.trim()) {
      return reply
        .code(400)
        .send({ error: 'sku is required', code: 'INVALID_REQUEST' })
    }
    if (!body.name?.trim()) {
      return reply
        .code(400)
        .send({ error: 'name is required', code: 'INVALID_REQUEST' })
    }
    if (
      typeof body.basePrice !== 'number' ||
      Number.isNaN(body.basePrice) ||
      body.basePrice < 0
    ) {
      return reply.code(400).send({
        error: 'basePrice must be a non-negative number',
        code: 'INVALID_REQUEST',
      })
    }

    // SKU uniqueness — check master + every variation up front so we
    // can return a clean conflict before the transaction starts.
    const variationSkus = (body.variations ?? []).map((v) => v.sku?.trim())
    if (variationSkus.some((s) => !s)) {
      return reply.code(400).send({
        error: 'every variation must have a non-empty sku',
        code: 'INVALID_REQUEST',
      })
    }
    const allSkus = [body.sku.trim(), ...variationSkus]
    if (new Set(allSkus).size !== allSkus.length) {
      return reply.code(400).send({
        error: 'duplicate SKUs in this request — master and variations must be unique',
        code: 'DUPLICATE_SKU',
      })
    }
    const conflict = await prisma.product.findFirst({
      where: { sku: { in: allSkus } },
      select: { sku: true },
    })
    if (conflict) {
      return reply.code(409).send({
        error: `SKU "${conflict.sku}" already exists`,
        code: 'DUPLICATE_SKU',
      })
    }

    try {
      const result = await prisma.$transaction(async (tx) => {
        const isParent = (body.variations?.length ?? 0) > 0
        const masterData: Record<string, unknown> = {
          sku: body.sku.trim(),
          name: body.name.trim(),
          basePrice: body.basePrice,
          isParent,
          status: 'ACTIVE',
          syncChannels: [],
          validationStatus: 'VALID',
          validationErrors: [],
          hasChannelOverrides: false,
        }
        // Optional fields: only set when present so we don't blow
        // away DB defaults with explicit null/undefined.
        if (body.brand !== undefined) masterData.brand = body.brand
        if (body.productType !== undefined)
          masterData.productType = body.productType
        if (body.description !== undefined)
          masterData.description = body.description
        if (typeof body.costPrice === 'number')
          masterData.costPrice = body.costPrice
        if (typeof body.totalStock === 'number')
          masterData.totalStock = body.totalStock
        if (typeof body.lowStockThreshold === 'number')
          masterData.lowStockThreshold = body.lowStockThreshold
        if (body.upc !== undefined) masterData.upc = body.upc
        if (body.ean !== undefined) masterData.ean = body.ean
        if (body.gtin !== undefined) masterData.gtin = body.gtin
        if (typeof body.weightValue === 'number')
          masterData.weightValue = body.weightValue
        if (body.weightUnit !== undefined)
          masterData.weightUnit = body.weightUnit
        if (typeof body.dimLength === 'number')
          masterData.dimLength = body.dimLength
        if (typeof body.dimWidth === 'number')
          masterData.dimWidth = body.dimWidth
        if (typeof body.dimHeight === 'number')
          masterData.dimHeight = body.dimHeight
        if (body.dimUnit !== undefined) masterData.dimUnit = body.dimUnit
        if (body.manufacturer !== undefined)
          masterData.manufacturer = body.manufacturer
        if (
          body.categoryAttributes &&
          Object.keys(body.categoryAttributes).length > 0
        ) {
          masterData.categoryAttributes = body.categoryAttributes
        }

        const product = await tx.product.create({ data: masterData as any })

        if (isParent && body.variations) {
          // Each variation also gets a Product row with parentId set
          // (the canonical "child product" pattern in this codebase),
          // plus a ProductVariation row with the attribute map. This
          // matches what catalog.routes.ts does for child creation.
          //
          // P.1 NOTE — the PV mirror is load-bearing for the listing
          // wizard's variations.service + submission.service, which
          // read children via the PV relation (not parentId). Until
          // those services are refactored to read Product.parentId
          // children, the PV mirror has to stay; disabling it would
          // make the wizard see children: [] for new variants.
          for (const v of body.variations) {
            const child = await tx.product.create({
              data: {
                sku: v.sku.trim(),
                name: v.name?.trim() || `${body.name} — ${v.sku.trim()}`,
                basePrice: v.price ?? body.basePrice,
                totalStock: v.stock ?? 0,
                parentId: product.id,
                isParent: false,
                isMasterProduct: false,
                status: 'ACTIVE',
                syncChannels: [],
                validationStatus: 'VALID',
                validationErrors: [],
                hasChannelOverrides: false,
              } as any,
            })
            await tx.productVariation.create({
              data: {
                productId: product.id,
                sku: v.sku.trim(),
                variationAttributes: (v.variationAttributes ?? {}) as any,
                price: v.price ?? body.basePrice,
                stock: v.stock ?? 0,
              } as any,
            })
            void child
          }
        }

        return product
      })

      // NN.4 — audit log the creation.
      void auditLogService.write({
        userId: null,
        ip: request.ip ?? null,
        entityType: 'Product',
        entityId: result.id,
        action: 'create',
        after: { sku: result.sku, name: result.name },
        metadata: {
          source: 'create-wizard',
          variationCount: body.variations?.length ?? 0,
        },
      })

      return reply.code(201).send({
        success: true,
        product: {
          id: result.id,
          sku: result.sku,
          name: result.name,
          isParent: result.isParent,
        },
        variationCount: body.variations?.length ?? 0,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      fastify.log.error({ err }, '[products/create-wizard] failed')
      return reply.code(500).send({ error: msg, code: 'CREATE_FAILED' })
    }
  })

  //
  // POST /api/products/bulk-upload
  //   multipart/form-data with one file. Parses + validates against
  //   the field registry, writes a BulkOperation row with status
  //   PENDING_APPLY holding the validated plan, returns
  //   { uploadId, preview }.
  fastify.post(
    '/products/bulk-upload',
    {
      // Phase 10/A2 — file upload + parse is heavy; cap to 30/min so
      // a stuck client retry loop can't pin parse threads.
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
    try {
      const part = await (request as any).file?.()
      if (!part) {
        return reply.code(400).send({ error: 'No file in request' })
      }
      const filename: string = part.filename ?? 'upload'
      const buf: Buffer = await part.toBuffer()
      let parsed
      try {
        parsed = await parseUploadBuffer(filename, buf)
      } catch (e: any) {
        return reply.code(400).send({ error: e?.message ?? 'Parse failed' })
      }
      let plan
      try {
        plan = await buildUploadPlan(prisma, filename, parsed.rows)
      } catch (e: any) {
        return reply.code(400).send({ error: e?.message ?? 'Validation failed' })
      }

      // Persist the plan so apply can replay without re-parsing. Only
      // include rows that have at least one change OR at least one
      // error — fully empty rows would just bloat the JSON.
      const planForDb: PlanRow[] = plan.rows.filter(
        (r) => r.changes.length > 0 || r.errors.length > 0,
      )
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000) // 30 min
      const summary = summarisePlan(plan)

      const op = await prisma.bulkOperation.create({
        data: {
          status: 'PENDING_APPLY',
          productCount: summary.toUpdate,
          changeCount: 0, // will be set on apply
          changes: planForDb as any,
          errors:
            summary.errors.length > 0 ? (summary.errors as any) : undefined,
          uploadFilename: filename,
          expiresAt,
        },
      })

      return {
        uploadId: op.id,
        preview: {
          ...summary,
          warnings: parsed.warnings,
          expiresAt: expiresAt.toISOString(),
        },
      }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[products/bulk-upload] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // POST /api/products/bulk-upload-zip
  //   D.5: ZIP archive with one folder per SKU. Each folder may
  //   carry a data.json (field updates) and/or description.html.
  //   Images/ subfolders + other files are surfaced as warnings; the
  //   apply path is the same as CSV uploads.
  fastify.post(
    '/products/bulk-upload-zip',
    {
      // Phase 10/A2 — ZIP parse is even heavier than CSV (zlib +
      // image stream + per-row validation); cap at 10/min.
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
    try {
      const part = await (request as any).file?.()
      if (!part) {
        return reply.code(400).send({ error: 'No file in request' })
      }
      const filename: string = part.filename ?? 'upload.zip'
      if (!/\.zip$/i.test(filename)) {
        return reply
          .code(400)
          .send({ error: 'Expected a .zip file' })
      }
      const buf: Buffer = await part.toBuffer()
      let result
      try {
        result = await parseZipUpload(prisma, filename, buf)
      } catch (e: any) {
        return reply.code(400).send({ error: e?.message ?? 'Parse failed' })
      }

      const planForDb: PlanRow[] = result.rows.filter(
        (r) => r.changes.length > 0 || r.errors.length > 0,
      )
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000)
      const summary = summarisePlan(result)

      const op = await prisma.bulkOperation.create({
        data: {
          status: 'PENDING_APPLY',
          productCount: summary.toUpdate,
          changeCount: 0,
          changes: planForDb as any,
          errors:
            summary.errors.length > 0 ? (summary.errors as any) : undefined,
          uploadFilename: filename,
          expiresAt,
        },
      })

      return {
        uploadId: op.id,
        preview: {
          ...summary,
          warnings: result.warnings,
          expiresAt: expiresAt.toISOString(),
        },
      }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[products/bulk-upload-zip] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // POST /api/products/bulk-apply
  //   body: { uploadId }
  //   Reads the PENDING_APPLY row, applies in chunks of 500, flips
  //   status to SUCCESS / PARTIAL / FAILED with completedAt.
  fastify.post<{ Body: { uploadId?: string } }>(
    '/products/bulk-apply',
    {
      // Phase 10/A2 — the apply phase chunks 500 rows at a time but
      // the whole import is still heavy. 30/min keeps it usable for
      // legitimate bulk-import sessions while preventing runaway
      // retry loops.
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const uploadId = request.body?.uploadId
      if (!uploadId) {
        return reply.code(400).send({ error: 'uploadId required' })
      }
      const op = await prisma.bulkOperation.findUnique({
        where: { id: uploadId },
      })
      if (!op) {
        return reply.code(404).send({ error: 'Upload not found' })
      }
      if (op.status !== 'PENDING_APPLY') {
        return reply
          .code(409)
          .send({ error: `Upload already ${op.status.toLowerCase()}` })
      }
      if (op.expiresAt && op.expiresAt.getTime() < Date.now()) {
        return reply.code(410).send({ error: 'Upload preview has expired' })
      }

      const planRows = (op.changes as unknown as PlanRow[]) ?? []
      // D.5: split scalar field changes from category-attribute
      // changes. Scalars become prisma.product.update; attr_* are
      // grouped per-product into a single jsonb merge UPDATE so we
      // don't blow away keys that aren't in this upload.
      const scalarChanges: Array<{
        productId: string
        field: string
        value: unknown
      }> = []
      const attrByProduct = new Map<string, Record<string, unknown>>()
      for (const r of planRows) {
        if (!r.productId) continue
        for (const c of r.changes) {
          if (c.field.startsWith('attr_')) {
            const stripped = c.field.replace(/^attr_/, '')
            let bag = attrByProduct.get(r.productId)
            if (!bag) {
              bag = {}
              attrByProduct.set(r.productId, bag)
            }
            bag[stripped] = c.newValue
          } else {
            scalarChanges.push({
              productId: r.productId,
              field: c.field,
              value: c.newValue,
            })
          }
        }
      }

      const totalUnits = scalarChanges.length + attrByProduct.size
      if (totalUnits === 0) {
        await prisma.bulkOperation.update({
          where: { id: op.id },
          data: {
            status: 'FAILED',
            completedAt: new Date(),
            errors: [{ message: 'No applicable changes' }] as any,
          },
        })
        return reply.code(400).send({ error: 'No applicable changes' })
      }

      const writeAttrMerge = (productId: string, patch: Record<string, unknown>) =>
        prisma.$executeRaw`
          UPDATE "Product"
          SET "categoryAttributes" = COALESCE("categoryAttributes", '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb
          WHERE id = ${productId}
        `

      const startTs = Date.now()
      const CHUNK = 500
      let applied = 0
      const chunkErrors: Array<{ chunkStart: number; error: string }> = []

      // Build a single ordered list of Prisma promises so chunking is
      // simple. Scalar edges come first, then per-product attr merges
      // — each contributes one slot regardless of how many keys it
      // touches inside the jsonb blob.
      const pendingOps: Array<() => Prisma.PrismaPromise<unknown>> = []
      for (const c of scalarChanges) {
        pendingOps.push(() =>
          prisma.product.update({
            where: { id: c.productId },
            data: { [c.field]: c.value as any } as any,
          }),
        )
      }
      for (const [productId, patch] of attrByProduct) {
        pendingOps.push(() => writeAttrMerge(productId, patch))
      }

      for (let i = 0; i < pendingOps.length; i += CHUNK) {
        const slice = pendingOps.slice(i, i + CHUNK).map((fn) => fn())
        try {
          await prisma.$transaction(slice as any, {
            isolationLevel: 'ReadCommitted',
          })
          applied += slice.length
        } catch (err: any) {
          chunkErrors.push({
            chunkStart: i,
            error: err?.message ?? String(err),
          })
        }
      }

      const elapsedMs = Date.now() - startTs
      const finalStatus =
        applied === pendingOps.length
          ? 'SUCCESS'
          : applied === 0
          ? 'FAILED'
          : 'PARTIAL'

      await prisma.bulkOperation.update({
        where: { id: op.id },
        data: {
          status: finalStatus,
          changeCount: applied,
          completedAt: new Date(),
          errors:
            chunkErrors.length > 0 ? (chunkErrors as any) : op.errors ?? undefined,
        },
      })

      return {
        applied,
        total: pendingOps.length,
        errors: chunkErrors,
        status: finalStatus,
        elapsedMs,
      }
    },
  )

  // GET /api/products/bulk-template?view=catalog
  //   CSV with editable field headers + a single sample row that
  //   demonstrates the format (including weight/dim unit suffixes).
  fastify.get<{ Querystring: { view?: string } }>(
    '/products/bulk-template',
    async (request, reply) => {
      const view = (request.query?.view ?? 'full').toLowerCase()
      const fields = await getAvailableFields({})
      // Always include sku as the join key + every editable field.
      // The view filter just biases the column order so the user
      // sees the most relevant ones first when they open the file.
      const editable = fields.filter((f) => f.editable)
      const headerOrder: string[] = ['sku']
      const sortKey = (id: string): number => {
        if (view === 'pricing') {
          return [
            'name',
            'basePrice',
            'costPrice',
            'minMargin',
            'minPrice',
            'maxPrice',
          ].indexOf(id)
        }
        if (view === 'inventory') {
          return [
            'name',
            'totalStock',
            'lowStockThreshold',
            'fulfillmentChannel',
          ].indexOf(id)
        }
        if (view === 'physical') {
          return [
            'weightValue',
            'weightUnit',
            'dimLength',
            'dimWidth',
            'dimHeight',
            'dimUnit',
          ].indexOf(id)
        }
        return -1
      }
      const sorted = [...editable].sort((a, b) => {
        const ai = sortKey(a.id)
        const bi = sortKey(b.id)
        if (ai === -1 && bi === -1) return a.id.localeCompare(b.id)
        if (ai === -1) return 1
        if (bi === -1) return -1
        return ai - bi
      })
      for (const f of sorted) {
        if (f.id !== 'sku') headerOrder.push(f.id)
      }

      // Sample row — one example value per field showing format.
      const sampleByField: Record<string, string> = {
        sku: 'EXAMPLE-SKU-001',
        name: 'Example product name',
        brand: 'Brand X',
        manufacturer: 'Brand X Mfg',
        status: 'ACTIVE',
        fulfillmentChannel: 'FBA',
        basePrice: '49.95',
        costPrice: '18.50',
        minMargin: '0.20',
        minPrice: '40.00',
        maxPrice: '79.95',
        totalStock: '100',
        lowStockThreshold: '10',
        upc: '123456789012',
        ean: '1234567890123',
        gtin: '12345678901234',
        weightValue: '5kg',
        weightUnit: 'kg',
        dimLength: '60cm',
        dimWidth: '40cm',
        dimHeight: '20cm',
        dimUnit: 'cm',
      }

      const csvEscape = (v: string) =>
        /[\t\n",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v

      const headerRow = headerOrder.map(csvEscape).join(',')
      const sampleRow = headerOrder
        .map((id) => csvEscape(sampleByField[id] ?? ''))
        .join(',')
      const csv = `${headerRow}\n${sampleRow}\n`

      reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header(
          'Content-Disposition',
          `attachment; filename="nexus-template-${view}.csv"`,
        )
      return csv
    },
  )

  // R.2 — schema-driven bulk attribute update across products ×
  // marketplaces. Synchronous; returns per-tuple success/error so the
  // modal can render a result toast without polling. Same field-id
  // semantics as the per-listing PUT route (item_name → title etc.).
  fastify.post<{
    Body: {
      productIds: string[]
      marketplaceContexts: Array<{
        channel: 'AMAZON' | 'EBAY'
        marketplace: string
      }>
      attributes: Record<string, string | number | boolean | null>
      variantAttributes?: Record<
        string,
        Record<string, string | number | boolean | null>
      >
    }
  }>(
    '/products/bulk-schema-update',
    async (request, reply) => {
      const { productIds, marketplaceContexts, attributes, variantAttributes } =
        request.body ?? {}
      if (!Array.isArray(productIds) || productIds.length === 0) {
        return reply.code(400).send({ error: 'productIds required' })
      }
      if (productIds.length > 1000) {
        return reply.code(400).send({ error: 'Max 1000 productIds per request' })
      }
      if (
        !Array.isArray(marketplaceContexts) ||
        marketplaceContexts.length === 0
      ) {
        return reply
          .code(400)
          .send({ error: 'marketplaceContexts required (one or more)' })
      }
      if (!attributes || typeof attributes !== 'object') {
        return reply.code(400).send({ error: 'attributes required' })
      }

      // Pre-load existing listings for every (product × context) so the
      // shallow-merge into platformAttributes preserves keys we're not
      // touching. One findMany covers all targets.
      const targetKeys = marketplaceContexts.flatMap((ctx) =>
        productIds.map((pid) => ({
          productId: pid,
          channel: ctx.channel,
          marketplace: ctx.marketplace,
        })),
      )
      const existing = await prisma.channelListing.findMany({
        where: {
          OR: marketplaceContexts.map((ctx) => ({
            productId: { in: productIds },
            channel: ctx.channel,
            marketplace: ctx.marketplace,
          })),
        },
        select: {
          id: true,
          productId: true,
          channel: true,
          marketplace: true,
          platformAttributes: true,
        },
      })
      const existingByKey = new Map(
        existing.map((l) => [
          `${l.productId}:${l.channel}:${l.marketplace}`,
          l,
        ]),
      )

      const errors: Array<{
        productId: string
        channel: string
        marketplace: string
        error: string
      }> = []
      let updated = 0

      // Mirror the per-listing PUT logic: split known field ids into
      // their dedicated columns, merge the rest into
      // platformAttributes.attributes (and .variants).
      const ops: any[] = []
      for (const tk of targetKeys) {
        const key = `${tk.productId}:${tk.channel}:${tk.marketplace}`
        const channelMarket = `${tk.channel}_${tk.marketplace}`
        const data: Record<string, any> = {}

        // Split attributes into columns + passthrough
        const passthrough: Record<string, unknown> = {}
        for (const [fieldId, value] of Object.entries(attributes)) {
          if (fieldId === 'item_name' && typeof value === 'string') {
            data.title = value
          } else if (
            fieldId === 'product_description' &&
            typeof value === 'string'
          ) {
            data.description = value
          } else if (fieldId === 'bullet_point') {
            if (typeof value === 'string') {
              try {
                const parsed = JSON.parse(value)
                if (Array.isArray(parsed)) {
                  data.bulletPointsOverride = parsed.filter(
                    (s) => typeof s === 'string' && s.length > 0,
                  )
                } else {
                  data.bulletPointsOverride = [value]
                }
              } catch {
                data.bulletPointsOverride = [value]
              }
            } else if (Array.isArray(value)) {
              data.bulletPointsOverride = (value as unknown[]).filter(
                (s) => typeof s === 'string' && (s as string).length > 0,
              )
            }
          } else {
            passthrough[fieldId] = value
          }
        }

        // platformAttributes shallow merge with existing slice.
        const ex = existingByKey.get(key)
        const exPA = (ex?.platformAttributes as Record<string, any> | null) ?? null
        let nextPA: Record<string, any> | null = null
        if (Object.keys(passthrough).length > 0) {
          const exAttrs =
            exPA && typeof exPA.attributes === 'object'
              ? (exPA.attributes as Record<string, unknown>)
              : {}
          const merged: Record<string, unknown> = { ...exAttrs }
          for (const [k, v] of Object.entries(passthrough)) {
            if (v === null || v === undefined || v === '') {
              delete merged[k]
            } else {
              merged[k] = v
            }
          }
          nextPA = { ...(exPA ?? {}), attributes: merged }
        }
        if (variantAttributes && typeof variantAttributes === 'object') {
          const exVariants =
            exPA && typeof exPA.variants === 'object'
              ? (exPA.variants as Record<string, Record<string, unknown>>)
              : {}
          const mergedVariants: Record<string, Record<string, unknown>> = {
            ...exVariants,
          }
          for (const [variationId, slice] of Object.entries(variantAttributes)) {
            const prev = mergedVariants[variationId] ?? {}
            const next: Record<string, unknown> = { ...prev }
            for (const [fieldId, v] of Object.entries(slice ?? {})) {
              if (v === null || v === undefined || v === '') {
                delete next[fieldId]
              } else {
                next[fieldId] = v
              }
            }
            if (Object.keys(next).length === 0) {
              delete mergedVariants[variationId]
            } else {
              mergedVariants[variationId] = next
            }
          }
          nextPA = {
            ...(exPA ?? {}),
            ...(nextPA ?? {}),
            variants: mergedVariants,
          }
        }
        if (nextPA !== null) data.platformAttributes = nextPA

        ops.push(
          prisma.channelListing
            .upsert({
              where: {
                productId_channel_marketplace: {
                  productId: tk.productId,
                  channel: tk.channel,
                  marketplace: tk.marketplace,
                },
              },
              create: {
                productId: tk.productId,
                channel: tk.channel,
                channelMarket,
                region: tk.marketplace,
                marketplace: tk.marketplace,
                listingStatus: 'DRAFT',
                ...data,
              } as any,
              update: data,
            })
            .then(() => {
              updated++
              return null
            })
            .catch((err: unknown) => {
              errors.push({
                productId: tk.productId,
                channel: tk.channel,
                marketplace: tk.marketplace,
                error: err instanceof Error ? err.message : String(err),
              })
              return null
            }),
        )
      }
      await Promise.all(ops)

      return { updated, skipped: 0, errors }
    },
  )

  // AA.1 — replicate listing values from a source marketplace to one
  // or more target marketplaces, across many products in one call.
  // For each productId, fetches the source ChannelListing and writes
  // its values to each target listing.
  //
  // Field mapping:
  //   - title / description / bulletPointsOverride / price / quantity
  //     copy column-to-column (channel-agnostic, so AMAZON:IT title →
  //     EBAY:IT title works cleanly).
  //   - platformAttributes.attributes (Amazon attr_*, eBay aspects)
  //     copy by identity-match on field id. Same-channel replication
  //     (AMAZON:IT → AMAZON:DE) hits all attributes; cross-channel
  //     (AMAZON:IT → EBAY:IT) hits the columns + any attribute id that
  //     happens to match (rare unless the user chose canonical names).
  //
  // Caps: 1000 productIds, 20 targets per request — keeps the
  // round-trip bounded for catalogs the size of Xavia's.
  fastify.post<{
    Body: {
      productIds: string[]
      sourceContext: { channel: 'AMAZON' | 'EBAY'; marketplace: string }
      targetContexts: Array<{
        channel: 'AMAZON' | 'EBAY'
        marketplace: string
      }>
      /** When true, only the column-mapped fields (title, description,
       *  bullet points, price, quantity) replicate; attributes are
       *  skipped entirely. Useful for cross-channel where the
       *  attribute namespaces don't overlap. */
      columnsOnly?: boolean
    }
  }>('/products/bulk-replicate', async (request, reply) => {
    const { productIds, sourceContext, targetContexts, columnsOnly } =
      request.body ?? {}

    // NN.2 — idempotency on the replicate fan-out. Double-clicked
    // 'Replicate' should not write the same target listings twice.
    const idempotencyKey = request.headers['idempotency-key'] as
      | string
      | undefined
    const cached = idempotencyService.lookup('replicate', idempotencyKey)
    if (cached) return cached

    if (!Array.isArray(productIds) || productIds.length === 0) {
      return reply.code(400).send({ error: 'productIds required' })
    }
    if (productIds.length > 1000) {
      return reply.code(400).send({ error: 'Max 1000 productIds per request' })
    }
    if (!sourceContext?.channel || !sourceContext?.marketplace) {
      return reply.code(400).send({ error: 'sourceContext required' })
    }
    if (!Array.isArray(targetContexts) || targetContexts.length === 0) {
      return reply
        .code(400)
        .send({ error: 'targetContexts required (one or more)' })
    }
    if (targetContexts.length > 20) {
      return reply
        .code(400)
        .send({ error: 'Max 20 target contexts per request' })
    }

    // Fetch source listings in one query.
    const sourceListings = await prisma.channelListing.findMany({
      where: {
        productId: { in: productIds },
        channel: sourceContext.channel,
        marketplace: sourceContext.marketplace,
      },
    })
    const sourceByProductId = new Map(
      sourceListings.map((l) => [l.productId, l]),
    )

    // Fetch all target listings (across every (productId × target))
    // in one query so we can shallow-merge platformAttributes
    // intelligently rather than blow them away.
    const targetWhere = {
      OR: targetContexts.map((tc) => ({
        productId: { in: productIds },
        channel: tc.channel,
        marketplace: tc.marketplace,
      })),
    }
    const existingTargets = await prisma.channelListing.findMany({
      where: targetWhere,
    })
    const targetByKey = new Map(
      existingTargets.map((l) => [
        `${l.productId}:${l.channel}:${l.marketplace}`,
        l,
      ]),
    )

    let replicated = 0
    let skippedNoSource = 0
    const errors: Array<{
      productId: string
      channel: string
      marketplace: string
      error: string
    }> = []

    // NN.12 — snapshot the source updatedAt at the start of the run.
    // If a source listing is edited between this snapshot and the
    // upsert below, we drop that productId from this batch (the user
    // can re-run replicate to pick up the new value). Without this,
    // a concurrent edit to the source can land stale data on N
    // targets in this fan-out.
    const sourceSnapshotAt = new Map<string, Date>()
    for (const s of sourceListings) {
      sourceSnapshotAt.set(s.productId, s.updatedAt)
    }
    const sourceConflicts: string[] = []

    const ops = await Promise.all(
      productIds.flatMap((productId) =>
        targetContexts.map(async (tc) => {
          const source = sourceByProductId.get(productId)
          if (!source) {
            skippedNoSource++
            return
          }
          // NN.12 — re-check the source updatedAt right before the
          // upsert. If it moved, skip and report; the user gets a
          // 'source changed' entry in errors so they know which
          // products didn't replicate cleanly.
          const fresh = await prisma.channelListing.findUnique({
            where: {
              productId_channel_marketplace: {
                productId,
                channel: sourceContext.channel,
                marketplace: sourceContext.marketplace,
              },
            },
            select: { updatedAt: true },
          })
          const snapshotAt = sourceSnapshotAt.get(productId)
          if (
            fresh &&
            snapshotAt &&
            fresh.updatedAt.getTime() !== snapshotAt.getTime()
          ) {
            sourceConflicts.push(productId)
            errors.push({
              productId,
              channel: tc.channel,
              marketplace: tc.marketplace,
              error:
                'source listing changed during replicate — re-run to pick up the new value',
            })
            return
          }
          const targetKey = `${productId}:${tc.channel}:${tc.marketplace}`
          const existingTarget = targetByKey.get(targetKey) ?? null

          // Build the data payload. Columns flow channel-agnostic.
          const data: Record<string, unknown> = {
            title: source.title,
            description: source.description,
            bulletPointsOverride: source.bulletPointsOverride,
          }
          if (source.price !== null && source.price !== undefined) {
            data.price = source.price
          }
          if (source.quantity !== null && source.quantity !== undefined) {
            data.quantity = source.quantity
          }

          // Attributes: identity-match merge unless columnsOnly.
          // EE.5 — when source.channel !== target.channel, run keys
          // through CROSS_CHANNEL_ATTR_MAP to map equivalent concepts
          // (Amazon "brand" → eBay "brand"; Amazon "material_type" →
          // eBay "material"; etc.). Identity-match on top so any
          // already-canonical keys flow regardless. Unmapped keys
          // get reported back so the user can see what didn't carry.
          if (!columnsOnly) {
            const sourcePA =
              (source.platformAttributes as Record<string, any> | null) ?? null
            const sourceAttrs =
              sourcePA && typeof sourcePA.attributes === 'object'
                ? (sourcePA.attributes as Record<string, unknown>)
                : null
            if (sourceAttrs) {
              const existingPA =
                (existingTarget?.platformAttributes as Record<string, any> | null) ??
                null
              const existingAttrs =
                existingPA && typeof existingPA.attributes === 'object'
                  ? (existingPA.attributes as Record<string, unknown>)
                  : {}
              const isCrossChannel =
                sourceContext.channel !== tc.channel
              const mapped = isCrossChannel
                ? mapAttributesCrossChannel(
                    sourceAttrs,
                    sourceContext.channel,
                    tc.channel,
                  )
                : sourceAttrs
              const merged: Record<string, unknown> = {
                ...existingAttrs,
                ...mapped,
              }
              data.platformAttributes = {
                ...(existingPA ?? {}),
                attributes: merged,
              }
            }
          }

          const channelMarket = `${tc.channel}_${tc.marketplace}`
          try {
            await prisma.channelListing.upsert({
              where: {
                productId_channel_marketplace: {
                  productId,
                  channel: tc.channel,
                  marketplace: tc.marketplace,
                },
              },
              create: {
                productId,
                channel: tc.channel,
                marketplace: tc.marketplace,
                channelMarket,
                region: tc.marketplace,
                listingStatus: 'DRAFT',
                ...data,
              } as any,
              update: data as any,
            })
            replicated++
          } catch (e) {
            errors.push({
              productId,
              channel: tc.channel,
              marketplace: tc.marketplace,
              error: e instanceof Error ? e.message : String(e),
            })
          }
        }),
      ),
    )
    void ops

    const responseBody = {
      replicated,
      skippedNoSource,
      errors,
    }
    // NN.2 — store the replicate result so a duplicate request with
    // the same Idempotency-Key returns identical bytes.
    idempotencyService.store('replicate', idempotencyKey, responseBody)
    return responseBody
  })
}

// EE.5 — canonical-name mapping for cross-channel replicate. Keys
// are well-known overlapping concepts; values for non-listed keys
// (Amazon's `attr_armorType` → eBay's "EN 1621-2 level") cannot be
// derived without per-attribute logic and are dropped from the
// cross-channel copy. The user is told via the result.errors list.
const AMAZON_TO_EBAY_ATTR: Record<string, string> = {
  brand: 'brand',
  brand_name: 'brand',
  color: 'color',
  color_name: 'color',
  size: 'size',
  size_name: 'size',
  material: 'material',
  material_type: 'material',
  manufacturer: 'manufacturer',
  mpn: 'mpn',
  model_name: 'mpn',
  model_number: 'mpn',
  part_number: 'mpn',
  style: 'style',
  style_name: 'style',
  pattern: 'pattern',
  pattern_name: 'pattern',
  department_name: 'department',
  age_range_description: 'age_group',
  target_gender: 'department',
}

const EBAY_TO_AMAZON_ATTR: Record<string, string> = {
  brand: 'brand',
  color: 'color',
  size: 'size',
  material: 'material_type',
  manufacturer: 'manufacturer',
  mpn: 'model_name',
  style: 'style',
  pattern: 'pattern',
  department: 'department_name',
  age_group: 'age_range_description',
}

function mapAttributesCrossChannel(
  source: Record<string, unknown>,
  fromChannel: 'AMAZON' | 'EBAY',
  toChannel: 'AMAZON' | 'EBAY',
): Record<string, unknown> {
  if (fromChannel === toChannel) return source
  const table =
    fromChannel === 'AMAZON' && toChannel === 'EBAY'
      ? AMAZON_TO_EBAY_ATTR
      : fromChannel === 'EBAY' && toChannel === 'AMAZON'
      ? EBAY_TO_AMAZON_ATTR
      : null
  if (!table) return {}
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(source)) {
    const canonical = k.toLowerCase()
    const mapped = table[canonical]
    if (mapped) {
      out[mapped] = v
    }
  }
  return out
}

export default productsRoutes
