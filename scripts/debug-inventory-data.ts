#!/usr/bin/env node

import { PrismaClient } from "@nexus/database";

const prisma = new PrismaClient();

async function debugInventoryData() {
  console.log("🔍 Debugging inventory data structure...\n");

  try {
    // Fetch top-level products exactly as the page does
    const products = (await (prisma as any).product.findMany({
      where: {
        parentId: null,
      },
      include: {
        children: true,
      },
      orderBy: { updatedAt: "desc" },
      take: 15, // Just first 15 for debugging
    })) as any[];

    console.log(`📊 Fetched ${products.length} top-level products\n`);

    // Show first 5 products with their isParent status
    products.slice(0, 5).forEach((product: any, idx: number) => {
      console.log(`Product ${idx + 1}:`);
      console.log(`  SKU: ${product.sku}`);
      console.log(`  isParent: ${product.isParent} (type: ${typeof product.isParent})`);
      console.log(`  Children count: ${product.children?.length || 0}`);
      console.log();
    });

    // Count parents in the fetched data
    const parentCount = products.filter((p: any) => p.isParent === true).length;
    console.log(`✅ Parents in fetched data: ${parentCount} out of ${products.length}`);

  } catch (error) {
    console.error("❌ Error:", error);
  } finally {
    await prisma.$disconnect();
  }
}

debugInventoryData();
