import { recordManagedContentChange } from '../services/shopify/content-webhook.service.js'
import { workspaceKey } from '@nexus/database/workspace-context'
import { registerShopifySchemaWebhook } from '../services/shopify/schema-sync.service.js'
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
import { WebhookValidator, registerRawJsonParser } from "../utils/webhook.js";
import { completeInbound, recordInbound } from "../services/cx/ingress/ledger.js";
import { legacyIngress, verifiedChannelWorkspace, withIngressWorkspace } from "../lib/workspace-ingress.js";
import { inboundHandlerFor } from "../services/cx/ingress/handlers.js";
import type { RawBodyRequest } from "../utils/webhook.js";
import { ConfigManager } from "../utils/config.js";
import type { ShopifyConfig } from "../types/marketplace.js";
import { publishListingEvent } from "../services/listing-events.service.js";
import { productEventService } from "../services/product-event.service.js";
import {
  reserveOpenOrder,
  consumeOpenOrder,
  resolveLocationByCode,
} from "../services/stock-level.service.js";
import { resolveByShopifyId } from "../services/shopify-locations.service.js";
// applyStockMovement now lives behind the ChannelStockEvent service
// (CS.2 — drift threshold + auto-apply / review-needed gating).
import { logger } from "../utils/logger.js";

interface ShopifyWebhookPayload {
  id: string;
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
}

/**
 * RT.3 — parse the X-Shopify-Triggered-At header that Shopify
 * stamps on every webhook (RFC3339 UTC). Used as the provider-side
 * timestamp on the WebhookEvent row so /api/admin/push-latency can
 * chart Shopify push latency. Returns null if the header is missing
 * or malformed — push-latency drops nulls from the percentile calc.
 */
function parseShopifyTriggeredAt(request: { headers: Record<string, unknown> }): Date | null {
  const raw = request.headers["x-shopify-triggered-at"];
  if (typeof raw !== "string") return null;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : new Date(t);
}

/**
 * Process product update webhook
 */
export async function handleProductUpdate(payload: ShopifyWebhookPayload): Promise<void> {
  try {
    const product = payload as any;
    const shopifyProductId = String(product.id);

    console.log(`[ShopifyWebhooks] Processing product update: ${shopifyProductId}`);

    if (await recordManagedContentChange(shopifyProductId, product.updated_at)) return;

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

    // P-RT.2 — fan out to ProductEvent timeline + SSE listing-events
    // bus so /products + /products/[id]/edit refresh within ~250ms
    // instead of waiting for the 30s usePolledList tick. emit() writes
    // the audit row AND publishes product.updated to the bus via the
    // ssePayloadFor mapping (P-RT.1).
    void productEventService.emit({
      aggregateId: dbProduct.id,
      aggregateType: 'Product',
      eventType: 'PRODUCT_UPDATED',
      data: { shopifyProductId, title: product.title },
      metadata: { source: 'WEBHOOK', shopifyProductId, channel: 'SHOPIFY' },
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
export async function handleProductDelete(payload: ShopifyWebhookPayload): Promise<void> {
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

      // P-RT.2 — emit product.deleted on the SSE bus. We use the
      // PRODUCT_DELETED event type even though the row stays in the
      // DB (status flipped to INACTIVE) because semantically the
      // product left the active catalog from Shopify's perspective —
      // /products grid should drop it from the active view in real
      // time. The Timeline tab keeps the row + the audit event.
      void productEventService.emit({
        aggregateId: dbProduct.id,
        aggregateType: 'Product',
        eventType: 'PRODUCT_DELETED',
        data: { shopifyProductId },
        metadata: { source: 'WEBHOOK', shopifyProductId, channel: 'SHOPIFY' },
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
 * Process inventory_levels/update webhook.
 *
 * S.23 + CS.2 — Shopify pushes inventory deltas back; we route them
 * through ChannelStockEvent so the operator gets visibility into
 * drift even when auto-applied. Large drifts (> threshold) sit in
 * REVIEW_NEEDED status until operator confirms — closes the
 * silent-overwrite risk where a Shopify admin typo would have
 * blown away local stock without trace.
 *
 * Webhook payload:
 *   { inventory_item_id, location_id, available, updated_at }
 *
 * Flow:
 *   1. Resolve location_id → Nexus SHOPIFY_LOCATION StockLocation
 *      via resolveByShopifyId (S.22). Skip if unmapped.
 *   2. Resolve inventory_item_id → ChannelListing → Product.
 *   3. recordChannelStockEvent({ channel: 'SHOPIFY', productId,
 *      channelReportedQty: available, locationId, channelEventId:
 *      `${inventory_item_id}:${updated_at}` }). The service handles
 *      the threshold logic (auto-apply small drifts, queue large
 *      drifts for REVIEW_NEEDED).
 */
export async function handleInventoryUpdate(payload: ShopifyWebhookPayload): Promise<void> {
  const inventory = payload as any;
  const inventoryItemId = String(inventory.inventory_item_id ?? '');
  const shopifyLocationId = inventory.location_id != null ? String(inventory.location_id) : null;
  const available = inventory.available;
  const updatedAt = inventory.updated_at != null ? String(inventory.updated_at) : new Date().toISOString();

  logger.info('[ShopifyWebhooks] inventory_levels/update received', {
    inventoryItemId, shopifyLocationId, available,
  });

  if (!inventoryItemId || !Number.isSafeInteger(available)) {
    logger.warn('[ShopifyWebhooks] inventory webhook missing inventory_item_id; skipping');
    return;
  }
  if (!shopifyLocationId) {
    logger.warn('[ShopifyWebhooks] inventory webhook missing location_id; skipping (pre-S.22 payload?)');
    return;
  }

  try {
    // Resolve Shopify location → Nexus StockLocation. If the location
    // hasn't been discovered/mapped yet, drop the update — better to
    // miss one tick than to write to the wrong StockLevel row. The
    // operator can run /shopify-locations/discover and the next tick
    // catches up.
    const nexusLocation = await resolveByShopifyId(shopifyLocationId);
    if (!nexusLocation) {
      logger.warn('[ShopifyWebhooks] unmapped Shopify location — run discover', {
        shopifyLocationId,
      });
      return;
    }

    // Canonical native variant mappings use exact inventory IDs; a substring of
    // a product ID can match an unrelated SKU (and ProductVariation is retired).
    const matches = await prisma.channelListing.findMany({
      where: { channel: 'SHOPIFY', OR: [
        { platformAttributes: { path: ['inventoryItemId'], equals: inventoryItemId } },
        { platformAttributes: { path: ['inventoryItemId'], equals: `gid://shopify/InventoryItem/${inventoryItemId}` } },
      ] }, select: { productId: true }, take: 2,
    });
    let productId: string | null = matches.length === 1 ? matches[0].productId : null;
    if (!productId) {
      logger.warn('[ShopifyWebhooks] inventory webhook for unknown product', {
        inventoryItemId, shopifyLocationId,
      });
      // Still record the event with no productId so the operator
      // surface can show "unmapped SKU" entries — easier to debug
      // mapping holes from one place than via log archaeology.
      const { recordChannelStockEvent } = await import(
        '../services/channel-stock-event.service.js'
      );
      try {
        await recordChannelStockEvent({
          channel: 'SHOPIFY',
          channelEventId: `${inventoryItemId}:${shopifyLocationId}:${updatedAt}`,
          sku: inventoryItemId, // best-effort placeholder
          channelReportedQty: available,
          locationId: nexusLocation.id,
          rawPayload: payload as any,
        });
      } catch (e) {
        logger.warn('[ShopifyWebhooks] could not record unmapped event', {
          err: e instanceof Error ? e.message : String(e),
        });
      }
      return;
    }

    // CS.2 — route through ChannelStockEvent. The service computes
    // drift, classifies (AUTO_APPLIED if within threshold, else
    // REVIEW_NEEDED), and either fires applyStockMovement inline
    // or leaves the row queued for operator action.
    const { recordChannelStockEvent } = await import(
      '../services/channel-stock-event.service.js'
    );
    const result = await recordChannelStockEvent({
      channel: 'SHOPIFY',
      channelEventId: `${inventoryItemId}:${shopifyLocationId}:${updatedAt}`,
      productId,
      channelReportedQty: available,
      locationId: nexusLocation.id,
      rawPayload: payload as any,
    });

    logger.info('[ShopifyWebhooks] inventory_levels/update routed via CS.1', {
      productId,
      shopifyLocationId,
      drift: result.drift,
      status: result.status,
      newlyRecorded: result.newlyRecorded,
    });

    // P-RT.2 — emit a STOCK_ADJUSTED ProductEvent when the change
    // was auto-applied (drift within threshold) so /products + the
    // stock workspace refresh sub-200ms via the listing-events SSE
    // bus. REVIEW_NEEDED rows are operator-gated by design — those
    // already surface in the drift triage UI; firing SSE for them
    // would imply the change landed locally when it didn't. APPLIED
    // (drift === 0) is a no-op observation, no UI refresh needed.
    if (
      result.newlyRecorded &&
      (result.status === 'AUTO_APPLIED') &&
      productId
    ) {
      void productEventService.emit({
        aggregateId: productId,
        aggregateType: 'Product',
        eventType: 'STOCK_ADJUSTED',
        data: {
          shopifyInventoryItemId: inventoryItemId,
          locationId: nexusLocation.id,
          channelReportedQty: available,
          drift: result.drift,
        },
        metadata: { source: 'WEBHOOK', channel: 'SHOPIFY' },
      });
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

export async function handleOrderCreate(payload: ShopifyWebhookPayload): Promise<void> {
  const order = payload as any;
  const shopifyOrderId = String(order.id);

  logger.info('[ShopifyWebhooks] Processing order create', { shopifyOrderId });

  try {
    const status = mapShopifyOrderStatus(order.financial_status, order.fulfillment_status);
    const purchaseDate = order.created_at ? new Date(order.created_at) : new Date();

    // Idempotent upsert on (channel, channelOrderId).
    const dbOrder = await prisma.order.upsert({
      where: {
        channel_channelOrderId: workspaceKey({
          channel: 'SHOPIFY',
          channelOrderId: shopifyOrderId,
        }),
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

    // O.5: upsert per line by (orderId, externalLineItemId=Shopify
    // line_items[].id). Replaces the earlier delete-then-create
    // pattern so OrderItem.id stays stable across the orders/create →
    // orders/updated → refunds/create webhook sequence (Shopify
    // retries on 5xx and the same line keeps its id, so any
    // ReturnItem.orderItemId reference survives). Same SKU on
    // multiple lines stays valid because the unique key is the line
    // id, not the SKU.
    const createdItems: Array<{ productId: string | null; quantity: number; sku: string }> = [];
    if (order.line_items && Array.isArray(order.line_items)) {
      for (const item of order.line_items) {
        const sku = item.sku || item.title || `shopify-line-${item.id}`;
        const externalLineItemId = String(item.id);
        const product = sku
          ? await prisma.product.findUnique({ where: { workspace_sku: workspaceKey({ sku: sku }) }, select: { id: true } })
          : null;
        await prisma.orderItem.upsert({
          where: {
            orderId_externalLineItemId: workspaceKey({
              orderId: dbOrder.id,
              externalLineItemId,
            }),
          },
          create: {
            orderId: dbOrder.id,
            externalLineItemId,
            sku,
            quantity: item.quantity,
            price: parseFloat(item.price) || 0,
            ...(product?.id ? { productId: product.id } : {}),
          },
          update: {
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

    // IS.1 → RT.2 — run the CANONICAL cascade after reserving (the old
    // hand-rolled row loop missed shared-eBay fan-out, Follow/FBA filtering,
    // coalescing, and the ChannelListing.quantity write, and carried a 30s
    // hold). reason ORDER_PLACED ⇒ 0-hold, priority-1 instant dispatch (~2s).
    void (async () => {
      try {
        const { recascadeProduct } = await import('../services/stock-movement.service.js');
        for (const it of createdItems) {
          if (!it.productId) continue;
          const res = await recascadeProduct(it.productId, {
            reason: 'ORDER_PLACED',
            referenceType: 'ORDER',
            referenceId: order?.id ? String(order.id) : undefined,
            actor: 'shopify-webhooks:IS.1',
          });
          if (res.ok === false) {
            logger.warn('[ShopifyWebhooks] IS.1 recascade refused (NO_LEDGER) — backfill needed', {
              productId: it.productId,
              totalStock: res.totalStock,
            });
          }
        }
      } catch (err) {
        logger.warn('[ShopifyWebhooks] IS.1 cascade failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();

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

    // O.6: lifecycle event for /orders SSE subscribers. orders/create
    // is Shopify's own create webhook, so we always emit order.created
    // (idempotent at the bus level — multiple subscribers re-fetch).
    void (async () => {
      try {
        const { publishOrderEvent } = await import('../services/order-events.service.js');
        publishOrderEvent({
          type: 'order.created',
          orderId: dbOrder.id,
          channel: 'SHOPIFY',
          channelOrderId: shopifyOrderId,
          ts: Date.now(),
        });
      } catch {
        // bus failure must not break webhook ack
      }
    })();

    // O.21a: customer FK + cache refresh. Fire-and-forget per the
    // amazon-orders / ebay-orders pattern.
    void (async () => {
      try {
        const { linkAndRefreshCustomerForOrder } = await import(
          '../services/customer-cache.service.js'
        );
        await linkAndRefreshCustomerForOrder(dbOrder.id);
      } catch (err) {
        logger.warn('[ShopifyWebhooks] customer cache refresh failed', {
          shopifyOrderId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();

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
export async function handleOrderUpdate(payload: ShopifyWebhookPayload): Promise<void> {
  const order = payload as any;
  const shopifyOrderId = String(order.id);

  logger.info('[ShopifyWebhooks] Processing order update', { shopifyOrderId });

  try {
    const dbOrder = await prisma.order.findUnique({
      where: {
        channel_channelOrderId: workspaceKey({
          channel: 'SHOPIFY',
          channelOrderId: shopifyOrderId,
        }),
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

    const channelStatus = mapShopifyOrderStatus(order.financial_status, order.fulfillment_status);

    // O.7: terminal-status downgrade guard. Shopify webhook delivery
    // isn't ordered with respect to the orderCancel mutation we send
    // on local cancel — orders/updated can arrive carrying pre-cancel
    // state moments after we issued the cancel. Preserve the local
    // terminal status when the channel still reports a non-terminal
    // one.
    const { shouldPreserveTerminalStatus } = await import('../services/order-status-guards.js');
    const preserveStatus = shouldPreserveTerminalStatus(dbOrder.status, channelStatus);
    if (preserveStatus) {
      logger.info('[ShopifyWebhooks] preserving local terminal status (webhook reports non-terminal)', {
        shopifyOrderId, localStatus: dbOrder.status, channelStatus,
      });
    }
    const newStatus = preserveStatus ? dbOrder.status : channelStatus;
    const newlyShipped = !preserveStatus && newStatus === 'SHIPPED' && dbOrder.status !== 'SHIPPED';
    const newlyCancelled = !preserveStatus && newStatus === 'CANCELLED' && dbOrder.status !== 'CANCELLED';

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

    // O.6: lifecycle event for /orders SSE subscribers. Cancellation
    // gets its own type so /orders can show the badge transition
    // immediately + invalidate facets (PENDING count drops).
    void (async () => {
      try {
        const { publishOrderEvent } = await import('../services/order-events.service.js');
        publishOrderEvent(
          newlyCancelled
            ? {
                type: 'order.cancelled',
                orderId: dbOrder.id,
                channel: 'SHOPIFY',
                ts: Date.now(),
              }
            : {
                type: 'order.updated',
                orderId: dbOrder.id,
                channel: 'SHOPIFY',
                status: newStatus,
                ts: Date.now(),
              },
        );
      } catch {
        // bus failure must not break webhook ack
      }
    })();

    // O.21a: customer cache refresh on every order update — covers
    // status transitions that affect LTV (cancelled / refunded
    // orders are excluded from totalSpentCents). FK is already set
    // from order-create; just need the recompute.
    void (async () => {
      try {
        const { linkAndRefreshCustomerForOrder } = await import(
          '../services/customer-cache.service.js'
        );
        await linkAndRefreshCustomerForOrder(dbOrder.id);
      } catch (err) {
        logger.warn('[ShopifyWebhooks] customer cache refresh failed', {
          shopifyOrderId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();

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
export async function handleRefundCreate(payload: ShopifyWebhookPayload): Promise<{ kind: 'created' | 'duplicate' | 'no_order' | 'no_lines'; returnId?: string }> {
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

  // O.6: emit return.created so /orders Returns lens auto-refreshes
  // when Shopify mirrors a refund. Fire-and-forget; bus failure must
  // not affect webhook ack.
  void (async () => {
    try {
      const { publishOrderEvent } = await import('../services/order-events.service.js');
      publishOrderEvent({
        type: 'return.created',
        returnId: ret.id,
        orderId: orderId,
        channel: 'SHOPIFY',
        ts: Date.now(),
      });
    } catch {
      // ignore
    }
  })();

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
export async function handleFulfillmentCreate(payload: ShopifyWebhookPayload): Promise<void> {
  const fulfillment = payload as any;
  const shopifyOrderId = String(fulfillment.order_id);

  logger.info('[ShopifyWebhooks] Processing fulfillment create', { shopifyOrderId });

  try {
    const dbOrder = await prisma.order.findUnique({
      where: {
        channel_channelOrderId: workspaceKey({
          channel: 'SHOPIFY',
          channelOrderId: shopifyOrderId,
        }),
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
  // CX.0 (S9): Shopify signs the raw bytes; capture them for this plugin only.
  registerRawJsonParser(app);
  registerShopifySchemaWebhook(app);

  /**
   * Which connected shop a verified webhook belongs to.
   *
   * The first choice is the shop domain Shopify stamps on the request, matched against
   * the routing index's `inboundAliases`. That is the only answer that stays correct
   * once a second Shopify account is connected.
   *
   * The fallback exists because the alias is backfilled from the connection's stored
   * identity, and a connection saved before that identity was captured has no alias to
   * match. Asking the index for the channel alone answers only when exactly ONE active
   * Shopify route exists — with two it raises, because guessing between two businesses
   * is the one failure this whole programme is about. So the fallback cannot leak: it
   * can only recover the single-account case that worked before this change.
   */
  async function resolveShopifyRoute(shopDomain?: string) {
    if (!shopDomain) return verifiedChannelWorkspace("SHOPIFY");
    try {
      return await verifiedChannelWorkspace("SHOPIFY", shopDomain);
    } catch (error) {
      const route = await verifiedChannelWorkspace("SHOPIFY");
      logger.warn("[ShopifyWebhooks] routed by the only connected shop; its domain alias is missing", {
        shopDomain,
        connectionId: route.connectionId,
      });
      return route;
    }
  }

  /**
   * P2.1 — one receiver for all seven topics.
   *
   * What stood here was the same forty lines copied seven times, and the copies had
   * drifted into two defects that only a rewrite removes:
   *
   * 1. Nothing reached the ledger. The routes ran with NO business profile, so every
   *    `WebhookEvent` query inside them threw `Select a business profile` into a catch
   *    block that logged and carried on. Measured before this change: a receiver's own
   *    write left zero rows behind. Shopify was the only connected channel with no
   *    inbound history at all.
   *
   * 2. Idempotency keyed on the RESOURCE, not the delivery. `externalId` was
   *    `String(payload.id)` — the product's id, the order's id — against a unique
   *    `(channel, externalId)`. Had defect 1 not been masking it, the FIRST update to
   *    a product would have been handled and every later update to that same product
   *    dropped as "Already processed", permanently. Fixing the ledger write without
   *    fixing this would have turned a silent gap into silent data loss, so the two
   *    are one change. The key is now `X-Shopify-Webhook-Id`: Shopify's own id for
   *    this delivery, which is stable across ITS retries and different for every new
   *    change to the same resource.
   *
   * A rejected signature is recorded too. An unsigned body cannot name a workspace,
   * so it is recorded against the platform's own — the same choice the Amazon
   * credential path makes for a message no business owns — and its claimed shop is
   * kept as text in the reason rather than trusted as a routing key.
   */
  type ShopifyTopicHandler = (payload: ShopifyWebhookPayload) => Promise<unknown>;

  function receiveShopify(path: string, eventType: string, handle: ShopifyTopicHandler) {
    app.post(path, async (request, reply) => {
      const body = (request as RawBodyRequest).rawBody;
      const signature = request.headers["x-shopify-hmac-sha256"] as string | undefined;
      const shopDomain = request.headers["x-shopify-shop-domain"] as string | undefined;
      const deliveryId = request.headers["x-shopify-webhook-id"] as string | undefined;
      const payload = request.body as ShopifyWebhookPayload;

      const config = ConfigManager.getConfig("SHOPIFY") as ShopifyConfig;
      if (!config) {
        return reply.status(400).send({ success: false, error: "Shopify is not configured" });
      }

      const validation = WebhookValidator.validateShopifySignature(body, signature, config.webhookSecret);
      if (!validation.isValid) {
        // `externalId: null` on purpose. Nothing about an unverified body is
        // trustworthy, and `(channel, externalId)` is UNIQUE: a forged delivery id
        // naming a real one would occupy that slot and make the genuine delivery look
        // like a duplicate, suppressing it. Null keys the row on the body digest,
        // which nobody can use to collide with a verified event.
        await legacyIngress(() =>
          recordInbound({
            channel: "SHOPIFY",
            eventType,
            externalId: null,
            rawBody: body ?? null,
            payload: payload ?? {},
            signatureOk: false,
            verifiedBy: "shopify_hmac",
            status: "failed",
            lastError: `signature rejected: ${validation.error ?? "invalid"}${shopDomain ? ` (claimed shop ${String(shopDomain).slice(0, 80)})` : ""}`,
          }),
        );
        logger.warn("[ShopifyWebhooks] signature rejected", { eventType, shopDomain });
        return reply.status(401).send({ success: false, error: validation.error });
      }

      let route: { workspaceId: string; connectionId: string };
      try {
        route = await resolveShopifyRoute(shopDomain);
      } catch (error) {
        // The signature passed, so the body is genuinely Shopify's — we simply do not
        // know whose shop it is. Record it before answering, so the event exists even
        // though nothing can act on it, then let Shopify retry.
        await legacyIngress(() =>
          recordInbound({
            channel: "SHOPIFY",
            eventType,
            externalId: deliveryId ?? null,
            rawBody: body ?? null,
            payload: payload ?? {},
            signatureOk: true,
            verifiedBy: "shopify_hmac",
            providerTimestamp: parseShopifyTriggeredAt(request),
            status: "failed",
            lastError: `no connected shop matches ${shopDomain ?? "(no shop domain header)"}: ${error instanceof Error ? error.message : String(error)}`,
          }),
        );
        logger.error("[ShopifyWebhooks] verified webhook needs account routing", { eventType, shopDomain });
        return reply.status(503).send({ success: false, error: "The shop on this webhook is not connected." });
      }

      return withIngressWorkspace(route.workspaceId, async () => {
        const written = await recordInbound({
          channel: "SHOPIFY",
          eventType,
          externalId: deliveryId ?? null,
          rawBody: body ?? null,
          payload: payload ?? {},
          signatureOk: true,
          verifiedBy: "shopify_hmac",
          connectionId: route.connectionId,
          providerTimestamp: parseShopifyTriggeredAt(request),
          status: "pending",
        });

        // No row means the ledger itself is unavailable. Answering 200 would ack an
        // event nothing recorded and nothing handled; a 503 keeps it on Shopify's
        // retry schedule. Same rule the Amazon poller follows: ledger first.
        if (!written.id) {
          logger.error("[ShopifyWebhooks] inbound ledger unavailable — webhook not acked", { eventType, deliveryId });
          return reply.status(503).send({ success: false, error: "The inbound ledger is unavailable." });
        }

        // Only a FINISHED event is a duplicate worth short-circuiting. Shopify resends
        // the same delivery id both when it never heard an answer and when we answered
        // with a failure; treating the second as "already processed" would drop the
        // very retry we asked for.
        if (written.duplicate && written.existingStatus === "done") {
          return reply.send({ success: true, message: "Already processed" });
        }

        try {
          const result = await handle(payload);
          await completeInbound(written.id, true);
          const extra = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
          return reply.send({ success: true, ...extra });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await completeInbound(written.id, false, message);
          logger.error(`[ShopifyWebhooks] ${eventType} failed`, { error: message });
          return reply.status(500).send({ success: false, error: message });
        }
      });
    });
  }

  // The event-type strings are the ones already written to `WebhookEvent`, not
  // Shopify's topic names. Changing them would orphan every stored row from the
  // handler that can replay it.
  receiveShopify("/webhooks/shopify/products/update", "product/update", handleProductUpdate);
  receiveShopify("/webhooks/shopify/products/delete", "product/delete", handleProductDelete);
  receiveShopify("/webhooks/shopify/inventory/update", "inventory/update", handleInventoryUpdate);
  receiveShopify("/webhooks/shopify/orders/create", "order/create", handleOrderCreate);
  receiveShopify("/webhooks/shopify/orders/update", "order/update", handleOrderUpdate);
  receiveShopify("/webhooks/shopify/fulfillments/create", "fulfillment/create", handleFulfillmentCreate);
  receiveShopify("/webhooks/shopify/refunds/create", "refunds/create", handleRefundCreate);

  // CX.0 (S8): the unsigned `refunds/create-test` route is gone. Verify
  // scripts sign a request to the real route with SHOPIFY_WEBHOOK_SECRET.
}

/**
 * Replay one stored Shopify webhook through the handler that first received it.
 *
 * P2.1 — this used to BE the dispatch table: a switch listing every topic, beside the
 * seven routes that listed the same topics again. The two drifted exactly as a
 * duplicated list does — the switch answered `refund/create` while the route wrote
 * `refunds/create`, so replaying a refund threw "Unknown Shopify eventType" and no
 * refund was ever replayable. It now asks the one registry, which the routes and the
 * retry worker also ask, so a topic cannot be known to one and unknown to another.
 */
export async function dispatchShopifyWebhook(eventType: string, payload: unknown): Promise<void> {
  const handler = await inboundHandlerFor('SHOPIFY', eventType)
  if (!handler) throw new Error(`Unknown Shopify eventType: ${eventType}`)
  await handler(payload)
}
