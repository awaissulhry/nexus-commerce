#!/usr/bin/env node

/**
 * Test script to verify Orders & Financials Phase 2 implementation
 * Tests:
 * 1. Database schema and relations
 * 2. Order creation with proper foreign keys
 * 3. OrderItem → Product linking
 * 4. FinancialTransaction creation
 * 5. Cascade deletes
 */

import prisma from "../packages/database/index.js";

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  details?: any;
}

const results: TestResult[] = [];

async function runTests() {
  console.log("🧪 Starting Orders & Financials Phase 2 Tests\n");

  try {
    // Test 1: Create sample product
    console.log("Test 1: Creating sample product...");
    const product = await (prisma.product as any).create({
      data: {
        sku: "TEST-SKU-001",
        name: "Test Product",
        basePrice: 99.99,
        amazonAsin: "B0123456789",
        parentAsin: "B0123456780",
      },
    });
    results.push({
      name: "Create sample product",
      passed: !!product.id,
      details: { productId: product.id, sku: product.sku },
    });
    console.log(`✅ Product created: ${product.id}\n`);

    // Test 2: Create sample order
    console.log("Test 2: Creating sample order...");
    const order = await (prisma.order as any).create({
      data: {
        amazonOrderId: "TEST-ORDER-001",
        purchaseDate: new Date("2024-04-20"),
        status: "Shipped",
        fulfillmentChannel: "AFN",
        buyerName: "Test Buyer",
        buyerEmail: "test@example.com",
        shippingAddress: {
          street1: "123 Test St",
          city: "Test City",
          state: "TS",
          postalCode: "12345",
          country: "US",
        },
        totalAmount: 299.97,
        currencyCode: "USD",
      },
    });
    results.push({
      name: "Create sample order",
      passed: !!order.id,
      details: { orderId: order.id, amazonOrderId: order.amazonOrderId },
    });
    console.log(`✅ Order created: ${order.id}\n`);

    // Test 3: Create order items with product linking
    console.log("Test 3: Creating order items with product linking...");
    const orderItem1 = await (prisma.orderItem as any).create({
      data: {
        amazonOrderItemId: "TEST-ITEM-001",
        orderId: order.id,
        productId: product.id,
        sellerSku: "TEST-SKU-001",
        asin: "B0123456789",
        title: "Test Product - Item 1",
        quantity: 2,
        itemPrice: 99.99,
        itemTax: 8.0,
        shippingPrice: 5.0,
        shippingTax: 0.4,
        subtotal: 199.98,
        totalWithShipping: 205.38,
        fulfillmentStatus: "Shipped",
      },
    });
    results.push({
      name: "Create order item with product link",
      passed: !!orderItem1.id && orderItem1.productId === product.id,
      details: {
        orderItemId: orderItem1.id,
        productId: orderItem1.productId,
        linkedCorrectly: orderItem1.productId === product.id,
      },
    });
    console.log(`✅ Order item created: ${orderItem1.id}\n`);

    // Test 4: Create order item without product (nullable productId)
    console.log("Test 4: Creating order item without product link...");
    const orderItem2 = await (prisma.orderItem as any).create({
      data: {
        amazonOrderItemId: "TEST-ITEM-002",
        orderId: order.id,
        productId: null, // No product link - for manual review
        sellerSku: "UNKNOWN-SKU",
        asin: "B9999999999",
        title: "Unknown Product",
        quantity: 1,
        itemPrice: 49.99,
        itemTax: 4.0,
        shippingPrice: 5.0,
        shippingTax: 0.4,
        subtotal: 49.99,
        totalWithShipping: 54.99,
        fulfillmentStatus: "Pending",
      },
    });
    results.push({
      name: "Create order item without product (nullable)",
      passed: !!orderItem2.id && orderItem2.productId === null,
      details: {
        orderItemId: orderItem2.id,
        productId: orderItem2.productId,
        nullableWorking: orderItem2.productId === null,
      },
    });
    console.log(`✅ Order item created without product: ${orderItem2.id}\n`);

    // Test 5: Create financial transactions
    console.log("Test 5: Creating financial transactions...");
    const transaction1 = await (prisma as any).financialTransaction.create({
      data: {
        amazonTransactionId: "TXN-001",
        orderId: order.id,
        transactionType: "Order",
        transactionDate: new Date("2024-04-20"),
        amount: 299.97,
        currencyCode: "USD",
        amazonFee: 29.99,
        fbaFee: 15.0,
        paymentServicesFee: 8.99,
        otherFees: 0,
        grossRevenue: 299.97,
        netRevenue: 245.99,
        status: "Completed",
      },
    });
    results.push({
      name: "Create financial transaction",
      passed: !!transaction1.id && transaction1.orderId === order.id,
      details: {
        transactionId: transaction1.id,
        orderId: transaction1.orderId,
        linkedCorrectly: transaction1.orderId === order.id,
      },
    });
    console.log(`✅ Financial transaction created: ${transaction1.id}\n`);

    // Test 6: Verify order with relations
    console.log("Test 6: Verifying order with all relations...");
    const orderWithRelations = await (prisma.order as any).findUnique({
      where: { id: order.id },
      include: {
        items: true,
        financialTransactions: true,
      },
    });
    results.push({
      name: "Fetch order with relations",
      passed:
        !!orderWithRelations &&
        orderWithRelations.items.length === 2 &&
        orderWithRelations.financialTransactions.length === 1,
      details: {
        orderId: orderWithRelations.id,
        itemsCount: orderWithRelations.items.length,
        transactionsCount: orderWithRelations.financialTransactions.length,
      },
    });
    console.log(`✅ Order with relations verified\n`);

    // Test 7: Verify product with order items
    console.log("Test 7: Verifying product with order items...");
    const productWithItems = await (prisma.product as any).findUnique({
      where: { id: product.id },
      include: {
        orderItems: true,
      },
    });
    results.push({
      name: "Fetch product with order items",
      passed:
        !!productWithItems && productWithItems.orderItems.length === 1,
      details: {
        productId: productWithItems.id,
        orderItemsCount: productWithItems.orderItems.length,
      },
    });
    console.log(`✅ Product with order items verified\n`);

    // Test 8: Test cascade delete
    console.log("Test 8: Testing cascade delete...");
    const itemCountBefore = await (prisma.orderItem as any).count({
      where: { orderId: order.id },
    });
    const txnCountBefore = await (prisma as any).financialTransaction.count({
      where: { orderId: order.id },
    });

    // Delete order
    await (prisma.order as any).delete({
      where: { id: order.id },
    });

    const itemCountAfter = await (prisma.orderItem as any).count({
      where: { orderId: order.id },
    });
    const txnCountAfter = await (prisma as any).financialTransaction.count({
      where: { orderId: order.id },
    });

    results.push({
      name: "Cascade delete on order deletion",
      passed: itemCountAfter === 0 && txnCountAfter === 0,
      details: {
        itemsBeforeDelete: itemCountBefore,
        itemsAfterDelete: itemCountAfter,
        transactionsBeforeDelete: txnCountBefore,
        transactionsAfterDelete: txnCountAfter,
      },
    });
    console.log(`✅ Cascade delete verified\n`);

    // Test 9: Verify product still exists after order deletion
    console.log("Test 9: Verifying product survives order deletion...");
    const productAfterDelete = await (prisma.product as any).findUnique({
      where: { id: product.id },
    });
    results.push({
      name: "Product survives order deletion",
      passed: !!productAfterDelete,
      details: {
        productId: productAfterDelete?.id,
        productExists: !!productAfterDelete,
      },
    });
    console.log(`✅ Product still exists\n`);

    // Clean up
    await (prisma.product as any).delete({
      where: { id: product.id },
    });
  } catch (error) {
    console.error("❌ Test error:", error);
    results.push({
      name: "Test execution",
      passed: false,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await prisma.$disconnect();
  }

  // Print summary
  console.log("\n" + "=".repeat(60));
  console.log("📊 TEST SUMMARY");
  console.log("=".repeat(60) + "\n");

  const passed = results.filter((r) => r.passed).length;
  const total = results.length;

  results.forEach((result) => {
    const icon = result.passed ? "✅" : "❌";
    console.log(`${icon} ${result.name}`);
    if (result.details) {
      console.log(`   Details: ${JSON.stringify(result.details)}`);
    }
    if (result.error) {
      console.log(`   Error: ${result.error}`);
    }
  });

  console.log("\n" + "=".repeat(60));
  console.log(`Results: ${passed}/${total} tests passed`);
  console.log("=".repeat(60) + "\n");

  if (passed === total) {
    console.log("🎉 All tests passed! Phase 2 backend is ready.\n");
    process.exit(0);
  } else {
    console.log("⚠️  Some tests failed. Please review the errors above.\n");
    process.exit(1);
  }
}

runTests().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
