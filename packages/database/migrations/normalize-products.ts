/**
 * Migration Script: Normalize Products to Parent-Child Hierarchical Structure
 * 
 * Purpose: Convert existing products and variations into the Rithum parent-child model
 * 
 * Strategy:
 * 1. Identify products with variations
 * 2. Infer variation themes from SKU patterns
 * 3. Populate variationAttributes from legacy name/value fields
 * 4. Ensure all products have valid status
 * 
 * Usage: npx ts-node packages/database/migrations/normalize-products.ts
 */

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

// Variation theme patterns for SKU matching
const VARIATION_PATTERNS = {
  SIZE_COLOR: /^(.+?)-(XS|S|M|L|XL|XXL|XXXL|\d+)-(BLK|WHT|RED|BLU|GRN|YEL|BRN|GRY|PNK|PRP|NAVY|GOLD|SILVER)$/i,
  SIZE: /^(.+?)-(XS|S|M|L|XL|XXL|XXXL|\d+)$/i,
  COLOR: /^(.+?)-(BLK|WHT|RED|BLU|GRN|YEL|BRN|GRY|PNK|PRP|NAVY|GOLD|SILVER)$/i,
  SIZE_MATERIAL: /^(.+?)-(XS|S|M|L|XL)-(COTTON|POLY|WOOL|SILK|LINEN)$/i,
}

interface VariationGroup {
  theme: string
  confidence: number
}

/**
 * Detect variation theme from a set of SKUs
 * Returns the most likely theme based on pattern matching
 */
function detectVariationTheme(skus: string[]): VariationGroup | null {
  if (skus.length === 0) return null

  const matches: Record<string, number> = {}

  for (const sku of skus) {
    for (const [theme, pattern] of Object.entries(VARIATION_PATTERNS)) {
      if (pattern.test(sku)) {
        matches[theme] = (matches[theme] || 0) + 1
      }
    }
  }

  if (Object.keys(matches).length === 0) {
    // No pattern matched, use generic theme
    return {
      theme: 'MultiAxis',
      confidence: 0.3,
    }
  }

  // Find the theme with highest match count
  const [theme, count] = Object.entries(matches).reduce((a, b) =>
    b[1] > a[1] ? b : a
  )

  const confidence = count / skus.length

  return {
    theme,
    confidence,
  }
}

/**
 * Convert legacy single-axis variation to multi-axis format
 */
function convertToMultiAxis(name: string | null, value: string | null): Record<string, string> {
  if (!name && !value) return {}

  return {
    [name || 'Variant']: value || '',
  }
}

/**
 * Main migration function
 */
async function migrateProducts() {
  console.log('🔄 Starting product normalization migration...\n')

  try {
    // Step 1: Get all products with their variations
    const products = await prisma.product.findMany({
      select: {
        id: true,
        sku: true,
        name: true,
        basePrice: true,
        totalStock: true,
        status: true,
        variationTheme: true,
        variations: {
          select: {
            id: true,
            sku: true,
            name: true,
            value: true,
            variationAttributes: true,
          },
        },
      },
    })

    console.log(`📊 Found ${products.length} products to process\n`)

    let productsUpdated = 0
    let variationsUpdated = 0
    let themeDetected = 0

    // Step 2: Process each product
    for (const product of products) {
      const hasVariations = product.variations.length > 0

      if (!hasVariations) {
        // Standalone product - ensure status is set
        if (!product.status || product.status === '') {
          await prisma.product.update({
            where: { id: product.id },
            data: { status: 'ACTIVE' },
          })
          productsUpdated++
        }
        continue
      }

      // Product has variations - detect theme and update
      const skus = product.variations.map((v) => v.sku)
      const detectedTheme = detectVariationTheme(skus)

      if (detectedTheme && !product.variationTheme) {
        await prisma.product.update({
          where: { id: product.id },
          data: {
            variationTheme: detectedTheme.theme,
            status: product.status || 'ACTIVE',
          },
        })
        productsUpdated++
        themeDetected++

        console.log(
          `✅ Product ${product.sku}: Theme detected as "${detectedTheme.theme}" (confidence: ${(detectedTheme.confidence * 100).toFixed(1)}%)`
        )
      }

      // Step 3: Update variations with variationAttributes
      for (const variation of product.variations as any[]) {
        if (!variation.variationAttributes && (variation.name || variation.value)) {
          const multiAxis = convertToMultiAxis(variation.name, variation.value)

          await (prisma as any).productVariation.update({
            where: { id: variation.id },
            data: {
              variationAttributes: multiAxis,
            },
          })
          variationsUpdated++
        }
      }
    }

    console.log(`\n📈 Migration Summary:`)
    console.log(`   • Products updated: ${productsUpdated}`)
    console.log(`   • Themes detected: ${themeDetected}`)
    console.log(`   • Variations updated: ${variationsUpdated}`)

    // Step 4: Verify data integrity
    const productsWithoutTheme = await (prisma as any).product.count({
      where: {
        AND: [
          {
            variations: {
              some: {},
            },
          },
          {
            variationTheme: null,
          },
        ],
      },
    })

    const variationsWithoutAttributes = await (prisma as any).productVariation.count({
      where: {
        AND: [
          {
            variationAttributes: null,
          },
          {
            name: {
              not: null,
            },
          },
        ],
      },
    })

    console.log(`\n🔍 Data Integrity Check:`)
    console.log(`   • Products with variations but no theme: ${productsWithoutTheme}`)
    console.log(`   • Variations with legacy fields but no attributes: ${variationsWithoutAttributes}`)

    if (productsWithoutTheme === 0 && variationsWithoutAttributes === 0) {
      console.log(`\n✨ Migration completed successfully!`)
    } else {
      console.log(`\n⚠️  Some records may need manual review`)
    }
  } catch (error) {
    console.error('❌ Migration failed:', error)
    throw error
  } finally {
    await prisma.$disconnect()
  }
}

// Run migration
migrateProducts().catch((error) => {
  console.error(error)
  process.exit(1)
})
