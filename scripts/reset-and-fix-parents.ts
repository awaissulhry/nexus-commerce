#!/usr/bin/env node

/**
 * Reset and Fix Amazon Parents Script
 * 
 * 1. Reset all parentId to NULL (except xracing children)
 * 2. Reset all isParent to false
 * 3. Mark only the 11 true parents as isParent = true
 * 4. Link only xracing children to xracing parent
 */

import { PrismaClient } from "@nexus/database";

const prisma = new PrismaClient();

async function resetAndFixParents() {
  console.log("🔧 Starting Reset and Fix...\n");

  try {
    // Step 1: Reset everything
    console.log("🔄 Resetting all parent/child relationships...");
    
    await prisma.$executeRaw`SET session_replication_role = replica`;
    
    try {
      // Reset all products
      await prisma.$executeRaw`
        UPDATE "Product"
        SET "parentId" = NULL, "isParent" = false
      `;
      console.log(`✅ Reset all products\n`);
    } finally {
      await prisma.$executeRaw`SET session_replication_role = origin`;
    }

    // Step 2: Mark the 11 true parents
    console.log("🏷️  Marking true parents...");
    const trueParentSkus = [
      'VENTRA-JACKET',
      'REGAL-JACKET',
      'IT-MOSS-JACKET',
      'GALE-JACKET',
      'AIRMESH-JACKET',
      'AIREON',
      'AIR-MESH-JACKET-MEN',
      '3K-HP05-BH9I',
      'xracing',
      'xavia-knee-slider',
      'normal-knee-slider'
    ];

    for (const sku of trueParentSkus) {
      await prisma.$executeRaw`
        UPDATE "Product"
        SET "isParent" = true, "basePrice" = 0, "totalStock" = 0
        WHERE sku = ${sku}
      `;
    }
    console.log(`✅ Marked ${trueParentSkus.length} parents\n`);

    // Step 3: Link ONLY xracing children
    console.log("🔗 Linking xracing children...");
    
    // Get xracing parent ID
    const xracingParent = await prisma.$queryRaw<any[]>`
      SELECT id FROM "Product" WHERE sku = 'xracing' LIMIT 1
    `;

    if (xracingParent && xracingParent.length > 0) {
      const parentId = xracingParent[0].id;
      
      // Link all xracing* SKUs (except xracing itself) to xracing parent
      const linkResult = await prisma.$executeRaw`
        UPDATE "Product"
        SET "parentId" = ${parentId}, "isParent" = false
        WHERE sku LIKE 'xracing%' AND sku != 'xracing'
      `;
      
      console.log(`✅ Linked ${linkResult} xracing children\n`);
    }

    // Step 4: Verify final state
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

    if (integrity.total_products === 265 && integrity.marked_as_parent === 11) {
      console.log("\n✨ Database fixed correctly!");
      process.exit(0);
    } else {
      console.log(`\n⚠️  Unexpected state`);
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
resetAndFixParents();
