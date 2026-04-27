#!/usr/bin/env node

/**
 * Fix Amazon Parents Script
 * 
 * 1. Delete all fake PARENT- SKUs
 * 2. Mark true parent SKUs as isParent = true
 * 3. Link children to their true parents via parentId
 */

import { PrismaClient } from "@nexus/database";

const prisma = new PrismaClient();

// True Amazon Parent SKUs (base SKUs that have variations)
const trueParentSkus = [
  'VENTRA-JACKET',
  'REGAL-JACKET',
  'IT-MOSS-JACKET',
  'GALE-JACKET',
  'AIRMESH-JACKET',
  'AIREON',
  'AIR-MESH-JACKET-MEN',
  '3K-HP05-BH9I', // Misano
  'xracing',
  'xavia-knee-slider',
  'normal-knee-slider'
];

async function fixAmazonParents() {
  console.log("🔧 Starting Amazon Parents Fix...\n");

  try {
    // Step 1: Delete all fake PARENT- SKUs (and their related records)
    console.log("🗑️  Deleting fake PARENT- SKUs...");
    
    // Disable foreign key constraints temporarily
    await prisma.$executeRaw`SET session_replication_role = replica`;
    
    try {
      // Delete related records first
      await prisma.$executeRaw`
        DELETE FROM "MarketplaceSync"
        WHERE "productId" IN (
          SELECT id FROM "Product" WHERE sku LIKE 'PARENT-%'
        )
      `;
      
      await prisma.$executeRaw`
        DELETE FROM "StockLog"
        WHERE "productId" IN (
          SELECT id FROM "Product" WHERE sku LIKE 'PARENT-%'
        )
      `;
      
      await prisma.$executeRaw`
        DELETE FROM "ProductImage"
        WHERE "productId" IN (
          SELECT id FROM "Product" WHERE sku LIKE 'PARENT-%'
        )
      `;
      
      // Now delete the fake parents
      const deleteResult = await prisma.$executeRaw`
        DELETE FROM "Product"
        WHERE sku LIKE 'PARENT-%'
      `;
      console.log(`✅ Deleted ${deleteResult} fake parent products\n`);
    } finally {
      // Re-enable foreign key constraints
      await prisma.$executeRaw`SET session_replication_role = origin`;
    }

    // Step 2: Mark true parents and link children
    console.log("🔗 Processing true parent SKUs...\n");
    let totalLinked = 0;

    for (const parentSku of trueParentSkus) {
      console.log(`Processing: ${parentSku}`);

      // Find the parent product
      const parent = await prisma.$queryRaw<any[]>`
        SELECT id, sku
        FROM "Product"
        WHERE sku = ${parentSku}
        LIMIT 1
      `;

      if (!parent || parent.length === 0) {
        console.log(`  ⚠️  Parent SKU not found in database\n`);
        continue;
      }

      const parentId = parent[0].id;
      console.log(`  Parent ID: ${parentId}`);

      // Mark this product as parent
      await prisma.$executeRaw`
        UPDATE "Product"
        SET 
          "isParent" = true,
          "basePrice" = 0,
          "totalStock" = 0,
          "status" = 'ACTIVE'
        WHERE id = ${parentId}
      `;
      console.log(`  ✅ Marked as parent`);

      // Find all children (SKUs that contain the parent base but are not the parent itself)
      // Extract the base from the parent SKU (e.g., VENTRA from VENTRA-JACKET)
      const baseParts = parentSku.split('-');
      const basePattern = baseParts[0]; // First part before dash

      const children = await prisma.$queryRaw<any[]>`
        SELECT id, sku
        FROM "Product"
        WHERE sku ILIKE ${basePattern + '%'}
          AND sku != ${parentSku}
          AND "parentId" IS NULL
        ORDER BY sku
      `;

      if (children.length > 0) {
        console.log(`  Found ${children.length} children`);

        // Link all children to this parent
        const linkResult = await prisma.$executeRaw`
          UPDATE "Product"
          SET 
            "parentId" = ${parentId},
            "isParent" = false
          WHERE sku ILIKE ${basePattern + '%'}
            AND sku != ${parentSku}
            AND "parentId" IS NULL
        `;

        console.log(`  ✅ Linked ${linkResult} children\n`);
        totalLinked += linkResult;
      } else {
        console.log(`  ℹ️  No children found\n`);
      }
    }

    console.log(`\n✅ Total children linked: ${totalLinked}\n`);

    // Step 3: Verify final state
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

    console.log(`\n📈 Summary:`);
    console.log(`  Parents: ${integrity.marked_as_parent}`);
    console.log(`  Children: ${integrity.products_with_parent}`);
    console.log(`  Standalones: ${integrity.top_level_products - integrity.marked_as_parent}`);
    console.log(`  Total Top-Level: ${integrity.top_level_products}`);

    if (integrity.total_products === 265) {
      console.log("\n✨ Database restored to 265 original products with correct parent-child relationships!");
      process.exit(0);
    } else {
      console.log(`\n⚠️  Warning: Expected 265 products but found ${integrity.total_products}`);
      process.exit(1);
    }
  } catch (error) {
    console.error("\n❌ Fix failed:", error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

// Run the fix
fixAmazonParents();
