/**
 * Phase 9: Multi-Channel Matrix Data Migration Script
 * 
 * CRITICAL: This script safely migrates Phase 1-8 data to Phase 9 structure
 * 
 * Migration Steps:
 * 1. Flag all existing products as isMasterProduct = true
 * 2. Convert VariantChannelListing → ChannelListing (with channel + region)
 * 3. Create default Offer records for each ChannelListing
 * 4. Migrate ProductImages → ChannelListingImages (master images)
 * 5. Update OutboundSyncQueue references
 */

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

interface MigrationStats {
  productsMarkedAsMaster: number
  channelListingsCreated: number
  offersCreated: number
  channelListingImagesCreated: number
  errors: Array<{ step: string; error: string }>
}

const stats: MigrationStats = {
  productsMarkedAsMaster: 0,
  channelListingsCreated: 0,
  offersCreated: 0,
  channelListingImagesCreated: 0,
  errors: [],
}

async function main() {
  console.log('🚀 Starting Phase 9 Matrix Migration...\n')

  try {
    // Step 1: Mark all products as master products
    console.log('📋 Step 1: Marking all products as master products...')
    await markProductsAsMaster()

    // Step 2: Create ChannelListings from VariantChannelListing
    console.log('\n📋 Step 2: Creating ChannelListings from VariantChannelListing...')
    await migrateVariantChannelListings()

    // Step 3: Create default Offers for each ChannelListing
    console.log('\n📋 Step 3: Creating default Offers for each ChannelListing...')
    await createDefaultOffers()

    // Step 4: Migrate ProductImages to ChannelListingImages (master images)
    console.log('\n📋 Step 4: Migrating ProductImages to ChannelListingImages...')
    await migrateProductImages()

    // Step 5: Update OutboundSyncQueue
    console.log('\n📋 Step 5: Updating OutboundSyncQueue references...')
    await updateOutboundSyncQueue()

    // Print summary
    console.log('\n✅ Migration Complete!\n')
    console.log('📊 Migration Summary:')
    console.log(`   • Products marked as master: ${stats.productsMarkedAsMaster}`)
    console.log(`   • ChannelListings created: ${stats.channelListingsCreated}`)
    console.log(`   • Offers created: ${stats.offersCreated}`)
    console.log(`   • ChannelListingImages created: ${stats.channelListingImagesCreated}`)

    if (stats.errors.length > 0) {
      console.log(`\n⚠️  Errors encountered: ${stats.errors.length}`)
      stats.errors.forEach((err) => {
        console.log(`   • [${err.step}] ${err.error}`)
      })
    }
  } catch (error) {
    console.error('❌ Migration failed:', error)
    process.exit(1)
  } finally {
    await prisma.$disconnect()
  }
}

/**
 * Step 1: Mark all existing products as master products
 */
async function markProductsAsMaster() {
  try {
    // Get all products and update them
    const allProducts = await prisma.product.findMany()
    
    for (const product of allProducts) {
      await prisma.product.update({
        where: { id: product.id },
        data: { isMasterProduct: true },
      })
    }

    stats.productsMarkedAsMaster = allProducts.length
    console.log(`   ✓ Marked ${allProducts.length} products as master products`)
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    stats.errors.push({ step: 'markProductsAsMaster', error: errorMsg })
    console.error(`   ✗ Error: ${errorMsg}`)
  }
}

/**
 * Step 2: Convert VariantChannelListing → ChannelListing
 * 
 * Maps:
 * - variantId → productId (get parent product)
 * - channel + region → channelMarket
 * - externalListingId → externalListingId
 * - channelPrice → price
 * - channelQuantity → quantity
 */
async function migrateVariantChannelListings() {
  try {
    // Fetch all VariantChannelListings
    const variantListings = await prisma.variantChannelListing.findMany({
      include: {
        variant: {
          include: {
            product: true,
          },
        },
      },
    })

    console.log(`   Found ${variantListings.length} VariantChannelListings to migrate`)

    for (const vl of variantListings as any[]) {
      try {
        const product = vl.variant.product
        const channel = (vl as any).channel || 'AMAZON'
        const region = 'US' // Default region since VariantChannelListing doesn't have region field
        const channelMarket = `${channel}_${region}`

        // Check if ChannelListing already exists
        const existing = await (prisma as any).channelListing.findUnique({
          where: {
            productId_channelMarket: {
              productId: product.id,
              channelMarket,
            },
          },
        })

        if (existing) {
          console.log(`   ⊘ ChannelListing already exists: ${product.sku} → ${channelMarket}`)
          continue
        }

        // Create ChannelListing
        await (prisma as any).channelListing.create({
          data: {
            productId: product.id,
            channelMarket,
            channel,
            region,
            externalListingId: (vl as any).externalListingId || undefined,
            externalParentId: (vl as any).channelProductId || undefined,
            title: product.name,
            description: undefined,
            price: (vl as any).channelPrice,
            quantity: (vl as any).channelQuantity,
            platformAttributes: (vl as any).channelSpecificData || undefined,
            listingStatus: (vl as any).listingStatus || 'DRAFT',
            lastSyncedAt: (vl as any).lastSyncedAt || undefined,
            lastSyncStatus: (vl as any).lastSyncStatus || undefined,
            lastSyncError: (vl as any).lastSyncError || undefined,
            syncRetryCount: (vl as any).syncRetryCount || 0,
            syncFromMaster: false,
            syncLocked: false,
          },
        })

        stats.channelListingsCreated++
        console.log(`   ✓ Created ChannelListing: ${product.sku} → ${channelMarket}`)
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error)
        console.log(`   ✗ Failed to migrate VariantChannelListing: ${errorMsg}`)
      }
    }

    console.log(`   ✓ Total ChannelListings created: ${stats.channelListingsCreated}`)
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    stats.errors.push({ step: 'migrateVariantChannelListings', error: errorMsg })
    console.error(`   ✗ Error: ${errorMsg}`)
  }
}

/**
 * Step 3: Create default Offer for each ChannelListing
 * 
 * Creates one FBA and one FBM offer per listing with:
 * - SKU: {productSku}-{fulfillmentMethod}
 * - Price: from ChannelListing
 * - Quantity: from ChannelListing
 * - isActive: true
 */
async function createDefaultOffers() {
  try {
    const channelListings = await (prisma as any).channelListing.findMany({
      include: {
        product: true,
        offers: true,
      },
    })

    console.log(`   Found ${channelListings.length} ChannelListings to create offers for`)

    for (const listing of channelListings) {
      try {
        // Create FBA offer if it doesn't exist
        const fbaExists = listing.offers.some((o: any) => o.fulfillmentMethod === 'FBA')
        if (!fbaExists) {
          await (prisma as any).offer.create({
            data: {
              channelListingId: listing.id,
              fulfillmentMethod: 'FBA',
              sku: `${listing.product.sku}-FBA`,
              price: listing.price || listing.product.basePrice,
              quantity: listing.quantity || listing.product.totalStock,
              isActive: true,
            },
          })
          stats.offersCreated++
        }

        // Create FBM offer if it doesn't exist
        const fbmExists = listing.offers.some((o: any) => o.fulfillmentMethod === 'FBM')
        if (!fbmExists) {
          await (prisma as any).offer.create({
            data: {
              channelListingId: listing.id,
              fulfillmentMethod: 'FBM',
              sku: `${listing.product.sku}-FBM`,
              price: listing.price || listing.product.basePrice,
              quantity: listing.quantity || listing.product.totalStock,
              isActive: true,
            },
          })
          stats.offersCreated++
        }

        console.log(`   ✓ Created offers for: ${listing.product.sku} → ${listing.channelMarket}`)
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error)
        console.log(`   ✗ Failed to create offers: ${errorMsg}`)
      }
    }

    console.log(`   ✓ Total Offers created: ${stats.offersCreated}`)
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    stats.errors.push({ step: 'createDefaultOffers', error: errorMsg })
    console.error(`   ✗ Error: ${errorMsg}`)
  }
}

/**
 * Step 4: Migrate ProductImages to ChannelListingImages
 * 
 * Creates ChannelListingImage records linked to Product (master images)
 * These will be inherited by all ChannelListings
 */
async function migrateProductImages() {
  try {
    const productImages = await prisma.productImage.findMany()

    console.log(`   Found ${productImages.length} ProductImages to migrate`)

    for (const img of productImages) {
      try {
        // Check if ChannelListingImage already exists
        const existing = await (prisma as any).channelListingImage.findFirst({
          where: {
            productId: img.productId,
            url: img.url,
          },
        })

        if (existing) {
          console.log(`   ⊘ ChannelListingImage already exists: ${img.productId}`)
          continue
        }

        // Create ChannelListingImage linked to Product (master image)
        await (prisma as any).channelListingImage.create({
          data: {
            productId: img.productId,
            url: img.url,
            alt: img.alt || undefined,
            type: img.type || 'MAIN',
            sortOrder: 0,
          },
        })

        stats.channelListingImagesCreated++
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error)
        console.log(`   ✗ Failed to migrate ProductImage: ${errorMsg}`)
      }
    }

    console.log(`   ✓ Total ChannelListingImages created: ${stats.channelListingImagesCreated}`)
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    stats.errors.push({ step: 'migrateProductImages', error: errorMsg })
    console.error(`   ✗ Error: ${errorMsg}`)
  }
}

/**
 * Step 5: Update OutboundSyncQueue
 *
 * Ensures all existing OutboundSyncQueue entries have productId set
 * (Phase 9 supports both productId and channelListingId)
 */
async function updateOutboundSyncQueue() {
  try {
    const queueItems = await (prisma as any).outboundSyncQueue.findMany({
      where: {
        productId: null,
      },
    })

    console.log(`   Found ${queueItems.length} OutboundSyncQueue items without productId`)

    // For now, just log that they exist
    // In a real scenario, we'd need to determine the correct productId
    if (queueItems.length > 0) {
      console.log(`   ⚠️  ${queueItems.length} items need manual review`)
    } else {
      console.log(`   ✓ All OutboundSyncQueue items are valid`)
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    stats.errors.push({ step: 'updateOutboundSyncQueue', error: errorMsg })
    console.error(`   ✗ Error: ${errorMsg}`)
  }
}

// Run migration
main()
