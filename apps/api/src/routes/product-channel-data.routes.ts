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
import { computeAvailableToPublish } from '../services/available-to-publish.service.js'
import { MARKETPLACE_ID_TO_CODE } from '../utils/marketplace-code.js'
import { getPendingMcfReservedByProduct } from '../services/amazon-mcf.service.js'

// Normalize Amazon's fulfilment value (stored on
// ChannelListing.platformAttributes.fulfillmentChannel) to FBA/FBM. AFN =
// Amazon-fulfilled (FBA), MFN/MERCHANT = merchant-fulfilled (FBM).
function normalizeFulfillment(pa: unknown): 'FBA' | 'FBM' | null {
  const raw = (pa as Record<string, unknown> | null | undefined)?.fulfillmentChannel
  const s = typeof raw === 'string' ? raw.toUpperCase() : ''
  if (s === 'AFN' || s === 'FBA') return 'FBA'
  if (s === 'MFN' || s === 'FBM' || s === 'MERCHANT') return 'FBM'
  return null
}

// FCF.4b — merchant channels are always merchant-fulfilled (FBM); they can
// never be backed by Amazon FBA stock.
const MERCHANT_CHANNELS = new Set(['EBAY', 'SHOPIFY', 'WOOCOMMERCE', 'ETSY'])

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
        select: { id: true, sku: true, isParent: true, totalStock: true, fulfillmentMethod: true },
      })
      if (!product) return reply.code(404).send({ error: 'Product not found' })

      // Product-level ChannelListing (used for non-parent + product summary row)
      const channelListings = await prisma.channelListing.findMany({
        where: { productId: id, channel },
        select: { marketplace: true, channel: true, quantity: true, stockBuffer: true, listingStatus: true, lastSyncedAt: true, platformAttributes: true, fulfillmentMethod: true },
        orderBy: { marketplace: 'asc' },
      })

      // FCF.4b — child product rows (parent only). Loaded up-front so the stock
      // pools below can be batched across product + every child in one query.
      const children = product.isParent
        ? await prisma.product.findMany({
            where: { parentId: id, deletedAt: null },
            select: {
              id: true, sku: true, totalStock: true, variantAttributes: true,
              channelListings: {
                where: { channel },
                select: { marketplace: true, channel: true, quantity: true, stockBuffer: true, listingStatus: true, lastSyncedAt: true, platformAttributes: true, fulfillmentMethod: true },
              },
            },
            orderBy: { sku: 'asc' },
          })
        : []

      // FCF.4b — gather the two stock pools once for the product + all children,
      // then compute availableToPublish per (variant, market). FBM listings are
      // backed by own-warehouse StockLevel.available; FBA listings by SELLABLE
      // FbaInventoryDetail scoped to the listing's marketplace. Mirrors the
      // FCF.1 GET /products/:id/fulfillment endpoint, batched for the matrix.
      const allProductIds = [id, ...children.map((c) => c.id)]
      const allSkus = [product.sku, ...children.map((c) => c.sku)].filter((s): s is string => !!s)
      const [whRows, fbaRows, pendingMcfByProduct] = await Promise.all([
        prisma.stockLevel.findMany({
          where: { productId: { in: allProductIds }, location: { type: 'WAREHOUSE' } },
          select: { productId: true, available: true },
        }),
        allSkus.length > 0
          ? prisma.fbaInventoryDetail.findMany({
              where: { sku: { in: allSkus }, condition: 'SELLABLE' },
              select: { sku: true, quantity: true, marketplaceId: true },
            })
          : Promise.resolve([] as Array<{ sku: string; quantity: number; marketplaceId: string }>),
        // FCF.6 — in-flight MCF reservations against the FBA pool per product.
        getPendingMcfReservedByProduct(allProductIds),
      ])
      const warehouseByProduct = new Map<string, number>()
      for (const r of whRows) warehouseByProduct.set(r.productId, (warehouseByProduct.get(r.productId) ?? 0) + r.available)
      const fbaBySkuMarket = new Map<string, number>()
      for (const r of fbaRows) {
        const code = MARKETPLACE_ID_TO_CODE[r.marketplaceId] ?? r.marketplaceId
        const key = `${r.sku}::${code}`
        fbaBySkuMarket.set(key, (fbaBySkuMarket.get(key) ?? 0) + r.quantity)
      }

      // Resolve the effective fulfillment method for a listing: the persisted
      // FCF.1 ChannelListing.fulfillmentMethod when set ('listing'), else
      // derived — merchant channels → FBM, Amazon → ingested fulfillmentChannel
      // → product-level method → FBM. Then bind availableToPublish to that pool.
      const productMethod = (product.fulfillmentMethod as 'FBA' | 'FBM' | null) ?? null
      function buildMarket(cl: {
        marketplace: string; channel: string; quantity: number | null; stockBuffer: number | null
        listingStatus: string | null; lastSyncedAt: Date | null; platformAttributes: unknown
        fulfillmentMethod: 'FBA' | 'FBM' | null
      }, productId: string, sku: string | null) {
        const ingested = normalizeFulfillment(cl.platformAttributes)
        let method = cl.fulfillmentMethod
        let source: 'listing' | 'derived' = 'listing'
        if (method == null) {
          source = 'derived'
          method = MERCHANT_CHANNELS.has(cl.channel) ? 'FBM' : (ingested ?? productMethod ?? 'FBM')
        }
        const code = cl.marketplace?.toUpperCase() ?? cl.marketplace
        const warehouseAvailable = warehouseByProduct.get(productId) ?? 0
        const fbaSellable = sku ? fbaBySkuMarket.get(`${sku}::${code}`) ?? 0 : 0
        const pendingMcf = pendingMcfByProduct.get(productId) ?? 0
        const atp = computeAvailableToPublish({
          fulfillmentMethod: method,
          warehouseAvailable,
          fbaSellable,
          stockBuffer: cl.stockBuffer ?? 0,
          // FCF.6 — only FBA needs the pending-MCF subtraction; warehouse is
          // already reservation-netted.
          pendingReserved: method === 'FBA' ? pendingMcf : 0,
        })
        const listedQty = cl.quantity ?? null
        const drift = listedQty == null ? null : listedQty - atp.available
        return {
          marketplace: cl.marketplace,
          channel: cl.channel,
          listedQty,
          buffer: cl.stockBuffer ?? 0,
          listingStatus: cl.listingStatus,
          lastSyncedAt: cl.lastSyncedAt?.toISOString() ?? null,
          fulfillmentChannel: ingested,
          // FCF.4b — operator-set per channel×marketplace method + resolved pool.
          fulfillmentMethod: method,
          fulfillmentSource: source,
          availableToPublish: atp.available,
          pool: atp.pool,
          // FCF.5 — merchant-channel listing backed by the FBA pool = MCF.
          isMcf: MERCHANT_CHANNELS.has(cl.channel) && method === 'FBA',
          // FCF.6 — published-vs-pool drift; oversold = listing more than the
          // pool can back (after reservations + buffer).
          reservedApplied: atp.reservedApplied,
          drift,
          oversold: drift != null && drift > 0,
          // Raw pools (pre-buffer) so the matrix can recompute ATP instantly
          // when the operator toggles the method, without a refetch.
          warehouseAvailable,
          fbaSellable,
          pendingReserved: method === 'FBA' ? pendingMcf : 0,
        }
      }

      const productMarkets = channelListings.map((cl) => buildMarket(cl, id, product.sku))

      const variantRows = children.map((c) => ({
        variantId: c.id,
        sku: c.sku,
        attributes: (c.variantAttributes as Record<string, string> | null) ?? {},
        physicalStock: c.totalStock ?? 0,
        markets: c.channelListings.map((cl) => buildMarket(cl, c.id, c.sku)),
      }))

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

  // ── PATCH /api/products/:id/fulfillment ─────────────────────────────────
  //
  // FCF.4b — set ChannelListing.fulfillmentMethod per channel×marketplace.
  // Mirrors PATCH /channel-pricing: when variantId is provided it is a child
  // Product ID (the Matrix tab operates on children); otherwise the update is
  // product-level. Pass fulfillmentMethod: null to clear the override and fall
  // back to the derived method. Writing FBA/FBM also mirrors the value into
  // platformAttributes.fulfillmentChannel so the read-side (cockpit card,
  // channel-inventory ingested signal) stays consistent until the next sync.
  fastify.patch<{
    Params: { id: string }
    Body: {
      updates: Array<{
        variantId?: string | null
        marketplace: string
        channel?: string
        fulfillmentMethod: 'FBA' | 'FBM' | null
      }>
    }
  }>('/products/:id/fulfillment', async (request, reply) => {
    const { id } = request.params
    const { updates } = request.body
    if (!updates?.length) return reply.code(400).send({ error: 'updates must be non-empty' })
    for (const u of updates) {
      if (u.fulfillmentMethod != null && u.fulfillmentMethod !== 'FBA' && u.fulfillmentMethod !== 'FBM') {
        return reply.code(400).send({ error: `invalid fulfillmentMethod: ${u.fulfillmentMethod}` })
      }
    }

    const ops = updates.map(async (u) => {
      const mp = u.marketplace.toUpperCase()
      const ch = (u.channel ?? 'AMAZON').toUpperCase()
      const productId = u.variantId ?? id

      // Keep the ingested fulfillmentChannel mirror in step with the operator's
      // choice so read surfaces reading platformAttributes don't show stale data.
      const existing = await prisma.channelListing.findUnique({
        where: { productId_channel_marketplace: { productId, channel: ch, marketplace: mp } },
        select: { platformAttributes: true },
      })
      const pa = { ...((existing?.platformAttributes as Record<string, unknown> | null) ?? {}) }
      if (u.fulfillmentMethod == null) delete pa.fulfillmentChannel
      else pa.fulfillmentChannel = u.fulfillmentMethod === 'FBA' ? 'AFN' : 'MFN'
      const paJson = pa as unknown as Parameters<typeof prisma.channelListing.upsert>[0]['create']['platformAttributes']

      await prisma.channelListing.upsert({
        where: { productId_channel_marketplace: { productId, channel: ch, marketplace: mp } },
        update: { fulfillmentMethod: u.fulfillmentMethod, platformAttributes: paJson, lastSyncedAt: new Date(), syncStatus: 'PENDING' },
        create: {
          productId,
          channel: ch,
          marketplace: mp,
          channelMarket: `${ch}_${mp}`,
          region: mp,
          fulfillmentMethod: u.fulfillmentMethod,
          platformAttributes: paJson,
          lastSyncedAt: new Date(),
          syncStatus: 'PENDING',
        },
      })
    })

    await Promise.allSettled(ops)
    return reply.send({ ok: true, updated: updates.length })
  })

  // ── GET /api/products/:id/listings ──────────────────────────────────────
  // T3.3 — all of a product's channel listings (every channel × market)
  // with their effective key field values, for the cross-channel matrix.
  // Effective value = override ?? own ?? inherited-master, so the matrix
  // shows what's actually live per coordinate.
  fastify.get<{ Params: { id: string } }>(
    '/products/:id/listings',
    async (request, reply) => {
      const { id } = request.params
      const listings = await prisma.channelListing.findMany({
        where: { productId: id },
        select: {
          channel: true,
          marketplace: true,
          listingStatus: true,
          title: true,
          masterTitle: true,
          description: true,
          masterDescription: true,
          price: true,
          priceOverride: true,
          masterPrice: true,
          lastSyncedAt: true,
        },
        orderBy: [{ channel: 'asc' }, { marketplace: 'asc' }],
      })
      const num = (v: unknown): number | null => {
        if (v == null) return null
        const n = typeof v === 'string' ? parseFloat(v) : Number(v)
        return Number.isFinite(n) ? n : null
      }
      return reply.send({
        productId: id,
        listings: listings.map((l) => ({
          channel: l.channel,
          marketplace: l.marketplace,
          status: l.listingStatus,
          title: l.title ?? l.masterTitle ?? null,
          hasDescription: Boolean(l.description ?? l.masterDescription),
          price: num(l.priceOverride) ?? num(l.price) ?? num(l.masterPrice),
          lastSyncedAt: l.lastSyncedAt?.toISOString() ?? null,
        })),
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

  // ── GET /api/products/:id/variant-image-locks ──────────────────────────
  //
  // AC.6.4 — Amazon Listing Cockpit's VariationMatrix needs to show the
  // "Red" image for any Red-variant cell regardless of which size that
  // variant is. The IM-series ListingImage model already tags images
  // with (variantGroupKey, variantGroupValue) — e.g. Color/Rosso — so
  // this endpoint just rolls those rows into a {axisKey: {axisValue: url}}
  // map. Prefers GLOBAL-scope rows; falls back to the first per-channel
  // row when no global image exists for a value.
  //
  // Shape:
  //   { locks: { [axisKey]: { [axisValue]: { url, role } } } }
  fastify.get<{ Params: { id: string } }>(
    '/products/:id/variant-image-locks',
    async (request, reply) => {
      const { id } = request.params
      const product = await prisma.product.findUnique({
        where: { id },
        select: { id: true, isParent: true },
      })
      if (!product) return reply.code(404).send({ error: 'Product not found' })

      const rows = await prisma.listingImage.findMany({
        where: {
          productId: id,
          variantGroupKey: { not: null },
          variantGroupValue: { not: null },
        },
        select: {
          variantGroupKey: true,
          variantGroupValue: true,
          url: true,
          role: true,
          scope: true,
          position: true,
        },
        orderBy: [{ scope: 'asc' }, { role: 'asc' }, { position: 'asc' }],
      })

      const locks: Record<
        string,
        Record<string, { url: string; role: string }>
      > = {}
      for (const r of rows) {
        if (!r.variantGroupKey || !r.variantGroupValue) continue
        const key = r.variantGroupKey
        const val = r.variantGroupValue
        // First row wins (orderBy makes scope=GLOBAL come first when
        // present; otherwise lowest-role/lowest-position).
        if (!locks[key]) locks[key] = {}
        if (!locks[key][val]) locks[key][val] = { url: r.url, role: r.role }
      }

      return reply.send({ productId: id, locks })
    },
  )

  // ── OL.C.1 — POST /api/products/listing-health/bulk ──────────────────────
  // Marketplace-aware listing health for the /products grid, in bulk. For
  // each product, scores its ChannelListings with the SAME "ready" rule the
  // publish preflight (OL.B) uses, so the grid and the publish review agree:
  // a coordinate is ready when it has a title + positive price (+ Amazon also
  // needs a productType) and isn't in ERROR status. score = % of a product's
  // coordinates that are ready. Returns ready/total/blocked + per-channel
  // counts for the tooltip. Column-gated client fetch (mirrors
  // family-completeness/bulk) so it never slows a default grid load.
  fastify.post<{ Body: { productIds?: string[] } }>(
    '/products/listing-health/bulk',
    async (request, reply) => {
      const ids = Array.isArray(request.body?.productIds)
        ? request.body!.productIds.slice(0, 500)
        : []
      if (ids.length === 0) return reply.send({ results: {} })

      const num = (v: unknown): number | null => {
        if (v == null) return null
        const n = typeof v === 'string' ? parseFloat(v) : Number(v)
        return Number.isFinite(n) ? n : null
      }

      try {
        const [products, listings] = await Promise.all([
          prisma.product.findMany({
            where: { id: { in: ids } },
            select: { id: true, name: true, basePrice: true, productType: true },
          }),
          prisma.channelListing.findMany({
            where: { productId: { in: ids } },
            select: {
              productId: true, channel: true, marketplace: true, listingStatus: true,
              title: true, masterTitle: true, description: true, masterDescription: true,
              price: true, priceOverride: true, masterPrice: true, platformAttributes: true,
            },
          }),
        ])
        const productById = new Map(products.map((p) => [p.id, p]))

        type Counts = { ready: number; total: number }
        const acc = new Map<
          string,
          { ready: number; total: number; blocked: number; byChannel: Record<string, Counts> }
        >()
        for (const id of ids) acc.set(id, { ready: 0, total: 0, blocked: 0, byChannel: {} })

        for (const l of listings) {
          const a = acc.get(l.productId)
          if (!a) continue
          const p = productById.get(l.productId)
          const pa = (l.platformAttributes as Record<string, any> | null) ?? {}
          const ch = l.channel.toUpperCase()

          const title = l.title ?? l.masterTitle ?? p?.name ?? null
          const price = num(l.priceOverride) ?? num(l.price) ?? num(l.masterPrice) ?? num(p?.basePrice)
          const productType = pa.productType ?? p?.productType ?? null

          const missingRequired =
            !title || String(title).trim() === '' ||
            price == null || price <= 0 ||
            (ch === 'AMAZON' && (!productType || String(productType).trim() === ''))
          const errored = l.listingStatus === 'ERROR'
          const ready = !missingRequired && !errored

          a.total++
          if (ready) a.ready++
          else a.blocked++
          const bc = (a.byChannel[ch] ??= { ready: 0, total: 0 })
          bc.total++
          if (ready) bc.ready++
        }

        const results: Record<
          string,
          { score: number | null; ready: number; total: number; blocked: number; byChannel: Record<string, Counts> }
        > = {}
        for (const [id, a] of acc) {
          results[id] = {
            score: a.total > 0 ? Math.round((a.ready / a.total) * 100) : null,
            ready: a.ready,
            total: a.total,
            blocked: a.blocked,
            byChannel: a.byChannel,
          }
        }
        return reply.send({ results })
      } catch (error: any) {
        request.log?.error({ err: error }, '[products/listing-health/bulk] failed')
        return reply.code(500).send({ error: error?.message ?? String(error) })
      }
    },
  )
}
