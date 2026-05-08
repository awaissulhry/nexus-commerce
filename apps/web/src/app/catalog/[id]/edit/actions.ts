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

    // TECH_DEBT #43.5 — variation editing on this page wrote to the
    // empty ProductVariation table (silent no-op in production). The
    // canonical variant mechanism is Product.parentId children, edited
    // through /products. This block is removed; product-level fields
    // above still update.

    revalidatePath(`/catalog/${productId}/edit`)
    revalidatePath('/catalog')

    return { success: true, message: 'Product updated successfully' }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.error('Failed to update product:', message)
    return { success: false, message: `Failed to update product: ${message}` }
  }
}
