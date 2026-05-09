/**
 * WooCommerce Webhook Routes
 * Handles incoming webhooks from WooCommerce for products, inventory, and orders
 */

import type { FastifyInstance } from "fastify";
import prisma from "../db.js";
import { WebhookValidator, WebhookProcessor } from "../utils/webhook.js";
import { ConfigManager } from "../utils/config.js";
import type { WooCommerceConfig } from "../types/marketplace.js";

interface WooCommerceWebhookPayload {
  id: number;
  created: string;
  modified: string;
  [key: string]: unknown;
}

/**
 * Process product update webhook
 */
async function handleProductUpdate(payload: WooCommerceWebhookPayload): Promise<void> {
  try {
    const product = payload as any;
    const wooProductId = product.id;

    console.log(`[WooCommerceWebhooks] Processing product update: ${wooProductId}`);

    // Find product in database
    const dbProduct = await (prisma as any).product.findFirst({
      where: { woocommerceProductId: wooProductId },
    });

    if (!dbProduct) {
      console.log(`[WooCommerceWebhooks] Product ${wooProductId} not found in database`);
      return;
    }

    // Update product details
    await (prisma as any).product.update({
      where: { id: dbProduct.id },
      data: {
        name: product.name,
        updatedAt: new Date(),
      },
    });

    console.log(`[WooCommerceWebhooks] Product ${wooProductId} updated successfully`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[WooCommerceWebhooks] Failed to process product update:", message);
    throw error;
  }
}

/**
 * Process product delete webhook
 */
async function handleProductDelete(payload: WooCommerceWebhookPayload): Promise<void> {
  try {
    const product = payload as any;
    const wooProductId = product.id;

    console.log(`[WooCommerceWebhooks] Processing product delete: ${wooProductId}`);

    // Find and mark product as inactive
    const dbProduct = await (prisma as any).product.findFirst({
      where: { woocommerceProductId: wooProductId },
    });

    if (dbProduct) {
      await (prisma as any).product.update({
        where: { id: dbProduct.id },
        data: { status: "INACTIVE" },
      });

      console.log(`[WooCommerceWebhooks] Product ${wooProductId} marked as inactive`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[WooCommerceWebhooks] Failed to process product delete:", message);
    throw error;
  }
}

/**
 * Process inventory update webhook
 */
async function handleInventoryUpdate(payload: WooCommerceWebhookPayload): Promise<void> {
  try {
    const product = payload as any;
    const wooProductId = product.id;
    const stockQuantity = product.stock_quantity || 0;

    console.log(`[WooCommerceWebhooks] Processing inventory update: ${wooProductId}`);

    // Find product by WooCommerce ID
    const dbProduct = await (prisma as any).product.findFirst({
      where: { woocommerceProductId: wooProductId },
      include: { variations: true },
    });

    if (!dbProduct) {
      console.log(`[WooCommerceWebhooks] Product ${wooProductId} not found in database`);
      return;
    }

    // If it's a simple product, update the product stock
    if (dbProduct.variations.length === 0) {
      await (prisma as any).product.update({
        where: { id: dbProduct.id },
        data: { totalStock: stockQuantity },
      });
    } else {
      // For variable products, update the first variant (or distribute stock)
      if (dbProduct.variations.length > 0) {
        await (prisma as any).productVariation.update({
          where: { id: dbProduct.variations[0].id },
          data: { stock: stockQuantity },
        });
      }
    }

    console.log(`[WooCommerceWebhooks] Inventory updated for product ${wooProductId}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[WooCommerceWebhooks] Failed to process inventory update:", message);
    throw error;
  }
}

/**
 * Process order create webhook
 */
async function handleOrderCreate(payload: WooCommerceWebhookPayload): Promise<void> {
  try {
    const order = payload as any;
    const wooOrderId = order.id;

    console.log(`[WooCommerceWebhooks] Processing order create: ${wooOrderId}`);

    // Check if order already exists
    const existingOrder = await (prisma as any).order.findFirst({
      where: { amazonOrderId: `woo_${wooOrderId}` },
    });

    if (existingOrder) {
      console.log(`[WooCommerceWebhooks] Order ${wooOrderId} already exists`);
      return;
    }

    // Get or create WooCommerce channel
    let channel = await (prisma as any).channel.findFirst({
      where: { type: "WOOCOMMERCE" },
    });

    if (!channel) {
      channel = await (prisma as any).channel.create({
        data: {
          type: "WOOCOMMERCE",
          name: "WooCommerce",
          credentials: "encrypted",
        },
      });
    }

    // Create order
    const newOrder = await (prisma as any).order.create({
      data: {
        amazonOrderId: `woo_${wooOrderId}`,
        status: "PENDING",
        totalAmount: parseFloat(order.total) || 0,
        buyerName: `${order.billing?.first_name || ""} ${order.billing?.last_name || ""}`.trim(),
        shippingAddress: order.shipping || order.billing,
        channelId: channel.id,
      },
    });

    // Create order items
    if (order.line_items && Array.isArray(order.line_items)) {
      for (const item of order.line_items) {
        await (prisma as any).orderItem.create({
          data: {
            orderId: newOrder.id,
            sku: item.sku || `item_${item.id}`,
            quantity: item.quantity || 1,
            price: parseFloat(item.total) / (item.quantity || 1),
          },
        });
      }
    }

    console.log(`[WooCommerceWebhooks] Order ${wooOrderId} created successfully`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[WooCommerceWebhooks] Failed to process order create:", message);
    throw error;
  }
}

/**
 * Process order update webhook
 */
async function handleOrderUpdate(payload: WooCommerceWebhookPayload): Promise<void> {
  try {
    const order = payload as any;
    const wooOrderId = order.id;

    console.log(`[WooCommerceWebhooks] Processing order update: ${wooOrderId}`);

    // Find order in database
    const dbOrder = await (prisma as any).order.findFirst({
      where: { amazonOrderId: `woo_${wooOrderId}` },
    });

    if (!dbOrder) {
      console.log(`[WooCommerceWebhooks] Order ${wooOrderId} not found in database`);
      return;
    }

    // Map WooCommerce status to Nexus status
    const statusMap: Record<string, string> = {
      pending: "PENDING",
      processing: "PROCESSING",
      "on-hold": "PENDING",
      completed: "COMPLETED",
      cancelled: "CANCELLED",
      refunded: "REFUNDED",
      failed: "FAILED",
    };

    const status = statusMap[order.status] || "PENDING";

    // Update order
    await (prisma as any).order.update({
      where: { id: dbOrder.id },
      data: {
        status,
        totalAmount: parseFloat(order.total) || dbOrder.totalAmount,
        shippingAddress: order.shipping || order.billing,
      },
    });

    console.log(`[WooCommerceWebhooks] Order ${wooOrderId} updated successfully`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[WooCommerceWebhooks] Failed to process order update:", message);
    throw error;
  }
}

/**
 * Process order delete webhook
 */
async function handleOrderDelete(payload: WooCommerceWebhookPayload): Promise<void> {
  try {
    const order = payload as any;
    const wooOrderId = order.id;

    console.log(`[WooCommerceWebhooks] Processing order delete: ${wooOrderId}`);

    // Find and mark order as cancelled
    const dbOrder = await (prisma as any).order.findFirst({
      where: { amazonOrderId: `woo_${wooOrderId}` },
    });

    if (dbOrder) {
      await (prisma as any).order.update({
        where: { id: dbOrder.id },
        data: { status: "CANCELLED" },
      });

      console.log(`[WooCommerceWebhooks] Order ${wooOrderId} marked as cancelled`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[WooCommerceWebhooks] Failed to process order delete:", message);
    throw error;
  }
}

export async function woocommerceWebhookRoutes(app: FastifyInstance) {
  /**
   * POST /webhooks/woocommerce/products/update
   * Handle product update events
   */
  app.post<{ Body: WooCommerceWebhookPayload }>(
    "/webhooks/woocommerce/products/update",
    async (request, reply) => {
      try {
        const payload = request.body;

        // Validate webhook signature
        const config = ConfigManager.getConfig("WOOCOMMERCE") as WooCommerceConfig;
        if (config?.webhookSecret) {
          const signature = request.headers["x-wc-webhook-signature"] as string;
          const isValid = WebhookValidator.validateWooCommerceSignature(
            JSON.stringify(payload),
            signature,
            config.webhookSecret
          );

          if (!isValid) {
            console.warn("[WooCommerceWebhooks] Invalid webhook signature");
            return reply.status(401).send({ error: "Invalid signature" });
          }
        }

        // Check for idempotency
        const externalId = `woo_product_${payload.id}_update`;
        const existingEvent = await (prisma as any).webhookEvent.findUnique({
          where: { channel_externalId: { channel: "WOOCOMMERCE", externalId } },
        });

        if (existingEvent?.isProcessed) {
          console.log("[WooCommerceWebhooks] Webhook already processed, skipping");
          return reply.send({ success: true });
        }

        // Process webhook
        await handleProductUpdate(payload);

        // Mark as processed
        if (existingEvent) {
          await (prisma as any).webhookEvent.update({
            where: { id: existingEvent.id },
            data: { isProcessed: true, processedAt: new Date() },
          });
        } else {
          await (prisma as any).webhookEvent.create({
            data: {
              channel: "WOOCOMMERCE",
              eventType: "product/update",
              externalId,
              payload,
              isProcessed: true,
              processedAt: new Date(),
            },
          });
        }

        return reply.send({ success: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[WooCommerceWebhooks] Product update webhook failed:", message);
        return reply.status(500).send({ error: message });
      }
    }
  );

  /**
   * POST /webhooks/woocommerce/products/delete
   * Handle product deletion
   */
  app.post<{ Body: WooCommerceWebhookPayload }>(
    "/webhooks/woocommerce/products/delete",
    async (request, reply) => {
      try {
        const payload = request.body;

        // Validate webhook signature
        const config = ConfigManager.getConfig("WOOCOMMERCE") as WooCommerceConfig;
        if (config?.webhookSecret) {
          const signature = request.headers["x-wc-webhook-signature"] as string;
          const isValid = WebhookValidator.validateWooCommerceSignature(
            JSON.stringify(payload),
            signature,
            config.webhookSecret
          );

          if (!isValid) {
            console.warn("[WooCommerceWebhooks] Invalid webhook signature");
            return reply.status(401).send({ error: "Invalid signature" });
          }
        }

        // Check for idempotency
        const externalId = `woo_product_${payload.id}_delete`;
        const existingEvent = await (prisma as any).webhookEvent.findUnique({
          where: { channel_externalId: { channel: "WOOCOMMERCE", externalId } },
        });

        if (existingEvent?.isProcessed) {
          console.log("[WooCommerceWebhooks] Webhook already processed, skipping");
          return reply.send({ success: true });
        }

        // Process webhook
        await handleProductDelete(payload);

        // Mark as processed
        if (existingEvent) {
          await (prisma as any).webhookEvent.update({
            where: { id: existingEvent.id },
            data: { isProcessed: true, processedAt: new Date() },
          });
        } else {
          await (prisma as any).webhookEvent.create({
            data: {
              channel: "WOOCOMMERCE",
              eventType: "product/delete",
              externalId,
              payload,
              isProcessed: true,
              processedAt: new Date(),
            },
          });
        }

        return reply.send({ success: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[WooCommerceWebhooks] Product delete webhook failed:", message);
        return reply.status(500).send({ error: message });
      }
    }
  );

  /**
   * POST /webhooks/woocommerce/inventory/update
   * Handle inventory level changes
   */
  app.post<{ Body: WooCommerceWebhookPayload }>(
    "/webhooks/woocommerce/inventory/update",
    async (request, reply) => {
      try {
        const payload = request.body;

        // Validate webhook signature
        const config = ConfigManager.getConfig("WOOCOMMERCE") as WooCommerceConfig;
        if (config?.webhookSecret) {
          const signature = request.headers["x-wc-webhook-signature"] as string;
          const isValid = WebhookValidator.validateWooCommerceSignature(
            JSON.stringify(payload),
            signature,
            config.webhookSecret
          );

          if (!isValid) {
            console.warn("[WooCommerceWebhooks] Invalid webhook signature");
            return reply.status(401).send({ error: "Invalid signature" });
          }
        }

        // Check for idempotency
        const externalId = `woo_inventory_${payload.id}_update`;
        const existingEvent = await (prisma as any).webhookEvent.findUnique({
          where: { channel_externalId: { channel: "WOOCOMMERCE", externalId } },
        });

        if (existingEvent?.isProcessed) {
          console.log("[WooCommerceWebhooks] Webhook already processed, skipping");
          return reply.send({ success: true });
        }

        // Process webhook
        await handleInventoryUpdate(payload);

        // Mark as processed
        if (existingEvent) {
          await (prisma as any).webhookEvent.update({
            where: { id: existingEvent.id },
            data: { isProcessed: true, processedAt: new Date() },
          });
        } else {
          await (prisma as any).webhookEvent.create({
            data: {
              channel: "WOOCOMMERCE",
              eventType: "inventory/update",
              externalId,
              payload,
              isProcessed: true,
              processedAt: new Date(),
            },
          });
        }

        return reply.send({ success: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[WooCommerceWebhooks] Inventory update webhook failed:", message);
        return reply.status(500).send({ error: message });
      }
    }
  );

  /**
   * POST /webhooks/woocommerce/orders/create
   * Handle new order creation
   */
  app.post<{ Body: WooCommerceWebhookPayload }>(
    "/webhooks/woocommerce/orders/create",
    async (request, reply) => {
      try {
        const payload = request.body;

        // Validate webhook signature
        const config = ConfigManager.getConfig("WOOCOMMERCE") as WooCommerceConfig;
        if (config?.webhookSecret) {
          const signature = request.headers["x-wc-webhook-signature"] as string;
          const isValid = WebhookValidator.validateWooCommerceSignature(
            JSON.stringify(payload),
            signature,
            config.webhookSecret
          );

          if (!isValid) {
            console.warn("[WooCommerceWebhooks] Invalid webhook signature");
            return reply.status(401).send({ error: "Invalid signature" });
          }
        }

        // Check for idempotency
        const externalId = `woo_order_${payload.id}_create`;
        const existingEvent = await (prisma as any).webhookEvent.findUnique({
          where: { channel_externalId: { channel: "WOOCOMMERCE", externalId } },
        });

        if (existingEvent?.isProcessed) {
          console.log("[WooCommerceWebhooks] Webhook already processed, skipping");
          return reply.send({ success: true });
        }

        // Process webhook
        await handleOrderCreate(payload);

        // Mark as processed
        if (existingEvent) {
          await (prisma as any).webhookEvent.update({
            where: { id: existingEvent.id },
            data: { isProcessed: true, processedAt: new Date() },
          });
        } else {
          await (prisma as any).webhookEvent.create({
            data: {
              channel: "WOOCOMMERCE",
              eventType: "order/create",
              externalId,
              payload,
              isProcessed: true,
              processedAt: new Date(),
            },
          });
        }

        return reply.send({ success: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[WooCommerceWebhooks] Order create webhook failed:", message);
        return reply.status(500).send({ error: message });
      }
    }
  );

  /**
   * POST /webhooks/woocommerce/orders/update
   * Handle order status changes
   */
  app.post<{ Body: WooCommerceWebhookPayload }>(
    "/webhooks/woocommerce/orders/update",
    async (request, reply) => {
      try {
        const payload = request.body;

        // Validate webhook signature
        const config = ConfigManager.getConfig("WOOCOMMERCE") as WooCommerceConfig;
        if (config?.webhookSecret) {
          const signature = request.headers["x-wc-webhook-signature"] as string;
          const isValid = WebhookValidator.validateWooCommerceSignature(
            JSON.stringify(payload),
            signature,
            config.webhookSecret
          );

          if (!isValid) {
            console.warn("[WooCommerceWebhooks] Invalid webhook signature");
            return reply.status(401).send({ error: "Invalid signature" });
          }
        }

        // Check for idempotency
        const externalId = `woo_order_${payload.id}_update`;
        const existingEvent = await (prisma as any).webhookEvent.findUnique({
          where: { channel_externalId: { channel: "WOOCOMMERCE", externalId } },
        });

        if (existingEvent?.isProcessed) {
          console.log("[WooCommerceWebhooks] Webhook already processed, skipping");
          return reply.send({ success: true });
        }

        // Process webhook
        await handleOrderUpdate(payload);

        // Mark as processed
        if (existingEvent) {
          await (prisma as any).webhookEvent.update({
            where: { id: existingEvent.id },
            data: { isProcessed: true, processedAt: new Date() },
          });
        } else {
          await (prisma as any).webhookEvent.create({
            data: {
              channel: "WOOCOMMERCE",
              eventType: "order/update",
              externalId,
              payload,
              isProcessed: true,
              processedAt: new Date(),
            },
          });
        }

        return reply.send({ success: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[WooCommerceWebhooks] Order update webhook failed:", message);
        return reply.status(500).send({ error: message });
      }
    }
  );

  /**
   * POST /webhooks/woocommerce/orders/delete
   * Handle order deletion
   */
  app.post<{ Body: WooCommerceWebhookPayload }>(
    "/webhooks/woocommerce/orders/delete",
    async (request, reply) => {
      try {
        const payload = request.body;

        // Validate webhook signature
        const config = ConfigManager.getConfig("WOOCOMMERCE") as WooCommerceConfig;
        if (config?.webhookSecret) {
          const signature = request.headers["x-wc-webhook-signature"] as string;
          const isValid = WebhookValidator.validateWooCommerceSignature(
            JSON.stringify(payload),
            signature,
            config.webhookSecret
          );

          if (!isValid) {
            console.warn("[WooCommerceWebhooks] Invalid webhook signature");
            return reply.status(401).send({ error: "Invalid signature" });
          }
        }

        // Check for idempotency
        const externalId = `woo_order_${payload.id}_delete`;
        const existingEvent = await (prisma as any).webhookEvent.findUnique({
          where: { channel_externalId: { channel: "WOOCOMMERCE", externalId } },
        });

        if (existingEvent?.isProcessed) {
          console.log("[WooCommerceWebhooks] Webhook already processed, skipping");
          return reply.send({ success: true });
        }

        // Process webhook
        await handleOrderDelete(payload);

        // Mark as processed
        if (existingEvent) {
          await (prisma as any).webhookEvent.update({
            where: { id: existingEvent.id },
            data: { isProcessed: true, processedAt: new Date() },
          });
        } else {
          await (prisma as any).webhookEvent.create({
            data: {
              channel: "WOOCOMMERCE",
              eventType: "order/delete",
              externalId,
              payload,
              isProcessed: true,
              processedAt: new Date(),
            },
          });
        }

        return reply.send({ success: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[WooCommerceWebhooks] Order delete webhook failed:", message);
        return reply.status(500).send({ error: message });
      }
    }
  );
}

/**
 * L.17.0 — replay dispatcher (mirrors dispatchShopifyWebhook).
 */
export async function dispatchWooWebhook(
  eventType: string,
  payload: unknown,
): Promise<void> {
  const p = payload as WooCommerceWebhookPayload
  switch (eventType) {
    case 'product/update':
      return handleProductUpdate(p)
    case 'product/delete':
      return handleProductDelete(p)
    case 'inventory/update':
      return handleInventoryUpdate(p)
    case 'order/create':
      return handleOrderCreate(p)
    case 'order/update':
      return handleOrderUpdate(p)
    case 'order/delete':
      return handleOrderDelete(p)
    default:
      throw new Error(`Unknown WooCommerce eventType: ${eventType}`)
  }
}
