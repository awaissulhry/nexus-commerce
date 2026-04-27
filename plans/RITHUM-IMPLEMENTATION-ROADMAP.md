# Rithum Product Synchronization — Detailed Implementation Roadmap

**Document**: Step-by-Step Implementation Guide  
**Status**: Ready for Code Implementation  
**Last Updated**: April 23, 2026

---

## Implementation Sequence

### ✅ Phase 1: ProductSyncService Creation

**File**: `apps/api/src/services/product-sync.service.ts`  
**Estimated Lines**: 600-800  
**Dependencies**: Prisma, existing marketplace services

#### 1.1 Service Structure

```typescript
import prisma from "../db.js";
import { AmazonService } from "./marketplaces/amazon.service.js";
import type { CatalogItem, ProductDetails } from "./marketplaces/amazon.service.js";

export interface SyncResult {
  createdParents: number;
  createdVariants: number;
  updatedParents: number;
  updatedVariants: number;
  errors: SyncError[];
}

export interface SyncError {
  sku: string;
  message: string;
  code: string;
}

export interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

export class ProductSyncService {
  private amazon: AmazonService;

  constructor() {
    this.amazon = new AmazonService();
  }

  // Core methods...
}
```

#### 1.2 Variation Theme Detection

```typescript
/**
 * Analyzes SKU patterns to detect variation theme
 * Examples:
 *   NIKE-AM90-BLK-10 → SizeColor
 *   SHIRT-RED-S → SizeColor
 *   ITEM-001 → null (standalone)
 */
async detectVariationTheme(
  skus: string[],
  productDetails: ProductDetails[]
): Promise<string | null> {
  if (skus.length <= 1) {
    return null; // Standalone product
  }

  // Extract patterns from SKUs
  const patterns = this.analyzeSkuPattern(skus);
  
  // Extract attributes from product details
  const attributes = this.extractAttributes(productDetails);
  
  // Validate consistency
  const theme = this.validateThemeConsistency(patterns, attributes);
  
  return theme;
}

/**
 * Analyzes SKU patterns to identify variation axes
 * Returns detected theme or null
 */
private analyzeSkuPattern(skus: string[]): string | null {
  // Common patterns:
  // PARENT-{ATTR1}-{ATTR2} → SizeColor
  // PARENT-{ATTR1} → Size or Color
  
  if (skus.length < 2) return null;

  // Split SKUs by common delimiter
  const parts = skus.map(sku => sku.split('-'));
  
  // Find common prefix (parent SKU)
  const commonPrefix = this.findCommonPrefix(parts);
  
  // Analyze remaining parts for patterns
  const variableParts = parts.map(p => p.slice(commonPrefix.length));
  
  // Detect pattern
  if (variableParts[0].length === 2) {
    // Two variable parts → likely SizeColor
    return "SizeColor";
  } else if (variableParts[0].length === 1) {
    // One variable part → Size or Color
    return "Size"; // Default, can be refined
  }
  
  return null;
}

/**
 * Extracts attributes from product details
 */
private extractAttributes(details: ProductDetails[]): string[] {
  const attributeSet = new Set<string>();
  
  for (const detail of details) {
    // Extract from product attributes if available
    if (detail.attributes) {
      Object.keys(detail.attributes).forEach(attr => {
        attributeSet.add(attr);
      });
    }
  }
  
  return Array.from(attributeSet).sort();
}

/**
 * Validates that detected theme matches attributes
 */
private validateThemeConsistency(
  pattern: string | null,
  attributes: string[]
): string | null {
  if (!pattern) return null;
  
  // Map patterns to expected attributes
  const themeMap: Record<string, string[]> = {
    "SizeColor": ["Color", "Size"],
    "Size": ["Size"],
    "Color": ["Color"],
  };
  
  const expectedAttrs = themeMap[pattern];
  if (!expectedAttrs) return null;
  
  // Check if detected attributes match expected
  const matches = expectedAttrs.every(attr => attributes.includes(attr));
  
  return matches ? pattern : null;
}
```

#### 1.3 SKU Grouping by Parent

```typescript
/**
 * Groups SKUs into parent-child relationships
 * Returns map of parentSku → childSkus
 */
groupSkusByParent(
  catalogItems: CatalogItem[]
): Map<string, CatalogItem[]> {
  const groups = new Map<string, CatalogItem[]>();
  
  for (const item of catalogItems) {
    const parentSku = this.identifyParentSku(item.sku);
    
    if (!groups.has(parentSku)) {
      groups.set(parentSku, []);
    }
    
    groups.get(parentSku)!.push(item);
  }
  
  return groups;
}

/**
 * Identifies parent SKU from child SKU
 * Examples:
 *   NIKE-AM90-BLK-10 → NIKE-AM90
 *   SHIRT-RED-S → SHIRT
 */
private identifyParentSku(childSku: string): string {
  // Strategy 1: Remove last 2 segments (common pattern)
  const parts = childSku.split('-');
  
  if (parts.length >= 3) {
    // Assume last 2 parts are variation attributes
    return parts.slice(0, -2).join('-');
  } else if (parts.length === 2) {
    // Assume last part is variation attribute
    return parts[0];
  }
  
  // Fallback: return as-is (standalone)
  return childSku;
}
```

#### 1.4 Sync from Amazon

```typescript
/**
 * Main sync method: pulls from Amazon and creates parent-child structure
 */
async syncFromAmazon(
  catalogItems: CatalogItem[],
  enrichedDetails: Map<string, ProductDetails>
): Promise<SyncResult> {
  const result: SyncResult = {
    createdParents: 0,
    createdVariants: 0,
    updatedParents: 0,
    updatedVariants: 0,
    errors: [],
  };

  // Step 1: Group SKUs by parent
  const groups = this.groupSkusByParent(catalogItems);

  // Step 2: Process each parent group
  for (const [parentSku, childItems] of groups) {
    try {
      // Detect variation theme
      const childSkus = childItems.map(item => item.sku);
      const childDetails = childSkus
        .map(sku => enrichedDetails.get(sku))
        .filter(Boolean) as ProductDetails[];

      const variationTheme = await this.detectVariationTheme(
        childSkus,
        childDetails
      );

      // Create or update parent product
      const parent = await this.upsertParentProduct(
        parentSku,
        childItems,
        childDetails,
        variationTheme
      );

      if (parent.isNew) {
        result.createdParents++;
      } else {
        result.updatedParents++;
      }

      // Create or update child variants
      for (const childItem of childItems) {
        const childDetail = enrichedDetails.get(childItem.sku);
        if (!childDetail) continue;

        const variant = await this.upsertChildVariant(
          parent.id,
          childItem,
          childDetail,
          variationTheme
        );

        if (variant.isNew) {
          result.createdVariants++;
        } else {
          result.updatedVariants++;
        }
      }

      // Validate parent-child relationships
      const validation = await this.validateRelationalIntegrity(parent);
      if (!validation.isValid) {
        result.errors.push({
          sku: parentSku,
          message: validation.errors.join('; '),
          code: "VALIDATION_FAILED",
        });
      }
    } catch (error) {
      result.errors.push({
        sku: parentSku,
        message: error instanceof Error ? error.message : String(error),
        code: "SYNC_ERROR",
      });
    }
  }

  return result;
}

/**
 * Creates or updates parent product
 */
private async upsertParentProduct(
  parentSku: string,
  childItems: CatalogItem[],
  childDetails: ProductDetails[],
  variationTheme: string | null
): Promise<{ id: string; isNew: boolean }> {
  // Calculate aggregates from children
  const avgPrice = childItems.reduce((sum, item) => sum + item.price, 0) / childItems.length;
  const totalStock = childItems.reduce((sum, item) => sum + item.quantity, 0);
  const title = childDetails[0]?.title || parentSku;
  const brand = childDetails[0]?.brand || null;

  const existing = await (prisma as any).product.findUnique({
    where: { sku: parentSku },
  });

  if (existing) {
    await (prisma as any).product.update({
      where: { sku: parentSku },
      data: {
        basePrice: avgPrice,
        totalStock,
        variationTheme,
        status: "ACTIVE",
      },
    });

    return { id: existing.id, isNew: false };
  } else {
    const created = await (prisma as any).product.create({
      data: {
        sku: parentSku,
        name: title,
        basePrice: avgPrice,
        totalStock,
        variationTheme,
        status: "ACTIVE",
        brand,
        amazonAsin: childItems[0]?.asin?.split('-')[0], // Parent ASIN
      },
    });

    return { id: created.id, isNew: true };
  }
}

/**
 * Creates or updates child variant
 */
private async upsertChildVariant(
  parentId: string,
  childItem: CatalogItem,
  childDetail: ProductDetails,
  variationTheme: string | null
): Promise<{ id: string; isNew: boolean }> {
  // Extract variation attributes from SKU or product details
  const variationAttributes = this.extractVariationAttributes(
    childItem.sku,
    childDetail,
    variationTheme
  );

  const existing = await (prisma as any).productVariation.findUnique({
    where: { sku: childItem.sku },
  });

  if (existing) {
    await (prisma as any).productVariation.update({
      where: { sku: childItem.sku },
      data: {
        price: childItem.price,
        stock: childItem.quantity,
        variationAttributes,
        amazonAsin: childItem.asin,
        isActive: true,
      },
    });

    return { id: existing.id, isNew: false };
  } else {
    const created = await (prisma as any).productVariation.create({
      data: {
        productId: parentId,
        sku: childItem.sku,
        price: childItem.price,
        stock: childItem.quantity,
        variationAttributes,
        amazonAsin: childItem.asin,
        isActive: true,
      },
    });

    return { id: created.id, isNew: true };
  }
}

/**
 * Extracts variation attributes from SKU or product details
 */
private extractVariationAttributes(
  sku: string,
  detail: ProductDetails,
  variationTheme: string | null
): Record<string, string> | null {
  if (!variationTheme) return null;

  const attributes: Record<string, string> = {};

  // Try to extract from product details first
  if (detail.attributes) {
    Object.assign(attributes, detail.attributes);
  }

  // If not found, try to parse from SKU
  if (Object.keys(attributes).length === 0) {
    const parts = sku.split('-');
    const themeAttrs = this.getAttributesForTheme(variationTheme);

    if (themeAttrs.length === 2 && parts.length >= 3) {
      attributes[themeAttrs[0]] = parts[parts.length - 2];
      attributes[themeAttrs[1]] = parts[parts.length - 1];
    } else if (themeAttrs.length === 1 && parts.length >= 2) {
      attributes[themeAttrs[0]] = parts[parts.length - 1];
    }
  }

  return Object.keys(attributes).length > 0 ? attributes : null;
}

/**
 * Gets attribute names for a variation theme
 */
private getAttributesForTheme(theme: string): string[] {
  const themeMap: Record<string, string[]> = {
    "SizeColor": ["Size", "Color"],
    "Size": ["Size"],
    "Color": ["Color"],
    "SizeMaterial": ["Size", "Material"],
  };

  return themeMap[theme] || [];
}
```

#### 1.5 Validation

```typescript
/**
 * Validates parent-child relationships
 */
async validateRelationalIntegrity(
  product: any
): Promise<ValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Check 1: Parent exists
  if (!product || !product.id) {
    errors.push("Parent product does not exist");
    return { isValid: false, errors, warnings };
  }

  // Check 2: Fetch variants
  const variants = await (prisma as any).productVariation.findMany({
    where: { productId: product.id },
  });

  // Check 3: If variationTheme is set, must have variants
  if (product.variationTheme && variants.length === 0) {
    errors.push(
      `Parent has variationTheme "${product.variationTheme}" but no variants`
    );
  }

  // Check 4: If variationTheme is null, must have no variants
  if (!product.variationTheme && variants.length > 0) {
    errors.push(
      `Parent has no variationTheme but has ${variants.length} variants`
    );
  }

  // Check 5: All variants must have matching attributes
  if (product.variationTheme) {
    const expectedAttrs = this.getAttributesForTheme(product.variationTheme);

    for (const variant of variants) {
      if (!variant.variationAttributes) {
        errors.push(
          `Variant ${variant.sku} has no variationAttributes`
        );
        continue;
      }

      const variantAttrs = Object.keys(variant.variationAttributes);
      const missing = expectedAttrs.filter(attr => !variantAttrs.includes(attr));

      if (missing.length > 0) {
        errors.push(
          `Variant ${variant.sku} missing attributes: ${missing.join(', ')}`
        );
      }
    }
  }

  // Check 6: No duplicate attribute combinations
  if (product.variationTheme && variants.length > 1) {
    const seen = new Set<string>();

    for (const variant of variants) {
      const key = JSON.stringify(variant.variationAttributes);
      if (seen.has(key)) {
        errors.push(
          `Duplicate variation attributes: ${key}`
        );
      }
      seen.add(key);
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
  };
}
```

---

### ✅ Phase 2: DataValidationService Creation

**File**: `apps/api/src/services/data-validation.service.ts`  
**Estimated Lines**: 400-500  
**Dependencies**: Prisma

#### 2.1 Service Structure

```typescript
import prisma from "../db.js";

export interface ValidationReport {
  timestamp: Date;
  totalProducts: number;
  totalVariants: number;
  orphanedVariants: number;
  themeInconsistencies: number;
  channelListingIssues: number;
  errors: ValidationError[];
  warnings: string[];
}

export interface ValidationError {
  type: string;
  severity: "ERROR" | "WARNING";
  message: string;
  affectedRecords: string[];
}

export class DataValidationService {
  /**
   * Finds variants without valid parents
   */
  async validateOrphanedVariants(): Promise<string[]> {
    const orphaned = await (prisma as any).productVariation.findMany({
      where: {
        product: null,
      },
      select: { id: true, sku: true },
    });

    return orphaned.map((v: any) => v.sku);
  }

  /**
   * Checks variation theme consistency
   */
  async validateVariationThemeConsistency(): Promise<ValidationError[]> {
    const errors: ValidationError[] = [];

    const products = await (prisma as any).product.findMany({
      include: { variations: true },
    });

    for (const product of products) {
      if (!product.variationTheme && product.variations.length > 0) {
        errors.push({
          type: "THEME_MISMATCH",
          severity: "ERROR",
          message: `Product ${product.sku} has no theme but has ${product.variations.length} variants`,
          affectedRecords: [product.id],
        });
      }

      if (product.variationTheme && product.variations.length === 0) {
        errors.push({
          type: "THEME_MISMATCH",
          severity: "WARNING",
          message: `Product ${product.sku} has theme "${product.variationTheme}" but no variants`,
          affectedRecords: [product.id],
        });
      }
    }

    return errors;
  }

  /**
   * Validates channel listing integrity
   */
  async validateChannelListingIntegrity(): Promise<ValidationError[]> {
    const errors: ValidationError[] = [];

    // Check for orphaned channel listings
    const orphanedListings = await (prisma as any).variantChannelListing.findMany({
      where: {
        variant: null,
      },
    });

    if (orphanedListings.length > 0) {
      errors.push({
        type: "ORPHANED_LISTING",
        severity: "ERROR",
        message: `Found ${orphanedListings.length} channel listings without variants`,
        affectedRecords: orphanedListings.map((l: any) => l.id),
      });
    }

    return errors;
  }

  /**
   * Generates comprehensive validation report
   */
  async generateValidationReport(): Promise<ValidationReport> {
    const totalProducts = await (prisma as any).product.count();
    const totalVariants = await (prisma as any).productVariation.count();

    const orphanedVariants = await this.validateOrphanedVariants();
    const themeErrors = await this.validateVariationThemeConsistency();
    const listingErrors = await this.validateChannelListingIntegrity();

    const allErrors = [...themeErrors, ...listingErrors];

    return {
      timestamp: new Date(),
      totalProducts,
      totalVariants,
      orphanedVariants: orphanedVariants.length,
      themeInconsistencies: themeErrors.length,
      channelListingIssues: listingErrors.length,
      errors: allErrors,
      warnings: allErrors
        .filter(e => e.severity === "WARNING")
        .map(e => e.message),
    };
  }
}
```

---

### ✅ Phase 3: Sync Job Refactoring

**File**: `apps/api/src/jobs/sync.job.ts` (REFACTORED)  
**Key Changes**: Integrate ProductSyncService, add validation

#### 3.1 Enhanced syncAmazonCatalog()

```typescript
import { ProductSyncService } from "../services/product-sync.service.js";
import { DataValidationService } from "../services/data-validation.service.js";

const productSync = new ProductSyncService();
const dataValidation = new DataValidationService();

async function syncAmazonCatalog(): Promise<void> {
  console.log("[SyncJob] Phase 0: Syncing Amazon catalog with parent-child structure…");

  try {
    // Step 1: Fetch catalog
    const catalog = await amazon.fetchActiveCatalog();

    if (catalog.length === 0) {
      console.log("[SyncJob] No active listings found in Amazon catalog.");
      return;
    }

    console.log(`[SyncJob] Found ${catalog.length} active Amazon listing(s).`);

    // Step 2: Enrich with details
    const enrichedMap = new Map<string, ProductDetails>();
    let enriched = 0;

    for (const item of catalog) {
      try {
        const details = await amazon.fetchProductDetails(item.sku);
        enrichedMap.set(item.sku, details);
        enriched++;
      } catch (error) {
        console.warn(
          `[SyncJob] Failed to enrich SKU "${item.sku}":`,
          error instanceof Error ? error.message : error
        );
      }
    }

    console.log(`[SyncJob] Enriched ${enriched}/${catalog.length} products.`);

    // Step 3: Sync with parent-child structure
    console.log("[SyncJob] Syncing with parent-child structure…");
    const syncResult = await productSync.syncFromAmazon(catalog, enrichedMap);

    console.log(
      `[SyncJob] Sync complete: ${syncResult.createdParents} parents created, ` +
      `${syncResult.createdVariants} variants created, ` +
      `${syncResult.updatedParents} parents updated, ` +
      `${syncResult.updatedVariants} variants updated`
    );

    if (syncResult.errors.length > 0) {
      console.error(
        `[SyncJob] Sync errors (${syncResult.errors.length}):`,
        syncResult.errors
      );
    }

    // Step 4: Validate data integrity
    console.log("[SyncJob] Validating data integrity…");
    const report = await dataValidation.generateValidationReport();

    console.log(
      `[SyncJob] Validation report: ${report.orphanedVariants} orphaned variants, ` +
      `${report.themeInconsistencies} theme inconsistencies, ` +
      `${report.channelListingIssues} channel listing issues`
    );

    if (report.errors.length > 0) {
      console.error("[SyncJob] Validation errors:", report.errors);
    }

    // Step 5: Record sync status
    await (prisma as any).marketplaceSync.upsert({
      where: {
        productId_channel: {
          productId: "SYSTEM", // Placeholder for system-level sync
          channel: "AMAZON",
        },
      },
      update: {
        lastSyncStatus: syncResult.errors.length === 0 ? "SUCCESS" : "PARTIAL",
        lastSyncAt: new Date(),
      },
      create: {
        productId: "SYSTEM",
        channel: "AMAZON",
        lastSyncStatus: syncResult.errors.length === 0 ? "SUCCESS" : "PARTIAL",
        lastSyncAt: new Date(),
      },
    });

    console.log("[SyncJob] Phase 0 complete.");
  } catch (error) {
    console.error(
      "[SyncJob] Phase 0 failed:",
      error instanceof Error ? error.message : error
    );
  }
}
```

#### 3.2 Enhanced syncNewListings()

```typescript
async function syncNewListings(): Promise<void> {
  console.log("[SyncJob] Phase 1: Publishing new listings to eBay…");

  try {
    const unlinkedProducts = await (prisma as any).product.findMany({
      where: {
        amazonAsin: { not: null },
        ebayItemId: null,
      },
      include: {
        variations: true,
        images: true,
      },
    });

    if (unlinkedProducts.length === 0) {
      console.log("[SyncJob] No unlinked products found.");
      return;
    }

    console.log(`[SyncJob] Found ${unlinkedProducts.length} unlinked product(s).`);

    let published = 0;
    let failed = 0;

    for (const product of unlinkedProducts) {
      try {
        // Step 1: Validate parent-child structure
        const validation = await productSync.validateRelationalIntegrity(product);

        if (!validation.isValid) {
          console.error(
            `[SyncJob] Cannot publish ${product.sku}: validation failed`,
            validation.errors
          );
          failed++;
          continue;
        }

        // Step 2: Prepare for eBay
        const ebayData = await productSync.prepareForEbay(product);

        // Step 3: Publish parent listing
        const listingId = await ebay.publishNewListing(
          product.sku,
          ebayData,
          Number(product.basePrice),
          product.totalStock
        );

        console.log(
          `[SyncJob] Published parent listing for ${product.sku} (listingId=${listingId})`
        );

        // Step 4: Publish variants (if any)
        if (product.variations && product.variations.length > 0) {
          await ebay.publishVariations(listingId, product.variations);
          console.log(
            `[SyncJob] Published ${product.variations.length} variants for ${product.sku}`
          );
        }

        // Step 5: Create VariantChannelListing records
        for (const variant of product.variations || []) {
          await (prisma as any).variantChannelListing.upsert({
            where: {
              variantId_channelId: {
                variantId: variant.id,
                channelId: "EBAY",
              },
            },
            update: {
              channelProductId: listingId,
              channelPrice: Number(variant.price),
              channelQuantity: variant.stock,
              listingStatus: "ACTIVE",
              lastSyncedAt: new Date(),
              lastSyncStatus: "SUCCESS",
            },
            create: {
              variantId: variant.id,
              channelId: "EBAY",
              channelSku: variant.sku,
              channelProductId: listingId,
              channelPrice: Number(variant.price),
              channelQuantity: variant.stock,
              listingStatus: "ACTIVE",
              lastSyncedAt: new Date(),
              lastSyncStatus: "SUCCESS",
            },
          });
        }

        // Step 6: Update product with eBay data
        await (prisma as any).product.update({
          where: { id: product.id },
          data: {
            ebayItemId: listingId,
            ebayTitle: ebayData.ebayTitle,
          },
        });

        // Step 7: Record sync status
        await (prisma as any).marketplaceSync.upsert({
          where: {
            productId_channel: {
              productId: product.id,
              channel: "EBAY",
            },
          },
          update: {
            lastSyncStatus: "SUCCESS",
            lastSyncAt: new Date(),
          },
          create: {
            productId: product.id,
            channel: "EBAY",
            lastSyncStatus: "SUCCESS",
            lastSyncAt: new Date(),
          },
        });

        published++;
      } catch (error) {
        console.error(
          `[SyncJob] Failed to publish ${product.sku}:`,
          error instanceof Error ? error.message : error
        );
        failed++;

        // Record failure
        try {
          await (prisma as any).marketplaceSync.upsert({
            where: {
              productId_channel: {
                productId: product.id,
                channel: "EBAY",
              },
            },
            update: {
              lastSyncStatus: "FAILED",
              lastSyncAt: new Date(),
            },
            create: {
              productId: product.id,
              channel: "EBAY",
              lastSyncStatus: "FAILED",
              lastSyncAt: new Date(),
            },
          });
        } catch (dbError) {
          console.error(`[SyncJob] Failed to record sync failure:`, dbError);
        }
      }
    }

    console.log(
      `[SyncJob] Phase 1 complete: ${published} published, ${failed} failed.`
    );
  } catch (error) {
    console.error(
      "[SyncJob] Phase 1 failed:",
      error instanceof Error ? error.message : error
    );
  }
}
```

---

### ✅ Phase 4: Marketplace Service Enhancements

**Files**: 
- `apps/api/src/services/marketplaces/amazon.service.ts`
- `apps/api/src/services/marketplaces/ebay.service.ts`

#### 4.1 Amazon Service Enhancements

```typescript
// Add to AmazonService class

/**
 * Detects variation theme from product attributes
 */
async detectVariationTheme(
  asin: string,
  productDetails: ProductDetails
): Promise<string | null> {
  // Extract attributes from product details
  const attributes = Object.keys(productDetails.attributes || {});

  if (attributes.length === 0) return null;

  // Map to variation theme
  if (attributes.includes("Size") && attributes.includes("Color")) {
    return "SizeColor";
  } else if (attributes.includes("Size")) {
    return "Size";
  } else if (attributes.includes("Color")) {
    return "Color";
  }

  return null;
}

/**
 * Gets parent ASIN from child ASIN
 */
async getParentAsin(childAsin: string): Promise<string | null> {
  try {
    const response = await this.sp.callAPI({
      operation: "getItem",
      endpoint: "catalog",
      body: {
        asin: childAsin,
      },
    });

    return response.parentAsin || null;
  } catch (error) {
    console.error(`Failed to get parent ASIN for ${childAsin}:`, error);
    return null;
  }
}

/**
 * Gets child ASINs for parent
 */
async getChildAsins(parentAsin: string): Promise<string[]> {
  try {
    const response = await this.sp.callAPI({
      operation: "searchCatalogItems",
      endpoint: "catalog",
      body: {
        parentAsin,
      },
    });

    return response.items?.map((item: any) => item.asin) || [];
  } catch (error) {
    console.error(`Failed to get child ASINs for ${parentAsin}:`, error);
    return [];
  }
}
```

#### 4.2 eBay Service Enhancements

```typescript
// Add to EbayService class

/**
 * Publishes parent listing (non-purchasable container)
 */
async publishParentListing(
  parentSku: string,
  listingData: EbayListingData
): Promise<string> {
  const token = await this.getAccessToken();
