/**
 * Phase 29: Matrix Variation Generator - End-to-End Test
 * Tests the complete flow of creating variations using the matrix builder
 */

import prisma from '../apps/api/src/db.js'

interface TestResult {
  name: string
  passed: boolean
  error?: string
  details?: any
}

const results: TestResult[] = []

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn()
    results.push({ name, passed: true })
    console.log(`✓ ${name}`)
  } catch (error: any) {
    results.push({ name, passed: false, error: error.message })
    console.log(`✗ ${name}: ${error.message}`)
  }
}

async function runTests() {
  console.log('\n🧪 Phase 29: Matrix Variation Generator - E2E Tests\n')

  let testParentId: string
  let testProductType = 'CLOTHING'

  // Test 1: Create a parent product
  await test('Create parent product', async () => {
    const parent = await prisma.product.create({
      data: {
        sku: `TEST-PARENT-${Date.now()}`,
        name: 'Test Parent Product',
        basePrice: 29.99,
        productType: testProductType,
        status: 'ACTIVE',
        isParent: false, // Will be set to true by bulk-variants endpoint
        syncChannels: ['AMAZON'],
      },
    })
    testParentId = parent.id
    console.log(`  Parent ID: ${testParentId}`)
  })

  // Test 2: Verify SKU generation helper
  await test('SKU generation - slugify function', async () => {
    const { slugify } = await import('../apps/web/src/lib/sku-generator.ts')
    const tests = [
      { input: 'Red Color', expected: 'red-color' },
      { input: 'Size M', expected: 'size-m' },
      { input: 'Extra Large', expected: 'extra-large' },
      { input: '  Spaces  ', expected: 'spaces' },
    ]

    for (const t of tests) {
      const result = slugify(t.input)
      if (result !== t.expected) {
        throw new Error(`slugify("${t.input}") = "${result}", expected "${t.expected}"`)
      }
    }
  })

  // Test 3: Verify variation matrix generation
  await test('SKU generation - matrix generation', async () => {
    const { generateVariationMatrix, calculateVariationCount } = await import(
      '../apps/web/src/lib/sku-generator.ts'
    )

    const optionTypes = [
      {
        id: 'color',
        name: 'Color',
        values: ['Red', 'Blue', 'Black'],
      },
      {
        id: 'size',
        name: 'Size',
        values: ['S', 'M', 'L'],
      },
    ]

    const variations = generateVariationMatrix('TSHIRT', optionTypes)
    const count = calculateVariationCount(optionTypes)

    if (variations.length !== 9) {
      throw new Error(`Expected 9 variations, got ${variations.length}`)
    }

    if (count !== 9) {
      throw new Error(`Expected count 9, got ${count}`)
    }

    // Verify SKU format (slugify converts to lowercase)
    const expectedSkus = [
      'TSHIRT-black-l',
      'TSHIRT-black-m',
      'TSHIRT-black-s',
      'TSHIRT-blue-l',
      'TSHIRT-blue-m',
      'TSHIRT-blue-s',
      'TSHIRT-red-l',
      'TSHIRT-red-m',
      'TSHIRT-red-s',
    ]

    const actualSkus = variations.map((v) => v.sku).sort()
    const sortedExpected = expectedSkus.sort()

    for (let i = 0; i < actualSkus.length; i++) {
      if (actualSkus[i] !== sortedExpected[i]) {
        throw new Error(
          `SKU mismatch at index ${i}: "${actualSkus[i]}" vs "${sortedExpected[i]}"`
        )
      }
    }

    console.log(`  Generated ${variations.length} variations with correct SKU format`)
  })

  // Test 4: Bulk create variants via API simulation
  await test('Bulk create variants - API endpoint', async () => {
    const { generateVariationMatrix } = await import(
      '../apps/web/src/lib/sku-generator.ts'
    )

    const optionTypes = [
      {
        id: 'color',
        name: 'Color',
        values: ['Red', 'Blue'],
      },
      {
        id: 'size',
        name: 'Size',
        values: ['S', 'M'],
      },
    ]

    const variations = generateVariationMatrix('TEST-PARENT', optionTypes)
    const globalPrice = 49.99
    const globalStock = 100

    // Simulate the bulk-variants endpoint logic
    const createdVariations = await prisma.$transaction(async (tx: any) => {
      // Mark parent as parent
      await tx.product.update({
        where: { id: testParentId },
        data: { isParent: true },
      })

      // Create all child products
      const created = await Promise.all(
        variations.map((variation) =>
          tx.product.create({
            data: {
              sku: variation.sku,
              name: variation.name,
              basePrice: globalPrice,
              totalStock: globalStock,
              parentId: testParentId,
              masterProductId: testParentId,
              isParent: false,
              status: 'ACTIVE',
              productType: testProductType,
              categoryAttributes: variation.optionValues,
              syncChannels: ['AMAZON'],
              validationStatus: 'VALID',
            },
          })
        )
      )

      return created
    })

    if (createdVariations.length !== 4) {
      throw new Error(`Expected 4 variations created, got ${createdVariations.length}`)
    }

    // Verify all variations have correct properties
    for (const variation of createdVariations) {
      // Use approximate comparison for Decimal type
      const priceNum = typeof variation.basePrice === 'number'
        ? variation.basePrice
        : parseFloat(variation.basePrice.toString())
      if (Math.abs(priceNum - globalPrice) > 0.01) {
        throw new Error(`Price mismatch: ${priceNum} vs ${globalPrice}`)
      }
      if (variation.totalStock !== globalStock) {
        throw new Error(`Stock mismatch: ${variation.totalStock} vs ${globalStock}`)
      }
      if (variation.parentId !== testParentId) {
        throw new Error(`Parent ID mismatch: ${variation.parentId} vs ${testParentId}`)
      }
      if (!variation.sku.startsWith('TEST-PARENT-')) {
        throw new Error(`Invalid SKU format: ${variation.sku}`)
      }
    }

    console.log(`  Created ${createdVariations.length} variations successfully`)
  })

  // Test 5: Verify parent is marked as parent
  await test('Parent product marked as parent', async () => {
    const parent = await prisma.product.findUnique({
      where: { id: testParentId },
    })

    if (!parent?.isParent) {
      throw new Error('Parent product not marked as isParent: true')
    }
  })

  // Test 6: Verify children are linked to parent
  await test('Child products linked to parent', async () => {
    const children = await prisma.product.findMany({
      where: { parentId: testParentId },
    })

    if (children.length !== 4) {
      throw new Error(`Expected 4 children, found ${children.length}`)
    }

    for (const child of children) {
      if (child.parentId !== testParentId) {
        throw new Error(`Child ${child.id} not linked to parent`)
      }
      if (child.isParent) {
        throw new Error(`Child ${child.id} marked as parent`)
      }
    }

    console.log(`  Found ${children.length} child products linked to parent`)
  })

  // Test 7: Verify SKU uniqueness
  await test('SKU uniqueness validation', async () => {
    const children = await prisma.product.findMany({
      where: { parentId: testParentId },
      select: { sku: true },
    })

    const skus = children.map((c) => c.sku)
    const uniqueSkus = new Set(skus)

    if (uniqueSkus.size !== skus.length) {
      throw new Error('Duplicate SKUs found among child products')
    }

    console.log(`  All ${skus.length} SKUs are unique`)
  })

  // Test 8: Verify category attributes inheritance
  await test('Category attributes inheritance', async () => {
    const children = await prisma.product.findMany({
      where: { parentId: testParentId },
    })

    for (const child of children) {
      if (!child.categoryAttributes || Object.keys(child.categoryAttributes).length === 0) {
        throw new Error(`Child ${child.id} has no category attributes`)
      }
    }

    console.log(`  All children have category attributes`)
  })

  // Test 9: Cleanup
  await test('Cleanup test data', async () => {
    // Delete all children
    await prisma.product.deleteMany({
      where: { parentId: testParentId },
    })

    // Delete parent
    await prisma.product.delete({
      where: { id: testParentId },
    })

    console.log(`  Cleaned up test data`)
  })

  // Print summary
  console.log('\n' + '='.repeat(60))
  const passed = results.filter((r) => r.passed).length
  const total = results.length
  console.log(`\n📊 Test Results: ${passed}/${total} passed\n`)

  if (passed === total) {
    console.log('✅ All tests passed!')
  } else {
    console.log('❌ Some tests failed:\n')
    results
      .filter((r) => !r.passed)
      .forEach((r) => {
        console.log(`  • ${r.name}`)
        console.log(`    Error: ${r.error}`)
      })
  }

  console.log('\n' + '='.repeat(60) + '\n')

  process.exit(passed === total ? 0 : 1)
}

// Run tests
runTests().catch((error) => {
  console.error('Test suite error:', error)
  process.exit(1)
})
