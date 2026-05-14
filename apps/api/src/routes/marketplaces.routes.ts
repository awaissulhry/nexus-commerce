import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'
import { AmazonService } from '../services/marketplaces/amazon.service.js'
import { amazonMarketplaceId } from '../services/categories/marketplace-ids.js'
import { amazonSpApiClient } from '../clients/amazon-sp-api.client.js'
import { syncActivatedListings } from '../services/listing-activation-sync.service.js'

const amazonService = new AmazonService()

const MARKETPLACES = [
  // Amazon EU
  { channel: 'AMAZON', code: 'IT', name: 'Amazon Italy',       marketplaceId: 'APJ6JRA9NG5V4', region: 'EU', currency: 'EUR', language: 'it', domainUrl: 'amazon.it' },
  { channel: 'AMAZON', code: 'DE', name: 'Amazon Germany',     marketplaceId: 'A1PA6795UKMFR9', region: 'EU', currency: 'EUR', language: 'de', domainUrl: 'amazon.de' },
  { channel: 'AMAZON', code: 'FR', name: 'Amazon France',      marketplaceId: 'A13V1IB3VIYZZH', region: 'EU', currency: 'EUR', language: 'fr', domainUrl: 'amazon.fr' },
  { channel: 'AMAZON', code: 'ES', name: 'Amazon Spain',       marketplaceId: 'A1RKKUPIHCS9HS', region: 'EU', currency: 'EUR', language: 'es', domainUrl: 'amazon.es' },
  { channel: 'AMAZON', code: 'UK', name: 'Amazon UK',          marketplaceId: 'A1F83G8C2ARO7P', region: 'EU', currency: 'GBP', language: 'en', domainUrl: 'amazon.co.uk' },
  { channel: 'AMAZON', code: 'NL', name: 'Amazon Netherlands', marketplaceId: 'A1805IZSGTT6HS', region: 'EU', currency: 'EUR', language: 'nl', domainUrl: 'amazon.nl' },
  { channel: 'AMAZON', code: 'SE', name: 'Amazon Sweden',      marketplaceId: 'A2NODRKZP88ZB9', region: 'EU', currency: 'SEK', language: 'sv', domainUrl: 'amazon.se' },
  { channel: 'AMAZON', code: 'PL', name: 'Amazon Poland',      marketplaceId: 'A1C3SOZRARQ6R3', region: 'EU', currency: 'PLN', language: 'pl', domainUrl: 'amazon.pl' },
  { channel: 'AMAZON', code: 'US', name: 'Amazon US',          marketplaceId: 'ATVPDKIKX0DER',  region: 'NA', currency: 'USD', language: 'en', domainUrl: 'amazon.com' },
  // eBay
  { channel: 'EBAY', code: 'IT', name: 'eBay Italy',   marketplaceId: 'EBAY_IT', region: 'EU', currency: 'EUR', language: 'it', domainUrl: 'ebay.it' },
  { channel: 'EBAY', code: 'DE', name: 'eBay Germany', marketplaceId: 'EBAY_DE', region: 'EU', currency: 'EUR', language: 'de', domainUrl: 'ebay.de' },
  { channel: 'EBAY', code: 'FR', name: 'eBay France',  marketplaceId: 'EBAY_FR', region: 'EU', currency: 'EUR', language: 'fr', domainUrl: 'ebay.fr' },
  { channel: 'EBAY', code: 'ES', name: 'eBay Spain',   marketplaceId: 'EBAY_ES', region: 'EU', currency: 'EUR', language: 'es', domainUrl: 'ebay.es' },
  { channel: 'EBAY', code: 'UK', name: 'eBay UK',      marketplaceId: 'EBAY_GB', region: 'EU', currency: 'GBP', language: 'en', domainUrl: 'ebay.co.uk' },
  // Single-store
  { channel: 'SHOPIFY',     code: 'GLOBAL', name: 'Shopify Store',     region: 'GLOBAL', currency: 'EUR', language: 'en' },
  { channel: 'WOOCOMMERCE', code: 'GLOBAL', name: 'WooCommerce Store', region: 'GLOBAL', currency: 'EUR', language: 'en' },
  { channel: 'ETSY',        code: 'GLOBAL', name: 'Etsy Shop',         region: 'GLOBAL', currency: 'EUR', language: 'en' },
] as const

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
      }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[sidebar/counts] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // POST /api/marketplaces/seed — idempotent seed of the 17 marketplaces
  fastify.post('/marketplaces/seed', async (_request, reply) => {
    try {
      let upserted = 0
      for (const mp of MARKETPLACES) {
        await prisma.marketplace.upsert({
          where: { channel_code: { channel: mp.channel, code: mp.code } },
          create: { ...mp },
          update: { ...mp },
        })
        upserted++
      }
      const total = await prisma.marketplace.count()
      return { success: true, upserted, total }
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
          select: { channel: true, code: true, currency: true, language: true },
        }),
      ])

      const mpKey = (channel: string, code: string) => `${channel}_${code}`
      const meta = new Map(
        marketplaces.map((m) => [
          mpKey(m.channel, m.code),
          { currency: m.currency, language: m.language },
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
          ;(acc[mp.channel] ??= []).push(mp)
          return acc
        },
        {} as Record<string, typeof marketplaces>
      )
      return grouped
    } catch (error: any) {
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // GET /api/products/:id/all-listings — every channel/marketplace listing for a product
  fastify.get<{ Params: { id: string } }>(
    '/products/:id/all-listings',
    async (request, reply) => {
      try {
        const { id } = request.params
        const listings = await prisma.channelListing.findMany({
          where: { productId: id },
          orderBy: [{ channel: 'asc' }, { marketplace: 'asc' }],
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
  // Body: { markets: Array<{ channel: string; marketplace: string; offerActive: boolean }> }
  // Auto-creates ChannelListing rows that don't exist yet (with offerActive set).
  fastify.patch<{
    Params: { id: string }
    Body: { markets: Array<{ channel: string; marketplace: string; offerActive: boolean }> }
  }>(
    '/products/:id/offer-availability',
    async (request, reply) => {
      try {
        const { id } = request.params
        const { markets } = request.body ?? {}
        if (!Array.isArray(markets) || markets.length === 0) {
          return reply.code(400).send({ error: 'markets array is required' })
        }
        const results = await Promise.all(
          markets.map(({ channel, marketplace, offerActive }) =>
            prisma.channelListing.upsert({
              where: { productId_channel_marketplace: { productId: id, channel, marketplace } },
              update: { offerActive },
              create: {
                productId: id,
                channel,
                marketplace,
                region: marketplace,
                channelMarket: `${channel}_${marketplace}`,
                listingStatus: 'DRAFT',
                offerActive,
              },
              select: { id: true, channel: true, marketplace: true, offerActive: true },
            })
          )
        )
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
  // Body: { productIds: string[]; markets: Array<{ channel: string; marketplace: string }>; offerActive: boolean }
  fastify.post<{
    Body: { productIds: string[]; markets: Array<{ channel: string; marketplace: string }>; offerActive: boolean }
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
        let upserted = 0
        // Fan out: for each product × market, upsert the ChannelListing.
        // Batched in chunks of 50 to avoid overwhelming the connection pool.
        const pairs: Array<{ productId: string; channel: string; marketplace: string }> = []
        for (const productId of productIds) {
          for (const { channel, marketplace } of markets) {
            pairs.push({ productId, channel, marketplace })
          }
        }
        const CHUNK = 50
        for (let i = 0; i < pairs.length; i += CHUNK) {
          const chunk = pairs.slice(i, i + CHUNK)
          await Promise.all(
            chunk.map(({ productId, channel, marketplace }) =>
              prisma.channelListing.upsert({
                where: { productId_channel_marketplace: { productId, channel, marketplace } },
                update: { offerActive },
                create: {
                  productId,
                  channel,
                  marketplace,
                  region: marketplace,
                  channelMarket: `${channel}_${marketplace}`,
                  listingStatus: 'DRAFT',
                  offerActive,
                },
                select: { id: true },
              })
            )
          )
          upserted += chunk.length
        }
        // When activating, sync inventory for every listing that just turned active
        if (offerActive) {
          const allIds = await prisma.channelListing.findMany({
            where: {
              productId: { in: productIds },
              channel: { in: [...new Set(markets.map((m) => m.channel))] },
              marketplace: { in: [...new Set(markets.map((m) => m.marketplace))] },
              offerActive: true,
            },
            select: { id: true },
          })
          void syncActivatedListings(allIds.map((l) => l.id))
        }
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

  // PUT /api/products/:id/listings/:channel/:marketplace — upsert
  //
  // Accepts the legacy direct-column shape ({ title, description,
  // bulletPointsOverride, price, quantity, ... }) AND a Q.2 schema-
  // driven `attributes` payload. When `attributes` is present:
  //   - item_name           → title
  //   - product_description → description
  //   - bullet_point        → bulletPointsOverride[]  (JSON-encoded
  //                                                    string[] from the
  //                                                    schema editor)
  //   - everything else     → platformAttributes.attributes[fieldId]
  // Existing platformAttributes.attributes entries are merged shallowly
  // so per-attribute saves don't blow away unrelated fields.
  fastify.put<{
    Params: { id: string; channel: string; marketplace: string }
    Body: Record<string, any>
  }>(
    '/products/:id/listings/:channel/:marketplace',
    async (request, reply) => {
      try {
        const { id, channel, marketplace } = request.params
        const body = (request.body ?? {}) as Record<string, any>

        // Verify the marketplace is configured
        const mp = await prisma.marketplace.findUnique({
          where: { channel_code: { channel, code: marketplace } },
        })
        if (!mp) {
          return reply
            .code(400)
            .send({ error: `Marketplace ${channel}/${marketplace} not configured` })
        }

        // Verify the product exists
        const product = await prisma.product.findUnique({ where: { id } })
        if (!product) {
          return reply.code(404).send({ error: `Product ${id} not found` })
        }

        const channelMarket = `${channel}_${marketplace}`
        const existing = await prisma.channelListing.findFirst({
          where: { productId: id, channel, marketplace },
        })

        // Q.2 — split out `attributes` into known columns + JSON merge.
        // Q.4 — `variantAttributes` (Record<variationId, Record<fieldId,
        //       value>>) merges into platformAttributes.variants so
        //       per-variant channel overrides ride along on the parent
        //       listing's row.
        // Q.5 — `productType` body field stores into
        //       platformAttributes.productType so the schema endpoint
        //       can pick it up as the per-listing override.
        const { attributes, variantAttributes, productType, ...rest } = body
        const data: Record<string, any> = { ...rest }

        // platformAttributes accumulates across the productType /
        // attributes / variantAttributes branches below. Seeding from
        // existing keeps unrelated keys (browseNodeId etc.) intact.
        const existingPA =
          (existing?.platformAttributes as Record<string, any> | null) ?? null
        let nextPA: Record<string, any> | null = null
        const ensurePA = () => {
          if (nextPA === null) nextPA = { ...(existingPA ?? {}) }
          return nextPA
        }

        if (typeof productType === 'string') {
          const pa = ensurePA()
          if (productType.trim() === '') {
            delete pa.productType
          } else {
            pa.productType = productType
          }
        }

        if (attributes && typeof attributes === 'object') {
          const attrs = attributes as Record<string, unknown>
          const passthrough: Record<string, unknown> = {}
          for (const [fieldId, value] of Object.entries(attrs)) {
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
                data.bulletPointsOverride = value.filter(
                  (s) => typeof s === 'string' && s.length > 0,
                )
              }
            } else {
              passthrough[fieldId] = value
            }
          }
          const existingAttrs =
            existingPA && typeof existingPA.attributes === 'object'
              ? (existingPA.attributes as Record<string, unknown>)
              : {}
          const merged: Record<string, unknown> = { ...existingAttrs }
          for (const [k, v] of Object.entries(passthrough)) {
            if (v === null || v === undefined || v === '') {
              delete merged[k]
            } else {
              merged[k] = v
            }
          }
          ensurePA().attributes = merged
        }

        // Q.4 — variant overrides. Same shallow-merge pattern: each
        // variationId slice replaces (rather than deep-merges) so a
        // PATCH-style edit to one (variation, field) keeps the other
        // fields on that variation untouched.
        if (variantAttributes && typeof variantAttributes === 'object') {
          const existingVariants =
            existingPA && typeof existingPA.variants === 'object'
              ? (existingPA.variants as Record<string, Record<string, unknown>>)
              : {}
          const mergedVariants: Record<string, Record<string, unknown>> = {
            ...existingVariants,
          }
          for (const [variationId, slice] of Object.entries(
            variantAttributes as Record<string, Record<string, unknown>>,
          )) {
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
          ensurePA().variants = mergedVariants
        }

        if (nextPA !== null) {
          data.platformAttributes = nextPA
        }

        let listing
        if (existing) {
          listing = await prisma.channelListing.update({
            where: { id: existing.id },
            data: {
              ...data,
              channel,
              marketplace,
              channelMarket,
              region: marketplace,
            },
          })
        } else {
          listing = await prisma.channelListing.create({
            data: {
              ...data,
              productId: id,
              channel,
              marketplace,
              channelMarket,
              region: marketplace,
            },
          })
        }
        return listing
      } catch (error: any) {
        fastify.log.error({ err: error }, '[products/listings PUT] failed')
        return reply.code(500).send({ error: error?.message ?? String(error) })
      }
    }
  )

  // POST /api/products/:id/listings/:channel/:marketplace/replicate
  //
  // Copy content from a source (channel, marketplace) listing to one or
  // more target marketplaces within the same channel. Useful for
  // pan-EU sellers who maintain IT as the master and want to push the
  // same bullets / attributes to DE, FR, ES, UK.
  //
  // Body:
  //   targetMarketplaces: string[]    — e.g. ["DE","FR","ES","UK"]
  //   fields?: string[]               — specific field ids; omit for all
  //   includeSetup?: boolean          — also copy productType + variationTheme (default true)
  //   includePrice?: boolean          — also copy priceOverride (default false)
  fastify.post<{
    Params: { id: string; channel: string; marketplace: string }
    Body: {
      targetMarketplaces: string[]
      fields?: string[]
      includeSetup?: boolean
      includePrice?: boolean
    }
  }>(
    '/products/:id/listings/:channel/:marketplace/replicate',
    async (request, reply) => {
      const { id, channel, marketplace } = request.params
      const {
        targetMarketplaces,
        fields,
        includeSetup = true,
        includePrice = false,
      } = request.body ?? {}

      if (!Array.isArray(targetMarketplaces) || targetMarketplaces.length === 0) {
        return reply.code(400).send({ error: 'targetMarketplaces[] required' })
      }

      const source = await prisma.channelListing.findFirst({
        where: { productId: id, channel, marketplace },
      })
      if (!source) {
        return reply.code(404).send({ error: `No listing found for ${channel}/${marketplace}` })
      }

      const sourcePA = (source.platformAttributes as Record<string, any> | null) ?? {}
      const sourceAttrs = (typeof sourcePA.attributes === 'object' && sourcePA.attributes)
        ? sourcePA.attributes as Record<string, unknown>
        : {}

      const results: { marketplace: string; ok: boolean; error?: string }[] = []

      for (const targetMarket of targetMarketplaces) {
        if (targetMarket.toUpperCase() === marketplace.toUpperCase()) {
          results.push({ marketplace: targetMarket, ok: false, error: 'same as source' })
          continue
        }
        try {
          const targetMp = await prisma.marketplace.findUnique({
            where: { channel_code: { channel, code: targetMarket } },
          })
          if (!targetMp) {
            results.push({ marketplace: targetMarket, ok: false, error: 'marketplace not configured' })
            continue
          }

          const existing = await prisma.channelListing.findFirst({
            where: { productId: id, channel, marketplace: targetMarket },
          })
          const existingPA = (existing?.platformAttributes as Record<string, any> | null) ?? {}
          const existingAttrs = (typeof existingPA.attributes === 'object' && existingPA.attributes)
            ? existingPA.attributes as Record<string, unknown>
            : {}

          // Merge source attributes into target, field-filter if requested
          const mergedAttrs = { ...existingAttrs }
          const attrsToCopy = fields
            ? Object.fromEntries(Object.entries(sourceAttrs).filter(([k]) => fields.includes(k)))
            : sourceAttrs
          Object.assign(mergedAttrs, attrsToCopy)

          const nextPA: Record<string, any> = { ...existingPA, attributes: mergedAttrs }
          if (includeSetup) {
            if (sourcePA.productType) nextPA.productType = sourcePA.productType
            if (sourcePA.variants && !fields) nextPA.variants = sourcePA.variants
          }

          const data: Record<string, any> = { platformAttributes: nextPA }

          // Copy title / description / bullets if not field-filtered or field is in the list
          const copyField = (name: string) => !fields || fields.includes(name)
          if (copyField('item_name') && source.title) data.title = source.title
          if (copyField('product_description') && source.description) data.description = source.description
          if (copyField('bullet_point') && source.bulletPointsOverride?.length) {
            data.bulletPointsOverride = source.bulletPointsOverride
          }
          if (includeSetup && copyField('variationTheme') && source.variationTheme) {
            data.variationTheme = source.variationTheme
          }
          if (includePrice && source.priceOverride != null) {
            data.price = source.priceOverride
            data.pricingRule = source.pricingRule
            data.priceAdjustmentPercent = source.priceAdjustmentPercent
          }

          if (existing) {
            await prisma.channelListing.update({ where: { id: existing.id }, data })
          } else {
            await prisma.channelListing.create({
              data: {
                ...data,
                productId: id,
                channel,
                marketplace: targetMarket,
                channelMarket: `${channel}_${targetMarket}`,
                region: targetMarket,
              },
            })
          }
          results.push({ marketplace: targetMarket, ok: true })
        } catch (err: any) {
          results.push({ marketplace: targetMarket, ok: false, error: err?.message ?? String(err) })
        }
      }

      const succeeded = results.filter((r) => r.ok).length
      return reply.send({ ok: true, replicated: succeeded, total: targetMarketplaces.length, results })
    }
  )

  // POST /api/products/:id/listings/:channel/:marketplace/pricing
  //
  // Set the pricing rule for this (channel, marketplace): priceOverride,
  // pricingRule, priceAdjustmentPercent, followMasterPrice.
  fastify.post<{
    Params: { id: string; channel: string; marketplace: string }
    Body: {
      priceOverride?: number | null
      pricingRule?: string
      priceAdjustmentPercent?: number | null
      followMasterPrice?: boolean
    }
  }>(
    '/products/:id/listings/:channel/:marketplace/pricing',
    async (request, reply) => {
      const { id, channel, marketplace } = request.params
      const { priceOverride, pricingRule, priceAdjustmentPercent, followMasterPrice } =
        request.body ?? {}

      const mp = await prisma.marketplace.findUnique({
        where: { channel_code: { channel, code: marketplace } },
      })
      if (!mp) return reply.code(400).send({ error: `Marketplace ${channel}/${marketplace} not configured` })

      const existing = await prisma.channelListing.findFirst({
        where: { productId: id, channel, marketplace },
      })

      const data: Record<string, any> = {}
      if (priceOverride !== undefined) data.price = priceOverride
      if (pricingRule !== undefined) data.pricingRule = pricingRule
      if (priceAdjustmentPercent !== undefined) data.priceAdjustmentPercent = priceAdjustmentPercent
      if (followMasterPrice !== undefined) data.followMasterPrice = followMasterPrice

      let listing
      if (existing) {
        listing = await prisma.channelListing.update({ where: { id: existing.id }, data })
      } else {
        listing = await prisma.channelListing.create({
          data: {
            ...data,
            productId: id,
            channel,
            marketplace,
            channelMarket: `${channel}_${marketplace}`,
            region: marketplace,
          },
        })
      }
      return listing
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
      if (!amazonService.isConfigured()) {
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

  // POST /api/products/:id/listings/:channel/:marketplace/save-browse-nodes
  //
  // Persists browse nodes (and optionally category path) for a channel listing.
  // Merges into platformAttributes.attributes.recommended_browse_nodes.
  fastify.post<{
    Params: { id: string; channel: string; marketplace: string }
    Body: { browseNodes?: number[]; categoryPath?: string }
  }>(
    '/products/:id/listings/:channel/:marketplace/save-browse-nodes',
    async (request, reply) => {
      const { id, channel, marketplace } = request.params
      const { browseNodes, categoryPath } = request.body ?? {}

      const existing = await prisma.channelListing.findFirst({
        where: { productId: id, channel, marketplace },
      })
      const existingPA = (existing?.platformAttributes as Record<string, any> | null) ?? {}
      const existingAttrs = typeof existingPA.attributes === 'object' && existingPA.attributes
        ? (existingPA.attributes as Record<string, unknown>) : {}

      const nextAttrs: Record<string, unknown> = { ...existingAttrs }
      if (browseNodes !== undefined) {
        nextAttrs.recommended_browse_nodes = browseNodes
      }

      const nextPA: Record<string, any> = { ...existingPA, attributes: nextAttrs }
      if (categoryPath !== undefined) nextPA.detectedCategoryPath = categoryPath

      const mp = await prisma.marketplace.findUnique({
        where: { channel_code: { channel, code: marketplace } },
      })
      if (!mp) return reply.code(400).send({ error: `Marketplace ${channel}/${marketplace} not configured` })

      let listing
      if (existing) {
        listing = await prisma.channelListing.update({
          where: { id: existing.id },
          data: { platformAttributes: nextPA },
        })
      } else {
        listing = await prisma.channelListing.create({
          data: {
            productId: id, channel, marketplace,
            channelMarket: `${channel}_${marketplace}`,
            region: marketplace,
            platformAttributes: nextPA,
          },
        })
      }
      return listing
    }
  )

  // POST /api/products/:id/listings/:channel/:marketplace/publish
  //
  // Validates required fields, attempts a channel push (Amazon SP-API or
  // optimistic mark-as-published for other channels), then sets
  // isPublished=true and listingStatus='ACTIVE' on success.
  //
  // Returns { ok, status, message, issues? }
  fastify.post<{
    Params: { id: string; channel: string; marketplace: string }
    Body: Record<string, never>
  }>(
    '/products/:id/listings/:channel/:marketplace/publish',
    async (request, reply) => {
      const { id, channel, marketplace } = request.params

      try {
        const [product, listing] = await Promise.all([
          prisma.product.findUnique({ where: { id } }),
          prisma.channelListing.findFirst({ where: { productId: id, channel, marketplace } }),
        ])
        if (!product) return reply.code(404).send({ error: `Product ${id} not found` })

        // Resolve values: listing override first, fall back to master product
        const resolvedTitle = listing?.title ?? product.name
        const resolvedPrice = listing?.price ?? (product as any).basePrice ?? null
        const pa = (listing?.platformAttributes as Record<string, any> | null) ?? {}
        const resolvedProductType = pa.productType ?? (product as any).productType ?? ''

        const issues: { message: string; severity: 'ERROR' | 'WARNING' }[] = []
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

        if (channel.toUpperCase() === 'AMAZON' && amazonService.isConfigured()) {
          const mpId = (MARKETPLACES.find(
            (m) => m.channel === 'AMAZON' && m.code === marketplace,
          ) as (typeof MARKETPLACES)[number] & { marketplaceId?: string } | undefined)?.marketplaceId

          if (!mpId) {
            return reply.code(400).send({ error: `No marketplaceId for AMAZON/${marketplace}` })
          }

          const sku = product.sku
          if (!sku) return reply.code(400).send({ error: 'Product has no SKU — cannot publish to Amazon' })

          const attrs = typeof pa.attributes === 'object' && pa.attributes
            ? (pa.attributes as Record<string, unknown>)
            : {}

          // Build a minimal SP-API attributes payload
          const spAttrs: Record<string, unknown> = {
            ...attrs,
          }
          if (resolvedTitle) {
            spAttrs.item_name = [{ value: resolvedTitle, marketplace_id: mpId, language_tag: 'it_IT' }]
          }
          if (listing?.description) {
            spAttrs.product_description = [{ value: listing.description, marketplace_id: mpId, language_tag: 'it_IT' }]
          }
          if (Array.isArray(listing?.bulletPointsOverride) && listing.bulletPointsOverride.length > 0) {
            spAttrs.bullet_point = listing.bulletPointsOverride.map((b: string) => ({
              value: b,
              marketplace_id: mpId,
              language_tag: 'it_IT',
            }))
          }
          if (resolvedPrice != null) {
            spAttrs.purchasable_offer = [{
              currency: 'EUR',
              our_price: [{ schedule: [{ value_with_tax: Number(resolvedPrice) }] }],
              marketplace_id: mpId,
            }]
          }

          const sellerId = process.env.AMAZON_SELLER_ID ?? ''
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

          // Mark as published + sync inventory
          await prisma.channelListing.updateMany({
            where: { productId: id, channel, marketplace },
            data: { isPublished: true, listingStatus: 'ACTIVE', lastSyncedAt: new Date() },
          })
          const publishedListing = await prisma.channelListing.findFirst({
            where: { productId: id, channel, marketplace },
            select: { id: true },
          })
          if (publishedListing) void syncActivatedListings([publishedListing.id])

          responsePayload = {
            ok: true,
            status: spResult.dryRun ? 'DRY_RUN' : (spResult.status ?? 'SUBMITTED'),
            message: spResult.dryRun
              ? 'Dry-run: listing payload accepted (no live push). Set AMAZON_PUBLISH_MODE=live to publish for real.'
              : `Submitted to Amazon. Submission ID: ${spResult.submissionId ?? 'n/a'}`,
            issues: spResult.warnings?.map((w) => ({ message: w.message, severity: w.severity })),
          }
        } else {
          // Non-Amazon channels (eBay, Shopify, etc.) — optimistic mark-as-published
          await prisma.channelListing.upsert({
            where: listing
              ? { id: listing.id }
              : { id: 'none' }, // fallback: upsert by productId+channel+marketplace below
            update: { isPublished: true, listingStatus: 'ACTIVE', lastSyncedAt: new Date() },
            create: {
              productId: id,
              channel,
              marketplace,
              channelMarket: `${channel}_${marketplace}`,
              region: marketplace,
              isPublished: true,
              listingStatus: 'ACTIVE',
              lastSyncedAt: new Date(),
            },
          }).catch(async () => {
            // upsert by unique id failed (no existing listing), create instead
            await prisma.channelListing.create({
              data: {
                productId: id,
                channel,
                marketplace,
                channelMarket: `${channel}_${marketplace}`,
                region: marketplace,
                isPublished: true,
                listingStatus: 'ACTIVE',
                lastSyncedAt: new Date(),
              },
            })
          })

          // Sync inventory immediately after marking published
          const activatedL = await prisma.channelListing.findFirst({
            where: { productId: id, channel, marketplace },
            select: { id: true },
          })
          if (activatedL) void syncActivatedListings([activatedL.id])

          const channelLabel =
            channel === 'EBAY' ? 'eBay'
            : channel === 'SHOPIFY' ? 'Shopify'
            : channel

          responsePayload = {
            ok: true,
            status: 'SUBMITTED',
            message: `Marked as published. Inventory synced and push queued for ${channelLabel}.`,
          }
        }

        return reply.send(responsePayload)
      } catch (error: any) {
        fastify.log.error({ err: error }, '[products/listings/publish] failed')
        return reply.code(500).send({ ok: false, status: 'ERROR', message: error?.message ?? String(error) })
      }
    }
  )
}

export default marketplacesRoutes
