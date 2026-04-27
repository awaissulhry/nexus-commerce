/**
 * Webhook Infrastructure
 * Handles webhook signature validation and processing for all marketplaces
 */

import crypto from "crypto";
import { MarketplaceChannel, WebhookSignatureValidation } from "../types/marketplace.js";

/**
 * Webhook signature validators for different marketplaces
 */
export class WebhookValidator {
  /**
   * Validate Shopify webhook signature
   * Uses HMAC-SHA256 with the webhook secret
   */
  static validateShopifySignature(
    body: string,
    hmacHeader: string,
    secret: string
  ): WebhookSignatureValidation {
    try {
      const hash = crypto.createHmac("sha256", secret).update(body, "utf8").digest("base64");

      const isValid = hash === hmacHeader;

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
   * Validate WooCommerce webhook signature
   * Uses HMAC-SHA256 with the webhook secret
   */
  static validateWooCommerceSignature(
    body: string,
    signatureHeader: string,
    secret: string
  ): WebhookSignatureValidation {
    try {
      const hash = crypto.createHmac("sha256", secret).update(body, "utf8").digest("base64");

      const isValid = hash === signatureHeader;

      return {
        isValid,
        error: isValid ? undefined : "Invalid WooCommerce webhook signature",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        isValid: false,
        error: `WooCommerce signature validation failed: ${message}`,
      };
    }
  }

  /**
   * Validate Etsy webhook signature
   * Uses HMAC-SHA256 with the webhook secret
   */
  static validateEtsySignature(
    body: string,
    signatureHeader: string,
    secret: string
  ): WebhookSignatureValidation {
    try {
      const hash = crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex");

      const isValid = hash === signatureHeader;

      return {
        isValid,
        error: isValid ? undefined : "Invalid Etsy webhook signature",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        isValid: false,
        error: `Etsy signature validation failed: ${message}`,
      };
    }
  }

  /**
   * Validate webhook signature based on marketplace channel
   */
  static validateSignature(
    channel: MarketplaceChannel,
    body: string,
    signatureHeader: string,
    secret: string
  ): WebhookSignatureValidation {
    switch (channel) {
      case "SHOPIFY":
        return this.validateShopifySignature(body, signatureHeader, secret);
      case "WOOCOMMERCE":
        return this.validateWooCommerceSignature(body, signatureHeader, secret);
      case "ETSY":
        return this.validateEtsySignature(body, signatureHeader, secret);
      default:
        return {
          isValid: false,
          error: `Unknown marketplace channel: ${channel}`,
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
   * Mark webhook as processed
   */
  static async markWebhookProcessed(
    channel: MarketplaceChannel,
    externalId: string,
    db: any,
    error?: string
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
          eventType: "unknown",
          payload: {},
          isProcessed: !error,
          processedAt: !error ? new Date() : undefined,
          error,
        },
        update: {
          isProcessed: !error,
          processedAt: !error ? new Date() : undefined,
          error,
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
