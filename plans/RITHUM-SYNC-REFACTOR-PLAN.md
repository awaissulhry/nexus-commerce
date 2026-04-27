# Rithum Product Synchronization System Refactor — Comprehensive Implementation Plan

**Project**: Nexus Commerce — Product Sync Refactor  
**Objective**: Implement strict hierarchical parent-child structure following Rithum architecture pattern  
**Status**: Planning Phase  
**Last Updated**: April 23, 2026

---

## Executive Summary

This plan outlines the complete refactoring of the product synchronization system to enforce the Rithum parent-child hierarchy pattern. The current implementation syncs products but lacks:

1. **Variation Theme Detection**: No automatic detection of parent-child relationships from marketplace data
2. **Orphaned Variant Prevention**: No validation to prevent variants without parents
3. **Cascade Operations**: No coordinated updates across parent-child relationships
4. **Marketplace-Specific Handling**: Amazon and eBay services don't understand parent-child structures
5. **Data Normalization**: Existing products may not conform to the parent-child pattern

**Key Deliverables**:
- ProductSyncService with Rithum-compliant logic
- Enhanced Amazon/eBay sync with variation theme detection
- Data validation service for relational integrity
- Migration strategy for existing products
- Comprehensive error handling and logging

---

## Current State Analysis

### ✅ What's Already in Place

**Database Schema** (`packages/database/prisma/schema.prisma`):
- ✅ Product model has `variationTheme` (nullable) and `status` fields
- ✅ ProductVariation has `variationAttributes` (JSON) for multi-axis variations
- ✅ VariantImage model for variant-specific images
- ✅ VariantChannelListing model for per-variant channel tracking
- ✅ Cascade delete relationships configured

**Sync Job** (`apps/api/src/jobs/sync.job.ts`):
- ✅ Phase 0: syncAmazonCatalog() — pulls and enriches products
- ✅ Phase 1: syncNewListings() — publishes to eBay
- ✅ Phase 2: syncPriceParity() — maintains price consistency
- ✅ Cron scheduler (every 30 minutes)

**Marketplace Services**:
- ✅ AmazonService with fetchActiveCatalog() and fetchProductDetails()
- ✅ EbayService with publishNewListing() and updateVariantPrice()
- ✅ MarketplaceService unified abstraction layer

### ❌ What's Missing

**ProductSyncService**:
- ❌ No service to orchestrate parent-child creation
- ❌ No variation theme detection logic
- ❌ No SKU grouping strategy for parent identification
- ❌ No handling of standalone vs. variant products

**Sync Job Enhancements**:
- ❌ syncAmazonCatalog() doesn't detect variation themes
- ❌ No parent product creation before variant creation
- ❌ syncNewListings() doesn't handle parent-child publishing
- ❌ No validation of parent-child relationships

**Data Validation**:
- ❌ No service to validate relational integrity
- ❌ No orphaned variant detection
- ❌ No cascade operation coordination
- ❌ No data consistency checks

**Migration Strategy**:
- ❌ No migration to normalize existing products
- ❌ No strategy for handling legacy flat products
- ❌ No rollback mechanism

---

## Architecture Overview

### System Flow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                    Sync Job (sync.job.ts)                       │
│                                                                   │
│  Phase 0: syncAmazonCatalog()                                    │
│  ├─ Fetch catalog from Amazon SP-API                            │
│  ├─ Call ProductSyncService.syncFromAmazon()                    │
│  │  ├─ Detect variation themes (SKU grouping)                   │
│  │  ├─ Create/update parent products                            │
│  │  ├─ Create/update child variants                             │
│  │  └─ Validate parent-child relationships                      │
│  └─ Enrich with product details                                 │
│                                                                   │
│  Phase 1: syncNewListings()                                      │
│  ├─ Find unlinked products (Amazon ASIN, no eBay)               │
│  ├─ Call ProductSyncService.prepareForEbay()                    │
│  │  ├─ Validate parent-child structure                          │
│  │  ├─ Generate eBay listing data (parent-level)                │
│  │  └─ Prepare variant data for eBay                            │
│  ├─ Publish to eBay (parent listing with variations)            │
│  └─ Create VariantChannelListing records                        │
│                                                                   │
│  Phase 2: syncPriceParity()                                      │
│  ├─ Find linked products (Amazon + eBay)                        │
│  ├─ For each variant:                                            │
│  │  ├─ Compare variant.price to channelListing.channelPrice     │
│  │  ├─ Update VariantChannelListing if drift detected           │
│  │  └─ Call marketplace APIs to sync prices                     │
│  └─ Record sync status per variant                              │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│              ProductSyncService (NEW)                            │
│                                                                   │
│  syncFromAmazon(catalogItems)                                    │
│  ├─ Group SKUs by variation theme                               │
│  ├─ Create parent products                                      │
│  ├─ Create child variants                                       │
│  └─ Return sync results                                         │
│                                                                   │
│  prepareForEbay(product)                                         │
│  ├─ Validate parent-child structure                             │
│  ├─ Build eBay listing data                                     │
│  └─ Return eBay-ready data                                      │
│                                                                   │
│  validateRelationalIntegrity(product)                            │
│  ├─ Check parent exists for all variants                        │
│  ├─ Check variationTheme matches attributes                     │
│  └─ Return validation result                                    │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│         DataValidationService (NEW)                              │
│                                                                   │
│  validateOrphanedVariants()                                      │
│  validateVariationThemeConsistency()                             │
│  validateChannelListingIntegrity()                               │
│  validateCascadeOperations()                                     │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│      Marketplace Services (ENHANCED)                             │
│                                                                   │
│  AmazonService                                                   │
│  ├─ fetchActiveCatalog() — returns parent + child SKUs          │
│  ├─ fetchProductDetails() — includes variation info             │
│  └─ detectVariationTheme() — NEW                                │
│                                                                   │
│  EbayService                                                     │
│  ├─ publishNewListing() — parent-level listing                  │
│  ├─ publishVariations() — NEW (child variations)                │
│  └─ updateVariantPrice() — per-variant pricing                  │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
```

---

## Implementation Phases

### Phase 1: ProductSyncService Creation

**File**: `apps/api/src/services/product-sync.service.ts`

**Responsibilities**:
1. Detect variation themes from marketplace data
2. Group SKUs into parent-child relationships
3. Create parent products with variationTheme
4. Create child variants with variationAttributes
5. Validate parent-child relationships
6. Handle standalone products (variationTheme = null)

**Key Methods**:

```typescript
class ProductSyncService {
  // Detect variation theme from SKU patterns and product attributes
  async detectVariationTheme(
    skus: string[],
    productDetails: ProductDetails[]
  ): Promise<string | null>

  // Group SKUs by parent (variation theme detection)
  groupSkusByParent(
    catalogItems: CatalogItem[]
  ): Map<string, CatalogItem[]>

  // Sync products from Amazon with parent-child structure
  async syncFromAmazon(
    catalogItems: CatalogItem[],
    enrichedDetails: Map<string, ProductDetails>
  ): Promise<SyncResult>

  // Prepare product for eBay publishing (parent-level)
  async prepareForEbay(product: Product): Promise<EbayListingData>

  // Validate parent-child relationships
  async validateRelationalIntegrity(
    product: Product
  ): Promise<ValidationResult>

  // Normalize existing products to parent-child structure
  async normalizeExistingProducts(): Promise<NormalizationResult>
}
```

**Variation Theme Detection Strategy**:

```
1. Analyze SKU patterns:
   - NIKE-AM90-BLK-10, NIKE-AM90-WHT-09 → SizeColor
   - SHIRT-RED-S, SHIRT-RED-M → SizeColor
   - ITEM-001, ITEM-002 → null (standalone)

2. Check product attributes:
   - If product has size + color attributes → SizeColor
   - If product has only size → Size
   - If product has only color → Color

3. Validate consistency:
   - All variants must have same theme attributes
   - No missing attributes in any variant

4. Fallback:
   - If no pattern detected → standalone (variationTheme = null)
```

---

### Phase 2: Sync Job Refactoring

**File**: `apps/api/src/jobs/sync.job.ts` (REFACTORED)

#### Phase 0 Enhancement: syncAmazonCatalog()

**Current Flow**:
```
Fetch catalog → Upsert products → Enrich details
```

**New Flow**:
```
Fetch catalog
  ↓
Detect variation themes (ProductSyncService)
  ↓
Group SKUs by parent
  ↓
Create parent products with variationTheme
  ↓
Create child variants with variationAttributes
  ↓
Enrich with product details
  ↓
Validate parent-child relationships
  ↓
Record sync status
```

**Key Changes**:
- Call `ProductSyncService.syncFromAmazon()` instead of direct upsert
- Detect variation themes before creating products
- Create parent products first, then variants
- Validate relationships after creation
- Log parent-child creation separately

**Example**:
```typescript
async function syncAmazonCatalog(): Promise<void> {
  const catalog = await amazon.fetchActiveCatalog();
  
  // Enrich all items with details
  const enrichedMap = new Map<string, ProductDetails>();
  for (const item of catalog) {
    const details = await amazon.fetchProductDetails(item.sku);
    enrichedMap.set(item.sku, details);
  }
  
  // Sync with parent-child structure
  const syncService = new ProductSyncService();
  const result = await syncService.syncFromAmazon(catalog, enrichedMap);
  
  // Validate relationships
  for (const product of result.createdParents) {
    const validation = await syncService.validateRelationalIntegrity(product);
    if (!validation.isValid) {
      console.error(`Validation failed for ${product.sku}:`, validation.errors);
    }
  }
}
```

#### Phase 1 Enhancement: syncNewListings()

**Current Flow**:
```
Find unlinked products → Generate eBay data → Publish → Create channel listings
```

**New Flow**:
```
Find unlinked products
  ↓
For each product:
  ├─ Validate parent-child structure
  ├─ Prepare for eBay (ProductSyncService)
  ├─ Publish parent listing to eBay
  ├─ Publish variants to eBay
  ├─ Create VariantChannelListing records
  └─ Record sync status
```

**Key Changes**:
- Validate parent-child structure before publishing
- Publish parent listing first (non-purchasable container)
- Publish variants as child listings
- Create VariantChannelListing for each variant
- Handle standalone products (parent is purchasable)

**Example**:
```typescript
async function syncNewListings(): Promise<void> {
  const unlinkedProducts = await prisma.product.findMany({
    where: {
      amazonAsin: { not: null },
      ebayItemId: null,
    },
    include: { variations: true, images: true },
  });

  const syncService = new ProductSyncService();

  for (const product of unlinkedProducts) {
    // Validate parent-child structure
    const validation = await syncService.validateRelationalIntegrity(product);
    if (!validation.isValid) {
      console.error(`Cannot publish ${product.sku}: ${validation.errors.join(', ')}`);
      continue;
    }

    // Prepare for eBay
    const ebayData = await syncService.prepareForEbay(product);

    // Publish parent listing
    const parentListingId = await ebay.publishNewListing(
      product.sku,
      ebayData,
      Number(product.basePrice),
      product.totalStock
    );

    // Publish variants (if any)
    if (product.variations && product.variations.length > 0) {
      await ebay.publishVariations(parentListingId, product.variations);
    }

    // Create channel listings
    for (const variant of product.variations || []) {
      await prisma.variantChannelListing.upsert({
        where: {
          variantId_channelId: {
            variantId: variant.id,
            channelId: "EBAY",
          },
        },
        update: { /* ... */ },
        create: { /* ... */ },
      });
    }
  }
}
```

#### Phase 2: syncPriceParity() (Already Correct)

The current implementation already handles per-variant pricing correctly:
- Compares `variant.price` to `channelListing.channelPrice`
- Updates VariantChannelListing
- Calls marketplace APIs per variant

**No changes needed** — this phase is already Rithum-compliant.

---

### Phase 3: Data Validation Service

**File**: `apps/api/src/services/data-validation.service.ts`

**Responsibilities**:
1. Detect orphaned variants (no parent)
2. Validate variation theme consistency
3. Check channel listing integrity
4. Validate cascade operations
5. Generate validation reports

**Key Methods**:

```typescript
class DataValidationService {
  // Find variants without parents
  async validateOrphanedVariants(): Promise<OrphanedVariant[]>

  // Check variation theme matches attributes
  async validateVariationThemeConsistency(): Promise<ValidationError[]>

  // Ensure all variants have channel listings
  async validateChannelListingIntegrity(): Promise<ValidationError[]>

  // Check cascade delete won't break relationships
  async validateCascadeOperations(productId: string): Promise<ValidationResult>

  // Generate comprehensive validation report
  async generateValidationReport(): Promise<ValidationReport>

  // Fix common data integrity issues
  async autoRepairOrphanedVariants(): Promise<RepairResult>
}
```

**Validation Rules**:

1. **Orphaned Variants**:
   - Every ProductVariation must have a valid productId
   - Parent product must exist
   - Parent must not be deleted

2. **Variation Theme Consistency**:
   - If parent.variationTheme = "SizeColor", all variants must have Size + Color attributes
   - If parent.variationTheme = null, product must have no variants
   - All variants must have same attribute keys

3. **Channel Listing Integrity**:
   - Every variant with channelProductId must have VariantChannelListing
   - VariantChannelListing.channelPrice must match variant.price (or be marked as drift)
   - No orphaned VariantChannelListing records

4. **Cascade Operations**:
   - Deleting parent must cascade to all variants
   - Deleting variant must not affect parent
   - Updating parent.variationTheme must validate all variants

---

### Phase 4: Migration Strategy

**File**: `packages/database/prisma/migrations/[timestamp]_normalize_products_to_parent_child.sql`

**Objectives**:
1. Identify existing products that should be parents
2. Create parent products from existing flat products
3. Move variants to new parent structure
4. Validate data integrity
5. Provide rollback mechanism

**Migration Strategy**:

```sql
-- Step 1: Identify products with multiple SKU variants
-- (These should become parents with children)

-- Step 2: Create parent products
-- - Copy from existing product
-- - Set variationTheme based on variant attributes
-- - Mark as non-purchasable (if has variants)

-- Step 3: Create variants from existing products
-- - Copy product data to ProductVariation
-- - Set variationAttributes from product attributes
-- - Link to parent product

-- Step 4: Update marketplace IDs
-- - Parent gets parent ASIN (non-purchasable)
-- - Variants get child ASINs (purchasable)

-- Step 5: Create VariantChannelListing records
-- - For each variant with marketplace ID
-- - Create channel listing entry

-- Step 6: Validate integrity
-- - Check no orphaned variants
-- - Check variation theme consistency
-- - Check channel listing completeness
```

**Rollback Strategy**:
- Keep backup of original Product table
- Store migration metadata for reversal
- Provide rollback script if needed

---

### Phase 5: Marketplace Service Enhancements

#### Amazon Service Enhancement

**File**: `apps/api/src/services/marketplaces/amazon.service.ts`

**New Methods**:

```typescript
class AmazonService {
  // Detect variation theme from product attributes
  async detectVariationTheme(
    asin: string,
    productDetails: ProductDetails
  ): Promise<string | null>

  // Get parent ASIN (non-purchasable container)
  async getParentAsin(childAsin: string): Promise<string | null>

  // Get child ASINs for parent
  async getChildAsins(parentAsin: string): Promise<string[]>

  // Update parent product (non-purchasable)
  async updateParentProduct(
    parentAsin: string,
    data: ParentProductData
  ): Promise<void>

  // Update child variant (purchasable)
  async updateChildVariant(
    childAsin: string,
    data: ChildVariantData
  ): Promise<void>
}
```

#### eBay Service Enhancement

**File**: `apps/api/src/services/marketplaces/ebay.service.ts`

**New Methods**:

```typescript
class EbayService {
  // Publish parent listing (non-purchasable container)
  async publishParentListing(
    parentSku: string,
    listingData: EbayListingData
  ): Promise<string> // Returns listing ID

  // Publish child variations
  async publishVariations(
    listingId: string,
    variants: ProductVariation[]
  ): Promise<void>

  // Update parent listing
  async updateParentListing(
    listingId: string,
    data: ParentListingData
  ): Promise<void>

  // Update child variant
  async updateChildVariant(
    listingId: string,
    variantSku: string,
    data: ChildVariantData
  ): Promise<void>
}
```

---

### Phase 6: Error Handling & Logging

**Enhancements**:

1. **Structured Logging**:
   - Log parent creation separately from variant creation
   - Include parent-child relationship info
   - Track variation theme detection
   - Log validation results

2. **Error Handling**:
   - Catch and log orphaned variant creation
   - Validate parent-child relationships before operations
   - Provide detailed error messages
   - Implement retry logic for transient failures

3. **Monitoring**:
   - Track sync success rates per phase
   - Monitor parent-child relationship health
   - Alert on validation failures
   - Report on data integrity issues

**Example Logging**:
```typescript
console.log(`[SyncJob] Detected variation theme: ${theme} for SKU ${parentSku}`);
console.log(`[SyncJob] Created parent product: ${parentId} (${parentSku})`);
console.log(`[SyncJob] Created ${variants.length} child variants for parent ${parentId}`);
console.log(`[SyncJob] Validation: ${validation.isValid ? 'PASS' : 'FAIL'}`);
if (!validation.isValid) {
  console.error(`[SyncJob] Validation errors: ${validation.errors.join(', ')}`);
}
```

---

## Implementation Checklist

### Phase 1: ProductSyncService
- [ ] Create `apps/api/src/services/product-sync.service.ts`
- [ ] Implement `detectVariationTheme()` method
- [ ] Implement `groupSkusByParent()` method
- [ ] Implement `syncFromAmazon()` method
- [ ] Implement `prepareForEbay()` method
- [ ] Implement `validateRelationalIntegrity()` method
- [ ] Add comprehensive error handling
- [ ] Add unit tests

### Phase 2: Sync Job Refactoring
- [ ] Refactor `syncAmazonCatalog()` to use ProductSyncService
- [ ] Refactor `syncNewListings()` to handle parent-child publishing
- [ ] Add validation before publishing
- [ ] Update logging to track parent-child operations
- [ ] Test with sample data

### Phase 3: Data Validation Service
- [ ] Create `apps/api/src/services/data-validation.service.ts`
- [ ] Implement orphaned variant detection
- [ ] Implement variation theme consistency checks
- [ ] Implement channel listing integrity checks
- [ ] Implement cascade operation validation
- [ ] Add auto-repair functionality
- [ ] Add unit tests

### Phase 4: Migration Strategy
- [ ] Create migration SQL file
- [ ] Implement data normalization logic
- [ ] Add validation checks
- [ ] Create rollback script
- [ ] Test migration with sample data

### Phase 5: Marketplace Service Enhancements
- [ ] Add variation theme detection to AmazonService
- [ ] Add parent/child ASIN methods to AmazonService
- [ ] Add parent listing publishing to EbayService
- [ ] Add variant publishing to EbayService
- [ ] Update error handling
- [ ] Add unit tests

### Phase 6: Error Handling & Logging
- [ ] Add structured logging throughout
- [ ] Implement comprehensive error handling
- [ ] Add monitoring and alerting
- [ ] Create error recovery procedures
- [ ] Document error codes

### Phase 7: Testing & Verification
- [ ] Unit tests for ProductSyncService
- [ ] Unit tests for DataValidationService
- [ ] Integration tests for sync pipeline
- [ ] End-to-end tests with sample products
- [ ] Performance testing
- [ ] Data integrity verification

### Phase 8: Documentation
- [ ] Update API documentation
- [ ] Create troubleshooting guide
- [ ] Document variation theme detection
- [ ] Create migration guide
- [ ] Add code examples

---

## Key Design Decisions

### 1. Variation Theme Detection

**Decision**: Detect from SKU patterns and product attributes

**Rationale**:
- SKU patterns are reliable indicators (e.g., NIKE-AM90-BLK-10)
- Product attributes provide validation
- Fallback to null for standalone products
- Allows flexibility for different product types

**Implementation**:
```typescript
// SKU pattern analysis
const skuPattern = analyzeSkuPattern(skus);
// e.g., "NIKE-AM90-{COLOR}-{SIZE}" → SizeColor

// Attribute validation
const attributes = extractAttributes(productDetails);
// e.g., ["Size", "Color"] → SizeColor

// Consistency check
const theme = validateTheme(skuPattern, attributes);
```

### 2. Parent-Child Relationship

**Decision**: Strict 2-level hierarchy (parent → variants)

**Rationale**:
- Matches Rithum architecture
- Simplifies queries and operations
- Prevents circular relationships
- Enables cascade operations

**Constraints**:
- Parent cannot have parent
- Variant must have parent
- No variant-of-variant relationships

### 3. Standalone Products

**Decision**: Parent with null variationTheme and no variants

**Rationale**:
- Maintains backward compatibility
- Parent is purchasable (has price, stock)
- No variant overhead
- Simplifies single-SKU products

**Example**:
```typescript
// Standalone product
{
  sku: "ITEM-001",
  variationTheme: null,
  variations: [],
  basePrice: 29.99,
  totalStock: 100
}
```

### 4. Variation Attributes

**Decision**: JSON object with attribute keys and values

**Rationale**:
- Supports multi-axis variations
- Flexible for different product types
- Easy to query and filter
- Matches marketplace standards

**Example**:
```typescript
// Multi-axis variation
{
  variationAttributes: {
    "Size": "M",
    "Color": "Red",
    "Material": "Cotton"
  }
}
```

### 5. Channel Listings

**Decision**: Per-variant VariantChannelListing records

**Rationale**:
- Tracks variant-specific marketplace IDs
- Enables per-variant pricing
- Supports multi-channel publishing
- Simplifies price parity checks

**Example**:
```typescript
// Variant channel listing
{
  variantId: "pv_123",
  channelId: "AMAZON",
  channelProductId: "B08XYZ5678", // Child ASIN
  channelPrice: 129.99,
  channelQuantity: 8
}
```

---

## Data Flow Examples

### Example 1: Syncing Nike Air Max 90 from Amazon

**Input**: Amazon catalog with 2 SKUs
```
NIKE-AM90-BLK-10 (Black, Size 10)
NIKE-AM90-WHT-09 (White, Size 9)
```

**Process**:
1. Detect variation theme: "SizeColor"
2. Group by parent: "NIKE-AM90"
3. Create parent product:
   ```
   {
     sku: "NIKE-AM90",
     name: "Nike Air Max 90",
     variationTheme: "SizeColor",
     amazonAsin: "B08XYZ1234" (parent ASIN)
   }
   ```
4. Create child variants:
   ```
   Variant 1:
   {
     sku: "NIKE-AM90-BLK-10",
     variationAttributes: { "Color": "Black", "Size": "10" },
     price: 129.99,
     amazonAsin: "B08XYZ5678" (child ASIN)
   }
   
   Variant 2:
   {
     sku: "NIKE-AM90-WHT-09",
     variationAttributes: { "Color": "White", "Size": "9" },
     price: 134.99,
     amazonAsin: "B08XYZ5679" (child ASIN)
   }
   ```

**Output**: Parent product with 2 child variants, ready for eBay publishing

---

### Example 2: Publishing to eBay

**Input**: Parent product with 2 variants

**Process**:
1. Validate parent-child structure ✓
2. Publish parent listing to eBay:
   ```
   {
     title: "Nike Air Max 90",
     description: "...",
     category: "Shoes",
     variations: [
       { name: "Color", value: "Black" },
       { name: "Size", value: "10" }
     ]
   }
   ```
3. Publish variants:
   ```
   Variant 1: SKU=NIKE-AM90-BLK-10, Price=129.99, Stock=8
   Variant 2: SKU=NIKE-AM90-WHT-09, Price=134.99, Stock=19
   ```
4. Create VariantChannelListing records:
   ```
   Variant 1 → EBAY channel listing
   Variant 2 → EBAY channel listing
   ```

**Output**: eBay listing with parent container and 2 purchasable variants

---

### Example 3: Price Parity Check

**Input**: Linked product (Amazon + eBay)

**Process**:
1. Find all variants with channel listings
2. For each variant:
   ```
   Variant 1:
   - DB price: 129.99
   - eBay price: 124.99
   - Drift detected: -$5.00
   - Update eBay to 129.99
   ```
3. Update VariantChannelListing
4. Call eBay API to sync price
5. Record sync status

**Output**: All variant prices synchronized across channels

---

## Testing Strategy

### Unit Tests

**ProductSyncService**:
- Test variation theme detection
- Test SKU grouping
- Test parent-child creation
- Test validation logic

**DataValidationService**:
- Test orphaned variant detection
- Test theme consistency checks
- Test channel listing validation
- Test cascade operation validation

**Marketplace Services**:
- Test variation theme detection
- Test parent/child ASIN retrieval
- Test listing publishing
- Test error handling

### Integration Tests

**Sync Pipeline**:
- Test full Amazon → DB sync
- Test DB → eBay publishing
- Test price parity checks
- Test error recovery

**Data Integrity**:
- Test parent-child relationships
- Test cascade operations
- Test validation rules
- Test migration rollback

### End-to-End Tests

**Sample Products**:
- Nike Air Max 90 (SizeColor)
- T-Shirt (SizeColor)
- Standalone item (no variations)
- Complex product (3+ attributes)

**Scenarios**:
- New product sync
- Existing product update
- Variant addition
- Variant removal
- Price changes
- Stock updates

---

## Success Criteria

### Functional Requirements
- ✅ All synced products have proper parent-child relationships
- ✅ Variation themes detected automatically
- ✅ No orphaned variants in database
- ✅ Parent-child relationships validated before operations
- ✅ Cascade operations work correctly
- ✅ Standalone products handled properly

### Data Quality
- ✅ 100% of variants have valid parent
- ✅ 100% of parents have correct variationTheme
- ✅ 100% of variants have matching attributes
- ✅ 100% of channel listings have valid variant
- ✅ No data inconsistencies

### Performance
- ✅ Sync completes in < 5 minutes for 1000 products
- ✅ Variation theme detection < 100ms per product
- ✅ Validation < 50ms per product
- ✅ No database locks during sync

### Reliability
- ✅ Sync job runs every 30 minutes without errors
- ✅ Automatic error recovery
- ✅ Comprehensive logging
- ✅ Monitoring and alerting

---

## Risk Mitigation

### Risk 1: Data Corruption During Migration

**Mitigation**:
- Create backup before migration
- Test migration on staging environment
- Implement rollback script
- Validate data integrity after migration
- Monitor for issues post-migration

### Risk 2: Marketplace API Failures

**Mitigation**:
- Implement retry logic with