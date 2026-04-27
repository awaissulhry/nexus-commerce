/**
 * Data Transformation Utilities
 * Transforms data between Nexus and marketplace formats
 */

import {
  NexusProductMapping,
  NexusVariantMapping,
  VariationTheme,
  ShopifyProduct,
  ShopifyVariant,
  WooCommerceProduct,
  WooCommerceVariation,
  EtsyListing,
  EtsyInventory,
} from "../types/marketplace.js";

/**
 * Variation theme detector
 */
export class VariationThemeDetector {
  /**
   * Detect variation theme from variant titles (Shopify)
   * Example: "Medium / Black" -> SIZE_COLOR
   */
  static detectFromShopifyTitles(variants: ShopifyVariant[]): VariationTheme | null {
    if (variants.length === 0) return null;

    // Extract attributes from variant titles
    const attributeNames = new Set<string>();

    for (const variant of variants) {
      const parts = variant.title.split(" / ");
      if (parts.length > 1) {
        // Infer attribute names from common patterns
        for (const part of parts) {
          const normalized = this.normalizeAttributeName(part);
          if (normalized) {
            attributeNames.add(normalized);
          }
        }
      }
    }

    if (attributeNames.size === 0) return null;

    const attributes = Array.from(attributeNames).sort();
    const theme = attributes.join("_").toUpperCase();

    return {
      theme,
      attributes,
    };
  }

  /**
   * Detect variation theme from WooCommerce attributes
   */
  static detectFromWooCommerceAttributes(
    attributes: Array<{ name: string; options: string[] }>
  ): VariationTheme | null {
    if (attributes.length === 0) return null;

    const attributeNames = attributes.map((a) => this.normalizeAttributeName(a.name)).filter(Boolean) as string[];

    if (attributeNames.length === 0) return null;

    const theme = attributeNames.sort().join("_").toUpperCase();

    return {
      theme,
      attributes: attributeNames,
    };
  }

  /**
   * Detect variation theme from Etsy properties
   */
  static detectFromEtsyProperties(
    variations: Array<{ propertyName: string; values: string[] }>
  ): VariationTheme | null {
    if (variations.length === 0) return null;

    const attributeNames = variations
      .map((v) => this.normalizeAttributeName(v.propertyName))
      .filter(Boolean) as string[];

    if (attributeNames.length === 0) return null;

    const theme = attributeNames.sort().join("_").toUpperCase();

    return {
      theme,
      attributes: attributeNames,
    };
  }

  /**
   * Normalize attribute name to standard format
   */
  private static normalizeAttributeName(name: string): string | null {
    const normalized = name.trim().toUpperCase();

    // Common attribute mappings
    const mappings: Record<string, string> = {
      SIZE: "SIZE",
      COLOUR: "COLOR",
      COLOR: "COLOR",
      MATERIAL: "MATERIAL",
      STYLE: "STYLE",
      BRAND: "BRAND",
      GENDER: "GENDER",
      AGE: "AGE",
      WEIGHT: "WEIGHT",
      LENGTH: "LENGTH",
      WIDTH: "WIDTH",
      HEIGHT: "HEIGHT",
    };

    return mappings[normalized] || null;
  }
}

/**
 * Shopify data transformer
 */
export class ShopifyTransformer {
  /**
   * Transform Shopify product to Nexus format
   */
  static toNexusProduct(shopifyProduct: ShopifyProduct): NexusProductMapping {
    const variationTheme = VariationThemeDetector.detectFromShopifyTitles(
      shopifyProduct.variants
    );

    const variants = shopifyProduct.variants.map((v) =>
      this.toNexusVariant(v, variationTheme)
    );

    // Use first variant SKU as parent SKU if available
    const parentSku = variants[0]?.sku.split("-").slice(0, -1).join("-") || shopifyProduct.handle;

    return {
      sku: parentSku,
      name: shopifyProduct.title,
      variationTheme: variationTheme || undefined,
      variants,
      channelProductId: shopifyProduct.id,
    };
  }

  /**
   * Transform Shopify variant to Nexus variant
   */
  private static toNexusVariant(
    variant: ShopifyVariant,
    variationTheme?: VariationTheme | null
  ): NexusVariantMapping {
    const variationAttributes = this.extractVariationAttributes(
      variant.title,
      variationTheme
    );

    return {
      sku: variant.sku,
      variationAttributes,
      price: parseFloat(variant.price),
      stock: variant.inventoryQuantity,
      channelVariantId: variant.id,
    };
  }

  /**
   * Extract variation attributes from variant title
   */
  private static extractVariationAttributes(
    title: string,
    variationTheme?: VariationTheme | null
  ): Record<string, string> {
    const attributes: Record<string, string> = {};

    if (!variationTheme) return attributes;

    const parts = title.split(" / ");

    for (let i = 0; i < Math.min(parts.length, variationTheme.attributes.length); i++) {
      attributes[variationTheme.attributes[i]] = parts[i].trim();
    }

    return attributes;
  }
}

/**
 * WooCommerce data transformer
 */
export class WooCommerceTransformer {
  /**
   * Transform WooCommerce product to Nexus format
   */
  static toNexusProduct(
    product: WooCommerceProduct,
    variations: WooCommerceVariation[]
  ): NexusProductMapping {
    const variationTheme = VariationThemeDetector.detectFromWooCommerceAttributes(
      product.attributes || []
    );

    const nexusVariants = variations.map((v) =>
      this.toNexusVariant(v, product.attributes || [], variationTheme)
    );

    return {
      sku: product.slug,
      name: product.name,
      variationTheme: variationTheme || undefined,
      variants: nexusVariants,
      channelProductId: product.id.toString(),
    };
  }

  /**
   * Transform WooCommerce variation to Nexus variant
   */
  private static toNexusVariant(
    variation: WooCommerceVariation,
    attributes: Array<{ name: string; options: string[] }>,
    variationTheme?: VariationTheme | null
  ): NexusVariantMapping {
    const variationAttributes: Record<string, string> = {};

    for (const attr of variation.attributes) {
      const normalizedName = VariationThemeDetector["normalizeAttributeName"](attr.name);
      if (normalizedName) {
        variationAttributes[normalizedName] = attr.option;
      }
    }

    return {
      sku: variation.sku,
      variationAttributes,
      price: parseFloat(variation.price),
      stock: variation.stockQuantity,
      channelVariantId: variation.id.toString(),
    };
  }
}

/**
 * Etsy data transformer
 */
export class EtsyTransformer {
  /**
   * Transform Etsy listing to Nexus format
   */
  static toNexusProduct(listing: EtsyListing): NexusProductMapping {
    const variationTheme = VariationThemeDetector.detectFromEtsyProperties(
      listing.variations || []
    );

    const variants = (listing.inventory || []).map((inv) =>
      this.toNexusVariant(inv, listing.variations || [], variationTheme)
    );

    return {
      sku: `ETSY-${listing.listingId}`,
      name: listing.title,
      variationTheme: variationTheme || undefined,
      variants,
      channelProductId: listing.listingId,
    };
  }

  /**
   * Transform Etsy inventory to Nexus variant
   */
  private static toNexusVariant(
    inventory: EtsyInventory,
    variations: Array<{ propertyName: string; values: string[] }>,
    variationTheme?: VariationTheme | null
  ): NexusVariantMapping {
    const variationAttributes: Record<string, string> = {};

    for (const propValue of inventory.propertyValues) {
      const normalizedName = VariationThemeDetector["normalizeAttributeName"](
        propValue.propertyName
      );
      if (normalizedName) {
        variationAttributes[normalizedName] = propValue.value;
      }
    }

    return {
      sku: inventory.sku,
      variationAttributes,
      price: 0, // Etsy doesn't support per-variant pricing
      stock: inventory.quantity,
    };
  }
}

/**
 * Inventory transformation utilities
 */
export class InventoryTransformer {
  /**
   * Transform Nexus inventory to Shopify format
   */
  static toShopifyInventoryUpdate(
    currentStock: number,
    newStock: number
  ): {
    available_adjustment: number;
  } {
    return {
      available_adjustment: newStock - currentStock,
    };
  }

  /**
   * Transform Nexus inventory to WooCommerce format
   */
  static toWooCommerceInventoryUpdate(newStock: number): {
    stock_quantity: number;
    stock_status: "instock" | "outofstock";
  } {
    return {
      stock_quantity: newStock,
      stock_status: newStock > 0 ? "instock" : "outofstock",
    };
  }

  /**
   * Transform Nexus inventory to Etsy format
   */
  static toEtsyInventoryUpdate(newStock: number): {
    quantity: number;
  } {
    return {
      quantity: newStock,
    };
  }
}

/**
 * Price transformation utilities
 */
export class PriceTransformer {
  /**
   * Transform Nexus price to marketplace format
   */
  static toMarketplacePrice(price: number): string {
    return price.toFixed(2);
  }

  /**
   * Parse marketplace price to number
   */
  static fromMarketplacePrice(price: string | number): number {
    return parseFloat(String(price));
  }
}

/**
 * SKU utilities
 */
export class SKUUtilities {
  /**
   * Extract parent SKU from child SKU
   * Example: "TSHIRT-M-BLK" -> "TSHIRT"
   */
  static extractParentSku(childSku: string): string {
    const parts = childSku.split("-");
    // Assume last 2 parts are variation attributes
    return parts.slice(0, -2).join("-") || childSku;
  }

  /**
   * Generate child SKU from parent and attributes
   * Example: "TSHIRT", {Size: "M", Color: "BLK"} -> "TSHIRT-M-BLK"
   */
  static generateChildSku(
    parentSku: string,
    attributes: Record<string, string>,
    separator: string = "-"
  ): string {
    const attributeValues = Object.values(attributes)
      .map((v) => v.substring(0, 3).toUpperCase())
      .join(separator);

    return `${parentSku}${separator}${attributeValues}`;
  }

  /**
   * Normalize SKU for consistency
   */
  static normalize(sku: string): string {
    return sku.toUpperCase().trim().replace(/\s+/g, "-");
  }
}
