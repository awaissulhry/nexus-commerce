/**
 * WooCommerce Sync Service
 * Handles product, inventory, and order synchronization with parent-child hierarchy
 */

import prisma from "../../db.js";
import { WooCommerceService, type WooCommerceProductSync, type WooCommerceOrderSync } from "../marketplaces/woocommerce.service.js";
import { MarketplaceSyncError } from "../../utils/error-handler.js";
import type { WooCommerceConfig } from "../../types/marketplace.js";

export interface WooCommerceSyncResult {
  success: boolean;
  productsCreated: number;
  productsUpdated: number;
  variantsCreated: number;
  variantsUpdated: number;
  inventoryUpdated: number;
  ordersCreated: number;
  ordersUpdated: number;
  errors: Array<{ id: string | number; error: string }>;
}

export interface WooCommerceInventorySyncResult {
  success: boolean;
  updated: number;
  failed: number;
  errors: Array<{ variantId: string; error: string }>;
}

export interface WooCommerceOrderSyncResult {
  success: boolean;
  created: number;
  updated: number;
  errors: Array<{ orderId: number; error: string }>;
}

/**
 * WooCommerce Sync Service
 * Manages bidirectional synchronization with WooCommerce
 */
export class WooCommerceSyncService {
  private woocommerceService: WooCommerceService;

  constructor(config: WooCommerceConfig) {
    this.woocommerceService = new WooCommerceService(config);
  }

  /**
   * Sync all products from WooCommerce to Nexus
   */
  async syncProducts(limit: number = 100): Promise<WooCommerceSyncResult> {
    const result: WooCommerceSyncResult = {
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
      console.log("[WooCommerceSyncService] Starting product sync from WooCommerce…");

      let page = 1;
      let hasNextPage = true;

      while (hasNextPage) {
        try {
          const { products, pageInfo } = await this.woocommerceService.getAllProducts(limit, page);

          for (const wooProduct of products) {
            try {
              const syncResult = await this.syncProduct(wooProduct);
              result.productsCreated += syncResult.productsCreated;
              result.productsUpdated += syncResult.productsUpdated;
              result.variantsCreated += syncResult.variantsCreated;
              result.variantsUpdated += syncResult.variantsUpdated;
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              result.errors.push({
                id: wooProduct.productId,
                error: message,
              });
              result.success = false;
            }
          }

          hasNextPage = pageInfo.hasNextPage;
          page++;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error("[WooCommerceSyncService] Error fetching products:", message);
          result.success = false;
          break;
        }
      }

      console.log(
        `[WooCommerceSyncService] Product sync complete: ${result.productsCreated} created, ${result.productsUpdated} updated`
      );

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[WooCommerceSyncService] Product sync failed:", message);
      result.success = false;
      return result;
    }
  }

  /**
   * Sync a single product from WooCommerce
   */
  private async syncProduct(wooProduct: WooCommerceProductSync): Promise<{
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
      if (wooProduct.isParent && wooProduct.variationTheme && wooProduct.variations.length > 0) {
        // Parent-child product structure
        const parentSku = wooProduct.sku;

        // Upsert parent product
        const parent = await (prisma as any).product.upsert({
          where: { sku: parentSku },
          update: {
            name: wooProduct.title,
            woocommerceProductId: wooProduct.productId,
            variationTheme: wooProduct.variationTheme,
            status: "ACTIVE",
          },
          create: {
            sku: parentSku,
            name: wooProduct.title,
            basePrice: 0, // Parent price is derived from variants
            totalStock: 0, // Parent stock is sum of variants
            woocommerceProductId: wooProduct.productId,
            variationTheme: wooProduct.variationTheme,
            status: "ACTIVE",
          },
        });

        if (!parent.id) {
          result.productsCreated++;
        } else {
          result.productsUpdated++;
        }

        // Sync variants
        let totalStock = 0;
        for (const variant of wooProduct.variations) {
          try {
            const variantResult = await this.syncVariant(parent.id, variant);
            result.variantsCreated += variantResult.created ? 1 : 0;
            result.variantsUpdated += variantResult.updated ? 1 : 0;
            totalStock += variant.stock;
          } catch (error) {
            console.error(
              `[WooCommerceSyncService] Failed to sync variant ${variant.variationId}:`,
              error instanceof Error ? error.message : String(error)
            );
          }
        }

        // Update parent stock
        await (prisma as any).product.update({
          where: { id: parent.id },
          data: { totalStock },
        });
      } else {
        // Simple product (no variations)
        const sku = wooProduct.sku;
        const price = wooProduct.variations.length > 0 ? wooProduct.variations[0].price : 0;
        const stock = wooProduct.variations.length > 0 ? wooProduct.variations[0].stock : 0;

        const product = await (prisma as any).product.upsert({
          where: { sku },
          update: {
            name: wooProduct.title,
            basePrice: price,
            totalStock: stock,
            woocommerceProductId: wooProduct.productId,
            status: "ACTIVE",
          },
          create: {
            sku,
            name: wooProduct.title,
            basePrice: price,
            totalStock: stock,
            woocommerceProductId: wooProduct.productId,
            status: "ACTIVE",
          },
        });

        if (!product.id) {
          result.productsCreated++;
        } else {
          result.productsUpdated++;
        }
      }

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[WooCommerceSyncService] Failed to sync product ${wooProduct.productId}:`,
        message
      );
      throw error;
    }
  }

  /**
   * Sync a single variant
   */
  private async syncVariant(
    productId: string,
    variant: WooCommerceProductSync["variations"][0]
  ): Promise<{ created: boolean; updated: boolean }> {
    try {
      const existingVariant = await (prisma as any).productVariation.findUnique({
        where: { sku: variant.sku },
      });

      if (existingVariant) {
        await (prisma as any).productVariation.update({
          where: { id: existingVariant.id },
          data: {
            price: variant.price,
            stock: variant.stock,
            variationAttributes: variant.attributes,
            woocommerceVariationId: variant.variationId,
            isActive: true,
          },
        });
        return { created: false, updated: true };
      } else {
        await (prisma as any).productVariation.create({
          data: {
            productId,
            sku: variant.sku,
            price: variant.price,
            stock: variant.stock,
            variationAttributes: variant.attributes,
            woocommerceVariationId: variant.variationId,
            isActive: true,
          },
        });
        return { created: true, updated: false };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[WooCommerceSyncService] Failed to sync variant ${variant.variationId}:`,
        message
      );
      throw error;
    }
  }

  /**
   * Sync inventory from Nexus to WooCommerce
   */
  async syncInventoryToWooCommerce(variantId: string, quantity: number): Promise<void> {
    try {
      const variant = await (prisma as any).productVariation.findUnique({
        where: { id: variantId },
        include: { product: true },
      });

      if (!variant || !variant.woocommerceVariationId) {
        throw new Error(`Variant ${variantId} not found or not synced to WooCommerce`);
      }

      const product = variant.product;
      if (!product.woocommerceProductId) {
        throw new Error(`Product ${product.id} not synced to WooCommerce`);
      }

      // Update variation stock in WooCommerce
      await this.woocommerceService.updateVariationStock(
        product.woocommerceProductId,
        variant.woocommerceVariationId,
        quantity
      );

      console.log(
        `[WooCommerceSyncService] Updated inventory for variant ${variantId} to ${quantity}`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[WooCommerceSyncService] Failed to sync inventory to WooCommerce:", message);
      throw error;
    }
  }

  /**
   * Sync inventory from WooCommerce to Nexus
   */
  async syncInventoryFromWooCommerce(productId: string): Promise<WooCommerceInventorySyncResult> {
    const result: WooCommerceInventorySyncResult = {
      success: true,
      updated: 0,
      failed: 0,
      errors: [],
    };

    try {
      const product = await (prisma as any).product.findUnique({
        where: { id: productId },
        include: { variations: true },
      });

      if (!product || !product.woocommerceProductId) {
        throw new Error(`Product ${productId} not found or not synced to WooCommerce`);
      }

      // Fetch product from WooCommerce
      const wooProduct = await this.woocommerceService.getProduct(product.woocommerceProductId);

      // Update variant stocks
      for (const variant of wooProduct.variations) {
        try {
          const dbVariant = product.variations.find((v) => v.woocommerceVariationId === variant.variationId);
          if (dbVariant) {
            await (prisma as any).productVariation.update({
              where: { id: dbVariant.id },
              data: { stock: variant.stock },
            });
            result.updated++;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          result.errors.push({
            variantId: variant.variationId.toString(),
            error: message,
          });
          result.failed++;
          result.success = false;
        }
      }

      // Update parent stock
      const totalStock = wooProduct.variations.reduce((sum, v) => sum + v.stock, 0);
      await (prisma as any).product.update({
        where: { id: productId },
        data: { totalStock },
      });

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[WooCommerceSyncService] Failed to sync inventory from WooCommerce:", message);
      result.success = false;
      return result;
    }
  }

  /**
   * Sync all orders from WooCommerce to Nexus
   */
  async syncOrders(limit: number = 100): Promise<WooCommerceOrderSyncResult> {
    const result: WooCommerceOrderSyncResult = {
      success: true,
      created: 0,
      updated: 0,
      errors: [],
    };

    try {
      console.log("[WooCommerceSyncService] Starting order sync from WooCommerce…");

      let page = 1;
      let hasNextPage = true;

      while (hasNextPage) {
        try {
          const { orders, pageInfo } = await this.woocommerceService.getOrders(limit, page);

          for (const wooOrder of orders) {
            try {
              const syncResult = await this.syncOrder(wooOrder);
              if (syncResult.created) {
                result.created++;
              } else if (syncResult.updated) {
                result.updated++;
              }
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              result.errors.push({
                orderId: wooOrder.orderId,
                error: message,
              });
              result.success = false;
            }
          }

          hasNextPage = pageInfo.hasNextPage;
          page++;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error("[WooCommerceSyncService] Error fetching orders:", message);
          result.success = false;
          break;
        }
      }

      console.log(
        `[WooCommerceSyncService] Order sync complete: ${result.created} created, ${result.updated} updated`
      );

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[WooCommerceSyncService] Order sync failed:", message);
      result.success = false;
      return result;
    }
  }

  /**
   * Sync a single order from WooCommerce
   */
  private async syncOrder(wooOrder: WooCommerceOrderSync): Promise<{ created: boolean; updated: boolean }> {
    try {
      const existingOrder = await (prisma as any).order.findFirst({
        where: { amazonOrderId: `woo_${wooOrder.orderId}` },
      });

      const orderData = {
        amazonOrderId: `woo_${wooOrder.orderId}`,
        status: this.mapOrderStatus(wooOrder.status),
        totalAmount: wooOrder.totalAmount,
        buyerName: `${wooOrder.shippingAddress.firstName} ${wooOrder.shippingAddress.lastName}`,
        shippingAddress: wooOrder.shippingAddress,
        channelId: await this.getOrCreateWooCommerceChannel(),
      };

      if (existingOrder) {
        await (prisma as any).order.update({
          where: { id: existingOrder.id },
          data: orderData,
        });

        // Update order items
        await (prisma as any).orderItem.deleteMany({
          where: { orderId: existingOrder.id },
        });

        for (const item of wooOrder.lineItems) {
          await (prisma as any).orderItem.create({
            data: {
              orderId: existingOrder.id,
              sku: item.sku,
              quantity: item.quantity,
              price: item.price,
            },
          });
        }

        return { created: false, updated: true };
      } else {
        const order = await (prisma as any).order.create({
          data: orderData,
        });

        // Create order items
        for (const item of wooOrder.lineItems) {
          await (prisma as any).orderItem.create({
            data: {
              orderId: order.id,
              sku: item.sku,
              quantity: item.quantity,
              price: item.price,
            },
          });
        }

        return { created: true, updated: false };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[WooCommerceSyncService] Failed to sync order ${wooOrder.orderId}:`,
        message
      );
      throw error;
    }
  }

  /**
   * Update order status in WooCommerce
   */
  async updateOrderStatus(orderId: number, status: string): Promise<void> {
    try {
      await this.woocommerceService.updateOrderStatus(orderId, status);
      console.log(`[WooCommerceSyncService] Updated order ${orderId} status to ${status}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[WooCommerceSyncService] Failed to update order status:", message);
      throw error;
    }
  }

  /**
   * Add fulfillment note to order
   */
  async addFulfillmentNote(orderId: number, trackingNumber?: string): Promise<void> {
    try {
      const note = trackingNumber
        ? `Order fulfilled. Tracking: ${trackingNumber}`
        : "Order fulfilled";

      await this.woocommerceService.addOrderNote(orderId, note, false);
      console.log(`[WooCommerceSyncService] Added fulfillment note to order ${orderId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[WooCommerceSyncService] Failed to add fulfillment note:", message);
      throw error;
    }
  }

  /**
   * Map WooCommerce order status to Nexus OrderStatus enum.
   *
   * O.1: prior version emitted 'COMPLETED' and 'FAILED' string literals
   * that don't exist in the enum, silently failing every WooCommerce
   * order ingest. Now maps to real enum values, including the new
   * AWAITING_PAYMENT / ON_HOLD / REFUNDED that O.1 added. Woo
   * 'completed' (= delivered to customer) → DELIVERED. 'failed'
   * (payment failed) → CANCELLED. 'pending' (= awaiting payment in
   * WooCommerce vocabulary) → AWAITING_PAYMENT, distinct from our
   * generic PENDING.
   */
  private mapOrderStatus(wooStatus: string): string {
    const statusMap: Record<string, string> = {
      pending: "AWAITING_PAYMENT",
      processing: "PROCESSING",
      "on-hold": "ON_HOLD",
      completed: "DELIVERED",
      cancelled: "CANCELLED",
      refunded: "REFUNDED",
      failed: "CANCELLED",
    };
    return statusMap[wooStatus] || "PENDING";
  }

  /**
   * Get or create WooCommerce channel
   */
  private async getOrCreateWooCommerceChannel(): Promise<string> {
    let channel = await (prisma as any).channel.findFirst({
      where: { type: "WOOCOMMERCE" },
    });

    if (!channel) {
      channel = await (prisma as any).channel.create({
        data: {
          type: "WOOCOMMERCE",
          name: "WooCommerce",
          credentials: "encrypted",
        },
      });
    }

    return channel.id;
  }
}
