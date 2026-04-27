/**
 * WooCommerce Service
 * Handles product listing, inventory, orders, and parent-child product hierarchy
 */

import { rateLimiter } from "../../utils/rate-limiter.js";
import { MarketplaceSyncError } from "../../utils/error-handler.js";
import type { WooCommerceConfig } from "../../types/marketplace.js";

// ── WooCommerce API Response Types ────────────────────────────────────────

interface WooCommerceProduct {
  id: number;
  name: string;
  slug: string;
  type: string; // simple, variable, grouped, external
  status: string; // draft, pending, private, publish
  description: string;
  short_description: string;
  sku: string;
  price: string;
  regular_price: string;
  sale_price: string;
  date_created: string;
  date_modified: string;
  parent_id: number;
  variations: number[];
  images: Array<{
    id: number;
    src: string;
    alt: string;
  }>;
  attributes: Array<{
    id: number;
    name: string;
    options: string[];
  }>;
}

interface WooCommerceVariation {
  id: number;
  product_id: number;
  sku: string;
  price: string;
  regular_price: string;
  sale_price: string;
  stock_quantity: number;
  stock_status: string;
  attributes: Array<{
    id: number;
    name: string;
    option: string;
  }>;
  image?: {
    id: number;
    src: string;
    alt: string;
  };
}

interface WooCommerceOrder {
  id: number;
  number: string;
  status: string;
  date_created: string;
  date_modified: string;
  total: string;
  total_tax: string;
  shipping_total: string;
  currency: string;
  billing: {
    first_name: string;
    last_name: string;
    email: string;
    phone: string;
    address_1: string;
    address_2: string;
    city: string;
    state: string;
    postcode: string;
    country: string;
  };
  shipping: {
    first_name: string;
    last_name: string;
    address_1: string;
    address_2: string;
    city: string;
    state: string;
    postcode: string;
    country: string;
  };
  line_items: Array<{
    id: number;
    product_id: number;
    variation_id: number;
    quantity: number;
    subtotal: string;
    total: string;
    sku: string;
    name: string;
  }>;
}

interface WooCommerceOrderNote {
  id: number;
  date_created: string;
  note: string;
  customer_note: boolean;
}

// ── Parent-Child Detection Types ────────────────────────────────────────

export interface ParentChildMapping {
  parentId: number;
  parentSku: string;
  parentTitle: string;
  variationTheme: string;
  variations: Array<{
    variationId: number;
    sku: string;
    title: string;
    attributes: Record<string, string>;
  }>;
}

export interface WooCommerceProductSync {
  productId: number;
  sku: string;
  title: string;
  slug: string;
  type: string;
  isParent: boolean;
  parentId?: number;
  variationTheme?: string;
  variations: Array<{
    variationId: number;
    sku: string;
    title: string;
    price: number;
    regularPrice?: number;
    salePrice?: number;
    stock: number;
    attributes: Record<string, string>;
    image?: {
      id: number;
      src: string;
      alt: string;
    };
  }>;
  images: Array<{
    id: number;
    src: string;
    alt: string;
  }>;
}

export interface WooCommerceOrderSync {
  orderId: number;
  orderNumber: string;
  status: string;
  createdAt: string;
  totalAmount: number;
  totalTax: number;
  shippingTotal: number;
  currency: string;
  buyerEmail: string;
  buyerPhone?: string;
  shippingAddress: {
    firstName: string;
    lastName: string;
    address1: string;
    address2?: string;
    city: string;
    state: string;
    postcode: string;
    country: string;
  };
  lineItems: Array<{
    lineItemId: number;
    productId: number;
    variationId: number;
    sku: string;
    quantity: number;
    price: number;
  }>;
}

/**
 * WooCommerce Service
 * Manages API interactions with WooCommerce REST API
 */
export class WooCommerceService {
  private baseUrl: string;
  private consumerKey: string;
  private consumerSecret: string;

  constructor(config: WooCommerceConfig) {
    this.baseUrl = config.storeUrl.replace(/\/$/, "");
    this.consumerKey = config.consumerKey;
    this.consumerSecret = config.consumerSecret;

    if (!this.baseUrl || !this.consumerKey || !this.consumerSecret) {
      throw new Error(
        "Missing required WooCommerce configuration: storeUrl, consumerKey, consumerSecret"
      );
    }
  }

  /**
   * Make an authenticated request to WooCommerce API
   */
  private async request<T>(
    method: string,
    endpoint: string,
    body?: unknown
  ): Promise<T> {
    await rateLimiter.consumeToken("WOOCOMMERCE", endpoint);

    const url = `${this.baseUrl}/wp-json/wc/v3${endpoint}`;
    const auth = Buffer.from(
      `${this.consumerKey}:${this.consumerSecret}`
    ).toString("base64");

    const options: RequestInit = {
      method,
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
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
          "WOOCOMMERCE",
          "VALIDATION",
          `WooCommerce API error: ${response.status} ${response.statusText}`,
          { endpoint, status: response.status, error: errorData }
        );
      }

      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof MarketplaceSyncError) {
        throw error;
      }
      throw new MarketplaceSyncError(
        "WOOCOMMERCE",
        "NETWORK",
        `Failed to make WooCommerce API request: ${error instanceof Error ? error.message : String(error)}`,
        { endpoint, method }
      );
    }
  }

  /**
   * Get a single product with variations
   */
  async getProduct(productId: number): Promise<WooCommerceProductSync> {
    try {
      const product = await this.request<WooCommerceProduct>(
        "GET",
        `/products/${productId}`
      );

      // If it's a variable product, fetch variations
      let variations: WooCommerceVariation[] = [];
      if (product.type === "variable" && product.variations.length > 0) {
        variations = await this.request<WooCommerceVariation[]>(
          "GET",
          `/products/${productId}/variations?per_page=100`
        );
      }

      return this.mapProductToSync(product, variations);
    } catch (error) {
      throw new MarketplaceSyncError(
        "WOOCOMMERCE",
        "NOT_FOUND",
        `Failed to fetch product ${productId}: ${error instanceof Error ? error.message : String(error)}`,
        { productId: String(productId) }
      );
    }
  }

  /**
   * Get all products with pagination
   */
  async getAllProducts(
    perPage: number = 100,
    page: number = 1
  ): Promise<{
    products: WooCommerceProductSync[];
    pageInfo: { hasNextPage: boolean; totalPages: number; currentPage: number };
  }> {
    try {
      const response = await this.request<WooCommerceProduct[]>(
        "GET",
        `/products?per_page=${perPage}&page=${page}`
      );

      // Get total pages from response headers (WooCommerce returns this)
      const products: WooCommerceProductSync[] = [];

      for (const product of response) {
        let variations: WooCommerceVariation[] = [];
        if (product.type === "variable" && product.variations.length > 0) {
          variations = await this.request<WooCommerceVariation[]>(
            "GET",
            `/products/${product.id}/variations?per_page=100`
          );
        }
        products.push(this.mapProductToSync(product, variations));
      }

      return {
        products,
        pageInfo: {
          hasNextPage: response.length === perPage,
          totalPages: Math.ceil(response.length / perPage),
          currentPage: page,
        },
      };
    } catch (error) {
      throw new MarketplaceSyncError(
        "WOOCOMMERCE",
        "NETWORK",
        `Failed to fetch products: ${error instanceof Error ? error.message : String(error)}`,
        { perPage, page }
      );
    }
  }

  /**
   * Update product price
   */
  async updateProductPrice(
    productId: number,
    price: number
  ): Promise<void> {
    try {
      await this.request("PUT", `/products/${productId}`, {
        regular_price: price.toString(),
      });
    } catch (error) {
      throw new MarketplaceSyncError(
        "WOOCOMMERCE",
        "VALIDATION",
        `Failed to update product price: ${error instanceof Error ? error.message : String(error)}`,
        { productId: String(productId), price: String(price) }
      );
    }
  }

  /**
   * Update variation price
   */
  async updateVariationPrice(
    productId: number,
    variationId: number,
    price: number
  ): Promise<void> {
    try {
      await this.request("PUT", `/products/${productId}/variations/${variationId}`, {
        regular_price: price.toString(),
      });
    } catch (error) {
      throw new MarketplaceSyncError(
        "WOOCOMMERCE",
        "VALIDATION",
        `Failed to update variation price: ${error instanceof Error ? error.message : String(error)}`,
        { productId: String(productId), variationId: String(variationId), price: String(price) }
      );
    }
  }

  /**
   * Update product stock
   */
  async updateProductStock(
    productId: number,
    quantity: number
  ): Promise<void> {
    try {
      await this.request("PUT", `/products/${productId}`, {
        stock_quantity: quantity,
      });
    } catch (error) {
      throw new MarketplaceSyncError(
        "WOOCOMMERCE",
        "VALIDATION",
        `Failed to update product stock: ${error instanceof Error ? error.message : String(error)}`,
        { productId: String(productId), quantity: String(quantity) }
      );
    }
  }

  /**
   * Update variation stock
   */
  async updateVariationStock(
    productId: number,
    variationId: number,
    quantity: number
  ): Promise<void> {
    try {
      await this.request("PUT", `/products/${productId}/variations/${variationId}`, {
        stock_quantity: quantity,
      });
    } catch (error) {
      throw new MarketplaceSyncError(
        "WOOCOMMERCE",
        "VALIDATION",
        `Failed to update variation stock: ${error instanceof Error ? error.message : String(error)}`,
        { productId: String(productId), variationId: String(variationId), quantity: String(quantity) }
      );
    }
  }

  /**
   * Get all orders with pagination
   */
  async getOrders(
    perPage: number = 100,
    page: number = 1
  ): Promise<{
    orders: WooCommerceOrderSync[];
    pageInfo: { hasNextPage: boolean; totalPages: number; currentPage: number };
  }> {
    try {
      const response = await this.request<WooCommerceOrder[]>(
        "GET",
        `/orders?per_page=${perPage}&page=${page}&status=any`
      );

      const orders = response.map((order) => this.mapOrderToSync(order));

      return {
        orders,
        pageInfo: {
          hasNextPage: response.length === perPage,
          totalPages: Math.ceil(response.length / perPage),
          currentPage: page,
        },
      };
    } catch (error) {
      throw new MarketplaceSyncError(
        "WOOCOMMERCE",
        "NETWORK",
        `Failed to fetch orders: ${error instanceof Error ? error.message : String(error)}`,
        { perPage, page }
      );
    }
  }

  /**
   * Get a single order
   */
  async getOrder(orderId: number): Promise<WooCommerceOrderSync> {
    try {
      const order = await this.request<WooCommerceOrder>(
        "GET",
        `/orders/${orderId}`
      );
      return this.mapOrderToSync(order);
    } catch (error) {
      throw new MarketplaceSyncError(
        "WOOCOMMERCE",
        "NOT_FOUND",
        `Failed to fetch order ${orderId}: ${error instanceof Error ? error.message : String(error)}`,
        { orderId }
      );
    }
  }

  /**
   * Update order status
   */
  async updateOrderStatus(orderId: number, status: string): Promise<void> {
    try {
      await this.request("PUT", `/orders/${orderId}`, { status });
    } catch (error) {
      throw new MarketplaceSyncError(
        "WOOCOMMERCE",
        "VALIDATION",
        `Failed to update order status: ${error instanceof Error ? error.message : String(error)}`,
        { orderId, status }
      );
    }
  }

  /**
   * Add order note (for tracking/fulfillment)
   */
  async addOrderNote(
    orderId: number,
    note: string,
    customerNote: boolean = false
  ): Promise<void> {
    try {
      await this.request("POST", `/orders/${orderId}/notes`, {
        note,
        customer_note: customerNote,
      });
    } catch (error) {
      throw new MarketplaceSyncError(
        "WOOCOMMERCE",
        "VALIDATION",
        `Failed to add order note: ${error instanceof Error ? error.message : String(error)}`,
        { orderId }
      );
    }
  }

  /**
   * Detect parent-child product hierarchy
   */
  detectParentChild(product: WooCommerceProduct, variations: WooCommerceVariation[]): ParentChildMapping | null {
    if (product.type !== "variable" || variations.length === 0) {
      return null;
    }

    // Extract variation theme from product attributes
    const variationTheme = product.attributes
      .map((attr) => attr.name)
      .join("-");

    if (!variationTheme) {
      return null;
    }

    return {
      parentId: product.id,
      parentSku: product.sku,
      parentTitle: product.name,
      variationTheme,
      variations: variations.map((v) => ({
        variationId: v.id,
        sku: v.sku,
        title: v.sku, // WooCommerce doesn't have variation titles, use SKU
        attributes: this.mapVariationAttributes(v.attributes),
      })),
    };
  }

  /**
   * Map WooCommerce product to sync format
   */
  private mapProductToSync(
    product: WooCommerceProduct,
    variations: WooCommerceVariation[]
  ): WooCommerceProductSync {
    const isParent = product.type === "variable" && variations.length > 0;
    const variationTheme = isParent
      ? product.attributes.map((attr) => attr.name).join("-")
      : undefined;

    return {
      productId: product.id,
      sku: product.sku,
      title: product.name,
      slug: product.slug,
      type: product.type,
      isParent,
      parentId: product.parent_id || undefined,
      variationTheme,
      variations: variations.map((v) => ({
        variationId: v.id,
        sku: v.sku,
        title: v.sku,
        price: parseFloat(v.price),
        regularPrice: v.regular_price ? parseFloat(v.regular_price) : undefined,
        salePrice: v.sale_price ? parseFloat(v.sale_price) : undefined,
        stock: v.stock_quantity || 0,
        attributes: this.mapVariationAttributes(v.attributes),
        image: v.image,
      })),
      images: product.images,
    };
  }

  /**
   * Map variation attributes to key-value format
   */
  private mapVariationAttributes(
    attributes: Array<{ id: number; name: string; option: string }>
  ): Record<string, string> {
    const result: Record<string, string> = {};
    for (const attr of attributes) {
      result[attr.name] = attr.option;
    }
    return result;
  }

  /**
   * Map WooCommerce order to sync format
   */
  private mapOrderToSync(order: WooCommerceOrder): WooCommerceOrderSync {
    return {
      orderId: order.id,
      orderNumber: order.number,
      status: order.status,
      createdAt: order.date_created,
      totalAmount: parseFloat(order.total),
      totalTax: parseFloat(order.total_tax),
      shippingTotal: parseFloat(order.shipping_total),
      currency: order.currency,
      buyerEmail: order.billing.email,
      buyerPhone: order.billing.phone,
      shippingAddress: {
        firstName: order.shipping.first_name,
        lastName: order.shipping.last_name,
        address1: order.shipping.address_1,
        address2: order.shipping.address_2,
        city: order.shipping.city,
        state: order.shipping.state,
        postcode: order.shipping.postcode,
        country: order.shipping.country,
      },
      lineItems: order.line_items.map((item) => ({
        lineItemId: item.id,
        productId: item.product_id,
        variationId: item.variation_id,
        sku: item.sku,
        quantity: item.quantity,
        price: parseFloat(item.total) / item.quantity,
      })),
    };
  }
}
