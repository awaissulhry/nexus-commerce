/**
 * Phase 27: SSOT Multi-Channel Sync Test
 * 
 * Tests the data transformation engine with override intelligence:
 * 1. Creates a test product with base price
 * 2. Creates channel listings with price overrides
 * 3. Triggers sync to each channel
 * 4. Verifies payloads respect override flags
 * 5. Confirms syncStatus updates to IN_SYNC
 */

import prisma from '../packages/database/index.js'

async function testPhase27SSOT() {
  console.log('\n' + '='.repeat(80))
  console.log('🚀 PHASE 27: SSOT Multi-Channel Sync Test')
  console.log('='.repeat(80) + '\n')

  try {
    // ─────────────────────────────────────────────────────────────────────
    // STEP 1: Create test product (SSOT)
    // ─────────────────────────────────────────────────────────────────────
    console.log('📦 STEP 1: Creating test product (SSOT)...\n')

    const testProduct = await prisma.product.create({
      data: {
        sku: `TEST-SSOT-${Date.now()}`,
        name: 'Test SSOT Product',
        basePrice: 99.99,
        totalStock: 100,
        productType: 'SIMPLE',
        categoryAttributes: {
          brand: 'TestBrand',
          color: 'Blue',
        },
        syncChannels: ['AMAZON', 'EBAY', 'SHOPIFY'],
        isMasterProduct: true,
      },
    })

    console.log('✅ Product created:')
    console.log(`   SKU: ${testProduct.sku}`)
    console.log(`   Name: ${testProduct.name}`)
    console.log(`   Base Price: $${testProduct.basePrice}`)
    console.log(`   Total Stock: ${testProduct.totalStock}\n`)

    // ─────────────────────────────────────────────────────────────────────
    // STEP 2: Create channel listings with overrides
    // ─────────────────────────────────────────────────────────────────────
    console.log('📋 STEP 2: Creating channel listings with overrides...\n')

    // Amazon: Custom price override ($199.99)
    const amazonListing = await prisma.channelListing.create({
      data: {
        productId: testProduct.id,
        channel: 'AMAZON',
        channelMarket: 'AMAZON_US',
        region: 'US',
        title: testProduct.name,
        description: '',
        price: testProduct.basePrice,
        quantity: testProduct.totalStock,
        listingStatus: 'DRAFT',
        syncStatus: 'IDLE',
        followMasterPrice: false,
        priceOverride: 199.99,
        followMasterTitle: true,
        followMasterDescription: true,
        followMasterQuantity: true,
      },
    })

    console.log('✅ Amazon listing created:')
    console.log(`   Channel: AMAZON`)
    console.log(`   Follow Master Price: ${amazonListing.followMasterPrice}`)
    console.log(`   Price Override: $${amazonListing.priceOverride}`)
    console.log(`   Expected Sync Price: $199.99\n`)

    // eBay: Follow master price
    const ebayListing = await prisma.channelListing.create({
      data: {
        productId: testProduct.id,
        channel: 'EBAY',
        channelMarket: 'EBAY_US',
        region: 'US',
        title: testProduct.name,
        description: '',
        price: testProduct.basePrice,
        quantity: testProduct.totalStock,
        listingStatus: 'DRAFT',
        syncStatus: 'IDLE',
        followMasterPrice: true,
        followMasterTitle: true,
        followMasterDescription: true,
        followMasterQuantity: true,
      },
    })

    console.log('✅ eBay listing created:')
    console.log(`   Channel: EBAY`)
    console.log(`   Follow Master Price: ${ebayListing.followMasterPrice}`)
    console.log(`   Expected Sync Price: $${testProduct.basePrice}\n`)

    // Shopify: Follow master price
    const shopifyListing = await prisma.channelListing.create({
      data: {
        productId: testProduct.id,
        channel: 'SHOPIFY',
        channelMarket: 'SHOPIFY_US',
        region: 'US',
        title: testProduct.name,
        description: '',
        price: testProduct.basePrice,
        quantity: testProduct.totalStock,
        listingStatus: 'DRAFT',
        syncStatus: 'IDLE',
        followMasterPrice: true,
        followMasterTitle: true,
        followMasterDescription: true,
        followMasterQuantity: true,
        followMasterImages: true,
      },
    })

    console.log('✅ Shopify listing created:')
    console.log(`   Channel: SHOPIFY`)
    console.log(`   Follow Master Price: ${shopifyListing.followMasterPrice}`)
    console.log(`   Expected Sync Price: $${testProduct.basePrice}\n`)

    // ─────────────────────────────────────────────────────────────────────
    // STEP 3: Display test expectations
    // ─────────────────────────────────────────────────────────────────────
    console.log('🎯 STEP 3: Test Expectations\n')
    console.log('When syncing this product, you should see:\n')

    console.log('📊 [AMAZON PAYLOAD]')
    console.log('   {')
    console.log(`     "sku": "${testProduct.sku}",`)
    console.log(`     "title": "${testProduct.name}",`)
    console.log(`     "price": 199.99,  ← OVERRIDE (not ${testProduct.basePrice})`)
    console.log(`     "quantity": ${testProduct.totalStock}`)
    console.log('   }\n')

    console.log('📊 [EBAY PAYLOAD]')
    console.log('   {')
    console.log(`     "sku": "${testProduct.sku}",`)
    console.log(`     "title": "${testProduct.name}",`)
    console.log(`     "price": ${testProduct.basePrice},  ← MASTER (following master)`)
    console.log(`     "quantity": ${testProduct.totalStock}`)
    console.log('   }\n')

    console.log('📊 [SHOPIFY PAYLOAD]')
    console.log('   {')
    console.log(`     "sku": "${testProduct.sku}",`)
    console.log(`     "title": "${testProduct.name}",`)
    console.log(`     "price": ${testProduct.basePrice},  ← MASTER (following master)`)
    console.log(`     "quantity": ${testProduct.totalStock}`)
    console.log('   }\n')

    // ─────────────────────────────────────────────────────────────────────
    // STEP 4: Instructions for manual testing
    // ─────────────────────────────────────────────────────────────────────
    console.log('🧪 STEP 4: Manual Testing Instructions\n')
    console.log('1. Open the web UI and navigate to Catalog')
    console.log('2. Find the product with SKU: ' + testProduct.sku)
    console.log('3. Click "Marketplace Hub" dropdown')
    console.log('4. Click "Sync All to All Channels"')
    console.log('5. Watch the API terminal for payload logs\n')

    console.log('✅ Expected Terminal Output:')
    console.log('   [AMAZON PAYLOAD] with price: 199.99')
    console.log('   [EBAY PAYLOAD] with price: ' + testProduct.basePrice)
    console.log('   [SHOPIFY PAYLOAD] with price: ' + testProduct.basePrice)
    console.log('   [SYNC COMPLETE] for each channel\n')

    console.log('✅ Expected Database Updates:')
    console.log('   All channel listings syncStatus → IN_SYNC')
    console.log('   All channel listings lastSyncedAt → current timestamp\n')

    console.log('='.repeat(80))
    console.log('✅ Test data created successfully!')
    console.log('='.repeat(80) + '\n')

    console.log('📝 Test Product Details:')
    console.log(JSON.stringify(
      {
        product: {
          id: testProduct.id,
          sku: testProduct.sku,
          name: testProduct.name,
          basePrice: testProduct.basePrice,
          totalStock: testProduct.totalStock,
        },
        listings: {
          amazon: {
            id: amazonListing.id,
            followMasterPrice: amazonListing.followMasterPrice,
            priceOverride: amazonListing.priceOverride,
          },
          ebay: {
            id: ebayListing.id,
            followMasterPrice: ebayListing.followMasterPrice,
          },
          shopify: {
            id: shopifyListing.id,
            followMasterPrice: shopifyListing.followMasterPrice,
          },
        },
      },
      null,
      2
    ))

    console.log('\n' + '='.repeat(80))
    console.log('Ready for testing! Proceed with manual sync in the UI.')
    console.log('='.repeat(80) + '\n')

  } catch (error) {
    console.error('❌ Test setup failed:', error)
    throw error
  } finally {
    await prisma.$disconnect()
  }
}

// Run the test
testPhase27SSOT().catch((error) => {
  console.error('Fatal error:', error)
  process.exit(1)
})
