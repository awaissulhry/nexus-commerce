/**
 * Etsy Marketplace Service
 * Handles product listing, inventory, and order operations on Etsy
 */

import { rateLimiter } from "../../utils/rate-limiter.js";
import { MarketplaceSyncError } from "../../utils/error-handler.js";
import type { EtsyConfig } from "../../types/marketplace.js";

// ── Etsy API Response Types ────────────────────────────────────────

interface EtsyListing {
  listing_id: number;
  user_id: number;
  shop_id: number;
  title: string;
  description: string;
  state: string; // active, inactive, sold_out, deactivated, expired, alchemy
  creation_tsz: number;
  ending_tsz: number;
  original_creation_tsz: number;
  last_modified_tsz: number;
  price: string;
  currency_code: string;
  quantity: number;
  sku: string;
  tags: string[];
  category_id: number;
  taxonomy_id: number;
  images: Array<{
    listing_image_id: number;
    hex_code: string;
    red: number;
    green: number;
    blue: number;
    hue: number;
    saturation: number;
    brightness: number;
    is_primary: boolean;
    creation_tsz: number;
    listing_id: number;
    image_name: string;
    rank: number;
    url_75x75: string;
    url_170x135: string;
    url_570xN: string;
  }>;
  variations?: Array<{
    property_id: number;
    property_name: string;
    value_id: number;
    value_name: string;
    scale_id?: number;
    scale_name?: string;
  }>;
  has_variations: boolean;
  should_auto_renew: boolean;
  is_supply: boolean;
  item_weight?: number;
  item_length?: number;
  item_width?: number;
  item_height?: number;
  weight_unit?: string;
  dimension_unit?: string;
  is_personalizable: boolean;
  personalization_is_required: boolean;
  personalization_char_limit_per_field?: number;
  personalization_num_lines?: number;
  non_taxable: boolean;
  shop_section_id?: number;
  processing_min?: number;
  processing_max?: number;
  processing_unit?: string;
}

interface EtsyVariationProperty {
  property_id: number;
  property_name: string;
  display_name: string;
  scale_id?: number;
  scale_name?: string;
  values: Array<{
    value_id: number;
    value_name: string;
  }>;
}

interface EtsyListingVariation {
  listing_id: number;
  variation_id: number;
  quantity: number;
  is_deleted: boolean;
  price?: string;
  sku?: string;
  properties: Array<{
    property_id: number;
    property_name: string;
    value_id: number;
    value_name: string;
    scale_id?: number;
    scale_name?: string;
  }>;
}

interface EtsyReceipt {
  receipt_id: number;
  receipt_type: number;
  seller_user_id: number;
  buyer_user_id: number;
  name: string;
  first_line: string;
  second_line: string;
  city: string;
  state: string;
  zip: string;
  country_id: number;
  country_name: string;
  payment_method: string;
  payment_email: string;
  message_from_buyer: string;
  message_from_seller: string;
  was_paid: boolean;
  was_shipped: boolean;
  was_delivered: boolean;
  was_cancelled: boolean;
  was_refunded: boolean;
  total_tax_cost: string;
  total_price: string;
  total_shipping_cost: string;
  currency_code: string;
  creation_tsz: number;
  last_modified_tsz: number;
  transactions: Array<{
    transaction_id: number;
    listing_id: number;
    receipt_id: number;
    buyer_user_id: number;
    seller_user_id: number;
    sku: string;
    price: string;
    currency_code: string;
    quantity: number;
    creation_tsz: number;
    last_modified_tsz: number;
    variations: Array<{
      property_id: number;
      property_name: string;
      value_id: number;
      value_name: string;
    }>;
  }>;
}

// ── Parent-Child Detection Types ────────────────────────────────────────

export interface EtsyParentChildMapping {
  parentListingId: number;
  parentSku: string;
  parentTitle: string;
  variationTheme: string;
  variations: Array<{
    variationId: number;
    sku: string;
    title: string;
    attributes: Record<string, string>;
    quantity: number;
    price: number;
  }>;
}

export interface EtsyListingSync {
  listingId: number;
  sku: string;
  title: string;
  description: string;
  state: string;
  isParent: boolean;
  parentId?: number;
  variationTheme?: string;
  price: number;
  quantity: number;
  currency: string;
  variations: Array<{
    variationId: number;
    sku: string;
    title: string;
    price: number;
    quantity: number;
    attributes: Record<string, string>;
    image?: {
      id: number;
      url: string;
      alt: string;
    };
  }>;
  images: Array<{
    id: number;
    url: string;
    alt: string;
  }>;
}

export interface EtsyOrderSync {
  orderId: number;
  receiptId: number;
  status: string;
  createdAt: string;
  totalAmount: number;
  totalTax: number;
  totalShipping: number;
  currency: string;
  buyerName: string;
  buyerEmail: string;
  shippingAddress: {
    firstName: string;
    lastName: string;
    address1: string;
    address2?: string;
    city: string;
    state: string;
    zip: string;
    country: string;
  };
  lineItems: Array<{
    transactionId: number;
    listingId: number;
    sku: string;
    quantity: number;
    price: number;
    attributes: Record<string, string>;
  }>;
}

/**
 * Etsy Service
 * Manages API interactions with Etsy REST API
 */
export class EtsyService {
  private baseUrl: string = "https://openapi.etsy.com/v3";
  private accessToken: string;
  private shopId: string;

  constructor(config: EtsyConfig) {
    this.accessToken = config.accessToken;
    this.shopId = config.shopId;

    if (!this.accessToken || !this.shopId) {
      throw new Error(
        "Missing required Etsy configuration: accessToken, shopId"
      );
    }
  }

  /**
   * Make an authenticated request to Etsy API
   */
  private async request<T>(
    method: string,
    endpoint: string,
    body?: unknown
  ): Promise<T> {
    await rateLimiter.consumeToken("ETSY", endpoint);

    const url = `${this.baseUrl}${endpoint}`;

    const options: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
        "x-api-key": this.accessToken,
      },
    };

    if (body) {
      options.body = JSON.stringify(body);
    }

    try {
      const response = await fetch(url, options);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new MarketplaceSyncError(
          "ETSY",
          "VALIDATION",
          `Etsy API error: ${response.status} ${response.statusText}`,
          { endpoint, status: response.status, error: errorData }
        );
      }

      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof MarketplaceSyncError) {
        throw error;
      }
      throw new MarketplaceSyncError(
        "ETSY",
        "NETWORK",
        `Failed to make Etsy API request: ${error instanceof Error ? error.message : String(error)}`,
        { endpoint, method }
      );
    }
  }

  /**
   * Get a single listing with variations
   */
  async getListing(listingId: number): Promise<EtsyListingSync> {
    try {
      const listing = await this.request<EtsyListing>(
        "GET",
        `/shops/${this.shopId}/listings/${listingId}`
      );

      // If it has variations, fetch them
      let variations: EtsyListingVariation[] = [];
      if (listing.has_variations) {
        const variationsResponse = await this.request<{
          results: EtsyListingVariation[];
        }>(
          "GET",
          `/shops/${this.shopId}/listings/${listingId}/variations?limit=100`
        );
        variations = variationsResponse.results;
      }

      return this.mapListingToSync(listing, variations);
    } catch (error) {
      throw new MarketplaceSyncError(
        "ETSY",
        "NOT_FOUND",
        `Failed to fetch listing ${listingId}: ${error instanceof Error ? error.message : String(error)}`,
        { listingId: String(listingId) }
      );
    }
  }

  /**
   * Get all listings with pagination
   */
  async getAllListings(
    limit: number = 100,
    offset: number = 0
  ): Promise<{
    listings: EtsyListingSync[];
    pageInfo: { hasNextPage: boolean; totalCount: number; offset: number };
  }> {
    try {
      const response = await this.request<{
        results: EtsyListing[];
        count: number;
        total: number;
      }>(
        "GET",
        `/shops/${this.shopId}/listings/active?limit=${limit}&offset=${offset}`
      );

      const listings: EtsyListingSync[] = [];

      for (const listing of response.results) {
        let variations: EtsyListingVariation[] = [];
        if (listing.has_variations) {
          const variationsResponse = await this.request<{
            results: EtsyListingVariation[];
          }>(
            "GET",
            `/shops/${this.shopId}/listings/${listing.listing_id}/variations?limit=100`
          );
          variations = variationsResponse.results;
        }
        listings.push(this.mapListingToSync(listing, variations));
      }

      return {
        listings,
        pageInfo: {
          hasNextPage: offset + limit < response.total,
          totalCount: response.total,
          offset,
        },
      };
    } catch (error) {
      throw new MarketplaceSyncError(
        "ETSY",
        "NETWORK",
        `Failed to fetch listings: ${error instanceof Error ? error.message : String(error)}`,
        { limit, offset }
      );
    }
  }

  /**
   * Update listing price
   */
  async updateListingPrice(
    listingId: number,
    price: number
  ): Promise<void> {
    try {
      await this.request(
        "PATCH",
        `/shops/${this.shopId}/listings/${listingId}`,
        {
          price: (price * 100).toFixed(0), // Etsy uses cents
        }
      );
    } catch (error) {
      throw new MarketplaceSyncError(
        "ETSY",
        "VALIDATION",
        `Failed to update listing price: ${error instanceof Error ? error.message : String(error)}`,
        { listingId, price }
      );
    }
  }

  /**
   * Update listing quantity
   */
  async updateListingQuantity(
    listingId: number,
    quantity: number
  ): Promise<void> {
    try {
      await this.request(
        "PATCH",
        `/shops/${this.shopId}/listings/${listingId}`,
        {
          quantity,
        }
      );
    } catch (error) {
      throw new MarketplaceSyncError(
        "ETSY",
        "VALIDATION",
        `Failed to update listing quantity: ${error instanceof Error ? error.message : String(error)}`,
        { listingId, quantity }
      );
    }
  }

  /**
   * Update variation quantity
   */
  async updateVariationQuantity(
    listingId: number,
    variationId: number,
    quantity: number
  ): Promise<void> {
    try {
      await this.request(
        "PATCH",
        `/shops/${this.shopId}/listings/${listingId}/variations/${variationId}`,
        {
          quantity,
        }
      );
    } catch (error) {
      throw new MarketplaceSyncError(
        "ETSY",
        "VALIDATION",
        `Failed to update variation quantity: ${error instanceof Error ? error.message : String(error)}`,
        { listingId, variationId, quantity }
      );
    }
  }

  /**
   * Get all receipts (orders)
   */
  async getReceipts(
    limit: number = 100,
    offset: number = 0
  ): Promise<{
    receipts: EtsyOrderSync[];
    pageInfo: { hasNextPage: boolean; totalCount: number; offset: number };
  }> {
    try {
      const response = await this.request<{
        results: EtsyReceipt[];
        count: number;
        total: number;
      }>(
        "GET",
        `/shops/${this.shopId}/receipts?limit=${limit}&offset=${offset}&was_paid=true`
      );

      const receipts = response.results.map((receipt) =>
        this.mapReceiptToSync(receipt)
      );

      return {
        receipts,
        pageInfo: {
          hasNextPage: offset + limit < response.total,
          totalCount: response.total,
          offset,
        },
      };
    } catch (error) {
      throw new MarketplaceSyncError(
        "ETSY",
        "NETWORK",
        `Failed to fetch receipts: ${error instanceof Error ? error.message : String(error)}`,
        { limit, offset }
      );
    }
  }

  /**
   * Get a single receipt (order)
   */
  async getReceipt(receiptId: number): Promise<EtsyOrderSync> {
    try {
      const receipt = await this.request<EtsyReceipt>(
        "GET",
        `/shops/${this.shopId}/receipts/${receiptId}`
      );

      return this.mapReceiptToSync(receipt);
    } catch (error) {
      throw new MarketplaceSyncError(
        "ETSY",
        "NOT_FOUND",
        `Failed to fetch receipt ${receiptId}: ${error instanceof Error ? error.message : String(error)}`,
        { receiptId: String(receiptId) }
      );
    }
  }

  /**
   * Update receipt status (mark as shipped)
   */
  async updateReceiptStatus(
    receiptId: number,
    wasShipped: boolean,
    trackingNumber?: string
  ): Promise<void> {
    try {
      const body: any = {
        was_shipped: wasShipped,
      };

      if (trackingNumber) {
        body.tracking_code = trackingNumber;
      }

      await this.request(
        "PATCH",
        `/shops/${this.shopId}/receipts/${receiptId}`,
        body
      );
    } catch (error) {
      throw new MarketplaceSyncError(
        "ETSY",
        "VALIDATION",
        `Failed to update receipt status: ${error instanceof Error ? error.message : String(error)}`,
        { receiptId, wasShipped, trackingNumber }
      );
    }
  }

  /**
   * Detect parent-child hierarchy from listing variations
   */
  detectParentChildHierarchy(
    listing: EtsyListing,
    variations: EtsyListingVariation[]
  ): EtsyParentChildMapping | null {
    if (!listing.has_variations || variations.length === 0) {
      return null;
    }

    // Extract variation theme from properties
    const propertyNames = new Set<string>();
    for (const variation of variations) {
      for (const prop of variation.properties) {
        propertyNames.add(prop.property_name);
      }
    }

    const variationTheme = Array.from(propertyNames).sort().join("-");

    // Extract parent SKU (remove variation suffix)
    const parentSku = listing.sku || `ETSY-${listing.listing_id}`;

    return {
      parentListingId: listing.listing_id,
      parentSku,
      parentTitle: listing.title,
      variationTheme,
      variations: variations
        .filter((v) => !v.is_deleted)
        .map((v) => ({
          variationId: v.variation_id,
          sku: v.sku || `${parentSku}-${v.variation_id}`,
          title: this.buildVariationTitle(listing.title, v.properties),
          attributes: this.extractAttributes(v.properties),
          quantity: v.quantity,
          price: v.price ? parseFloat(v.price) : parseFloat(listing.price),
        })),
    };
  }

  /**
   * Build variation title from properties
   */
  private buildVariationTitle(
    baseTitle: string,
    properties: Array<{ property_name: string; value_name: string }>
  ): string {
    const values = properties.map((p) => p.value_name).join(" - ");
    return `${baseTitle} (${values})`;
  }

  /**
   * Extract attributes from variation properties
   */
  private extractAttributes(
    properties: Array<{ property_name: string; value_name: string }>
  ): Record<string, string> {
    const attributes: Record<string, string> = {};
    for (const prop of properties) {
      attributes[prop.property_name] = prop.value_name;
    }
    return attributes;
  }

  /**
   * Map Etsy listing to sync format
   */
  private mapListingToSync(
    listing: EtsyListing,
    variations: EtsyListingVariation[]
  ): EtsyListingSync {
    const isParent = listing.has_variations && variations.length > 0;
    const parentChildMapping = isParent
      ? this.detectParentChildHierarchy(listing, variations)
      : null;

    return {
      listingId: listing.listing_id,
      sku: listing.sku || `ETSY-${listing.listing_id}`,
      title: listing.title,
      description: listing.description,
      state: listing.state,
      isParent,
      parentId: parentChildMapping?.parentListingId,
      variationTheme: parentChildMapping?.variationTheme,
      price: parseFloat(listing.price),
      quantity: listing.quantity,
      currency: listing.currency_code,
      variations: parentChildMapping
        ? parentChildMapping.variations
        : [],
      images: listing.images.map((img) => ({
        id: img.listing_image_id,
        url: img.url_570xN,
        alt: img.image_name,
      })),
    };
  }

  /**
   * Map Etsy receipt to sync format
   */
  private mapReceiptToSync(receipt: EtsyReceipt): EtsyOrderSync {
    const [firstName, ...lastNameParts] = receipt.name.split(" ");
    const lastName = lastNameParts.join(" ");

    return {
      orderId: receipt.receipt_id,
      receiptId: receipt.receipt_id,
      status: this.mapReceiptStatus(receipt),
      createdAt: new Date(receipt.creation_tsz * 1000).toISOString(),
      totalAmount: parseFloat(receipt.total_price),
      totalTax: parseFloat(receipt.total_tax_cost),
      totalShipping: parseFloat(receipt.total_shipping_cost),
      currency: receipt.currency_code,
      buyerName: receipt.name,
      buyerEmail: receipt.payment_email,
      shippingAddress: {
        firstName,
        lastName,
        address1: receipt.first_line,
        address2: receipt.second_line,
        city: receipt.city,
        state: receipt.state,
        zip: receipt.zip,
        country: receipt.country_name,
      },
      lineItems: receipt.transactions.map((txn) => ({
        transactionId: txn.transaction_id,
        listingId: txn.listing_id,
        sku: txn.sku,
        quantity: txn.quantity,
        price: parseFloat(txn.price),
        attributes: this.extractAttributes(txn.variations),
      })),
    };
  }

  /**
   * Map Etsy receipt status to standard status
   */
  private mapReceiptStatus(receipt: EtsyReceipt): string {
    if (receipt.was_refunded) return "REFUNDED";
    if (receipt.was_cancelled) return "CANCELLED";
    if (receipt.was_delivered) return "DELIVERED";
    if (receipt.was_shipped) return "SHIPPED";
    if (receipt.was_paid) return "PAID";
    return "PENDING";
  }
}
