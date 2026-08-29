/**
 * Webhook Infrastructure
 * Handles webhook signature validation and processing for all marketplaces
 */

import crypto from "crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { MarketplaceChannel, WebhookSignatureValidation } from "../types/marketplace.js";

/**
 * CX.0 (S9) — raw-body capture for signature verification.
 *
 * Every channel signs the exact bytes it sent. Fastify's default JSON parser
 * discards those bytes, and re-serialising `request.body` changes float
 * formatting, unicode escapes and key order — so a legitimate signature can
 * fail and an operator is tempted to disable verification. Receiver plugins
 * call `registerRawJsonParser(app)` once; Fastify encapsulation scopes the
 * parser to that plugin's routes only, so the rest of the API is untouched.
 */
export type RawBodyRequest = FastifyRequest & { rawBody?: Buffer };

export function registerRawJsonParser(app: FastifyInstance): void {
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (req, buf: Buffer, done) => {
      (req as RawBodyRequest).rawBody = buf;
      if (buf.length === 0) return done(null, undefined);
      try {
        done(null, JSON.parse(buf.toString("utf8")));
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        (e as Error & { statusCode?: number }).statusCode = 400;
        done(e, undefined);
      }
    }
  );
}

/** Constant-time equality for two base64 digests (length checked first). */
function base64Equal(a: string, b: string): boolean {
  const ab = Buffer.from(a, "base64");
  const bb = Buffer.from(b, "base64");
  if (ab.length === 0 || ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * Webhook signature validators for different marketplaces
 */
export class WebhookValidator {
  /**
   * Validate Shopify webhook signature: base64 HMAC-SHA256 over the RAW body
   * with the app secret, compared in constant time.
   * (WooCommerce/Etsy validators removed in CX.0 — Woo is out of scope; Etsy's
   * real order webhooks use the Standard-Webhooks scheme and land in CX.6.)
   */
  static validateShopifySignature(
    body: Buffer | string | undefined,
    hmacHeader: string | undefined,
    secret: string
  ): WebhookSignatureValidation {
    try {
      if (!body || !hmacHeader || !secret) {
        return { isValid: false, error: "Missing Shopify webhook signature, body or secret" };
      }
      const hash = crypto.createHmac("sha256", secret).update(body).digest("base64");
      const isValid = base64Equal(hash, hmacHeader);
      return {
        isValid,
        error: isValid ? undefined : "Invalid Shopify webhook signature",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        isValid: false,
        error: `Shopify signature validation failed: ${message}`,
      };
    }
  }

  /**
   * Validate webhook signature based on marketplace channel
   */
  static validateSignature(
    channel: MarketplaceChannel,
    body: Buffer | string,
    signatureHeader: string,
    secret: string
  ): WebhookSignatureValidation {
    switch (channel) {
      case "SHOPIFY":
        return this.validateShopifySignature(body, signatureHeader, secret);
      default:
        return {
          isValid: false,
          error: `No webhook signature validator for channel: ${channel}`,
        };
    }
  }
}

/**
 * Webhook event processor
 */
export class WebhookProcessor {
  /**
   * Extract event type from webhook payload based on marketplace
   */
  static getEventType(channel: MarketplaceChannel, payload: any): string {
    switch (channel) {
      case "SHOPIFY":
        // Shopify sends event type in X-Shopify-Topic header, but we can infer from payload
        return payload.id ? "shopify/event" : "unknown";

      case "WOOCOMMERCE":
        // WooCommerce sends event type in X-WC-Webhook-Topic header
        return payload.action || "woocommerce/event";

      case "ETSY":
        // Etsy sends event type in X-Etsy-Event-Type header
        return payload.type || "etsy/event";

      default:
        return "unknown";
    }
  }

  /**
   * Extract unique identifier from webhook payload for idempotency
   */
  static getExternalId(channel: MarketplaceChannel, payload: any): string {
    switch (channel) {
      case "SHOPIFY":
        return payload.id?.toString() || "";

      case "WOOCOMMERCE":
        return payload.id?.toString() || "";

      case "ETSY":
        return payload.listing_id?.toString() || payload.receipt_id?.toString() || "";

      default:
        return "";
    }
  }

  /**
   * Check if webhook has already been processed (idempotency)
   */
  static async isWebhookProcessed(
    channel: MarketplaceChannel,
    externalId: string,
    db: any
  ): Promise<boolean> {
    try {
      const event = await db.webhookEvent.findUnique({
        where: {
          channel_externalId: {
            channel,
            externalId,
          },
        },
      });

      return event?.isProcessed || false;
    } catch (error) {
      console.error("[WebhookProcessor] Error checking webhook status:", error);
      return false;
    }
  }

  /**
   * Mark webhook as processed.
   *
   * RT.1 added the optional eventType + payload params so push-health
   * and the /sync-logs/webhooks viewer (RT.4) can show meaningful
   * topic names instead of "unknown" placeholders. Existing 3-arg call
   * sites keep working unchanged.
   *
   * RT.3 added providerTimestamp so /api/admin/push-latency can chart
   * end-to-end latency per source. For Shopify the value comes from
   * the X-Shopify-Triggered-At request header (RFC3339 UTC string).
   */
  static async markWebhookProcessed(
    channel: MarketplaceChannel,
    externalId: string,
    db: any,
    error?: string,
    eventType?: string,
    payload?: unknown,
    providerTimestamp?: Date | null,
  ): Promise<void> {
    try {
      await db.webhookEvent.upsert({
        where: {
          channel_externalId: {
            channel,
            externalId,
          },
        },
        create: {
          channel,
          externalId,
          eventType: eventType ?? "unknown",
          payload: (payload as any) ?? {},
          isProcessed: !error,
          processedAt: !error ? new Date() : undefined,
          error,
          providerTimestamp: providerTimestamp ?? undefined,
        },
        update: {
          isProcessed: !error,
          processedAt: !error ? new Date() : undefined,
          error,
          // Only overwrite eventType/payload if the caller supplied them
          // — keeps the record meaningful when a retry comes through a
          // path that didn't pass the topic.
          ...(eventType ? { eventType } : {}),
          ...(payload !== undefined ? { payload: payload as any } : {}),
          ...(providerTimestamp ? { providerTimestamp } : {}),
        },
      });
    } catch (err) {
      console.error("[WebhookProcessor] Error marking webhook processed:", err);
    }
  }
}

/**
 * Webhook signature generator (for testing)
 */
export class WebhookSignatureGenerator {
  /**
   * Generate Shopify webhook signature
   */
  static generateShopifySignature(body: string, secret: string): string {
    return crypto.createHmac("sha256", secret).update(body, "utf8").digest("base64");
  }

  /**
   * Generate WooCommerce webhook signature
   */
  static generateWooCommerceSignature(body: string, secret: string): string {
    return crypto.createHmac("sha256", secret).update(body, "utf8").digest("base64");
  }

  /**
   * Generate Etsy webhook signature
   */
  static generateEtsySignature(body: string, secret: string): string {
    return crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex");
  }

  /**
   * Generate signature based on marketplace channel
   */
  static generateSignature(channel: MarketplaceChannel, body: string, secret: string): string {
    switch (channel) {
      case "SHOPIFY":
        return this.generateShopifySignature(body, secret);
      case "WOOCOMMERCE":
        return this.generateWooCommerceSignature(body, secret);
      case "ETSY":
        return this.generateEtsySignature(body, secret);
      default:
        throw new Error(`Unknown marketplace channel: ${channel}`);
    }
  }
}
