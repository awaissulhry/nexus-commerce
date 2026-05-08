/**
 * Shopify Marketplace Service
 * Handles product listing, inventory, and pricing operations on Shopify
 */

interface ShopifyTokenResponse {
  access_token: string;
  scope: string;
  expires_in: number;
  associated_user_scope: string;
  associated_user: {
    account_owner: boolean;
    collaborator: boolean;
    email: string;
    account_permissions: string[];
  };
}

interface ShopifyProduct {
  id: string;
  title: string;
  handle: string;
  vendor: string;
  product_type: string;
  created_at: string;
  updated_at: string;
  published_at: string;
  tags: string;
  status: string;
  variants: ShopifyVariant[];
  images: ShopifyImage[];
}

interface ShopifyVariant {
  id: string;
  product_id: string;
  title: string;
  price: string;
  sku: string;
  position: number;
  inventory_quantity: number;
  inventory_management: string;
  inventory_policy: string;
  barcode: string;
  compare_at_price: string;
  fulfillment_service: string;
  weight: number;
  weight_unit: string;
  created_at: string;
  updated_at: string;
  taxable: boolean;
  image_id: string | null;
}

interface ShopifyImage {
  id: string;
  product_id: string;
  position: number;
  created_at: string;
  updated_at: string;
  alt: string | null;
  width: number;
  height: number;
  src: string;
  variant_ids: string[];
}

interface ShopifyInventoryLevel {
  inventory_item_id: string;
  location_id: string;
  available: number;
  updated_at: string;
}

export class ShopifyService {
  private shopName: string;
  private accessToken: string;
  private apiVersion: string = "2024-01";

  constructor() {
    this.shopName = process.env.SHOPIFY_SHOP_NAME || "";
    this.accessToken = process.env.SHOPIFY_ACCESS_TOKEN || "";

    if (!this.shopName || !this.accessToken) {
      throw new Error(
        "Missing required Shopify environment variables: SHOPIFY_SHOP_NAME, SHOPIFY_ACCESS_TOKEN"
      );
    }
  }

  /**
   * S.22 — public wrapper for Admin API GETs. Used by
   * shopify-locations.service for the discovery flow without
   * exposing the full makeRequest contract.
   */
  async getRaw(path: string): Promise<unknown> {
    return this.makeRequest('GET', path);
  }

  // S.22 — delegating shim that lets discoverShopifyLocations()
  // accept either a ShopifyEnhancedService or this lighter
  // ShopifyService — the only contract is `makeRequest('GET', path)`.
  async makeRequestPublic(method: 'GET', path: string): Promise<unknown> {
    return this.makeRequest(method, path);
  }

  /**
   * Get the base URL for Shopify API calls
   */
  private getBaseUrl(): string {
    return `https://${this.shopName}.myshopify.com/admin/api/${this.apiVersion}`;
  }

  /**
   * Make an authenticated request to the Shopify API
   */
  private async makeRequest(
    method: string,
    endpoint: string,
    body?: unknown
  ): Promise<unknown> {
    const url = `${this.getBaseUrl()}${endpoint}`;

    const options: RequestInit = {
      method,
      headers: {
        "X-Shopify-Access-Token": this.accessToken,
        "Content-Type": "application/json",
      },
    };

    if (body) {
      options.body = JSON.stringify(body);
    }

    try {
      const response = await fetch(url, options);

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(
          `Shopify API error (${response.status}): ${errorBody}`
        );
      }

      return await response.json();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[ShopifyService] Request failed: ${message}`);
      throw error;
    }
  }

  /**
   * Get a product by ID
   */
  async getProduct(productId: string): Promise<ShopifyProduct> {
    try {
      const response = (await this.makeRequest(
        "GET",
        `/products/${productId}.json`
      )) as { product: ShopifyProduct };

      return response.product;
    } catch (error) {
      console.error(`[ShopifyService] Failed to get product ${productId}:`, error);
      throw error;
    }
  }

  /**
   * Get a product by SKU
   */
  async getProductBySku(sku: string): Promise<ShopifyProduct | null> {
    try {
      const response = (await this.makeRequest(
        "GET",
        `/products.json?query=sku:${encodeURIComponent(sku)}`
      )) as { products: ShopifyProduct[] };

      if (response.products.length === 0) {
        return null;
      }

      return response.products[0];
    } catch (error) {
      console.error(`[ShopifyService] Failed to get product by SKU ${sku}:`, error);
      throw error;
    }
  }

  /**
   * Update a product variant price
   */
  async updateVariantPrice(variantId: string, newPrice: number): Promise<void> {
    try {
      console.log(
        `[ShopifyService] Updating price for variant ${variantId} to $${newPrice.toFixed(2)}…`
      );

      await this.makeRequest("PUT", `/variants/${variantId}.json`, {
        variant: {
          id: variantId,
          price: newPrice.toFixed(2),
        },
      });

      console.log(
        `[ShopifyService] ✓ Updated price for variant ${variantId} to $${newPrice.toFixed(2)}`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[ShopifyService] ✗ Failed to update variant price for ${variantId}:`,
        message
      );
      throw error;
    }
  }

  /**
   * Update inventory for a variant
   */
  async updateVariantInventory(
    variantId: string,
    quantity: number,
    locationId?: string
  ): Promise<void> {
    try {
      console.log(
        `[ShopifyService] Updating inventory for variant ${variantId} to ${quantity}…`
      );

      // Get the variant to find its inventory item ID
      const variant = await this.getVariant(variantId);

      if (!variant) {
        throw new Error(`Variant ${variantId} not found`);
      }

      // Get inventory item ID from variant
      const inventoryItemId = (variant as any).inventory_item_id;

      if (!inventoryItemId) {
        throw new Error(`No inventory item found for variant ${variantId}`);
      }

      // Use the provided location ID or default to the first location
      const locId = locationId || (await this.getDefaultLocationId());

      // Update inventory level
      await this.makeRequest("POST", `/inventory_levels/adjust.json`, {
        inventory_item_id: inventoryItemId,
        available_adjustment: quantity,
        location_id: locId,
      });

      console.log(
        `[ShopifyService] ✓ Updated inventory for variant ${variantId} to ${quantity}`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[ShopifyService] ✗ Failed to update variant inventory for ${variantId}:`,
        message
      );
      throw error;
    }
  }

  /**
   * Get a variant by ID
   */
  private async getVariant(variantId: string): Promise<ShopifyVariant | null> {
    try {
      const response = (await this.makeRequest(
        "GET",
        `/variants/${variantId}.json`
      )) as { variant: ShopifyVariant };

      return response.variant;
    } catch (error) {
      console.error(`[ShopifyService] Failed to get variant ${variantId}:`, error);
      return null;
    }
  }

  /**
   * Get the default location ID for inventory operations
   */
  private async getDefaultLocationId(): Promise<string> {
    try {
      const response = (await this.makeRequest(
        "GET",
        `/locations.json`
      )) as { locations: Array<{ id: string; name: string }> };

      if (response.locations.length === 0) {
        throw new Error("No locations found in Shopify store");
      }

      // Return the first location ID
      return response.locations[0].id;
    } catch (error) {
      console.error(`[ShopifyService] Failed to get default location:`, error);
      throw error;
    }
  }

  /**
   * Get all products from the store
   */
  async getAllProducts(limit: number = 250): Promise<ShopifyProduct[]> {
    try {
      console.log(`[ShopifyService] Fetching products (limit: ${limit})…`);

      const response = (await this.makeRequest(
        "GET",
        `/products.json?limit=${limit}&status=active`
      )) as { products: ShopifyProduct[] };

      console.log(
        `[ShopifyService] ✓ Fetched ${response.products.length} products`
      );

      return response.products;
    } catch (error) {
      console.error(`[ShopifyService] Failed to fetch products:`, error);
      throw error;
    }
  }

  /**
   * Create a new product
   */
  async createProduct(
    title: string,
    vendor: string,
    productType: string,
    variants: Array<{
      title: string;
      sku: string;
      price: number;
      inventory_quantity?: number;
    }>
  ): Promise<ShopifyProduct> {
    try {
      console.log(`[ShopifyService] Creating product "${title}"…`);

      const response = (await this.makeRequest("POST", `/products.json`, {
        product: {
          title,
          vendor,
          product_type: productType,
          variants: variants.map((v) => ({
            title: v.title,
            sku: v.sku,
            price: v.price.toFixed(2),
            inventory_quantity: v.inventory_quantity || 0,
            inventory_management: "shopify",
            inventory_policy: "deny",
          })),
        },
      })) as { product: ShopifyProduct };

      console.log(
        `[ShopifyService] ✓ Created product "${title}" with ID ${response.product.id}`
      );

      return response.product;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[ShopifyService] ✗ Failed to create product:`, message);
      throw error;
    }
  }

  /**
   * Update a product
   */
  async updateProduct(
    productId: string,
    updates: Partial<ShopifyProduct>
  ): Promise<ShopifyProduct> {
    try {
      console.log(`[ShopifyService] Updating product ${productId}…`);

      const response = (await this.makeRequest("PUT", `/products/${productId}.json`, {
        product: updates,
      })) as { product: ShopifyProduct };

      console.log(`[ShopifyService] ✓ Updated product ${productId}`);

      return response.product;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[ShopifyService] ✗ Failed to update product:`, message);
      throw error;
    }
  }

  /**
   * Delete a product
   */
  async deleteProduct(productId: string): Promise<void> {
    try {
      console.log(`[ShopifyService] Deleting product ${productId}…`);

      await this.makeRequest("DELETE", `/products/${productId}.json`);

      console.log(`[ShopifyService] ✓ Deleted product ${productId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[ShopifyService] ✗ Failed to delete product:`, message);
      throw error;
    }
  }

  /**
   * Get inventory levels for a product
   */
  async getInventoryLevels(productId: string): Promise<ShopifyInventoryLevel[]> {
    try {
      const product = await this.getProduct(productId);

      const inventoryLevels: ShopifyInventoryLevel[] = [];

      for (const variant of product.variants) {
        const response = (await this.makeRequest(
          "GET",
          `/inventory_levels.json?inventory_item_ids=${(variant as any).inventory_item_id}`
        )) as { inventory_levels: ShopifyInventoryLevel[] };

        inventoryLevels.push(...response.inventory_levels);
      }

      return inventoryLevels;
    } catch (error) {
      console.error(
        `[ShopifyService] Failed to get inventory levels for product ${productId}:`,
        error
      );
      throw error;
    }
  }
}
