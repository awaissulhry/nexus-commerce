import prisma from "../../db.js";

/**
 * Variation theme detection patterns
 * Maps SKU patterns to variation themes
 */
const VARIATION_PATTERNS = {
  SIZE_COLOR: /^(.+?)-(S|M|L|XL|XXL|XS)-(BLK|WHT|RED|BLU|GRN|YEL|BRN|GRY|PNK|PRP)$/i,
  SIZE: /^(.+?)-(XS|S|M|L|XL|XXL|XXXL|\d+)$/i,
  COLOR: /^(.+?)-(BLK|WHT|RED|BLU|GRN|YEL|BRN|GRY|PNK|PRP|NAVY|GOLD|SILVER)$/i,
  SIZE_MATERIAL: /^(.+?)-(S|M|L|XL)-(COTTON|POLY|WOOL|SILK|LINEN)$/i,
};

/**
 * Attribute mappings for variation themes
 */
const ATTRIBUTE_MAPPINGS: Record<string, Record<string, string>> = {
  SIZE_COLOR: {
    S: "Small",
    M: "Medium",
    L: "Large",
    XL: "Extra Large",
    XXL: "2X Large",
    BLK: "Black",
    WHT: "White",
    RED: "Red",
    BLU: "Blue",
    GRN: "Green",
    YEL: "Yellow",
    BRN: "Brown",
    GRY: "Gray",
    PNK: "Pink",
    PRP: "Purple",
  },
  SIZE: {
    XS: "Extra Small",
    S: "Small",
    M: "Medium",
    L: "Large",
    XL: "Extra Large",
    XXL: "2X Large",
    XXXL: "3X Large",
  },
  COLOR: {
    BLK: "Black",
    WHT: "White",
    RED: "Red",
    BLU: "Blue",
    GRN: "Green",
    YEL: "Yellow",
    BRN: "Brown",
    GRY: "Gray",
    PNK: "Pink",
    PRP: "Purple",
    NAVY: "Navy",
    GOLD: "Gold",
    SILVER: "Silver",
  },
};

export interface VariationGroup {
  parentSku: string;
  theme: string;
  variants: Array<{
    sku: string;
    attributes: Record<string, string>;
  }>;
}

export interface ProductSyncResult {
  success: boolean;
  parentId?: string;
  variantIds?: string[];
  error?: string;
}

/**
 * ProductSyncService
 * Handles parent-child product synchronization following Rithum architecture
 */
export class ProductSyncService {
  /**
   * Detect variation theme from SKU pattern
   */
  detectVariationTheme(sku: string): string | null {
    for (const [theme, pattern] of Object.entries(VARIATION_PATTERNS)) {
      if (pattern.test(sku)) {
        return theme;
      }
    }
    return null;
  }

  /**
   * Extract variation attributes from SKU based on theme
   */
  extractAttributes(sku: string, theme: string): Record<string, string> | null {
    const pattern = VARIATION_PATTERNS[theme as keyof typeof VARIATION_PATTERNS];
    if (!pattern) return null;

    const match = sku.match(pattern);
    if (!match) return null;

    const attributes: Record<string, string> = {};
    const mappings = ATTRIBUTE_MAPPINGS[theme];

    if (theme === "SIZE_COLOR") {
      const size = match[2]?.toUpperCase();
      const color = match[3]?.toUpperCase();
      if (size && mappings[size]) attributes.Size = mappings[size];
      if (color && mappings[color]) attributes.Color = mappings[color];
    } else if (theme === "SIZE") {
      const size = match[2]?.toUpperCase();
      if (size && mappings[size]) attributes.Size = mappings[size];
    } else if (theme === "COLOR") {
      const color = match[2]?.toUpperCase();
      if (color && mappings[color]) attributes.Color = mappings[color];
    } else if (theme === "SIZE_MATERIAL") {
      const size = match[2]?.toUpperCase();
      const material = match[3]?.toUpperCase();
      if (size && mappings[size]) attributes.Size = mappings[size];
      if (material && mappings[material]) attributes.Material = mappings[material];
    }

    return Object.keys(attributes).length > 0 ? attributes : null;
  }

  /**
   * Group SKUs by parent product (variation theme detection)
   */
  groupByParent(skus: string[]): VariationGroup[] {
    const groups: Map<string, VariationGroup> = new Map();

    for (const sku of skus) {
      const theme = this.detectVariationTheme(sku);

      if (!theme) {
        // Standalone product (no variation theme)
        groups.set(sku, {
          parentSku: sku,
          theme: "STANDALONE",
          variants: [{ sku, attributes: {} }],
        });
      } else {
        // Extract parent SKU (first part before variation codes)
        const parentMatch = sku.match(/^(.+?)-(S|M|L|XL|XXL|XS|BLK|WHT|RED|BLU|GRN|YEL|BRN|GRY|PNK|PRP|NAVY|GOLD|SILVER|COTTON|POLY|WOOL|SILK|LINEN|\d+)/i);
        const parentSku = parentMatch ? parentMatch[1] : sku;

        if (!groups.has(parentSku)) {
          groups.set(parentSku, {
            parentSku,
            theme,
            variants: [],
          });
        }

        const attributes = this.extractAttributes(sku, theme);
        groups.get(parentSku)!.variants.push({
          sku,
          attributes: attributes || {},
        });
      }
    }

    return Array.from(groups.values());
  }

  /**
   * Sync product with parent-child structure
   */
  async syncProduct(
    sku: string,
    productData: {
      name: string;
      basePrice: number;
      totalStock: number;
      amazonAsin?: string;
      ebayItemId?: string;
      brand?: string;
      manufacturer?: string;
      bulletPoints?: string[];
      keywords?: string[];
    }
  ): Promise<ProductSyncResult> {
    try {
      const theme = this.detectVariationTheme(sku);

      if (!theme) {
        // Standalone product
        const product = await (prisma as any).product.upsert({
          where: { sku },
          update: {
            name: productData.name,
            basePrice: productData.basePrice,
            totalStock: productData.totalStock,
            amazonAsin: productData.amazonAsin,
            ebayItemId: productData.ebayItemId,
            brand: productData.brand,
            manufacturer: productData.manufacturer,
            bulletPoints: productData.bulletPoints || [],
            keywords: productData.keywords || [],
            variationTheme: null,
            status: "ACTIVE",
          },
          create: {
            sku,
            name: productData.name,
            basePrice: productData.basePrice,
            totalStock: productData.totalStock,
            amazonAsin: productData.amazonAsin,
            ebayItemId: productData.ebayItemId,
            brand: productData.brand,
            manufacturer: productData.manufacturer,
            bulletPoints: productData.bulletPoints || [],
            keywords: productData.keywords || [],
            variationTheme: null,
            status: "ACTIVE",
          },
        });

        return { success: true, parentId: product.id };
      } else {
        // Parent-child product
        const parentMatch = sku.match(/^(.+?)-(S|M|L|XL|XXL|XS|BLK|WHT|RED|BLU|GRN|YEL|BRN|GRY|PNK|PRP|NAVY|GOLD|SILVER|COTTON|POLY|WOOL|SILK|LINEN|\d+)/i);
        const parentSku = parentMatch ? parentMatch[1] : sku;

        // Create or update parent product
        const parent = await (prisma as any).product.upsert({
          where: { sku: parentSku },
          update: {
            name: productData.name,
            brand: productData.brand,
            manufacturer: productData.manufacturer,
            bulletPoints: productData.bulletPoints || [],
            keywords: productData.keywords || [],
            variationTheme: theme,
            status: "ACTIVE",
          },
          create: {
            sku: parentSku,
            name: productData.name,
            basePrice: productData.basePrice,
            totalStock: 0, // Parent stock is sum of variants
            brand: productData.brand,
            manufacturer: productData.manufacturer,
            bulletPoints: productData.bulletPoints || [],
            keywords: productData.keywords || [],
            variationTheme: theme,
            status: "ACTIVE",
          },
        });

        // Create or update child variant
        const attributes = this.extractAttributes(sku, theme);
        const variant = await (prisma as any).productVariation.upsert({
          where: { sku },
          update: {
            price: productData.basePrice,
            stock: productData.totalStock,
            variationAttributes: attributes,
          },
          create: {
            sku,
            productId: parent.id,
            price: productData.basePrice,
            stock: productData.totalStock,
            variationAttributes: attributes,
          },
        });

        // Update parent total stock
        const totalStock = await (prisma as any).productVariation.aggregate({
          where: { productId: parent.id },
          _sum: { stock: true },
        });

        await (prisma as any).product.update({
          where: { id: parent.id },
          data: { totalStock: totalStock._sum.stock || 0 },
        });

        return { success: true, parentId: parent.id, variantIds: [variant.id] };
      }
    } catch (error: any) {
      return {
        success: false,
        error: error?.message || "Failed to sync product",
      };
    }
  }

  /**
   * Sync multiple products with parent-child grouping
   */
  async syncProducts(
    products: Array<{
      sku: string;
      name: string;
      basePrice: number;
      totalStock: number;
      amazonAsin?: string;
      ebayItemId?: string;
      brand?: string;
      manufacturer?: string;
      bulletPoints?: string[];
      keywords?: string[];
    }>
  ): Promise<{
    success: boolean;
    created: number;
    updated: number;
    failed: number;
    errors: Array<{ sku: string; error: string }>;
  }> {
    const results = {
      success: true,
      created: 0,
      updated: 0,
      failed: 0,
      errors: [] as Array<{ sku: string; error: string }>,
    };

    for (const product of products) {
      const result = await this.syncProduct(product.sku, product);
      if (result.success) {
        result.parentId ? results.created++ : results.updated++;
      } else {
        results.failed++;
        results.errors.push({ sku: product.sku, error: result.error || "Unknown error" });
      }
    }

    return results;
  }
}
