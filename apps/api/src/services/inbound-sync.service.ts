/**
 * Phase 10: Inbound Catalog Sync Service (The Vacuum)
 * 
 * Fetches live catalog from Amazon EU and unpacks it into the Phase 9 Matrix structure:
 * - Creates Master Product records
 * - Creates ChannelListings per region
 * - Creates Offer records (FBA detection)
 */

import { PrismaClient } from '@prisma/client'
import { logger } from '../utils/logger.js'
import { AmazonService } from './marketplaces/amazon.service.js'

const prisma = new PrismaClient()

/**
 * Unpack Amazon catalog item into Matrix structure
 * Maps SP-API CatalogItem to Master Product + ChannelListings
 */
async function unpackAmazonCatalogItem(catalogItem: any, amazonService: AmazonService) {
  try {
    logger.info('Unpacking Amazon catalog item', { sku: catalogItem.sku, asin: catalogItem.asin })

    // Fetch rich product details from SP-API
    const productDetails = await amazonService.fetchProductDetails(catalogItem.sku)

    // Step 1: Create or update Master Product
    const masterProduct = await (prisma as any).product.upsert({
      where: { amazonAsin: productDetails.asin },
      update: {
        sku: catalogItem.sku,
        name: productDetails.title,
        description: productDetails.description,
        brand: productDetails.brand,
        manufacturer: productDetails.manufacturer,
        basePrice: productDetails.price || catalogItem.price,
        isMasterProduct: true,
        status: 'ACTIVE',
      },
      create: {
        sku: catalogItem.sku,
        name: productDetails.title,
        description: productDetails.description,
        brand: productDetails.brand,
        manufacturer: productDetails.manufacturer,
        basePrice: productDetails.price || catalogItem.price,
        amazonAsin: productDetails.asin,
        isMasterProduct: true,
        status: 'ACTIVE',
        totalStock: catalogItem.quantity,
      },
    })

    logger.info('Master product created/updated', { productId: masterProduct.id, asin: productDetails.asin })

    // Step 2: Create ChannelListing for the marketplace
    const channelListing = await (prisma as any).channelListing.upsert({
      where: {
        productId_channel_region: {
          productId: masterProduct.id,
          channel: 'AMAZON',
          region: 'EU', // Default to EU region for catalog sync
        },
      },
      update: {
        title: productDetails.title,
        description: productDetails.description,
        price: productDetails.price || catalogItem.price,
        quantity: catalogItem.quantity,
        externalListingId: productDetails.asin,
        syncFromMaster: false,
      },
      create: {
        productId: masterProduct.id,
        channel: 'AMAZON',
        region: 'EU',
        channelMarket: 'AMAZON_EU',
        title: productDetails.title,
        description: productDetails.description,
        price: productDetails.price || catalogItem.price,
        quantity: catalogItem.quantity,
        externalListingId: productDetails.asin,
        syncFromMaster: false,
        syncLocked: false,
      },
    })

    logger.info('Channel listing created', {
      listingId: channelListing.id,
      channel: 'AMAZON',
      region: 'EU',
    })

    // Step 3: Create Offer record (FBA by default for SP-API catalog)
    const createdOffer = await (prisma as any).offer.upsert({
      where: {
        channelListingId_sku: {
          channelListingId: channelListing.id,
          sku: catalogItem.sku,
        },
      },
      update: {
        fulfillmentMethod: 'FBA', // SP-API catalog items are typically FBA
        price: productDetails.price || catalogItem.price,
        quantity: catalogItem.quantity,
        leadTime: 1,
      },
      create: {
        channelListingId: channelListing.id,
        fulfillmentMethod: 'FBA',
        sku: catalogItem.sku,
        price: productDetails.price || catalogItem.price,
        quantity: catalogItem.quantity,
        leadTime: 1,
      },
    })

    logger.info('Offer created', {
      offerId: createdOffer.id,
      fulfillmentMethod: 'FBA',
      sku: catalogItem.sku,
    })

    return masterProduct
  } catch (error) {
    logger.error('Error unpacking Amazon catalog item', {
      sku: catalogItem.sku,
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

/**
 * Main sync function - Vacuum the Amazon EU catalog using real SP-API
 * Fetches active catalog from Amazon and unpacks into Matrix structure
 * 
 * @returns Object with sync results: productsCreated, listingsCreated, offersCreated, errors, totalProcessed
 */
export async function syncAmazonEUCatalog() {
  let amazonService: AmazonService | null = null

  try {
    logger.info('Starting Amazon EU catalog sync (The Vacuum) with real SP-API...')

    // Initialize Amazon SP-API service
    amazonService = new AmazonService()

    const results = {
      productsCreated: 0,
      listingsCreated: 0,
      offersCreated: 0,
      errors: 0,
      totalProcessed: 0,
    }

    // Fetch active catalog from Amazon SP-API
    logger.info('Fetching active catalog from Amazon SP-API...')
    const catalogItems = await amazonService.fetchActiveCatalog()

    logger.info(`Retrieved ${catalogItems.length} active catalog items from Amazon`)
    results.totalProcessed = catalogItems.length

    // Process each catalog item
    for (const catalogItem of catalogItems) {
      try {
        const masterProduct = await unpackAmazonCatalogItem(catalogItem, amazonService)
        results.productsCreated++
        results.listingsCreated++
        results.offersCreated++

        logger.info('Catalog item sync complete', {
          sku: catalogItem.sku,
          asin: catalogItem.asin,
          productId: masterProduct.id,
        })
      } catch (error) {
        results.errors++
        logger.error('Failed to sync catalog item', {
          sku: catalogItem.sku,
          asin: catalogItem.asin,
          error: error instanceof Error ? error.message : String(error),
        })
        // Continue processing other items even if one fails
      }
    }

    logger.info('Amazon EU catalog sync complete', results)
    return results
  } catch (error) {
    logger.error('Critical error during catalog sync', {
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

export default {
  syncAmazonEUCatalog,
}
