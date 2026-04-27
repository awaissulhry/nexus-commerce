# Rithum Product Synchronization Architecture — Visual Guide

**Document**: Architecture & System Design  
**Status**: Planning Phase  
**Last Updated**: April 23, 2026

---

## System Architecture Diagram

### High-Level Component Interaction

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         EXTERNAL MARKETPLACES                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  ┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐      │
│  │   Amazon SP-API  │    │    eBay REST API │    │  Shopify GraphQL │      │
│  │                  │    │                  │    │                  │      │
│  │ • Catalog Report │    │ • Inventory API  │    │ • Products API   │      │
│  │ • Listings API   │    │ • Offers API     │    │ • Variants API   │      │
│  │ • Pricing API    │    │ • Pricing API    │    │ • Pricing API    │      │
│  └────────┬─────────┘    └────────┬─────────┘    └────────┬─────────┘      │
│           │                       │                       │                 │
└───────────┼───────────────────────┼───────────────────────┼─────────────────┘
            │                       │                       │
            ▼                       ▼                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    MARKETPLACE SERVICES LAYER                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                    AmazonService (ENHANCED)                          │   │
│  ├──────────────────────────────────────────────────────────────────────┤   │
│  │ • fetchActiveCatalog()                                               │   │
│  │ • fetchProductDetails()                                              │   │
│  │ • detectVariationTheme() ← NEW                                       │   │
│  │ • getParentAsin() ← NEW                                              │   │
│  │ • getChildAsins() ← NEW                                              │   │
│  │ • updateVariantPrice()                                               │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                               │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                    EbayService (ENHANCED)                            │   │
│  ├──────────────────────────────────────────────────────────────────────┤   │
│  │ • publishNewListing()                                                │   │
│  │ • publishParentListing() ← NEW                                       │   │
│  │ • publishVariations() ← NEW                                          │   │
│  │ • updateVariantPrice()                                               │   │
│  │ • updateInventory()                                                  │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                               │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                    ShopifyService                                    │   │
│  ├──────────────────────────────────────────────────────────────────────┤   │
│  │ • updateVariantPrice()                                               │   │
│  │ • updateVariantInventory()                                           │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                               │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                    MarketplaceService (Abstraction)                  │   │
│  ├──────────────────────────────────────────────────────────────────────┤   │
│  │ • updatePrice()                                                      │   │
│  │ • updateInventory()                                                  │   │
│  │ • syncVariants()                                                     │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                               │
└─────────────────────────────────────────────────────────────────────────────┘
            ▲                       ▲                       ▲
            │                       │                       │
            └───────────────────────┼───────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    PRODUCT SYNC SERVICE LAYER (NEW)                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                  ProductSyncService (NEW)                            │   │
│  ├──────────────────────────────────────────────────────────────────────┤   │
│  │                                                                       │   │
│  │  Variation Theme Detection:                                          │   │
│  │  ├─ analyzeSkuPattern(skus: string[]): string | null                │   │
│  │  ├─ extractAttributes(details: ProductDetails[]): string[]          │   │
│  │  └─ validateThemeConsistency(theme, attributes): boolean            │   │
│  │                                                                       │   │
│  │  Parent-Child Grouping:                                              │   │
│  │  ├─ groupSkusByParent(items: CatalogItem[]): Map<string, Item[]>   │   │
│  │  ├─ identifyParentSku(childSkus: string[]): string                 │   │
│  │  └─ validateGroupConsistency(group: Item[]): boolean                │   │
│  │                                                                       │   │
│  │  Sync Operations:                                                    │   │
│  │  ├─ syncFromAmazon(catalog, details): SyncResult                    │   │
│  │  ├─ prepareForEbay(product): EbayListingData                        │   │
│  │  └─ normalizeExistingProducts(): NormalizationResult                │   │
│  │                                                                       │   │
│  │  Validation:                                                         │   │
│  │  └─ validateRelationalIntegrity(product): ValidationResult          │   │
│  │                                                                       │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                               │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │              DataValidationService (NEW)                             │   │
│  ├──────────────────────────────────────────────────────────────────────┤   │
│  │                                                                       │   │
│  │  Integrity Checks:                                                   │   │
│  │  ├─ validateOrphanedVariants(): OrphanedVariant[]                   │   │
│  │  ├─ validateVariationThemeConsistency(): ValidationError[]          │   │
│  │  ├─ validateChannelListingIntegrity(): ValidationError[]            │   │
│  │  └─ validateCascadeOperations(productId): ValidationResult          │   │
│  │                                                                       │   │
│  │  Reporting & Repair:                                                 │   │
│  │  ├─ generateValidationReport(): ValidationReport                    │   │
│  │  └─ autoRepairOrphanedVariants(): RepairResult                      │   │
│  │                                                                       │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                               │
└─────────────────────────────────────────────────────────────────────────────┘
            ▲                       ▲
            │                       │
            └───────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                      SYNC JOB ORCHESTRATION LAYER                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                    sync.job.ts (REFACTORED)                          │   │
│  ├──────────────────────────────────────────────────────────────────────┤   │
│  │                                                                       │   │
│  │  Phase 0: syncAmazonCatalog()                                        │   │
│  │  ├─ Fetch catalog from Amazon                                        │   │
│  │  ├─ Enrich with product details                                      │   │
│  │  ├─ Call ProductSyncService.syncFromAmazon()                         │   │
│  │  │  ├─ Detect variation themes                                       │   │
│  │  │  ├─ Group SKUs by parent                                          │   │
│  │  │  ├─ Create parent products                                        │   │
│  │  │  └─ Create child variants                                         │   │
│  │  ├─ Validate parent-child relationships                              │   │
│  │  └─ Record sync status                                               │   │
│  │                                                                       │   │
│  │  Phase 1: syncNewListings()                                          │   │
│  │  ├─ Find unlinked products (Amazon ASIN, no eBay)                    │   │
│  │  ├─ For each product:                                                │   │
│  │  │  ├─ Validate parent-child structure                               │   │
│  │  │  ├─ Call ProductSyncService.prepareForEbay()                      │   │
│  │  │  ├─ Publish parent listing to eBay                                │   │
│  │  │  ├─ Publish variants to eBay                                      │   │
│  │  │  ├─ Create VariantChannelListing records                          │   │
│  │  │  └─ Record sync status                                            │   │
│  │  └─ Log results                                                      │   │
│  │                                                                       │   │
│  │  Phase 2: syncPriceParity()                                          │   │
│  │  ├─ Find linked products (Amazon + eBay)                             │   │
│  │  ├─ For each variant with channel listings:                          │   │
│  │  │  ├─ Compare variant.price to channelListing.channelPrice          │   │
│  │  │  ├─ Update VariantChannelListing if drift detected                │   │
│  │  │  ├─ Call marketplace APIs to sync prices                          │   │
│  │  │  └─ Record sync status                                            │   │
│  │  └─ Log results                                                      │   │
│  │                                                                       │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                               │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                    Cron Scheduler                                    │   │
│  ├──────────────────────────────────────────────────────────────────────┤   │
│  │ • Runs every 30 minutes                                              │   │
│  │ • Executes runSync() function                                        │   │
│  │ • Handles errors and logging                                         │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                               │
└─────────────────────────────────────────────────────────────────────────────┘
            ▲
            │
            ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         DATABASE LAYER                                      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                    Product (Parent)                                  │   │
│  ├──────────────────────────────────────────────────────────────────────┤   │
│  │ • id: String (CUID)                                                  │   │
│  │ • sku: String (unique)                                               │   │
│  │ • name: String                                                       │   │
│  │ • basePrice: Decimal                                                 │   │
│  │ • totalStock: Int                                                    │   │
│  │ • variationTheme: String? (null = standalone)                        │   │
│  │ • status: String (DRAFT, ACTIVE, INACTIVE)                           │   │
│  │ • amazonAsin: String? (parent ASIN)                                  │   │
│  │ • ebayItemId: String? (parent listing ID)                            │   │
│  │ • bulletPoints: String[]                                             │   │
│  │ • keywords: String[]                                                 │   │
│  │ • ... (other fields)                                                 │   │
│  │                                                                       │   │
│  │ Relations:                                                            │   │
│  │ • variations: ProductVariation[] (cascade delete)                    │   │
│  │ • images: ProductImage[]                                             │   │
│  │ • listings: Listing[]                                                │   │
│  │ • marketplaceSyncs: MarketplaceSync[]                                │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                               │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                    ProductVariation (Child)                          │   │
│  ├──────────────────────────────────────────────────────────────────────┤   │
│  │ • id: String (CUID)                                                  │   │
│  │ • productId: String (FK → Product, cascade delete)                   │   │
│  │ • sku: String (unique, child SKU)                                    │   │
│  │ • variationAttributes: Json? (e.g., {"Size": "M", "Color": "Red"})  │   │
│  │ • price: Decimal (per-variant pricing)                               │   │
│  │ • stock: Int (per-variant inventory)                                 │   │
│  │ • amazonAsin: String? (child ASIN)                                   │   │
│  │ • ebayVariationId: String? (eBay variation ID)                       │   │
│  │ • isActive: Boolean                                                  │   │
│  │ • ... (other fields)                                                 │   │
│  │                                                                       │   │
│  │ Relations:                                                            │   │
│  │ • product: Product (parent)                                          │   │
│  │ • images: VariantImage[]                                             │   │
│  │ • channelListings: VariantChannelListing[]                           │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                               │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                    VariantChannelListing                             │   │
│  ├──────────────────────────────────────────────────────────────────────┤   │
│  │ • id: String (CUID)                                                  │   │
│  │ • variantId: String (FK → ProductVariation)                          │   │
│  │ • channelId: String (AMAZON, EBAY, SHOPIFY)                          │   │
│  │ • channelProductId: String (child ASIN, eBay variation ID, etc.)     │   │
│  │ • channelPrice: Decimal                                              │   │
│  │ • channelQuantity: Int                                               │   │
│  │ • listingStatus: String (PENDING, ACTIVE, INACTIVE, ERROR)           │   │
│  │ • lastSyncedAt: DateTime?                                            │   │
│  │ • lastSyncStatus: String? (SUCCESS, FAILED, PENDING)                 │   │
│  │                                                                       │   │
│  │ Unique Constraint: (variantId, channelId)                            │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                               │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                    VariantImage                                      │   │
│  ├──────────────────────────────────────────────────────────────────────┤   │
│  │ • id: String (CUID)                                                  │   │
│  │ • variantId: String (FK → ProductVariation)                          │   │
│  │ • url: String                                                        │   │
│  │ • type: String (MAIN, SWATCH, ALT, LIFESTYLE)                        │   │
│  │ • sortOrder: Int                                                     │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                               │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                    MarketplaceSync                                   │   │
│  ├──────────────────────────────────────────────────────────────────────┤   │
│  │ • id: String (CUID)                                                  │   │
│  │ • productId: String (FK → Product)                                   │   │
│  │ • channel: String (AMAZON, EBAY)                                     │   │
│  │ • lastSyncStatus: String (SUCCESS, FAILED, PENDING)                  │   │
│  │ • lastSyncAt: DateTime                                               │   │
│  │                                                                       │   │
│  │ Unique Constraint: (productId, channel)                              │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                               │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Data Flow Diagrams

### Flow 1: Amazon Catalog Sync with Parent-Child Detection

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ STEP 1: Fetch Catalog from Amazon                                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  AmazonService.fetchActiveCatalog()                                          │
│  ↓                                                                            │
│  Returns: [                                                                  │
│    { sku: "NIKE-AM90-BLK-10", asin: "B08XYZ5678", price: 129.99, qty: 8 },  │
│    { sku: "NIKE-AM90-WHT-09", asin: "B08XYZ5679", price: 134.99, qty: 19 }, │
│    { sku: "NIKE-AM90-RED-11", asin: "B08XYZ5680", price: 139.99, qty: 5 }   │
│  ]                                                                            │
│                                                                               │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│ STEP 2: Enrich with Product Details                                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  For each SKU, call AmazonService.fetchProductDetails()                      │
│  ↓                                                                            │
│  Returns enriched data:                                                      │
│  {                                                                            │
│    sku: "NIKE-AM90-BLK-10",                                                  │
│    title: "Nike Air Max 90 Running Shoe",                                    │
│    brand: "Nike",                                                            │
│    attributes: {                                                             │
│      "Color": "Black",                                                       │
│      "Size": "10"                                                            │
│    },                                                                        │
│    bulletPoints: [...],                                                      │
│    images: [...]                                                             │
│  }                                                                            │
│                                                                               │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│ STEP 3: Call ProductSyncService.syncFromAmazon()                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  Input: catalogItems, enrichedDetails                                        │
│                                                                               │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │ STEP 3a: Detect Variation Theme                                     │    │
│  ├─────────────────────────────────────────────────────────────────────┤    │
│  │                                                                      │    │
│  │  analyzeSkuPattern(["NIKE-AM90-BLK-10", "NIKE-AM90-WHT-09", ...])  │    │
│  │  ↓                                                                   │    │
│  │  Pattern: "NIKE-AM90-{COLOR}-{SIZE}"                                │    │
│  │  ↓                                                                   │    │
│  │  Detected attributes: ["Color", "Size"]                             │    │
│  │  ↓                                                                   │    │
│  │  Variation Theme: "SizeColor"                                        │    │
│  │                                                                      │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                               │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │ STEP 3b: Group SKUs by Parent                                       │    │
│  ├─────────────────────────────────────────────────────────────────────┤    │
│  │                                                                      │    │
│  │  groupSkusByParent(catalogItems)                                    │    │
│  │  ↓                                                                   │    │
│  │  Returns: {                                                          │    │
│  │    "NIKE-AM90": [                                                    │    │
│  │      { sku: "NIKE-AM90-BLK-10", ... },                              │    │
│  │      { sku: "NIKE-AM90-WHT-09", ... },                              │    │
│  │      { sku: "NIKE-AM90-RED-11", ... }                               │    │
│  │    ]                                                                 │    │
│  │  }                                                                   │    │
│  │                                                                      │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                               │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │ STEP 3c: Create Parent Product                                      │    │
│  ├─────────────────────────────────────────────────────────────────────┤    │
│  │                                                                      │    │
│  │  prisma.product.upsert({                                            │    │
│  │    where: { sku: "NIKE-AM90" },                                     │    │
│  │    create: {                                                         │    │
│  │      sku: "NIKE-AM90",                                              │    │
│  │      name: "Nike Air Max 90 Running Shoe",                          │    │
│  │      basePrice: 129.99, // Average of variants                      │    │
│  │      totalStock: 32, // Sum of variants                             │    │
│  │      variationTheme: "SizeColor",                                   │    │
│  │      amazonAsin: "B08XYZ1234", // Parent ASIN                       │    │
│  │      status: "ACTIVE",                                              │    │
│  │      brand: "Nike",                                                 │    │
│  │      bulletPoints: [...],                                           │    │
│  │      keywords: [...]                                                │    │
│  │    },                                                                │    │
│  │    update: { /* ... */ }                                            │    │
│  │  })                                                                  │    │
│  │  ↓                                                                   │    │
│  │  Created: Product {                                                 │    │
│  │    id: "pg_cuid123456",                                             │    │
│  │    sku: "NIKE-AM90",                                                │    │
│  │    variationTheme: "SizeColor"                                      │    │
│  │  }                                                                   │    │
│  │                                                                      │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                               │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │ STEP 3d: Create Child Variants                                      │    │
│  ├─────────────────────────────────────────────────────────────────────┤    │
│  │                                                                      │    │
│  │  For each SKU in group:                                             │    │
│  │                                                                      │    │
│  │  prisma.productVariation.upsert({                                   │    │
│  │    where: { sku: "NIKE-AM90-BLK-10" },                              │    │
│  │    create: {                                                         │    │
│  │      productId: "pg_cuid123456", // Parent ID                       │    │
│  │      sku: "NIKE-AM90-BLK-10",                                       │    │
│  │      variationAttributes: {                                         │    │
│  │        "Color": "Black",                                            │    │
│  │        "Size": "10"                                                 │    │
│  │      },                                                              │    │
│  │      price: 129.99,                                                 │    │
│  │      stock: 8,                                                      │    │
│  │      amazonAsin: "B08XYZ5678", // Child ASIN                        │    │
│  │      isActive: true                                                 │    │
│  │    },                                                                │    │
│  │    update: { /* ... */ }                                            │    │
│  │  })                                                                  │    │
│  │  ↓                                                                   │    │
│  │  Created 3 variants:                                                │    │
│  │  • pv_cuid001 (Black, Size 10)                                      │    │
│  │  • pv_cuid002 (White, Size 9)                                       │    │
│  │  • pv_cuid003 (Red, Size 11)                                        │    │
│  │                                                                      │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                               │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │ STEP 3e: Validate Parent-Child Relationships                        │    │
│  ├─────────────────────────────────────────────────────────────────────┤    │
│  │                                                                      │    │
│  │  validateRelationalIntegrity(product)                               │    │
│  │  ↓                                                                   │    │
│  │  Checks:                                                             │    │
│  │  ✓ Parent exists                                                    │    │
│  │  ✓ All variants have parent                                         │    │
│  │  ✓ variationTheme matches variant attributes                        │    │
│  │  ✓ No orphaned variants                                             │    │
│  │  ↓                                                                   │    │
│  │  Result: { isValid: true, errors: [] }                              │    │
│  │                                                                      │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                               │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│ STEP 4: Record Sync Status                                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  prisma.marketplaceSync.upsert({                                             │
│    where: { productId_channel: { productId: "pg_cuid123456", channel: "AMAZON" } },
│    create: {                                                                 │
│      productId: "pg_cuid123456",                                             │
│      channel: "AMAZON",                                                      │
│      lastSyncStatus: "SUCCESS",                                              │
│      lastSyncAt: new Date()                                                  │
│    },                                                                        │
│    update: { /* ... */ }                                                    │
│  })                                                                          │