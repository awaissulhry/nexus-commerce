/**
 * Phase 9: Matrix API Routes (Fastify)
 * 
 * Endpoints for the Multi-Channel Matrix Edit Product experience
 * Provides comprehensive product data with all channel listings and offers
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { assertRequestPermission } from '../lib/auth/request-permission.js'


/**
 * GET /api/products/:id/matrix
 * 
 * Fetches the complete product matrix including:
 * - Master Product data
 * - All ChannelListings (per platform/region)
 * - All Offers (per fulfillment method)
 * - All ChannelListingImages (platform-specific images)
 * - Master ProductImages
 */
async function getProductMatrix(request: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = request.params as { id: string }

    logger.info('Fetching product matrix', { productId: id })

    // Fetch master product with all relations
    const product = await (prisma as any).product.findUnique({
      where: { id },
      include: {
        channelListings: {
          include: {
            offers: {
              orderBy: { fulfillmentMethod: 'asc' },
            },
            images: {
              where: { channelListingId: { not: null } },
              orderBy: { sortOrder: 'asc' },
            },
          },
          orderBy: [{ channel: 'asc' }, { region: 'asc' }],
        },
        channelListingImages: {
          where: { productId: id, channelListingId: null },
          orderBy: { sortOrder: 'asc' },
        },
      },
    })

    if (!product) {
      logger.warn('Product not found', { productId: id })
      return reply.status(404).send({ error: 'Product not found' })
    }

    // Helper function to convert Decimal fields to numbers
    const convertDecimalToNumber = (value: any): any => {
      if (value === null || value === undefined) return value
      if (typeof value === 'object' && value.constructor.name === 'Decimal') {
        return parseFloat(value.toString())
      }
      return value
    }

    // Build response with proper structure
    const matrixData = {
      product: {
        id: product.id,
        sku: product.sku,
        name: product.name,
        basePrice: convertDecimalToNumber(product.basePrice),
        totalStock: product.totalStock,
        brand: product.brand,
        manufacturer: product.manufacturer,
        productType: product.productType,
        status: product.status,
        isMasterProduct: product.isMasterProduct,
        bulletPoints: product.bulletPoints,
        keywords: product.keywords,
        categoryAttributes: product.categoryAttributes,
        costPrice: convertDecimalToNumber(product.costPrice),
        minPrice: convertDecimalToNumber(product.minPrice),
        maxPrice: convertDecimalToNumber(product.maxPrice),
        createdAt: product.createdAt,
        updatedAt: product.updatedAt,
      },
      channelListings: product.channelListings.map((listing: any) => ({
        id: listing.id,
        channel: listing.channel,
        region: listing.region,
        channelMarket: listing.channelMarket,
        title: listing.title,
        description: listing.description,
        price: convertDecimalToNumber(listing.price),
        quantity: listing.quantity,
        syncFromMaster: listing.syncFromMaster,
        syncLocked: listing.syncLocked,
        externalListingId: listing.externalListingId,
        // ── PHASE 12b: Variation Matrix ────────────────────────────
        variationTheme: listing.variationTheme,
        variationMapping: listing.variationMapping,
        offers: listing.offers.map((offer: any) => ({
          ...offer,
          price: convertDecimalToNumber(offer.price),
          minPrice: convertDecimalToNumber(offer.minPrice),
          maxPrice: convertDecimalToNumber(offer.maxPrice),
          costPrice: convertDecimalToNumber(offer.costPrice),
        })),
        images: listing.images,
      })),
      masterImages: product.channelListingImages,
    }

    logger.info('Product matrix fetched successfully', {
      productId: id,
      listingCount: product.channelListings.length,
    })

    return reply.send(matrixData)
  } catch (error) {
    logger.error('Error fetching product matrix', {
      error: error instanceof Error ? error.message : String(error),
    })
    return reply.status(500).send({ error: 'Failed to fetch product matrix' })
  }
}

/**
 * PUT /api/products/:id/matrix/channel-listing/:listingId
 * Update a channel listing
 */
async function updateChannelListing(request: FastifyRequest, reply: FastifyReply) {
  try {
    const { id, listingId } = request.params as { id: string; listingId: string }
    const body = request.body as any

    logger.info('Updating channel listing', { productId: id, listingId })

    const updated = await (prisma as any).channelListing.update({
      where: { id: listingId, productId: id },
      data: {
        title: body.title,
        description: body.description,
        price: body.price,
        quantity: body.quantity,
        syncFromMaster: body.syncFromMaster,
        syncLocked: body.syncLocked,
        externalListingId: body.externalListingId,
        // ── PHASE 12b: Variation Matrix ────────────────────────────
        variationTheme: body.variationTheme,
        variationMapping: body.variationMapping,
      },
      include: {
        offers: true,
        images: true,
      },
    })

    logger.info('Channel listing updated', { listingId, variationTheme: body.variationTheme })
    return reply.send(updated)
  } catch (error) {
    logger.error('Error updating channel listing', {
      error: error instanceof Error ? error.message : String(error),
    })
    return reply.status(500).send({ error: 'Failed to update channel listing' })
  }
}

/**
 * POST /api/products/:id/matrix/channel-listing
 * Create a new channel listing
 */
async function createChannelListing(request: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = request.params as { id: string }
    const body = request.body as any

    logger.info('Creating channel listing', { productId: id })

    const listing = await (prisma as any).channelListing.create({
      data: {
        productId: id,
        channel: body.channel,
        region: body.region,
        title: body.title,
        description: body.description,
        price: body.price,
        quantity: body.quantity,
        syncFromMaster: body.syncFromMaster || true,
        syncLocked: body.syncLocked || false,
        // ── PHASE 12b: Variation Matrix ────────────────────────────
        variationTheme: body.variationTheme,
        variationMapping: body.variationMapping,
      },
      include: {
        offers: true,
        images: true,
      },
    })

    logger.info('Channel listing created', { listingId: listing.id })
    return reply.status(201).send(listing)
  } catch (error) {
    logger.error('Error creating channel listing', {
      error: error instanceof Error ? error.message : String(error),
    })
    return reply.status(500).send({ error: 'Failed to create channel listing' })
  }
}

// Presence D24: legacy Offer writers retired; use the studio Matrix write door.
export async function matrixRoutes(fastify: FastifyInstance) {
  fastify.get('/api/products/:id/matrix', getProductMatrix)
  fastify.post('/api/products/:id/matrix/channel-listing', createChannelListing)
  fastify.put('/api/products/:id/matrix/channel-listing/:listingId', {
    preHandler: async (request) => assertRequestPermission(request, 'products.edit'),
  }, updateChannelListing)
}
