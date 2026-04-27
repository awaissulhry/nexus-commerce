/**
 * Shopify API Routes
 * Handles product sync, inventory sync, and order management
 */

import type { FastifyInstance } from "fastify";
import prisma from "../db.js";
import { ShopifySyncService } from "../services/sync/shopify-sync.service.js";
import { ConfigManager } from "../utils/config.js";
import type { ShopifyConfig } from "../types/marketplace.js";

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

interface CreateFulfillmentBody {
  orderId: string;
  lineItemIds: string[];
  trackingInfo?: {
    number: string;
    company: string;
    url?: string;
  };
}

export async function shopifyRoutes(app: FastifyInstance) {
  /**
   * POST /shopify/sync/products
   * Sync all products from Shopify to Nexus
   */
  app.post<{ Body: SyncProductsBody }>("/shopify/sync/products", async (request, reply) => {
    try {
      const { limit = 100 } = request.body;

      // Get Shopify config
      const config = ConfigManager.getConfig("SHOPIFY") as ShopifyConfig;
      if (!config) {
        return reply.status(400).send({
          success: false,
          error: "Shopify is not configured",
        });
      }

      const syncService = new ShopifySyncService(config);
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
      console.error("[ShopifyRoutes] Product sync failed:", message);
      return reply.status(500).send({
        success: false,
        error: message,
      });
    }
  });

  /**
   * POST /shopify/sync/inventory/to-shopify
   * Sync inventory from Nexus to Shopify
   */
  app.post<{ Body: SyncInventoryBody }>(
    "/shopify/sync/inventory/to-shopify",
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

        // Get Shopify config
        const config = ConfigManager.getConfig("SHOPIFY") as ShopifyConfig;
        if (!config) {
          return reply.status(400).send({
            success: false,
            error: "Shopify is not configured",
          });
        }

        const syncService = new ShopifySyncService(config);
        await syncService.syncInventoryToShopify(variantId, quantity);

        return reply.send({
          success: true,
          message: "Inventory synced to Shopify",
          variantId,
          quantity,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[ShopifyRoutes] Inventory sync to Shopify failed:", message);
        return reply.status(500).send({
          success: false,
          error: message,
        });
      }
    }
  );

  /**
   * POST /shopify/sync/inventory/from-shopify
   * Sync inventory from Shopify to Nexus
   */
  app.post<{ Body: { productId: string } }>(
    "/shopify/sync/inventory/from-shopify",
    async (request, reply) => {
      try {
        const { productId } = request.body;

        if (!productId) {
          return reply.status(400).send({
            success: false,
            error: "productId is required",
          });
        }

        // Get Shopify config
        const config = ConfigManager.getConfig("SHOPIFY") as ShopifyConfig;
        if (!config) {
          return reply.status(400).send({
            success: false,
            error: "Shopify is not configured",
          });
        }

        const syncService = new ShopifySyncService(config);
        const result = await syncService.syncInventoryFromShopify(productId);

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
        console.error("[ShopifyRoutes] Inventory sync from Shopify failed:", message);
        return reply.status(500).send({
          success: false,
          error: message,
        });
      }
    }
  );

  /**
   * POST /shopify/sync/orders
   * Sync orders from Shopify to Nexus
   */
  app.post<{ Body: SyncOrdersBody }>("/shopify/sync/orders", async (request, reply) => {
    try {
      const { limit = 50 } = request.body;

      // Get Shopify config
      const config = ConfigManager.getConfig("SHOPIFY") as ShopifyConfig;
      if (!config) {
        return reply.status(400).send({
          success: false,
          error: "Shopify is not configured",
        });
      }

      const syncService = new ShopifySyncService(config);
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
      console.error("[ShopifyRoutes] Order sync failed:", message);
      return reply.status(500).send({
        success: false,
        error: message,
      });
    }
  });

  /**
   * POST /shopify/fulfillments/create
   * Create a fulfillment for an order
   */
  app.post<{ Body: CreateFulfillmentBody }>(
    "/shopify/fulfillments/create",
    async (request, reply) => {
      try {
        const { orderId, lineItemIds, trackingInfo } = request.body;

        if (!orderId || !Array.isArray(lineItemIds) || lineItemIds.length === 0) {
          return reply.status(400).send({
            success: false,
            error: "orderId and lineItemIds array are required",
          });
        }

        // Get Shopify config
        const config = ConfigManager.getConfig("SHOPIFY") as ShopifyConfig;
        if (!config) {
          return reply.status(400).send({
            success: false,
            error: "Shopify is not configured",
          });
        }

        const syncService = new ShopifySyncService(config);
        const result = await syncService.createFulfillment(orderId, lineItemIds, trackingInfo);

        return reply.send({
          success: true,
          fulfillmentId: result.fulfillmentId,
          status: result.status,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[ShopifyRoutes] Fulfillment creation failed:", message);
        return reply.status(500).send({
          success: false,
          error: message,
        });
      }
    }
  );

  /**
   * GET /shopify/products/:productId
   * Get a product from Shopify
   */
  app.get<{ Params: { productId: string } }>(
    "/shopify/products/:productId",
    async (request, reply) => {
      try {
        const { productId } = request.params;

        // Get Shopify config
        const config = ConfigManager.getConfig("SHOPIFY") as ShopifyConfig;
        if (!config) {
          return reply.status(400).send({
            success: false,
            error: "Shopify is not configured",
          });
        }

        const { ShopifyEnhancedService } = await import(
          "../services/marketplaces/shopify-enhanced.service.js"
        );
        const shopifyService = new ShopifyEnhancedService(config);
        const product = await shopifyService.getProduct(productId);

        return reply.send({
          success: true,
          product,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[ShopifyRoutes] Get product failed:", message);
        return reply.status(500).send({
          success: false,
          error: message,
        });
      }
    }
  );

  /**
   * GET /shopify/orders/:orderId
   * Get an order from Shopify
   */
  app.get<{ Params: { orderId: string } }>(
    "/shopify/orders/:orderId",
    async (request, reply) => {
      try {
        const { orderId } = request.params;

        // Get Shopify config
        const config = ConfigManager.getConfig("SHOPIFY") as ShopifyConfig;
        if (!config) {
          return reply.status(400).send({
            success: false,
            error: "Shopify is not configured",
          });
        }

        const { ShopifyEnhancedService } = await import(
          "../services/marketplaces/shopify-enhanced.service.js"
        );
        const shopifyService = new ShopifyEnhancedService(config);
        const order = await shopifyService.getOrder(orderId);

        return reply.send({
          success: true,
          order,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[ShopifyRoutes] Get order failed:", message);
        return reply.status(500).send({
          success: false,
          error: message,
        });
      }
    }
  );
}
