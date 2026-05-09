/**
 * WooCommerce Sync Job
 * Scheduled job for syncing products, inventory, and orders from WooCommerce
 */

import prisma from "../db.js";
import { WooCommerceSyncService } from "../services/sync/woocommerce-sync.service.js";
import { ConfigManager } from "../utils/config.js";
import type { WooCommerceConfig } from "../types/marketplace.js";
import { recordCronRun } from "../utils/cron-observability.js";

/**
 * Run WooCommerce product sync
 */
export async function syncWooCommerceProducts(): Promise<void> {
  const config = ConfigManager.getConfig("WOOCOMMERCE") as WooCommerceConfig;
  if (!config) {
    console.warn("[WooCommerceSyncJob] WooCommerce is not configured");
    return;
  }

  await recordCronRun("woocommerce-sync-products", async () => {
    console.log("[WooCommerceSyncJob] Starting WooCommerce product sync…");
    const syncService = new WooCommerceSyncService(config);
    const result = await syncService.syncProducts(100);

    console.log(
      `[WooCommerceSyncJob] Product sync complete: ${result.productsCreated} created, ${result.productsUpdated} updated, ${result.errors.length} errors`
    );

    // Log sync result
    await (prisma as any).syncLog.create({
      data: {
        channel: "WOOCOMMERCE",
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

    return `created=${result.productsCreated} updated=${result.productsUpdated} errors=${result.errors.length}`;
  }).catch(async (error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[WooCommerceSyncJob] Product sync failed:", message);

    // Log error
    await (prisma as any).syncLog.create({
      data: {
        channel: "WOOCOMMERCE",
        syncType: "PRODUCTS",
        status: "FAILED",
        itemsProcessed: 0,
        itemsFailed: 0,
        details: { error: message },
      },
    });
  });
}

/**
 * Run WooCommerce inventory sync
 */
export async function syncWooCommerceInventory(): Promise<void> {
  const config = ConfigManager.getConfig("WOOCOMMERCE") as WooCommerceConfig;
  if (!config) {
    console.warn("[WooCommerceSyncJob] WooCommerce is not configured");
    return;
  }

  await recordCronRun("woocommerce-sync-inventory", async () => {
    console.log("[WooCommerceSyncJob] Starting WooCommerce inventory sync…");
    const syncService = new WooCommerceSyncService(config);

    // Get all products with WooCommerce IDs
    const products = await (prisma as any).product.findMany({
      where: { woocommerceProductId: { not: null } },
      select: { id: true, woocommerceProductId: true },
    });

    let totalUpdated = 0;
    let totalFailed = 0;
    const errors = [];

    for (const product of products) {
      try {
        const result = await syncService.syncInventoryFromWooCommerce(product.id);
        totalUpdated += result.updated;
        totalFailed += result.failed;
        errors.push(...result.errors);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(
          `[WooCommerceSyncJob] Failed to sync inventory for product ${product.woocommerceProductId}:`,
          message
        );
        totalFailed++;
        errors.push({
          variantId: product.id,
          error: message,
        });
      }
    }

    console.log(
      `[WooCommerceSyncJob] Inventory sync complete: ${totalUpdated} updated, ${totalFailed} failed`
    );

    // Log sync result
    await (prisma as any).syncLog.create({
      data: {
        channel: "WOOCOMMERCE",
        syncType: "INVENTORY",
        status: totalFailed === 0 ? "SUCCESS" : "PARTIAL",
        itemsProcessed: totalUpdated,
        itemsFailed: totalFailed,
        details: {
          updated: totalUpdated,
          failed: totalFailed,
          errors,
        },
      },
    });

    return `updated=${totalUpdated} failed=${totalFailed} products=${products.length}`;
  }).catch(async (error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[WooCommerceSyncJob] Inventory sync failed:", message);

    // Log error
    await (prisma as any).syncLog.create({
      data: {
        channel: "WOOCOMMERCE",
        syncType: "INVENTORY",
        status: "FAILED",
        itemsProcessed: 0,
        itemsFailed: 0,
        details: { error: message },
      },
    });
  });
}

/**
 * Run WooCommerce order sync
 */
export async function syncWooCommerceOrders(): Promise<void> {
  const config = ConfigManager.getConfig("WOOCOMMERCE") as WooCommerceConfig;
  if (!config) {
    console.warn("[WooCommerceSyncJob] WooCommerce is not configured");
    return;
  }

  await recordCronRun("woocommerce-sync-orders", async () => {
    console.log("[WooCommerceSyncJob] Starting WooCommerce order sync…");
    const syncService = new WooCommerceSyncService(config);
    const result = await syncService.syncOrders(100);

    console.log(
      `[WooCommerceSyncJob] Order sync complete: ${result.created} created, ${result.updated} updated, ${result.errors.length} errors`
    );

    // Log sync result
    await (prisma as any).syncLog.create({
      data: {
        channel: "WOOCOMMERCE",
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

    return `created=${result.created} updated=${result.updated} errors=${result.errors.length}`;
  }).catch(async (error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[WooCommerceSyncJob] Order sync failed:", message);

    // Log error
    await (prisma as any).syncLog.create({
      data: {
        channel: "WOOCOMMERCE",
        syncType: "ORDERS",
        status: "FAILED",
        itemsProcessed: 0,
        itemsFailed: 0,
        details: { error: message },
      },
    });
  });
}

/**
 * Run all WooCommerce sync jobs
 */
export async function runAllWooCommerceSyncJobs(): Promise<void> {
  console.log("[WooCommerceSyncJob] Running all WooCommerce sync jobs…");
  await syncWooCommerceProducts();
  await syncWooCommerceInventory();
  await syncWooCommerceOrders();
  console.log("[WooCommerceSyncJob] All WooCommerce sync jobs complete");
}
