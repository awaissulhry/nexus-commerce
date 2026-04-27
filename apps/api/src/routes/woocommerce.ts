/**
 * WooCommerce API Routes
 * Handles product sync, inventory sync, and order management
 */

import type { FastifyInstance } from "fastify";
import prisma from "../db.js";
import { WooCommerceSyncService } from "../services/sync/woocommerce-sync.service.js";
import { ConfigManager } from "../utils/config.js";
import type { WooCommerceConfig } from "../types/marketplace.js";

interface SyncProductsBody {
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
  orderId: number;
  status: string;
}

interface AddFulfillmentNoteBody {
  orderId: number;
  trackingNumber?: string;
}

export async function woocommerceRoutes(app: FastifyInstance) {
  /**
   * POST /woocommerce/sync/products
   * Sync all products from WooCommerce to Nexus
   */
  app.post<{ Body: SyncProductsBody }>("/woocommerce/sync/products", async (request, reply) => {
    try {
      const { limit = 100 } = request.body;

      // Get WooCommerce config
      const config = ConfigManager.getConfig("WOOCOMMERCE") as WooCommerceConfig;
      if (!config) {
        return reply.status(400).send({
          success: false,
          error: "WooCommerce is not configured",
        });
      }

      const syncService = new WooCommerceSyncService(config);
      const result = await syncService.syncProducts(limit);

      return reply.send({
        success: result.success,
        summary: {
          productsCreated: result.productsCreated,
          productsUpdated: result.productsUpdated,
          variantsCreated: result.variantsCreated,
          variantsUpdated: result.variantsUpdated,
          totalErrors: result.errors.length,
        },
        errors: result.errors,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[WooCommerceRoutes] Product sync failed:", message);
      return reply.status(500).send({
        success: false,
        error: message,
      });
    }
  });

  /**
   * POST /woocommerce/sync/inventory/to-woocommerce
   * Sync inventory from Nexus to WooCommerce
   */
  app.post<{ Body: SyncInventoryBody }>(
    "/woocommerce/sync/inventory/to-woocommerce",
    async (request, reply) => {
      try {
        const { variantId, quantity } = request.body;

        if (!variantId || quantity === undefined) {
          return reply.status(400).send({
            success: false,
            error: "variantId and quantity are required",
          });
        }

        if (quantity < 0) {
          return reply.status(400).send({
            success: false,
            error: "quantity must be non-negative",
          });
        }

        // Get WooCommerce config
        const config = ConfigManager.getConfig("WOOCOMMERCE") as WooCommerceConfig;
        if (!config) {
          return reply.status(400).send({
            success: false,
            error: "WooCommerce is not configured",
          });
        }

        const syncService = new WooCommerceSyncService(config);
        await syncService.syncInventoryToWooCommerce(variantId, quantity);

        return reply.send({
          success: true,
          message: `Inventory synced for variant ${variantId}`,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[WooCommerceRoutes] Inventory sync to WooCommerce failed:", message);
        return reply.status(500).send({
          success: false,
          error: message,
        });
      }
    }
  );

  /**
   * POST /woocommerce/sync/inventory/from-woocommerce
   * Sync inventory from WooCommerce to Nexus
   */
  app.post<{ Body: { productId: string } }>(
    "/woocommerce/sync/inventory/from-woocommerce",
    async (request, reply) => {
      try {
        const { productId } = request.body;

        if (!productId) {
          return reply.status(400).send({
            success: false,
            error: "productId is required",
          });
        }

        // Get WooCommerce config
        const config = ConfigManager.getConfig("WOOCOMMERCE") as WooCommerceConfig;
        if (!config) {
          return reply.status(400).send({
            success: false,
            error: "WooCommerce is not configured",
          });
        }

        const syncService = new WooCommerceSyncService(config);
        const result = await syncService.syncInventoryFromWooCommerce(productId);

        return reply.send({
          success: result.success,
          summary: {
            updated: result.updated,
            failed: result.failed,
          },
          errors: result.errors,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[WooCommerceRoutes] Inventory sync from WooCommerce failed:", message);
        return reply.status(500).send({
          success: false,
          error: message,
        });
      }
    }
  );

  /**
   * POST /woocommerce/sync/orders
   * Sync orders from WooCommerce to Nexus
   */
  app.post<{ Body: SyncOrdersBody }>("/woocommerce/sync/orders", async (request, reply) => {
    try {
      const { limit = 100 } = request.body;

      // Get WooCommerce config
      const config = ConfigManager.getConfig("WOOCOMMERCE") as WooCommerceConfig;
      if (!config) {
        return reply.status(400).send({
          success: false,
          error: "WooCommerce is not configured",
        });
      }

      const syncService = new WooCommerceSyncService(config);
      const result = await syncService.syncOrders(limit);

      return reply.send({
        success: result.success,
        summary: {
          created: result.created,
          updated: result.updated,
          totalErrors: result.errors.length,
        },
        errors: result.errors,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[WooCommerceRoutes] Order sync failed:", message);
      return reply.status(500).send({
        success: false,
        error: message,
      });
    }
  });

  /**
   * POST /woocommerce/orders/:orderId/status
   * Update order status in WooCommerce
   */
  app.post<{ Params: { orderId: string }; Body: UpdateOrderStatusBody }>(
    "/woocommerce/orders/:orderId/status",
    async (request, reply) => {
      try {
        const { orderId } = request.params;
        const { status } = request.body;

        if (!status) {
          return reply.status(400).send({
            success: false,
            error: "status is required",
          });
        }

        // Get WooCommerce config
        const config = ConfigManager.getConfig("WOOCOMMERCE") as WooCommerceConfig;
        if (!config) {
          return reply.status(400).send({
            success: false,
            error: "WooCommerce is not configured",
          });
        }

        const syncService = new WooCommerceSyncService(config);
        await syncService.updateOrderStatus(parseInt(orderId), status);

        return reply.send({
          success: true,
          message: `Order ${orderId} status updated to ${status}`,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[WooCommerceRoutes] Order status update failed:", message);
        return reply.status(500).send({
          success: false,
          error: message,
        });
      }
    }
  );

  /**
   * POST /woocommerce/orders/:orderId/fulfillment
   * Add fulfillment note to order
   */
  app.post<{ Params: { orderId: string }; Body: AddFulfillmentNoteBody }>(
    "/woocommerce/orders/:orderId/fulfillment",
    async (request, reply) => {
      try {
        const { orderId } = request.params;
        const { trackingNumber } = request.body;

        // Get WooCommerce config
        const config = ConfigManager.getConfig("WOOCOMMERCE") as WooCommerceConfig;
        if (!config) {
          return reply.status(400).send({
            success: false,
            error: "WooCommerce is not configured",
          });
        }

        const syncService = new WooCommerceSyncService(config);
        await syncService.addFulfillmentNote(parseInt(orderId), trackingNumber);

        return reply.send({
          success: true,
          message: `Fulfillment note added to order ${orderId}`,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[WooCommerceRoutes] Fulfillment note failed:", message);
        return reply.status(500).send({
          success: false,
          error: message,
        });
      }
    }
  );
}
