import type { FastifyInstance } from 'fastify'
import prisma from '../db.js'
import { randomUUID } from 'node:crypto'

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
type BulkJob = {
  id: string
  action: string
  channel?: string
  marketplace?: string
  total: number
  processed: number
  succeeded: number
  failed: number
  errors: Array<{ listingId: string; reason: string }>
  status: 'QUEUED' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED'
  createdAt: number
  updatedAt: number
}
const BULK_JOBS = new Map<string, BulkJob>()

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

      const [total, listings, marketplacesMeta] = await Promise.all([
        prisma.channelListing.count({ where }),
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
  // ─────────────────────────────────────────────────────────────────
  fastify.get('/listings/facets', async (_request, reply) => {
    try {
      const [byChannel, byMarketplace, byStatus, bySyncStatus, errorCount, total] = await Promise.all([
        prisma.channelListing.groupBy({ by: ['channel'], _count: true }),
        prisma.channelListing.groupBy({ by: ['channel', 'marketplace'], _count: true }),
        prisma.channelListing.groupBy({ by: ['listingStatus'], _count: true }),
        prisma.channelListing.groupBy({ by: ['syncStatus'], _count: true }),
        prisma.channelListing.count({ where: { OR: [{ listingStatus: 'ERROR' }, { lastSyncStatus: 'FAILED' }, { syncStatus: 'FAILED' }] } }),
        prisma.channelListing.count(),
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

      const [errorRows, suppressedRows, draftRows, failedSyncRows, pendingSyncRows] = await Promise.all([
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

      return {
        errorCount: errorRows.length,
        suppressedCount: suppressedRows,
        draftCount: draftRows,
        failedSyncCount: failedSyncRows,
        pendingSyncCount: pendingSyncRows,
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
  // ─────────────────────────────────────────────────────────────────
  fastify.get('/listings/matrix', async (request, reply) => {
    try {
      const q = request.query as Record<string, string | undefined>
      const productIds = csvParam(q.productIds)
      const channels = csvParam(q.channels)
      const limit = Math.min(500, Math.max(1, Math.floor(safeNum(q.limit) ?? 100)))

      // Resolve which products to include: explicit list, otherwise the N most recently updated
      let products: Array<{ id: string; sku: string; name: string; basePrice: any; totalStock: number; isParent: boolean }>
      if (productIds && productIds.length > 0) {
        products = await prisma.product.findMany({
          where: { id: { in: productIds } },
          select: { id: true, sku: true, name: true, basePrice: true, totalStock: true, isParent: true },
        })
      } else {
        products = await prisma.product.findMany({
          where: { isParent: false },
          orderBy: { updatedAt: 'desc' },
          take: limit,
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
          price: true, quantity: true, externalListingId: true, isPublished: true,
        },
      })

      // Build a per-product map of cells keyed by `${channel}:${marketplace}`
      const byProduct = new Map<string, Array<any>>()
      for (const l of listings) {
        const arr = byProduct.get(l.productId) ?? []
        arr.push({
          id: l.id,
          channel: l.channel,
          marketplace: l.marketplace,
          listingStatus: l.listingStatus,
          syncStatus: l.syncStatus,
          lastSyncStatus: l.lastSyncStatus,
          price: l.price == null ? null : Number(l.price),
          quantity: l.quantity,
          externalListingId: l.externalListingId,
          isPublished: l.isPublished,
          listingUrl: listingUrlFor(l.channel, l.marketplace, l.externalListingId),
        })
        byProduct.set(l.productId, arr)
      }

      return {
        products: products.map((p) => ({
          id: p.id,
          sku: p.sku,
          name: p.name,
          basePrice: p.basePrice == null ? null : Number(p.basePrice),
          totalStock: p.totalStock,
          isParent: p.isParent,
          cells: byProduct.get(p.id) ?? [],
        })),
        count: products.length,
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
        createdAt: l.createdAt,
        updatedAt: l.updatedAt,
      }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[listings/:id] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // ─────────────────────────────────────────────────────────────────
  // POST /api/listings/:id/resync — mark for re-pull from channel
  // The actual fetch happens via the channel's sync service; here we
  // flip the listing into PENDING + reset the retry counter so the
  // next worker tick picks it up.
  // ─────────────────────────────────────────────────────────────────
  fastify.post('/listings/:id/resync', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const existing = await prisma.channelListing.findUnique({ where: { id }, select: { id: true, version: true } })
      if (!existing) return reply.code(404).send({ error: 'Listing not found' })

      const updated = await prisma.channelListing.update({
        where: { id },
        data: {
          syncStatus: 'PENDING',
          lastSyncStatus: 'PENDING',
          syncRetryCount: 0,
          lastSyncError: null,
          version: { increment: 1 },
        },
        select: { id: true, syncStatus: true, lastSyncStatus: true, version: true },
      })
      return { ok: true, listing: updated }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[listings/:id/resync] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
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

      const jobId = randomUUID()
      const job: BulkJob = {
        id: jobId,
        action,
        total: ids.length,
        processed: 0,
        succeeded: 0,
        failed: 0,
        errors: [],
        status: 'QUEUED',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      BULK_JOBS.set(jobId, job)

      // Run async — do not block the response
      ;(async () => {
        job.status = 'IN_PROGRESS'
        job.updatedAt = Date.now()
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
                const p = Number(body.payload?.price)
                if (!Number.isFinite(p) || p < 0) throw new Error('payload.price must be a non-negative number')
                data.price = p
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
                if (!['FIXED', 'MATCH_AMAZON', 'PERCENT_OF_MASTER'].includes(rule)) {
                  throw new Error('payload.pricingRule must be FIXED|MATCH_AMAZON|PERCENT_OF_MASTER')
                }
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
            job.succeeded += 1
          } catch (err: any) {
            job.failed += 1
            job.errors.push({ listingId: id, reason: err?.message ?? String(err) })
          }
          job.processed += 1
          job.updatedAt = Date.now()
        }
        job.status = job.failed === 0 ? 'COMPLETED' : (job.succeeded === 0 ? 'FAILED' : 'COMPLETED')
        job.updatedAt = Date.now()
      })().catch((e) => {
        fastify.log.error({ err: e }, '[listings/bulk-action] worker crashed')
        job.status = 'FAILED'
      })

      return reply.code(202).send({ jobId, status: 'QUEUED', total: ids.length })
    } catch (error: any) {
      fastify.log.error({ err: error }, '[listings/bulk-action] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  fastify.get('/listings/bulk-action/:jobId', async (request, reply) => {
    const { jobId } = request.params as { jobId: string }
    const job = BULK_JOBS.get(jobId)
    if (!job) return reply.code(404).send({ error: 'Job not found' })
    return job
  })
}
