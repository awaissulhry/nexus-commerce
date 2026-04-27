#!/usr/bin/env node

/**
 * Simple Database Verification Script
 * Checks Order, OrderItem, and FinancialTransaction counts
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function verifyDatabase() {
  console.log("🔍 Verifying Orders Database\n");
  console.log("=".repeat(60));

  try {
    // Get counts
    const orderCount = await prisma.order.count();
    const orderItemCount = await prisma.orderItem.count();
    const transactionCount = await (prisma as any).financialTransaction.count();

    console.log("\n📊 Database Counts:");
    console.log(`   Total Orders: ${orderCount}`);
    console.log(`   Total Order Items: ${orderItemCount}`);
    console.log(`   Total Financial Transactions: ${transactionCount}`);

    // Get linked vs unlinked items
    const linkedItems = await prisma.orderItem.count({
      where: { productId: { not: null } },
    });
    const unlinkedItems = await prisma.orderItem.count({
      where: { productId: null },
    });

    console.log(`\n🔗 Product Linking Status:`);
    console.log(`   Linked Items: ${linkedItems}`);
    console.log(`   Unlinked Items: ${unlinkedItems}`);

    if (orderItemCount > 0) {
      const linkingPercentage = ((linkedItems / orderItemCount) * 100).toFixed(1);
      console.log(`   Linking Rate: ${linkingPercentage}%`);
    }

    // Sample order if exists
    if (orderCount > 0) {
      console.log(`\n📦 Sample Order Data:`);
      const sampleOrder = await prisma.order.findFirst({
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
      });

      if (sampleOrder) {
        console.log(`   Order ID: ${sampleOrder.amazonOrderId}`);
        console.log(`   Status: ${sampleOrder.status}`);
        console.log(`   Items: ${sampleOrder.items.length}`);
        console.log(`   Transactions: ${sampleOrder.financialTransactions.length}`);

        if (sampleOrder.items.length > 0) {
          console.log(`\n   Sample Items:`);
          sampleOrder.items.slice(0, 3).forEach((item) => {
            if (item.product) {
              console.log(
                `   ✅ ${item.sellerSku} → ${item.product.name}`
              );
            } else {
              console.log(`   ⚠️  ${item.sellerSku} → [UNLINKED]`);
            }
          });
        }
      }
    }

    console.log("\n" + "=".repeat(60));
    console.log("✅ Database verification complete\n");
  } catch (error) {
    console.error("❌ Error:", error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

verifyDatabase();
