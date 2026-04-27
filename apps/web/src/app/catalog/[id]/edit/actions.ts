'use server'

import { prisma } from '@nexus/database'
import { revalidatePath } from 'next/cache'
import type { ProductEditorFormData } from './schema'

export async function updateProduct(productId: string, data: ProductEditorFormData) {
  try {
    // Update the main product record
    await prisma.product.update({
      where: { id: productId },
      data: {
        name: data.name,
        brand: data.brand || null,
        manufacturer: data.manufacturer || null,
        upc: data.upc || null,
        ean: data.ean || null,
        basePrice: data.basePrice,
        totalStock: data.totalStock,
        fulfillmentMethod: data.fulfillmentMethod || null,
        bulletPoints: data.bulletPoints ?? [],
        aPlusContent: data.aPlusContent ? JSON.parse(data.aPlusContent) : null,
        keywords: [],
        weightValue: data.weightValue || null,
        weightUnit: data.weightUnit || null,
        dimLength: data.dimLength || null,
        dimWidth: data.dimWidth || null,
        dimHeight: data.dimHeight || null,
        dimUnit: data.dimUnit || null,
        // ── NEW: Rithum-level fields ──────────────────────────────────
        variationTheme: data.variationTheme || null,
        status: data.status ?? 'ACTIVE',
      },
    })

    // Handle images: delete existing and recreate
    if (data.images && data.images.length > 0) {
      await prisma.productImage.deleteMany({
        where: { productId },
      })
      await prisma.productImage.createMany({
        data: data.images.map((img) => ({
          productId,
          url: img.url,
          alt: img.alt || null,
          type: img.type,
        })),
      })
    }

    // Handle variations: delete existing and recreate with full Rithum-level data
    // Cascade delete handles VariantImage and VariantChannelListing cleanup
    await prisma.productVariation.deleteMany({
      where: { productId },
    })

    if (data.variations && data.variations.length > 0) {
      for (const variation of data.variations) {
        await prisma.productVariation.create({
          data: {
            productId,
            sku: variation.sku,
            // Multi-axis variation attributes (Rithum pattern)
            variationAttributes: variation.variationAttributes && Object.keys(variation.variationAttributes).length > 0
              ? variation.variationAttributes
              : undefined,
            // Legacy single-axis fields (backward compat)
            name: variation.name || null,
            value: variation.value || null,
            // Pricing
            price: variation.price,
            costPrice: variation.costPrice || null,
            minPrice: variation.minPrice || null,
            maxPrice: variation.maxPrice || null,
            mapPrice: variation.mapPrice || null,
            // Inventory
            stock: variation.stock,
            // Per-variant identifiers
            upc: variation.upc || null,
            ean: variation.ean || null,
            gtin: variation.gtin || null,
            // Per-variant physical attributes
            weightValue: variation.weightValue || null,
            weightUnit: variation.weightUnit || null,
            dimLength: variation.dimLength || null,
            dimWidth: variation.dimWidth || null,
            dimHeight: variation.dimHeight || null,
            dimUnit: variation.dimUnit || null,
            // Per-variant fulfillment
            fulfillmentMethod: variation.fulfillmentMethod || null,
            // Per-variant marketplace IDs (read-only from sync, but preserve)
            amazonAsin: variation.amazonAsin || null,
            ebayVariationId: variation.ebayVariationId || null,
            // Status
            isActive: variation.isActive ?? true,
          },
        })
      }

      // Recompute parent totalStock from variant sum
      const totalVariantStock = data.variations.reduce((sum, v) => sum + (v.stock || 0), 0)
      await prisma.product.update({
        where: { id: productId },
        data: { totalStock: totalVariantStock },
      })
    }

    revalidatePath(`/catalog/${productId}/edit`)
    revalidatePath('/catalog')

    return { success: true, message: 'Product updated successfully' }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.error('Failed to update product:', message)
    return { success: false, message: `Failed to update product: ${message}` }
  }
}
