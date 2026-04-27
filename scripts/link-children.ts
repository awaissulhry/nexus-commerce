#!/usr/bin/env node

/**
 * Database Relationship Repair Script
 * 
 * This script:
 * 1. Fetches all parent products (isParent = true)
 * 2. For each parent, finds children by matching SKU base pattern
 * 3. Updates children to link them to their parent via parentId
 * 4. Verifies the relationships were created correctly
 */

import { PrismaClient } from "@nexus/database";

const prisma = new PrismaClient();

async function repairRelationships() {
  console.log("🔧 Starting Database Relationship Repair...\n");

  try {
    // Step 1: Fetch all parent products
    console.log("📦 Fetching parent products...");
    const parents = await prisma.$queryRaw<any[]>`
      SELECT id, sku, name
      FROM "Product"
      WHERE "isParent" = true
      ORDER BY sku
    `;

    console.log(`✅ Found ${parents.length} parent products\n`);

    // Step 2: For each parent, find and link children
    let totalLinked = 0;

    for (const parent of parents) {
      // Extract base SKU from parent
      // Parent SKU format: "PARENT-{baseSku}"
      const baseSku = parent.sku.replace("PARENT-", "");

      console.log(`🔗 Processing parent: ${parent.sku}`);

      // Find all original products that start with this base SKU
      const children = await prisma.$queryRaw<any[]>`
        SELECT id, sku
        FROM "Product"
        WHERE sku LIKE ${baseSku + "%"}
          AND sku != ${parent.sku}
          AND "parentId" IS NULL
        ORDER BY sku
      `;

      if (children.length > 0) {
        console.log(`   Found ${children.length} children to link`);

        // Update each child to link to this parent
        for (const child of children) {
          await prisma.$executeRaw`
            UPDATE "Product"
            SET "parentId" = ${parent.id}, "isParent" = false
            WHERE id = ${child.id}
          `;
          totalLinked++;
        }

        console.log(`   ✅ Linked ${children.length} children\n`);
      } else {
        console.log(`   ℹ️  No children found\n`);
      }
    }

    console.log(`\n✅ Total children linked: ${totalLinked}\n`);

    // Step 3: Verify the relationships
    console.log("🔐 Verifying database integrity...\n");
    const integrityCheck = await prisma.$queryRaw<any[]>`
      SELECT 
        COUNT(*)::int as total_products,
        COUNT(CASE WHEN "parentId" IS NOT NULL THEN 1 END)::int as products_with_parent,
        COUNT(CASE WHEN "parentId" IS NULL THEN 1 END)::int as top_level_products,
        COUNT(CASE WHEN "isParent" = true THEN 1 END)::int as marked_as_parent
      FROM "Product"
    `;

    const integrity = integrityCheck[0];
    console.log("✅ Final Database Integrity Check:");
    console.log(`  Total Products: ${integrity.total_products}`);
    console.log(`  Products with Parent: ${integrity.products_with_parent}`);
    console.log(`  Top-Level Products: ${integrity.top_level_products}`);
    console.log(`  Marked as Parent: ${integrity.marked_as_parent}`);

    // Verify the expected numbers
    const expectedTopLevel = integrity.marked_as_parent + (integrity.total_products - integrity.products_with_parent - integrity.marked_as_parent);
    console.log(`\n📈 Summary:`);
    console.log(`  Expected Top-Level Items: ~${expectedTopLevel}`);
    console.log(`  Actual Top-Level Items: ${integrity.top_level_products}`);
    console.log(`  Parent/Child Relationships: ${integrity.products_with_parent > 0 ? "✅ ESTABLISHED" : "❌ FAILED"}`);

    if (integrity.products_with_parent > 0) {
      console.log("\n✨ Database repair completed successfully!");
      process.exit(0);
    } else {
      console.log("\n❌ Database repair failed - no children were linked!");
      process.exit(1);
    }
  } catch (error) {
    console.error("\n❌ Repair failed:", error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

// Run the repair
repairRelationships();
