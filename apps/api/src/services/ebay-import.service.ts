/**
 * Phase 25: eBay Ingestion Engine
 * Imports eBay catalog and maps to SSOT database
 * Similar structure to amazon-import.service.ts
 */

import prisma from '../db.js'
import { logger } from '../utils/logger.js'

/**
 * Mock eBay API response structure
 * In production, this would come from actual eBay API calls
 */
interface EbayProduct {
  sku: string
  title: string
  price: number
  productType: string
  attributes: {
    Condition?: string
    Brand?: string
    Manufacturer?: string
    Color?: string
    Material?: string
    [key: string]: string | undefined
  }
  bulletPoints?: string[]
}

/**
 * Reverse mapper: Converts eBay attribute names to our generic categoryAttributes
 * Maps eBay's specific field names back to our schema-agnostic format
 */
function reverseMapEbayAttributes(
  ebayAttributes: Record<string, string | undefined>,
  productType: string
): Record<string, any> {
  const categoryAttributes: Record<string, any> = {}

  // Map eBay Condition → condition
  if (ebayAttributes.Condition) {
    categoryAttributes.condition = ebayAttributes.Condition
  }

  // Map eBay Brand → brand
  if (ebayAttributes.Brand) {
    categoryAttributes.brand = ebayAttributes.Brand
  }

  // Map eBay Color → color
  if (ebayAttributes.Color) {
    categoryAttributes.color = ebayAttributes.Color
  }

  // Map eBay Material → material
  if (ebayAttributes.Material) {
    categoryAttributes.material = ebayAttributes.Material
  }

  // Map eBay Manufacturer → manufacturer
  if (ebayAttributes.Manufacturer) {
    categoryAttributes.manufacturer = ebayAttributes.Manufacturer
  }

  return categoryAttributes
}

/**
 * Mock eBay catalog data for demonstration
 * In production, this would be fetched from actual eBay API
 */
function getMockEbayCatalog(): EbayProduct[] {
  return [
    {
      sku: 'EBAY-RETRO-CAMERA-001',
      title: 'Vintage Retro Film Camera - 35mm',
      price: 79.99,
      productType: 'ELECTRONICS',
      attributes: {
        Condition: 'Used',
        Brand: 'Canon',
        Manufacturer: 'Canon Inc.',
        Color: 'Black',
        Material: 'Metal and Glass',
      },
      bulletPoints: [
        'Classic 35mm film camera',
        'Fully functional',
        'Includes original lens',
        'Great for photography enthusiasts',
        'Vintage condition',
      ],
    },
    {
      sku: 'EBAY-MOUNTAIN-BIKE-001',
      title: 'Mountain Bike - 21 Speed All-Terrain',
      price: 249.99,
      productType: 'SPORTS',
      attributes: {
        Condition: 'New',
        Brand: 'Trek',
        Manufacturer: 'Trek Bicycle Corporation',
        Color: 'Red',
        Material: 'Aluminum Frame',
      },
      bulletPoints: [
        '21-speed gear system',
        'All-terrain tires',
        'Aluminum frame',
        'Front suspension',
        'Perfect for trails and roads',
      ],
    },
    {
      sku: 'EBAY-GAMING-CHAIR-001',
      title: 'Professional Gaming Chair - Ergonomic Design',
      price: 199.99,
      productType: 'FURNITURE',
      attributes: {
        Condition: 'New',
        Brand: 'SecretLab',
        Manufacturer: 'SecretLab Pte Ltd',
        Color: 'Black',
        Material: 'PU Leather and Steel',
      },
      bulletPoints: [
        'Ergonomic design for long gaming sessions',
        'Adjustable height and armrests',
        'Premium PU leather',
        'Steel frame construction',
        'Lumbar support included',
      ],
    },
  ]
}

/**
 * Import eBay catalog and save as Master Products in SSOT database
 * Uses upsert to handle both new products and updates
 */
export async function importEbayCatalog(): Promise<{
  created: number
  updated: number
  total: number
  products: any[]
}> {
  try {
    logger.info('Starting eBay catalog import...')

    // Get mock eBay catalog (in production, call actual eBay API)
    const ebayProducts = getMockEbayCatalog()
    logger.info(`Retrieved ${ebayProducts.length} products from eBay`)

    const results: any[] = []
    let created = 0
    let updated = 0

    // Process each eBay product
    for (const ebayProduct of ebayProducts) {
      try {
        // Reverse map eBay attributes to our generic categoryAttributes
        const categoryAttributes = reverseMapEbayAttributes(
          ebayProduct.attributes,
          ebayProduct.productType
        )

        // Upsert product: create if doesn't exist, update if it does
        const product = await prisma.product.upsert({
          where: { sku: ebayProduct.sku },
          update: {
            name: ebayProduct.title,
            basePrice: ebayProduct.price,
            productType: ebayProduct.productType,
            categoryAttributes,
            bulletPoints: ebayProduct.bulletPoints || [],
            brand: ebayProduct.attributes.Brand,
            manufacturer: ebayProduct.attributes.Manufacturer,
            // Mark as master product from eBay
            isMasterProduct: true,
            validationStatus: 'VALID',
            status: 'ACTIVE',
            // Phase 20 SSOT fields
            syncChannels: ['EBAY'],
            validationErrors: [],
            hasChannelOverrides: false,
          },
          create: {
            sku: ebayProduct.sku,
            name: ebayProduct.title,
            basePrice: ebayProduct.price,
            productType: ebayProduct.productType,
            categoryAttributes,
            bulletPoints: ebayProduct.bulletPoints || [],
            brand: ebayProduct.attributes.Brand,
            manufacturer: ebayProduct.attributes.Manufacturer,
            // Mark as master product from eBay
            isMasterProduct: true,
            validationStatus: 'VALID',
            status: 'ACTIVE',
            // Phase 20 SSOT defaults
            syncChannels: ['EBAY'],
            validationErrors: [],
            hasChannelOverrides: false,
            totalStock: 0,
            costPrice: 0,
            minPrice: ebayProduct.price,
            maxPrice: ebayProduct.price,
          },
        })

        // Track if created or updated
        const isNew = !results.find((r) => r.sku === ebayProduct.sku)
        if (isNew) {
          created++
        } else {
          updated++
        }

        results.push({
          id: product.id,
          sku: product.sku,
          name: product.name,
          basePrice: product.basePrice,
          productType: product.productType,
          categoryAttributes: product.categoryAttributes,
        })

        logger.info(`Imported product: ${ebayProduct.sku}`)
      } catch (error: any) {
        logger.error(`Failed to import product ${ebayProduct.sku}:`, error.message)
      }
    }

    const total = created + updated
    logger.info(
      `eBay import complete: ${created} created, ${updated} updated, ${total} total`
    )

    return {
      created,
      updated,
      total,
      products: results,
    }
  } catch (error: any) {
    logger.error('eBay catalog import failed:', error.message)
    throw new Error(`eBay import failed: ${error.message}`)
  }
}

/**
 * Get import statistics
 */
export async function getEbayImportStats(): Promise<{
  totalProducts: number
  ebayProducts: number
}> {
  try {
    const totalProducts = await prisma.product.count()
    const ebayProducts = await prisma.product.count({
      where: {
        isMasterProduct: true,
        syncChannels: {
          has: 'EBAY',
        },
      },
    })

    return {
      totalProducts,
      ebayProducts,
    }
  } catch (error: any) {
    logger.error('Failed to get eBay import stats:', error.message)
    throw error
  }
}
