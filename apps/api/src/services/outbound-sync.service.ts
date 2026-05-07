import prisma from "../db.js";
import { amazonSpApiClient } from "../clients/amazon-sp-api.client.js";
import {
  acquireAmazonPublishToken,
  checkAmazonCircuit,
  getAmazonPublishMode,
  recordAmazonOutcome,
} from "./amazon-publish-gate.service.js";
import {
  acquireEbayPublishToken,
  checkEbayCircuit,
  getEbayApiBaseForMode,
  getEbayPublishMode,
  recordEbayOutcome,
} from "./ebay-publish-gate.service.js";
import {
  digestPayload,
  writeAttemptLog,
} from "./channel-publish-audit.service.js";
import { ebayAuthService } from "./ebay-auth.service.js";

// ── Data Structures ──────────────────────────────────────────────────────

interface SyncPayload {
  price?: number;
  quantity?: number;
  categoryAttributes?: Record<string, any>;
  title?: string;
  description?: string;
  images?: string[];
  [key: string]: any;
}

interface QueueResult {
  success: boolean;
  queueId?: string;
  message: string;
}

interface SyncResult {
  success: boolean;
  queueId: string;
  channel: string;
  status: string;
  message: string;
  error?: string;
}

interface ProcessingStats {
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  errors: Array<{ queueId: string; error: string }>;
}

// ── Outbound Sync Service ────────────────────────────────────────────────

export class OutboundSyncService {
  private stats = {
    queued: 0,
    processed: 0,
    succeeded: 0,
    failed: 0,
  };

  /**
   * Queue a product update for outbound sync to a specific channel
   */
  async queueProductUpdate(
    productId: string,
    targetChannel: "AMAZON" | "EBAY" | "SHOPIFY" | "WOOCOMMERCE",
    syncType: "PRICE_UPDATE" | "QUANTITY_UPDATE" | "ATTRIBUTE_UPDATE" | "FULL_SYNC",
    payload: SyncPayload
  ): Promise<QueueResult> {
    try {
      // Verify product exists
      const product = await prisma.product.findUnique({
        where: { id: productId },
      });

      if (!product) {
        return {
          success: false,
          message: `Product ${productId} not found`,
        };
      }

      // Create queue entry
      const queueEntry = await prisma.outboundSyncQueue.create({
        data: {
          productId,
          targetChannel,
          syncStatus: "PENDING",
          syncType,
          payload,
          retryCount: 0,
          maxRetries: 3,
          externalListingId: this.getExternalListingId(product, targetChannel),
        },
      });

      this.stats.queued++;

      return {
        success: true,
        queueId: queueEntry.id,
        message: `Product queued for ${targetChannel} sync`,
      };
    } catch (error) {
      console.error("Error queuing product update:", error);
      return {
        success: false,
        message: `Failed to queue product: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  }

  /**
   * Process all pending syncs in the queue
   */
  async processPendingSyncs(): Promise<ProcessingStats> {
    const stats: ProcessingStats = {
      processed: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      errors: [],
    };

    try {
      // Get all pending syncs that have either passed their grace
      // window or never had one. TECH_DEBT #49 — without the holdUntil
      // filter, any caller that wrote an OutboundSyncQueue row without
      // ALSO adding a BullMQ job (legacy paths, raw imports, manual
      // SQL) bypassed the 5-minute undo window because BullMQ's job
      // delay was the only thing deferring processing. This filter
      // mirrors outbound-sync-phase9.service.ts:332's getReadyItems().
      const now = new Date();
      const pendingItems = await prisma.outboundSyncQueue.findMany({
        where: {
          syncStatus: "PENDING",
          OR: [{ holdUntil: null }, { holdUntil: { lte: now } }],
        },
        include: {
          product: true,
        },
        orderBy: {
          createdAt: "asc",
        },
      });

      console.log(`Processing ${pendingItems.length} pending syncs`);

      for (const item of pendingItems) {
        try {
          // Mark as in progress
          await prisma.outboundSyncQueue.update({
            where: { id: item.id },
            data: { syncStatus: "IN_PROGRESS" },
          });

          let result: SyncResult;

          // Route to appropriate sync method
          if (item.targetChannel === "AMAZON") {
            result = await this.syncToAmazon(item);
          } else if (item.targetChannel === "EBAY") {
            result = await this.syncToEbay(item);
          } else if (item.targetChannel === "SHOPIFY") {
            result = await this.syncToShopify(item);
          } else if (item.targetChannel === "WOOCOMMERCE") {
            result = await this.syncToWoocommerce(item);
          } else {
            throw new Error(`Unknown channel: ${item.targetChannel}`);
          }

          if (result.success) {
            // Mark as successful
            await prisma.outboundSyncQueue.update({
              where: { id: item.id },
              data: {
                syncStatus: "SUCCESS",
                syncedAt: new Date(),
              },
            });
            stats.succeeded++;
          } else {
            // Handle retry logic
            await this.handleSyncFailure(item, result.error || "Unknown error");
            stats.failed++;
            stats.errors.push({
              queueId: item.id,
              error: result.error || "Unknown error",
            });
          }

          stats.processed++;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : "Unknown error";
          await this.handleSyncFailure(item, errorMessage);
          stats.failed++;
          stats.errors.push({
            queueId: item.id,
            error: errorMessage,
          });
          stats.processed++;
        }
      }

      // Get retry items
      const retryItems = await prisma.outboundSyncQueue.findMany({
        where: {
          syncStatus: "FAILED",
          nextRetryAt: {
            lte: new Date(),
          },
          retryCount: {
            lt: 3,
          },
        },
        include: {
          product: true,
        },
      });

      console.log(`Processing ${retryItems.length} retry items`);

      for (const item of retryItems) {
        try {
          // Mark as in progress
          await prisma.outboundSyncQueue.update({
            where: { id: item.id },
            data: { syncStatus: "IN_PROGRESS" },
          });

          let result: SyncResult;

          if (item.targetChannel === "AMAZON") {
            result = await this.syncToAmazon(item);
          } else if (item.targetChannel === "EBAY") {
            result = await this.syncToEbay(item);
          } else if (item.targetChannel === "SHOPIFY") {
            result = await this.syncToShopify(item);
          } else if (item.targetChannel === "WOOCOMMERCE") {
            result = await this.syncToWoocommerce(item);
          } else {
            throw new Error(`Unknown channel: ${item.targetChannel}`);
          }

          if (result.success) {
            await prisma.outboundSyncQueue.update({
              where: { id: item.id },
              data: {
                syncStatus: "SUCCESS",
                syncedAt: new Date(),
              },
            });
            stats.succeeded++;
          } else {
            await this.handleSyncFailure(item, result.error || "Unknown error");
            stats.failed++;
            stats.errors.push({
              queueId: item.id,
              error: result.error || "Unknown error",
            });
          }

          stats.processed++;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : "Unknown error";
          await this.handleSyncFailure(item, errorMessage);
          stats.failed++;
          stats.errors.push({
            queueId: item.id,
            error: errorMessage,
          });
          stats.processed++;
        }
      }

      return stats;
    } catch (error) {
      console.error("Error processing pending syncs:", error);
      throw error;
    }
  }

  /**
   * Sync product to Amazon using SP-API.
   * PATCH /listings/2021-08-01/items/{sellerId}/{sku}
   *
   * C.8 — replaced the Math.random demo simulator with a real PATCH
   * call routed through amazonSpApiClient.submitListingPayload, gated
   * by the same NEXUS_ENABLE_AMAZON_PUBLISH flag + AMAZON_PUBLISH_MODE
   * resolver as the wizard publish path (C.6). Default state: gated
   * outcome, queue row fails honestly. Set the flag + mode on Railway
   * to enable real updates.
   */
  private async syncToAmazon(queueItem: any): Promise<SyncResult> {
    const { product, payload, id: queueId } = queueItem;
    const sku = product?.sku ?? queueItem.externalListingId ?? "(unknown sku)";
    const marketplaceId =
      payload?.marketplaceId ?? process.env.AMAZON_DEFAULT_MARKETPLACE ?? "IT";
    const sellerId =
      process.env.AMAZON_SELLER_ID ?? process.env.AMAZON_MERCHANT_ID ?? "";

    const amazonPayload = this.constructAmazonPayload(payload);
    const digest = digestPayload(amazonPayload);

    const fail = (
      outcome: "gated" | "rate-limited" | "circuit-open" | "failed" | "timeout",
      mode: "gated" | "dry-run" | "sandbox" | "live",
      message: string,
      durationMs?: number,
    ): SyncResult => {
      writeAttemptLog({
        channel: "AMAZON",
        marketplace: marketplaceId,
        sellerId: sellerId || "(unset)",
        sku,
        productId: product?.id ?? null,
        mode,
        outcome,
        payloadDigest: digest,
        errorMessage: message,
        durationMs: durationMs ?? null,
      });
      return {
        success: false,
        queueId,
        channel: "AMAZON",
        status: "FAILED",
        message: `Failed to sync to Amazon`,
        error: message,
      };
    };

    // 1. Feature flag (resolved as 'gated' mode)
    const mode = getAmazonPublishMode();
    if (mode === "gated") {
      return fail(
        "gated",
        "gated",
        "NEXUS_ENABLE_AMAZON_PUBLISH=false — set true to enable Amazon outbound sync.",
      );
    }
    if (!sellerId) {
      return fail(
        "failed",
        mode,
        "AMAZON_SELLER_ID is not configured. Set the env var before enabling outbound sync.",
      );
    }

    // 2. Circuit breaker
    const circuit = checkAmazonCircuit(sellerId, marketplaceId);
    if (!circuit.ok) {
      return fail("circuit-open", mode, circuit.error ?? "Circuit open");
    }

    // 3. Rate limiter
    const t0 = Date.now();
    const acquired = await acquireAmazonPublishToken(sellerId, marketplaceId);
    if (!acquired.ok) {
      return fail(
        "rate-limited",
        mode,
        acquired.error ?? "Rate limited",
        Date.now() - t0,
      );
    }

    // 4. Dry-run short-circuit. We log + audit + return synthetic
    // success so the queue row's `syncStatus` flips to SUCCESS for
    // the operator's downstream view; no HTTP. The 'mode'='dry-run'
    // audit row is the source of truth that no real call occurred.
    if (mode === "dry-run") {
      console.log(`[AMAZON] Dry-run sync for ${sku}:`, amazonPayload);
      recordAmazonOutcome(sellerId, marketplaceId, true);
      writeAttemptLog({
        channel: "AMAZON",
        marketplace: marketplaceId,
        sellerId,
        sku,
        productId: product?.id ?? null,
        mode: "dry-run",
        outcome: "success",
        payloadDigest: digest,
        durationMs: Date.now() - t0,
      });
      return {
        success: true,
        queueId,
        channel: "AMAZON",
        status: "SUCCESS",
        message: `Product ${sku} dry-run synced to Amazon`,
      };
    }

    // 5. Real call. The client picks live vs sandbox host based on
    // AMAZON_PUBLISH_MODE inside its own logic. submitListingPayload
    // expects the JSON-Patch-style body that constructAmazonPayload
    // already produces.
    let result: Awaited<ReturnType<typeof amazonSpApiClient.submitListingPayload>>;
    try {
      result = await amazonSpApiClient.submitListingPayload({
        sellerId,
        sku,
        payload: amazonPayload,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      recordAmazonOutcome(sellerId, marketplaceId, false);
      return fail("timeout", mode, message, Date.now() - t0);
    }

    const succeeded = result.success;
    recordAmazonOutcome(sellerId, marketplaceId, succeeded);
    writeAttemptLog({
      channel: "AMAZON",
      marketplace: marketplaceId,
      sellerId,
      sku,
      productId: product?.id ?? null,
      mode,
      outcome: succeeded ? "success" : "failed",
      payloadDigest: digest,
      errorMessage: result.error ?? null,
      durationMs: Date.now() - t0,
    });

    if (!succeeded) {
      return {
        success: false,
        queueId,
        channel: "AMAZON",
        status: "FAILED",
        message: `Failed to sync to Amazon`,
        error: result.error ?? "Unknown SP-API error",
      };
    }
    return {
      success: true,
      queueId,
      channel: "AMAZON",
      status: "SUCCESS",
      message: `Product ${sku} synced to Amazon`,
    };
  }

  /**
   * Sync product to eBay using Inventory API.
   * PUT /sell/inventory/v1/inventory_item/{sku}
   *
   * C.8 — replaced the Math.random demo simulator with a real PUT
   * call gated by NEXUS_ENABLE_EBAY_PUBLISH + EBAY_PUBLISH_MODE
   * (same flags as the wizard publish path, C.7).
   */
  private async syncToEbay(queueItem: any): Promise<SyncResult> {
    const { product, payload, id: queueId } = queueItem;
    const sku = product?.sku ?? queueItem.externalListingId ?? "(unknown sku)";
    const marketplaceId = payload?.marketplaceId ?? "EBAY_IT";

    const ebayPayload = this.constructEbayPayload(payload);
    const digest = digestPayload(ebayPayload);

    const fail = (
      outcome: "gated" | "rate-limited" | "circuit-open" | "failed" | "timeout",
      mode: "gated" | "dry-run" | "sandbox" | "live",
      sellerId: string,
      message: string,
      durationMs?: number,
    ): SyncResult => {
      writeAttemptLog({
        channel: "EBAY",
        marketplace: marketplaceId,
        sellerId,
        sku,
        productId: product?.id ?? null,
        mode,
        outcome,
        payloadDigest: digest,
        errorMessage: message,
        durationMs: durationMs ?? null,
      });
      return {
        success: false,
        queueId,
        channel: "EBAY",
        status: "FAILED",
        message: `Failed to sync to eBay`,
        error: message,
      };
    };

    // 1. Feature flag
    const mode = getEbayPublishMode();
    if (mode === "gated") {
      return fail(
        "gated",
        "gated",
        marketplaceId, // pre-connection-lookup placeholder
        "NEXUS_ENABLE_EBAY_PUBLISH=false — set true to enable eBay outbound sync.",
      );
    }

    // 2. Connection lookup (post-gate so a gated attempt is side-effect-free)
    const connection = await prisma.channelConnection.findFirst({
      where: { channelType: "EBAY", isActive: true },
      orderBy: { updatedAt: "desc" },
    });
    if (!connection) {
      return fail(
        "failed",
        mode,
        "(no-connection)",
        "No active eBay connection — link an eBay account in Settings first.",
      );
    }

    // 3. Circuit breaker
    const circuit = checkEbayCircuit(connection.id, marketplaceId);
    if (!circuit.ok) {
      return fail(
        "circuit-open",
        mode,
        connection.id,
        circuit.error ?? "Circuit open",
      );
    }

    // 4. Rate limiter
    const t0 = Date.now();
    const acquired = await acquireEbayPublishToken(connection.id, marketplaceId);
    if (!acquired.ok) {
      return fail(
        "rate-limited",
        mode,
        connection.id,
        acquired.error ?? "Rate limited",
        Date.now() - t0,
      );
    }

    // 5. Dry-run short-circuit
    if (mode === "dry-run") {
      console.log(`[EBAY] Dry-run sync for ${sku}:`, ebayPayload);
      recordEbayOutcome(connection.id, marketplaceId, true);
      writeAttemptLog({
        channel: "EBAY",
        marketplace: marketplaceId,
        sellerId: connection.id,
        sku,
        productId: product?.id ?? null,
        mode: "dry-run",
        outcome: "success",
        payloadDigest: digest,
        durationMs: Date.now() - t0,
      });
      return {
        success: true,
        queueId,
        channel: "EBAY",
        status: "SUCCESS",
        message: `Product ${sku} dry-run synced to eBay`,
      };
    }

    // 6. Auth (token fetch has a side effect — lastUsedAt update — so
    // it lives after the dry-run short-circuit)
    let token: string;
    try {
      token = await ebayAuthService.getValidToken(connection.id);
    } catch (err) {
      const message = `Could not obtain eBay token: ${
        err instanceof Error ? err.message : String(err)
      }`;
      recordEbayOutcome(connection.id, marketplaceId, false);
      return fail("failed", mode, connection.id, message, Date.now() - t0);
    }

    // 7. Real PUT to inventory_item endpoint. createOrReplaceInventoryItem
    // accepts the same body shape we use for first-time publish; it
    // upserts so partial updates (price, quantity) merge with whatever
    // eBay already has on file.
    const apiBase = getEbayApiBaseForMode(mode);
    const url = `${apiBase}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Content-Language": "en-US",
          Accept: "application/json",
        },
        body: JSON.stringify(ebayPayload),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      recordEbayOutcome(connection.id, marketplaceId, false);
      return fail("timeout", mode, connection.id, message, Date.now() - t0);
    }

    const succeeded = response.ok || response.status === 204;
    let errorBody: string | null = null;
    if (!succeeded) {
      errorBody = await response.text().catch(() => "");
    }
    recordEbayOutcome(connection.id, marketplaceId, succeeded);
    writeAttemptLog({
      channel: "EBAY",
      marketplace: marketplaceId,
      sellerId: connection.id,
      sku,
      productId: product?.id ?? null,
      mode,
      outcome: succeeded ? "success" : "failed",
      payloadDigest: digest,
      errorMessage: succeeded
        ? null
        : `createOrReplaceInventoryItem ${response.status}: ${(errorBody ?? "").slice(0, 500)}`,
      durationMs: Date.now() - t0,
    });

    if (!succeeded) {
      return {
        success: false,
        queueId,
        channel: "EBAY",
        status: "FAILED",
        message: `Failed to sync to eBay`,
        error: `createOrReplaceInventoryItem ${response.status}: ${(errorBody ?? "").slice(0, 500)}`,
      };
    }
    return {
      success: true,
      queueId,
      channel: "EBAY",
      status: "SUCCESS",
      message: `Product ${sku} synced to eBay`,
    };
  }

  /**
   * Sync product to Shopify.
   *
   * C.8 — replaced the Math.random demo simulator with an honest
   * NOT_IMPLEMENTED gate. Real wiring lands in Wave 6 / C.18 once
   * the /listings/shopify Path-A overlay is shipped. Until then
   * every queued Shopify sync returns a clear "not yet wired"
   * failure instead of phantom 90% success — so master/channel
   * drift never gets papered over by a fake green tick.
   */
  private async syncToShopify(queueItem: any): Promise<SyncResult> {
    const { product, payload, id: queueId } = queueItem;
    const sku = product?.sku ?? queueItem.externalListingId ?? "(unknown sku)";
    const shopifyPayload = this.constructShopifyPayload(payload);
    writeAttemptLog({
      channel: "SHOPIFY",
      marketplace: "GLOBAL",
      sellerId: process.env.SHOPIFY_SHOP_NAME ?? "(unset)",
      sku,
      productId: product?.id ?? null,
      mode: "gated",
      outcome: "gated",
      payload: shopifyPayload,
      errorMessage:
        "Shopify outbound sync not yet wired — see roadmap C.18 (Wave 6 Path A).",
    });
    return {
      success: false,
      queueId,
      channel: "SHOPIFY",
      status: "FAILED",
      message: `Failed to sync to Shopify`,
      error:
        "Shopify outbound sync not yet wired — see roadmap C.18 (Wave 6 Path A).",
    };
  }

  /**
   * Sync product to WooCommerce.
   *
   * C.8 — same shape as syncToShopify: honest NOT_IMPLEMENTED gate
   * until Wave 6 / C.19 wires the real REST adapter.
   */
  private async syncToWoocommerce(queueItem: any): Promise<SyncResult> {
    const { product, payload, id: queueId } = queueItem;
    const sku = product?.sku ?? queueItem.externalListingId ?? "(unknown sku)";
    const wooPayload = this.constructWoocommercePayload(payload);
    writeAttemptLog({
      channel: "WOOCOMMERCE",
      marketplace: "GLOBAL",
      sellerId: process.env.WOOCOMMERCE_STORE_URL ?? "(unset)",
      sku,
      productId: product?.id ?? null,
      mode: "gated",
      outcome: "gated",
      payload: wooPayload,
      errorMessage:
        "WooCommerce outbound sync not yet wired — see roadmap C.19 (Wave 6 Path A).",
    });
    return {
      success: false,
      queueId,
      channel: "WOOCOMMERCE",
      status: "FAILED",
      message: `Failed to sync to WooCommerce`,
      error:
        "WooCommerce outbound sync not yet wired — see roadmap C.19 (Wave 6 Path A).",
    };
  }

  /**
   * Handle sync failure with retry logic
   */
  private async handleSyncFailure(queueItem: any, errorMessage: string): Promise<void> {
    const newRetryCount = queueItem.retryCount + 1;
    const maxRetries = queueItem.maxRetries || 3;

    if (newRetryCount >= maxRetries) {
      // Max retries exceeded, mark as failed
      await prisma.outboundSyncQueue.update({
        where: { id: queueItem.id },
        data: {
          syncStatus: "FAILED",
          errorMessage,
          errorCode: "MAX_RETRIES_EXCEEDED",
          retryCount: newRetryCount,
        },
      });
    } else {
      // Schedule retry with exponential backoff
      const backoffMs = Math.pow(2, newRetryCount) * 1000; // 2s, 4s, 8s
      const nextRetryAt = new Date(Date.now() + backoffMs);

      await prisma.outboundSyncQueue.update({
        where: { id: queueItem.id },
        data: {
          syncStatus: "FAILED",
          errorMessage,
          errorCode: "RETRY_SCHEDULED",
          retryCount: newRetryCount,
          nextRetryAt,
        },
      });
    }
  }

  /**
   * Construct Amazon SP-API payload
   * PATCH /listings/2021-08-01/items/{sellerId}/{sku}
   */
  private constructAmazonPayload(payload: SyncPayload): Record<string, any> {
    const amazonPayload: Record<string, any> = {
      attributes: {},
    };

    if (payload.price !== undefined) {
      amazonPayload.attributes.price = [
        {
          value: payload.price,
          marketplaceId: "ATVPDKIKX0DER", // US marketplace
        },
      ];
    }

    if (payload.quantity !== undefined) {
      amazonPayload.attributes.fulfillmentAvailability = [
        {
          fulfillmentChannelCode: "DEFAULT",
          quantity: payload.quantity,
        },
      ];
    }

    if (payload.title) {
      amazonPayload.attributes.title = [{ value: payload.title }];
    }

    if (payload.description) {
      amazonPayload.attributes.description = [{ value: payload.description }];
    }

    if (payload.categoryAttributes) {
      // Merge category-specific attributes
      Object.entries(payload.categoryAttributes).forEach(([key, value]) => {
        amazonPayload.attributes[key] = [{ value }];
      });
    }

    return amazonPayload;
  }

  /**
   * Construct eBay Inventory API payload
   * PUT /sell/inventory/v1/inventory_item/{sku}
   */
  private constructEbayPayload(payload: SyncPayload): Record<string, any> {
    const ebayPayload: Record<string, any> = {};

    if (payload.quantity !== undefined) {
      ebayPayload.availability = {
        availableQuantity: payload.quantity,
      };
    }

    if (payload.price !== undefined) {
      ebayPayload.price = {
        value: payload.price.toString(),
        currency: "USD",
      };
    }

    if (payload.title) {
      ebayPayload.title = payload.title;
    }

    if (payload.description) {
      ebayPayload.description = payload.description;
    }

    if (payload.images && payload.images.length > 0) {
      ebayPayload.images = payload.images.map((url) => ({
        imageUrl: url,
      }));
    }

    return ebayPayload;
  }

  /**
   * Construct Shopify payload
   */
  private constructShopifyPayload(payload: SyncPayload): Record<string, any> {
    const shopifyPayload: Record<string, any> = {
      product: {},
    };

    if (payload.title) {
      shopifyPayload.product.title = payload.title;
    }

    if (payload.description) {
      shopifyPayload.product.body_html = payload.description;
    }

    if (payload.price !== undefined || payload.quantity !== undefined) {
      shopifyPayload.product.variants = [
        {
          price: payload.price,
          inventory_quantity: payload.quantity,
        },
      ];
    }

    return shopifyPayload;
  }

  /**
   * Construct WooCommerce payload
   */
  private constructWoocommercePayload(payload: SyncPayload): Record<string, any> {
    const wooPayload: Record<string, any> = {};

    if (payload.title) {
      wooPayload.name = payload.title;
    }

    if (payload.description) {
      wooPayload.description = payload.description;
    }

    if (payload.price !== undefined) {
      wooPayload.regular_price = payload.price.toString();
    }

    if (payload.quantity !== undefined) {
      wooPayload.stock_quantity = payload.quantity;
    }

    if (payload.images && payload.images.length > 0) {
      wooPayload.images = payload.images.map((url) => ({
        src: url,
      }));
    }

    return wooPayload;
  }

  /**
   * Get external listing ID from product based on channel
   */
  private getExternalListingId(
    product: any,
    channel: "AMAZON" | "EBAY" | "SHOPIFY" | "WOOCOMMERCE"
  ): string | null {
    switch (channel) {
      case "AMAZON":
        return product.amazonAsin || null;
      case "EBAY":
        return product.ebayItemId || null;
      case "SHOPIFY":
        return product.shopifyProductId || null;
      case "WOOCOMMERCE":
        return product.woocommerceProductId || null;
      default:
        return null;
    }
  }

  /**
   * Get queue status
   */
  async getQueueStatus(
    filters?: {
      status?: string;
      channel?: string;
      productId?: string;
    }
  ): Promise<any[]> {
    const where: any = {};

    if (filters?.status) {
      where.syncStatus = filters.status;
    }

    if (filters?.channel) {
      where.targetChannel = filters.channel;
    }

    if (filters?.productId) {
      where.productId = filters.productId;
    }

    return prisma.outboundSyncQueue.findMany({
      where,
      include: {
        product: {
          select: {
            id: true,
            sku: true,
            name: true,
            basePrice: true,
            totalStock: true,
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });
  }

  /**
   * Retry a specific queue item
   */
  async retryQueueItem(queueId: string): Promise<QueueResult> {
    try {
      const queueItem = await prisma.outboundSyncQueue.findUnique({
        where: { id: queueId },
      });

      if (!queueItem) {
        return {
          success: false,
          message: `Queue item ${queueId} not found`,
        };
      }

      // Reset for retry
      await prisma.outboundSyncQueue.update({
        where: { id: queueId },
        data: {
          syncStatus: "PENDING",
          retryCount: 0,
          errorMessage: null,
          errorCode: null,
          nextRetryAt: null,
        },
      });

      return {
        success: true,
        queueId,
        message: `Queue item reset for retry`,
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to retry queue item: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  }

  /**
   * Get sync statistics
   */
  getStats() {
    return this.stats;
  }

  /**
   * Reset statistics
   */
  resetStats() {
    this.stats = {
      queued: 0,
      processed: 0,
      succeeded: 0,
      failed: 0,
    };
  }
}

export default new OutboundSyncService();
