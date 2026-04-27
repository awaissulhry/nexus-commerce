/**
 * Enhanced Shopify Service with GraphQL API
 * Handles product listing, inventory, orders, and parent-child product hierarchy
 */

import { RateLimiter } from "../../utils/rate-limiter.js";
import { MarketplaceSyncError } from "../../utils/error-handler.js";
import type { ShopifyConfig } from "../../types/marketplace.js";

// ── GraphQL Query Types ────────────────────────────────────────────────

interface ShopifyGraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string; extensions?: Record<string, unknown> }>;
}

interface ShopifyProductNode {
  id: string;
  title: string;
  handle: string;
  vendor?: string;
  productType?: string;
  createdAt: string;
  updatedAt: string;
  variants: {
    edges: Array<{
      node: ShopifyVariantNode;
    }>;
  };
  images: {
    edges: Array<{
      node: ShopifyImageNode;
    }>;
  };
}

interface ShopifyVariantNode {
  id: string;
  title: string;
  sku: string;
  price: string;
  compareAtPrice?: string;
  inventoryQuantity: number;
  inventoryItem: {
    id: string;
    tracked: boolean;
  };
  selectedOptions: Array<{
    name: string;
    value: string;
  }>;
  image?: {
    id: string;
    src: string;
    alt?: string;
  };
}

interface ShopifyImageNode {
  id: string;
  src: string;
  alt?: string;
}

interface ShopifyOrderNode {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  email: string;
  phone?: string;
  totalPrice: string;
  totalTax: string;
  totalShippingPrice: string;
  currencyCode: string;
  fulfillmentStatus: string;
  financialStatus: string;
  lineItems: {
    edges: Array<{
      node: ShopifyLineItemNode;
    }>;
  };
  shippingAddress?: {
    address1: string;
    address2?: string;
    city: string;
    province: string;
    zip: string;
    country: string;
  };
  fulfillments: Array<{
    id: string;
    status: string;
    createdAt: string;
    trackingInfo?: {
      number: string;
      company: string;
      url: string;
    };
  }>;
}

interface ShopifyLineItemNode {
  id: string;
  title: string;
  quantity: number;
  price: string;
  sku: string;
  variantId: string;
  productId: string;
}

interface ShopifyInventoryLevel {
  inventoryItemId: string;
  locationId: string;
  available: number;
  updated: string;
}

// ── Parent-Child Detection Types ────────────────────────────────────────

export interface ParentChildMapping {
  parentId: string;
  parentSku: string;
  parentTitle: string;
  variationTheme: string;
  variants: Array<{
    variantId: string;
    sku: string;
    title: string;
    selectedOptions: Record<string, string>;
  }>;
}

export interface ShopifyProductSync {
  productId: string;
  sku: string;
  title: string;
  handle: string;
  vendor?: string;
  productType?: string;
  isParent: boolean;
  parentId?: string;
  variationTheme?: string;
  variants: Array<{
    variantId: string;
    sku: string;
    title: string;
    price: number;
    compareAtPrice?: number;
    inventory: number;
    selectedOptions: Record<string, string>;
    imageUrl?: string;
  }>;
  images: Array<{
    id: string;
    url: string;
    alt?: string;
  }>;
}

export interface ShopifyOrderSync {
  orderId: string;
  orderName: string;
  createdAt: string;
  email: string;
  phone?: string;
  totalPrice: number;
  totalTax: number;
  totalShipping: number;
  currency: string;
  fulfillmentStatus: string;
  financialStatus: string;
  items: Array<{
    lineItemId: string;
    title: string;
    quantity: number;
    price: number;
    sku: string;
    variantId: string;
    productId: string;
  }>;
  shippingAddress?: {
    address1: string;
    address2?: string;
    city: string;
    province: string;
    zip: string;
    country: string;
  };
  fulfillments: Array<{
    id: string;
    status: string;
    createdAt: string;
    trackingNumber?: string;
    trackingCompany?: string;
    trackingUrl?: string;
  }>;
}

/**
 * Enhanced Shopify Service
 * Provides GraphQL-based API access with parent-child product support
 */
export class ShopifyEnhancedService {
  private shopName: string;
  private accessToken: string;
  private apiVersion: string = "2024-01";
  private rateLimiter: RateLimiter;

  constructor(config: ShopifyConfig) {
    this.shopName = config.shopName;
    this.accessToken = config.accessToken;
    this.apiVersion = config.apiVersion || "2024-01";

    if (!this.shopName || !this.accessToken) {
      throw new Error(
        "Missing required Shopify configuration: shopName, accessToken"
      );
    }

    // Initialize rate limiter (2 req/sec, 40 burst for Shopify)
    this.rateLimiter = new RateLimiter();
  }

  /**
   * Get the GraphQL endpoint URL
   */
  private getGraphQLUrl(): string {
    return `https://${this.shopName}.myshopify.com/admin/api/${this.apiVersion}/graphql.json`;
  }

  /**
   * Make a GraphQL request to Shopify
   */
  private async graphqlRequest<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    // Check rate limit
    const waitTime = await this.rateLimiter.consumeToken("SHOPIFY", "graphql");
    if (waitTime > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }

    const url = this.getGraphQLUrl();

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": this.accessToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, variables }),
      });

      if (!response.ok) {
        throw new MarketplaceSyncError(
          "SHOPIFY",
          "NETWORK",
          `Shopify API error (${response.status})`,
          { status: response.status }
        );
      }

      const result = (await response.json()) as ShopifyGraphQLResponse<T>;

      if (result.errors && result.errors.length > 0) {
        const errorMessage = result.errors.map((e) => e.message).join("; ");
        throw new MarketplaceSyncError(
          "SHOPIFY",
          "VALIDATION",
          `Shopify GraphQL error: ${errorMessage}`,
          { errors: result.errors }
        );
      }

      return result.data as T;
    } catch (error) {
      if (error instanceof MarketplaceSyncError) {
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);
      throw new MarketplaceSyncError(
        "SHOPIFY",
        "NETWORK",
        `Shopify request failed: ${message}`,
        { originalError: message }
      );
    }
  }

  /**
   * Detect parent-child product hierarchy from variants
   */
  private detectParentChildHierarchy(product: ShopifyProductNode): ParentChildMapping | null {
    const variants = product.variants.edges.map((e) => e.node);

    if (variants.length <= 1) {
      return null; // Single variant, not a parent-child structure
    }

    // Analyze selected options to determine variation theme
    const optionNames = new Set<string>();
    for (const variant of variants) {
      for (const option of variant.selectedOptions) {
        optionNames.add(option.name);
      }
    }

    if (optionNames.size === 0) {
      return null; // No variation options
    }

    // Determine variation theme based on option names
    const optionArray = Array.from(optionNames).sort();
    const variationTheme = optionArray.join("-");

    // Extract parent SKU (common prefix)
    const skus = variants.map((v) => v.sku).filter((s) => s);
    const parentSku = this.extractParentSku(skus);

    return {
      parentId: product.id,
      parentSku,
      parentTitle: product.title,
      variationTheme,
      variants: variants.map((v) => ({
        variantId: v.id,
        sku: v.sku,
        title: v.title,
        selectedOptions: Object.fromEntries(
          v.selectedOptions.map((o) => [o.name, o.value])
        ),
      })),
    };
  }

  /**
   * Extract parent SKU from variant SKUs
   */
  private extractParentSku(skus: string[]): string {
    if (skus.length === 0) return "";
    if (skus.length === 1) return skus[0];

    // Find common prefix
    let commonPrefix = skus[0];
    for (const sku of skus.slice(1)) {
      let i = 0;
      while (i < commonPrefix.length && i < sku.length && commonPrefix[i] === sku[i]) {
        i++;
      }
      commonPrefix = commonPrefix.substring(0, i);
    }

    // Remove trailing dash if present
    return commonPrefix.replace(/-$/, "");
  }

  /**
   * Get a product by ID with full details
   */
  async getProduct(productId: string): Promise<ShopifyProductSync> {
    const query = `
      query GetProduct($id: ID!) {
        product(id: $id) {
          id
          title
          handle
          vendor
          productType
          createdAt
          updatedAt
          variants(first: 100) {
            edges {
              node {
                id
                title
                sku
                price
                compareAtPrice
                inventoryQuantity
                inventoryItem {
                  id
                  tracked
                }
                selectedOptions {
                  name
                  value
                }
                image {
                  id
                  src
                  alt
                }
              }
            }
          }
          images(first: 100) {
            edges {
              node {
                id
                src
                alt
              }
            }
          }
        }
      }
    `;

    const response = await this.graphqlRequest<{ product: ShopifyProductNode }>(query, {
      id: productId,
    });

    if (!response.product) {
      throw new MarketplaceSyncError(
        "SHOPIFY",
        "NOT_FOUND",
        `Product ${productId} not found`,
        { productId }
      );
    }

    const product = response.product;
    const parentChild = this.detectParentChildHierarchy(product);

    return {
      productId: product.id,
      sku: parentChild?.parentSku || product.variants.edges[0]?.node.sku || "",
      title: product.title,
      handle: product.handle,
      vendor: product.vendor,
      productType: product.productType,
      isParent: parentChild !== null,
      parentId: parentChild?.parentId,
      variationTheme: parentChild?.variationTheme,
      variants: product.variants.edges.map((e) => {
        const variant = e.node;
        return {
          variantId: variant.id,
          sku: variant.sku,
          title: variant.title,
          price: parseFloat(variant.price),
          compareAtPrice: variant.compareAtPrice ? parseFloat(variant.compareAtPrice) : undefined,
          inventory: variant.inventoryQuantity,
          selectedOptions: Object.fromEntries(
            variant.selectedOptions.map((o) => [o.name, o.value])
          ),
          imageUrl: variant.image?.src,
        };
      }),
      images: product.images.edges.map((e) => ({
        id: e.node.id,
        url: e.node.src,
        alt: e.node.alt,
      })),
    };
  }

  /**
   * Get all products with pagination
   */
  async getAllProducts(first: number = 100, after?: string): Promise<{
    products: ShopifyProductSync[];
    pageInfo: { hasNextPage: boolean; endCursor?: string };
  }> {
    const query = `
      query GetProducts($first: Int!, $after: String) {
        products(first: $first, after: $after, query: "status:active") {
          edges {
            node {
              id
              title
              handle
              vendor
              productType
              createdAt
              updatedAt
              variants(first: 100) {
                edges {
                  node {
                    id
                    title
                    sku
                    price
                    compareAtPrice
                    inventoryQuantity
                    inventoryItem {
                      id
                      tracked
                    }
                    selectedOptions {
                      name
                      value
                    }
                    image {
                      id
                      src
                      alt
                    }
                  }
                }
              }
              images(first: 100) {
                edges {
                  node {
                    id
                    src
                    alt
                  }
                }
              }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    `;

    const response = await this.graphqlRequest<{
      products: {
        edges: Array<{ node: ShopifyProductNode }>;
        pageInfo: { hasNextPage: boolean; endCursor?: string };
      };
    }>(query, { first, after });

    return {
      products: response.products.edges.map((e) => {
        const product = e.node;
        const parentChild = this.detectParentChildHierarchy(product);

        return {
          productId: product.id,
          sku: parentChild?.parentSku || product.variants.edges[0]?.node.sku || "",
          title: product.title,
          handle: product.handle,
          vendor: product.vendor,
          productType: product.productType,
          isParent: parentChild !== null,
          parentId: parentChild?.parentId,
          variationTheme: parentChild?.variationTheme,
          variants: product.variants.edges.map((e) => {
            const variant = e.node;
            return {
              variantId: variant.id,
              sku: variant.sku,
              title: variant.title,
              price: parseFloat(variant.price),
              compareAtPrice: variant.compareAtPrice ? parseFloat(variant.compareAtPrice) : undefined,
              inventory: variant.inventoryQuantity,
              selectedOptions: Object.fromEntries(
                variant.selectedOptions.map((o) => [o.name, o.value])
              ),
              imageUrl: variant.image?.src,
            };
          }),
          images: product.images.edges.map((e) => ({
            id: e.node.id,
            url: e.node.src,
            alt: e.node.alt,
          })),
        };
      }),
      pageInfo: response.products.pageInfo,
    };
  }

  /**
   * Update variant price
   */
  async updateVariantPrice(variantId: string, price: number): Promise<void> {
    const mutation = `
      mutation UpdateVariantPrice($input: ProductVariantInput!) {
        productVariantUpdate(input: $input) {
          productVariant {
            id
            price
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const response = await this.graphqlRequest<{
      productVariantUpdate: {
        productVariant?: { id: string; price: string };
        userErrors: Array<{ field: string[]; message: string }>;
      };
    }>(mutation, {
      input: {
        id: variantId,
        price: price.toFixed(2),
      },
    });

    if (response.productVariantUpdate.userErrors.length > 0) {
      const errors = response.productVariantUpdate.userErrors
        .map((e) => e.message)
        .join("; ");
      throw new MarketplaceSyncError(
        "SHOPIFY",
        "VALIDATION",
        `Failed to update variant price: ${errors}`,
        { variantId, price }
      );
    }
  }

  /**
   * Update inventory for a variant at a specific location
   */
  async updateInventory(
    inventoryItemId: string,
    locationId: string,
    quantity: number
  ): Promise<void> {
    const mutation = `
      mutation UpdateInventory($input: InventoryAdjustQuantityInput!) {
        inventoryAdjustQuantity(input: $input) {
          inventoryLevel {
            id
            available
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const response = await this.graphqlRequest<{
      inventoryAdjustQuantity: {
        inventoryLevel?: { id: string; available: number };
        userErrors: Array<{ field: string[]; message: string }>;
      };
    }>(mutation, {
      input: {
        inventoryItemId,
        locationId,
        availableAdjustment: quantity,
      },
    });

    if (response.inventoryAdjustQuantity.userErrors.length > 0) {
      const errors = response.inventoryAdjustQuantity.userErrors
        .map((e) => e.message)
        .join("; ");
      throw new MarketplaceSyncError(
        "SHOPIFY",
        "VALIDATION",
        `Failed to update inventory: ${errors}`,
        { inventoryItemId, locationId, quantity }
      );
    }
  }

  /**
   * Get inventory levels for a product
   */
  async getInventoryLevels(productId: string): Promise<ShopifyInventoryLevel[]> {
    const query = `
      query GetInventoryLevels($id: ID!) {
        product(id: $id) {
          variants(first: 100) {
            edges {
              node {
                id
                inventoryItem {
                  id
                  inventoryLevels(first: 100) {
                    edges {
                      node {
                        inventoryItemId
                        locationId
                        available
                        updated
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;

    const response = await this.graphqlRequest<{
      product: {
        variants: {
          edges: Array<{
            node: {
              id: string;
              inventoryItem: {
                id: string;
                inventoryLevels: {
                  edges: Array<{
                    node: ShopifyInventoryLevel;
                  }>;
                };
              };
            };
          }>;
        };
      };
    }>(query, { id: productId });

    const levels: ShopifyInventoryLevel[] = [];
    for (const variantEdge of response.product.variants.edges) {
      for (const levelEdge of variantEdge.node.inventoryItem.inventoryLevels.edges) {
        levels.push(levelEdge.node);
      }
    }

    return levels;
  }

  /**
   * Get orders with pagination
   */
  async getOrders(first: number = 50, after?: string): Promise<{
    orders: ShopifyOrderSync[];
    pageInfo: { hasNextPage: boolean; endCursor?: string };
  }> {
    const query = `
      query GetOrders($first: Int!, $after: String) {
        orders(first: $first, after: $after, sortKey: CREATED_AT, reverse: true) {
          edges {
            node {
              id
              name
              createdAt
              updatedAt
              email
              phone
              totalPrice
              totalTax
              totalShippingPrice
              currencyCode
              fulfillmentStatus
              financialStatus
              lineItems(first: 100) {
                edges {
                  node {
                    id
                    title
                    quantity
                    price
                    sku
                    variantId
                    productId
                  }
                }
              }
              shippingAddress {
                address1
                address2
                city
                province
                zip
                country
              }
              fulfillments {
                id
                status
                createdAt
                trackingInfo {
                  number
                  company
                  url
                }
              }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    `;

    const response = await this.graphqlRequest<{
      orders: {
        edges: Array<{ node: ShopifyOrderNode }>;
        pageInfo: { hasNextPage: boolean; endCursor?: string };
      };
    }>(query, { first, after });

    return {
      orders: response.orders.edges.map((e) => {
        const order = e.node;
        return {
          orderId: order.id,
          orderName: order.name,
          createdAt: order.createdAt,
          email: order.email,
          phone: order.phone,
          totalPrice: parseFloat(order.totalPrice),
          totalTax: parseFloat(order.totalTax),
          totalShipping: parseFloat(order.totalShippingPrice),
          currency: order.currencyCode,
          fulfillmentStatus: order.fulfillmentStatus,
          financialStatus: order.financialStatus,
          items: order.lineItems.edges.map((e) => {
            const item = e.node;
            return {
              lineItemId: item.id,
              title: item.title,
              quantity: item.quantity,
              price: parseFloat(item.price),
              sku: item.sku,
              variantId: item.variantId,
              productId: item.productId,
            };
          }),
          shippingAddress: order.shippingAddress
            ? {
                address1: order.shippingAddress.address1,
                address2: order.shippingAddress.address2,
                city: order.shippingAddress.city,
                province: order.shippingAddress.province,
                zip: order.shippingAddress.zip,
                country: order.shippingAddress.country,
              }
            : undefined,
          fulfillments: order.fulfillments.map((f) => ({
            id: f.id,
            status: f.status,
            createdAt: f.createdAt,
            trackingNumber: f.trackingInfo?.number,
            trackingCompany: f.trackingInfo?.company,
            trackingUrl: f.trackingInfo?.url,
          })),
        };
      }),
      pageInfo: response.orders.pageInfo,
    };
  }

  /**
   * Get a single order by ID
   */
  async getOrder(orderId: string): Promise<ShopifyOrderSync> {
    const query = `
      query GetOrder($id: ID!) {
        order(id: $id) {
          id
          name
          createdAt
          updatedAt
          email
          phone
          totalPrice
          totalTax
          totalShippingPrice
          currencyCode
          fulfillmentStatus
          financialStatus
          lineItems(first: 100) {
            edges {
              node {
                id
                title
                quantity
                price
                sku
                variantId
                productId
              }
            }
          }
          shippingAddress {
            address1
            address2
            city
            province
            zip
            country
          }
          fulfillments {
            id
            status
            createdAt
            trackingInfo {
              number
              company
              url
            }
          }
        }
      }
    `;

    const response = await this.graphqlRequest<{ order: ShopifyOrderNode }>(query, {
      id: orderId,
    });

    if (!response.order) {
      throw new MarketplaceSyncError(
        "SHOPIFY",
        "NOT_FOUND",
        `Order ${orderId} not found`,
        { orderId }
      );
    }

    const order = response.order;
    return {
      orderId: order.id,
      orderName: order.name,
      createdAt: order.createdAt,
      email: order.email,
      phone: order.phone,
      totalPrice: parseFloat(order.totalPrice),
      totalTax: parseFloat(order.totalTax),
      totalShipping: parseFloat(order.totalShippingPrice),
      currency: order.currencyCode,
      fulfillmentStatus: order.fulfillmentStatus,
      financialStatus: order.financialStatus,
      items: order.lineItems.edges.map((e) => {
        const item = e.node;
        return {
          lineItemId: item.id,
          title: item.title,
          quantity: item.quantity,
          price: parseFloat(item.price),
          sku: item.sku,
          variantId: item.variantId,
          productId: item.productId,
        };
      }),
      shippingAddress: order.shippingAddress
        ? {
            address1: order.shippingAddress.address1,
            address2: order.shippingAddress.address2,
            city: order.shippingAddress.city,
            province: order.shippingAddress.province,
            zip: order.shippingAddress.zip,
            country: order.shippingAddress.country,
          }
        : undefined,
      fulfillments: order.fulfillments.map((f) => ({
        id: f.id,
        status: f.status,
        createdAt: f.createdAt,
        trackingNumber: f.trackingInfo?.number,
        trackingCompany: f.trackingInfo?.company,
        trackingUrl: f.trackingInfo?.url,
      })),
    };
  }

  /**
   * Create a fulfillment for an order
   */
  async createFulfillment(
    orderId: string,
    lineItemIds: string[],
    trackingInfo?: {
      number: string;
      company: string;
      url?: string;
    }
  ): Promise<{ fulfillmentId: string; status: string }> {
    const mutation = `
      mutation CreateFulfillment($input: FulfillmentInput!) {
        fulfillmentCreate(input: $input) {
          fulfillment {
            id
            status
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const response = await this.graphqlRequest<{
      fulfillmentCreate: {
        fulfillment?: { id: string; status: string };
        userErrors: Array<{ field: string[]; message: string }>;
      };
    }>(mutation, {
      input: {
        orderId,
        lineItemsToFulfill: lineItemIds.map((id) => ({
          id,
        })),
        trackingInfo: trackingInfo
          ? {
              number: trackingInfo.number,
              company: trackingInfo.company,
              url: trackingInfo.url,
            }
          : undefined,
      },
    });

    if (response.fulfillmentCreate.userErrors.length > 0) {
      const errors = response.fulfillmentCreate.userErrors
        .map((e) => e.message)
        .join("; ");
      throw new MarketplaceSyncError(
        "SHOPIFY",
        "VALIDATION",
        `Failed to create fulfillment: ${errors}`,
        { orderId, lineItemIds }
      );
    }

    if (!response.fulfillmentCreate.fulfillment) {
      throw new MarketplaceSyncError(
        "SHOPIFY",
        "UNKNOWN",
        "Failed to create fulfillment: no response",
        { orderId }
      );
    }

    return {
      fulfillmentId: response.fulfillmentCreate.fulfillment.id,
      status: response.fulfillmentCreate.fulfillment.status,
    };
  }

  /**
   * Get default location ID for inventory operations
   */
  async getDefaultLocationId(): Promise<string> {
    const query = `
      query GetLocations {
        locations(first: 1) {
          edges {
            node {
              id
              name
              isActive
            }
          }
        }
      }
    `;

    const response = await this.graphqlRequest<{
      locations: {
        edges: Array<{
          node: { id: string; name: string; isActive: boolean };
        }>;
      };
    }>(query);

    if (response.locations.edges.length === 0) {
      throw new MarketplaceSyncError(
        "SHOPIFY",
        "NOT_FOUND",
        "No locations found in Shopify store"
      );
    }

    return response.locations.edges[0].node.id;
  }
}
