/**
 * Phase 27: eBay Sync Service
 * 
 * Handles product synchronization to eBay with SSOT intelligence.
 * Respects override flags and generates marketplace-specific payloads.
 */

import { logger } from '../../utils/logger.js'

interface EbayPayload {
  sku: string
  title: string
  description: string
  price: number
  quantity: number
  attributes?: Record<string, unknown>
}

/**
 * Generate eBay-specific payload from product data
 */
function generateEbayPayload(
  product: any,
  channelListing: any,
  finalPrice: number,
  finalTitle: string,
  finalDescription: string,
  finalQuantity: number
): EbayPayload {
  return {
    sku: product.sku,
    title: finalTitle,
    description: finalDescription,
    price: finalPrice,
    quantity: finalQuantity,
    attributes: product.categoryAttributes || {},
  }
}

/**
 * Sync product to eBay with override intelligence
 * 
 * @param product - The SSOT product record
 * @param channelListing - The channel-specific listing with override flags
 * @returns The generated eBay payload
 */
export async function syncProductToEbay(
  product: any,
  channelListing: any
): Promise<EbayPayload> {
  logger.info('🔴 [EBAY SYNC] Starting sync', {
    sku: product.sku,
    channelListingId: channelListing.id,
  })

  try {
    // ─────────────────────────────────────────────────────────────────────
    // STEP 1: Calculate final price based on override flags
    // ─────────────────────────────────────────────────────────────────────
    let finalPrice: number

    if (channelListing.followMasterPrice) {
      finalPrice = product.basePrice
      logger.debug('💰 [EBAY] Using master price', {
        masterPrice: product.basePrice,
      })
    } else {
      finalPrice = channelListing.priceOverride || product.basePrice
      logger.debug('💰 [EBAY] Using price override', {
        override: channelListing.priceOverride,
        fallback: product.basePrice,
      })
    }

    // ─────────────────────────────────────────────────────────────────────
    // STEP 2: Calculate final title based on override flags
    // ─────────────────────────────────────────────────────────────────────
    let finalTitle: string

    if (channelListing.followMasterTitle !== false) {
      finalTitle = product.name
      logger.debug('📝 [EBAY] Using master title', {
        title: product.name,
      })
    } else {
      finalTitle = channelListing.titleOverride || product.name
      logger.debug('📝 [EBAY] Using title override', {
        override: channelListing.titleOverride,
        fallback: product.name,
      })
    }

    // ─────────────────────────────────────────────────────────────────────
    // STEP 3: Calculate final description based on override flags
    // ─────────────────────────────────────────────────────────────────────
    let finalDescription: string

    if (channelListing.followMasterDescription !== false) {
      finalDescription = product.description || ''
      logger.debug('📄 [EBAY] Using master description', {
        length: finalDescription.length,
      })
    } else {
      finalDescription = channelListing.descriptionOverride || product.description || ''
      logger.debug('📄 [EBAY] Using description override', {
        length: finalDescription.length,
      })
    }

    // ─────────────────────────────────────────────────────────────────────
    // STEP 4: Calculate final quantity based on override flags
    // ─────────────────────────────────────────────────────────────────────
    let finalQuantity: number

    if (channelListing.followMasterQuantity !== false) {
      finalQuantity = product.totalStock || 0
      logger.debug('📦 [EBAY] Using master quantity', {
        quantity: product.totalStock,
      })
    } else {
      finalQuantity = channelListing.quantityOverride || product.totalStock || 0
      logger.debug('📦 [EBAY] Using quantity override', {
        override: channelListing.quantityOverride,
        fallback: product.totalStock,
      })
    }

    // ─────────────────────────────────────────────────────────────────────
    // STEP 5: Generate eBay payload
    // ─────────────────────────────────────────────────────────────────────
    const payload = generateEbayPayload(
      product,
      channelListing,
      finalPrice,
      finalTitle,
      finalDescription,
      finalQuantity
    )

    logger.info('[EBAY PAYLOAD]', {
      payload: JSON.stringify(payload, null, 2),
    })

    logger.info('✅ [EBAY SYNC] Payload generated successfully', {
      sku: product.sku,
      price: finalPrice,
      title: finalTitle,
    })

    return payload
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    logger.error('❌ [EBAY SYNC] Failed to generate payload', {
      sku: product.sku,
      error: errorMsg,
      stack: error instanceof Error ? error.stack : undefined,
    })
    throw error
  }
}
