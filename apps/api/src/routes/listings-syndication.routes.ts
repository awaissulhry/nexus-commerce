import type { FastifyInstance } from 'fastify'
import prisma from '../db.js'
import { computeHealth, aggregateIssuesByCategory } from '../services/listings/health.service.js'
import { publishListingEvent, subscribeListingEvents } from '../services/listing-events.service.js'
import { listEtag, matches } from '../utils/list-etag.js'

// ─────────────────────────────────────────────────────────────────────
// SYNDICATION — universal /listings workspace endpoints
//
// GET  /api/listings                paginated/filterable/sortable grid feed
// GET  /api/listings/facets         counts per channel/marketplace/status
// GET  /api/listings/health         rollup for the Health lens
// GET  /api/listings/matrix         product × channel/marketplace cells
// GET  /api/listings/drafts         products without coverage on a channel
// GET  /api/listings/:id            single listing (drawer)
// POST /api/listings/:id/resync     enqueue per-listing pull from channel
// POST /api/listings/bulk-action    publish/unpublish/price/follow-master/resync
// GET  /api/listings/bulk-action/:jobId   poll job status (in-mem)
// ─────────────────────────────────────────────────────────────────────

const ALLOWED_CHANNELS = ['AMAZON', 'EBAY', 'SHOPIFY', 'WOOCOMMERCE', 'ETSY']

// In-memory bulk-job tracker. Multi-instance deploys would need Redis,
// but the existing bulk-publish-to-ebay route is BullMQ-gated and we're
// matching its current scope.
// S.0.5 / H-5 — bulk-job state lives on the BulkActionJob table.
// Earlier audit caught the in-memory Map approach: it lost every job
// on API restart and went non-atomic across replicas. Now we write a
// BulkActionJob row on enqueue and update it as the worker progresses.
// The GET endpoint reads from DB, so polling clients see consistent
// state regardless of which API instance handles the request.
//
// actionType is hardcoded 'LISTING_BULK_ACTION' so this surface stays
// distinguishable from /bulk-operations rows in the same table (which
// use PRICING_UPDATE / STATUS_UPDATE / etc.). Saves writing a separate
// table while keeping query partitioning easy.
const LISTING_BULK_ACTION_TYPE = 'LISTING_BULK_ACTION'

interface ListingBulkActionPayload {
  action: string
  listingIds: string[]
  payload?: any
}

function csvParam(v: unknown): string[] | undefined {
  if (typeof v !== 'string' || v.length === 0 || v === 'ALL') return undefined
  return v.split(',').map((s) => s.trim()).filter(Boolean)
}

function safeNum(v: unknown): number | undefined {
  if (v == null) return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

function listingUrlFor(channel: string, marketplace: string, externalId: string | null): string | null {
  if (!externalId) return null
  switch (channel) {
    case 'AMAZON': {
      const tld: Record<string, string> = {
        US: 'com', CA: 'ca', MX: 'com.mx', BR: 'com.br',
        UK: 'co.uk', GB: 'co.uk', DE: 'de', FR: 'fr', IT: 'it', ES: 'es', NL: 'nl', PL: 'pl', SE: 'se', BE: 'com.be', TR: 'com.tr',
        AE: 'ae', SA: 'sa', EG: 'eg',
        JP: 'co.jp', AU: 'com.au', SG: 'sg', IN: 'in',
      }
      const t = tld[marketplace.toUpperCase()] ?? 'com'
      return `https://www.amazon.${t}/dp/${externalId}`
    }
    case 'EBAY': {
      const tld: Record<string, string> = {
        US: 'com', UK: 'co.uk', GB: 'co.uk', DE: 'de', IT: 'it', FR: 'fr', ES: 'es', AU: 'com.au', CA: 'ca',
      }
      const t = tld[marketplace.toUpperCase()] ?? 'com'
      return `https://www.ebay.${t}/itm/${externalId}`
    }
    case 'SHOPIFY':
      // Shopify product IDs aren't directly URLable without store handle —
      // the admin link is the closest we can build server-side.
      return null
    case 'ETSY':
      return `https://www.etsy.com/listing/${externalId}`
    case 'WOOCOMMERCE':
      return null
    default:
      return null
  }
}

export async function listingsSyndicationRoutes(fastify: FastifyInstance) {
  // ─────────────────────────────────────────────────────────────────
  // GET /api/listings — paginated, filterable, sortable
  // ─────────────────────────────────────────────────────────────────
  fastify.get('/listings', async (request, reply) => {
    try {
      const q = request.query as Record<string, string | undefined>

      const page = Math.max(1, Math.floor(safeNum(q.page) ?? 1))
      const pageSize = Math.min(200, Math.max(1, Math.floor(safeNum(q.pageSize) ?? 50)))
      const skip = (page - 1) * pageSize

      const channels = csvParam(q.channel)
      const marketplaces = csvParam(q.marketplace)
      const statuses = csvParam(q.listingStatus)
      const syncStatuses = csvParam(q.syncStatus)
      const lastSyncStatuses = csvParam(q.lastSyncStatus)
      const search = (q.search ?? '').trim()

      const priceMin = safeNum(q.priceMin)
      const priceMax = safeNum(q.priceMax)
      const inStock = q.inStock === 'true'
      const lowStock = q.lowStock === 'true'
      const hasError = q.hasError === 'true'
      const isPublishedOnly = q.published === 'true'

      const lastSyncBefore = q.lastSyncBefore ? new Date(q.lastSyncBefore) : undefined
      const lastSyncAfter = q.lastSyncAfter ? new Date(q.lastSyncAfter) : undefined

      const sortBy = (q.sortBy ?? 'updatedAt') as string
      const sortDir = (q.sortDir === 'asc' ? 'asc' : 'desc') as 'asc' | 'desc'

      const where: any = {}
      if (channels && channels.length > 0) where.channel = { in: channels }
      if (marketplaces && marketplaces.length > 0) where.marketplace = { in: marketplaces }
      if (statuses && statuses.length > 0) where.listingStatus = { in: statuses }
      if (syncStatuses && syncStatuses.length > 0) where.syncStatus = { in: syncStatuses }
      if (lastSyncStatuses && lastSyncStatuses.length > 0) where.lastSyncStatus = { in: lastSyncStatuses }

      if (priceMin != null || priceMax != null) {
        where.price = {}
        if (priceMin != null) where.price.gte = priceMin
        if (priceMax != null) where.price.lte = priceMax
      }
      if (inStock) where.quantity = { gt: 0 }
      if (lowStock) where.quantity = { gt: 0, lte: 5 }
      if (hasError) where.OR = [{ listingStatus: 'ERROR' }, { lastSyncStatus: 'FAILED' }, { syncStatus: 'FAILED' }]
      if (isPublishedOnly) where.isPublished = true

      if (lastSyncBefore || lastSyncAfter) {
        where.lastSyncedAt = {}
        if (lastSyncBefore) where.lastSyncedAt.lte = lastSyncBefore
        if (lastSyncAfter) where.lastSyncedAt.gte = lastSyncAfter
      }

      if (search) {
        const s = search
        const productOr: any = {
          product: {
            OR: [
              { sku: { contains: s, mode: 'insensitive' } },
              { name: { contains: s, mode: 'insensitive' } },
              { amazonAsin: { contains: s, mode: 'insensitive' } },
            ],
          },
        }
        const externalOr: any = { externalListingId: { contains: s, mode: 'insensitive' } }
        const titleOr: any = { title: { contains: s, mode: 'insensitive' } }
        // Combine search with existing AND filters via top-level OR alongside where
        where.AND = [{ OR: [productOr, externalOr, titleOr] }]
      }

      // Translate sort key to Prisma orderBy
      let orderBy: any
      switch (sortBy) {
        case 'price': orderBy = { price: sortDir }; break
        case 'quantity': orderBy = { quantity: sortDir }; break
        case 'lastSyncedAt': orderBy = { lastSyncedAt: sortDir }; break
        case 'channel': orderBy = [{ channel: sortDir }, { marketplace: 'asc' }]; break
        case 'marketplace': orderBy = [{ marketplace: sortDir }, { channel: 'asc' }]; break
        case 'sku': orderBy = { product: { sku: sortDir } }; break
        case 'name': orderBy = { product: { name: sortDir } }; break
        case 'updatedAt':
        default: orderBy = { updatedAt: sortDir }
      }

      // Phase 10b — short-circuit with 304 when nothing changed since
      // the client's last fetch. Frontends poll the listings list on
      // visibility-change and bulk-action completion; without ETag
      // every poll re-runs the count + findMany + marketplace meta
      // join even when nothing about the filtered set has shifted.
      const { etag, count: etagCount } = await listEtag(prisma, {
        model: 'channelListing',
        where,
        filterContext: { page, pageSize, sortBy, sortDir },
      })
      reply.header('ETag', etag)
      reply.header('Cache-Control', 'private, max-age=0, must-revalidate')
      if (matches(request, etag)) {
        return reply.code(304).send()
      }

      const [total, listings, marketplacesMeta] = await Promise.all([
        // listEtag already counted; reuse it instead of issuing a
        // duplicate count() against the same where clause.
        Promise.resolve(etagCount),
        prisma.channelListing.findMany({
          where,
          include: {
            product: {
              select: {
                id: true, sku: true, name: true, amazonAsin: true,
                basePrice: true, totalStock: true, isParent: true, parentId: true,
                images: { select: { url: true }, take: 1 },
              },
            },
          },
          orderBy,
          skip,
          take: pageSize,
        }),
        prisma.marketplace.findMany({
          select: { channel: true, code: true, currency: true, language: true, name: true },
        }),
      ])

      const mpKey = (channel: string, code: string) => `${channel}_${code}`
      const meta = new Map<string, { currency: string; language: string; marketplaceName: string }>(
        marketplacesMeta.map((m) => [
          mpKey(m.channel, m.code),
          { currency: m.currency, language: m.language, marketplaceName: m.name },
        ])
      )

      const enriched = listings.map((l) => {
        const m = meta.get(mpKey(l.channel, l.marketplace))
        return {
          id: l.id,
          productId: l.productId,
          channel: l.channel,
          marketplace: l.marketplace,
          listingStatus: l.listingStatus,
          syncStatus: l.syncStatus,
          lastSyncStatus: l.lastSyncStatus,
          lastSyncError: l.lastSyncError,
          lastSyncedAt: l.lastSyncedAt,
          syncRetryCount: l.syncRetryCount,
          price: l.price == null ? null : Number(l.price),
          salePrice: l.salePrice == null ? null : Number(l.salePrice),
          masterPrice: l.masterPrice == null ? null : Number(l.masterPrice),
          quantity: l.quantity,
          stockBuffer: l.stockBuffer,
          masterQuantity: l.masterQuantity,
          pricingRule: l.pricingRule,
          priceAdjustmentPercent: l.priceAdjustmentPercent == null ? null : Number(l.priceAdjustmentPercent),
          isPublished: l.isPublished,
          followMasterTitle: l.followMasterTitle,
          followMasterDescription: l.followMasterDescription,
          followMasterPrice: l.followMasterPrice,
          followMasterQuantity: l.followMasterQuantity,
          title: l.title,
          externalListingId: l.externalListingId,
          externalParentId: l.externalParentId,
          listingUrl: listingUrlFor(l.channel, l.marketplace, l.externalListingId),
          variationTheme: l.variationTheme,
          validationStatus: l.validationStatus,
          validationErrors: l.validationErrors,
          version: l.version,
          updatedAt: l.updatedAt,
          createdAt: l.createdAt,
          currency: m?.currency ?? null,
          language: m?.language ?? null,
          marketplaceName: m?.marketplaceName ?? null,
          product: {
            id: l.product.id,
            sku: l.product.sku,
            name: l.product.name,
            amazonAsin: l.product.amazonAsin,
            basePrice: l.product.basePrice == null ? null : Number(l.product.basePrice),
            totalStock: l.product.totalStock,
            isParent: l.product.isParent,
            parentId: l.product.parentId,
            thumbnailUrl: l.product.images?.[0]?.url ?? null,
          },
        }
      })

      return {
        listings: enriched,
        total,
        page,
        pageSize,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[listings] paginated query failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // ─────────────────────────────────────────────────────────────────
  // GET /api/listings/facets — counts to drive filter chips
  //
  // S.0.5 / M-1 — accepts the same filter params as /api/listings.
  // Without this, facet counts went stale once any filter was applied
  // (you'd filter to AMAZON and the Status chip would still show counts
  // from all channels). Each facet groupBy now applies the same `where`
  // clause as the list endpoint. The status / syncStatus / channel /
  // marketplace facet for the dimension being grouped on is itself
  // excluded from the where so the chip can show "5 ACTIVE in this
  // filtered set" without zeroing itself out — i.e. the marketplace
  // chip respects the channel filter, the status chip respects channel
  // + marketplace, etc. This matches how Linear / Stripe / Notion do
  // facets: each chip is the count given everything *except* its own
  // dimension.
  // ─────────────────────────────────────────────────────────────────
  fastify.get('/listings/facets', async (request, reply) => {
    try {
      const q = request.query as Record<string, string | undefined>
      const channels = csvParam(q.channel)
      const marketplaces = csvParam(q.marketplace)
      const statuses = csvParam(q.listingStatus)
      const syncStatuses = csvParam(q.syncStatus)
      const hasError = q.hasError === 'true'
      const lowStock = q.lowStock === 'true'
      const isPublishedOnly = q.published === 'true'
      const search = (q.search ?? '').trim()

      // Build a `where` for each facet that excludes the dimension being
      // grouped on. That way the channel chip shows "AMAZON: 8" even
      // when the user has already selected AMAZON — instead of "0" which
      // would make the chip un-deselectable.
      const buildWhere = (excludeDim?: 'channel' | 'marketplace' | 'listingStatus' | 'syncStatus'): any => {
        const where: any = {}
        if (channels && channels.length > 0 && excludeDim !== 'channel') {
          where.channel = { in: channels }
        }
        if (marketplaces && marketplaces.length > 0 && excludeDim !== 'marketplace') {
          where.marketplace = { in: marketplaces }
        }
        if (statuses && statuses.length > 0 && excludeDim !== 'listingStatus') {
          where.listingStatus = { in: statuses }
        }
        if (syncStatuses && syncStatuses.length > 0 && excludeDim !== 'syncStatus') {
          where.syncStatus = { in: syncStatuses }
        }
        if (hasError) {
          where.OR = [
            { listingStatus: 'ERROR' },
            { lastSyncStatus: 'FAILED' },
            { syncStatus: 'FAILED' },
          ]
        }
        if (lowStock) {
          where.AND = [
            ...(where.AND ?? []),
            { quantity: { gt: 0 } },
            { quantity: { lte: 5 } },
          ]
        }
        if (isPublishedOnly) {
          where.isPublished = true
        }
        if (search) {
          where.OR = [
            ...(where.OR ?? []),
            { product: { sku: { contains: search, mode: 'insensitive' } } },
            { product: { name: { contains: search, mode: 'insensitive' } } },
            { product: { amazonAsin: { contains: search, mode: 'insensitive' } } },
            { externalListingId: { contains: search, mode: 'insensitive' } },
            { title: { contains: search, mode: 'insensitive' } },
          ]
        }
        return where
      }

      const totalWhere = buildWhere()
      const [byChannel, byMarketplace, byStatus, bySyncStatus, errorCount, total] = await Promise.all([
        prisma.channelListing.groupBy({ by: ['channel'], where: buildWhere('channel'), _count: true }),
        prisma.channelListing.groupBy({ by: ['channel', 'marketplace'], where: buildWhere('marketplace'), _count: true }),
        prisma.channelListing.groupBy({ by: ['listingStatus'], where: buildWhere('listingStatus'), _count: true }),
        prisma.channelListing.groupBy({ by: ['syncStatus'], where: buildWhere('syncStatus'), _count: true }),
        prisma.channelListing.count({
          where: {
            ...totalWhere,
            OR: [
              ...(totalWhere.OR ?? []),
              { listingStatus: 'ERROR' },
              { lastSyncStatus: 'FAILED' },
              { syncStatus: 'FAILED' },
            ],
          },
        }),
        prisma.channelListing.count({ where: totalWhere }),
      ])

      return {
        total,
        errorCount,
        channels: byChannel.map((c) => ({ value: c.channel, count: c._count })),
        marketplaces: byMarketplace.map((c) => ({ channel: c.channel, marketplace: c.marketplace, count: c._count })),
        statuses: byStatus.map((c) => ({ value: c.listingStatus, count: c._count })),
        syncStatuses: bySyncStatus.map((c) => ({ value: c.syncStatus, count: c._count })),
      }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[listings/facets] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // ─────────────────────────────────────────────────────────────────
  // GET /api/listings/health — rollup for the Health lens
  // ─────────────────────────────────────────────────────────────────
  fastify.get('/listings/health', async (request, reply) => {
    try {
      const q = request.query as Record<string, string | undefined>
      const channels = csvParam(q.channel)
      const where: any = {}
      if (channels && channels.length > 0) where.channel = { in: channels }

      // S.3 — pull a sample of all-listing health for category aggregate.
      // We can't aggregate health categories in SQL (computed per row),
      // so sample the most-recent N for the rollup. errorRows give us
      // the actionable cohort; sampleAll feeds the category breakdown.
      const [errorRows, suppressedRows, draftRows, failedSyncRows, pendingSyncRows, sampleAll] = await Promise.all([
        prisma.channelListing.findMany({
          where: { ...where, OR: [{ listingStatus: 'ERROR' }, { syncStatus: 'FAILED' }, { lastSyncStatus: 'FAILED' }] },
          include: { product: { select: { id: true, sku: true, name: true } } },
          orderBy: { updatedAt: 'desc' },
          take: 100,
        }),
        prisma.channelListing.count({ where: { ...where, listingStatus: 'SUPPRESSED' } }),
        prisma.channelListing.count({ where: { ...where, listingStatus: 'DRAFT' } }),
        prisma.channelListing.count({ where: { ...where, lastSyncStatus: 'FAILED' } }),
        prisma.channelListing.count({ where: { ...where, OR: [{ syncStatus: 'PENDING' }, { lastSyncStatus: 'PENDING' }] } }),
        prisma.channelListing.findMany({
          where,
          orderBy: { updatedAt: 'desc' },
          take: 500,
        }),
      ])

      // Group errors by reason for at-a-glance triage
      const errorReasonCounts: Record<string, number> = {}
      for (const r of errorRows) {
        const key = (r.lastSyncError ?? 'Unknown error').slice(0, 80)
        errorReasonCounts[key] = (errorReasonCounts[key] ?? 0) + 1
      }
      const topReasons = Object.entries(errorReasonCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([reason, count]) => ({ reason, count }))

      // Score-bucket distribution + issues-by-category over the sample.
      // 500 rows is enough for any operator-scale system (Awa runs ~3,200
      // products); revisit when Nexus serves a multi-tenant customer
      // with 100k+ listings.
      const sampleHealths = sampleAll.map((r) =>
        computeHealth({
          listingStatus: r.listingStatus,
          syncStatus: r.syncStatus,
          lastSyncStatus: r.lastSyncStatus,
          lastSyncError: r.lastSyncError,
          lastSyncedAt: r.lastSyncedAt,
          syncRetryCount: r.syncRetryCount,
          validationErrors: r.validationErrors,
          title: r.title,
          price: r.price == null ? null : Number(r.price),
          quantity: r.quantity,
          externalListingId: r.externalListingId,
          channel: r.channel,
          marketplace: r.marketplace,
          followMasterPrice: r.followMasterPrice,
          followMasterQuantity: r.followMasterQuantity,
          followMasterTitle: r.followMasterTitle,
          masterPrice: r.masterPrice == null ? null : Number(r.masterPrice),
          masterQuantity: r.masterQuantity,
          masterTitle: r.masterTitle,
        }),
      )
      const scoreBuckets = {
        HEALTHY: sampleHealths.filter((h) => h.category === 'HEALTHY').length,
        WARNING: sampleHealths.filter((h) => h.category === 'WARNING').length,
        CRITICAL: sampleHealths.filter((h) => h.category === 'CRITICAL').length,
      }
      const issuesByCategory = aggregateIssuesByCategory(sampleHealths)

      return {
        errorCount: errorRows.length,
        suppressedCount: suppressedRows,
        draftCount: draftRows,
        failedSyncCount: failedSyncRows,
        pendingSyncCount: pendingSyncRows,
        scoreBuckets,
        issuesByCategory,
        sampleSize: sampleAll.length,
        topReasons,
        recentErrors: errorRows.slice(0, 50).map((r) => ({
          id: r.id,
          productId: r.productId,
          productSku: r.product.sku,
          productName: r.product.name,
          channel: r.channel,
          marketplace: r.marketplace,
          listingStatus: r.listingStatus,
          syncStatus: r.syncStatus,
          lastSyncStatus: r.lastSyncStatus,
          lastSyncError: r.lastSyncError,
          syncRetryCount: r.syncRetryCount,
          updatedAt: r.updatedAt,
        })),
      }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[listings/health] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // ─────────────────────────────────────────────────────────────────
  // GET /api/listings/matrix — product × (channel,marketplace) cells
  // ?productIds=csv  ?channels=csv  ?limit=N
  // ?coverage=everywhere|missing-amazon|missing-ebay|single-channel|uncovered
  // ?sortBy=updated|coverage-gaps|most-channels|name
  //
  // S.1 — adds coverage and sortBy. The matrix becomes a live workspace
  // rather than a status snapshot: operators can sort by gap density to
  // find products needing publish, by recency to triage drift, or by
  // most-channels to confirm cross-channel parity. Cell payload extended
  // with syncStatus + lastSyncedAt + lastSyncError + masterPrice so the
  // frontend can render drift indicators and per-cell error glyphs
  // without an extra round-trip.
  // ─────────────────────────────────────────────────────────────────
  fastify.get('/listings/matrix', async (request, reply) => {
    try {
      const q = request.query as Record<string, string | undefined>
      const productIds = csvParam(q.productIds)
      const channels = csvParam(q.channels)
      const limit = Math.min(500, Math.max(1, Math.floor(safeNum(q.limit) ?? 100)))
      const coverage = q.coverage as
        | 'everywhere'
        | 'missing-amazon'
        | 'missing-ebay'
        | 'single-channel'
        | 'uncovered'
        | undefined
      const sortBy = (q.sortBy ?? 'updated') as
        | 'updated'
        | 'coverage-gaps'
        | 'most-channels'
        | 'name'

      // Resolve which products to include: explicit list, otherwise the
      // N most recently updated. Note we pull a wider set when sorting
      // by coverage so the post-filter step doesn't truncate too early.
      const overshoot = sortBy === 'updated' || sortBy === 'name' ? limit : Math.min(500, limit * 3)
      let products: Array<{ id: string; sku: string; name: string; basePrice: any; totalStock: number; isParent: boolean }>
      if (productIds && productIds.length > 0) {
        products = await prisma.product.findMany({
          where: { id: { in: productIds } },
          select: { id: true, sku: true, name: true, basePrice: true, totalStock: true, isParent: true },
        })
      } else {
        products = await prisma.product.findMany({
          where: { isParent: false },
          orderBy: sortBy === 'name' ? { name: 'asc' } : { updatedAt: 'desc' },
          take: overshoot,
          select: { id: true, sku: true, name: true, basePrice: true, totalStock: true, isParent: true },
        })
      }

      const ids = products.map((p) => p.id)
      const listingsWhere: any = { productId: { in: ids } }
      if (channels && channels.length > 0) listingsWhere.channel = { in: channels }

      const listings = await prisma.channelListing.findMany({
        where: listingsWhere,
        select: {
          id: true, productId: true, channel: true, marketplace: true,
          listingStatus: true, syncStatus: true, lastSyncStatus: true,
          lastSyncedAt: true, lastSyncError: true,
          price: true, masterPrice: true,
          quantity: true, masterQuantity: true,
          externalListingId: true, isPublished: true,
          followMasterPrice: true, followMasterQuantity: true,
          // C.9 — title + override fields for cross-channel diff. The
          // matrix's drift indicators read these directly; we send the
          // effective channel title (override || stored title) plus the
          // master title so the frontend can compute mismatches without
          // a second fetch.
          title: true, titleOverride: true, masterTitle: true,
          followMasterTitle: true,
        },
      })

      // Build a per-product map of cells keyed by `${channel}:${marketplace}`
      const byProduct = new Map<string, Array<any>>()
      for (const l of listings) {
        const arr = byProduct.get(l.productId) ?? []
        // Effective title operators care about: titleOverride wins when
        // set, else the channel-stored title, else null. The drift
        // calculation on the frontend ignores null vs null.
        const effectiveTitle =
          (l.titleOverride && l.titleOverride.length > 0
            ? l.titleOverride
            : l.title) ?? null
        arr.push({
          id: l.id,
          channel: l.channel,
          marketplace: l.marketplace,
          listingStatus: l.listingStatus,
          syncStatus: l.syncStatus,
          lastSyncStatus: l.lastSyncStatus,
          lastSyncedAt: l.lastSyncedAt,
          lastSyncError: l.lastSyncError,
          price: l.price == null ? null : Number(l.price),
          masterPrice: l.masterPrice == null ? null : Number(l.masterPrice),
          followMasterPrice: l.followMasterPrice,
          quantity: l.quantity,
          masterQuantity: l.masterQuantity,
          followMasterQuantity: l.followMasterQuantity,
          title: effectiveTitle,
          masterTitle: l.masterTitle,
          followMasterTitle: l.followMasterTitle,
          externalListingId: l.externalListingId,
          isPublished: l.isPublished,
          listingUrl: listingUrlFor(l.channel, l.marketplace, l.externalListingId),
        })
        byProduct.set(l.productId, arr)
      }

      // Coverage filter — narrow products[] before sort/limit. We
      // compute over the channels actually represented in the data so
      // a missing-shopify filter on a system with no Shopify rows is a
      // no-op rather than returning everything.
      const filteredProducts = (() => {
        if (!coverage) return products
        return products.filter((p) => {
          const cells = byProduct.get(p.id) ?? []
          const channelsForProduct = new Set(cells.map((c) => c.channel))
          switch (coverage) {
            case 'everywhere':
              // Every channel currently in the data appears for this product
              return ['AMAZON', 'EBAY', 'SHOPIFY', 'WOOCOMMERCE', 'ETSY']
                .every((ch) => channelsForProduct.has(ch))
            case 'missing-amazon':
              return !channelsForProduct.has('AMAZON')
            case 'missing-ebay':
              return !channelsForProduct.has('EBAY')
            case 'single-channel':
              return channelsForProduct.size === 1
            case 'uncovered':
              return channelsForProduct.size === 0
            default:
              return true
          }
        })
      })()

      // Sort: coverage-gaps and most-channels need the cell counts we
      // just built, so they can't be done in the SQL orderBy.
      const sortedProducts = (() => {
        if (sortBy === 'coverage-gaps') {
          return [...filteredProducts].sort((a, b) => {
            const aCells = (byProduct.get(a.id) ?? []).length
            const bCells = (byProduct.get(b.id) ?? []).length
            return aCells - bCells // fewer cells first (most gaps first)
          })
        }
        if (sortBy === 'most-channels') {
          return [...filteredProducts].sort((a, b) => {
            const aCells = (byProduct.get(a.id) ?? []).length
            const bCells = (byProduct.get(b.id) ?? []).length
            return bCells - aCells // more cells first
          })
        }
        // 'updated' and 'name' were already enforced by the SQL orderBy
        return filteredProducts
      })()

      const truncated = sortedProducts.slice(0, limit)

      return {
        products: truncated.map((p) => ({
          id: p.id,
          sku: p.sku,
          name: p.name,
          basePrice: p.basePrice == null ? null : Number(p.basePrice),
          totalStock: p.totalStock,
          isParent: p.isParent,
          // C.9 — per-row master reference for the matrix's leftmost
          // master cell. masterTitle falls back to product.name when
          // ChannelListing.masterTitle wasn't set; masterPrice and
          // masterQuantity come straight from Product so the master
          // column never depends on a ChannelListing row existing.
          masterTitleForCompare: p.name,
          masterPriceForCompare: p.basePrice == null ? null : Number(p.basePrice),
          masterQuantityForCompare: p.totalStock,
          cells: byProduct.get(p.id) ?? [],
        })),
        count: truncated.length,
        totalMatched: sortedProducts.length, // before slice — for "showing N of M"
      }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[listings/matrix] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // ─────────────────────────────────────────────────────────────────
  // GET /api/listings/drafts — products without coverage on a channel
  // ?channel=AMAZON|EBAY|...   ?marketplace=IT|...   ?search=...
  // ─────────────────────────────────────────────────────────────────
  fastify.get('/listings/drafts', async (request, reply) => {
    try {
      const q = request.query as Record<string, string | undefined>
      const channel = q.channel
      const marketplace = q.marketplace
      const search = (q.search ?? '').trim()
      const limit = Math.min(500, Math.max(1, Math.floor(safeNum(q.limit) ?? 100)))

      if (!channel || !ALLOWED_CHANNELS.includes(channel)) {
        return reply.code(400).send({ error: 'channel is required (AMAZON|EBAY|SHOPIFY|WOOCOMMERCE|ETSY)' })
      }

      // Two layers:
      //   (a) products with a DRAFT listing on the target channel
      //   (b) products with no listing on the target channel at all (uncovered)
      const draftWhere: any = { channel, listingStatus: 'DRAFT' }
      if (marketplace) draftWhere.marketplace = marketplace
      if (search) {
        draftWhere.product = {
          OR: [
            { sku: { contains: search, mode: 'insensitive' } },
            { name: { contains: search, mode: 'insensitive' } },
          ],
        }
      }

      const drafts = await prisma.channelListing.findMany({
        where: draftWhere,
        include: { product: { select: { id: true, sku: true, name: true, basePrice: true } } },
        orderBy: { updatedAt: 'desc' },
        take: limit,
      })

      // For "uncovered": list products that don't have any listing on this channel
      const productsWithListings = await prisma.channelListing.findMany({
        where: { channel },
        select: { productId: true },
        distinct: ['productId'],
      })
      const coveredIds = new Set(productsWithListings.map((p) => p.productId))

      const uncoveredWhere: any = { id: { notIn: Array.from(coveredIds) }, isParent: false }
      if (search) {
        uncoveredWhere.OR = [
          { sku: { contains: search, mode: 'insensitive' } },
          { name: { contains: search, mode: 'insensitive' } },
        ]
      }

      const uncovered = await prisma.product.findMany({
        where: uncoveredWhere,
        select: { id: true, sku: true, name: true, basePrice: true },
        orderBy: { updatedAt: 'desc' },
        take: limit,
      })

      return {
        drafts: drafts.map((d) => ({
          id: d.id,
          productId: d.productId,
          channel: d.channel,
          marketplace: d.marketplace,
          listingStatus: d.listingStatus,
          price: d.price == null ? null : Number(d.price),
          title: d.title,
          updatedAt: d.updatedAt,
          product: {
            id: d.product.id,
            sku: d.product.sku,
            name: d.product.name,
            basePrice: d.product.basePrice == null ? null : Number(d.product.basePrice),
          },
        })),
        uncovered: uncovered.map((p) => ({
          id: p.id,
          sku: p.sku,
          name: p.name,
          basePrice: p.basePrice == null ? null : Number(p.basePrice),
        })),
        draftCount: drafts.length,
        uncoveredCount: uncovered.length,
      }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[listings/drafts] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // ─────────────────────────────────────────────────────────────────
  // GET /api/listings/:id — single listing for the drawer
  //
  // S.2 — also returns `companions`: every other ChannelListing for the
  // same product. The drawer's "Per-channel" tab uses this to surface
  // "this product is also live on AMAZON DE, EBAY IT, …" without a
  // separate round-trip. Companions are kept lean (status, price, qty,
  // sync state, listingUrl) — no need for the full detail shape.
  // ─────────────────────────────────────────────────────────────────
  fastify.get('/listings/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const l = await prisma.channelListing.findUnique({
        where: { id },
        include: {
          product: {
            select: {
              id: true, sku: true, name: true, basePrice: true, totalStock: true,
              amazonAsin: true, brand: true,
              images: { select: { url: true } },
            },
          },
        },
      })
      if (!l) return reply.code(404).send({ error: 'Listing not found' })

      const companions = await prisma.channelListing.findMany({
        where: { productId: l.productId, id: { not: id } },
        select: {
          id: true, channel: true, marketplace: true,
          listingStatus: true, syncStatus: true, lastSyncStatus: true,
          lastSyncedAt: true, lastSyncError: true,
          price: true, quantity: true,
          // C.10 — fields the drawer's Per-channel comparison panel
          // needs to render per-marketplace customization inline:
          // master values for delta math, override flags so the
          // operator sees which fields are explicitly overridden vs
          // inherited, and effective title/description for the title
          // mismatch indicator. Stored as part of ChannelListing — no
          // join cost.
          title: true, titleOverride: true, masterTitle: true,
          masterPrice: true, masterQuantity: true,
          priceOverride: true, quantityOverride: true,
          followMasterTitle: true, followMasterPrice: true,
          followMasterQuantity: true, followMasterDescription: true,
          externalListingId: true, isPublished: true,
        },
        orderBy: [{ channel: 'asc' }, { marketplace: 'asc' }],
      })

      // S.5 — Amazon-specific context. Included only when this is an
      // Amazon listing; populates the drawer Detail tab's Amazon
      // section (ASIN tree, FBA economics, Buy Box intelligence,
      // active suppression record).
      let amazonContext: any = null
      if (l.channel === 'AMAZON') {
        // Sibling variations (parent/child ASIN tree). When this product
        // has a parent, fetch the parent and all its variations. When
        // this IS a parent, fetch its own variations.
        const product = await prisma.product.findUnique({
          where: { id: l.productId },
          select: {
            id: true, sku: true, name: true,
            isParent: true, parentId: true,
            amazonAsin: true, parentAsin: true,
            variations: {
              select: { id: true, sku: true, name: true, amazonAsin: true, stock: true },
            },
          },
        })

        // Active suppression record, if any
        const activeSuppression = await prisma.amazonSuppression.findFirst({
          where: { listingId: l.id, resolvedAt: null },
          orderBy: { suppressedAt: 'desc' },
        })

        // Buy Box intelligence: our price vs lowest competitor.
        // `lowestCompetitorPrice` + `competitorFetchedAt` come from a
        // future SP-API GetItemOffersBatch cron; today they may be
        // null. Drawer renders gracefully either way.
        const competitorDelta =
          l.price != null && l.lowestCompetitorPrice != null
            ? Number(l.price) - Number(l.lowestCompetitorPrice)
            : null

        amazonContext = {
          asin: l.externalListingId,
          parentAsin: l.externalParentId,
          isParentSku: product?.isParent ?? false,
          variations: product?.variations ?? [],
          fbaEconomics: {
            estimatedFbaFee: l.estimatedFbaFee == null ? null : Number(l.estimatedFbaFee),
            referralFeePercent: l.referralFeePercent == null ? null : Number(l.referralFeePercent),
            feeFetchedAt: l.feeFetchedAt,
          },
          buyBox: {
            ourPrice: l.price == null ? null : Number(l.price),
            lowestCompetitorPrice:
              l.lowestCompetitorPrice == null ? null : Number(l.lowestCompetitorPrice),
            competitorFetchedAt: l.competitorFetchedAt,
            delta: competitorDelta,
            losingOnPrice: competitorDelta != null && competitorDelta > 0,
            // Real ownership requires SP-API GetItemOffersBatch — flagged honestly
            ownershipKnown: false,
          },
          activeSuppression: activeSuppression
            ? {
                id: activeSuppression.id,
                suppressedAt: activeSuppression.suppressedAt,
                reasonCode: activeSuppression.reasonCode,
                reasonText: activeSuppression.reasonText,
                severity: activeSuppression.severity,
                source: activeSuppression.source,
              }
            : null,
        }
      }

      return {
        id: l.id,
        productId: l.productId,
        channel: l.channel,
        marketplace: l.marketplace,
        listingStatus: l.listingStatus,
        syncStatus: l.syncStatus,
        lastSyncStatus: l.lastSyncStatus,
        lastSyncError: l.lastSyncError,
        syncRetryCount: l.syncRetryCount,
        lastSyncedAt: l.lastSyncedAt,
        title: l.title,
        description: l.description,
        price: l.price == null ? null : Number(l.price),
        salePrice: l.salePrice == null ? null : Number(l.salePrice),
        quantity: l.quantity,
        stockBuffer: l.stockBuffer,
        externalListingId: l.externalListingId,
        externalParentId: l.externalParentId,
        listingUrl: listingUrlFor(l.channel, l.marketplace, l.externalListingId),
        pricingRule: l.pricingRule,
        priceAdjustmentPercent: l.priceAdjustmentPercent == null ? null : Number(l.priceAdjustmentPercent),
        platformAttributes: l.platformAttributes,
        variationTheme: l.variationTheme,
        followMasterTitle: l.followMasterTitle,
        followMasterDescription: l.followMasterDescription,
        followMasterPrice: l.followMasterPrice,
        followMasterQuantity: l.followMasterQuantity,
        followMasterImages: l.followMasterImages,
        masterTitle: l.masterTitle,
        masterPrice: l.masterPrice == null ? null : Number(l.masterPrice),
        masterQuantity: l.masterQuantity,
        validationStatus: l.validationStatus,
        validationErrors: l.validationErrors,
        version: l.version,
        isPublished: l.isPublished,
        product: {
          id: l.product.id,
          sku: l.product.sku,
          name: l.product.name,
          basePrice: l.product.basePrice == null ? null : Number(l.product.basePrice),
          totalStock: l.product.totalStock,
          amazonAsin: l.product.amazonAsin,
          brand: l.product.brand,
          images: l.product.images.map((i) => i.url),
        },
        companions: companions.map((c) => ({
          id: c.id,
          channel: c.channel,
          marketplace: c.marketplace,
          listingStatus: c.listingStatus,
          syncStatus: c.syncStatus,
          lastSyncStatus: c.lastSyncStatus,
          lastSyncedAt: c.lastSyncedAt,
          lastSyncError: c.lastSyncError,
          price: c.price == null ? null : Number(c.price),
          quantity: c.quantity,
          externalListingId: c.externalListingId,
          isPublished: c.isPublished,
          listingUrl: listingUrlFor(c.channel, c.marketplace, c.externalListingId),
          // C.10 — comparison-panel fields. effectiveTitle picks the
          // override when set, else the channel-stored title.
          title:
            (c.titleOverride && c.titleOverride.length > 0
              ? c.titleOverride
              : c.title) ?? null,
          masterTitle: c.masterTitle,
          masterPrice: c.masterPrice == null ? null : Number(c.masterPrice),
          masterQuantity: c.masterQuantity,
          // Override indicators for per-marketplace customization view —
          // surfaces "this channel's price/qty/title is explicitly
          // overridden" without forcing a follow-up drawer-load.
          hasPriceOverride: c.priceOverride != null,
          hasQuantityOverride: c.quantityOverride != null,
          hasTitleOverride:
            c.titleOverride != null && c.titleOverride.length > 0,
          followMasterTitle: c.followMasterTitle,
          followMasterPrice: c.followMasterPrice,
          followMasterQuantity: c.followMasterQuantity,
          followMasterDescription: c.followMasterDescription,
        })),
        // S.5 — Amazon-specific context (null for non-Amazon channels)
        amazonContext,
        // S.3 — computed health: score, category, structured issues.
        // The frontend HealthPanel renders this without recomputing.
        health: computeHealth({
          listingStatus: l.listingStatus,
          syncStatus: l.syncStatus,
          lastSyncStatus: l.lastSyncStatus,
          lastSyncError: l.lastSyncError,
          lastSyncedAt: l.lastSyncedAt,
          syncRetryCount: l.syncRetryCount,
          validationErrors: l.validationErrors,
          title: l.title,
          price: l.price == null ? null : Number(l.price),
          quantity: l.quantity,
          externalListingId: l.externalListingId,
          channel: l.channel,
          marketplace: l.marketplace,
          followMasterPrice: l.followMasterPrice,
          followMasterQuantity: l.followMasterQuantity,
          followMasterTitle: l.followMasterTitle,
          masterPrice: l.masterPrice == null ? null : Number(l.masterPrice),
          masterQuantity: l.masterQuantity,
          masterTitle: l.masterTitle,
        }),
        createdAt: l.createdAt,
        updatedAt: l.updatedAt,
      }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[listings/:id] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // ─────────────────────────────────────────────────────────────────
  // PATCH /api/listings/:id — single-listing field updates
  //
  // S.2 — narrow surface for drawer-driven edits: per-field
  // followMaster toggles, pricingRule, priceAdjustmentPercent,
  // isPublished, stockBuffer. The bulk-action endpoint covers
  // multi-listing operations and is awkward for single-row UX
  // (job polling, async, etc.) so this provides direct synchronous
  // updates with optimistic-concurrency via `version`.
  //
  // Heavy authoring (title/description/price/quantity overrides) stays
  // in /products/:id/edit — the drawer is for toggles and quick
  // adjustments, not deep editing.
  // ─────────────────────────────────────────────────────────────────
  fastify.patch('/listings/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = (request.body ?? {}) as {
        followMasterTitle?: boolean
        followMasterDescription?: boolean
        followMasterPrice?: boolean
        followMasterQuantity?: boolean
        followMasterImages?: boolean
        followMasterBulletPoints?: boolean
        pricingRule?: 'FIXED' | 'MATCH_AMAZON' | 'PERCENT_OF_MASTER'
        priceAdjustmentPercent?: number
        isPublished?: boolean
        stockBuffer?: number
        expectedVersion?: number
      }

      const data: any = {}
      const boolFields = [
        'followMasterTitle', 'followMasterDescription', 'followMasterPrice',
        'followMasterQuantity', 'followMasterImages', 'followMasterBulletPoints',
        'isPublished',
      ] as const
      for (const k of boolFields) {
        if (typeof body[k] === 'boolean') data[k] = body[k]
      }
      if (body.pricingRule) {
        const valid = ['FIXED', 'MATCH_AMAZON', 'PERCENT_OF_MASTER']
        if (!valid.includes(body.pricingRule)) {
          return reply.code(400).send({ error: `pricingRule must be ${valid.join('|')}` })
        }
        data.pricingRule = body.pricingRule
      }
      if (body.priceAdjustmentPercent != null) {
        const n = Number(body.priceAdjustmentPercent)
        if (!Number.isFinite(n)) {
          return reply.code(400).send({ error: 'priceAdjustmentPercent must be a number' })
        }
        data.priceAdjustmentPercent = n
      }
      if (body.stockBuffer != null) {
        const n = Math.floor(Number(body.stockBuffer))
        if (!Number.isFinite(n) || n < 0) {
          return reply.code(400).send({ error: 'stockBuffer must be a non-negative integer' })
        }
        data.stockBuffer = n
      }

      if (Object.keys(data).length === 0) {
        return reply.code(400).send({ error: 'No updatable fields provided' })
      }

      // Optimistic concurrency: if the client tells us what version it
      // saw, refuse to write over a newer one. Without expectedVersion
      // we still increment, just no concurrent-edit detection.
      const current = await prisma.channelListing.findUnique({
        where: { id },
        select: { id: true, version: true },
      })
      if (!current) return reply.code(404).send({ error: 'Listing not found' })
      if (
        body.expectedVersion != null &&
        Number(body.expectedVersion) !== current.version
      ) {
        return reply.code(409).send({
          error: 'Version conflict — another tab edited this listing. Refresh and retry.',
          currentVersion: current.version,
        })
      }

      data.version = { increment: 1 }
      const updated = await prisma.channelListing.update({ where: { id }, data })
      // S.4 — broadcast so other tabs / cells refresh within 200ms.
      publishListingEvent({ type: 'listing.updated', listingId: id, reason: 'patch', ts: Date.now() })
      return { ok: true, listing: { id: updated.id, version: updated.version } }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[listings/:id PATCH] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // ─────────────────────────────────────────────────────────────────
  // GET /api/listings/amazon/overview — Amazon-specific aggregates
  //
  // S.5 — powers the AmazonListingsClient header. KPIs are scoped to a
  // single Amazon marketplace (IT/DE/FR/UK/ES/NL/PL/SE/US) when
  // ?marketplace= is present, or to all Amazon marketplaces aggregated
  // when omitted.
  //
  // Returned shape includes counts (live, suppressed, draft, error),
  // FBA economics rollups (avg fee, avg referral %), parent ASIN count,
  // currently-active suppressions list, and a per-marketplace
  // breakdown for the marketplace tab strip badges.
  // ─────────────────────────────────────────────────────────────────
  fastify.get('/listings/amazon/overview', async (request, reply) => {
    try {
      const q = request.query as Record<string, string | undefined>
      const marketplace = (q.marketplace ?? '').trim()

      const where: any = { channel: 'AMAZON' }
      if (marketplace) where.marketplace = marketplace

      const [
        total,
        live,
        draft,
        error,
        suppressed,
        listings,
        marketplaceBreakdown,
        activeSuppressions,
      ] = await Promise.all([
        prisma.channelListing.count({ where }),
        prisma.channelListing.count({ where: { ...where, listingStatus: 'ACTIVE' } }),
        prisma.channelListing.count({ where: { ...where, listingStatus: 'DRAFT' } }),
        prisma.channelListing.count({ where: { ...where, listingStatus: 'ERROR' } }),
        prisma.channelListing.count({ where: { ...where, listingStatus: 'SUPPRESSED' } }),
        prisma.channelListing.findMany({
          where,
          select: {
            id: true,
            estimatedFbaFee: true,
            referralFeePercent: true,
            externalParentId: true,
            externalListingId: true,
            price: true,
            lowestCompetitorPrice: true,
          },
        }),
        // Per-marketplace breakdown (always group all Amazon markets
        // even when filtering — the tab strip needs the unfiltered set
        // to render badge counts).
        prisma.channelListing.groupBy({
          by: ['marketplace'],
          where: { channel: 'AMAZON' },
          _count: true,
        }),
        prisma.amazonSuppression.findMany({
          where: {
            resolvedAt: null,
            channelListing: { channel: 'AMAZON', ...(marketplace ? { marketplace } : {}) },
          },
          orderBy: { suppressedAt: 'desc' },
          take: 50,
          include: {
            channelListing: {
              select: {
                id: true,
                marketplace: true,
                externalListingId: true,
                listingStatus: true,
                product: { select: { id: true, sku: true, name: true } },
              },
            },
          },
        }),
      ])

      // FBA economics rollups (only over rows that actually have fees set)
      const withFee = listings.filter((l) => l.estimatedFbaFee != null)
      const withReferral = listings.filter((l) => l.referralFeePercent != null)
      const avgFbaFee =
        withFee.length === 0
          ? null
          : withFee.reduce((acc, l) => acc + Number(l.estimatedFbaFee), 0) / withFee.length
      const avgReferralPct =
        withReferral.length === 0
          ? null
          : withReferral.reduce((acc, l) => acc + Number(l.referralFeePercent), 0) / withReferral.length

      // Parent ASIN count = distinct externalParentId values present
      const parentAsins = new Set<string>()
      for (const l of listings) {
        if (l.externalParentId) parentAsins.add(l.externalParentId)
      }

      // Pricing competitiveness: fraction of rows where our price >
      // lowestCompetitorPrice (we're losing on price). Soft signal —
      // real Buy Box requires SP-API.
      const withCompetitor = listings.filter(
        (l) => l.lowestCompetitorPrice != null && l.price != null,
      )
      const losingOnPrice = withCompetitor.filter(
        (l) => Number(l.price) > Number(l.lowestCompetitorPrice),
      ).length

      return {
        marketplace: marketplace || null,
        counts: { total, live, draft, error, suppressed },
        fbaEconomics: {
          avgFbaFee,
          avgReferralPct,
          coverage: total === 0 ? 0 : Math.round((withFee.length / total) * 100),
        },
        parentAsinCount: parentAsins.size,
        pricingIntelligence: {
          listingsWithCompetitor: withCompetitor.length,
          losingOnPrice,
        },
        marketplaceBreakdown: marketplaceBreakdown.map((b) => ({
          marketplace: b.marketplace,
          count: b._count,
        })),
        activeSuppressions: activeSuppressions.map((s) => ({
          id: s.id,
          listingId: s.listingId,
          suppressedAt: s.suppressedAt,
          reasonCode: s.reasonCode,
          reasonText: s.reasonText,
          severity: s.severity,
          source: s.source,
          listing: {
            id: s.channelListing.id,
            marketplace: s.channelListing.marketplace,
            externalListingId: s.channelListing.externalListingId,
            listingStatus: s.channelListing.listingStatus,
            product: s.channelListing.product,
          },
        })),
      }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[listings/amazon/overview] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // GET /api/listings/ebay/overview — eBay-specific aggregates
  //
  // C.15 — powers the EbayListingsClient header. Mirror of the Amazon
  // overview, but reads eBay-specific aggregates: latest watcher /
  // hit / question counts from EbayWatcherStats, active markdown count
  // from EbayMarkdown, active campaign count from EbayCampaign.
  //
  // Scoped to a single eBay marketplace (IT/DE/ES/FR/UK) when
  // ?marketplace=EBAY_IT is present, or to all eBay marketplaces
  // aggregated when omitted.
  fastify.get('/listings/ebay/overview', async (request, reply) => {
    try {
      const q = request.query as Record<string, string | undefined>
      const marketplace = (q.marketplace ?? '').trim()

      // ChannelListing.marketplace stores the country code (IT/DE/...)
      // for eBay too — same convention as Amazon. The full
      // EBAY_IT-style marketplaceId only lives in EbayCampaign /
      // EbayMarkdown payloads. Keep the WHERE clause simple by
      // accepting either form.
      const cleanMarket = marketplace.replace(/^EBAY_/, '')
      const where: any = { channel: 'EBAY' }
      if (cleanMarket) where.marketplace = cleanMarket

      const [
        total,
        live,
        draft,
        error,
        listings,
        marketplaceBreakdown,
      ] = await Promise.all([
        prisma.channelListing.count({ where }),
        prisma.channelListing.count({ where: { ...where, listingStatus: 'ACTIVE' } }),
        prisma.channelListing.count({ where: { ...where, listingStatus: 'DRAFT' } }),
        prisma.channelListing.count({ where: { ...where, listingStatus: 'ERROR' } }),
        prisma.channelListing.findMany({
          where,
          select: {
            id: true,
            // C.14 — latest watcher snapshot per listing. We pull all
            // snapshots and reduce to the most recent on the server
            // because the volume per listing is bounded by the cron
            // cadence (one row/hour cap by design).
            ebayWatcherStats: {
              orderBy: { snapshotAt: 'desc' },
              take: 1,
              select: { watcherCount: true, hitCount: true, questionCount: true, snapshotAt: true },
            },
            // Active markdowns on this listing right now
            ebayMarkdowns: {
              where: { status: 'ACTIVE' },
              select: { id: true },
              take: 1,
            },
          },
        }),
        // Per-marketplace breakdown (unfiltered — tab strip badges).
        prisma.channelListing.groupBy({
          by: ['marketplace'],
          where: { channel: 'EBAY' },
          _count: true,
        }),
      ])

      // Watcher / hit / question rollups — only over listings that
      // have at least one snapshot.
      const withStats = listings.filter((l) => l.ebayWatcherStats.length > 0)
      const totalWatchers = withStats.reduce(
        (acc, l) => acc + (l.ebayWatcherStats[0]?.watcherCount ?? 0),
        0,
      )
      const totalHits = withStats.reduce(
        (acc, l) => acc + (l.ebayWatcherStats[0]?.hitCount ?? 0),
        0,
      )
      const totalQuestions = withStats.reduce(
        (acc, l) => acc + (l.ebayWatcherStats[0]?.questionCount ?? 0),
        0,
      )
      const avgWatchers = withStats.length === 0 ? null : totalWatchers / withStats.length

      const listingsWithActiveMarkdown = listings.filter(
        (l) => l.ebayMarkdowns.length > 0,
      ).length

      // Active campaigns scoped to this marketplace (or all marketplaces
      // when no filter). EbayCampaign.marketplace stores the full
      // EBAY_IT-style id; convert from the country code if needed.
      const ebayMarketId = cleanMarket ? `EBAY_${cleanMarket}` : null
      const activeCampaigns = await prisma.ebayCampaign.count({
        where: {
          status: 'RUNNING',
          ...(ebayMarketId ? { marketplace: ebayMarketId } : {}),
        },
      })

      return {
        marketplace: cleanMarket || null,
        counts: { total, live, draft, error },
        engagement: {
          coverage: total === 0 ? 0 : Math.round((withStats.length / total) * 100),
          avgWatchers,
          totalWatchers,
          totalHits,
          totalQuestions,
        },
        markdowns: {
          activeListingCount: listingsWithActiveMarkdown,
        },
        campaigns: {
          activeCount: activeCampaigns,
        },
        marketplaceBreakdown: marketplaceBreakdown.map((b) => ({
          marketplace: b.marketplace,
          count: b._count,
        })),
      }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[listings/ebay/overview] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // ─────────────────────────────────────────────────────────────────
  // POST /api/listings/amazon/suppressions — manually log a suppression
  //
  // S.5 — used by the resolver UI when an operator wants to record a
  // suppression event ahead of SP-API auto-detection (S.5b). Body
  // carries listingId, reasonText, optional reasonCode + severity.
  // ─────────────────────────────────────────────────────────────────
  fastify.post('/listings/amazon/suppressions', async (request, reply) => {
    try {
      const body = (request.body ?? {}) as {
        listingId?: string
        reasonText?: string
        reasonCode?: string
        severity?: 'ERROR' | 'WARNING' | 'INFO'
      }
      if (!body.listingId) return reply.code(400).send({ error: 'listingId required' })
      if (!body.reasonText) return reply.code(400).send({ error: 'reasonText required' })

      const listing = await prisma.channelListing.findUnique({
        where: { id: body.listingId },
        select: { id: true, channel: true },
      })
      if (!listing) return reply.code(404).send({ error: 'Listing not found' })
      if (listing.channel !== 'AMAZON') {
        return reply.code(400).send({ error: 'Suppressions are Amazon-only' })
      }

      const created = await prisma.amazonSuppression.create({
        data: {
          listingId: body.listingId,
          reasonText: body.reasonText,
          reasonCode: body.reasonCode ?? null,
          severity: body.severity ?? 'ERROR',
          source: 'manual',
        },
      })
      // Reflect on the listing itself so the rest of the UI sees SUPPRESSED.
      await prisma.channelListing.update({
        where: { id: body.listingId },
        data: { listingStatus: 'SUPPRESSED', version: { increment: 1 } },
      })
      publishListingEvent({ type: 'listing.updated', listingId: body.listingId, reason: 'suppression-opened', ts: Date.now() })
      return { ok: true, suppression: created }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[listings/amazon/suppressions POST] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // ─────────────────────────────────────────────────────────────────
  // PATCH /api/listings/amazon/suppressions/:id — resolve a suppression
  // ─────────────────────────────────────────────────────────────────
  fastify.patch('/listings/amazon/suppressions/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = (request.body ?? {}) as { resolved?: boolean; restoreStatus?: string }

      const sup = await prisma.amazonSuppression.findUnique({
        where: { id },
        select: { id: true, listingId: true, resolvedAt: true },
      })
      if (!sup) return reply.code(404).send({ error: 'Suppression not found' })

      if (body.resolved && !sup.resolvedAt) {
        await prisma.amazonSuppression.update({
          where: { id },
          data: { resolvedAt: new Date() },
        })
        // Optional: restore the listing's status so the rest of the
        // UI un-flags it. We default to ACTIVE; caller can override.
        const newStatus = body.restoreStatus ?? 'ACTIVE'
        await prisma.channelListing.update({
          where: { id: sup.listingId },
          data: { listingStatus: newStatus, version: { increment: 1 } },
        })
        publishListingEvent({ type: 'listing.updated', listingId: sup.listingId, reason: 'suppression-resolved', ts: Date.now() })
      }
      return { ok: true }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[listings/amazon/suppressions PATCH] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // ─────────────────────────────────────────────────────────────────
  // GET /api/listings/:id/sync-history — paginated sync timeline
  //
  // S.4 — backed by the SyncAttempt audit table. Drawer's Sync tab
  // renders this as a real timeline (replaces the synthetic 2-entry
  // version that S.2 shipped as a placeholder).
  // ─────────────────────────────────────────────────────────────────
  fastify.get('/listings/:id/sync-history', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const q = request.query as Record<string, string | undefined>
      const limit = Math.min(100, Math.max(1, Math.floor(safeNum(q.limit) ?? 25)))

      const exists = await prisma.channelListing.findUnique({
        where: { id },
        select: { id: true },
      })
      if (!exists) return reply.code(404).send({ error: 'Listing not found' })

      const attempts = await prisma.syncAttempt.findMany({
        where: { listingId: id },
        orderBy: { attemptedAt: 'desc' },
        take: limit,
      })

      return {
        attempts: attempts.map((a) => ({
          id: a.id,
          attemptedAt: a.attemptedAt,
          status: a.status,
          source: a.source,
          durationMs: a.durationMs,
          error: a.error,
        })),
        count: attempts.length,
      }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[listings/:id/sync-history] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // ─────────────────────────────────────────────────────────────────
  // GET /api/listings/events — SSE stream of listing events
  //
  // S.4 — mirrors /api/fulfillment/inbound/events. Long-lived GET;
  // single open connection per client. 25s heartbeat keeps middleware
  // (Railway's Envoy, Cloudflare) from closing idle connections.
  // EventSource auto-reconnects on transient drops.
  // ─────────────────────────────────────────────────────────────────
  fastify.get('/listings/events', async (request, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    reply.raw.write(
      `event: ping\ndata: ${JSON.stringify({ ts: Date.now(), connected: true })}\n\n`,
    )

    const send = (event: any) => {
      try {
        reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      } catch {
        // Connection dead — cleanup runs in close handler.
      }
    }

    const unsubscribe = subscribeListingEvents(send)
    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(`: heartbeat ${Date.now()}\n\n`)
      } catch {
        // ignore
      }
    }, 25_000)

    request.raw.on('close', () => {
      clearInterval(heartbeat)
      unsubscribe()
    })

    await new Promise(() => {})
  })

  // ─────────────────────────────────────────────────────────────────
  // POST /api/listings/:id/resync — synchronous inline pull from channel
  //
  // S.0 / C-3 — was a placebo (just flipped a flag with no consumer).
  // Now hits the channel adapter directly and merges the response.
  // Single-listing only; bulk resync stays on the bulk-action endpoint
  // until S.4 builds the inbound queue.
  //
  // Status transitions:
  //   pre-call:  syncStatus = 'SYNCING'
  //   success:   syncStatus = 'IN_SYNC',  lastSyncStatus = 'SUCCESS'
  //   timeout:   syncStatus = 'FAILED',   lastSyncStatus = 'FAILED'
  //   error:     syncStatus = 'FAILED',   lastSyncStatus = 'FAILED'
  //   501 path:  syncStatus untouched (channel adapter not wired —
  //              not the listing's fault)
  // ─────────────────────────────────────────────────────────────────
  fastify.post('/listings/:id/resync', async (request, reply) => {
    const { id } = request.params as { id: string }

    const existing = await prisma.channelListing.findUnique({
      where: { id },
      select: {
        id: true,
        channel: true,
        marketplace: true,
        externalListingId: true,
        version: true,
      },
    })
    if (!existing) return reply.code(404).send({ error: 'Listing not found' })

    if (!existing.externalListingId) {
      return reply.code(400).send({
        error:
          'Listing has no externalListingId — never been published. Cannot resync.',
      })
    }

    // Lazy-import so the route module compiles even if the resync
    // service file moves later. Path is relative-with-extension to
    // match the rest of the codebase's NodeNext resolution.
    const { pullListingFromChannel, ChannelNotSupportedError, ResyncTimeoutError } =
      await import('../services/listings/resync.service.js')

    // S.4 — open a SyncAttempt row up-front so the timeline records the
    // attempt even if the channel call hangs / crashes before we can
    // write a terminal status. We update this row at the end with the
    // real outcome.
    const attemptStartedAt = Date.now()
    const source = ((request.query as any)?.source as string) ?? 'manual'
    const attempt = await prisma.syncAttempt.create({
      data: {
        listingId: id,
        status: 'IN_PROGRESS',
        source,
      },
      select: { id: true },
    })

    // Mark in-flight first so concurrent polls / drawer reopens see
    // SYNCING rather than the stale prior status.
    await prisma.channelListing.update({
      where: { id },
      data: {
        syncStatus: 'SYNCING',
        lastSyncStatus: 'PENDING',
      },
    })

    // Notify SSE subscribers so cells / drawers flip to amber instantly.
    publishListingEvent({ type: 'listing.syncing', listingId: id, ts: Date.now() })

    try {
      const remote = await pullListingFromChannel(
        {
          channel: existing.channel,
          marketplace: existing.marketplace,
          externalListingId: existing.externalListingId,
        },
        { timeoutMs: 10_000 },
      )

      const durationMs = Date.now() - attemptStartedAt
      const updated = await prisma.channelListing.update({
        where: { id },
        data: {
          // Only overwrite columns the channel actually returned a value
          // for. `undefined` skips the column in Prisma update payloads,
          // so a marketplace that doesn't surface (say) a title leaves
          // our title as-is rather than nulling it.
          ...(remote.price != null ? { price: remote.price } : {}),
          ...(remote.quantity != null ? { quantity: remote.quantity } : {}),
          ...(remote.title != null ? { title: remote.title } : {}),
          ...(remote.listingStatus != null
            ? { listingStatus: remote.listingStatus }
            : {}),
          syncStatus: 'IN_SYNC',
          lastSyncStatus: 'SUCCESS',
          lastSyncedAt: new Date(),
          lastSyncError: null,
          syncRetryCount: 0,
          version: { increment: 1 },
        },
      })
      await prisma.syncAttempt.update({
        where: { id: attempt.id },
        data: { status: 'SUCCESS', durationMs },
      })
      publishListingEvent({
        type: 'listing.synced',
        listingId: id,
        status: 'SUCCESS',
        durationMs,
        ts: Date.now(),
      })
      return { ok: true, listing: updated }
    } catch (error: any) {
      const durationMs = Date.now() - attemptStartedAt
      // Channel adapter not implemented for this channel — revert the
      // pre-call SYNCING marker and surface 501 cleanly. Don't write
      // FAILED; this isn't the listing's fault.
      if (error instanceof ChannelNotSupportedError) {
        await prisma.channelListing.update({
          where: { id },
          data: { syncStatus: 'IDLE', lastSyncStatus: null },
        })
        await prisma.syncAttempt.update({
          where: { id: attempt.id },
          data: { status: 'NOT_IMPLEMENTED', durationMs, error: error.message },
        })
        publishListingEvent({
          type: 'listing.synced',
          listingId: id,
          status: 'NOT_IMPLEMENTED',
          durationMs,
          ts: Date.now(),
        })
        return reply.code(501).send({
          error: 'NOT_IMPLEMENTED',
          detail: error.message,
        })
      }

      const isTimeout = error instanceof ResyncTimeoutError
      await prisma.channelListing.update({
        where: { id },
        data: {
          syncStatus: 'FAILED',
          lastSyncStatus: 'FAILED',
          lastSyncError: error?.message ?? String(error),
          syncRetryCount: { increment: 1 },
        },
      })
      await prisma.syncAttempt.update({
        where: { id: attempt.id },
        data: {
          status: isTimeout ? 'TIMEOUT' : 'FAILED',
          durationMs,
          error: error?.message ?? String(error),
        },
      })
      publishListingEvent({
        type: 'listing.synced',
        listingId: id,
        status: isTimeout ? 'TIMEOUT' : 'FAILED',
        durationMs,
        ts: Date.now(),
      })
      fastify.log.error({ err: error, listingId: id }, '[listings/:id/resync] failed')
      return reply.code(isTimeout ? 504 : 502).send({
        error: isTimeout ? 'CHANNEL_TIMEOUT' : 'CHANNEL_ERROR',
        detail: error?.message ?? String(error),
      })
    }
  })

  // ─────────────────────────────────────────────────────────────────
  // POST /api/listings/bulk-action
  // body: { action, listingIds[], payload? }
  // actions:
  //   - "publish"          → isPublished=true
  //   - "unpublish"        → isPublished=false
  //   - "resync"           → syncStatus=PENDING, syncRetryCount=0
  //   - "set-price"        → price = payload.price (Decimal)
  //   - "follow-master"    → followMaster* = true (cascade master fields)
  //   - "unfollow-master"  → followMaster* = false (freeze current values)
  //   - "set-pricing-rule" → pricingRule = payload.pricingRule
  // Returns 202 with jobId — poll GET /api/listings/bulk-action/:jobId
  // ─────────────────────────────────────────────────────────────────
  fastify.post('/listings/bulk-action', async (request, reply) => {
    try {
      const body = (request.body ?? {}) as {
        action?: string
        listingIds?: string[]
        payload?: any
      }
      const action = body.action
      const ids = Array.isArray(body.listingIds) ? body.listingIds : []
      if (!action) return reply.code(400).send({ error: 'action is required' })
      if (ids.length === 0) return reply.code(400).send({ error: 'listingIds[] is required' })
      if (ids.length > 1000) return reply.code(400).send({ error: 'Max 1000 listings per bulk action' })

      const validActions = ['publish', 'unpublish', 'resync', 'set-price', 'follow-master', 'unfollow-master', 'set-pricing-rule']
      if (!validActions.includes(action)) {
        return reply.code(400).send({ error: `Invalid action. Allowed: ${validActions.join(', ')}` })
      }

      // Validate action-specific payload BEFORE creating the job row so
      // a malformed request doesn't leave a half-baked job in the DB.
      if (action === 'set-price') {
        const p = Number(body.payload?.price)
        if (!Number.isFinite(p) || p < 0) {
          return reply.code(400).send({ error: 'payload.price must be a non-negative number' })
        }
      }
      if (action === 'set-pricing-rule') {
        const rule = String(body.payload?.pricingRule ?? '').toUpperCase()
        if (!['FIXED', 'MATCH_AMAZON', 'PERCENT_OF_MASTER'].includes(rule)) {
          return reply.code(400).send({ error: 'payload.pricingRule must be FIXED|MATCH_AMAZON|PERCENT_OF_MASTER' })
        }
      }

      const actionPayload: ListingBulkActionPayload = {
        action,
        listingIds: ids,
        payload: body.payload,
      }

      // S.0.5 / H-5 — persist to BulkActionJob. The targetProductIds
      // column is repurposed as targetListingIds here (column type is
      // String[] either way; per-route semantics carried in actionType).
      const job = await prisma.bulkActionJob.create({
        data: {
          jobName: `Listings: ${action} (${ids.length})`,
          actionType: LISTING_BULK_ACTION_TYPE,
          targetProductIds: ids, // listingIds stored here for /listings actionType
          targetVariationIds: [],
          actionPayload: actionPayload as any,
          status: 'QUEUED',
          totalItems: ids.length,
          processedItems: 0,
          failedItems: 0,
          skippedItems: 0,
          progressPercent: 0,
          isRollbackable: false, // Phase J of /bulk-operations adds rollback; not in scope here
        },
      })
      const jobId = job.id

      // Run async — do not block the response. Worker updates the DB
      // row as it progresses; clients poll GET /api/listings/bulk-action/:jobId.
      ;(async () => {
        await prisma.bulkActionJob.update({
          where: { id: jobId },
          data: { status: 'IN_PROGRESS', startedAt: new Date() },
        })

        let succeeded = 0
        let failed = 0
        const errors: Array<{ listingId: string; reason: string }> = []

        for (const id of ids) {
          try {
            const data: any = {}
            switch (action) {
              case 'publish': data.isPublished = true; break
              case 'unpublish': data.isPublished = false; break
              case 'resync':
                data.syncStatus = 'PENDING'
                data.lastSyncStatus = 'PENDING'
                data.syncRetryCount = 0
                data.lastSyncError = null
                break
              case 'set-price': {
                data.price = Number(body.payload?.price)
                data.followMasterPrice = false
                break
              }
              case 'follow-master':
                data.followMasterTitle = true
                data.followMasterDescription = true
                data.followMasterPrice = true
                data.followMasterQuantity = true
                data.followMasterImages = true
                data.followMasterBulletPoints = true
                break
              case 'unfollow-master':
                data.followMasterTitle = false
                data.followMasterDescription = false
                data.followMasterPrice = false
                data.followMasterQuantity = false
                data.followMasterImages = false
                data.followMasterBulletPoints = false
                break
              case 'set-pricing-rule': {
                const rule = String(body.payload?.pricingRule ?? '').toUpperCase()
                data.pricingRule = rule
                if (rule === 'PERCENT_OF_MASTER') {
                  const pct = Number(body.payload?.priceAdjustmentPercent)
                  if (Number.isFinite(pct)) data.priceAdjustmentPercent = pct
                }
                break
              }
            }
            data.version = { increment: 1 }
            await prisma.channelListing.update({ where: { id }, data })
            succeeded += 1
          } catch (err: any) {
            failed += 1
            errors.push({ listingId: id, reason: err?.message ?? String(err) })
          }

          // Flush progress to DB. Per-listing flush is fine at the
          // current scale (max 1000 items, each <10ms); revisit if real
          // volume forces batched flushing.
          const processedTotal = succeeded + failed
          await prisma.bulkActionJob
            .update({
              where: { id: jobId },
              data: {
                processedItems: succeeded,
                failedItems: failed,
                progressPercent: Math.floor((processedTotal / ids.length) * 100),
                errorLog: errors as any,
                lastError: errors.length > 0 ? errors[errors.length - 1].reason : null,
              },
            })
            .catch((e) => {
              // A flush failure shouldn't kill the worker — log and continue.
              fastify.log.warn({ err: e, jobId }, '[listings/bulk-action] progress flush failed')
            })

          // S.4 — emit per-item progress so subscribers see the bar move
          // without a polling round-trip. Also emit listing.updated for
          // the touched id so individual cells refresh in real time.
          publishListingEvent({
            type: 'bulk.progress',
            jobId,
            processed: processedTotal,
            total: ids.length,
            succeeded,
            failed,
            ts: Date.now(),
          })
          publishListingEvent({
            type: 'listing.updated',
            listingId: id,
            reason: `bulk:${action}`,
            ts: Date.now(),
          })
        }

        const finalStatus =
          failed === 0
            ? 'COMPLETED'
            : succeeded === 0
              ? 'FAILED'
              : 'PARTIALLY_COMPLETED'

        await prisma.bulkActionJob.update({
          where: { id: jobId },
          data: {
            status: finalStatus,
            completedAt: new Date(),
            progressPercent: 100,
          },
        })
        publishListingEvent({
          type: 'bulk.completed',
          jobId,
          status: finalStatus,
          ts: Date.now(),
        })
      })().catch(async (e) => {
        fastify.log.error({ err: e, jobId }, '[listings/bulk-action] worker crashed')
        await prisma.bulkActionJob
          .update({
            where: { id: jobId },
            data: {
              status: 'FAILED',
              lastError: e?.message ?? String(e),
              completedAt: new Date(),
            },
          })
          .catch(() => {})
      })

      return reply.code(202).send({ jobId, status: 'QUEUED', total: ids.length })
    } catch (error: any) {
      fastify.log.error({ err: error }, '[listings/bulk-action] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  fastify.get('/listings/bulk-action/:jobId', async (request, reply) => {
    const { jobId } = request.params as { jobId: string }
    const job = await prisma.bulkActionJob.findUnique({ where: { id: jobId } })
    if (!job || job.actionType !== LISTING_BULK_ACTION_TYPE) {
      return reply.code(404).send({ error: 'Job not found' })
    }

    // Adapt the BulkActionJob row to the legacy in-memory shape the
    // existing /listings client polls for. Keeps the frontend
    // unchanged across the H-5 migration. actionPayload is Prisma
    // JsonValue so we cast through unknown — runtime shape is enforced
    // by the writer at job creation time (this route is the only source
    // of LISTING_BULK_ACTION rows).
    const payload =
      (job.actionPayload as unknown as ListingBulkActionPayload | null) ?? {
        action: 'unknown',
        listingIds: [],
      }
    const errorLog = Array.isArray(job.errorLog) ? job.errorLog : []
    return {
      id: job.id,
      action: payload.action,
      total: job.totalItems,
      processed: job.processedItems + job.failedItems,
      succeeded: job.processedItems,
      failed: job.failedItems,
      errors: errorLog,
      status: job.status,
      createdAt: job.createdAt.getTime(),
      updatedAt: job.updatedAt.getTime(),
    }
  })
}
