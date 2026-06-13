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
  acquireShopifyPublishToken,
  checkShopifyCircuit,
  recordShopifyOutcome,
} from "./shopify-publish-gate.service.js";
import {
  digestPayload,
  writeAttemptLog,
} from "./channel-publish-audit.service.js";
import { ebayAuthService } from "./ebay-auth.service.js";
import { listingPublishService } from "./listing-publish.service.js";

// Advertising mutations (bids/budgets/state) ride the same OutboundSyncQueue
// table but are owned exclusively by the dedicated ads-sync worker
// (ads-sync.worker.ts → dispatchToAmazon, gated by checkAdsWriteGate). This
// generic listings processor must NOT pick them up — routing an AD_BID_UPDATE
// through syncToAmazon (the listings PATCH path) fails it at the listings
// publish gate and starves the real ads dispatcher. Exclude them from both the
// pending and retry selections.
const AD_SYNC_TYPES = [
  "AD_BID_UPDATE",
  "AD_BUDGET_UPDATE",
  "AD_ENTITY_STATE_UPDATE",
  "AD_BIDDING_STRATEGY_UPDATE",
] as const;

// ── eBay payload helpers (Phase 0.1) ───────────────────────────────────────
// On eBay, price lives on the OFFER and quantity on the inventory_item — two
// different endpoints — and createOrReplaceInventoryItem REPLACES the whole
// item, so we GET-merge-PUT to avoid wiping listing content. The prior single
// inventory_item PUT put price on the item, used the wrong qty key, and
// hardcoded USD, so master price/stock changes silently never reached eBay.

export function ebayCurrencyForMarket(marketplaceId: string | undefined): string {
  return marketplaceId === "EBAY_GB" ? "GBP" : "EUR";
}

/** Merge quantity/content into an existing inventory_item so the createOrReplace
 *  PUT doesn't drop the rest of the listing. */
export function mergeEbayInventoryItem(
  existing: Record<string, any>,
  payload: { quantity?: number; title?: string; description?: string; images?: string[] },
): Record<string, any> {
  const merged: Record<string, any> = { ...existing };
  if (payload.quantity !== undefined) {
    merged.availability = {
      ...(existing.availability ?? {}),
      shipToLocationAvailability: { quantity: payload.quantity },
    };
  }
  if (payload.title || payload.description || (payload.images && payload.images.length > 0)) {
    merged.product = { ...(existing.product ?? {}) };
    if (payload.title) merged.product.title = payload.title;
    if (payload.description) merged.product.description = payload.description;
    if (payload.images && payload.images.length > 0) merged.product.imageUrls = payload.images;
  }
  return merged;
}

/** Update an existing offer's price, preserving its other fields. */
export function buildEbayOfferUpdate(
  existingOffer: Record<string, any>,
  price: number,
  currency: string,
): Record<string, any> {
  return {
    ...existingOffer,
    pricingSummary: { price: { value: price.toFixed(2), currency } },
  };
}

// Amazon EU marketplace IDs (Phase 0.2). The price PATCH was hardcoded to the
// US marketplace (ATVPDKIKX0DER) for an Amazon-IT seller; resolve the listing's
// real marketplace, defaulting to IT (the primary market) — never US.
const AMAZON_MARKETPLACE_IDS: Record<string, string> = {
  IT: "APJ6JRA9NG5V4", DE: "A1PA6795UKMFR9", FR: "A13V1IB3VIYZZH", ES: "A1RKKUPIHCS9HS",
  NL: "A1805IZSGTT6HS", SE: "A2NODRKZP88ZB9", PL: "A1C3SOZRARQ6R3", BE: "AMEN7PMS3EDWL",
  IE: "A28R8C7NBKEWEA", UK: "A1F83G8C2ARO7P", GB: "A1F83G8C2ARO7P", US: "ATVPDKIKX0DER",
};

export function resolveAmazonMarketplaceId(mp: string | undefined): string {
  if (!mp) return AMAZON_MARKETPLACE_IDS.IT;
  if (/^A[A-Z0-9]{9,}$/.test(mp)) return mp; // already a full Amazon marketplace id
  return AMAZON_MARKETPLACE_IDS[mp.toUpperCase()] ?? AMAZON_MARKETPLACE_IDS.IT;
}

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

  /** A2.1 — route one queue item to the right channel sync method. */
  private async dispatchSync(item: any): Promise<SyncResult> {
    switch (item.targetChannel) {
      case "AMAZON": return this.syncToAmazon(item);
      case "EBAY": return this.syncToEbay(item);
      case "SHOPIFY": return this.syncToShopify(item);
      case "WOOCOMMERCE": return this.syncToWoocommerce(item);
      default: throw new Error(`Unknown channel: ${item.targetChannel}`);
    }
  }

  /**
   * A2.1 — process exactly ONE queue row (the row a BullMQ job owns) instead of
   * draining the whole table. Guards (PENDING / not CANCELLED / past holdUntil),
   * marks IN_PROGRESS, dispatches, and returns the result. The caller owns the
   * final status write (the BullMQ worker's per-job update), so this never
   * touches any other row.
   */
  async processSingle(queueId: string): Promise<SyncResult> {
    const item = await prisma.outboundSyncQueue.findUnique({
      where: { id: queueId },
      include: { product: true },
    });
    if (!item) {
      return { success: false, queueId, channel: "UNKNOWN", status: "FAILED", message: `Queue row ${queueId} not found`, error: "queue-row-not-found" };
    }
    if ((item.syncStatus as any) === "CANCELLED") {
      return { success: false, queueId, channel: item.targetChannel, status: "SKIPPED", message: "Cancelled during grace period", error: "cancelled" };
    }
    if (item.syncStatus !== "PENDING") {
      return { success: false, queueId, channel: item.targetChannel, status: "SKIPPED", message: `Not PENDING (${item.syncStatus})`, error: "not-pending" };
    }
    if (item.holdUntil && item.holdUntil > new Date()) {
      return { success: false, queueId, channel: item.targetChannel, status: "SKIPPED", message: "Still within grace window", error: "held" };
    }
    await prisma.outboundSyncQueue.update({ where: { id: item.id }, data: { syncStatus: "IN_PROGRESS" } });
    try {
      return await this.dispatchSync(item);
    } catch (err) {
      // dispatch threw (e.g. unknown channel) — don't leave the row stuck IN_PROGRESS.
      await prisma.outboundSyncQueue.update({ where: { id: item.id }, data: { syncStatus: "PENDING" } }).catch(() => {});
      throw err;
    }
  }

  /**
   * Process all pending syncs in the queue.
   * A2.3 — `opts.skip` lets the cron act as a BACKSTOP when BullMQ is enabled: it
   * skips rows that already have a live BullMQ job, so the cron only sweeps
   * orphans (rows written without a job, or jobs that died).
   */
  async processPendingSyncs(opts?: { skip?: (queueId: string) => Promise<boolean> }): Promise<ProcessingStats> {
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
          syncType: { notIn: [...AD_SYNC_TYPES] },
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
        if (opts?.skip && (await opts.skip(item.id))) {
          stats.skipped++;
          continue;
        }
        try {
          // Mark as in progress
          await prisma.outboundSyncQueue.update({
            where: { id: item.id },
            data: { syncStatus: "IN_PROGRESS" },
          });

          const result = await this.dispatchSync(item);

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
          syncType: { notIn: [...AD_SYNC_TYPES] },
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
        if (opts?.skip && (await opts.skip(item.id))) {
          stats.skipped++;
          continue;
        }
        try {
          // Mark as in progress
          await prisma.outboundSyncQueue.update({
            where: { id: item.id },
            data: { syncStatus: "IN_PROGRESS" },
          });

          const result = await this.dispatchSync(item);

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

    const amazonPayload = this.constructAmazonPayload(payload, marketplaceId);

    // A1.3 — delegate the gate→circuit→rate-limit→dry-run→audit chain to the
    // shared ListingPublishService; inject Amazon's gate functions + the actual
    // SP-API call. (Behavior-preserving extraction of the former inline chain.)
    const r = await listingPublishService.publish({
      channel: "AMAZON",
      marketplaceId,
      sku,
      productId: product?.id ?? null,
      digest: digestPayload(amazonPayload),
      gate: {
        getMode: getAmazonPublishMode,
        checkCircuit: checkAmazonCircuit,
        acquireToken: acquireAmazonPublishToken,
        recordOutcome: recordAmazonOutcome,
      },
      resolveSeller: async () =>
        sellerId
          ? { id: sellerId }
          : { error: "AMAZON_SELLER_ID is not configured. Set the env var before enabling outbound sync." },
      execute: async ({ sellerId: sid }) => {
        const res = await amazonSpApiClient.submitListingPayload({ sellerId: sid, sku, payload: amazonPayload });
        return { ok: res.success, error: res.error };
      },
    });

    return {
      success: r.success,
      queueId,
      channel: "AMAZON",
      status: r.status,
      message: r.message,
      error: r.error,
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

    const digest = digestPayload({
      price: payload.price,
      quantity: payload.quantity,
      content: !!(payload.title || payload.description || (payload.images && payload.images.length > 0)),
    });

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
      console.log(`[EBAY] Dry-run sync for ${sku}:`, { price: payload.price, quantity: payload.quantity });
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

    // 7. Apply the update. Quantity/content → inventory_item (GET-merge-PUT so
    // the full-replace never wipes existing content); price → the OFFER
    // (different endpoint). Either or both may run depending on the payload.
    const apiBase = getEbayApiBaseForMode(mode);
    const currency = ebayCurrencyForMarket(marketplaceId);
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    };

    const ebayFail = (
      message: string,
      outcome: "failed" | "timeout" = "failed",
    ): SyncResult => {
      recordEbayOutcome(connection.id, marketplaceId, false);
      writeAttemptLog({
        channel: "EBAY",
        marketplace: marketplaceId,
        sellerId: connection.id,
        sku,
        productId: product?.id ?? null,
        mode,
        outcome,
        payloadDigest: digest,
        errorMessage: message.slice(0, 500),
        durationMs: Date.now() - t0,
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

    try {
      // 7a. Quantity (+ any content) → inventory_item.
      const touchesItem =
        payload.quantity !== undefined ||
        !!payload.title ||
        !!payload.description ||
        !!(payload.images && payload.images.length > 0);
      if (touchesItem) {
        const itemUrl = `${apiBase}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`;
        let existing: Record<string, any> = {};
        const getRes = await fetch(itemUrl, { method: "GET", headers });
        if (getRes.ok) existing = (await getRes.json().catch(() => ({}))) as Record<string, any>;
        const putRes = await fetch(itemUrl, {
          method: "PUT",
          headers: { ...headers, "Content-Language": "en-US" },
          body: JSON.stringify(mergeEbayInventoryItem(existing, payload)),
        });
        if (!(putRes.ok || putRes.status === 204)) {
          return ebayFail(`inventory_item PUT ${putRes.status}: ${(await putRes.text().catch(() => "")).slice(0, 300)}`);
        }
      }

      // 7b. Price → offer (resolve the offer by SKU, then PUT its pricingSummary).
      if (payload.price !== undefined) {
        const offersRes = await fetch(
          `${apiBase}/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}`,
          { method: "GET", headers },
        );
        if (!offersRes.ok) {
          return ebayFail(`get offers ${offersRes.status}: ${(await offersRes.text().catch(() => "")).slice(0, 300)}`);
        }
        const offersData = (await offersRes.json().catch(() => ({}))) as {
          offers?: Array<Record<string, any>>;
        };
        const offer = offersData.offers?.[0];
        if (!offer?.offerId) {
          return ebayFail(`No eBay offer for SKU "${sku}" — publish the listing before syncing price.`);
        }
        const offerRes = await fetch(
          `${apiBase}/sell/inventory/v1/offer/${encodeURIComponent(offer.offerId)}`,
          {
            method: "PUT",
            headers: { ...headers, "Content-Language": "en-US" },
            body: JSON.stringify(buildEbayOfferUpdate(offer, payload.price, currency)),
          },
        );
        if (!offerRes.ok) {
          return ebayFail(`offer PUT ${offerRes.status}: ${(await offerRes.text().catch(() => "")).slice(0, 300)}`);
        }
      }
    } catch (err) {
      return ebayFail(err instanceof Error ? err.message : String(err), "timeout");
    }

    recordEbayOutcome(connection.id, marketplaceId, true);
    writeAttemptLog({
      channel: "EBAY",
      marketplace: marketplaceId,
      sellerId: connection.id,
      sku,
      productId: product?.id ?? null,
      mode,
      outcome: "success",
      payloadDigest: digest,
      durationMs: Date.now() - t0,
    });
    return {
      success: true,
      queueId,
      channel: "EBAY",
      status: "SUCCESS",
      message: `Product ${sku} synced to eBay`,
    };
  }

  /**
   * Sync product to Shopify via inventory_levels/set.
   *
   * IS.1 — real implementation that updates the Shopify inventory level
   * for the SKU's inventory_item_id at the configured location. Replaces
   * the NOT_IMPLEMENTED gate from C.8.
   */
  private async syncToShopify(queueItem: any): Promise<SyncResult> {
    const { product, payload, channelListing, id: queueId, syncType } = queueItem;
    const sku = product?.sku ?? queueItem.externalListingId ?? "(unknown sku)";

    const shopName = process.env.SHOPIFY_SHOP_NAME ?? "";
    const accessToken = process.env.SHOPIFY_ACCESS_TOKEN ?? process.env.SHOPIFY_ADMIN_API_TOKEN ?? "";

    if (!shopName || !accessToken) {
      writeAttemptLog({
        channel: "SHOPIFY", marketplace: "GLOBAL", sellerId: shopName || "(unset)",
        sku, productId: product?.id ?? null, mode: "gated", outcome: "gated",
        payloadDigest: digestPayload(payload),
        errorMessage: "SHOPIFY_SHOP_NAME or SHOPIFY_ACCESS_TOKEN not configured.",
      });
      return { success: false, queueId, channel: "SHOPIFY", status: "FAILED",
        message: "Shopify outbound sync not configured",
        error: "SHOPIFY_SHOP_NAME or SHOPIFY_ACCESS_TOKEN env vars missing." };
    }

    // P3.0 — circuit breaker check
    const circuitCheck = checkShopifyCircuit(shopName);
    if (!circuitCheck.ok) {
      return { success: false, queueId, channel: "SHOPIFY", status: "FAILED",
        message: "Shopify circuit open", error: circuitCheck.error };
    }

    // P3.0 — rate limiter
    const tokenResult = await acquireShopifyPublishToken(shopName);
    if (!tokenResult.ok) {
      return { success: false, queueId, channel: "SHOPIFY", status: "FAILED",
        message: "Shopify rate limited", error: tokenResult.error };
    }

    const apiBase = `https://${shopName}.myshopify.com/admin/api/2024-01`;
    const headers = {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json",
      Accept: "application/json",
    };

    // Resolve variant (needed for both price + inventory_item_id for qty)
    let variantId: string | null =
      (channelListing?.platformAttributes as Record<string, any>)?.variantId ?? null;
    let inventoryItemId: string | null =
      (channelListing?.platformAttributes as Record<string, any>)?.inventoryItemId ?? null;

    if (!variantId || !inventoryItemId) {
      const varRes = await fetch(
        `${apiBase}/variants.json?sku=${encodeURIComponent(sku)}&fields=id,inventory_item_id`,
        { headers },
      ).catch(() => null);
      if (varRes?.ok) {
        const varData = await varRes.json().catch(() => null) as {
          variants?: Array<{ id: string; inventory_item_id: string }>
        } | null;
        const v = varData?.variants?.[0];
        if (v) {
          variantId = String(v.id);
          inventoryItemId = String(v.inventory_item_id);
        }
      }
    }

    // ── P3.0 — Price update ──────────────────────────────────────────────
    if (syncType === "PRICE_UPDATE" || payload?.price != null) {
      const newPrice: number | null = payload?.price ?? null;
      if (newPrice == null || !variantId) {
        return { success: false, queueId, channel: "SHOPIFY", status: "FAILED",
          message: `Cannot update Shopify price for SKU ${sku}: missing price or variantId`,
          error: "price or variantId not resolved." };
      }

      const t0 = Date.now();
      const priceStr = Number(newPrice).toFixed(2);
      const priceRes = await fetch(`${apiBase}/variants/${variantId}.json`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ variant: { id: parseInt(variantId, 10), price: priceStr } }),
      }).catch((err: Error) => ({ ok: false, text: async () => err.message } as any));

      const succeeded = priceRes.ok;
      const errBody = succeeded ? null : await priceRes.text().catch(() => "");

      writeAttemptLog({
        channel: "SHOPIFY", marketplace: "GLOBAL", sellerId: shopName,
        sku, productId: product?.id ?? null, mode: "live",
        outcome: succeeded ? "success" : "failed",
        payloadDigest: digestPayload(payload),
        errorMessage: succeeded ? null : `variants PUT ${priceRes.status}: ${(errBody ?? "").slice(0, 300)}`,
        durationMs: Date.now() - t0,
      });

      recordShopifyOutcome(shopName, succeeded, succeeded ? undefined : `variants PUT ${priceRes.status}`);

      if (!succeeded) {
        return { success: false, queueId, channel: "SHOPIFY", status: "FAILED",
          message: "Failed to update Shopify variant price",
          error: `variants PUT ${priceRes.status}: ${(errBody ?? "").slice(0, 300)}` };
      }

      return { success: true, queueId, channel: "SHOPIFY", status: "SUCCESS",
        message: `Shopify price updated: ${sku} → €${priceStr}` };
    }

    // ── Quantity update (existing path) ─────────────────────────────────
    const newQty: number = payload?.quantity ?? 0;

    if (!inventoryItemId) {
      return { success: false, queueId, channel: "SHOPIFY", status: "FAILED",
        message: `No Shopify inventory_item_id found for SKU ${sku}`,
        error: "inventory_item_id not in ChannelListing and SKU lookup returned nothing." };
    }

    let locationId: string | null = process.env.SHOPIFY_LOCATION_ID ?? null;
    if (!locationId) {
      const locRes = await fetch(`${apiBase}/locations.json?limit=1&fields=id`, { headers }).catch(() => null);
      if (locRes?.ok) {
        const locData = await locRes.json().catch(() => null) as { locations?: Array<{ id: string }> } | null;
        locationId = String(locData?.locations?.[0]?.id ?? "");
      }
    }

    if (!locationId) {
      return { success: false, queueId, channel: "SHOPIFY", status: "FAILED",
        message: "Could not resolve Shopify location ID",
        error: "Set SHOPIFY_LOCATION_ID env var or connect a Shopify location." };
    }

    const t0 = Date.now();
    const setRes = await fetch(`${apiBase}/inventory_levels/set.json`, {
      method: "POST", headers,
      body: JSON.stringify({
        location_id: parseInt(locationId, 10),
        inventory_item_id: parseInt(inventoryItemId, 10),
        available: newQty,
      }),
    }).catch((err: Error) => ({ ok: false, text: async () => err.message } as any));

    const succeeded = setRes.ok;
    const errorBody = succeeded ? null : await setRes.text().catch(() => "");

    writeAttemptLog({
      channel: "SHOPIFY", marketplace: "GLOBAL", sellerId: shopName,
      sku, productId: product?.id ?? null, mode: "live",
      outcome: succeeded ? "success" : "failed",
      payloadDigest: digestPayload(payload),
      errorMessage: succeeded ? null : `inventory_levels/set ${setRes.status}: ${(errorBody ?? "").slice(0, 300)}`,
      durationMs: Date.now() - t0,
    });

    recordShopifyOutcome(shopName, succeeded, succeeded ? undefined : `inventory_levels/set ${setRes.status}`);

    if (!succeeded) {
      return { success: false, queueId, channel: "SHOPIFY", status: "FAILED",
        message: "Failed to update Shopify inventory",
        error: `inventory_levels/set ${setRes.status}: ${(errorBody ?? "").slice(0, 300)}` };
    }

    return { success: true, queueId, channel: "SHOPIFY", status: "SUCCESS",
      message: `Shopify inventory updated: ${sku} → ${newQty} at location ${locationId}` };
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
  private constructAmazonPayload(payload: SyncPayload, marketplaceId?: string): Record<string, any> {
    const amazonPayload: Record<string, any> = {
      attributes: {},
    };

    if (payload.price !== undefined) {
      amazonPayload.attributes.price = [
        {
          value: payload.price,
          // Phase 0.2 — scope to the listing's actual Amazon marketplace
          // (defaults to IT, never the US marketplace it was hardcoded to).
          marketplaceId: resolveAmazonMarketplaceId(marketplaceId),
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
