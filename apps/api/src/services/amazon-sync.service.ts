import prisma from "../db.js";
import { logger } from "../utils/logger.js";

interface AmazonProduct {
  asin: string;
  parentAsin?: string;
  title: string;
  sku: string;
  price?: number;
  stock?: number;
  fulfillmentChannel?: string;
  shippingTemplate?: string;
  variations?: AmazonProduct[];
}

interface SyncResult {
  syncId: string;
  status: "success" | "partial" | "failed";
  totalProcessed: number;
  parentsCreated: number;
  childrenCreated: number;
  parentsUpdated: number;
  childrenUpdated: number;
  errors: Array<{ sku: string; error: string }>;
  startTime: Date;
  endTime: Date;
  duration: number;
}

export class AmazonSyncService {
  private syncId: string;
  private startTime: Date;
  private errors: Array<{ sku: string; error: string }> = [];
  private stats = {
    totalProcessed: 0,
    parentsCreated: 0,
    childrenCreated: 0,
    parentsUpdated: 0,
    childrenUpdated: 0,
  };

  constructor() {
    this.syncId = `sync-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    this.startTime = new Date();
  }

  /**
   * Main entry point for syncing Amazon catalog
   */
  async syncAmazonCatalog(products: AmazonProduct[]): Promise<SyncResult> {
    try {
      logger.info(`[${this.syncId}] Starting Amazon catalog sync with ${products.length} products`);

      // Identify parent-child relationships
      const { parents, children, standalones } = this.identifyParentChildRelationships(products);

      logger.info(
        `[${this.syncId}] Identified: ${parents.length} parents, ${children.length} children, ${standalones.length} standalones`
      );

      // Sync all products in a transaction
      await prisma.$transaction(async (tx: any) => {
        // Sync standalone products
        for (const product of standalones) {
          await this.syncStandaloneProduct(product, tx);
        }

        // Sync parent products with their children
        for (const parent of parents) {
          const parentId = await this.syncParentProduct(parent, tx);
          const parentChildren = children.filter((c) => c.parentAsin === parent.asin);

          for (const child of parentChildren) {
            await this.syncChildVariation(child, parentId, tx);
          }
        }
      });

      const endTime = new Date();
      const duration = endTime.getTime() - this.startTime.getTime();

      const result: SyncResult = {
        syncId: this.syncId,
        status: this.errors.length === 0 ? "success" : this.errors.length < products.length ? "partial" : "failed",
        totalProcessed: this.stats.totalProcessed,
        parentsCreated: this.stats.parentsCreated,
        childrenCreated: this.stats.childrenCreated,
        parentsUpdated: this.stats.parentsUpdated,
        childrenUpdated: this.stats.childrenUpdated,
        errors: this.errors,
        startTime: this.startTime,
        endTime,
        duration,
      };

      await this.logSyncProgress(result);

      logger.info(
        `[${this.syncId}] Sync completed: ${result.status} (${this.stats.totalProcessed}/${products.length} processed in ${duration}ms)`
      );

      return result;
    } catch (error) {
      logger.error(`[${this.syncId}] Sync failed:`, error);
      throw error;
    }
  }

  /**
   * Identify parent-child relationships from Amazon products
   */
  private identifyParentChildRelationships(products: AmazonProduct[]): {
    parents: AmazonProduct[];
    children: AmazonProduct[];
    standalones: AmazonProduct[];
  } {
    const parents: AmazonProduct[] = [];
    const children: AmazonProduct[] = [];
    const standalones: AmazonProduct[] = [];

    // Create a map of ASINs for quick lookup
    const asinMap = new Map<string, AmazonProduct>();
    products.forEach((p) => asinMap.set(p.asin, p));

    for (const product of products) {
      // If product has a parentAsin, it's a child
      if (product.parentAsin && asinMap.has(product.parentAsin)) {
        children.push(product);
      }
      // If product has variations or is explicitly marked as parent, it's a parent
      else if (product.variations && product.variations.length > 0) {
        parents.push(product);
        // Add variations as children
        children.push(...product.variations);
      }
      // Otherwise it's a standalone
      else {
        standalones.push(product);
      }
    }

    return { parents, children, standalones };
  }

  /**
   * Sync a standalone product (no parent-child relationship)
   */
  private async syncStandaloneProduct(product: AmazonProduct, tx: any): Promise<string> {
    try {
      const fulfillmentChannel = this.detectFulfillmentChannel(product);
      const shippingTemplate = this.extractShippingTemplate(product);

      const existing = await tx.product.findUnique({
        where: { sku: product.sku },
      });

      if (existing) {
        await tx.product.update({
          where: { id: existing.id },
          data: {
            name: product.title,
            amazonAsin: product.asin,
            basePrice: product.price || existing.basePrice,
            totalStock: product.stock ?? existing.totalStock,
            fulfillmentChannel,
            shippingTemplate,
            lastAmazonSync: new Date(),
            amazonSyncStatus: "synced",
          },
        });
        this.stats.parentsUpdated++;
      } else {
        await tx.product.create({
          data: {
            sku: product.sku,
            name: product.title,
            amazonAsin: product.asin,
            basePrice: product.price || 0,
            totalStock: product.stock ?? 0,
            isParent: false,
            fulfillmentChannel,
            shippingTemplate,
            lastAmazonSync: new Date(),
            amazonSyncStatus: "synced",
          },
        });
        this.stats.parentsCreated++;
      }

      this.stats.totalProcessed++;
      return existing?.id || product.sku;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.errors.push({ sku: product.sku, error: errorMsg });
      logger.error(`[${this.syncId}] Error syncing standalone product ${product.sku}:`, error);
      throw error;
    }
  }

  /**
   * Sync a parent product
   */
  private async syncParentProduct(product: AmazonProduct, tx: any): Promise<string> {
    try {
      const fulfillmentChannel = this.detectFulfillmentChannel(product);
      const shippingTemplate = this.extractShippingTemplate(product);

      const existing = await tx.product.findUnique({
        where: { sku: product.sku },
      });

      if (existing) {
        await tx.product.update({
          where: { id: existing.id },
          data: {
            name: product.title,
            amazonAsin: product.asin,
            basePrice: product.price || existing.basePrice,
            totalStock: product.stock ?? existing.totalStock,
            isParent: true,
            fulfillmentChannel,
            shippingTemplate,
            lastAmazonSync: new Date(),
            amazonSyncStatus: "synced",
          },
        });
        this.stats.parentsUpdated++;
        return existing.id;
      } else {
        const created = await tx.product.create({
          data: {
            sku: product.sku,
            name: product.title,
            amazonAsin: product.asin,
            basePrice: product.price || 0,
            totalStock: product.stock ?? 0,
            isParent: true,
            fulfillmentChannel,
            shippingTemplate,
            lastAmazonSync: new Date(),
            amazonSyncStatus: "synced",
          },
        });
        this.stats.parentsCreated++;
        return created.id;
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.errors.push({ sku: product.sku, error: errorMsg });
      logger.error(`[${this.syncId}] Error syncing parent product ${product.sku}:`, error);
      throw error;
    }
  }

  /**
   * Sync a child variation/product
   */
  private async syncChildVariation(child: AmazonProduct, parentId: string, tx: any): Promise<string> {
    try {
      const fulfillmentChannel = this.detectFulfillmentChannel(child);
      const shippingTemplate = this.extractShippingTemplate(child);

      const existing = await tx.product.findUnique({
        where: { sku: child.sku },
      });

      if (existing) {
        await tx.product.update({
          where: { id: existing.id },
          data: {
            name: child.title,
            amazonAsin: child.asin,
            basePrice: child.price || existing.basePrice,
            totalStock: child.stock ?? existing.totalStock,
            parentId,
            isParent: false,
            fulfillmentChannel,
            shippingTemplate,
            lastAmazonSync: new Date(),
            amazonSyncStatus: "synced",
          },
        });
        this.stats.childrenUpdated++;
        return existing.id;
      } else {
        const created = await tx.product.create({
          data: {
            sku: child.sku,
            name: child.title,
            amazonAsin: child.asin,
            basePrice: child.price || 0,
            totalStock: child.stock ?? 0,
            parentId,
            isParent: false,
            fulfillmentChannel,
            shippingTemplate,
            lastAmazonSync: new Date(),
            amazonSyncStatus: "synced",
          },
        });
        this.stats.childrenCreated++;
        return created.id;
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.errors.push({ sku: child.sku, error: errorMsg });
      logger.error(`[${this.syncId}] Error syncing child variation ${child.sku}:`, error);
      throw error;
    }
  }

  /**
   * Detect fulfillment channel from product data
   */
  private detectFulfillmentChannel(product: AmazonProduct): string {
    if (product.fulfillmentChannel) {
      return product.fulfillmentChannel;
    }

    // Default to FBA (Fulfillment by Amazon) if not specified
    return "FBA";
  }

  /**
   * Extract shipping template from product data
   */
  private extractShippingTemplate(product: AmazonProduct): string | null {
    if (product.shippingTemplate) {
      return product.shippingTemplate;
    }

    // Return null if no shipping template is available
    return null;
  }

  /**
   * Log sync progress to database
   */
  private async logSyncProgress(result: SyncResult): Promise<void> {
    try {
      // Note: SyncLog requires a productId, but this is a catalog-wide sync
      // We skip logging for now as there's no single product to associate with
      logger.info(`[${this.syncId}] Sync progress: ${result.totalProcessed} items processed`);
    } catch (error) {
      logger.error(`[${this.syncId}] Error logging sync progress:`, error);
      // Don't throw - logging failure shouldn't fail the entire sync
    }
  }

  /**
   * Get sync status by ID
   */
  async getSyncStatus(syncId: string): Promise<any> {
    try {
      const syncLog = await prisma.syncLog.findUnique({
        where: { id: syncId },
      });

      if (!syncLog) {
        throw new Error(`Sync with ID ${syncId} not found`);
      }

      return syncLog;
    } catch (error) {
      logger.error(`Error retrieving sync status for ${syncId}:`, error);
      throw error;
    }
  }

  /**
   * Validate product data
   */
  validateProduct(product: AmazonProduct): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!product.asin) {
      errors.push("Missing ASIN");
    }

    if (!product.sku) {
      errors.push("Missing SKU");
    }

    if (!product.title) {
      errors.push("Missing title");
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Recompute parent stock from children
   */
  async recomputeParentStock(parentId: string): Promise<number> {
    try {
      const children = await prisma.product.findMany({
        where: { parentId },
        select: { totalStock: true },
      });

      const totalStock = children.reduce((sum, child) => sum + child.totalStock, 0);

      await prisma.product.update({
        where: { id: parentId },
        data: { totalStock },
      });

      return totalStock;
    } catch (error) {
      logger.error(`Error recomputing stock for parent ${parentId}:`, error);
      throw error;
    }
  }
}
