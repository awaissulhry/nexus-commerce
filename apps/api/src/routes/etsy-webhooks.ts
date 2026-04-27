/**
 * Etsy Webhook Routes
 * Handles incoming webhooks from Etsy for listings, inventory, and orders
 */

import type { FastifyInstance } from "fastify";
import prisma from "../db.js";
import { WebhookValidator, WebhookProcessor } from "../utils/webhook.js";
import { ConfigManager } from "../utils/config.js";
import type { EtsyConfig } from "../types/marketplace.js";

interface EtsyWebhookPayload {
  event_type: string;
  timestamp: number;
  data: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Process listing update webhook
 */
async function handleListingUpdate(payload: EtsyWebhookPayload): Promise<void> {
  try {
    const data = payload.data as any;
    const listingId = data.listing_id;

    console.log(`[EtsyWebhooks] Processing listing update: ${listingId}`);

    // Find product in database
    const dbProduct = await (prisma as any).product.findFirst({
      where: { etsyListingId: listingId },
    });

    if (!dbProduct) {
      console.log(`[EtsyWebhooks] Listing ${listingId} not found in database`);
      return;
    }

    // Update product details
    await (prisma as any).product.update({
      where: { id: dbProduct.id },
      data: {
        name: data.title || dbProduct.name,
        basePrice: data.price ? parseFloat(data.price) : dbProduct.basePrice,
        updatedAt: new Date(),
      },
    });

    console.log(`[EtsyWebhooks] Listing ${listingId} updated successfully`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[EtsyWebhooks] Failed to process listing update:", message);
    throw error;
  }
}

/**
 * Process listing delete webhook
 */
async function handleListingDelete(payload: EtsyWebhookPayload): Promise<void> {
  try {
    const data = payload.data as any;
    const listingId = data.listing_id;

    console.log(`[EtsyWebhooks] Processing listing delete: ${listingId}`);

    // Find and mark product as inactive
    const dbProduct = await (prisma as any).product.findFirst({
      where: { etsyListingId: listingId },
    });

    if (dbProduct) {
      await (prisma as any).product.update({
        where: { id: dbProduct.id },
        data: { status: "INACTIVE" },
      });

      console.log(`[EtsyWebhooks] Listing ${listingId} marked as inactive`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[EtsyWebhooks] Failed to process listing delete:", message);
    throw error;
  }
}

/**
 * Process inventory update webhook
 */
async function handleInventoryUpdate(payload: EtsyWebhookPayload): Promise<void> {
  try {
    const data = payload.data as any;
    const listingId = data.listing_id;
    const quantity = data.quantity || 0;

    console.log(`[EtsyWebhooks] Processing inventory update: ${listingId}`);

    // Find product by Etsy listing ID
    const dbProduct = await (prisma as any).product.findFirst({
      where: { etsyListingId: listingId },
      include: { variations: true },
    });

    if (!dbProduct) {
      console.log(`[EtsyWebhooks] Listing ${listingId} not found in database`);
      return;
    }

    // If it has variations, update the specific variant
    if (data.variation_id && dbProduct.variations.length > 0) {
      const variant = dbProduct.variations.find(
        (v) => v.etsyListingId === data.variation_id
      );

      if (variant) {
        await (prisma as any).productVariation.update({
          where: { id: variant.id },
          data: { stock: quantity },
        });

        // Update channel listing
        const channelListing = await (prisma as any).variantChannelListing.findFirst({
          where: { variantId: variant.id },
        });

        if (channelListing) {
          await (prisma as any).variantChannelListing.update({
            where: { id: channelListing.id },
            data: { channelQuantity: quantity },
          });
        }
      }
    } else {
      // Update product stock directly
      await (prisma as any).product.update({
        where: { id: dbProduct.id },
        data: { totalStock: quantity },
      });
    }

    console.log(`[EtsyWebhooks] Inventory updated: ${listingId} = ${quantity}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[EtsyWebhooks] Failed to process inventory update:", message);
    throw error;
  }
}

/**
 * Process order create webhook
 */
async function handleOrderCreate(payload: EtsyWebhookPayload): Promise<void> {
  try {
    const data = payload.data as any;
    const receiptId = data.receipt_id;

    console.log(`[EtsyWebhooks] Processing order create: ${receiptId}`);

    // Check if order already exists
    const existingOrder = await (prisma as any).order.findFirst({
      where: { amazonOrderId: `ETSY-${receiptId}` },
    });

    if (existingOrder) {
      console.log(`[EtsyWebhooks] Order ${receiptId} already exists`);
      return;
    }

    // Get or create Etsy channel
    let channel = await (prisma as any).channel.findFirst({
      where: { type: "ETSY" },
    });

    if (!channel) {
      channel = await (prisma as any).channel.create({
        data: {
          type: "ETSY",
          name: "Etsy",
          credentials: "{}",
        },
      });
    }

    // Create order
    const order = await (prisma as any).order.create({
      data: {
        amazonOrderId: `ETSY-${receiptId}`,
        status: "PAID",
        totalAmount: data.total_price ? parseFloat(data.total_price) : 0,
        channelId: channel.id,
        buyerName: data.buyer_name || "Unknown",
        shippingAddress: {
          firstName: data.first_name || "",
          lastName: data.last_name || "",
          address1: data.first_line || "",
          address2: data.second_line || "",
          city: data.city || "",
          state: data.state || "",
          zip: data.zip || "",
          country: data.country_name || "",
        },
      },
    });

    // Create order items from transactions
    if (data.transactions && Array.isArray(data.transactions)) {
      for (const txn of data.transactions) {
        await (prisma as any).orderItem.create({
          data: {
            orderId: order.id,
            sku: txn.sku || "",
            quantity: txn.quantity || 1,
            price: txn.price ? parseFloat(txn.price) : 0,
          },
        });
      }
    }

    console.log(`[EtsyWebhooks] Order ${receiptId} created successfully`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[EtsyWebhooks] Failed to process order create:", message);
    throw error;
  }
}

/**
 * Process order update webhook
 */
async function handleOrderUpdate(payload: EtsyWebhookPayload): Promise<void> {
  try {
    const data = payload.data as any;
    const receiptId = data.receipt_id;

    console.log(`[EtsyWebhooks] Processing order update: ${receiptId}`);

    // Find order in database
    const dbOrder = await (prisma as any).order.findFirst({
      where: { amazonOrderId: `ETSY-${receiptId}` },
    });

    if (!dbOrder) {
      console.log(`[EtsyWebhooks] Order ${receiptId} not found in database`);
      return;
    }

    // Map Etsy status to standard status
    let status = "PAID";
    if (data.was_refunded) status = "REFUNDED";
    else if (data.was_cancelled) status = "CANCELLED";
    else if (data.was_delivered) status = "DELIVERED";
    else if (data.was_shipped) status = "SHIPPED";

    // Update order
    await (prisma as any).order.update({
      where: { id: dbOrder.id },
      data: {
        status,
        trackingNumber: data.tracking_code || dbOrder.trackingNumber,
        shippedAt: data.was_shipped ? new Date() : dbOrder.shippedAt,
        updatedAt: new Date(),
      },
    });

    console.log(`[EtsyWebhooks] Order ${receiptId} updated successfully`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[EtsyWebhooks] Failed to process order update:", message);
    throw error;
  }
}

/**
 * Process order delete webhook
 */
async function handleOrderDelete(payload: EtsyWebhookPayload): Promise<void> {
  try {
    const data = payload.data as any;
    const receiptId = data.receipt_id;

    console.log(`[EtsyWebhooks] Processing order delete: ${receiptId}`);

    // Find and mark order as cancelled
    const dbOrder = await (prisma as any).order.findFirst({
      where: { amazonOrderId: `ETSY-${receiptId}` },
    });

    if (dbOrder) {
      await (prisma as any).order.update({
        where: { id: dbOrder.id },
        data: { status: "CANCELLED" },
      });

      console.log(`[EtsyWebhooks] Order ${receiptId} marked as cancelled`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[EtsyWebhooks] Failed to process order delete:", message);
    throw error;
  }
}

export async function estyWebhookRoutes(app: FastifyInstance) {
  /**
   * POST /webhooks/etsy/listings/update
   * Handle listing update events
   */
  app.post<{ Body: EtsyWebhookPayload }>(
    "/webhooks/etsy/listings/update",
    async (request, reply) => {
      try {
        const payload = request.body;

        // Validate webhook
        const config = ConfigManager.getConfig("ETSY") as EtsyConfig;
        if (!config) {
          console.warn("[EtsyWebhooks] Etsy is not configured");
          return reply.status(400).send({ success: false, error: "Not configured" });
        }

        // Check for idempotency
        const externalId = `${payload.event_type}-${payload.timestamp}-${(payload.data as any).listing_id}`;
        const existingEvent = await (prisma as any).webhookEvent.findFirst({
          where: { channel: "ETSY", externalId },
        });

        if (existingEvent && existingEvent.isProcessed) {
          console.log("[EtsyWebhooks] Webhook already processed (idempotency)");
          return reply.send({ success: true, message: "Already processed" });
        }

        // Process webhook
        await handleListingUpdate(payload);

        // Mark as processed
        if (existingEvent) {
          await (prisma as any).webhookEvent.update({
            where: { id: existingEvent.id },
            data: { isProcessed: true, processedAt: new Date() },
          });
        } else {
          await (prisma as any).webhookEvent.create({
            data: {
              channel: "ETSY",
              eventType: payload.event_type,
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
        console.error("[EtsyWebhooks] Webhook processing failed:", message);
        return reply.status(500).send({ success: false, error: message });
      }
    }
  );

  /**
   * POST /webhooks/etsy/listings/delete
   * Handle listing deletion
   */
  app.post<{ Body: EtsyWebhookPayload }>(
    "/webhooks/etsy/listings/delete",
    async (request, reply) => {
      try {
        const payload = request.body;

        // Check for idempotency
        const externalId = `${payload.event_type}-${payload.timestamp}-${(payload.data as any).listing_id}`;
        const existingEvent = await (prisma as any).webhookEvent.findFirst({
          where: { channel: "ETSY", externalId },
        });

        if (existingEvent && existingEvent.isProcessed) {
          return reply.send({ success: true, message: "Already processed" });
        }

        // Process webhook
        await handleListingDelete(payload);

        // Mark as processed
        if (existingEvent) {
          await (prisma as any).webhookEvent.update({
            where: { id: existingEvent.id },
            data: { isProcessed: true, processedAt: new Date() },
          });
        } else {
          await (prisma as any).webhookEvent.create({
            data: {
              channel: "ETSY",
              eventType: payload.event_type,
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
        console.error("[EtsyWebhooks] Webhook processing failed:", message);
        return reply.status(500).send({ success: false, error: message });
      }
    }
  );

  /**
   * POST /webhooks/etsy/inventory/update
   * Handle inventory level changes
   */
  app.post<{ Body: EtsyWebhookPayload }>(
    "/webhooks/etsy/inventory/update",
    async (request, reply) => {
      try {
        const payload = request.body;

        // Check for idempotency
        const externalId = `${payload.event_type}-${payload.timestamp}-${(payload.data as any).listing_id}`;
        const existingEvent = await (prisma as any).webhookEvent.findFirst({
          where: { channel: "ETSY", externalId },
        });

        if (existingEvent && existingEvent.isProcessed) {
          return reply.send({ success: true, message: "Already processed" });
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
              channel: "ETSY",
              eventType: payload.event_type,
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
        console.error("[EtsyWebhooks] Webhook processing failed:", message);
        return reply.status(500).send({ success: false, error: message });
      }
    }
  );

  /**
   * POST /webhooks/etsy/orders/create
   * Handle new order creation
   */
  app.post<{ Body: EtsyWebhookPayload }>(
    "/webhooks/etsy/orders/create",
    async (request, reply) => {
      try {
        const payload = request.body;

        // Check for idempotency
        const externalId = `${payload.event_type}-${payload.timestamp}-${(payload.data as any).receipt_id}`;
        const existingEvent = await (prisma as any).webhookEvent.findFirst({
          where: { channel: "ETSY", externalId },
        });

        if (existingEvent && existingEvent.isProcessed) {
          return reply.send({ success: true, message: "Already processed" });
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
              channel: "ETSY",
              eventType: payload.event_type,
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
        console.error("[EtsyWebhooks] Webhook processing failed:", message);
        return reply.status(500).send({ success: false, error: message });
      }
    }
  );

  /**
   * POST /webhooks/etsy/orders/update
   * Handle order status changes
   */
  app.post<{ Body: EtsyWebhookPayload }>(
    "/webhooks/etsy/orders/update",
    async (request, reply) => {
      try {
        const payload = request.body;

        // Check for idempotency
        const externalId = `${payload.event_type}-${payload.timestamp}-${(payload.data as any).receipt_id}`;
        const existingEvent = await (prisma as any).webhookEvent.findFirst({
          where: { channel: "ETSY", externalId },
        });

        if (existingEvent && existingEvent.isProcessed) {
          return reply.send({ success: true, message: "Already processed" });
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
              channel: "ETSY",
              eventType: payload.event_type,
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
        console.error("[EtsyWebhooks] Webhook processing failed:", message);
        return reply.status(500).send({ success: false, error: message });
      }
    }
  );

  /**
   * POST /webhooks/etsy/orders/delete
   * Handle order deletion
   */
  app.post<{ Body: EtsyWebhookPayload }>(
    "/webhooks/etsy/orders/delete",
    async (request, reply) => {
      try {
        const payload = request.body;

        // Check for idempotency
        const externalId = `${payload.event_type}-${payload.timestamp}-${(payload.data as any).receipt_id}`;
        const existingEvent = await (prisma as any).webhookEvent.findFirst({
          where: { channel: "ETSY", externalId },
        });

        if (existingEvent && existingEvent.isProcessed) {
          return reply.send({ success: true, message: "Already processed" });
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
              channel: "ETSY",
              eventType: payload.event_type,
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
        console.error("[EtsyWebhooks] Webhook processing failed:", message);
        return reply.status(500).send({ success: false, error: message });
      }
    }
  );
}
