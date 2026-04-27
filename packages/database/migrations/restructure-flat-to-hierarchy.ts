/**
 * Migration Script: Restructure Flat Products → Parent-Child Hierarchy
 *
 * Problem: The original import treated every Amazon variation as a standalone
 * Product row (265 flat products). This script restructures them into the
 * Rithum-style hierarchy:
 *
 *   Product (MasterProduct) → ProductVariation → VariantChannelListing
 *
 * Strategy:
 *   1. Identify products that share a parent ASIN (amazonAsin)
 *   2. Group children under a single parent Product
 *   3. Create ProductVariation rows for each child
 *   4. Create VariantChannelListing rows for Amazon channel
 *   5. Recalculate parent stock totals
 *   6. Delete orphaned flat Product rows that became variations
 *
 * Usage:
 *   npx ts-node packages/database/migrations/restructure-flat-to-hierarchy.ts
 *
 * IMPORTANT: Run with --dry-run first to preview changes:
 *   npx ts-node packages/database/migrations/restructure-flat-to-hierarchy.ts --dry-run
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const isDryRun = process.argv.includes("--dry-run");

interface FlatProduct {
  id: string;
  sku: string;
  name: string;
  basePrice: any;
  totalStock: number;
  amazonAsin: string | null;
  ebayItemId: string | null;
  brand: string | null;
  fulfillmentMethod: string | null;
  bulletPoints: string[];
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Detect parent SKU from a child SKU.
 * Common patterns:
 *   - PARENT-SIZE-COLOR  → PARENT
 *   - PARENT_SIZE        → PARENT
 *   - PARENT-VAR         → PARENT
 */
function extractParentSku(sku: string): string | null {
  // Try dash-separated: take everything before the last segment
  const dashParts = sku.split("-");
  if (dashParts.length >= 2) {
    return dashParts.slice(0, -1).join("-");
  }

  // Try underscore-separated
  const underParts = sku.split("_");
  if (underParts.length >= 2) {
    return underParts.slice(0, -1).join("_");
  }

  return null;
}

/**
 * Infer variation name/value from the SKU suffix.
 */
function inferVariation(
  sku: string,
  parentSku: string
): { name: string | null; value: string | null } {
  const suffix = sku.replace(parentSku, "").replace(/^[-_]/, "");
  if (!suffix) return { name: null, value: null };

  // Common size patterns
  const sizePattern =
    /^(XS|S|M|L|XL|XXL|XXXL|\d+)$/i;
  if (sizePattern.test(suffix)) {
    return { name: "Size", value: suffix.toUpperCase() };
  }

  // Common color patterns
  const colorMap: Record<string, string> = {
    BLK: "Black",
    WHT: "White",
    RED: "Red",
    BLU: "Blue",
    GRN: "Green",
    YEL: "Yellow",
    BRN: "Brown",
    GRY: "Gray",
    PNK: "Pink",
    PRP: "Purple",
    NAVY: "Navy",
    GOLD: "Gold",
    SILVER: "Silver",
  };

  const upperSuffix = suffix.toUpperCase();
  if (colorMap[upperSuffix]) {
    return { name: "Color", value: colorMap[upperSuffix] };
  }

  // Generic fallback
  return { name: "Variant", value: suffix };
}

async function restructure() {
  console.log(
    isDryRun
      ? "🔍 DRY RUN — No changes will be made\n"
      : "🚀 LIVE RUN — Changes will be committed\n"
  );

  // ── Step 1: Load all flat products ──────────────────────────────────
  const allProducts = (await prisma.product.findMany({
    orderBy: { sku: "asc" },
  })) as FlatProduct[];

  console.log(`📊 Found ${allProducts.length} total products\n`);

  // ── Step 2: Check which products already have variations ────────────
  const existingVariations = await (
    prisma as any
  ).productVariation.findMany({
    select: { productId: true },
  });
  const productsWithVariations = new Set(
    existingVariations.map((v: any) => v.productId)
  );

  // Only process products that DON'T already have variations
  const flatProducts = allProducts.filter(
    (p) => !productsWithVariations.has(p.id)
  );

  console.log(
    `📋 ${flatProducts.length} flat products (no existing variations)\n`
  );

  if (flatProducts.length === 0) {
    console.log("✅ No flat products to restructure. Already hierarchical.");
    await prisma.$disconnect();
    return;
  }

  // ── Step 3: Group by ASIN (products sharing the same parent ASIN) ──
  const asinGroups = new Map<string, FlatProduct[]>();
  const standaloneProducts: FlatProduct[] = [];

  for (const product of flatProducts) {
    if (product.amazonAsin) {
      const group = asinGroups.get(product.amazonAsin) || [];
      group.push(product);
      asinGroups.set(product.amazonAsin, group);
    } else {
      standaloneProducts.push(product);
    }
  }

  console.log(`🔗 ASIN groups: ${asinGroups.size}`);
  console.log(`📦 Standalone products (no ASIN): ${standaloneProducts.length}\n`);

  let parentsCreated = 0;
  let variationsCreated = 0;
  let listingsCreated = 0;
  let productsDeleted = 0;
  const errors: Array<{ sku: string; error: string }> = [];

  // ── Step 4: Process ASIN groups ─────────────────────────────────────
  for (const [asin, group] of asinGroups) {
    if (group.length === 1) {
      // Single product with this ASIN → standalone, just create a variation
      const product = group[0];
      console.log(
        `  📦 Standalone ASIN ${asin}: ${product.sku} → creating variation`
      );

      if (!isDryRun) {
        try {
          const variation = await (
            prisma as any
          ).productVariation.create({
            data: {
              productId: product.id,
              sku: product.sku,
              price: Number(product.basePrice),
              stock: product.totalStock,
              amazonAsin: product.amazonAsin,
              fulfillmentMethod: product.fulfillmentMethod,
              isActive: true,
            },
          });
          variationsCreated++;

          // Create channel listing
          await (prisma as any).variantChannelListing.create({
            data: {
              variantId: variation.id,
              channelId: "AMAZON",
              channelSku: product.sku,
              channelProductId: product.amazonAsin,
              channelPrice: Number(product.basePrice),
              channelQuantity: product.totalStock,
              listingStatus: "ACTIVE",
              lastSyncedAt: new Date(),
              lastSyncStatus: "SUCCESS",
            },
          });
          listingsCreated++;
        } catch (err) {
          errors.push({
            sku: product.sku,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      continue;
    }

    // Multiple products share this ASIN → need to pick/create a parent
    console.log(
      `  🔗 Group ASIN ${asin}: ${group.length} products → restructuring`
    );

    // Try to find the "parent" — the one whose SKU is a prefix of others
    let parentProduct: FlatProduct | null = null;
    const childProducts: FlatProduct[] = [];

    // Sort by SKU length (shortest first — likely the parent)
    const sorted = [...group].sort((a, b) => a.sku.length - b.sku.length);

    for (const product of sorted) {
      if (!parentProduct) {
        // Check if this SKU is a prefix of at least one other
        const isPrefix = sorted.some(
          (other) =>
            other.id !== product.id && other.sku.startsWith(product.sku)
        );
        if (isPrefix || sorted.length === 2) {
          parentProduct = product;
        } else {
          childProducts.push(product);
        }
      } else {
        childProducts.push(product);
      }
    }

    // If no clear parent found, use the shortest SKU as parent
    if (!parentProduct) {
      parentProduct = sorted[0];
      childProducts.length = 0;
      for (const p of sorted.slice(1)) {
        childProducts.push(p);
      }
    }

    console.log(`    Parent: ${parentProduct.sku}`);
    for (const child of childProducts) {
      console.log(`    Child:  ${child.sku}`);
    }

    if (!isDryRun) {
      try {
        // Recalculate parent stock
        const totalStock = group.reduce((sum, p) => sum + p.totalStock, 0);
        await prisma.product.update({
          where: { id: parentProduct.id },
          data: { totalStock },
        });

        // Create variations for ALL products in the group (including parent as standalone variation)
        for (const product of group) {
          const isParentRow = product.id === parentProduct.id;
          const { name, value } = isParentRow
            ? { name: null, value: null }
            : inferVariation(product.sku, parentProduct.sku);

          try {
            const variation = await (
              prisma as any
            ).productVariation.create({
              data: {
                productId: parentProduct.id,
                sku: product.sku,
                price: Number(product.basePrice),
                stock: product.totalStock,
                amazonAsin: product.amazonAsin,
                name,
                value,
                variationAttributes:
                  name && value ? { [name]: value } : undefined,
                fulfillmentMethod: product.fulfillmentMethod,
                isActive: true,
              },
            });
            variationsCreated++;

            // Create channel listing
            await (prisma as any).variantChannelListing.create({
              data: {
                variantId: variation.id,
                channelId: "AMAZON",
                channelSku: product.sku,
                channelProductId: product.amazonAsin,
                channelPrice: Number(product.basePrice),
                channelQuantity: product.totalStock,
                listingStatus: "ACTIVE",
                lastSyncedAt: new Date(),
                lastSyncStatus: "SUCCESS",
              },
            });
            listingsCreated++;
          } catch (err) {
            errors.push({
              sku: product.sku,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        // Delete child Product rows (they're now variations under the parent)
        for (const child of childProducts) {
          try {
            await prisma.product.delete({ where: { id: child.id } });
            productsDeleted++;
          } catch (err) {
            errors.push({
              sku: child.sku,
              error: `Delete failed: ${err instanceof Error ? err.message : String(err)}`,
            });
          }
        }

        parentsCreated++;
      } catch (err) {
        errors.push({
          sku: parentProduct.sku,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // ── Step 5: Process standalone products (no ASIN) ───────────────────
  for (const product of standaloneProducts) {
    console.log(
      `  📦 Standalone (no ASIN): ${product.sku} → creating variation`
    );

    if (!isDryRun) {
      try {
        const variation = await (
          prisma as any
        ).productVariation.create({
          data: {
            productId: product.id,
            sku: `${product.sku}-DEFAULT`,
            price: Number(product.basePrice),
            stock: product.totalStock,
            fulfillmentMethod: product.fulfillmentMethod,
            isActive: true,
          },
        });
        variationsCreated++;

        // Create eBay listing if ebayItemId exists
        if (product.ebayItemId) {
          await (prisma as any).variantChannelListing.create({
            data: {
              variantId: variation.id,
              channelId: "EBAY",
              channelSku: product.sku,
              channelProductId: product.ebayItemId,
              channelPrice: Number(product.basePrice),
              channelQuantity: product.totalStock,
              listingStatus: "ACTIVE",
              lastSyncedAt: new Date(),
              lastSyncStatus: "SUCCESS",
            },
          });
          listingsCreated++;
        }
      } catch (err) {
        errors.push({
          sku: product.sku,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // ── Summary ─────────────────────────────────────────────────────────
  console.log(`\n${"═".repeat(60)}`);
  console.log(`📈 Migration Summary${isDryRun ? " (DRY RUN)" : ""}:`);
  console.log(`   • Parent products created/updated: ${parentsCreated}`);
  console.log(`   • Variations created: ${variationsCreated}`);
  console.log(`   • Channel listings created: ${listingsCreated}`);
  console.log(`   • Flat products deleted (merged): ${productsDeleted}`);
  console.log(`   • Errors: ${errors.length}`);

  if (errors.length > 0) {
    console.log(`\n⚠️  Errors:`);
    for (const err of errors.slice(0, 20)) {
      console.log(`   • ${err.sku}: ${err.error}`);
    }
    if (errors.length > 20) {
      console.log(`   ... and ${errors.length - 20} more`);
    }
  }

  if (isDryRun) {
    console.log(
      `\n💡 Run without --dry-run to apply changes.`
    );
  } else {
    console.log(`\n✨ Migration completed!`);
  }

  await prisma.$disconnect();
}

// Run
restructure().catch((error) => {
  console.error("❌ Migration failed:", error);
  prisma.$disconnect();
  process.exit(1);
});
