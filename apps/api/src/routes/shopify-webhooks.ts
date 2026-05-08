/**
 * Shopify Webhook Routes
 * Handles incoming webhooks from Shopify for products, inventory, and orders.
 *
 * S.2.5 — order create/update handlers rewritten to use the canonical
 * Order schema columns (channel/channelOrderId/totalPrice/customerName/
 * customerEmail). Pre-S.2.5 they referenced non-existent columns
 * (amazonOrderId/totalAmount/buyerName/channelId) and would throw a
 * Prisma error if invoked. Stock now flows through the reserve-then-
 * consume lifecycle (reserve at order create, consume on fulfillment).
 */

import type { FastifyInstance } from "fastify";
import prisma from "../db.js";
import { WebhookValidator, WebhookProcessor } from "../utils/webhook.js";
import { ConfigManager } from "../utils/config.js";
import type { ShopifyConfig } from "../types/marketplace.js";
import { publishListingEvent } from "../services/listing-events.service.js";
import {
  reserveOpenOrder,
  consumeOpenOrder,
  resolveLocationByCode,
} from "../services/stock-level.service.js";
import { logger } from "../utils/logger.js";

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
        // C.3 — broadcast so any open /listings tab refreshes within
        // ~200 ms instead of waiting for the next 30 s polling tick.
        publishListingEvent({
          type: "listing.updated",
          listingId: listing.id,
          reason: "shopify-webhook:inventory",
          ts: Date.now(),
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
// S.2.5 — map Shopify financial/fulfillment state to our OrderStatus enum.
function mapShopifyOrderStatus(financial?: string, fulfillment?: string | null): 'PENDING' | 'PROCESSING' | 'SHIPPED' | 'CANCELLED' | 'DELIVERED' {
  if (financial === 'voided' || financial === 'refunded') return 'CANCELLED';
  if (fulfillment === 'fulfilled') return 'SHIPPED';
  if (fulfillment === 'partial') return 'PROCESSING';
  if (financial === 'paid' || financial === 'authorized') return 'PROCESSING';
  return 'PENDING';
}

async function handleOrderCreate(payload: ShopifyWebhookPayload): Promise<void> {
  const order = payload as any;
  const shopifyOrderId = String(order.id);

  logger.info('[ShopifyWebhooks] Processing order create', { shopifyOrderId });

  try {
    const status = mapShopifyOrderStatus(order.financial_status, order.fulfillment_status);
    const purchaseDate = order.created_at ? new Date(order.created_at) : new Date();

    // Idempotent upsert on (channel, channelOrderId).
    const dbOrder = await prisma.order.upsert({
      where: {
        channel_channelOrderId: {
          channel: 'SHOPIFY',
          channelOrderId: shopifyOrderId,
        },
      },
      update: {
        status,
        totalPrice: parseFloat(order.total_price) || 0,
        currencyCode: order.currency ?? 'EUR',
        customerName: order.customer
          ? `${order.customer.first_name ?? ''} ${order.customer.last_name ?? ''}`.trim() || (order.email ?? 'Shopify customer')
          : (order.email ?? 'Shopify customer'),
        customerEmail: order.email ?? '',
        shippingAddress: order.shipping_address ?? {},
        shopifyMetadata: order as object,
      },
      create: {
        channel: 'SHOPIFY',
        channelOrderId: shopifyOrderId,
        status,
        totalPrice: parseFloat(order.total_price) || 0,
        currencyCode: order.currency ?? 'EUR',
        customerName: order.customer
          ? `${order.customer.first_name ?? ''} ${order.customer.last_name ?? ''}`.trim() || (order.email ?? 'Shopify customer')
          : (order.email ?? 'Shopify customer'),
        customerEmail: order.email ?? '',
        shippingAddress: order.shipping_address ?? {},
        purchaseDate,
        shopifyMetadata: order as object,
      },
    });

    // Replace order items idempotently. Same delete-then-create pattern
    // amazon-orders.service uses (no per-line external id to upsert on).
    await prisma.orderItem.deleteMany({ where: { orderId: dbOrder.id } });
    const createdItems: Array<{ productId: string | null; quantity: number; sku: string }> = [];
    if (order.line_items && Array.isArray(order.line_items)) {
      for (const item of order.line_items) {
        const sku = item.sku || item.title || `shopify-line-${item.id}`;
        const product = sku
          ? await prisma.product.findUnique({ where: { sku }, select: { id: true } })
          : null;
        await prisma.orderItem.create({
          data: {
            orderId: dbOrder.id,
            sku,
            quantity: item.quantity,
            price: parseFloat(item.price) || 0,
            ...(product?.id ? { productId: product.id } : {}),
          },
        });
        createdItems.push({ productId: product?.id ?? null, quantity: item.quantity, sku });
      }
    }

    // S.2.5 — reserve at IT-MAIN. Idempotent: re-runs of the same
    // webhook (Shopify retries on 5xx) skip already-reserved lines.
    const itMainId = await resolveLocationByCode('IT-MAIN');
    if (!itMainId) {
      logger.error('[ShopifyWebhooks] IT-MAIN missing — cannot reserve Shopify stock', { shopifyOrderId });
    } else {
      for (const it of createdItems) {
        if (!it.productId || it.quantity <= 0) continue;
        try {
          await reserveOpenOrder({
            orderId: dbOrder.id,
            productId: it.productId,
            locationId: itMainId,
            quantity: it.quantity,
            actor: 'shopify-webhooks:order-create',
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn('[ShopifyWebhooks] reserve failed', {
            shopifyOrderId, productId: it.productId, sku: it.sku, error: msg,
          });
        }
      }
    }

    // If Shopify already says fulfilled at create time (unusual but
    // possible on bulk imports), consume immediately.
    if (status === 'SHIPPED') {
      try {
        const consumed = await consumeOpenOrder({
          orderId: dbOrder.id,
          actor: 'shopify-webhooks:order-create',
        });
        if (consumed > 0) {
          logger.info('[ShopifyWebhooks] order-create arrived already-fulfilled, consumed', {
            shopifyOrderId, consumed,
          });
        }
      } catch (err) {
        logger.warn('[ShopifyWebhooks] consume on order-create-already-fulfilled failed', {
          shopifyOrderId, error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    logger.info('[ShopifyWebhooks] order-create processed', { shopifyOrderId, orderId: dbOrder.id });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('[ShopifyWebhooks] order-create failed', { shopifyOrderId, error: message });
    throw error;
  }
}

/**
 * Process order update webhook
 */
async function handleOrderUpdate(payload: ShopifyWebhookPayload): Promise<void> {
  const order = payload as any;
  const shopifyOrderId = String(order.id);

  logger.info('[ShopifyWebhooks] Processing order update', { shopifyOrderId });

  try {
    const dbOrder = await prisma.order.findUnique({
      where: {
        channel_channelOrderId: {
          channel: 'SHOPIFY',
          channelOrderId: shopifyOrderId,
        },
      },
      select: { id: true, status: true },
    });
    if (!dbOrder) {
      // Webhook arrived before order/create finished or was missed.
      // Defer to the create handler shape so we do reservation work too.
      logger.info('[ShopifyWebhooks] update arrived for unknown order — falling through to create flow', { shopifyOrderId });
      await handleOrderCreate(payload);
      return;
    }

    const newStatus = mapShopifyOrderStatus(order.financial_status, order.fulfillment_status);
    const newlyShipped = newStatus === 'SHIPPED' && dbOrder.status !== 'SHIPPED';
    const newlyCancelled = newStatus === 'CANCELLED' && dbOrder.status !== 'CANCELLED';

    await prisma.order.update({
      where: { id: dbOrder.id },
      data: {
        status: newStatus,
        totalPrice: parseFloat(order.total_price) || 0,
        currencyCode: order.currency ?? undefined,
        shippingAddress: order.shipping_address ?? undefined,
        shippedAt: newlyShipped
          ? new Date(order.updated_at ?? order.created_at ?? Date.now())
          : undefined,
        cancelledAt: newlyCancelled
          ? new Date(order.cancelled_at ?? order.updated_at ?? Date.now())
          : undefined,
        shopifyMetadata: order as object,
      },
    });

    if (newlyShipped) {
      try {
        const consumed = await consumeOpenOrder({
          orderId: dbOrder.id,
          actor: 'shopify-webhooks:order-update',
        });
        if (consumed > 0) {
          logger.info('[ShopifyWebhooks] SHIPPED transition consumed reservations', {
            shopifyOrderId, consumed,
          });
        }
      } catch (err) {
        logger.warn('[ShopifyWebhooks] consume on SHIPPED failed', {
          shopifyOrderId, error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (newlyCancelled) {
      void (async () => {
        try {
          const { handleOrderCancelled } = await import('../services/order-cancellation/index.js');
          const cleanup = await handleOrderCancelled(dbOrder.id);
          logger.info('[ShopifyWebhooks] cancellation cascade', { shopifyOrderId, ...cleanup });
        } catch (err) {
          logger.warn('[ShopifyWebhooks] cancellation cascade failed', {
            shopifyOrderId, error: err instanceof Error ? err.message : String(err),
          });
        }
      })();
    }

    logger.info('[ShopifyWebhooks] order-update processed', { shopifyOrderId, newStatus });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('[ShopifyWebhooks] order-update failed', { shopifyOrderId, error: message });
    throw error;
  }
}

/**
 * R4.1 — Process refund/create webhook → Nexus Return.
 *
 * Shopify fires `refunds/create` whenever a merchant (or admin via
 * Shopify Flow) issues a refund against an order. Pre-R4.1 this
 * event was black-boxed: the operator only saw the refund land in
 * Stripe/PayPal a day later, with no record on the Nexus side. R4.1
 * mirrors the refund into a Return row so:
 *   1. The /fulfillment/returns workspace surfaces channel-issued
 *      refunds alongside operator-created RMAs.
 *   2. Returns analytics counts them in rates / reasons / value.
 *   3. The audit trail attributes the refund to Shopify (not
 *      a phantom local action).
 *
 * Mapping:
 *   payload.id                       → Return.channelReturnId, channelRefundId
 *   payload.order_id                 → Return.orderId (resolved via Order.shopifyProductId? no — by channelOrderId)
 *   payload.note                     → Return.reason (free text from merchant)
 *   payload.refund_line_items[]      → ReturnItem rows (one per line)
 *   sum(subtotal_set.shop_money)     → Return.refundCents
 *   first line currency              → Return.currencyCode (defaults EUR)
 *   payload.created_at               → Return.refundedAt, channelRefundedAt
 *   status                           → REFUNDED (channel already issued; we mirror)
 *
 * Idempotency: pre-check Return where (channel='SHOPIFY', channel-
 * ReturnId=payload.id). If found, ignore — Shopify retries on 5xx
 * and we don't want duplicate RMAs.
 */
async function handleRefundCreate(payload: ShopifyWebhookPayload): Promise<{ kind: 'created' | 'duplicate' | 'no_order' | 'no_lines'; returnId?: string }> {
  const refund = payload as any;
  const refundId = String(refund.id);
  const channelOrderId = refund.order_id != null ? String(refund.order_id) : null;

  console.log(`[ShopifyWebhooks] Processing refund: ${refundId} (order=${channelOrderId})`);

  // 1) Idempotency: dedupe on (channel, channelReturnId).
  const existing = await (prisma as any).return.findFirst({
    where: { channel: 'SHOPIFY', channelReturnId: refundId },
    select: { id: true },
  });
  if (existing) {
    console.log(`[ShopifyWebhooks] Refund ${refundId} already mirrored as Return ${existing.id}`);
    return { kind: 'duplicate', returnId: existing.id };
  }

  // 2) Resolve the originating Order. Shopify's order_id is the
  //    numeric channel id; we stored it as Order.channelOrderId
  //    when we ingested the order. If the order isn't in our DB
  //    yet (e.g. webhooks raced ahead of the order sync) we still
  //    create the Return with orderId=null so nothing is lost — a
  //    re-sync can attach it later via the channelReturnId pointer.
  let orderId: string | null = null;
  if (channelOrderId) {
    const order = await (prisma as any).order.findFirst({
      where: { channel: 'SHOPIFY', channelOrderId },
      select: { id: true, currencyCode: true },
    });
    if (order) orderId = order.id;
    else console.warn(`[ShopifyWebhooks] Refund ${refundId}: Shopify order ${channelOrderId} not found locally`);
  }

  // 3) Map refund_line_items → ReturnItem creates. Skip lines with
  //    no line_item.sku (custom adjustments, shipping refunds, gift
  //    cards) — those don't map to a SKU we restock.
  const refundLines: any[] = Array.isArray(refund.refund_line_items) ? refund.refund_line_items : [];
  const itemCreates: Array<{ sku: string; quantity: number; productId: string | null; orderItemId: string | null }> = [];
  let refundCents = 0;
  let currencyCode: string | null = null;
  for (const rli of refundLines) {
    const li = rli.line_item ?? {};
    const sku: string | undefined = li.sku;
    const quantity = Number(rli.quantity ?? 0);
    if (!sku || quantity <= 0) continue;
    // Subtotal is in major units; convert to cents.
    const sub = rli.subtotal_set?.shop_money?.amount ?? rli.subtotal ?? '0';
    refundCents += Math.round(Number(sub) * 100);
    if (!currencyCode) {
      currencyCode = rli.subtotal_set?.shop_money?.currency_code ?? null;
    }
    // Resolve our productId by SKU (Product.sku is unique).
    const product = await (prisma as any).product.findUnique({
      where: { sku },
      select: { id: true },
    });
    itemCreates.push({
      sku,
      quantity,
      productId: product?.id ?? null,
      orderItemId: null, // OrderItem mapping by line_item_id is a follow-up
    });
  }
  if (itemCreates.length === 0) {
    console.warn(`[ShopifyWebhooks] Refund ${refundId} has no mappable line items (shipping-only or gift card refund?) — skipping`);
    return { kind: 'no_lines' };
  }

  // 4) Compose the RMA. We mark it REFUNDED end-to-end because
  //    Shopify already issued the refund; the operator workflow
  //    now is just to physically receive + restock the units when
  //    they arrive. status=REFUNDED, refundStatus=REFUNDED but the
  //    items are still pending restock — receiving still flips to
  //    RECEIVED via the existing /receive route.
  function generateRmaNumber(): string {
    const d = new Date();
    const yymmdd = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
    return `RMA-${yymmdd}-${rand}`;
  }

  const refundedAt = refund.created_at ? new Date(refund.created_at) : new Date();
  const ret = await (prisma as any).return.create({
    data: {
      orderId,
      channel: 'SHOPIFY',
      channelReturnId: refundId,
      rmaNumber: generateRmaNumber(),
      status: 'REFUNDED',
      reason: refund.note?.trim() || 'Shopify refund',
      refundStatus: 'REFUNDED',
      refundCents,
      currencyCode: currencyCode ?? 'EUR',
      channelRefundId: refundId,
      channelRefundedAt: refundedAt,
      refundedAt,
      items: {
        create: itemCreates.map((it) => ({
          sku: it.sku,
          quantity: it.quantity,
          productId: it.productId,
          orderItemId: it.orderItemId,
        })),
      },
    },
    select: { id: true, rmaNumber: true },
  });

  // 5) AuditLog — attribute the create to Shopify, not a phantom
  //    local action. Operators reading the timeline see the real
  //    source.
  try {
    await (prisma as any).auditLog.create({
      data: {
        userId: null,
        ip: null,
        entityType: 'Return',
        entityId: ret.id,
        action: 'create',
        metadata: {
          source: 'shopify-webhook',
          topic: 'refunds/create',
          shopifyRefundId: refundId,
          shopifyOrderId: channelOrderId,
          refundCents,
          currencyCode,
          mirroredOrder: !!orderId,
        },
      },
    });
  } catch (e) {
    console.warn('[ShopifyWebhooks] audit write failed (non-fatal)', e);
  }

  console.log(`[ShopifyWebhooks] Created Return ${ret.id} (${ret.rmaNumber}) for Shopify refund ${refundId}`);
  return { kind: 'created', returnId: ret.id };
}

/**
 * Process fulfillment create webhook
 */
async function handleFulfillmentCreate(payload: ShopifyWebhookPayload): Promise<void> {
  const fulfillment = payload as any;
  const shopifyOrderId = String(fulfillment.order_id);

  logger.info('[ShopifyWebhooks] Processing fulfillment create', { shopifyOrderId });

  try {
    const dbOrder = await prisma.order.findUnique({
      where: {
        channel_channelOrderId: {
          channel: 'SHOPIFY',
          channelOrderId: shopifyOrderId,
        },
      },
      select: { id: true, status: true },
    });
    if (!dbOrder) {
      logger.warn('[ShopifyWebhooks] fulfillment for unknown order', { shopifyOrderId });
      return;
    }

    const newlyShipped = dbOrder.status !== 'SHIPPED';
    await prisma.order.update({
      where: { id: dbOrder.id },
      data: {
        status: 'SHIPPED',
        shippedAt: new Date(),
      },
    });

    if (newlyShipped) {
      try {
        const consumed = await consumeOpenOrder({
          orderId: dbOrder.id,
          actor: 'shopify-webhooks:fulfillment-create',
        });
        if (consumed > 0) {
          logger.info('[ShopifyWebhooks] fulfillment consumed reservations', {
            shopifyOrderId, consumed,
          });
        }
      } catch (err) {
        logger.warn('[ShopifyWebhooks] consume on fulfillment failed', {
          shopifyOrderId, error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    logger.info('[ShopifyWebhooks] fulfillment-create processed', { shopifyOrderId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('[ShopifyWebhooks] fulfillment-create failed', { shopifyOrderId, error: message });
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

  /**
   * R4.1 — POST /webhooks/shopify/refunds/create
   *
   * Mirrors a Shopify-issued refund into a Nexus Return row so the
   * /fulfillment/returns workspace, analytics, and audit log all
   * see channel-issued refunds alongside operator-created RMAs.
   *
   * Test endpoint (no signature) lives at /webhooks/shopify/refunds/
   * create-test for sandbox runs — the route below is the
   * production path.
   */
  app.post("/webhooks/shopify/refunds/create", async (request, reply) => {
    try {
      const signature = request.headers["x-shopify-hmac-sha256"] as string;
      const body = JSON.stringify(request.body);

      const config = ConfigManager.getConfig("SHOPIFY") as ShopifyConfig;
      if (!config) {
        return reply.status(400).send({
          success: false,
          error: "Shopify is not configured",
        });
      }

      const validation = WebhookValidator.validateShopifySignature(body, signature, config.webhookSecret);
      if (!validation.isValid) {
        console.warn("[ShopifyWebhooks] refunds/create — invalid signature");
        return reply.status(401).send({
          success: false,
          error: validation.error,
        });
      }

      const payload = request.body as ShopifyWebhookPayload;
      const externalId = String(payload.id);

      // Top-level idempotency via the WebhookProcessor table covers
      // duplicate webhook deliveries (Shopify retries on 5xx). The
      // handler below ALSO dedupes via Return.channelReturnId so we
      // stay correct even if the external_id table loses an entry.
      const isProcessed = await WebhookProcessor.isWebhookProcessed("SHOPIFY", externalId, prisma);
      if (isProcessed) {
        return reply.send({ success: true, message: "Already processed" });
      }

      const result = await handleRefundCreate(payload);
      await WebhookProcessor.markWebhookProcessed("SHOPIFY", externalId, prisma);

      return reply.send({ success: true, ...result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[ShopifyWebhooks] refunds/create webhook failed:", message);
      return reply.status(500).send({
        success: false,
        error: message,
      });
    }
  });

  /**
   * R4.1 — Sandbox-only test endpoint.
   *
   * Skips signature verification + idempotency table check so we can
   * fire fixture payloads at the handler from a verify script
   * without setting up a Shopify partner app + ngrok tunnel. Gated
   * to non-production env: returns 404 unless NEXUS_ENV is anything
   * other than 'production'. The handler logic is shared with the
   * real route above, so behaviour is identical end-to-end.
   */
  app.post("/webhooks/shopify/refunds/create-test", async (request, reply) => {
    if ((process.env.NEXUS_ENV ?? '').toLowerCase() === 'production') {
      return reply.code(404).send({ error: 'Not found' });
    }
    try {
      const result = await handleRefundCreate(request.body as ShopifyWebhookPayload);
      return reply.send({ success: true, ...result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[ShopifyWebhooks] refunds/create-test failed:", message);
      return reply.status(500).send({
        success: false,
        error: message,
      });
    }
  });
}
