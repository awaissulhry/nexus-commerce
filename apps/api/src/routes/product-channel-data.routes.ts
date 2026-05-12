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
  //
  // For parent products: "variants" = child Product rows + their ChannelListing
  // data. This aligns with what the Matrix tab displays (child product IDs) and
  // what getExistingRows reads (ChannelListing.price) so the flat file
  // round-trip works correctly.
  //
  // For non-parent products: "variants" is empty; product.markets covers the
  // single product's listings.
  fastify.get<{ Params: { id: string }; Querystring: { channel?: string } }>(
    '/products/:id/channel-pricing',
    async (request, reply) => {
      const { id } = request.params
      const channel = request.query.channel ?? 'AMAZON'

      const product = await prisma.product.findUnique({
        where: { id },
        select: { id: true, sku: true, isParent: true },
      })
      if (!product) return reply.code(404).send({ error: 'Product not found' })

      // Product-level channel listings (used for non-parent and as fallback)
      const channelListings = await prisma.channelListing.findMany({
        where: { productId: id, channel },
        select: { id: true, marketplace: true, channel: true, price: true, salePrice: true, listingStatus: true, lastSyncedAt: true, externalListingId: true },
        orderBy: { marketplace: 'asc' },
      })

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

      // For parent products: child Product rows are the "variants".
      // Each child has its own ChannelListing — that is exactly the source
      // getExistingRows reads for the flat file, so editing here = editing
      // what the flat file shows.
      type MarketRow = { marketplace: string; channel: string; price: number | null; salePrice: number | null; listingStatus: string; lastSyncedAt: string | null; asin: string | null; source: 'product' | 'variant' }
      let variantRows: Array<{
        variantId: string; sku: string
        attributes: Record<string, string>
        basePrice: number | null
        markets: MarketRow[]
      }> = []

      if (product.isParent) {
        const children = await prisma.product.findMany({
          where: { parentId: id, deletedAt: null },
          select: {
            id: true, sku: true, basePrice: true,
            variantAttributes: true,
            channelListings: {
              where: { channel },
              select: { marketplace: true, channel: true, price: true, salePrice: true, listingStatus: true, lastSyncedAt: true, externalListingId: true },
            },
          },
          orderBy: { sku: 'asc' },
        })

        variantRows = children.map((c) => ({
          variantId: c.id, // child Product ID — matches Matrix tab's child.id
          sku: c.sku,
          attributes: (c.variantAttributes as Record<string, string> | null) ?? {},
          basePrice: c.basePrice != null ? Number(c.basePrice) : null,
          markets: c.channelListings.map((cl) => ({
            marketplace: cl.marketplace,
            channel: cl.channel,
            price: cl.price != null ? Number(cl.price) : null,
            salePrice: cl.salePrice != null ? Number(cl.salePrice) : null,
            listingStatus: cl.listingStatus,
            lastSyncedAt: cl.lastSyncedAt?.toISOString() ?? null,
            asin: cl.externalListingId ?? null,
            source: 'variant' as const,
          })),
        }))
      }

      return reply.send({
        productId: id,
        channel,
        product: { markets: productMarkets },
        variants: variantRows,
      })
    },
  )

  // ── PATCH /api/products/:id/channel-pricing ─────────────────────────────
  //
  // When variantId is provided it is a child Product ID (from the Matrix tab).
  // We write to ChannelListing where productId = variantId — this is the same
  // table getExistingRows reads, so the flat file reflects the change
  // immediately on next load.
  //
  // We also attempt a secondary write to VariantChannelListing for the
  // PE.1 ChannelPricingSection which still uses that table.
  fastify.patch<{
    Params: { id: string }
    Body: {
      updates: Array<{
        variantId?: string | null
        marketplace: string
        channel?: string
        price?: number | null
        salePrice?: number | null
        quantity?: number | null
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
        // Primary: upsert the child product's ChannelListing (what flat file reads).
        // Use upsert not updateMany so that child products without an existing
        // ChannelListing row still get the price written — updateMany would silently
        // match 0 records and the flat file would never see the change.
        const clUpdate: Record<string, any> = { lastSyncedAt: new Date(), syncStatus: 'PENDING' }
        if (u.price !== undefined && u.price !== null) { clUpdate.price = u.price; clUpdate.followMasterPrice = false }
        if (u.salePrice !== undefined) clUpdate.salePrice = u.salePrice
        if (u.quantity !== undefined && u.quantity !== null) { clUpdate.quantity = u.quantity; clUpdate.followMasterQuantity = false }

        await prisma.channelListing.upsert({
          where: { productId_channel_marketplace: { productId: u.variantId, channel: ch, marketplace: mp } },
          update: clUpdate,
          create: {
            productId: u.variantId,
            channel: ch,
            marketplace: mp,
            channelMarket: `${ch}_${mp}`,
            region: mp,
            ...clUpdate,
          },
        })

        // Secondary: also update VariantChannelListing for completeness
        const vclData: Record<string, any> = { lastSyncedAt: new Date() }
        if (u.price !== undefined && u.price !== null) vclData.channelPrice = u.price
        if (u.quantity !== undefined && u.quantity !== null) vclData.channelQuantity = u.quantity
        await prisma.variantChannelListing.updateMany({
          where: { variantId: u.variantId, marketplace: mp, channel: ch },
          data: vclData,
        }).catch(() => { /* VariantChannelListing may not exist — non-fatal */ })
      } else {
        // Product-level update (no variantId)
        const data: Record<string, any> = { lastSyncedAt: new Date(), syncStatus: 'PENDING' }
        if (u.price !== undefined && u.price !== null) { data.price = u.price; data.followMasterPrice = false }
        if (u.salePrice !== undefined) data.salePrice = u.salePrice
        if (u.quantity !== undefined && u.quantity !== null) { data.quantity = u.quantity; data.followMasterQuantity = false }
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
  //
  // For parent products: variants = child Product rows + their ChannelListing
  // quantity. This mirrors the channel-pricing endpoint so both use the same
  // child Product IDs — matching what the Matrix tab and the flat file use.
  // (Old approach used ProductVariation + VariantChannelListing whose IDs
  // never matched child Product IDs, so listed qty always showed as 0.)
  fastify.get<{ Params: { id: string }; Querystring: { channel?: string } }>(
    '/products/:id/channel-inventory',
    async (request, reply) => {
      const { id } = request.params
      const channel = request.query.channel ?? 'AMAZON'

      const product = await prisma.product.findUnique({
        where: { id },
        select: { id: true, isParent: true, totalStock: true },
      })
      if (!product) return reply.code(404).send({ error: 'Product not found' })

      // Product-level ChannelListing (used for non-parent + product summary row)
      const channelListings = await prisma.channelListing.findMany({
        where: { productId: id, channel },
        select: { marketplace: true, channel: true, quantity: true, stockBuffer: true, listingStatus: true, lastSyncedAt: true },
        orderBy: { marketplace: 'asc' },
      })

      const productMarkets = channelListings.map((cl) => ({
        marketplace: cl.marketplace,
        channel: cl.channel,
        listedQty: cl.quantity ?? null,
        buffer: cl.stockBuffer ?? 0,
        listingStatus: cl.listingStatus,
        lastSyncedAt: cl.lastSyncedAt?.toISOString() ?? null,
      }))

      let variantRows: Array<{
        variantId: string; sku: string
        attributes: Record<string, string>
        physicalStock: number
        markets: typeof productMarkets
      }> = []

      if (product.isParent) {
        // Use child Product rows + their ChannelListing — same model the Matrix
        // tab and the PATCH /channel-pricing endpoint both operate on.
        const children = await prisma.product.findMany({
          where: { parentId: id, deletedAt: null },
          select: {
            id: true, sku: true, totalStock: true, variantAttributes: true,
            channelListings: {
              where: { channel },
              select: { marketplace: true, channel: true, quantity: true, stockBuffer: true, listingStatus: true, lastSyncedAt: true },
            },
          },
          orderBy: { sku: 'asc' },
        })

        variantRows = children.map((c) => ({
          variantId: c.id,
          sku: c.sku,
          attributes: (c.variantAttributes as Record<string, string> | null) ?? {},
          physicalStock: c.totalStock ?? 0,
          markets: c.channelListings.map((cl) => ({
            marketplace: cl.marketplace,
            channel: cl.channel,
            listedQty: cl.quantity ?? null,
            buffer: cl.stockBuffer ?? 0,
            listingStatus: cl.listingStatus,
            lastSyncedAt: cl.lastSyncedAt?.toISOString() ?? null,
          })),
        }))
      }

      return reply.send({
        productId: id,
        channel,
        product: {
          physicalStock: product.totalStock ?? 0,
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
