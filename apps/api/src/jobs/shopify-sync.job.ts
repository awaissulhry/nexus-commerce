/**
 * Shopify Sync Job
 * Scheduled job for syncing products, inventory, and orders from Shopify
 */

import prisma from "../db.js";
import { ShopifySyncService } from "../services/sync/shopify-sync.service.js";
import { ConfigManager } from "../utils/config.js";
import type { ShopifyConfig } from "../types/marketplace.js";

/**
 * Run Shopify product sync
 */
export async function syncShopifyProducts(): Promise<void> {
  try {
    console.log("[ShopifySyncJob] Starting Shopify product sync…");

    const config = ConfigManager.getConfig("SHOPIFY") as ShopifyConfig;
    if (!config) {
      console.warn("[ShopifySyncJob] Shopify is not configured");
      return;
    }

    const syncService = new ShopifySyncService(config);
    const result = await syncService.syncProducts(100);

    console.log(
      `[ShopifySyncJob] Product sync complete: ${result.productsCreated} created, ${result.productsUpdated} updated, ${result.errors.length} errors`
    );

    // Log sync result
    await (prisma as any).syncLog.create({
      data: {
        channel: "SHOPIFY",
        syncType: "PRODUCTS",
        status: result.success ? "SUCCESS" : "FAILED",
        itemsProcessed: result.productsCreated + result.productsUpdated,
        itemsFailed: result.errors.length,
        details: {
          productsCreated: result.productsCreated,
          productsUpdated: result.productsUpdated,
          variantsCreated: result.variantsCreated,
          variantsUpdated: result.variantsUpdated,
          errors: result.errors,
        },
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[ShopifySyncJob] Product sync failed:", message);

    // Log error
    await (prisma as any).syncLog.create({
      data: {
        channel: "SHOPIFY",
        syncType: "PRODUCTS",
        status: "FAILED",
        itemsProcessed: 0,
        itemsFailed: 0,
        details: { error: message },
      },
    });
  }
}

/**
 * Run Shopify inventory sync
 */
export async function syncShopifyInventory(): Promise<void> {
  try {
    console.log("[ShopifySyncJob] Starting Shopify inventory sync…");

    const config = ConfigManager.getConfig("SHOPIFY") as ShopifyConfig;
    if (!config) {
      console.warn("[ShopifySyncJob] Shopify is not configured");
      return;
    }

    const syncService = new ShopifySyncService(config);

    // Get all products with Shopify IDs
    const products = await (prisma as any).product.findMany({
      where: { shopifyProductId: { not: null } },
      select: { shopifyProductId: true },
    });

    let totalUpdated = 0;
    let totalFailed = 0;
    const errors = [];

    for (const product of products) {
      try {
        const result = await syncService.syncInventoryFromShopify(product.shopifyProductId);
        totalUpdated += result.updated;
        totalFailed += result.failed;
        errors.push(...result.errors);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(
          `[ShopifySyncJob] Failed to sync inventory for product ${product.shopifyProductId}:`,
          message
        );
        totalFailed++;
      }
    }

    console.log(
      `[ShopifySyncJob] Inventory sync complete: ${totalUpdated} updated, ${totalFailed} failed`
    );

    // Log sync result
    await (prisma as any).syncLog.create({
      data: {
        channel: "SHOPIFY",
        syncType: "INVENTORY",
        status: totalFailed === 0 ? "SUCCESS" : "PARTIAL",
        itemsProcessed: totalUpdated,
        itemsFailed: totalFailed,
        details: { errors },
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[ShopifySyncJob] Inventory sync failed:", message);

    // Log error
    await (prisma as any).syncLog.create({
      data: {
        channel: "SHOPIFY",
        syncType: "INVENTORY",
        status: "FAILED",
        itemsProcessed: 0,
        itemsFailed: 0,
        details: { error: message },
      },
    });
  }
}

/**
 * Run Shopify order sync
 */
export async function syncShopifyOrders(): Promise<void> {
  try {
    console.log("[ShopifySyncJob] Starting Shopify order sync…");

    const config = ConfigManager.getConfig("SHOPIFY") as ShopifyConfig;
    if (!config) {
      console.warn("[ShopifySyncJob] Shopify is not configured");
      return;
    }

    const syncService = new ShopifySyncService(config);
    const result = await syncService.syncOrders(50);

    console.log(
      `[ShopifySyncJob] Order sync complete: ${result.created} created, ${result.updated} updated, ${result.errors.length} errors`
    );

    // Log sync result
    await (prisma as any).syncLog.create({
      data: {
        channel: "SHOPIFY",
        syncType: "ORDERS",
        status: result.success ? "SUCCESS" : "FAILED",
        itemsProcessed: result.created + result.updated,
        itemsFailed: result.errors.length,
        details: {
          created: result.created,
          updated: result.updated,
          errors: result.errors,
        },
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[ShopifySyncJob] Order sync failed:", message);

    // Log error
    await (prisma as any).syncLog.create({
      data: {
        channel: "SHOPIFY",
        syncType: "ORDERS",
        status: "FAILED",
        itemsProcessed: 0,
        itemsFailed: 0,
        details: { error: message },
      },
    });
  }
}

/**
 * Run all Shopify sync jobs
 */
export async function runAllShopifySyncJobs(): Promise<void> {
  console.log("[ShopifySyncJob] Running all Shopify sync jobs…");

  try {
    await syncShopifyProducts();
    await syncShopifyInventory();
    await syncShopifyOrders();

    console.log("[ShopifySyncJob] All Shopify sync jobs completed");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[ShopifySyncJob] Shopify sync jobs failed:", message);
  }
}
