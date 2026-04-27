/**
 * Etsy API Routes
 * Handles listing sync, inventory sync, and order management
 */

import type { FastifyInstance } from "fastify";
import prisma from "../db.js";
import { EstySyncService } from "../services/sync/etsy-sync.service.js";
import { ConfigManager } from "../utils/config.js";
import type { EtsyConfig } from "../types/marketplace.js";

interface SyncListingsBody {
  limit?: number;
}

interface SyncInventoryBody {
  variantId: string;
  quantity: number;
}

interface SyncOrdersBody {
  limit?: number;
}

interface UpdateOrderStatusBody {
  orderId: string;
  status: string;
}

interface AddFulfillmentNoteBody {
  orderId: string;
  trackingNumber?: string;
}

export async function estyRoutes(app: FastifyInstance) {
  /**
   * POST /etsy/sync/listings
   * Sync all listings from Etsy to Nexus
   */
  app.post<{ Body: SyncListingsBody }>("/etsy/sync/listings", async (request, reply) => {
    try {
      const { limit = 100 } = request.body;

      // Get Etsy config
      const config = ConfigManager.getConfig("ETSY") as EtsyConfig;
      if (!config) {
        return reply.status(400).send({
          success: false,
          error: "Etsy is not configured",
        });
      }

      const syncService = new EstySyncService(config);
      const result = await syncService.syncListings(limit);

      return reply.send({
        success: result.success,
        summary: {
          listingsCreated: result.listingsCreated,
          listingsUpdated: result.listingsUpdated,
          variantsCreated: result.variantsCreated,
          variantsUpdated: result.variantsUpdated,
          totalErrors: result.errors.length,
        },
        errors: result.errors,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[EstyRoutes] Listing sync failed:", message);
      return reply.status(500).send({
        success: false,
        error: message,
      });
    }
  });

  /**
   * POST /etsy/sync/inventory/to-etsy
   * Sync inventory from Nexus to Etsy
   */
  app.post<{ Body: SyncInventoryBody }>(
    "/etsy/sync/inventory/to-etsy",
    async (request, reply) => {
      try {
        const { variantId, quantity } = request.body;

        if (!variantId || quantity === undefined) {
          return reply.status(400).send({
            success: false,
            error: "Missing required fields: variantId, quantity",
          });
        }

        // Get Etsy config
        const config = ConfigManager.getConfig("ETSY") as EtsyConfig;
        if (!config) {
          return reply.status(400).send({
            success: false,
            error: "Etsy is not configured",
          });
        }

        const syncService = new EstySyncService(config);
        await syncService.syncInventoryToEtsy(variantId, quantity);

        return reply.send({
          success: true,
          message: `Inventory synced to Etsy: variant ${variantId} = ${quantity}`,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[EstyRoutes] Inventory sync to Etsy failed:", message);
        return reply.status(500).send({
          success: false,
          error: message,
        });
      }
    }
  );

  /**
   * POST /etsy/sync/inventory/from-etsy
   * Sync inventory from Etsy to Nexus
   */
  app.post<{ Body: { productId: string } }>(
    "/etsy/sync/inventory/from-etsy",
    async (request, reply) => {
      try {
        const { productId } = request.body;

        if (!productId) {
          return reply.status(400).send({
            success: false,
            error: "Missing required field: productId",
          });
        }

        // Get Etsy config
        const config = ConfigManager.getConfig("ETSY") as EtsyConfig;
        if (!config) {
          return reply.status(400).send({
            success: false,
            error: "Etsy is not configured",
          });
        }

        const syncService = new EstySyncService(config);
        const result = await syncService.syncInventoryFromEtsy(productId);

        return reply.send({
          success: result.success,
          summary: {
            updated: result.updated,
            failed: result.failed,
            totalErrors: result.errors.length,
          },
          errors: result.errors,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[EstyRoutes] Inventory sync from Etsy failed:", message);
        return reply.status(500).send({
          success: false,
          error: message,
        });
      }
    }
  );

  /**
   * POST /etsy/sync/orders
   * Sync orders from Etsy to Nexus
   */
  app.post<{ Body: SyncOrdersBody }>("/etsy/sync/orders", async (request, reply) => {
    try {
      const { limit = 100 } = request.body;

      // Get Etsy config
      const config = ConfigManager.getConfig("ETSY") as EtsyConfig;
      if (!config) {
        return reply.status(400).send({
          success: false,
          error: "Etsy is not configured",
        });
      }

      const syncService = new EstySyncService(config);
      const result = await syncService.syncOrders(limit);

      return reply.send({
        success: result.success,
        summary: {
          ordersCreated: result.created,
          ordersUpdated: result.updated,
          totalErrors: result.errors.length,
        },
        errors: result.errors,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[EstyRoutes] Order sync failed:", message);
      return reply.status(500).send({
        success: false,
        error: message,
      });
    }
  });

  /**
   * POST /etsy/orders/:orderId/status
   * Update order status in Etsy
   */
  app.post<{ Params: { orderId: string }; Body: UpdateOrderStatusBody }>(
    "/etsy/orders/:orderId/status",
    async (request, reply) => {
      try {
        const { orderId } = request.params;
        const { status } = request.body;

        if (!status) {
          return reply.status(400).send({
            success: false,
            error: "Missing required field: status",
          });
        }

        // Get Etsy config
        const config = ConfigManager.getConfig("ETSY") as EtsyConfig;
        if (!config) {
          return reply.status(400).send({
            success: false,
            error: "Etsy is not configured",
          });
        }

        const syncService = new EstySyncService(config);
        await syncService.updateOrderStatus(orderId, status);

        return reply.send({
          success: true,
          message: `Order status updated: ${orderId} = ${status}`,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[EstyRoutes] Order status update failed:", message);
        return reply.status(500).send({
          success: false,
          error: message,
        });
      }
    }
  );

  /**
   * POST /etsy/orders/:orderId/fulfillment
   * Add fulfillment note to order
   */
  app.post<{ Params: { orderId: string }; Body: AddFulfillmentNoteBody }>(
    "/etsy/orders/:orderId/fulfillment",
    async (request, reply) => {
      try {
        const { orderId } = request.params;
        const { trackingNumber } = request.body;

        // Get Etsy config
        const config = ConfigManager.getConfig("ETSY") as EtsyConfig;
        if (!config) {
          return reply.status(400).send({
            success: false,
            error: "Etsy is not configured",
          });
        }

        const syncService = new EstySyncService(config);
        await syncService.addFulfillmentNote(orderId, trackingNumber);

        return reply.send({
          success: true,
          message: `Fulfillment note added: ${orderId}`,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[EstyRoutes] Fulfillment note failed:", message);
        return reply.status(500).send({
          success: false,
          error: message,
        });
      }
    }
  );
}
