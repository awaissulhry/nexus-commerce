#!/usr/bin/env node

import { PrismaClient } from "@nexus/database";

const prisma = new PrismaClient();

async function checkParents() {
  console.log("🔍 Checking parent products in database...\n");

  try {
    // Check all products marked as isParent
    const parents = await prisma.$queryRaw<any[]>`
      SELECT id, sku, name, "isParent", "parentId", 
             (SELECT COUNT(*) FROM "Product" WHERE "parentId" = p.id) as child_count
      FROM "Product" p
      WHERE "isParent" = true
      ORDER BY sku
    `;

    console.log(`✅ Found ${parents.length} products marked as isParent = true:\n`);
    parents.forEach((p: any) => {
      console.log(`  ${p.sku.padEnd(30)} | Children: ${p.child_count}`);
    });

    // Check top-level products
    const topLevel = await prisma.$queryRaw<any[]>`
      SELECT COUNT(*)::int as count FROM "Product" WHERE "parentId" IS NULL
    `;

    console.log(`\n📊 Top-level products (parentId IS NULL): ${topLevel[0].count}`);

    // Check products with children
    const withChildren = await prisma.$queryRaw<any[]>`
      SELECT COUNT(*)::int as count FROM "Product" WHERE "parentId" IS NOT NULL
    `;

    console.log(`📊 Products with parent (parentId IS NOT NULL): ${withChildren[0].count}`);

  } catch (error) {
    console.error("❌ Error:", error);
  } finally {
    await prisma.$disconnect();
  }
}

checkParents();
