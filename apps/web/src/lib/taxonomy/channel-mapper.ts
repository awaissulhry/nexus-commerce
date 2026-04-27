/**
 * Phase 21.2: Channel Mapper & Preview
 * Translates SSOT product data into platform-specific API payloads
 */

import { getCategorySchema, AttributeField } from './schemas'

export interface Product {
  id: string
  sku: string
  name: string
  basePrice: number
  brand?: string
  manufacturer?: string
  upc?: string
  ean?: string
  bulletPoints?: string[]
  categoryAttributes?: Record<string, any>
  productType?: string
}

export interface ChannelOverrides {
  priceOverride?: number
  titleOverride?: string
  descriptionOverride?: string
  bulletPointsOverride?: string[]
}

/**
 * Generate Amazon API payload from SSOT product data
 * Maps internal field names to Amazon's expected field names
 */
export function generateAmazonPayload(
  product: Product,
  overrides?: ChannelOverrides
): Record<string, any> {
  const payload: Record<string, any> = {}

  // Standard fields (always included)
  payload.SKU = product.sku
  payload.ItemName = overrides?.titleOverride || product.name
  payload.StandardPrice = overrides?.priceOverride || product.basePrice
  payload.ProductType = product.productType || 'GENERAL'

  // Optional standard fields
  if (product.brand) {
    payload.Brand = product.brand
  }
  if (product.manufacturer) {
    payload.Manufacturer = product.manufacturer
  }
  if (product.upc) {
    payload.UPC = product.upc
  }
  if (product.ean) {
    payload.EAN = product.ean
  }

  // Description and bullet points
  if (overrides?.descriptionOverride) {
    payload.Description = overrides.descriptionOverride
  }

  const bulletPoints = overrides?.bulletPointsOverride || product.bulletPoints || []
  if (bulletPoints.length > 0) {
    payload.BulletPoints = bulletPoints
  }

  // Category-specific attributes (mapped via amazonKey)
  if (product.categoryAttributes && product.productType) {
    const schema = getCategorySchema(product.productType)
    const schemaMap = new Map<string, AttributeField>()

    schema.forEach((field) => {
      schemaMap.set(field.id, field)
    })

    // Loop through category attributes and map to Amazon keys
    Object.entries(product.categoryAttributes).forEach(([fieldId, value]) => {
      const field = schemaMap.get(fieldId)
      if (field && value !== null && value !== undefined && value !== '') {
        payload[field.amazonKey] = value
      }
    })
  }

  return payload
}

/**
 * Generate Shopify API payload from SSOT product data
 */
export function generateShopifyPayload(
  product: Product,
  overrides?: ChannelOverrides
): Record<string, any> {
  const payload: Record<string, any> = {}

  // Shopify uses different field names
  payload.title = overrides?.titleOverride || product.name
  payload.vendor = product.brand || 'Unknown'
  payload.product_type = product.productType || 'General'
  payload.handle = product.sku.toLowerCase().replace(/[^a-z0-9]+/g, '-')

  // Pricing
  payload.variants = [
    {
      sku: product.sku,
      price: overrides?.priceOverride || product.basePrice,
    },
  ]

  // Description
  if (overrides?.descriptionOverride) {
    payload.body_html = overrides.descriptionOverride
  } else if (product.bulletPoints && product.bulletPoints.length > 0) {
    payload.body_html = `<ul>${product.bulletPoints
      .map((bp) => `<li>${bp}</li>`)
      .join('')}</ul>`
  }

  // Category attributes as metafields
  if (product.categoryAttributes && product.productType) {
    const schema = getCategorySchema(product.productType)
    const schemaMap = new Map<string, AttributeField>()

    schema.forEach((field) => {
      schemaMap.set(field.id, field)
    })

    payload.metafields = Object.entries(product.categoryAttributes)
      .filter(([fieldId, value]) => value !== null && value !== undefined && value !== '')
      .map(([fieldId, value]) => {
        const field = schemaMap.get(fieldId)
        return {
          namespace: 'custom',
          key: fieldId,
          value: String(value),
          value_type: 'string',
        }
      })
  }

  return payload
}

/**
 * Generate eBay API payload from SSOT product data
 */
export function generateEbayPayload(
  product: Product,
  overrides?: ChannelOverrides
): Record<string, any> {
  const payload: Record<string, any> = {}

  // eBay listing fields
  payload.title = overrides?.titleOverride || product.name
  payload.description = overrides?.descriptionOverride || ''
  payload.price = overrides?.priceOverride || product.basePrice
  payload.sku = product.sku

  // Add bullet points to description if not overridden
  if (!overrides?.descriptionOverride && product.bulletPoints && product.bulletPoints.length > 0) {
    payload.description = product.bulletPoints.join('\n')
  }

  // Category attributes as item specifics
  if (product.categoryAttributes && product.productType) {
    const schema = getCategorySchema(product.productType)
    const schemaMap = new Map<string, AttributeField>()

    schema.forEach((field) => {
      schemaMap.set(field.id, field)
    })

    payload.item_specifics = Object.entries(product.categoryAttributes)
      .filter(([fieldId, value]) => value !== null && value !== undefined && value !== '')
      .map(([fieldId, value]) => {
        const field = schemaMap.get(fieldId)
        return {
          name: field?.label || fieldId,
          value: String(value),
        }
      })
  }

  return payload
}

/**
 * Format payload for display in JSON preview
 */
export function formatPayloadForDisplay(payload: Record<string, any>): string {
  return JSON.stringify(payload, null, 2)
}

/**
 * Get all available channel generators
 */
export const channelGenerators = {
  AMAZON: generateAmazonPayload,
  SHOPIFY: generateShopifyPayload,
  EBAY: generateEbayPayload,
} as const

export type ChannelType = keyof typeof channelGenerators
