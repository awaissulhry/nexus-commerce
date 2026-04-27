/**
 * Import Service — Rithum-Style Relational Importer
 *
 * Implements a recursive import that maps Amazon's Parent-Child hierarchy
 * into the MasterProduct → ProductVariation → VariantChannelListing chain.
 *
 * Rules:
 *   1. If ParentSKU is null/empty → create a Product (MasterProduct).
 *   2. If ParentSKU is present   → find-or-create the parent Product,
 *      then create a ProductVariation linked to it.
 *   3. Standalone items (no parent, no children) get a Product AND a
 *      single ProductVariation so every purchasable SKU lives in the
 *      variation table.
 *   4. Every variation automatically gets a VariantChannelListing for
 *      the source channel (e.g. AMAZON).
 */

import { prisma } from '@nexus/database';

// ── Types ──────────────────────────────────────────────────────────────

export interface AmazonImportRow {
  sku: string;
  parentSku?: string | null;
  asin?: string | null;
  parentAsin?: string | null;
  title: string;
  description?: string | null;
  price: number;
  quantity: number;
  brand?: string | null;
  imageUrl?: string | null;
  fulfillment?: 'FBA' | 'FBM' | null;
  condition?: string | null;
  variationName?: string | null;   // e.g. "Color"
  variationValue?: string | null;  // e.g. "Red"
  bulletPoints?: string[];
  browseNodeId?: string | null;
  categoryPath?: string[];
  feePreview?: number | null;
}

export interface ImportResult {
  totalProcessed: number;
  parentsCreated: number;
  variationsCreated: number;
  listingsCreated: number;
  errors: Array<{ sku: string; error: string }>;
}

// ── Service ────────────────────────────────────────────────────────────

export class ImportService {
  /**
   * Import a batch of Amazon rows into the relational hierarchy.
   *
   * The caller should pass ALL rows (parents + children) in any order.
   * The service handles ordering internally.
   */
  async importFromAmazon(rows: AmazonImportRow[]): Promise<ImportResult> {
    const result: ImportResult = {
      totalProcessed: 0,
      parentsCreated: 0,
      variationsCreated: 0,
      listingsCreated: 0,
      errors: [],
    };

    // ── Phase 1: Separate parents from children ──────────────────────
    const parentRows: AmazonImportRow[] = [];
    const childRows: AmazonImportRow[] = [];

    for (const row of rows) {
      if (!row.parentSku || row.parentSku === row.sku) {
        parentRows.push(row);
      } else {
        childRows.push(row);
      }
    }

    // ── Phase 2: Create all parent Products ──────────────────────────
    // Cache: parentSku → Product.id
    const parentCache = new Map<string, string>();

    for (const row of parentRows) {
      try {
        const product = await this.upsertMasterProduct(row);
        parentCache.set(row.sku, product.id);
        result.parentsCreated++;

        // If this parent has NO children in the batch, treat it as
        // standalone: create a single variation so every purchasable
        // SKU lives in ProductVariation.
        const hasChildren = childRows.some((c) => c.parentSku === row.sku);
        if (!hasChildren) {
          const variation = await this.upsertVariation(product.id, row, true);
          result.variationsCreated++;

          await this.upsertChannelListing(variation.id, 'AMAZON', row);
          result.listingsCreated++;
        }
      } catch (err) {
        result.errors.push({
          sku: row.sku,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      result.totalProcessed++;
    }

    // ── Phase 3: Create all child Variations ─────────────────────────
    for (const row of childRows) {
      try {
        let parentId = parentCache.get(row.parentSku!);

        // Parent not yet created → create it on-the-fly
        if (!parentId) {
          const syntheticParent: AmazonImportRow = {
            sku: row.parentSku!,
            title: row.title.split(' - ')[0] || row.title,
            price: row.price,
            quantity: 0,
            brand: row.brand,
            imageUrl: row.imageUrl,
            parentAsin: row.parentAsin || row.asin,
            fulfillment: row.fulfillment,
          };
          const product = await this.upsertMasterProduct(syntheticParent);
          parentId = product.id;
          parentCache.set(row.parentSku!, parentId);
          result.parentsCreated++;
        }

        const variation = await this.upsertVariation(parentId, row, false);
        result.variationsCreated++;

        await this.upsertChannelListing(variation.id, 'AMAZON', row);
        result.listingsCreated++;
      } catch (err) {
        result.errors.push({
          sku: row.sku,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      result.totalProcessed++;
    }

    // ── Phase 4: Recalculate parent stock totals ─────────────────────
    for (const [, productId] of parentCache) {
      await this.recalculateParentStock(productId);
    }

    return result;
  }

  // ── Private helpers ──────────────────────────────────────────────────

  private async upsertMasterProduct(row: AmazonImportRow) {
    return prisma.product.upsert({
      where: { sku: row.sku },
      update: {
        name: row.title,
        basePrice: row.price,
        brand: row.brand,
        amazonAsin: row.parentAsin || row.asin,
        fulfillmentMethod: row.fulfillment as any,
        bulletPoints: row.bulletPoints || [],
        status: 'ACTIVE',
      },
      create: {
        sku: row.sku,
        name: row.title,
        basePrice: row.price,
        totalStock: 0,
        brand: row.brand,
        amazonAsin: row.parentAsin || row.asin,
        fulfillmentMethod: row.fulfillment as any,
        bulletPoints: row.bulletPoints || [],
        status: 'ACTIVE',
      },
    });
  }

  private async upsertVariation(
    productId: string,
    row: AmazonImportRow,
    isStandalone: boolean
  ) {
    const variationAttributes =
      row.variationName && row.variationValue
        ? { [row.variationName]: row.variationValue }
        : null;

    return (prisma as any).productVariation.upsert({
      where: { sku: row.sku },
      update: {
        price: row.price,
        stock: row.quantity,
        amazonAsin: row.asin,
        name: row.variationName,
        value: row.variationValue,
        variationAttributes: variationAttributes,
        fulfillmentMethod: row.fulfillment as any,
        isActive: true,
      },
      create: {
        productId,
        sku: row.sku,
        price: row.price,
        stock: row.quantity,
        amazonAsin: row.asin,
        name: isStandalone ? null : row.variationName,
        value: isStandalone ? null : row.variationValue,
        variationAttributes: isStandalone ? null : variationAttributes,
        fulfillmentMethod: row.fulfillment as any,
        isActive: true,
        marketplaceMetadata: row.browseNodeId
          ? {
              amazon: {
                browseNodeId: row.browseNodeId,
                categoryPath: row.categoryPath || [],
                feePreview: row.feePreview,
              },
            }
          : undefined,
      },
    });
  }

  private async upsertChannelListing(
    variantId: string,
    channelId: string,
    row: AmazonImportRow
  ) {
    return (prisma as any).variantChannelListing.upsert({
      where: {
        variantId_channelId: { variantId, channelId },
      },
      update: {
        channelPrice: row.price,
        channelQuantity: row.quantity,
        channelProductId: row.asin,
        channelSku: row.sku,
        listingStatus: 'ACTIVE',
        lastSyncedAt: new Date(),
        lastSyncStatus: 'SUCCESS',
        channelSpecificData: {
          fulfillment: row.fulfillment,
          condition: row.condition,
          feePreview: row.feePreview,
          browseNodeId: row.browseNodeId,
        },
      },
      create: {
        variantId,
        channelId,
        channelPrice: row.price,
        channelQuantity: row.quantity,
        channelProductId: row.asin,
        channelSku: row.sku,
        listingStatus: 'ACTIVE',
        lastSyncedAt: new Date(),
        lastSyncStatus: 'SUCCESS',
        channelSpecificData: {
          fulfillment: row.fulfillment,
          condition: row.condition,
          feePreview: row.feePreview,
          browseNodeId: row.browseNodeId,
        },
      },
    });
  }

  private async recalculateParentStock(productId: string) {
    const variations: any[] = await (prisma as any).productVariation.findMany({
      where: { productId },
      select: { stock: true },
    });

    const totalStock = variations.reduce(
      (sum: number, v: any) => sum + (v.stock || 0),
      0
    );

    await prisma.product.update({
      where: { id: productId },
      data: { totalStock },
    });
  }
}

export const importService = new ImportService();
