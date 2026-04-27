/**
 * Marketplace API Routes
 * Handles marketplace-specific operations (pricing, inventory, sync)
 */

import type { FastifyInstance } from "fastify";
import prisma from "../db.js";
import {
  marketplaceService,
  type MarketplaceVariantUpdate,
  type MarketplaceChannel,
} from "../services/marketplaces/marketplace.service.js";

interface UpdatePriceBody {
  updates: Array<{
    channel: MarketplaceChannel;
    channelVariantId: string;
    price: number;
  }>;
  dryRun?: boolean;
}

interface UpdateInventoryBody {
  updates: Array<{
    channel: MarketplaceChannel;
    channelVariantId: string;
    inventory: number;
    locationId?: string;
  }>;
  dryRun?: boolean;
}

interface SyncVariantBody {
  variantId: string;
  channels: MarketplaceChannel[];
}

export async function marketplaceRoutes(app: FastifyInstance) {
  /**
   * GET /marketplaces/status
   * Get status of all connected marketplaces
   */
  app.get("/marketplaces/status", async (request, reply) => {
    try {
      const available = marketplaceService.getAvailableMarketplaces();

      return reply.send({
        success: true,
        marketplaces: available.map((channel) => ({
          channel,
          available: marketplaceService.isMarketplaceAvailable(channel),
        })),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[MarketplaceRoutes] Status check failed:", message);
      return reply.status(500).send({
        success: false,
        error: message,
      });
    }
  });

  /**
   * POST /marketplaces/prices/update
   * Update prices across one or more marketplaces
   */
  app.post<{ Body: UpdatePriceBody }>(
    "/marketplaces/prices/update",
    async (request, reply) => {
      try {
        const { updates, dryRun = false } = request.body;

        if (!Array.isArray(updates) || updates.length === 0) {
          return reply.status(400).send({
            success: false,
            error: "updates array is required and must not be empty",
          });
        }

        // Validate all updates
        for (const update of updates) {
          if (!update.channel || !update.channelVariantId || update.price === undefined) {
            return reply.status(400).send({
              success: false,
              error: "Each update must have channel, channelVariantId, and price",
            });
          }

          if (!marketplaceService.isMarketplaceAvailable(update.channel)) {
            return reply.status(400).send({
              success: false,
              error: `Marketplace ${update.channel} is not available`,
            });
          }
        }

        if (dryRun) {
          return reply.send({
            success: true,
            dryRun: true,
            message: "Dry run completed successfully",
            updates: updates.map((u) => ({
              channel: u.channel,
              channelVariantId: u.channelVariantId,
              newPrice: u.price,
              status: "would_update",
            })),
          });
        }

        // Execute price updates with retry logic
        const results = await marketplaceService.batchUpdatePrices(
          updates as MarketplaceVariantUpdate[]
        );

        const successful = results.filter((r) => r.success).length;
        const failed = results.filter((r) => !r.success).length;

        return reply.send({
          success: failed === 0,
          summary: {
            total: results.length,
            successful,
            failed,
          },
          results,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[MarketplaceRoutes] Price update failed:", message);
        return reply.status(500).send({
          success: false,
          error: message,
        });
      }
    }
  );

  /**
   * POST /marketplaces/inventory/update
   * Update inventory across one or more marketplaces
   */
  app.post<{ Body: UpdateInventoryBody }>(
    "/marketplaces/inventory/update",
    async (request, reply) => {
      try {
        const { updates, dryRun = false } = request.body;

        if (!Array.isArray(updates) || updates.length === 0) {
          return reply.status(400).send({
            success: false,
            error: "updates array is required and must not be empty",
          });
        }

        // Validate all updates
        for (const update of updates) {
          if (!update.channel || !update.channelVariantId || update.inventory === undefined) {
            return reply.status(400).send({
              success: false,
              error: "Each update must have channel, channelVariantId, and inventory",
            });
          }

          if (!marketplaceService.isMarketplaceAvailable(update.channel)) {
            return reply.status(400).send({
              success: false,
              error: `Marketplace ${update.channel} is not available`,
            });
          }
        }

        if (dryRun) {
          return reply.send({
            success: true,
            dryRun: true,
            message: "Dry run completed successfully",
            updates: updates.map((u) => ({
              channel: u.channel,
              channelVariantId: u.channelVariantId,
              newInventory: u.inventory,
              status: "would_update",
            })),
          });
        }

        // Execute inventory updates with retry logic
        const results = await marketplaceService.batchUpdateInventory(
          updates as MarketplaceVariantUpdate[]
        );

        const successful = results.filter((r) => r.success).length;
        const failed = results.filter((r) => !r.success).length;

        return reply.send({
          success: failed === 0,
          summary: {
            total: results.length,
            successful,
            failed,
          },
          results,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[MarketplaceRoutes] Inventory update failed:", message);
        return reply.status(500).send({
          success: false,
          error: message,
        });
      }
    }
  );

  /**
   * POST /marketplaces/variants/sync
   * Sync a variant to one or more marketplaces
   */
  app.post<{ Body: SyncVariantBody }>(
    "/marketplaces/variants/sync",
    async (request, reply) => {
      try {
        const { variantId, channels } = request.body;

        if (!variantId || !Array.isArray(channels) || channels.length === 0) {
          return reply.status(400).send({
            success: false,
            error: "variantId and channels array are required",
          });
        }

        // Get variant with pricing and channel listings
        const variant = await (prisma as any).productVariation.findUnique({
          where: { id: variantId },
          include: {
            product: true,
            channelListings: true,
          },
        });

        if (!variant) {
          return reply.status(404).send({
            success: false,
            error: `Variant ${variantId} not found`,
          });
        }

        // Build price updates for requested channels
        const priceUpdates: MarketplaceVariantUpdate[] = [];

        for (const channel of channels) {
          if (!marketplaceService.isMarketplaceAvailable(channel)) {
            continue;
          }

          // Find existing channel listing or create new one
          let listing = variant.channelListings.find((cl: any) => cl.channelId === channel);

          if (!listing) {
            // Create new channel listing
            listing = await (prisma as any).variantChannelListing.create({
              data: {
                variantId: variant.id,
                channelId: channel,
                channelPrice: Number(variant.price),
                channelSku: variant.sku,
                lastSyncStatus: "PENDING",
              },
            });
          }

          // Determine channel variant ID
          let channelVariantId = "";
          if (channel === "AMAZON" && variant.amazonAsin) {
            channelVariantId = variant.amazonAsin;
          } else if (channel === "EBAY") {
            channelVariantId = variant.sku;
          } else if (channel === "SHOPIFY" && listing.channelVariantId) {
            channelVariantId = listing.channelVariantId;
          }

          if (channelVariantId) {
            priceUpdates.push({
              channel,
              channelVariantId,
              price: Number(variant.price),
            });
          }
        }

        if (priceUpdates.length === 0) {
          return reply.status(400).send({
            success: false,
            error: "No valid channel variant IDs found for sync",
          });
        }

        // Execute sync
        const results = await marketplaceService.batchUpdatePrices(priceUpdates);

        // Update channel listings with sync results
        for (let i = 0; i < results.length; i++) {
          const result = results[i];
          const listing = variant.channelListings.find(
            (cl: any) => cl.channelId === result.channel
          );

          if (listing) {
            await (prisma as any).variantChannelListing.update({
              where: { id: listing.id },
              data: {
                lastSyncStatus: result.success ? "SUCCESS" : "FAILED",
                lastSyncedAt: new Date(),
              },
            });
          }
        }

        const successful = results.filter((r) => r.success).length;
        const failed = results.filter((r) => !r.success).length;

        return reply.send({
          success: failed === 0,
          variantId,
          summary: {
            total: results.length,
            successful,
            failed,
          },
          results,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[MarketplaceRoutes] Variant sync failed:", message);
        return reply.status(500).send({
          success: false,
          error: message,
        });
      }
    }
  );

  /**
   * GET /marketplaces/variants/:variantId/listings
   * Get all channel listings for a variant
   */
  app.get<{ Params: { variantId: string } }>(
    "/marketplaces/variants/:variantId/listings",
    async (request, reply) => {
      try {
        const { variantId } = request.params;

        const variant = await (prisma as any).productVariation.findUnique({
          where: { id: variantId },
          include: {
            channelListings: true,
          },
        });

        if (!variant) {
          return reply.status(404).send({
            success: false,
            error: `Variant ${variantId} not found`,
          });
        }

        return reply.send({
          success: true,
          variantId,
          sku: variant.sku,
          price: variant.price,
          listings: variant.channelListings.map((listing: any) => ({
            id: listing.id,
            channel: listing.channelId,
            channelSku: listing.channelSku,
            channelVariantId: listing.channelVariantId,
            channelPrice: listing.channelPrice,
            lastSyncStatus: listing.lastSyncStatus,
            lastSyncedAt: listing.lastSyncedAt,
          })),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[MarketplaceRoutes] Get listings failed:", message);
        return reply.status(500).send({
          success: false,
          error: message,
        });
      }
    }
  );

  /**
   * POST /marketplaces/sync-all
   * Sync all variants with price changes to their connected marketplaces
   */
  app.post("/marketplaces/sync-all", async (request, reply) => {
    try {
      console.log("[MarketplaceRoutes] Starting full marketplace sync…");

      // Find all variants with channel listings
      const variants = await (prisma as any).productVariation.findMany({
        where: {
          channelListings: {
            some: {},
          },
        },
        include: {
          channelListings: true,
        },
      });

      if (variants.length === 0) {
        return reply.send({
          success: true,
          message: "No variants with channel listings found",
          summary: {
            total: 0,
            synced: 0,
            failed: 0,
          },
        });
      }

      let totalSynced = 0;
      let totalFailed = 0;
      const allResults = [];

      // Sync each variant
      for (const variant of variants) {
        const priceUpdates: MarketplaceVariantUpdate[] = [];

        for (const listing of variant.channelListings) {
          // Check if price has drifted
          if (Math.abs(Number(variant.price) - Number(listing.channelPrice)) < 0.01) {
            continue;
          }

          let channelVariantId = "";
          if (listing.channelId === "AMAZON" && variant.amazonAsin) {
            channelVariantId = variant.amazonAsin;
          } else if (listing.channelId === "EBAY") {
            channelVariantId = variant.sku;
          } else if (listing.channelVariantId) {
            channelVariantId = listing.channelVariantId;
          }

          if (channelVariantId) {
            priceUpdates.push({
              channel: listing.channelId,
              channelVariantId,
              price: Number(variant.price),
            });
          }
        }

        if (priceUpdates.length > 0) {
          const results = await marketplaceService.batchUpdatePrices(priceUpdates);
          allResults.push(...results);

          totalSynced += results.filter((r) => r.success).length;
          totalFailed += results.filter((r) => !r.success).length;

          // Update channel listings
          for (let i = 0; i < results.length; i++) {
            const result = results[i];
            const listing = variant.channelListings.find(
              (cl: any) => cl.channelId === result.channel
            );

            if (listing) {
              await (prisma as any).variantChannelListing.update({
                where: { id: listing.id },
                data: {
                  lastSyncStatus: result.success ? "SUCCESS" : "FAILED",
                  lastSyncedAt: new Date(),
                },
              });
            
              /**
               * GET /marketplaces/health
               * Get health status of all connected marketplaces
               */
              app.get("/marketplaces/health", async (request, reply) => {
                try {
                  const statuses = await marketplaceService.getMarketplaceHealthStatus();
            
                  return reply.send({
                    success: true,
                    statuses,
                    timestamp: new Date(),
                  });
                } catch (error) {
                  const message = error instanceof Error ? error.message : String(error);
                  console.error("[MarketplaceRoutes] Health check failed:", message);
                  return reply.status(500).send({
                    success: false,
                    error: message,
                  });
                }
              });
            
              /**
               * POST /marketplaces/products/:productId/sync
               * Sync a product across multiple channels
               */
              app.post<{ Params: { productId: string }; Body: { channels: MarketplaceChannel[] } }>(
                "/marketplaces/products/:productId/sync",
                async (request, reply) => {
                  try {
                    const { productId } = request.params;
                    const { channels } = request.body;
            
                    if (!productId || !Array.isArray(channels) || channels.length === 0) {
                      return reply.status(400).send({
                        success: false,
                        error: "productId and channels array are required",
                      });
                    }
            
                    const results = await marketplaceService.syncProductsAcrossChannels(
                      productId,
                      channels
                    );
            
                    const successful = results.filter((r) => r.success).length;
                    const failed = results.filter((r) => !r.success).length;
            
                    return reply.send({
                      success: failed === 0,
                      productId,
                      summary: {
                        total: results.length,
                        successful,
                        failed,
                      },
                      results,
                    });
                  } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    console.error("[MarketplaceRoutes] Product sync failed:", message);
                    return reply.status(500).send({
                      success: false,
                      error: message,
                    });
                  }
                }
              );
            }
          }
        }
      }

      console.log(
        `[MarketplaceRoutes] Full sync complete: ${totalSynced} synced, ${totalFailed} failed`
      );

      return reply.send({
        success: totalFailed === 0,
        summary: {
          total: allResults.length,
          synced: totalSynced,
          failed: totalFailed,
        },
        results: allResults,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[MarketplaceRoutes] Full sync failed:", message);
      return reply.status(500).send({
        success: false,
        error: message,
      });
    }
  });
}
