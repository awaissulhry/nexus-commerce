/**
 * Shopify Sync Service
 * Handles product, inventory, and order synchronization with parent-child hierarchy
 */

import prisma from "../../db.js";
import { ShopifyEnhancedService, type ShopifyProductSync, type ShopifyOrderSync } from "../marketplaces/shopify-enhanced.service.js";
import { MarketplaceSyncError } from "../../utils/error-handler.js";
import type { ShopifyConfig } from "../../types/marketplace.js";

export interface ShopifySyncResult {
  success: boolean;
  productsCreated: number;
  productsUpdated: number;
  variantsCreated: number;
  variantsUpdated: number;
  inventoryUpdated: number;
  ordersCreated: number;
  ordersUpdated: number;
  errors: Array<{ id: string; error: string }>;
}

export interface ShopifyInventorySyncResult {
  success: boolean;
  updated: number;
  failed: number;
  errors: Array<{ variantId: string; error: string }>;
}

export interface ShopifyOrderSyncResult {
  success: boolean;
  created: number;
  updated: number;
  errors: Array<{ orderId: string; error: string }>;
}

/**
 * Shopify Sync Service
 * Manages bidirectional synchronization with Shopify
 */
export class ShopifySyncService {
  private shopifyService: ShopifyEnhancedService;

  constructor(config: ShopifyConfig) {
    this.shopifyService = new ShopifyEnhancedService(config);
  }

  /**
   * Sync all products from Shopify to Nexus
   */
  async syncProducts(limit: number = 100): Promise<ShopifySyncResult> {
    const result: ShopifySyncResult = {
      success: true,
      productsCreated: 0,
      productsUpdated: 0,
      variantsCreated: 0,
      variantsUpdated: 0,
      inventoryUpdated: 0,
      ordersCreated: 0,
      ordersUpdated: 0,
      errors: [],
    };

    try {
      console.log("[ShopifySyncService] Starting product sync from Shopify…");

      let hasNextPage = true;
      let after: string | undefined;

      while (hasNextPage) {
        try {
          const { products, pageInfo } = await this.shopifyService.getAllProducts(limit, after);

          for (const shopifyProduct of products) {
            try {
              const syncResult = await this.syncProduct(shopifyProduct);
              result.productsCreated += syncResult.productsCreated;
              result.productsUpdated += syncResult.productsUpdated;
              result.variantsCreated += syncResult.variantsCreated;
              result.variantsUpdated += syncResult.variantsUpdated;
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              result.errors.push({
                id: shopifyProduct.productId,
                error: message,
              });
              result.success = false;
            }
          }

          hasNextPage = pageInfo.hasNextPage;
          after = pageInfo.endCursor;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error("[ShopifySyncService] Error fetching products:", message);
          result.success = false;
          break;
        }
      }

      console.log(
        `[ShopifySyncService] Product sync complete: ${result.productsCreated} created, ${result.productsUpdated} updated`
      );

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[ShopifySyncService] Product sync failed:", message);
      result.success = false;
      return result;
    }
  }

  /**
   * Sync a single product from Shopify
   */
  private async syncProduct(shopifyProduct: ShopifyProductSync): Promise<{
    productsCreated: number;
    productsUpdated: number;
    variantsCreated: number;
    variantsUpdated: number;
  }> {
    const result = {
      productsCreated: 0,
      productsUpdated: 0,
      variantsCreated: 0,
      variantsUpdated: 0,
    };

    try {
      if (shopifyProduct.isParent && shopifyProduct.variationTheme) {
        // Parent-child product structure
        const parentSku = shopifyProduct.sku;

        // Upsert parent product
        const parent = await (prisma as any).product.upsert({
          where: { sku: parentSku },
          update: {
            name: shopifyProduct.title,
            shopifyProductId: shopifyProduct.productId,
            variationTheme: shopifyProduct.variationTheme,
            status: "ACTIVE",
          },
          create: {
            sku: parentSku,
            name: shopifyProduct.title,
            basePrice: 0, // Parent price is derived from variants
            totalStock: 0, // Parent stock is sum of variants
            shopifyProductId: shopifyProduct.productId,
            variationTheme: shopifyProduct.variationTheme,
            status: "ACTIVE",
          },
        });

        result.productsCreated += parent.createdAt === parent.updatedAt ? 1 : 0;
        result.productsUpdated += parent.createdAt !== parent.updatedAt ? 1 : 0;

        // Sync variants
        let totalStock = 0;
        for (const variant of shopifyProduct.variants) {
          const variantResult = await this.syncVariant(parent.id, variant, shopifyProduct);
          result.variantsCreated += variantResult.created ? 1 : 0;
          result.variantsUpdated += variantResult.updated ? 1 : 0;
          totalStock += variant.inventory;
        }

        // Update parent total stock
        await (prisma as any).product.update({
          where: { id: parent.id },
          data: { totalStock },
        });
      } else {
        // Standalone product
        const variant = shopifyProduct.variants[0];
        if (!variant) {
          throw new Error("No variants found for standalone product");
        }

        const product = await (prisma as any).product.upsert({
          where: { sku: variant.sku },
          update: {
            name: shopifyProduct.title,
            basePrice: variant.price,
            totalStock: variant.inventory,
            shopifyProductId: shopifyProduct.productId,
            status: "ACTIVE",
          },
          create: {
            sku: variant.sku,
            name: shopifyProduct.title,
            basePrice: variant.price,
            totalStock: variant.inventory,
            shopifyProductId: shopifyProduct.productId,
            status: "ACTIVE",
          },
        });

        result.productsCreated += product.createdAt === product.updatedAt ? 1 : 0;
        result.productsUpdated += product.createdAt !== product.updatedAt ? 1 : 0;

        // Create channel listing for standalone product
        await this.createChannelListing(product.id, variant, shopifyProduct);
      }

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to sync product ${shopifyProduct.productId}: ${message}`);
    }
  }

  /**
   * Sync a product variant
   */
  private async syncVariant(
    parentId: string,
    variant: ShopifyProductSync["variants"][0],
    shopifyProduct: ShopifyProductSync
  ): Promise<{ created: boolean; updated: boolean }> {
    try {
      const existingVariant = await (prisma as any).productVariation.findUnique({
        where: { sku: variant.sku },
      });

      const isNew = !existingVariant;

      const variantData = {
        sku: variant.sku,
        price: variant.price,
        stock: variant.inventory,
        shopifyVariantId: variant.variantId,
        variationAttributes: variant.selectedOptions,
      };

      if (isNew) {
        await (prisma as any).productVariation.create({
          data: {
            ...variantData,
            productId: parentId,
          },
        });
      } else {
        await (prisma as any).productVariation.update({
          where: { sku: variant.sku },
          data: variantData,
        });
      }

      // Create channel listing
      await this.createChannelListing(parentId, variant, shopifyProduct);

      return { created: isNew, updated: !isNew };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to sync variant ${variant.sku}: ${message}`);
    }
  }

  /**
   * Create or update channel listing for a variant
   */
  private async createChannelListing(
    productId: string,
    variant: ShopifyProductSync["variants"][0],
    shopifyProduct: ShopifyProductSync
  ): Promise<void> {
    try {
      // Find the variant in database
      const dbVariant = await (prisma as any).productVariation.findUnique({
        where: { sku: variant.sku },
      });

      if (!dbVariant) {
        return; // Variant not yet created
      }

      // Upsert channel listing
      await (prisma as any).variantChannelListing.upsert({
        where: {
          variantId_channelId: {
            variantId: dbVariant.id,
            channelId: "SHOPIFY",
          },
        },
        update: {
          channelVariantId: variant.variantId,
          channelSku: variant.sku,
          channelPrice: variant.price,
          channelQuantity: variant.inventory,
          lastSyncedAt: new Date(),
          lastSyncStatus: "SUCCESS",
        },
        create: {
          variantId: dbVariant.id,
          channelId: "SHOPIFY",
          channelVariantId: variant.variantId,
          channelSku: variant.sku,
          channelPrice: variant.price,
          channelQuantity: variant.inventory,
          listingStatus: "ACTIVE",
          lastSyncedAt: new Date(),
          lastSyncStatus: "SUCCESS",
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[ShopifySyncService] Failed to create channel listing: ${message}`);
    }
  }

  /**
   * Sync inventory from Nexus to Shopify
   */
  async syncInventoryToShopify(variantId: string, quantity: number): Promise<void> {
    try {
      const variant = await (prisma as any).productVariation.findUnique({
        where: { id: variantId },
        include: { channelListings: true },
      });

      if (!variant) {
        throw new Error(`Variant ${variantId} not found`);
      }

      const shopifyListing = variant.channelListings.find(
        (cl: any) => cl.channelId === "SHOPIFY"
      );

      if (!shopifyListing || !shopifyListing.channelVariantId) {
        throw new Error(`No Shopify listing found for variant ${variantId}`);
      }

      // Get default location ID
      const locationId = await this.shopifyService.getDefaultLocationId();

      // Extract inventory item ID from variant ID (Shopify format: gid://shopify/ProductVariant/123)
      const inventoryItemId = shopifyListing.channelVariantId.replace(
        /gid:\/\/shopify\/ProductVariant\/(\d+)/,
        "gid://shopify/InventoryItem/$1"
      );

      // Calculate adjustment
      const currentQuantity = shopifyListing.channelQuantity || 0;
      const adjustment = quantity - currentQuantity;

      if (adjustment !== 0) {
        await this.shopifyService.updateInventory(inventoryItemId, locationId, adjustment);

        // Update channel listing
        await (prisma as any).variantChannelListing.update({
          where: { id: shopifyListing.id },
          data: {
            channelQuantity: quantity,
            lastSyncedAt: new Date(),
            lastSyncStatus: "SUCCESS",
          },
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new MarketplaceSyncError(
        "SHOPIFY",
        "NETWORK",
        `Failed to sync inventory to Shopify: ${message}`,
        { variantId, quantity }
      );
    }
  }

  /**
   * Sync inventory from Shopify to Nexus
   */
  async syncInventoryFromShopify(productId: string): Promise<ShopifyInventorySyncResult> {
    const result: ShopifyInventorySyncResult = {
      success: true,
      updated: 0,
      failed: 0,
      errors: [],
    };

    try {
      console.log(`[ShopifySyncService] Syncing inventory from Shopify for product ${productId}…`);

      const inventoryLevels = await this.shopifyService.getInventoryLevels(productId);

      for (const level of inventoryLevels) {
        try {
          // Find variant by Shopify inventory item ID
          const variant = await (prisma as any).productVariation.findFirst({
            where: {
              channelListings: {
                some: {
                  channelId: "SHOPIFY",
                  channelVariantId: {
                    contains: level.inventoryItemId,
                  },
                },
              },
            },
          });

          if (variant) {
            await (prisma as any).productVariation.update({
              where: { id: variant.id },
              data: { stock: level.available },
            });

            result.updated++;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          result.errors.push({
            variantId: level.inventoryItemId,
            error: message,
          });
          result.failed++;
          result.success = false;
        }
      }

      console.log(
        `[ShopifySyncService] Inventory sync complete: ${result.updated} updated, ${result.failed} failed`
      );

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[ShopifySyncService] Inventory sync failed:", message);
      result.success = false;
      return result;
    }
  }

  /**
   * Sync orders from Shopify to Nexus
   */
  async syncOrders(limit: number = 50): Promise<ShopifyOrderSyncResult> {
    const result: ShopifyOrderSyncResult = {
      success: true,
      created: 0,
      updated: 0,
      errors: [],
    };

    try {
      console.log("[ShopifySyncService] Starting order sync from Shopify…");

      let hasNextPage = true;
      let after: string | undefined;

      while (hasNextPage) {
        try {
          const { orders, pageInfo } = await this.shopifyService.getOrders(limit, after);

          for (const shopifyOrder of orders) {
            try {
              const syncResult = await this.syncOrder(shopifyOrder);
              result.created += syncResult.created ? 1 : 0;
              result.updated += syncResult.updated ? 1 : 0;
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              result.errors.push({
                orderId: shopifyOrder.orderId,
                error: message,
              });
              result.success = false;
            }
          }

          hasNextPage = pageInfo.hasNextPage;
          after = pageInfo.endCursor;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error("[ShopifySyncService] Error fetching orders:", message);
          result.success = false;
          break;
        }
      }

      console.log(
        `[ShopifySyncService] Order sync complete: ${result.created} created, ${result.updated} updated`
      );

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[ShopifySyncService] Order sync failed:", message);
      result.success = false;
      return result;
    }
  }

  /**
   * Sync a single order from Shopify
   */
  private async syncOrder(shopifyOrder: ShopifyOrderSync): Promise<{
    created: boolean;
    updated: boolean;
  }> {
    try {
      const existingOrder = await (prisma as any).order.findUnique({
        where: { amazonOrderId: shopifyOrder.orderId },
      });

      const isNew = !existingOrder;

      const orderData = {
        amazonOrderId: shopifyOrder.orderId,
        status: shopifyOrder.fulfillmentStatus,
        totalAmount: shopifyOrder.totalPrice,
        buyerName: shopifyOrder.email,
        shippingAddress: shopifyOrder.shippingAddress,
        trackingNumber: shopifyOrder.fulfillments[0]?.trackingNumber,
        shippedAt: shopifyOrder.fulfillments[0]?.createdAt
          ? new Date(shopifyOrder.fulfillments[0].createdAt)
          : undefined,
      };

      let order;
      if (isNew) {
        order = await (prisma as any).order.create({
          data: {
            ...orderData,
            channelId: "SHOPIFY", // Use channel ID as placeholder
          },
        });
      } else {
        order = await (prisma as any).order.update({
          where: { id: existingOrder.id },
          data: orderData,
        });
      }

      // Sync order items
      for (const item of shopifyOrder.items) {
        await (prisma as any).orderItem.upsert({
          where: {
            orderId_sku: {
              orderId: order.id,
              sku: item.sku,
            },
          },
          update: {
            quantity: item.quantity,
            price: item.price,
          },
          create: {
            orderId: order.id,
            sku: item.sku,
            quantity: item.quantity,
            price: item.price,
          },
        });
      }

      return { created: isNew, updated: !isNew };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to sync order ${shopifyOrder.orderId}: ${message}`);
    }
  }

  /**
   * Create fulfillment for an order
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
    try {
      return await this.shopifyService.createFulfillment(orderId, lineItemIds, trackingInfo);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new MarketplaceSyncError(
        "SHOPIFY",
        "NETWORK",
        `Failed to create fulfillment: ${message}`,
        { orderId, lineItemIds }
      );
    }
  }
}
