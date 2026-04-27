#!/usr/bin/env node

/**
 * Live Order Sync Test Script
 * 
 * This script:
 * 1. Fetches sample products from the database
 * 2. Creates sample orders with items linked to those products
 * 3. Monitors product linking success
 * 4. Verifies database population
 * 5. Reports final counts
 */

import prisma from "../packages/database/index.js";

interface SyncReport {
  ordersCreated: number;
  itemsCreated: number;
  itemsLinked: number;
  itemsUnlinked: number;
  transactionsCreated: number;
  errors: Array<{ orderId: string; error: string }>;
}

async function runLiveOrderSync() {
  console.log("🚀 Starting Live Order Sync Test\n");
  console.log("=".repeat(60));

  const report: SyncReport = {
    ordersCreated: 0,
    itemsCreated: 0,
    itemsLinked: 0,
    itemsUnlinked: 0,
    transactionsCreated: 0,
    errors: [],
  };

  try {
    // Step 1: Fetch existing products
    console.log("\n📦 Step 1: Fetching existing products from database...");
    const products = await (prisma.product as any).findMany({
      select: {
        id: true,
        sku: true,
        name: true,
        amazonAsin: true,
        basePrice: true,
      },
      take: 20,
    });

    console.log(`✅ Found ${products.length} products in database`);
    if (products.length === 0) {
      console.log("⚠️  No products found. Please run Phase 1 sync first.");
      return;
    }

    // Step 2: Create sample orders
    console.log("\n📋 Step 2: Creating sample orders...");

    const sampleOrders = [
      {
        amazonOrderId: "114-1234567-1234567",
        purchaseDate: new Date("2024-04-20"),
        status: "Shipped",
        fulfillmentChannel: "AFN",
        buyerName: "John Doe",
        buyerEmail: "john@example.com",
        shippingAddress: {
          street1: "123 Main St",
          city: "New York",
          state: "NY",
          postalCode: "10001",
          country: "US",
        },
        totalAmount: 299.99,
        currencyCode: "USD",
      },
      {
        amazonOrderId: "114-2345678-2345678",
        purchaseDate: new Date("2024-04-19"),
        status: "Pending",
        fulfillmentChannel: "MFN",
        buyerName: "Jane Smith",
        buyerEmail: "jane@example.com",
        shippingAddress: {
          street1: "456 Oak Ave",
          city: "Los Angeles",
          state: "CA",
          postalCode: "90001",
          country: "US",
        },
        totalAmount: 149.99,
        currencyCode: "USD",
      },
      {
        amazonOrderId: "114-3456789-3456789",
        purchaseDate: new Date("2024-04-18"),
        status: "Shipped",
        fulfillmentChannel: "AFN",
        buyerName: "Bob Johnson",
        buyerEmail: "bob@example.com",
        shippingAddress: {
          street1: "789 Pine Rd",
          city: "Chicago",
          state: "IL",
          postalCode: "60601",
          country: "US",
        },
        totalAmount: 499.99,
        currencyCode: "USD",
      },
    ];

    for (const orderData of sampleOrders) {
      try {
        // Create order
        const order = await (prisma.order as any).create({
          data: orderData,
        });

        report.ordersCreated++;
        console.log(`✅ Created order: ${order.amazonOrderId}`);

        // Create order items with product linking
        const itemsToCreate = products.slice(0, 3).map((product: any, idx: number) => ({
          amazonOrderItemId: `${order.amazonOrderId}-${idx + 1}`,
          orderId: order.id,
          productId: product.id, // Link to product
          sellerSku: product.sku,
          asin: product.amazonAsin || `ASIN-${idx}`,
          title: product.name,
          quantity: Math.floor(Math.random() * 3) + 1,
          itemPrice: parseFloat(product.basePrice.toString()),
          itemTax: parseFloat((parseFloat(product.basePrice.toString()) * 0.08).toFixed(2)),
          shippingPrice: 5.99,
          shippingTax: 0.48,
          subtotal: parseFloat(product.basePrice.toString()) * (Math.floor(Math.random() * 3) + 1),
          totalWithShipping: parseFloat(product.basePrice.toString()) * (Math.floor(Math.random() * 3) + 1) + 5.99,
          fulfillmentStatus: "Shipped",
        }));

        // Also create one unlinked item for testing
        itemsToCreate.push({
          amazonOrderItemId: `${order.amazonOrderId}-unlinked`,
          orderId: order.id,
          productId: null, // No product link
          sellerSku: "UNKNOWN-SKU-001",
          asin: "B9999999999",
          title: "Unknown Product (Manual Review Required)",
          quantity: 1,
          itemPrice: 99.99,
          itemTax: 8.0,
          shippingPrice: 5.99,
          shippingTax: 0.48,
          subtotal: 99.99,
          totalWithShipping: 105.98,
          fulfillmentStatus: "Pending",
        });

        // Create items
        for (const itemData of itemsToCreate) {
          const item = await (prisma.orderItem as any).create({
            data: itemData,
          });

          report.itemsCreated++;
          if (item.productId) {
            report.itemsLinked++;
            console.log(
              `  ✅ Item linked to product: ${item.sellerSku}`
            );
          } else {
            report.itemsUnlinked++;
            console.log(
              `  ⚠️  Item unlinked (manual review): ${item.sellerSku}`
            );
          }
        }

        // Create financial transactions
        const transactions = [
          {
            amazonTransactionId: `TXN-${order.amazonOrderId}-1`,
            orderId: order.id,
            transactionType: "Order",
            transactionDate: new Date(orderData.purchaseDate),
            amount: orderData.totalAmount,
            currencyCode: "USD",
            amazonFee: parseFloat((orderData.totalAmount * 0.15).toFixed(2)),
            fbaFee: parseFloat((orderData.totalAmount * 0.10).toFixed(2)),
            paymentServicesFee: parseFloat((orderData.totalAmount * 0.03).toFixed(2)),
            otherFees: 0,
            grossRevenue: orderData.totalAmount,
            netRevenue: parseFloat(
              (
                orderData.totalAmount -
                orderData.totalAmount * 0.15 -
                orderData.totalAmount * 0.10 -
                orderData.totalAmount * 0.03
              ).toFixed(2)
            ),
            status: "Completed",
          },
        ];

        for (const txnData of transactions) {
          await (prisma as any).financialTransaction.create({
            data: txnData,
          });
          report.transactionsCreated++;
        }

        console.log(
          `  💰 Created ${transactions.length} financial transaction(s)\n`
        );
      } catch (error) {
        report.errors.push({
          orderId: orderData.amazonOrderId,
          error: error instanceof Error ? error.message : String(error),
        });
        console.error(`❌ Error creating order: ${error}\n`);
      }
    }

    // Step 3: Verify database counts
    console.log("\n📊 Step 3: Verifying database population...");
    console.log("=".repeat(60));

    const orderCount = await (prisma.order as any).count();
    const itemCount = await (prisma.orderItem as any).count();
    const transactionCount = await (prisma as any).financialTransaction.count();
    const linkedItemCount = await (prisma.orderItem as any).count({
      where: { productId: { not: null } },
    });
    const unlinkedItemCount = await (prisma.orderItem as any).count({
      where: { productId: null },
    });

    console.log(`\n📈 Database Counts:`);
    console.log(`   Total Orders: ${orderCount}`);
    console.log(`   Total Order Items: ${itemCount}`);
    console.log(`   Linked Items: ${linkedItemCount}`);
    console.log(`   Unlinked Items: ${unlinkedItemCount}`);
    console.log(`   Financial Transactions: ${transactionCount}`);

    // Step 4: Sample data verification
    console.log("\n🔍 Step 4: Sampling order data for verification...");
    console.log("=".repeat(60));

    const sampleOrder = await (prisma.order as any).findFirst({
      include: {
        items: {
          include: {
            product: {
              select: {
                id: true,
                sku: true,
                name: true,
              },
            },
          },
        },
        financialTransactions: true,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    if (sampleOrder) {
      console.log(`\n📦 Sample Order: ${sampleOrder.amazonOrderId}`);
      console.log(`   Status: ${sampleOrder.status}`);
      console.log(`   Fulfillment: ${sampleOrder.fulfillmentChannel}`);
      console.log(`   Total: $${parseFloat(sampleOrder.totalAmount).toFixed(2)}`);
      console.log(`   Items: ${sampleOrder.items.length}`);

      console.log(`\n   Order Items:`);
      for (const item of sampleOrder.items) {
        if (item.product) {
          console.log(
            `   ✅ ${item.sellerSku} → ${item.product.name} (${item.product.sku})`
          );
        } else {
          console.log(`   ⚠️  ${item.sellerSku} → [UNLINKED - Manual Review]`);
        }
      }

      console.log(`\n   Financial Transactions: ${sampleOrder.financialTransactions.length}`);
      for (const txn of sampleOrder.financialTransactions) {
        console.log(`   💰 ${txn.transactionType}: $${parseFloat(txn.amount).toFixed(2)}`);
        console.log(
          `      Gross: $${parseFloat(txn.grossRevenue).toFixed(2)} | Net: $${parseFloat(txn.netRevenue).toFixed(2)}`
        );
      }
    }

    // Step 5: Product linking analysis
    console.log("\n📊 Step 5: Product Linking Analysis...");
    console.log("=".repeat(60));

    const linkingStats = await (prisma.orderItem as any).groupBy({
      by: ["productId"],
      _count: true,
    });

    const linkedCount = linkingStats.filter((s: any) => s.productId !== null).reduce((sum: number, s: any) => sum + s._count, 0);
    const unlinkedCount = linkingStats.filter((s: any) => s.productId === null).reduce((sum: number, s: any) => sum + s._count, 0);
    const linkingPercentage = itemCount > 0 ? ((linkedCount / itemCount) * 100).toFixed(1) : "0";

    console.log(`\n✅ Linked Items: ${linkedCount} (${linkingPercentage}%)`);
    console.log(`⚠️  Unlinked Items: ${unlinkedCount} (requires manual review)`);

    // Final Report
    console.log("\n" + "=".repeat(60));
    console.log("📋 SYNC REPORT");
    console.log("=".repeat(60));
    console.log(`\nOrders Created: ${report.ordersCreated}`);
    console.log(`Items Created: ${report.itemsCreated}`);
    console.log(`Items Linked: ${report.itemsLinked}`);
    console.log(`Items Unlinked: ${report.itemsUnlinked}`);
    console.log(`Transactions Created: ${report.transactionsCreated}`);

    if (report.errors.length > 0) {
      console.log(`\n❌ Errors: ${report.errors.length}`);
      for (const error of report.errors) {
        console.log(`   - ${error.orderId}: ${error.error}`);
      }
    }

    console.log("\n" + "=".repeat(60));
    if (report.errors.length === 0) {
      console.log("✅ SYNC COMPLETED SUCCESSFULLY");
    } else {
      console.log("⚠️  SYNC COMPLETED WITH ERRORS");
    }
    console.log("=".repeat(60) + "\n");
  } catch (error) {
    console.error("❌ Fatal error:", error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

runLiveOrderSync().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
