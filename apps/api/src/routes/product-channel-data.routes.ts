/**
 * Channel pricing + inventory + Amazon sync-data endpoints for the
 * product edit page.
 *
 *   GET  /api/products/:id/channel-pricing      — variant × market pricing
 *   PATCH /api/products/:id/channel-pricing     — bulk update prices
 *   GET  /api/products/:id/channel-inventory    — variant × market listed qty + physical stock
 *   GET  /api/products/:id/amazon-sync-data     — pull title/desc/bullets from ChannelListing
 */

import type { FastifyInstance } from 'fastify'
import prisma from '../db.js'

export default async function productChannelDataRoutes(fastify: FastifyInstance) {

  // ── GET /api/products/:id/channel-pricing ───────────────────────────────
  fastify.get<{ Params: { id: string }; Querystring: { channel?: string } }>(
    '/products/:id/channel-pricing',
    async (request, reply) => {
      const { id } = request.params
      const channel = request.query.channel ?? 'AMAZON'

      const [product, variants, channelListings, variantListings] = await Promise.all([
        prisma.product.findUnique({ where: { id }, select: { id: true, sku: true, isParent: true } }),
        prisma.productVariation.findMany({
          where: { productId: id },
          select: { id: true, sku: true, price: true, variationAttributes: true },
          orderBy: { sku: 'asc' },
        }),
        prisma.channelListing.findMany({
          where: { productId: id, channel },
          select: { id: true, marketplace: true, channel: true, price: true, salePrice: true, listingStatus: true, lastSyncedAt: true, externalListingId: true },
          orderBy: { marketplace: 'asc' },
        }),
        prisma.variantChannelListing.findMany({
          where: {
            variant: { productId: id },
            channel,
          },
          select: { id: true, variantId: true, marketplace: true, channel: true, channelPrice: true, currentPrice: true, listingStatus: true, lastSyncedAt: true, externalListingId: true },
          orderBy: [{ variantId: 'asc' }, { marketplace: 'asc' }],
        }),
      ])

      if (!product) return reply.code(404).send({ error: 'Product not found' })

      // Product-level markets
      const productMarkets = channelListings.map((cl) => ({
        marketplace: cl.marketplace,
        channel: cl.channel,
        price: cl.price != null ? Number(cl.price) : null,
        salePrice: cl.salePrice != null ? Number(cl.salePrice) : null,
        listingStatus: cl.listingStatus,
        lastSyncedAt: cl.lastSyncedAt?.toISOString() ?? null,
        asin: cl.externalListingId ?? null,
        source: 'product' as const,
      }))

      // Variant-level markets grouped by variantId
      const variantMap = new Map(variants.map((v) => [v.id, v]))
      const variantListingsByVariant = new Map<string, typeof variantListings>()
      for (const vl of variantListings) {
        if (!variantListingsByVariant.has(vl.variantId)) variantListingsByVariant.set(vl.variantId, [])
        variantListingsByVariant.get(vl.variantId)!.push(vl)
      }

      const variantRows = variants.map((v) => {
        const vListings = variantListingsByVariant.get(v.id) ?? []
        const markets = vListings.map((vl) => ({
          marketplace: vl.marketplace,
          channel: vl.channel,
          price: vl.channelPrice != null ? Number(vl.channelPrice) : (vl.currentPrice != null ? Number(vl.currentPrice) : null),
          salePrice: null as number | null,
          listingStatus: vl.listingStatus,
          lastSyncedAt: vl.lastSyncedAt?.toISOString() ?? null,
          asin: vl.externalListingId ?? null,
          source: 'variant' as const,
        }))

        // Fill in any markets that have product-level pricing but no variant override
        const coveredMarkets = new Set(markets.map((m) => m.marketplace))
        for (const pm of productMarkets) {
          if (!coveredMarkets.has(pm.marketplace)) {
            markets.push({ ...pm, source: 'variant' as const })
          }
        }
        markets.sort((a, b) => a.marketplace.localeCompare(b.marketplace))

        return {
          variantId: v.id,
          sku: v.sku,
          attributes: (v.variationAttributes as Record<string, string> | null) ?? {},
          basePrice: v.price != null ? Number(v.price) : null,
          markets,
        }
      })

      return reply.send({
        productId: id,
        channel,
        product: { markets: productMarkets },
        variants: variantRows,
      })
    },
  )

  // ── PATCH /api/products/:id/channel-pricing ─────────────────────────────
  // Bulk update. Each update targets either a variant (variantId set) or
  // the product-level ChannelListing (variantId absent/null).
  fastify.patch<{
    Params: { id: string }
    Body: {
      updates: Array<{
        variantId?: string | null
        marketplace: string
        channel?: string
        price?: number | null
        salePrice?: number | null
      }>
    }
  }>('/products/:id/channel-pricing', async (request, reply) => {
    const { id } = request.params
    const { updates } = request.body

    if (!updates?.length) return reply.code(400).send({ error: 'updates must be non-empty' })

    const ops = updates.map(async (u) => {
      const mp = u.marketplace.toUpperCase()
      const ch = (u.channel ?? 'AMAZON').toUpperCase()

      if (u.variantId) {
        // Variant-level update
        const data: Record<string, any> = { lastSyncedAt: new Date() }
        if (u.price !== undefined) data.channelPrice = u.price
        await prisma.variantChannelListing.updateMany({
          where: { variantId: u.variantId, marketplace: mp, channel: ch },
          data,
        })
      } else {
        // Product-level update
        const data: Record<string, any> = { lastSyncedAt: new Date() }
        if (u.price !== undefined && u.price !== null) data.price = u.price
        if (u.salePrice !== undefined) data.salePrice = u.salePrice
        await prisma.channelListing.updateMany({
          where: { productId: id, marketplace: mp, channel: ch },
          data,
        })
      }
    })

    await Promise.allSettled(ops)
    return reply.send({ ok: true, updated: updates.length })
  })

  // ── GET /api/products/:id/channel-inventory ─────────────────────────────
  fastify.get<{ Params: { id: string }; Querystring: { channel?: string } }>(
    '/products/:id/channel-inventory',
    async (request, reply) => {
      const { id } = request.params
      const channel = request.query.channel ?? 'AMAZON'

      const [variants, channelListings, variantListings, stockLevels] = await Promise.all([
        prisma.productVariation.findMany({
          where: { productId: id },
          select: { id: true, sku: true, variationAttributes: true, stock: true },
          orderBy: { sku: 'asc' },
        }),
        prisma.channelListing.findMany({
          where: { productId: id, channel },
          select: { marketplace: true, channel: true, quantity: true, stockBuffer: true, listingStatus: true, lastSyncedAt: true },
          orderBy: { marketplace: 'asc' },
        }),
        prisma.variantChannelListing.findMany({
          where: { variant: { productId: id }, channel },
          select: { variantId: true, marketplace: true, channel: true, channelQuantity: true, quantity: true, listingStatus: true, lastSyncedAt: true },
          orderBy: [{ variantId: 'asc' }, { marketplace: 'asc' }],
        }),
        prisma.stockLevel.findMany({
          where: { productId: id },
          select: { variationId: true, quantity: true, reserved: true, available: true, location: { select: { type: true } } },
        }),
      ])

      // Physical stock per variationId (sum across warehouse locations)
      const physicalByVariant = new Map<string | null, number>()
      for (const sl of stockLevels) {
        if (sl.location.type !== 'WAREHOUSE') continue
        const key = sl.variationId ?? null
        physicalByVariant.set(key, (physicalByVariant.get(key) ?? 0) + sl.available)
      }

      const productMarkets = channelListings.map((cl) => ({
        marketplace: cl.marketplace,
        channel: cl.channel,
        listedQty: cl.quantity ?? null,
        buffer: cl.stockBuffer ?? 0,
        listingStatus: cl.listingStatus,
        lastSyncedAt: cl.lastSyncedAt?.toISOString() ?? null,
      }))

      const variantListingsByVariant = new Map<string, typeof variantListings>()
      for (const vl of variantListings) {
        if (!variantListingsByVariant.has(vl.variantId)) variantListingsByVariant.set(vl.variantId, [])
        variantListingsByVariant.get(vl.variantId)!.push(vl)
      }

      const variantRows = variants.map((v) => {
        const vListings = variantListingsByVariant.get(v.id) ?? []
        const markets = vListings.map((vl) => ({
          marketplace: vl.marketplace,
          channel: vl.channel,
          listedQty: vl.channelQuantity ?? vl.quantity ?? null,
          buffer: 0,
          listingStatus: vl.listingStatus,
          lastSyncedAt: vl.lastSyncedAt?.toISOString() ?? null,
        }))

        // Fill markets not in variantListings from product-level
        const covered = new Set(markets.map((m) => m.marketplace))
        for (const pm of productMarkets) {
          if (!covered.has(pm.marketplace)) markets.push(pm)
        }
        markets.sort((a, b) => a.marketplace.localeCompare(b.marketplace))

        return {
          variantId: v.id,
          sku: v.sku,
          attributes: (v.variationAttributes as Record<string, string> | null) ?? {},
          physicalStock: physicalByVariant.get(v.id) ?? 0,
          markets,
        }
      })

      return reply.send({
        productId: id,
        channel,
        product: {
          physicalStock: physicalByVariant.get(null) ?? 0,
          markets: productMarkets,
        },
        variants: variantRows,
      })
    },
  )

  // ── GET /api/products/:id/amazon-sync-data ──────────────────────────────
  // Reads ChannelListing.platformAttributes for the given marketplace and
  // returns structured master-data fields the edit page can pre-fill.
  fastify.get<{ Params: { id: string }; Querystring: { marketplace?: string } }>(
    '/products/:id/amazon-sync-data',
    async (request, reply) => {
      const { id } = request.params
      const mp = (request.query.marketplace ?? 'IT').toUpperCase()

      // For child products look up the parent listing
      const product = await prisma.product.findUnique({
        where: { id },
        select: { id: true, isParent: true, parentId: true },
      })
      if (!product) return reply.code(404).send({ error: 'Product not found' })

      const sourceId = product.isParent ? id : (product.parentId ?? id)

      const listing = await prisma.channelListing.findFirst({
        where: { productId: sourceId, channel: 'AMAZON', marketplace: mp },
        select: { title: true, description: true, bulletPointsOverride: true, platformAttributes: true, lastSyncedAt: true },
        orderBy: { lastSyncedAt: 'desc' },
      })

      if (!listing) {
        return reply.code(404).send({ error: `No Amazon ${mp} listing found — pull from Amazon first` })
      }

      const attrs = (listing.platformAttributes as any)?.attributes ?? {}
      const extractFirst = (key: string) =>
        String(attrs[key]?.[0]?.value ?? '').trim() || null

      return reply.send({
        marketplace: mp,
        lastSyncedAt: listing.lastSyncedAt?.toISOString() ?? null,
        name: listing.title ?? extractFirst('item_name'),
        description: listing.description ?? extractFirst('product_description'),
        bulletPoints: listing.bulletPointsOverride?.length
          ? listing.bulletPointsOverride
          : (Array.isArray(attrs.bullet_point)
              ? attrs.bullet_point.map((b: any) => b?.value ?? '').filter(Boolean)
              : []),
        brand: extractFirst('brand'),
        keywords: extractFirst('generic_keyword'),
      })
    },
  )
}
