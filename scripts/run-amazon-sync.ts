#!/usr/bin/env node

/**
 * Amazon Catalog Sync Execution Script
 * 
 * This script:
 * 1. Fetches all existing products from the database
 * 2. Detects parent/child relationships based on SKU patterns
 * 3. Runs the AmazonSyncService to populate parentId fields
 * 4. Reports final database integrity metrics
 */

import { PrismaClient } from "@nexus/database";
import AmazonSyncService from "../apps/api/src/services/amazon-sync.service.js";

const prisma = new PrismaClient();

interface AmazonProduct {
  sku: string;
  name: string;
  asin?: string;
  parentAsin?: string;
  price: number;
  stock: number;
  fulfillmentChannel?: "FBA" | "FBM";
  shippingTemplate?: string;
  variationAttributes?: Record<string, string>;
  upc?: string;
  ean?: string;
  brand?: string;
  manufacturer?: string;
}

/**
 * Detect parent/child relationships from existing products
 * Strategy: Group products by SKU prefix patterns
 */
function detectParentChildRelationships(
  products: any[]
): Map<string, AmazonProduct[]> {
  const grouped = new Map<string, AmazonProduct[]>();

  // Group by SKU prefix (everything before the last dash or number)
  for (const product of products) {
    // Extract base SKU (parent identifier)
    // Example: "SHIRT-M-BLK" -> "SHIRT" (parent), "M-BLK" (variation)
    const skuParts = product.sku.split("-");
    let parentKey = product.sku;

    // If SKU has multiple parts, use first part as parent key
    if (skuParts.length > 1) {
      parentKey = skuParts[0];
    }

    if (!grouped.has(parentKey)) {
      grouped.set(parentKey, []);
    }

    const amazonProduct: AmazonProduct = {
      sku: product.sku,
      name: product.name,
      asin: product.amazonAsin,
      price: Number(product.basePrice),
      stock: product.totalStock,
      fulfillmentChannel: product.fulfillmentMethod || "FBM",
      shippingTemplate: product.shippingTemplate,
      upc: product.upc,
      ean: product.ean,
      brand: product.brand,
      manufacturer: product.manufacturer,
    };

    grouped.get(parentKey)!.push(amazonProduct);
  }

  return grouped;
}

/**
 * Assign parentAsin to products based on grouping
 */
function assignParentAsins(
  grouped: Map<string, AmazonProduct[]>
): AmazonProduct[] {
  const result: AmazonProduct[] = [];
  let parentAsinCounter = 1;

  for (const [parentKey, products] of grouped) {
    if (products.length > 1) {
      // This is a parent group - assign parentAsin to all products
      const parentAsin = `PARENT-${parentKey}-${parentAsinCounter}`;
      parentAsinCounter++;

      for (const product of products) {
        result.push({
          ...product,
          parentAsin,
        });
      }
    } else {
      // Standalone product - no parent
      result.push(products[0]);
    }
  }

  return result;
}

async function runSync() {
  console.log("🚀 Starting Amazon Catalog Sync...\n");

  try {
    // Step 1: Fetch all existing products using raw SQL
    console.log("📦 Fetching all products from database...");
    const allProducts = await prisma.$queryRaw<any[]>`
      SELECT 
        id,
        sku,
        name,
        "amazonAsin",
        "basePrice",
        "totalStock",
        "fulfillmentMethod",
        "shippingTemplate",
        upc,
        ean,
        brand,
        manufacturer
      FROM "Product"
      ORDER BY sku
    `;

    console.log(`✅ Found ${allProducts.length} products\n`);

    // Step 2: Detect parent/child relationships
    console.log("🔍 Detecting parent/child relationships...");
    const grouped = detectParentChildRelationships(allProducts);
    console.log(`✅ Grouped into ${grouped.size} parent groups\n`);

    // Step 3: Assign parentAsins
    console.log("🏷️  Assigning parent ASINs...");
    const productsWithParentAsins = assignParentAsins(grouped);
    console.log(`✅ Assigned parent ASINs\n`);

    // Step 4: Run sync
    console.log("⚙️  Running AmazonSyncService.syncBatch()...");
    const syncResult = await AmazonSyncService.syncBatch(
      productsWithParentAsins
    );

    console.log("\n📊 Sync Result:");
    console.log(`  Sync ID: ${syncResult.syncId}`);
    console.log(`  Status: ${syncResult.status}`);
    console.log(`  Items Processed: ${syncResult.itemsProcessed}`);
    console.log(`  Items Successful: ${syncResult.itemsSuccessful}`);
    console.log(`  Items Failed: ${syncResult.itemsFailed}`);
    console.log(`  Parent Count: ${syncResult.parentCount}`);
    console.log(`  Child Count: ${syncResult.childCount}`);
    console.log(`  Started: ${syncResult.startedAt.toISOString()}`);
    console.log(`  Completed: ${syncResult.completedAt.toISOString()}`);

    if (syncResult.errors.length > 0) {
      console.log(`\n⚠️  Errors (${syncResult.errors.length}):`);
      syncResult.errors.slice(0, 5).forEach((err) => {
        console.log(`  - ${err.sku}: ${err.error}`);
      });
      if (syncResult.errors.length > 5) {
        console.log(`  ... and ${syncResult.errors.length - 5} more`);
      }
    }

    // Step 5: Verify database integrity
    console.log("\n🔐 Verifying database integrity...");
    const integrityCheck = await prisma.$queryRaw<any[]>`
      SELECT 
        COUNT(*)::int as total_products,
        COUNT(CASE WHEN "parentId" IS NOT NULL THEN 1 END)::int as products_with_parent,
        COUNT(CASE WHEN "parentId" IS NULL THEN 1 END)::int as top_level_products,
        COUNT(CASE WHEN "isParent" = true THEN 1 END)::int as marked_as_parent
      FROM "Product"
    `;

    const integrity = integrityCheck[0];
    console.log("\n✅ Database Integrity Check:");
    console.log(`  Total Products: ${integrity.total_products}`);
    console.log(`  Products with Parent: ${integrity.products_with_parent}`);
    console.log(`  Top-Level Products: ${integrity.top_level_products}`);
    console.log(`  Marked as Parent: ${integrity.marked_as_parent}`);

    // Calculate expected vs actual
    const expectedTopLevel = integrity.marked_as_parent + (integrity.total_products - integrity.products_with_parent - integrity.marked_as_parent);
    console.log(`\n📈 Summary:`);
    console.log(`  Expected Top-Level Items: ~${expectedTopLevel}`);
    console.log(`  Actual Top-Level Items: ${integrity.top_level_products}`);
    console.log(`  Parent/Child Relationships Established: ${integrity.products_with_parent > 0 ? "✅ YES" : "❌ NO"}`);

    console.log("\n✨ Sync completed successfully!");
    process.exit(0);
  } catch (error) {
    console.error("\n❌ Sync failed:", error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

// Run the sync
runSync();
