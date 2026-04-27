import cron from "node-cron";
import prisma from "../db.js";
import {
  GeminiService,
  type ProductInput,
} from "../services/ai/gemini.service.js";
import { EbayService } from "../services/marketplaces/ebay.service.js";
import { AmazonService } from "../services/marketplaces/amazon.service.js";
import { ProductSyncService, DataValidationService } from "../services/sync/index.js";
import { unifiedSyncOrchestrator } from "../services/sync/unified-sync-orchestrator.js";
import {
  syncEstyListings,
  syncEstyInventory,
  syncEstyOrders,
} from "./etsy-sync.job.js";

const gemini = new GeminiService();
const ebay = new EbayService();
const amazon = new AmazonService();
const productSync = new ProductSyncService();
const dataValidation = new DataValidationService();

/* ================================================================== */
/*  Master pipeline                                                    */
/* ================================================================== */

/**
 * Runs the full Amazon → eBay synchronization pipeline:
 *
 * Phase 0 — Amazon Catalog Sync:
 *   Pulls the active catalog from Amazon, upserts products into the DB,
 *   and enriches each with detailed data (title, brand, bullets, images…).
 *
 * Phase 1 — New Listings:
 *   Finds products with an Amazon ASIN but no eBay listing yet.
 *   Generates optimized listing data via Gemini AI, publishes to eBay,
 *   and records the result.
 *
 * Phase 2 — Price Parity:
 *   Finds products already linked to eBay. Compares the current Amazon
 *   price (from our DB) to the eBay listing price. If they differ,
 *   updates the eBay offer price and records the sync.
 */
export async function runSync(): Promise<void> {
  try {
    console.log("[SyncJob] ═══════════════════════════════════════════");
    console.log("[SyncJob] Starting full Amazon → eBay sync pipeline…");
    console.log("[SyncJob] ═══════════════════════════════════════════");

    // ── Phase 0: Pull & enrich Amazon catalog ───────────────────────
    await syncAmazonCatalog();

    // ── Phase 1: Publish new listings to eBay ───────────────────────
    await syncNewListings();

    // ── Phase 2: Price parity for existing listings ─────────────────
    await syncPriceParity();

    console.log("[SyncJob] ═══════════════════════════════════════════");
    console.log("[SyncJob] Pipeline complete.");
    console.log("[SyncJob] ═══════════════════════════════════════════");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[SyncJob] ✗ Master pipeline failed:", message);
    if (error instanceof Error && error.stack) {
      console.error("[SyncJob] Stack:", error.stack);
    }
  }
}

/* ================================================================== */
/*  Phase 0 — Amazon Catalog Sync                                      */
/* ================================================================== */

/**
 * Fetches the active catalog from Amazon via the SP-API Reports API,
 * upserts every SKU into the Product table, and enriches each product
 * with detailed data from the Listings / Catalog Items APIs.
 */
async function syncAmazonCatalog(): Promise<void> {
  console.log("[SyncJob] Phase 0: Syncing Amazon catalog with Rithum parent-child structure…");

  const catalog = await amazon.fetchActiveCatalog();

  if (catalog.length === 0) {
    console.log("[SyncJob] No active listings found in Amazon catalog.");
    return;
  }

  console.log(
    `[SyncJob] Found ${catalog.length} active Amazon listing(s). Processing with variation theme detection…`
  );

  let created = 0;
  let updated = 0;
  let enriched = 0;
  let errors = 0;

  // Fetch detailed product data for all items
  const detailedProducts = [];
  for (const item of catalog) {
    try {
      const details = await amazon.fetchProductDetails(item.sku);
      detailedProducts.push({
        ...item,
        ...details,
      });
    } catch (error: any) {
      console.warn(
        `[SyncJob] Failed to fetch details for SKU "${item.sku}":`,
        error?.message ?? error
      );
      // Still include basic catalog item
      detailedProducts.push(item);
    }
  }

  // Sync products using ProductSyncService (handles parent-child structure)
  const syncResult = await productSync.syncProducts(
    detailedProducts.map((p: any) => ({
      sku: p.sku,
      name: p.title || p.name || p.sku,
      basePrice: p.price,
      totalStock: p.quantity,
      amazonAsin: p.asin,
      brand: p.brand,
      manufacturer: p.manufacturer,
      bulletPoints: p.bulletPoints || [],
      keywords: p.keywords || [],
    }))
  );

  created = syncResult.created;
  updated = syncResult.updated;
  errors = syncResult.failed;

  // Upsert images for each product
  for (const product of detailedProducts) {
    try {
      const p = product as any;
      if (p.images && p.images.length > 0) {
        const dbProduct = await (prisma as any).product.findUnique({
          where: { sku: p.sku },
        });

        if (dbProduct) {
          // Remove old images and insert fresh ones
          await (prisma as any).productImage.deleteMany({
            where: { productId: dbProduct.id },
          });

          await (prisma as any).productImage.createMany({
            data: p.images.map((img: any) => ({
              productId: dbProduct.id,
              url: img.url,
              alt: img.alt,
              type: img.type,
            })),
          });

          enriched++;
        }
      }
    } catch (enrichError: any) {
      console.warn(
        `[SyncJob] Image enrichment failed for SKU "${(product as any).sku}":`,
        enrichError?.message ?? enrichError
      );
    }
  }

  // Validate data integrity
  const validationReport = await dataValidation.validateAllProducts();
  if (!validationReport.isValid) {
    console.warn("[SyncJob] Data validation issues detected:");
    for (const issue of validationReport.issues) {
      console.warn(`  [${issue.severity}] ${issue.type}: ${issue.message}`);
    }
  }

  console.log(
    `[SyncJob] Phase 0 complete: ${created} created, ${updated} updated, ${enriched} enriched, ${errors} errors.`
  );
  if (!validationReport.isValid) {
    console.log(`[SyncJob] Validation issues: ${validationReport.issues.length}`);
  }
}

/* ================================================================== */
/*  Phase 1 — Publish new listings to eBay                             */
/* ================================================================== */

/**
 * Finds products with an Amazon ASIN but no eBay listing yet,
 * generates optimized listing data via Gemini AI, publishes to eBay,
 * and records the result.
 */
async function syncNewListings(): Promise<void> {
  console.log("[SyncJob] Phase 1: Publishing new listings to eBay…");

  const unlinkedProducts = await (prisma as any).product.findMany({
    where: {
      amazonAsin: { not: null },
      ebayItemId: null,
    },
    include: {
      variations: true,
      images: true,
    },
  });

  if (unlinkedProducts.length === 0) {
    console.log("[SyncJob] No unlinked products found. Skipping new listings.");
    return;
  }

  console.log(
    `[SyncJob] Found ${unlinkedProducts.length} unlinked product(s) to publish.`
  );

  for (const product of unlinkedProducts) {
    try {
      // Step 1: Build the ProductInput from the Prisma result
      // Use variationAttributes (Rithum pattern) with fallback to legacy name/value
      const productInput: ProductInput = {
        sku: product.sku,
        name: product.name,
        basePrice: Number(product.basePrice),
        totalStock: product.totalStock,
        upc: product.upc,
        ean: product.ean,
        brand: product.brand,
        manufacturer: product.manufacturer,
        weightValue: product.weightValue ? Number(product.weightValue) : null,
        weightUnit: product.weightUnit,
        dimLength: product.dimLength ? Number(product.dimLength) : null,
        dimWidth: product.dimWidth ? Number(product.dimWidth) : null,
        dimHeight: product.dimHeight ? Number(product.dimHeight) : null,
        dimUnit: product.dimUnit,
        bulletPoints: product.bulletPoints ?? [],
        aPlusContent: product.aPlusContent,
        keywords: product.keywords ?? [],
        variations: (product.variations ?? []).map((v: any) => {
          // Derive name/value from variationAttributes if available
          const attrs = v.variationAttributes as Record<string, string> | null;
          const attrKeys = attrs ? Object.keys(attrs) : [];
          return {
            sku: v.sku,
            name: attrKeys.length === 1 ? attrKeys[0] : (v.name ?? attrKeys.join('-')),
            value: attrKeys.length === 1 ? attrs![attrKeys[0]] : (v.value ?? Object.values(attrs ?? {}).join('-')),
            price: Number(v.price),
            stock: v.stock,
          };
        }),
        images: (product.images ?? []).map((img: any) => ({
          url: img.url,
          alt: img.alt,
          type: img.type,
        })),
      };

      // Step 2: Generate eBay listing data via Gemini AI
      const ebayData = await gemini.generateEbayListingData(productInput);

      // Step 3: Publish the listing to eBay
      const listingId = await ebay.publishNewListing(
        product.sku,
        ebayData,
        Number(product.basePrice),
        product.totalStock
      );

      // Step 4: Update the product with eBay data
      await (prisma as any).product.update({
        where: { id: product.id },
        data: {
          ebayItemId: listingId,
          ebayTitle: ebayData.ebayTitle,
        },
      });

      // Step 5: Create VariantChannelListing records for each variant
      for (const variant of (product.variations ?? [])) {
        try {
          await (prisma as any).variantChannelListing.upsert({
            where: {
              variantId_channelId: {
                variantId: variant.id,
                channelId: "EBAY", // Using channel type as ID for simplicity
              },
            },
            update: {
              channelProductId: listingId,
              channelPrice: Number(variant.price),
              channelQuantity: variant.stock,
              listingStatus: "ACTIVE",
              lastSyncedAt: new Date(),
              lastSyncStatus: "SUCCESS",
            },
            create: {
              variantId: variant.id,
              channelId: "EBAY",
              channelSku: variant.sku,
              channelProductId: listingId,
              channelPrice: Number(variant.price),
              channelQuantity: variant.stock,
              listingStatus: "ACTIVE",
              lastSyncedAt: new Date(),
              lastSyncStatus: "SUCCESS",
            },
          });
        } catch (vclError: any) {
          console.warn(
            `[SyncJob] Could not create VariantChannelListing for variant "${variant.sku}":`,
            vclError?.message ?? vclError
          );
        }
      }

      // Step 6: Record a successful sync (parent-level)
      await (prisma as any).marketplaceSync.upsert({
        where: {
          productId_channel: {
            productId: product.id,
            channel: "EBAY",
          },
        },
        update: {
          lastSyncStatus: "SUCCESS",
          lastSyncAt: new Date(),
        },
        create: {
          productId: product.id,
          channel: "EBAY",
          lastSyncStatus: "SUCCESS",
          lastSyncAt: new Date(),
        },
      });

      console.log(
        `[SyncJob] ✓ Product "${product.sku}" synced to eBay (listingId=${listingId}, variants=${product.variations?.length ?? 0})`
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      console.error(
        `[SyncJob] ✗ Failed to sync product "${product.sku}":`,
        message
      );

      // Record the failure
      try {
        await (prisma as any).marketplaceSync.upsert({
          where: {
            productId_channel: {
              productId: product.id,
              channel: "EBAY",
            },
          },
          update: {
            lastSyncStatus: "FAILED",
            lastSyncAt: new Date(),
          },
          create: {
            productId: product.id,
            channel: "EBAY",
            lastSyncStatus: "FAILED",
            lastSyncAt: new Date(),
          },
        });
      } catch (dbError) {
        console.error(
          `[SyncJob] Could not record sync failure for "${product.sku}":`,
          dbError
        );
      }
    }
  }
}

/* ================================================================== */
/*  Phase 2 — Price Parity                                             */
/* ================================================================== */

/**
 * Phase 2 — Price Parity v2 (Rithum pattern):
 * Ensures per-variant prices match across channels using VariantChannelListing.
 *
 * For each variant with channel listings:
 * - Compare variant.price (source of truth) to channelListing.channelPrice
 * - If they differ, update the channel listing and sync to marketplace
 * - Supports future repricing rules at variant level
 */
async function syncPriceParity(): Promise<void> {
  console.log("[SyncJob] Phase 2: Checking price parity (per-variant)…");

  // Find all products with variants that have channel listings
  const productsWithVariants = await (prisma as any).product.findMany({
    where: {
      amazonAsin: { not: null },
      ebayItemId: { not: null },
    },
    include: {
      variations: {
        include: {
          channelListings: true,
        },
      },
    },
  });

  if (productsWithVariants.length === 0) {
    console.log("[SyncJob] No linked products for price parity check.");
    return;
  }

  console.log(
    `[SyncJob] Checking price parity for ${productsWithVariants.length} linked product(s).`
  );

  let variantsChecked = 0;
  let variantsUpdated = 0;
  let channelListingsUpdated = 0;

  for (const product of productsWithVariants) {
    try {
      // Process each variant's channel listings
      for (const variant of (product.variations ?? [])) {
        if (!variant.isActive) continue;

        const variantPrice = Number(variant.price);
        variantsChecked++;

        // Check each channel listing for this variant
        for (const listing of (variant.channelListings ?? [])) {
          const channelPrice = Number(listing.channelPrice);

          // If prices match, skip
          if (Math.abs(variantPrice - channelPrice) < 0.01) {
            continue;
          }

          // Price drift detected — update channel listing
          console.log(
            `[SyncJob] Price drift detected for variant "${variant.sku}" on ${listing.channelId}: ` +
              `DB=${variantPrice}, Channel=${channelPrice}. Updating…`
          );

          // Update VariantChannelListing
          await (prisma as any).variantChannelListing.update({
            where: { id: listing.id },
            data: {
              channelPrice: variantPrice,
              lastSyncedAt: new Date(),
              lastSyncStatus: "PENDING",
            },
          });

          channelListingsUpdated++;

          // Call marketplace API to update price
          try {
            if (listing.channelId === "EBAY" && variant.sku) {
              await ebay.updateVariantPrice(variant.sku, variantPrice);
            } else if (listing.channelId === "AMAZON" && variant.amazonAsin) {
              await amazon.updateVariantPrice(variant.amazonAsin, variantPrice);
            }

            // Mark sync as successful
            await (prisma as any).variantChannelListing.update({
              where: { id: listing.id },
              data: {
                lastSyncStatus: "SUCCESS",
                lastSyncedAt: new Date(),
              },
            });
          } catch (apiError) {
            const errorMsg = apiError instanceof Error ? apiError.message : String(apiError);
            console.error(
              `[SyncJob] Failed to update price on ${listing.channelId} for variant "${variant.sku}":`,
              errorMsg
            );

            // Mark sync as failed
            await (prisma as any).variantChannelListing.update({
              where: { id: listing.id },
              data: {
                lastSyncStatus: "FAILED",
                lastSyncedAt: new Date(),
              },
            });
          }
        }

        // If any channel listing was updated, mark variant as updated
        if (
          (variant.channelListings ?? []).some(
            (cl: any) => Math.abs(variantPrice - Number(cl.channelPrice)) >= 0.01
          )
        ) {
          variantsUpdated++;
        }
      }

      // Record product-level sync status
      const hasFailures = (product.variations ?? []).some((v: any) =>
        (v.channelListings ?? []).some((cl: any) => cl.lastSyncStatus === "FAILED")
      );

      await (prisma as any).marketplaceSync.upsert({
        where: {
          productId_channel: {
            productId: product.id,
            channel: "EBAY",
          },
        },
        update: {
          lastSyncStatus: hasFailures ? "FAILED" : "SUCCESS",
          lastSyncAt: new Date(),
        },
        create: {
          productId: product.id,
          channel: "EBAY",
          lastSyncStatus: hasFailures ? "FAILED" : "SUCCESS",
          lastSyncAt: new Date(),
        },
      });

      console.log(
        `[SyncJob] ✓ Product "${product.sku}" price parity check complete (${product.variations?.length ?? 0} variants)`
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      console.error(
        `[SyncJob] ✗ Price parity failed for "${product.sku}":`,
        message
      );

      // Record the failure
      try {
        await (prisma as any).marketplaceSync.upsert({
          where: {
            productId_channel: {
              productId: product.id,
              channel: "EBAY",
            },
          },
          update: {
            lastSyncStatus: "FAILED",
            lastSyncAt: new Date(),
          },
          create: {
            productId: product.id,
            channel: "EBAY",
            lastSyncStatus: "FAILED",
            lastSyncAt: new Date(),
          },
        });
      } catch (dbError) {
        console.error(
          `[SyncJob] Could not record price sync failure for "${product.sku}":`,
          dbError
        );
      }
    }
  }

  console.log(
    `[SyncJob] Phase 2 complete: ${variantsChecked} variants checked, ${variantsUpdated} updated, ${channelListingsUpdated} channel listings updated.`
  );
}

/* ================================================================== */
/*  Cron scheduler                                                     */
/* ================================================================== */

/**
 * Starts the cron-based sync scheduler.
 * Runs every 30 minutes.
 */
/**
 * Multi-channel sync orchestration
 * Syncs all enabled marketplaces (Shopify, WooCommerce, Etsy)
 */
async function runMultiChannelSync(): Promise<void> {
  try {
    console.log("[SyncJob] ═══════════════════════════════════════════");
    console.log("[SyncJob] Starting multi-channel marketplace sync…");
    console.log("[SyncJob] ═══════════════════════════════════════════");

    const result = await unifiedSyncOrchestrator.syncAllMarketplaces();

    console.log("[SyncJob] ═══════════════════════════════════════════");
    console.log(`[SyncJob] Multi-channel sync complete:`);
    console.log(`[SyncJob]   - Total channels: ${result.summary.totalChannels}`);
    console.log(`[SyncJob]   - Successful: ${result.summary.successfulChannels}`);
    console.log(`[SyncJob]   - Failed: ${result.summary.failedChannels}`);
    console.log(`[SyncJob]   - Items synced: ${result.summary.totalItemsSynced}`);
    console.log(`[SyncJob]   - Items failed: ${result.summary.totalItemsFailed}`);
    console.log(`[SyncJob]   - Duration: ${result.totalDuration}ms`);
    console.log("[SyncJob] ═══════════════════════════════════════════");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[SyncJob] ✗ Multi-channel sync failed:", message);
    if (error instanceof Error && error.stack) {
      console.error("[SyncJob] Stack:", error.stack);
    }
  }
}

export function startJobs(): void {
  // Amazon → eBay sync (every 30 minutes)
  cron.schedule("*/30 * * * *", () => {
    runSync().catch((err) => {
      console.error("[SyncJob] Unhandled error in sync run:", err);
    });
  });

  // Multi-channel sync (Shopify, WooCommerce, Etsy) - every 60 minutes
  cron.schedule("0 * * * *", () => {
    runMultiChannelSync().catch((err) => {
      console.error("[SyncJob] Unhandled error in multi-channel sync:", err);
    });
  });

  // Etsy listing sync (every 60 minutes)
  cron.schedule("0 * * * *", () => {
    syncEstyListings().catch((err) => {
      console.error("[SyncJob] Unhandled error in Etsy listing sync:", err);
    });
  });

  // Etsy inventory sync (every 45 minutes)
  cron.schedule("*/45 * * * *", () => {
    syncEstyInventory().catch((err) => {
      console.error("[SyncJob] Unhandled error in Etsy inventory sync:", err);
    });
  });

  // Etsy order sync (every 30 minutes)
  cron.schedule("*/30 * * * *", () => {
    syncEstyOrders().catch((err) => {
      console.error("[SyncJob] Unhandled error in Etsy order sync:", err);
    });
  });

  console.log("[SyncJob] Cron scheduler started:");
  console.log("  - Amazon → eBay sync: every 30 minutes");
  console.log("  - Multi-channel sync (Shopify/WooCommerce/Etsy): every 60 minutes");
  console.log("  - Etsy listing sync: every 60 minutes");
  console.log("  - Etsy inventory sync: every 45 minutes");
  console.log("  - Etsy order sync: every 30 minutes");
}
