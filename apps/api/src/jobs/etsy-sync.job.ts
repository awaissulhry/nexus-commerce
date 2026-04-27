/**
 * Etsy Sync Job
 * Scheduled job for syncing listings, inventory, and orders from Etsy
 */

import prisma from "../db.js";
import { EstySyncService } from "../services/sync/etsy-sync.service.js";
import { ConfigManager } from "../utils/config.js";
import type { EtsyConfig } from "../types/marketplace.js";

/**
 * Run Etsy listing sync
 */
export async function syncEstyListings(): Promise<void> {
  try {
    console.log("[EstySyncJob] Starting Etsy listing sync…");

    const config = ConfigManager.getConfig("ETSY") as EtsyConfig;
    if (!config) {
      console.warn("[EstySyncJob] Etsy is not configured");
      return;
    }

    const syncService = new EstySyncService(config);
    const result = await syncService.syncListings(100);

    console.log(
      `[EstySyncJob] Listing sync complete: ${result.listingsCreated} created, ${result.listingsUpdated} updated, ${result.errors.length} errors`
    );

    // Log sync result
    await (prisma as any).syncLog.create({
      data: {
        channel: "ETSY",
        syncType: "LISTINGS",
        status: result.success ? "SUCCESS" : "FAILED",
        itemsProcessed: result.listingsCreated + result.listingsUpdated,
        itemsFailed: result.errors.length,
        details: {
          listingsCreated: result.listingsCreated,
          listingsUpdated: result.listingsUpdated,
          variantsCreated: result.variantsCreated,
          variantsUpdated: result.variantsUpdated,
          errors: result.errors,
        },
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[EstySyncJob] Listing sync failed:", message);

    // Log error
    await (prisma as any).syncLog.create({
      data: {
        channel: "ETSY",
        syncType: "LISTINGS",
        status: "FAILED",
        itemsProcessed: 0,
        itemsFailed: 0,
        details: { error: message },
      },
    });
  }
}

/**
 * Run Etsy inventory sync
 */
export async function syncEstyInventory(): Promise<void> {
  try {
    console.log("[EstySyncJob] Starting Etsy inventory sync…");

    const config = ConfigManager.getConfig("ETSY") as EtsyConfig;
    if (!config) {
      console.warn("[EstySyncJob] Etsy is not configured");
      return;
    }

    const syncService = new EstySyncService(config);

    // Get all products with Etsy listing IDs
    const products = await (prisma as any).product.findMany({
      where: { etsyListingId: { not: null } },
      select: { id: true, etsyListingId: true },
    });

    let totalUpdated = 0;
    let totalFailed = 0;
    const errors = [];

    for (const product of products) {
      try {
        const result = await syncService.syncInventoryFromEtsy(product.id);
        totalUpdated += result.updated;
        totalFailed += result.failed;
        errors.push(...result.errors);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(
          `[EstySyncJob] Failed to sync inventory for listing ${product.etsyListingId}:`,
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
      `[EstySyncJob] Inventory sync complete: ${totalUpdated} updated, ${totalFailed} failed`
    );

    // Log sync result
    await (prisma as any).syncLog.create({
      data: {
        channel: "ETSY",
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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[EstySyncJob] Inventory sync failed:", message);

    // Log error
    await (prisma as any).syncLog.create({
      data: {
        channel: "ETSY",
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
 * Run Etsy order sync
 */
export async function syncEstyOrders(): Promise<void> {
  try {
    console.log("[EstySyncJob] Starting Etsy order sync…");

    const config = ConfigManager.getConfig("ETSY") as EtsyConfig;
    if (!config) {
      console.warn("[EstySyncJob] Etsy is not configured");
      return;
    }

    const syncService = new EstySyncService(config);
    const result = await syncService.syncOrders(100);

    console.log(
      `[EstySyncJob] Order sync complete: ${result.created} created, ${result.updated} updated, ${result.errors.length} errors`
    );

    // Log sync result
    await (prisma as any).syncLog.create({
      data: {
        channel: "ETSY",
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
    console.error("[EstySyncJob] Order sync failed:", message);

    // Log error
    await (prisma as any).syncLog.create({
      data: {
        channel: "ETSY",
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
 * Run all Etsy sync jobs
 */
export async function runAllEstySyncJobs(): Promise<void> {
  console.log("[EstySyncJob] Running all Etsy sync jobs…");
  await syncEstyListings();
  await syncEstyInventory();
  await syncEstyOrders();
  console.log("[EstySyncJob] All Etsy sync jobs complete");
}
