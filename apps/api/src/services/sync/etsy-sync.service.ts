/**
 * Etsy Sync Service
 * Handles product, inventory, and order synchronization with parent-child hierarchy
 */

import prisma from "../../db.js";
import {
  EtsyService,
  type EtsyListingSync,
  type EtsyOrderSync,
} from "../marketplaces/etsy.service.js";
import { MarketplaceSyncError } from "../../utils/error-handler.js";
import type { EtsyConfig } from "../../types/marketplace.js";

export interface EstySyncResult {
  success: boolean;
  listingsCreated: number;
  listingsUpdated: number;
  variantsCreated: number;
  variantsUpdated: number;
  inventoryUpdated: number;
  ordersCreated: number;
  ordersUpdated: number;
  errors: Array<{ id: string | number; error: string }>;
}

export interface EstyInventorySyncResult {
  success: boolean;
  updated: number;
  failed: number;
  errors: Array<{ variantId: string; error: string }>;
}

export interface EstyOrderSyncResult {
  success: boolean;
  created: number;
  updated: number;
  errors: Array<{ orderId: number; error: string }>;
}

/**
 * Etsy Sync Service
 * Manages bidirectional synchronization with Etsy
 */
export class EstySyncService {
  private estyService: EtsyService;

  constructor(config: EtsyConfig) {
    this.estyService = new EtsyService(config);
  }

  /**
   * Sync all listings from Etsy to Nexus
   */
  async syncListings(limit: number = 100): Promise<EstySyncResult> {
    const result: EstySyncResult = {
      success: true,
      listingsCreated: 0,
      listingsUpdated: 0,
      variantsCreated: 0,
      variantsUpdated: 0,
      inventoryUpdated: 0,
      ordersCreated: 0,
      ordersUpdated: 0,
      errors: [],
    };

    try {
      console.log("[EstySyncService] Starting listing sync from Etsy…");

      let offset = 0;
      let hasNextPage = true;

      while (hasNextPage) {
        try {
          const { listings, pageInfo } = await this.estyService.getAllListings(
            limit,
            offset
          );

          for (const estyListing of listings) {
            try {
              const syncResult = await this.syncListing(estyListing);
              result.listingsCreated += syncResult.listingsCreated;
              result.listingsUpdated += syncResult.listingsUpdated;
              result.variantsCreated += syncResult.variantsCreated;
              result.variantsUpdated += syncResult.variantsUpdated;
            } catch (error) {
              const message =
                error instanceof Error ? error.message : String(error);
              result.errors.push({
                id: estyListing.listingId,
                error: message,
              });
              result.success = false;
            }
          }

          hasNextPage = pageInfo.hasNextPage;
          offset = pageInfo.offset + limit;
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          console.error("[EstySyncService] Error fetching listings:", message);
          result.success = false;
          break;
        }
      }

      console.log(
        `[EstySyncService] Listing sync complete: ${result.listingsCreated} created, ${result.listingsUpdated} updated`
      );
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[EstySyncService] Listing sync failed:", message);
      result.success = false;
      return result;
    }
  }

  /**
   * Sync a single listing
   */
  private async syncListing(
    estyListing: EtsyListingSync
  ): Promise<EstySyncResult> {
    const result: EstySyncResult = {
      success: true,
      listingsCreated: 0,
      listingsUpdated: 0,
      variantsCreated: 0,
      variantsUpdated: 0,
      inventoryUpdated: 0,
      ordersCreated: 0,
      ordersUpdated: 0,
      errors: [],
    };

    try {
      // Check if product exists
      let product = await (prisma as any).product.findFirst({
        where: { etsyListingId: estyListing.listingId },
        include: { variations: true },
      });

      if (!product) {
        // Create new product
        product = await (prisma as any).product.create({
          data: {
            sku: estyListing.sku,
            name: estyListing.title,
            basePrice: estyListing.price,
            totalStock: estyListing.quantity,
            etsyListingId: estyListing.listingId,
            variationTheme: estyListing.variationTheme,
            status: estyListing.state === "active" ? "ACTIVE" : "INACTIVE",
          },
          include: { variations: true },
        });
        result.listingsCreated++;
      } else {
        // Update existing product
        product = await (prisma as any).product.update({
          where: { id: product.id },
          data: {
            name: estyListing.title,
            basePrice: estyListing.price,
            totalStock: estyListing.quantity,
            variationTheme: estyListing.variationTheme,
            status: estyListing.state === "active" ? "ACTIVE" : "INACTIVE",
            updatedAt: new Date(),
          },
          include: { variations: true },
        });
        result.listingsUpdated++;
      }

      // Sync variations if parent
      if (estyListing.isParent && estyListing.variations.length > 0) {
        for (const estyVariation of estyListing.variations) {
          try {
            const variantResult = await this.syncVariant(
              product.id,
              estyVariation
            );
            result.variantsCreated += variantResult.created;
            result.variantsUpdated += variantResult.updated;
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            result.errors.push({
              id: estyVariation.variationId,
              error: message,
            });
            result.success = false;
          }
        }
      }

      // Create channel listing
      const channel = await (prisma as any).channel.findFirst({
        where: { type: "ETSY" },
      });

      if (channel) {
        const existingListing = await (prisma as any).listing.findFirst({
          where: { productId: product.id, channelId: channel.id },
        });

        if (!existingListing) {
          await (prisma as any).listing.create({
            data: {
              productId: product.id,
              channelId: channel.id,
              channelPrice: estyListing.price,
            },
          });
        } else {
          await (prisma as any).listing.update({
            where: { id: existingListing.id },
            data: { channelPrice: estyListing.price },
          });
        }
      }

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new MarketplaceSyncError(
        "ETSY",
        "VALIDATION",
        `Failed to sync listing: ${message}`,
        { listingId: estyListing.listingId }
      );
    }
  }

  /**
   * Sync a single variant
   */
  private async syncVariant(
    productId: string,
    estyVariation: any
  ): Promise<{ created: number; updated: number }> {
    let variant = await (prisma as any).productVariation.findFirst({
      where: { etsyListingId: estyVariation.variationId },
    });

    if (!variant) {
      await (prisma as any).productVariation.create({
        data: {
          productId,
          sku: estyVariation.sku,
          price: estyVariation.price,
          stock: estyVariation.quantity,
          etsyListingId: estyVariation.variationId,
          etsySku: estyVariation.sku,
          variationAttributes: estyVariation.attributes,
        },
      });
      return { created: 1, updated: 0 };
    } else {
      await (prisma as any).productVariation.update({
        where: { id: variant.id },
        data: {
          price: estyVariation.price,
          stock: estyVariation.quantity,
          variationAttributes: estyVariation.attributes,
          updatedAt: new Date(),
        },
      });
      return { created: 0, updated: 1 };
    }
  }

  /**
   * Sync inventory to Etsy
   */
  async syncInventoryToEtsy(
    variantId: string,
    quantity: number
  ): Promise<void> {
    try {
      const variant = await (prisma as any).productVariation.findUnique({
        where: { id: variantId },
        include: { product: true },
      });

      if (!variant || !variant.product.etsyListingId) {
        throw new Error("Variant or Etsy listing not found");
      }

      if (variant.etsyListingId) {
        // Update variation quantity
        await this.estyService.updateVariationQuantity(
          variant.product.etsyListingId,
          variant.etsyListingId,
          quantity
        );
      } else {
        // Update listing quantity
        await this.estyService.updateListingQuantity(
          variant.product.etsyListingId,
          quantity
        );
      }

      console.log(
        `[EstySyncService] Synced inventory to Etsy: variant ${variantId} = ${quantity}`
      );
    } catch (error) {
      throw new MarketplaceSyncError(
        "ETSY",
        "VALIDATION",
        `Failed to sync inventory to Etsy: ${error instanceof Error ? error.message : String(error)}`,
        { variantId, quantity }
      );
    }
  }

  /**
   * Sync inventory from Etsy
   */
  async syncInventoryFromEtsy(
    productId: string
  ): Promise<EstyInventorySyncResult> {
    const result: EstyInventorySyncResult = {
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

      if (!product || !product.etsyListingId) {
        throw new Error("Product or Etsy listing not found");
      }

      const estyListing = await this.estyService.getListing(
        product.etsyListingId
      );

      // Update product stock
      let totalStock = 0;

      if (estyListing.isParent && estyListing.variations.length > 0) {
        // Update variant stocks
        for (const estyVariation of estyListing.variations) {
          try {
            const variant = product.variations.find(
              (v) => v.etsyListingId === estyVariation.variationId
            );

            if (variant) {
              await (prisma as any).productVariation.update({
                where: { id: variant.id },
                data: { stock: estyVariation.quantity },
              });
              totalStock += estyVariation.quantity;
              result.updated++;
            }
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            result.errors.push({
              variantId: String(estyVariation.variationId),
              error: message,
            });
            result.failed++;
            result.success = false;
          }
        }
      } else {
        // Update product stock directly
        totalStock = estyListing.quantity;
        result.updated++;
      }

      // Update product total stock
      await (prisma as any).product.update({
        where: { id: productId },
        data: { totalStock },
      });

      console.log(
        `[EstySyncService] Synced inventory from Etsy: product ${productId} = ${totalStock}`
      );
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[EstySyncService] Inventory sync failed:", message);
      result.success = false;
      return result;
    }
  }

  /**
   * Sync all orders from Etsy to Nexus
   */
  async syncOrders(limit: number = 100): Promise<EstyOrderSyncResult> {
    const result: EstyOrderSyncResult = {
      success: true,
      created: 0,
      updated: 0,
      errors: [],
    };

    try {
      console.log("[EstySyncService] Starting order sync from Etsy…");

      let offset = 0;
      let hasNextPage = true;

      while (hasNextPage) {
        try {
          const { receipts, pageInfo } = await this.estyService.getReceipts(
            limit,
            offset
          );

          for (const estyOrder of receipts) {
            try {
              const syncResult = await this.syncOrder(estyOrder);
              result.created += syncResult.created;
              result.updated += syncResult.updated;
            } catch (error) {
              const message =
                error instanceof Error ? error.message : String(error);
              result.errors.push({
                orderId: estyOrder.orderId,
                error: message,
              });
              result.success = false;
            }
          }

          hasNextPage = pageInfo.hasNextPage;
          offset = pageInfo.offset + limit;
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          console.error("[EstySyncService] Error fetching orders:", message);
          result.success = false;
          break;
        }
      }

      console.log(
        `[EstySyncService] Order sync complete: ${result.created} created, ${result.updated} updated`
      );
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[EstySyncService] Order sync failed:", message);
      result.success = false;
      return result;
    }
  }

  /**
   * Sync a single order
   */
  private async syncOrder(estyOrder: EtsyOrderSync): Promise<{ created: number; updated: number }> {
    try {
      // Check if order exists
      let order = await (prisma as any).order.findFirst({
        where: { amazonOrderId: `ETSY-${estyOrder.orderId}` },
      });

      // Get or create Etsy channel
      let channel = await (prisma as any).channel.findFirst({
        where: { type: "ETSY" },
      });

      if (!channel) {
        channel = await (prisma as any).channel.create({
          data: {
            type: "ETSY",
            name: "Etsy",
            credentials: "{}",
          },
        });
      }

      if (!order) {
        // Create new order
        order = await (prisma as any).order.create({
          data: {
            amazonOrderId: `ETSY-${estyOrder.orderId}`,
            status: estyOrder.status,
            totalAmount: estyOrder.totalAmount,
            channelId: channel.id,
            buyerName: estyOrder.buyerName,
            shippingAddress: estyOrder.shippingAddress,
          },
        });

        // Create order items
        for (const lineItem of estyOrder.lineItems) {
          await (prisma as any).orderItem.create({
            data: {
              orderId: order.id,
              sku: lineItem.sku,
              quantity: lineItem.quantity,
              price: lineItem.price,
            },
          });
        }

        return { created: 1, updated: 0 };
      } else {
        // Update existing order
        await (prisma as any).order.update({
          where: { id: order.id },
          data: {
            status: estyOrder.status,
            updatedAt: new Date(),
          },
        });

        return { created: 0, updated: 1 };
      }
    } catch (error) {
      throw new MarketplaceSyncError(
        "ETSY",
        "VALIDATION",
        `Failed to sync order: ${error instanceof Error ? error.message : String(error)}`,
        { orderId: estyOrder.orderId }
      );
    }
  }

  /**
   * Update order status
   */
  async updateOrderStatus(orderId: string, status: string): Promise<void> {
    try {
      const order = await (prisma as any).order.findUnique({
        where: { id: orderId },
      });

      if (!order) {
        throw new Error("Order not found");
      }

      // Extract Etsy receipt ID from amazonOrderId
      const estyReceiptId = parseInt(order.amazonOrderId.replace("ETSY-", ""));

      // Update in Etsy
      const wasShipped = status === "SHIPPED" || status === "DELIVERED";
      await this.estyService.updateReceiptStatus(estyReceiptId, wasShipped);

      // Update in database
      await (prisma as any).order.update({
        where: { id: orderId },
        data: { status, updatedAt: new Date() },
      });

      console.log(
        `[EstySyncService] Updated order status: ${orderId} = ${status}`
      );
    } catch (error) {
      throw new MarketplaceSyncError(
        "ETSY",
        "VALIDATION",
        `Failed to update order status: ${error instanceof Error ? error.message : String(error)}`,
        { orderId, status }
      );
    }
  }

  /**
   * Add fulfillment note to order
   */
  async addFulfillmentNote(
    orderId: string,
    trackingNumber?: string
  ): Promise<void> {
    try {
      const order = await (prisma as any).order.findUnique({
        where: { id: orderId },
      });

      if (!order) {
        throw new Error("Order not found");
      }

      // Extract Etsy receipt ID from amazonOrderId
      const estyReceiptId = parseInt(order.amazonOrderId.replace("ETSY-", ""));

      // Update in Etsy
      await this.estyService.updateReceiptStatus(
        estyReceiptId,
        true,
        trackingNumber
      );

      // Update in database
      await (prisma as any).order.update({
        where: { id: orderId },
        data: {
          trackingNumber,
          shippedAt: new Date(),
          updatedAt: new Date(),
        },
      });

      console.log(
        `[EstySyncService] Added fulfillment note: ${orderId} = ${trackingNumber}`
      );
    } catch (error) {
      throw new MarketplaceSyncError(
        "ETSY",
        "VALIDATION",
        `Failed to add fulfillment note: ${error instanceof Error ? error.message : String(error)}`,
        { orderId, trackingNumber }
      );
    }
  }
}
