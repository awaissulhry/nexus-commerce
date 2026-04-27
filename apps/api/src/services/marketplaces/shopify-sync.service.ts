/**
 * Phase 27: Shopify Sync Service
 * 
 * Handles product synchronization to Shopify with SSOT intelligence.
 * Respects override flags and generates marketplace-specific payloads.
 */

import { logger } from '../../utils/logger.js'

interface ShopifyPayload {
  sku: string
  title: string
  description: string
  price: number
  quantity: number
  images?: Array<{ url: string; alt?: string }>
  attributes?: Record<string, unknown>
}

/**
 * Generate Shopify-specific payload from product data
 */
function generateShopifyPayload(
  product: any,
  channelListing: any,
  finalPrice: number,
  finalTitle: string,
  finalDescription: string,
  finalQuantity: number,
  finalImages: Array<{ url: string; alt?: string }>
): ShopifyPayload {
  return {
    sku: product.sku,
    title: finalTitle,
    description: finalDescription,
    price: finalPrice,
    quantity: finalQuantity,
    images: finalImages,
    attributes: product.categoryAttributes || {},
  }
}

/**
 * Sync product to Shopify with override intelligence
 * 
 * @param product - The SSOT product record
 * @param channelListing - The channel-specific listing with override flags
 * @returns The generated Shopify payload
 */
export async function syncProductToShopify(
  product: any,
  channelListing: any
): Promise<ShopifyPayload> {
  logger.info('🟢 [SHOPIFY SYNC] Starting sync', {
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
      logger.debug('💰 [SHOPIFY] Using master price', {
        masterPrice: product.basePrice,
      })
    } else {
      finalPrice = channelListing.priceOverride || product.basePrice
      logger.debug('💰 [SHOPIFY] Using price override', {
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
      logger.debug('📝 [SHOPIFY] Using master title', {
        title: product.name,
      })
    } else {
      finalTitle = channelListing.titleOverride || product.name
      logger.debug('📝 [SHOPIFY] Using title override', {
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
      logger.debug('📄 [SHOPIFY] Using master description', {
        length: finalDescription.length,
      })
    } else {
      finalDescription = channelListing.descriptionOverride || product.description || ''
      logger.debug('📄 [SHOPIFY] Using description override', {
        length: finalDescription.length,
      })
    }

    // ─────────────────────────────────────────────────────────────────────
    // STEP 4: Calculate final quantity based on override flags
    // ─────────────────────────────────────────────────────────────────────
    let finalQuantity: number

    if (channelListing.followMasterQuantity !== false) {
      finalQuantity = product.totalStock || 0
      logger.debug('📦 [SHOPIFY] Using master quantity', {
        quantity: product.totalStock,
      })
    } else {
      finalQuantity = channelListing.quantityOverride || product.totalStock || 0
      logger.debug('📦 [SHOPIFY] Using quantity override', {
        override: channelListing.quantityOverride,
        fallback: product.totalStock,
      })
    }

    // ─────────────────────────────────────────────────────────────────────
    // STEP 5: Calculate final images based on override flags
    // ─────────────────────────────────────────────────────────────────────
    let finalImages: Array<{ url: string; alt?: string }> = []

    if (channelListing.followMasterImages !== false) {
      // Use master images from product
      if (product.images && Array.isArray(product.images)) {
        finalImages = product.images.map((img: any) => ({
          url: img.url || img.imageUrl || '',
          alt: img.alt || img.altText || undefined,
        }))
      }
      logger.debug('🖼️ [SHOPIFY] Using master images', {
        count: finalImages.length,
      })
    } else {
      // Use channel-specific images if available
      if (channelListing.images && Array.isArray(channelListing.images)) {
        finalImages = channelListing.images.map((img: any) => ({
          url: img.url || img.imageUrl || '',
          alt: img.alt || img.altText || undefined,
        }))
      } else if (product.images && Array.isArray(product.images)) {
        finalImages = product.images.map((img: any) => ({
          url: img.url || img.imageUrl || '',
          alt: img.alt || img.altText || undefined,
        }))
      }
      logger.debug('🖼️ [SHOPIFY] Using image override', {
        count: finalImages.length,
      })
    }

    // ─────────────────────────────────────────────────────────────────────
    // STEP 6: Generate Shopify payload
    // ─────────────────────────────────────────────────────────────────────
    const payload = generateShopifyPayload(
      product,
      channelListing,
      finalPrice,
      finalTitle,
      finalDescription,
      finalQuantity,
      finalImages
    )

    logger.info('[SHOPIFY PAYLOAD]', {
      payload: JSON.stringify(payload, null, 2),
    })

    logger.info('✅ [SHOPIFY SYNC] Payload generated successfully', {
      sku: product.sku,
      price: finalPrice,
      title: finalTitle,
      imageCount: finalImages.length,
    })

    return payload
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    logger.error('❌ [SHOPIFY SYNC] Failed to generate payload', {
      sku: product.sku,
      error: errorMsg,
      stack: error instanceof Error ? error.stack : undefined,
    })
    throw error
  }
}
