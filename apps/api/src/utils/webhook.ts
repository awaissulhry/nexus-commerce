/**
 * Webhook Infrastructure — CX.0 shipped 2026-08-29 (this line is the Railway build trigger:
 * turbo-ignore skips empty commits, so the deploy needs a diff under apps/api).
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
 * P2.1 — `WebhookProcessor` was deleted here.
 *
 * Its two methods were the whole of Shopify's idempotency and its whole ledger write,
 * and both were dead in production. Each one called `db.webhookEvent` from a receiver
 * that ran with no business profile, so each threw `Select a business profile` into
 * its own catch block: `isWebhookProcessed` swallowed the throw and returned `false`,
 * so no delivery was ever recognised as a duplicate, and `markWebhookProcessed`
 * swallowed it and returned, so no Shopify event was ever written. The receivers read
 * as if both worked.
 *
 * They are not repaired, because a repair would have restored the second defect the
 * first was hiding: the idempotency key was the RESOURCE id, so the first change to a
 * product would have been handled and every later change to it dropped forever.
 * Shopify now goes through `services/cx/ingress/ledger.ts` with the delivery id from
 * `X-Shopify-Webhook-Id`, inside the workspace its shop routes to.
 */

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
