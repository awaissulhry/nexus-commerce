import { assertPushAllowed } from '@nexus/shared/push-lock'
import { readPushControls } from '../services/listing-push-controls.js'
import { buildAmazonContentAttributes, type AmazonContentInput } from '../services/pim/amazon-content-payload.js'
import { CONTENT_ROOTS } from '../services/channel-drift/amazon-content-compare.js'
import { resolvePublishContent, publishContentIssues, requireReviewedContent } from '../services/pim/publish-review-gate.js'
import { configuredAmazonMarketplaceId } from '../services/categories/marketplace-ids.js'
import { marketLanguages, languageTag } from '../services/pim/market-languages.js'
import { marketCatalogueRows } from '../services/pim/market-catalogue.js'
import { PRIMARY_CONTENT_LOCALE } from '../services/pim/content-locale.js'
import { assertInformationLocale } from '../services/pim/information-locale.js'
import { getAmazonSellerId } from '../lib/amazon-sp-client.js'
import { amazonContentRefusal } from '../services/amazon/validate-before-send.js'
import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'
import { AmazonService } from '../services/marketplaces/amazon.service.js'
import { amazonMarketplaceId } from '../services/categories/marketplace-ids.js'
import { amazonSpApiClient } from '../clients/amazon-sp-api.client.js'
import { syncActivatedListings } from '../services/listing-activation-sync.service.js'
import { whereCoordinate, type ListingCoordinate } from '../lib/listing-coordinate.js'
import { writeCoordinateOffer } from '../services/market-offer-availability.service.js'
import { assertRequestPermission } from '../lib/auth/request-permission.js'
import { resolveListingCategory } from '../services/pim/mapping/category-mapping.service.js'

const amazonService = new AmazonService()

/** Build only; used by the publish route and offline payload contract tests. */
export async function buildMarketplaceAmazonAttributes(input: {
  marketplace: string; marketplaceId: string; language?: string; attributes: Record<string, unknown>;
  title?: string | null; description?: string | null; bulletPoints?: string[]; price?: unknown;
  content?: Omit<AmazonContentInput, 'marketplace' | 'marketplaceId'>;
}): Promise<Record<string, any>> {
  const languages = input.content ? [] : await marketLanguages('AMAZON', input.marketplace)
  const language = input.language ?? languages[0]
  if (!input.content) assertInformationLocale('AMAZON', language, languages)
  const tag = input.content ? undefined : languageTag(language, input.marketplace)
  const spAttrs: Record<string, unknown> = {
    ...input.attributes,
  }
  if (input.content) {
    for (const key of CONTENT_ROOTS) delete spAttrs[key]
    Object.assign(spAttrs, await buildAmazonContentAttributes({ ...input.content, marketplace: input.marketplace, marketplaceId: input.marketplaceId }))
  } else {
  if (input.title) {
    spAttrs.item_name = [{ value: input.title, marketplace_id: input.marketplaceId, language_tag: tag }]
  }
  if (input.description) {
    spAttrs.product_description = [{ value: input.description, marketplace_id: input.marketplaceId, language_tag: tag }]
  }
  if (Array.isArray(input.bulletPoints) && input.bulletPoints.length > 0) {
    spAttrs.bullet_point = input.bulletPoints.map((b: string) => ({
      value: b,
      marketplace_id: input.marketplaceId,
      language_tag: tag,
    }))
  }
  }
  if (input.price != null) {
    spAttrs.purchasable_offer = [{
      currency: 'EUR',
      our_price: [{ schedule: [{ value_with_tax: Number(input.price) }] }],
      marketplace_id: input.marketplaceId,
    }]
  }

  return spAttrs
}

/**
 * The product type the publish sends and its preflight predicts. Amazon: the ONE rule (#82) — this market's listing,
 * else the product's own listings in the region's other markets, else the category mapping, else Product.productType —
 * so a first listing here is not sent as OUTERWEAR when the product is COAT in every other market. Other channels: as before.
 */
async function publishProductType(productId: string, channel: string, marketplace: string, pa: Record<string, any>, ownType: unknown): Promise<string> {
  if (channel.toUpperCase() !== 'AMAZON') return pa.productType ?? ownType ?? ''
  return (await resolveListingCategory({ productId, channel: 'AMAZON', marketplace, platformAttributes: pa })).channelCategoryId ?? ''
}

const marketplacesRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/sidebar/counts — aggregate counters for the sidebar.
  // Single endpoint covers everything the sidebar needs so navigation
  // doesn't fan out into a dozen queries on every page load. 30s cache.
  fastify.get('/sidebar/counts', async (_request, reply) => {
    try {
      reply.header('Cache-Control', 'private, max-age=30')

      const [
        totalProducts,
        pimPending,
        totalListings,
        listingsByChannel,
        pendingOrders,
        syncIssues,
        connectedChannels,
        inboxCritical,
        inboxWarn,
      ] = await Promise.all([
        prisma.product.count({ where: { parentId: null } }),
        prisma.product.count({ where: { reviewStatus: 'PENDING_REVIEW' } }),
        prisma.channelListing.count(),
        prisma.channelListing.groupBy({
          by: ['channel', 'marketplace'],
          _count: { _all: true },
        }),
        // Order table is empty in dev; wrap in try/catch so a missing
        // table or schema mismatch doesn't break the whole sidebar.
        prisma.order
          .count({ where: { status: 'PENDING' } })
          .catch(() => 0),
        prisma.channelListing.count({ where: { lastSyncStatus: 'FAILED' } }),
        prisma.marketplace.count({ where: { isActive: true } }),
        // P5.4 — inbox critical count (dead syncs + critical alert events)
        Promise.all([
          (prisma.outboundSyncQueue as any).count({ where: { isDead: true } }).catch(() => 0),
          prisma.alertEvent.count({ where: { status: 'TRIGGERED', rule: { metric: { in: ['errorRate', 'latencyP95'] } } } }).catch(() => 0),
        ]).then(([s, a]: [number, number]) => s + a),
        // warn count
        Promise.all([
          (prisma.outboundSyncQueue as any).count({ where: { syncStatus: 'FAILED', retryCount: { gt: 0 }, isDead: false } }).catch(() => 0),
          prisma.alertEvent.count({ where: { status: 'TRIGGERED', rule: { metric: { notIn: ['errorRate', 'latencyP95'] } } } }).catch(() => 0),
          prisma.webhookEvent.count({ where: { isProcessed: false, error: { not: null } } }).catch(() => 0),
        ]).then(([s, a, w]: [number, number, number]) => s + a + w),
      ])

      // Group listings by channel + per-marketplace breakdown
      const channelCounts: Record<
        string,
        { total: number; markets: Record<string, number> }
      > = {}
      for (const row of listingsByChannel) {
        const ch = row.channel as string
        const mp = row.marketplace as string
        const cnt = (row._count as any)._all ?? 0
        if (!channelCounts[ch]) channelCounts[ch] = { total: 0, markets: {} }
        channelCounts[ch].total += cnt
        channelCounts[ch].markets[mp] = cnt
      }

      return {
        catalog: { products: totalProducts, pimPending },
        listings: { total: totalListings, byChannel: channelCounts },
        operations: { pendingOrders },
        monitoring: { syncIssues },
        system: { connectedChannels },
        inbox: { critical: inboxCritical, warn: inboxWarn, total: inboxCritical + inboxWarn },
      }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[sidebar/counts] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // POST /api/marketplaces/seed — adds the catalogue markets this business lacks (A-53).
  // CREATE-ONLY: a market the business already has is never rewritten — its name, ids, VAT and languages
  // may be the business's own. It used to `upsert … update` 17 rows with no VAT.
  fastify.post('/marketplaces/seed', async (_request, reply) => {
    try {
      const { count: created } = await prisma.marketplace.createMany({ data: marketCatalogueRows(), skipDuplicates: true })
      const total = await prisma.marketplace.count()
      return { success: true, created, total }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[marketplaces/seed] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // GET /api/listings/all — flat list of every channel listing, enriched
  // with the parent product's sku/name/asin and the marketplace's
  // currency (no FK between ChannelListing and Marketplace, so we join
  // in JS). Capped at 200 rows for the cross-channel table view.
  fastify.get('/listings/all', async (_request, reply) => {
    try {
      const [listings, marketplaces] = await Promise.all([
        prisma.channelListing.findMany({
          include: {
            product: {
              select: { id: true, sku: true, name: true, amazonAsin: true },
            },
          },
          orderBy: [
            { channel: 'asc' },
            { marketplace: 'asc' },
            { updatedAt: 'desc' },
          ],
          take: 200,
        }),
        prisma.marketplace.findMany({
          select: { channel: true, code: true, currency: true, language: true, languages: true },
        }),
      ])

      const mpKey = (channel: string, code: string) => `${channel}_${code}`
      const meta = new Map(
        marketplaces.map((m) => [
          mpKey(m.channel, m.code),
          { currency: m.currency, language: marketLanguages(m.channel, m.code, [m])[0], languages: marketLanguages(m.channel, m.code, [m]) },
        ])
      )

      const enriched = listings.map((l) => {
        const m = meta.get(mpKey(l.channel, l.marketplace))
        return {
          ...l,
          // Coerce Decimal fields to numbers for JSON safety
          price: l.price == null ? null : Number(l.price),
          salePrice: l.salePrice == null ? null : Number(l.salePrice),
          currency: m?.currency ?? null,
          language: m?.language ?? null,
          languages: m?.languages ?? [],
        }
      })

      return { listings: enriched }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[listings/all] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // GET /api/marketplaces?channel=AMAZON — flat list, optional channel filter
  fastify.get('/marketplaces', async (request, reply) => {
    try {
      const { channel } = request.query as { channel?: string }
      const marketplaces = await prisma.marketplace.findMany({
        where: { isActive: true, ...(channel ? { channel } : {}) },
        orderBy: [{ channel: 'asc' }, { code: 'asc' }],
      })
      return marketplaces
    } catch (error: any) {
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // GET /api/marketplaces/grouped — { AMAZON: [...], EBAY: [...], ... }
  fastify.get('/marketplaces/grouped', async (_request, reply) => {
    try {
      const marketplaces = await prisma.marketplace.findMany({
        where: { isActive: true },
        orderBy: [{ channel: 'asc' }, { code: 'asc' }],
      })
      const grouped = marketplaces.reduce(
        (acc, mp) => {
          ;(acc[mp.channel] ??= []).push({ ...mp, languages: marketLanguages(mp.channel, mp.code, marketplaces) })
          return acc
        },
        {} as Record<string, typeof marketplaces>
      )
      return { ...grouped, _meta: { primaryLanguage: PRIMARY_CONTENT_LOCALE } }
    } catch (error: any) {
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // GET /api/products/:id/all-listings — every channel/marketplace listing for a product
  fastify.get<{ Params: { id: string } }>(
    '/products/:id/all-listings',
    { preHandler: request => assertRequestPermission(request, 'products.view') },
    async (request, reply) => {
      try {
        const { id } = request.params
        const listings = await prisma.channelListing.findMany({
          where: { productId: id },
          orderBy: [{ channel: 'asc' }, { marketplace: 'asc' }],
          // PERF — drop two large JSON columns the edit page never reads
          // (flatFileSnapshot = verbatim Amazon row, overrideData = raw
          // override bag; both verified 0 references in apps/web). Trims
          // payload without a whitelist `select` that could starve a tab
          // of a field it needs (platformAttributes / bulletPointsOverride
          // ARE consumed, so they stay).
          omit: { flatFileSnapshot: true, overrideData: true },
        })
        const grouped = listings.reduce(
          (acc, l) => {
            ;(acc[l.channel] ??= []).push(l)
            return acc
          },
          {} as Record<string, typeof listings>
        )
        return grouped
      } catch (error: any) {
        return reply.code(500).send({ error: error?.message ?? String(error) })
      }
    }
  )

  // MA.1 — PATCH /api/products/:id/offer-availability
  // Toggle offerActive per (channel, marketplace) for a single product.
  // Body: { markets: Array<Omit<ListingCoordinate, 'productId'> & { offerActive: boolean }> }
  // Auto-creates ChannelListing rows that don't exist yet (with offerActive set).
  fastify.patch<{
    Params: { id: string }
    Body: { markets: Array<Omit<ListingCoordinate, 'productId'> & { offerActive: boolean }> }
  }>(
    '/products/:id/offer-availability',
    async (request, reply) => {
      try {
        const { id } = request.params
        const { markets } = request.body ?? {}
        if (!Array.isArray(markets) || markets.length === 0) {
          return reply.code(400).send({ error: 'markets array is required' })
        }
        const targets = markets.map(m => ({ ...m, productId: id }))
        targets.forEach(whereCoordinate)
        const results = await Promise.all(targets.map(t => writeCoordinateOffer(t, t.offerActive)))
        // Sync inventory immediately for any listing just turned active
        const activatedIds = results.filter((r) => r.offerActive).map((r) => r.id)
        if (activatedIds.length > 0) void syncActivatedListings(activatedIds)
        return { ok: true, updated: results }
      } catch (error: any) {
        return reply.code(500).send({ error: error?.message ?? String(error) })
      }
    }
  )

  // IS.2b — PATCH /api/products/:id/auto-publish-content
  // Toggle the per-listing auto-publish flag for content changes (title,
  // description, images). Stored as platformAttributes._autoPublishContent.
  // Default=false — operator opts in per listing. Once enabled, any save
  // of content fields on that listing enqueues an OFFER_SYNC automatically.
  fastify.patch<{
    Params: { id: string }
    Body: { markets: Array<{ channel: string; marketplace: string; enabled: boolean }> }
  }>(
    '/products/:id/auto-publish-content',
    async (request, reply) => {
      const { id } = request.params
      const { markets } = request.body ?? {}
      if (!Array.isArray(markets) || markets.length === 0) {
        return reply.code(400).send({ error: 'markets array required' })
      }
      try {
        const results = await Promise.all(
          markets.map(async ({ channel, marketplace, enabled }) => {
            const listing = await prisma.channelListing.findFirst({
              where: { productId: id, channel, marketplace },
              select: { id: true, platformAttributes: true },
            })
            if (!listing) return { channel, marketplace, updated: false }
            const attrs = (listing.platformAttributes as Record<string, unknown> | null) ?? {}
            await prisma.channelListing.update({
              where: { id: listing.id },
              data: { platformAttributes: { ...attrs, _autoPublishContent: enabled } },
            })
            return { channel, marketplace, updated: true, autoPublishContent: enabled }
          })
        )
        return reply.send({ ok: true, results })
      } catch (err: any) {
        return reply.code(500).send({ error: err?.message ?? String(err) })
      }
    }
  )

  // MA.1 — POST /api/products/bulk-offer-availability
  // Toggle offerActive across many products × many markets in one shot.
  // Body: { productIds: string[]; markets: Array<Omit<ListingCoordinate, 'productId'>>; offerActive: boolean }
  fastify.post<{
    Body: { productIds: string[]; markets: Array<Omit<ListingCoordinate, 'productId'>>; offerActive: boolean }
  }>(
    '/products/bulk-offer-availability',
    async (request, reply) => {
      try {
        const { productIds, markets, offerActive } = request.body ?? {}
        if (!Array.isArray(productIds) || productIds.length === 0) {
          return reply.code(400).send({ error: 'productIds is required' })
        }
        if (!Array.isArray(markets) || markets.length === 0) {
          return reply.code(400).send({ error: 'markets array is required' })
        }
        if (typeof offerActive !== 'boolean') {
          return reply.code(400).send({ error: 'offerActive must be a boolean' })
        }
        const pairs: ListingCoordinate[] = productIds.flatMap(productId => markets.map(m => ({ ...m, productId })))
        pairs.forEach(whereCoordinate)
        const changedIds: string[] = []
        for (let i = 0; i < pairs.length; i += 50) {
          const results = await Promise.all(pairs.slice(i, i + 50).map(c => writeCoordinateOffer(c, offerActive)))
          changedIds.push(...results.map(r => r.id))
        }
        const upserted = changedIds.length
        if (offerActive && changedIds.length) void syncActivatedListings(changedIds)
        return { ok: true, upserted, offerActive }
      } catch (error: any) {
        return reply.code(500).send({ error: error?.message ?? String(error) })
      }
    }
  )

  // GET /api/products/:id/listings/:channel/:marketplace
  fastify.get<{
    Params: { id: string; channel: string; marketplace: string }
  }>(
    '/products/:id/listings/:channel/:marketplace',
    async (request, reply) => {
      try {
        const { id, channel, marketplace } = request.params
        const listing = await prisma.channelListing.findFirst({
          where: { productId: id, channel, marketplace },
        })
        if (!listing) {
          return reply
            .code(404)
            .send({ error: 'Listing not found', productId: id, channel, marketplace })
        }
        return listing
      } catch (error: any) {
        return reply.code(500).send({ error: error?.message ?? String(error) })
      }
    }
  )

  // GET /api/products/:id/listings/AMAZON/:marketplace/detect-type
  // GET /api/products/:id/listings/AMAZON/:marketplace/detect-type
  //
  // Returns { productType, variationTheme, browseNodes, categoryPath, asin, title, source }.
  // ASIN path uses searchCatalogItems (public catalog, works for any ASIN including
  // competitors) — fixes "Access denied" that getCatalogItem returned for ASINs the
  // seller doesn't own.
  fastify.get<{
    Params: { id: string; channel: string; marketplace: string }
    Querystring: { sku?: string; asin?: string }
  }>(
    '/products/:id/listings/:channel/:marketplace/detect-type',
    async (request, reply) => {
      const { id, channel, marketplace } = request.params
      const { sku: qSku, asin: qAsin } = request.query

      if (channel.toUpperCase() !== 'AMAZON') {
        return reply.code(400).send({ error: 'detect-type is only supported for AMAZON' })
      }
      if (!(await amazonService.isConfigured())) {
        return reply.code(503).send({ error: 'Amazon SP-API not configured' })
      }

      const mpId = amazonMarketplaceId(marketplace)

      // ASIN path — competitor or reference listing (searchCatalogItems, no seller auth needed)
      if (qAsin) {
        try {
          const result = await amazonService.detectProductTypeFromAsin(qAsin, mpId)
          return reply.send({ ...result, source: 'catalog_search', asin: qAsin })
        } catch (err: any) {
          return reply.code(500).send({ error: err?.message ?? String(err) })
        }
      }

      // SKU path — own listing via getListingsItem
      let sku = qSku
      if (!sku) {
        const product = await prisma.product.findUnique({ where: { id }, select: { sku: true } })
        if (!product?.sku) return reply.code(404).send({ error: 'Product not found or has no SKU' })
        sku = product.sku
      }

      try {
        const result = await amazonService.detectProductTypeFromSku(sku, mpId)
        return reply.send({ ...result, source: 'listings_api', sku })
      } catch (err: any) {
        // Fall back to first child variation if master SKU isn't on this marketplace
        try {
          const firstVariation = await prisma.productVariation.findFirst({
            where: { productId: id },
            select: { sku: true },
            orderBy: { createdAt: 'asc' },
          })
          if (firstVariation?.sku && firstVariation.sku !== sku) {
            const result = await amazonService.detectProductTypeFromSku(firstVariation.sku, mpId)
            return reply.send({ ...result, source: 'listings_api', sku: firstVariation.sku })
          }
        } catch { /* ignore */ }
        return reply.code(500).send({ error: err?.message ?? String(err) })
      }
    }
  )

  // GET /api/products/:id/ebay-sibling-categories
  //
  // Returns all OTHER eBay marketplaces where this product already has a valid
  // numeric eBay category ID set. Used by the "Copy category from market" UI
  // in ListingSetupCard so operators don't have to re-select the same category
  // on every eBay marketplace.
  fastify.get<{ Params: { id: string } }>(
    '/products/:id/ebay-sibling-categories',
    async (request, reply) => {
      const { id } = request.params
      const listings = await prisma.channelListing.findMany({
        where: { productId: id, channel: 'EBAY' },
        select: { marketplace: true, platformAttributes: true },
      })

      const siblings = listings
        .map((l) => {
          const pa = l.platformAttributes as Record<string, any> | null
          const pt = pa?.productType
          return {
            marketplace: l.marketplace,
            categoryId: typeof pt === 'string' && /^\d+$/.test(pt.trim()) ? pt : null,
          }
        })
        .filter((s) => s.categoryId !== null)

      return reply.send({ siblings })
    }
  )

  // POST /api/products/:id/listings/:channel/:marketplace/publish
  //
  // Validates required fields, pushes to Amazon (SP-API), then sets
  // isPublished=true and listingStatus='ACTIVE' when Amazon took it.
  // Amazon only: step 7, part 3 deleted the branch that marked an eBay or
  // Shopify listing ACTIVE + published (creating the row if missing) without
  // calling the channel. Any other channel, or Amazon not connected, is refused.
  //
  // Returns { ok, status, message, issues? }
  fastify.post<{
    Params: { id: string; channel: string; marketplace: string }
    Body: { language?: string }
  }>(
    '/products/:id/listings/:channel/:marketplace/publish',
    async (request, reply) => {
      const { id, channel, marketplace } = request.params

      try {
        const [product, listing] = await Promise.all([
          prisma.product.findUnique({ where: { id }, include: { translations: true, parent: { include: { translations: true } } } }),
          prisma.channelListing.findFirst({ where: { productId: id, channel, marketplace }, include: { translations: true } }),
        ])
        if (!product) return reply.code(404).send({ error: `Product ${id} not found` })

        const pushControls = await readPushControls({ channel, productIds: [id], allowAbsent: true })
        for (const current of pushControls) {
          const refusal = assertPushAllowed(current)
          if (refusal) return reply.code(409).send({ ok: false, status: 'REFUSED', message: refusal.sentence, refusal })
        }

        // Resolve values: listing override first, fall back to master product
        const resolvedTitle = listing?.title ?? product.name
        const resolvedPrice = listing?.price ?? (product as any).basePrice ?? null
        const pa = (listing?.platformAttributes as Record<string, any> | null) ?? {}
        const resolvedProductType = await publishProductType(id, channel, marketplace, pa, (product as any).productType)

        const content = await resolvePublishContent({ product: product as any, parent: product.parent as any, listing, marketplace, channel })
        const issues: { message: string; severity: 'ERROR' | 'WARNING' }[] = publishContentIssues(content)
        if (!resolvedTitle || String(resolvedTitle).trim().length === 0) {
          issues.push({ message: 'Title is required', severity: 'ERROR' })
        }
        if (resolvedPrice == null || Number(resolvedPrice) <= 0) {
          issues.push({ message: 'Price is required and must be positive', severity: 'ERROR' })
        }
        if (!resolvedProductType || String(resolvedProductType).trim().length === 0) {
          issues.push({ message: 'Product type is required', severity: 'ERROR' })
        }

        const errors = issues.filter((i) => i.severity === 'ERROR')
        if (errors.length > 0) {
          return reply.code(422).send({
            ok: false,
            status: 'INVALID',
            message: errors.map((e) => e.message).join('; '),
            issues,
          })
        }

        let responsePayload: {
          ok: boolean
          status: string
          message: string
          issues?: { message: string; severity: string }[]
        }

        if (channel.toUpperCase() === 'AMAZON' && (await amazonService.isConfigured())) {
          const mpId = await configuredAmazonMarketplaceId(marketplace)

          if (!mpId) {
            return reply.code(400).send({ error: `No marketplaceId for AMAZON/${marketplace}` })
          }

          const sku = product.sku
          if (!sku) return reply.code(400).send({ error: 'Product has no SKU — cannot publish to Amazon' })

          const attrs = typeof pa.attributes === 'object' && pa.attributes
            ? (pa.attributes as Record<string, unknown>)
            : {}

          const spAttrs = await buildMarketplaceAmazonAttributes({ marketplace, marketplaceId: mpId,
            language: request.body?.language, attributes: attrs, title: resolvedTitle,
            description: listing?.description, bulletPoints: listing?.bulletPointsOverride, price: resolvedPrice,
            content: { product: product as any, parent: product.parent as any, listing } })

          const sellerId = (await getAmazonSellerId())
          // P1.7 — Amazon's own dry run first; a full PUT replaces the listing's content.
          const previewRefusal = await amazonContentRefusal({
            sellerId, sku, marketplaceId: mpId, productType: resolvedProductType, attributes: spAttrs,
          })
          if (previewRefusal) {
            return reply.send({ ok: false, published: false, error: previewRefusal })
          }
          const spResult = await amazonSpApiClient.putListingsItem({
            sellerId,
            sku,
            marketplaceId: mpId,
            productType: resolvedProductType,
            attributes: spAttrs,
          })

          if (!spResult.success) {
            return reply.send({
              ok: false,
              status: spResult.status ?? 'FAILED',
              message: spResult.error ?? 'Amazon rejected the listing',
              issues: spResult.issues?.map((i: any) => ({ message: i.message ?? String(i), severity: 'ERROR' })),
            })
          }

          // Mark as published + sync inventory — only when Amazon really got it.
          // P0.1: a dry run sent nothing, so the listing stays as it was.
          if (!spResult.dryRun) {
            await prisma.channelListing.updateMany({
              where: { productId: id, channel, marketplace },
              data: { isPublished: true, listingStatus: 'ACTIVE', lastSyncedAt: new Date() },
            })
            const publishedListing = await prisma.channelListing.findFirst({
              where: { productId: id, channel, marketplace },
              select: { id: true },
            })
            if (publishedListing) void syncActivatedListings([publishedListing.id])
          }

          responsePayload = {
            ok: true,
            status: spResult.dryRun ? 'DRY_RUN' : (spResult.status ?? 'SUBMITTED'),
            message: spResult.dryRun
              ? 'Dry-run: listing payload accepted (no live push). Set AMAZON_PUBLISH_MODE=live to publish for real.'
              : `Submitted to Amazon. Submission ID: ${spResult.submissionId ?? 'n/a'}`,
            issues: spResult.warnings?.map((w) => ({ message: w.message, severity: w.severity })),
          }
        } else {
          return reply.code(400).send({
            ok: false,
            status: 'UNSUPPORTED',
            message: channel.toUpperCase() === 'AMAZON'
              ? 'Amazon is not connected, so nothing was published.'
              : `This route publishes to Amazon only; nothing was sent to ${channel}.`,
          })
        }

        return reply.send(responsePayload)
      } catch (error: any) {
        fastify.log.error({ err: error }, '[products/listings/publish] failed')
        return reply.code(500).send({ ok: false, status: 'ERROR', message: error?.message ?? String(error) })
      }
    }
  )

  // OL.B.1 — POST /api/products/:id/publish-preflight
  // Read-only "what would happen if I publish these coordinates now".
  // Mirrors the resolve + validate logic of the publish route above (no
  // writes, no SP-API call) so the Listing Hub can show a combined review
  // before a one-action multi-channel publish.
  //   Body: { coordinates: Array<{ channel: string; marketplace: string }> }
  // Per coordinate returns: status ('ready'|'blocked'), issues[], the
  // resolved title/price/productType that would be sent, and the effective
  // `action`: AMAZON goes through SP-API (live or dry-run per env); any other
  // channel is 'unsupported' and blocked, because the publish route refuses it
  // (step 7, part 3 — it used to mark eBay/Shopify active without calling them).
  fastify.post<{
    Params: { id: string }
    Body: { coordinates?: Array<{ channel: string; marketplace: string }> }
  }>(
    '/products/:id/publish-preflight',
    async (request, reply) => {
      const { id } = request.params
      const coordinates = Array.isArray(request.body?.coordinates) ? request.body!.coordinates : []
      if (coordinates.length === 0) {
        return reply.code(400).send({ error: 'coordinates array is required' })
      }
      try {
        const product = await prisma.product.findUnique({ where: { id }, include: { translations: true, parent: { include: { translations: true } } } })
        if (!product) return reply.code(404).send({ error: `Product ${id} not found` })

        const listings = await prisma.channelListing.findMany({
          where: { productId: id },
          include: { translations: true },
        })
        const byCoord = new Map(listings.map((l) => [`${l.channel}:${l.marketplace}`, l]))
        const amazonConfigured = (await amazonService.isConfigured())
        // Amazon dry-run is env-gated (AMAZON_PUBLISH_MODE). Anything other
        // than an explicit 'live' is a dry-run — same default the SP-API
        // client applies — so the review can label it without guessing.
        const amazonDryRun = (process.env.AMAZON_PUBLISH_MODE ?? '').toLowerCase() !== 'live'

        const results = await Promise.all(coordinates.map(async ({ channel, marketplace }) => {
          const listing = byCoord.get(`${channel}:${marketplace}`)
          const pa = (listing?.platformAttributes as Record<string, any> | null) ?? {}
          const resolvedTitle = listing?.title ?? product.name
          const resolvedPrice = listing?.price ?? (product as any).basePrice ?? null
          const resolvedProductType = await publishProductType(id, channel, marketplace, pa, (product as any).productType)

          const content = await resolvePublishContent({ product: product as any, parent: product.parent as any, listing, marketplace, channel })
          const issues: { message: string; severity: 'ERROR' | 'WARNING' }[] = publishContentIssues(content)
          if (!resolvedTitle || String(resolvedTitle).trim().length === 0) {
            issues.push({ message: 'Title is required', severity: 'ERROR' })
          }
          if (resolvedPrice == null || Number(resolvedPrice) <= 0) {
            issues.push({ message: 'Price is required and must be positive', severity: 'ERROR' })
          }
          if (channel.toUpperCase() === 'AMAZON' && (!resolvedProductType || String(resolvedProductType).trim().length === 0)) {
            issues.push({ message: 'Product type is required', severity: 'ERROR' })
          }

          const isAmazon = channel.toUpperCase() === 'AMAZON'
          // A-53: the SAME lookup the publish route makes (`configuredAmazonMarketplaceId`, the business's own
          // Marketplace row), so the preflight predicts the publish. It read a static 17-row list, which said
          // "mapped" for a business with no market rows and "not mapped" for Amazon BE/IE/TR that it has.
          const hasMpId = isAmazon && Boolean(await configuredAmazonMarketplaceId(marketplace))
          if (isAmazon && !hasMpId) {
            issues.push({ message: `No marketplace mapping for ${channel}/${marketplace}`, severity: 'ERROR' })
          }
          if (isAmazon && !product.sku) {
            issues.push({ message: 'Product has no SKU — cannot publish to Amazon', severity: 'ERROR' })
          }
          if (isAmazon && !amazonConfigured) {
            issues.push({ message: 'Amazon is not connected, so nothing would be published', severity: 'ERROR' })
          }
          if (!isAmazon) {
            issues.push({ message: `This route publishes to Amazon only; nothing would be sent to ${channel}`, severity: 'ERROR' })
          }

          const blocked = issues.some((i) => i.severity === 'ERROR')
          const action = isAmazon
            ? (amazonConfigured ? (amazonDryRun ? 'amazon-dry-run' : 'amazon-live') : 'amazon-unconfigured')
            : 'unsupported'

          return {
            channel,
            marketplace,
            status: blocked ? 'blocked' : 'ready',
            action,
            issues,
            resolved: {
              title: resolvedTitle ?? null,
              price: resolvedPrice == null ? null : Number(resolvedPrice),
              productType: resolvedProductType || null,
              hasDescription: Boolean(listing?.description),
              quantity: listing?.quantity ?? null,
            },
            listed: Boolean(listing),
            languages: content.map(row => row.language), requireReviewed: requireReviewedContent(),
          }
        }))

        return reply.send({
          productId: id,
          amazonConfigured,
          amazonDryRun,
          coordinates: results,
        })
      } catch (error: any) {
        fastify.log.error({ err: error }, '[products/publish-preflight] failed')
        return reply.code(500).send({ error: error?.message ?? String(error) })
      }
    }
  )
}

export default marketplacesRoutes
