/**
 * Shopify Webhook Routes
 * Handles incoming webhooks from Shopify for products, inventory, and orders
 */

import type { FastifyInstance } from "fastify";
import prisma from "../db.js";
import { WebhookValidator, WebhookProcessor } from "../utils/webhook.js";
import { ConfigManager } from "../utils/config.js";
import type { ShopifyConfig } from "../types/marketplace.js";

interface ShopifyWebhookPayload {
  id: string;
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
}

/**
 * Process product update webhook
 */
async function handleProductUpdate(payload: ShopifyWebhookPayload): Promise<void> {
  try {
    const product = payload as any;
    const shopifyProductId = String(product.id);

    console.log(`[ShopifyWebhooks] Processing product update: ${shopifyProductId}`);

    // Find product in database
    const dbProduct = await (prisma as any).product.findFirst({
      where: { shopifyProductId },
    });

    if (!dbProduct) {
      console.log(`[ShopifyWebhooks] Product ${shopifyProductId} not found in database`);
      return;
    }

    // Update product details
    await (prisma as any).product.update({
      where: { id: dbProduct.id },
      data: {
        name: product.title,
        updatedAt: new Date(),
      },
    });

    console.log(`[ShopifyWebhooks] Product ${shopifyProductId} updated successfully`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[ShopifyWebhooks] Failed to process product update:", message);
    throw error;
  }
}

/**
 * Process product delete webhook
 */
async function handleProductDelete(payload: ShopifyWebhookPayload): Promise<void> {
  try {
    const product = payload as any;
    const shopifyProductId = String(product.id);

    console.log(`[ShopifyWebhooks] Processing product delete: ${shopifyProductId}`);

    // Find and mark product as inactive
    const dbProduct = await (prisma as any).product.findFirst({
      where: { shopifyProductId },
    });

    if (dbProduct) {
      await (prisma as any).product.update({
        where: { id: dbProduct.id },
        data: { status: "INACTIVE" },
      });

      console.log(`[ShopifyWebhooks] Product ${shopifyProductId} marked as inactive`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[ShopifyWebhooks] Failed to process product delete:", message);
    throw error;
  }
}

/**
 * Process inventory update webhook
 */
async function handleInventoryUpdate(payload: ShopifyWebhookPayload): Promise<void> {
  try {
    const inventory = payload as any;
    const inventoryItemId = String(inventory.inventory_item_id);

    console.log(`[ShopifyWebhooks] Processing inventory update: ${inventoryItemId}`);

    // Find variant by inventory item ID
    const variant = await (prisma as any).productVariation.findFirst({
      where: {
        channelListings: {
          some: {
            channelId: "SHOPIFY",
            channelVariantId: {
              contains: inventoryItemId,
            },
          },
        },
      },
    });

    if (variant) {
      // Update variant stock
      await (prisma as any).productVariation.update({
        where: { id: variant.id },
        data: { stock: inventory.available_quantity || 0 },
      });

      // Update channel listing
      const listing = await (prisma as any).variantChannelListing.findFirst({
        where: {
          variantId: variant.id,
          channelId: "SHOPIFY",
        },
      });

      if (listing) {
        await (prisma as any).variantChannelListing.update({
          where: { id: listing.id },
          data: {
            channelQuantity: inventory.available_quantity || 0,
            lastSyncedAt: new Date(),
          },
        });
      }

      console.log(`[ShopifyWebhooks] Inventory updated for variant ${variant.id}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[ShopifyWebhooks] Failed to process inventory update:", message);
    throw error;
  }
}

/**
 * Process order create webhook
 */
async function handleOrderCreate(payload: ShopifyWebhookPayload): Promise<void> {
  try {
    const order = payload as any;
    const shopifyOrderId = String(order.id);

    console.log(`[ShopifyWebhooks] Processing order create: ${shopifyOrderId}`);

    // Create order in database
    const dbOrder = await (prisma as any).order.create({
      data: {
        amazonOrderId: shopifyOrderId,
        status: order.fulfillment_status || "PENDING",
        totalAmount: parseFloat(order.total_price) || 0,
        buyerName: order.email,
        shippingAddress: order.shipping_address,
        channelId: "SHOPIFY",
      },
    });

    // Create order items
    if (order.line_items && Array.isArray(order.line_items)) {
      for (const item of order.line_items) {
        await (prisma as any).orderItem.create({
          data: {
            orderId: dbOrder.id,
            sku: item.sku || item.title,
            quantity: item.quantity,
            price: parseFloat(item.price) || 0,
          },
        });
      }
    }

    console.log(`[ShopifyWebhooks] Order ${shopifyOrderId} created successfully`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[ShopifyWebhooks] Failed to process order create:", message);
    throw error;
  }
}

/**
 * Process order update webhook
 */
async function handleOrderUpdate(payload: ShopifyWebhookPayload): Promise<void> {
  try {
    const order = payload as any;
    const shopifyOrderId = String(order.id);

    console.log(`[ShopifyWebhooks] Processing order update: ${shopifyOrderId}`);

    // Find and update order
    const dbOrder = await (prisma as any).order.findUnique({
      where: { amazonOrderId: shopifyOrderId },
    });

    if (dbOrder) {
      await (prisma as any).order.update({
        where: { id: dbOrder.id },
        data: {
          status: order.fulfillment_status || "PENDING",
          totalAmount: parseFloat(order.total_price) || 0,
          shippingAddress: order.shipping_address,
          shippedAt: order.shipped_at ? new Date(order.shipped_at) : undefined,
        },
      });

      console.log(`[ShopifyWebhooks] Order ${shopifyOrderId} updated successfully`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[ShopifyWebhooks] Failed to process order update:", message);
    throw error;
  }
}

/**
 * Process fulfillment create webhook
 */
async function handleFulfillmentCreate(payload: ShopifyWebhookPayload): Promise<void> {
  try {
    const fulfillment = payload as any;
    const orderId = String(fulfillment.order_id);

    console.log(`[ShopifyWebhooks] Processing fulfillment create for order: ${orderId}`);

    // Find order and update status
    const dbOrder = await (prisma as any).order.findUnique({
      where: { amazonOrderId: orderId },
    });

    if (dbOrder) {
      await (prisma as any).order.update({
        where: { id: dbOrder.id },
        data: {
          status: "SHIPPED",
          trackingNumber: fulfillment.tracking_info?.number,
          shippedAt: new Date(),
        },
      });

      console.log(`[ShopifyWebhooks] Order ${orderId} marked as shipped`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[ShopifyWebhooks] Failed to process fulfillment create:", message);
    throw error;
  }
}

export async function shopifyWebhookRoutes(app: FastifyInstance) {
  const webhookValidator = new WebhookValidator();
  const webhookProcessor = new WebhookProcessor();

  /**
   * POST /webhooks/shopify/products/update
   * Handle product update webhooks
   */
  app.post("/webhooks/shopify/products/update", async (request, reply) => {
    try {
      const signature = request.headers["x-shopify-hmac-sha256"] as string;
      const body = JSON.stringify(request.body);

      // Validate webhook signature
      const config = ConfigManager.getConfig("SHOPIFY") as ShopifyConfig;
      if (!config) {
        return reply.status(400).send({
          success: false,
          error: "Shopify is not configured",
        });
      }

      const validation = WebhookValidator.validateShopifySignature(body, signature, config.webhookSecret);
      if (!validation.isValid) {
        console.warn("[ShopifyWebhooks] Invalid webhook signature");
        return reply.status(401).send({
          success: false,
          error: validation.error,
        });
      }

      const payload = request.body as ShopifyWebhookPayload;

      // Check idempotency
      const eventType = "product/update";
      const externalId = String(payload.id);

      const isProcessed = await WebhookProcessor.isWebhookProcessed("SHOPIFY", externalId, prisma);
      if (isProcessed) {
        console.log(`[ShopifyWebhooks] Webhook already processed: ${externalId}`);
        return reply.send({ success: true, message: "Already processed" });
      }

      // Process webhook
      await handleProductUpdate(payload);

      // Mark as processed
      await WebhookProcessor.markWebhookProcessed("SHOPIFY", externalId, prisma);

      return reply.send({ success: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[ShopifyWebhooks] Product update webhook failed:", message);
      return reply.status(500).send({
        success: false,
        error: message,
      });
    }
  });

  /**
   * POST /webhooks/shopify/products/delete
   * Handle product delete webhooks
   */
  app.post("/webhooks/shopify/products/delete", async (request, reply) => {
    try {
      const signature = request.headers["x-shopify-hmac-sha256"] as string;
      const body = JSON.stringify(request.body);

      // Validate webhook signature
      const config = ConfigManager.getConfig("SHOPIFY") as ShopifyConfig;
      if (!config) {
        return reply.status(400).send({
          success: false,
          error: "Shopify is not configured",
        });
      }

      const validation = WebhookValidator.validateShopifySignature(body, signature, config.webhookSecret);
      if (!validation.isValid) {
        console.warn("[ShopifyWebhooks] Invalid webhook signature");
        return reply.status(401).send({
          success: false,
          error: validation.error,
        });
      }

      const payload = request.body as ShopifyWebhookPayload;

      // Check idempotency
      const eventType = "product/delete";
      const externalId = String(payload.id);

      const isProcessed = await WebhookProcessor.isWebhookProcessed("SHOPIFY", externalId, prisma);
      if (isProcessed) {
        console.log(`[ShopifyWebhooks] Webhook already processed: ${externalId}`);
        return reply.send({ success: true, message: "Already processed" });
      }

      // Process webhook
      await handleProductDelete(payload);

      // Mark as processed
      await WebhookProcessor.markWebhookProcessed("SHOPIFY", externalId, prisma);

      return reply.send({ success: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[ShopifyWebhooks] Product delete webhook failed:", message);
      return reply.status(500).send({
        success: false,
        error: message,
      });
    }
  });

  /**
   * POST /webhooks/shopify/inventory/update
   * Handle inventory update webhooks
   */
  app.post("/webhooks/shopify/inventory/update", async (request, reply) => {
    try {
      const signature = request.headers["x-shopify-hmac-sha256"] as string;
      const body = JSON.stringify(request.body);

      // Validate webhook signature
      const config = ConfigManager.getConfig("SHOPIFY") as ShopifyConfig;
      if (!config) {
        return reply.status(400).send({
          success: false,
          error: "Shopify is not configured",
        });
      }

      const validation = WebhookValidator.validateShopifySignature(body, signature, config.webhookSecret);
      if (!validation.isValid) {
        console.warn("[ShopifyWebhooks] Invalid webhook signature");
        return reply.status(401).send({
          success: false,
          error: validation.error,
        });
      }

      const payload = request.body as ShopifyWebhookPayload;

      // Check idempotency
      const eventType = "inventory/update";
      const externalId = String(payload.id);

      const isProcessed = await WebhookProcessor.isWebhookProcessed("SHOPIFY", externalId, prisma);
      if (isProcessed) {
        console.log(`[ShopifyWebhooks] Webhook already processed: ${externalId}`);
        return reply.send({ success: true, message: "Already processed" });
      }

      // Process webhook
      await handleInventoryUpdate(payload);

      // Mark as processed
      await WebhookProcessor.markWebhookProcessed("SHOPIFY", externalId, prisma);

      return reply.send({ success: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[ShopifyWebhooks] Inventory update webhook failed:", message);
      return reply.status(500).send({
        success: false,
        error: message,
      });
    }
  });

  /**
   * POST /webhooks/shopify/orders/create
   * Handle order create webhooks
   */
  app.post("/webhooks/shopify/orders/create", async (request, reply) => {
    try {
      const signature = request.headers["x-shopify-hmac-sha256"] as string;
      const body = JSON.stringify(request.body);

      // Validate webhook signature
      const config = ConfigManager.getConfig("SHOPIFY") as ShopifyConfig;
      if (!config) {
        return reply.status(400).send({
          success: false,
          error: "Shopify is not configured",
        });
      }

      const validation = WebhookValidator.validateShopifySignature(body, signature, config.webhookSecret);
      if (!validation.isValid) {
        console.warn("[ShopifyWebhooks] Invalid webhook signature");
        return reply.status(401).send({
          success: false,
          error: validation.error,
        });
      }

      const payload = request.body as ShopifyWebhookPayload;

      // Check idempotency
      const eventType = "order/create";
      const externalId = String(payload.id);

      const isProcessed = await WebhookProcessor.isWebhookProcessed("SHOPIFY", externalId, prisma);
      if (isProcessed) {
        console.log(`[ShopifyWebhooks] Webhook already processed: ${externalId}`);
        return reply.send({ success: true, message: "Already processed" });
      }

      // Process webhook
      await handleOrderCreate(payload);

      // Mark as processed
      await WebhookProcessor.markWebhookProcessed("SHOPIFY", externalId, prisma);

      return reply.send({ success: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[ShopifyWebhooks] Order create webhook failed:", message);
      return reply.status(500).send({
        success: false,
        error: message,
      });
    }
  });

  /**
   * POST /webhooks/shopify/orders/update
   * Handle order update webhooks
   */
  app.post("/webhooks/shopify/orders/update", async (request, reply) => {
    try {
      const signature = request.headers["x-shopify-hmac-sha256"] as string;
      const body = JSON.stringify(request.body);

      // Validate webhook signature
      const config = ConfigManager.getConfig("SHOPIFY") as ShopifyConfig;
      if (!config) {
        return reply.status(400).send({
          success: false,
          error: "Shopify is not configured",
        });
      }

      const validation = WebhookValidator.validateShopifySignature(body, signature, config.webhookSecret);
      if (!validation.isValid) {
        console.warn("[ShopifyWebhooks] Invalid webhook signature");
        return reply.status(401).send({
          success: false,
          error: validation.error,
        });
      }

      const payload = request.body as ShopifyWebhookPayload;

      // Check idempotency
      const eventType = "order/update";
      const externalId = String(payload.id);

      const isProcessed = await WebhookProcessor.isWebhookProcessed("SHOPIFY", externalId, prisma);
      if (isProcessed) {
        console.log(`[ShopifyWebhooks] Webhook already processed: ${externalId}`);
        return reply.send({ success: true, message: "Already processed" });
      }

      // Process webhook
      await handleOrderUpdate(payload);

      // Mark as processed
      await WebhookProcessor.markWebhookProcessed("SHOPIFY", externalId, prisma);

      return reply.send({ success: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[ShopifyWebhooks] Order update webhook failed:", message);
      return reply.status(500).send({
        success: false,
        error: message,
      });
    }
  });

  /**
   * POST /webhooks/shopify/fulfillments/create
   * Handle fulfillment create webhooks
   */
  app.post("/webhooks/shopify/fulfillments/create", async (request, reply) => {
    try {
      const signature = request.headers["x-shopify-hmac-sha256"] as string;
      const body = JSON.stringify(request.body);

      // Validate webhook signature
      const config = ConfigManager.getConfig("SHOPIFY") as ShopifyConfig;
      if (!config) {
        return reply.status(400).send({
          success: false,
          error: "Shopify is not configured",
        });
      }

      const validation = WebhookValidator.validateShopifySignature(body, signature, config.webhookSecret);
      if (!validation.isValid) {
        console.warn("[ShopifyWebhooks] Invalid webhook signature");
        return reply.status(401).send({
          success: false,
          error: validation.error,
        });
      }

      const payload = request.body as ShopifyWebhookPayload;

      // Check idempotency
      const eventType = "fulfillment/create";
      const externalId = String(payload.id);

      const isProcessed = await WebhookProcessor.isWebhookProcessed("SHOPIFY", externalId, prisma);
      if (isProcessed) {
        console.log(`[ShopifyWebhooks] Webhook already processed: ${externalId}`);
        return reply.send({ success: true, message: "Already processed" });
      }

      // Process webhook
      await handleFulfillmentCreate(payload);

      // Mark as processed
      await WebhookProcessor.markWebhookProcessed("SHOPIFY", externalId, prisma);

      return reply.send({ success: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[ShopifyWebhooks] Fulfillment create webhook failed:", message);
      return reply.status(500).send({
        success: false,
        error: message,
      });
    }
  });
}
