# Rithum Product Synchronization Refactor — Quick Reference Guide

**Purpose**: Quick lookup for implementation details  
**Status**: Planning Complete  
**Last Updated**: April 23, 2026

---

## 📋 Implementation Checklist

### Phase 1: ProductSyncService
```
[ ] Create apps/api/src/services/product-sync.service.ts
    [ ] Import dependencies (prisma, AmazonService)
    [ ] Define interfaces (SyncResult, SyncError, ValidationResult)
    [ ] Implement detectVariationTheme()
    [ ] Implement analyzeSkuPattern()
    [ ] Implement extractAttributes()
    [ ] Implement validateThemeConsistency()
    [ ] Implement groupSkusByParent()
    [ ] Implement identifyParentSku()
    [ ] Implement syncFromAmazon()
    [ ] Implement upsertParentProduct()
    [ ] Implement upsertChildVariant()
    [ ] Implement extractVariationAttributes()
    [ ] Implement getAttributesForTheme()
    [ ] Implement validateRelationalIntegrity()
    [ ] Add error handling
    [ ] Add logging
    [ ] Write unit tests
```

### Phase 2: DataValidationService
```
[ ] Create apps/api/src/services/data-validation.service.ts
    [ ] Import dependencies (prisma)
    [ ] Define interfaces (ValidationReport, ValidationError)
    [ ] Implement validateOrphanedVariants()
    [ ] Implement validateVariationThemeConsistency()
    [ ] Implement validateChannelListingIntegrity()
    [ ] Implement validateCascadeOperations()
    [ ] Implement generateValidationReport()
    [ ] Implement autoRepairOrphanedVariants()
    [ ] Add error handling
    [ ] Add logging
    [ ] Write unit tests
```

### Phase 3: Sync Job Refactoring
```
[ ] Refactor apps/api/src/jobs/sync.job.ts
    [ ] Import ProductSyncService
    [ ] Import DataValidationService
    [ ] Enhance syncAmazonCatalog()
        [ ] Add enrichment step
        [ ] Call ProductSyncService.syncFromAmazon()
        [ ] Add validation step
        [ ] Update logging
    [ ] Enhance syncNewListings()
        [ ] Add validation before publishing
        [ ] Call ProductSyncService.prepareForEbay()
        [ ] Publish parent listing
        [ ] Publish variants
        [ ] Create VariantChannelListing records
        [ ] Update logging
    [ ] Test all phases
```

### Phase 4: Marketplace Service Enhancements
```
[ ] Enhance apps/api/src/services/marketplaces/amazon.service.ts
    [ ] Add detectVariationTheme()
    [ ] Add getParentAsin()
    [ ] Add getChildAsins()
    [ ] Add updateParentProduct()
    [ ] Add updateChildVariant()
    [ ] Add error handling
    [ ] Write unit tests

[ ] Enhance apps/api/src/services/marketplaces/ebay.service.ts
    [ ] Add publishParentListing()
    [ ] Add publishVariations()
    [ ] Add updateParentListing()
    [ ] Add updateChildVariant()
    [ ] Add error handling
    [ ] Write unit tests
```

### Phase 5: Migration Strategy
```
[ ] Create packages/database/prisma/migrations/[timestamp]_normalize_products.sql
    [ ] Identify products with multiple SKU variants
    [ ] Create parent products
    [ ] Move variants to parent structure
    [ ] Update marketplace IDs
    [ ] Create VariantChannelListing records
    [ ] Validate data integrity
    [ ] Create rollback script
    [ ] Test with sample data
```

### Phase 6: Testing & Verification
```
[ ] Unit Tests
    [ ] ProductSyncService (all methods)
    [ ] DataValidationService (all methods)
    [ ] Marketplace service enhancements
    [ ] Validation logic

[ ] Integration Tests
    [ ] Full sync pipeline
    [ ] Parent-child creation
    [ ] Marketplace publishing
    [ ] Price parity checks
    [ ] Error recovery

[ ] End-to-End Tests
    [ ] Nike Air Max 90 (SizeColor)
    [ ] T-Shirt (SizeColor)
    [ ] Standalone item (no variations)
    [ ] Complex product (3+ attributes)

[ ] Performance Tests
    [ ] Sync 1000 products
    [ ] Variation theme detection
    [ ] Validation performance
    [ ] Database query optimization
```

### Phase 7: Documentation
```
[ ] API Documentation
    [ ] ProductSyncService methods
    [ ] DataValidationService methods
    [ ] Marketplace service enhancements
    [ ] Error codes and messages

[ ] Troubleshooting Guide
    [ ] Common issues
    [ ] Error recovery
    [ ] Performance optimization
    [ ] Data integrity checks

[ ] Migration Guide
    [ ] Pre-migration checklist
    [ ] Migration steps
    [ ] Post-migration verification
    [ ] Rollback procedure

[ ] Code Examples
    [ ] Sync from Amazon
    [ ] Publish to eBay
    [ ] Validate relationships
    [ ] Handle errors
```

---

## 🔑 Key Concepts

### Variation Theme
**Definition**: Attribute(s) that define product variations  
**Examples**: "Size", "Color", "SizeColor", "SizeMaterial"  
**Null Value**: Standalone product (no variations)

### Parent Product
**Definition**: Non-purchasable container for variations  
**Properties**:
- `variationTheme`: Defines variation axes
- `amazonAsin`: Parent ASIN (non-purchasable)
- `ebayItemId`: Parent listing ID
- `variations`: Array of child variants

### Child Variant
**Definition**: Purchasable SKU with specific attribute values  
**Properties**:
- `variationAttributes`: JSON with attribute values
- `price`: Per-variant pricing
- `stock`: Per-variant inventory
- `amazonAsin`: Child ASIN (purchasable)
- `channelListings`: Per-channel marketplace IDs

### Standalone Product
**Definition**: Single SKU with no variations  
**Properties**:
- `variationTheme`: null
- `variations`: [] (empty)
- Parent is purchasable

---

## 📊 Data Structure Reference

### Product (Parent)
```typescript
{
  id: "pg_cuid123456",
  sku: "NIKE-AM90",
  name: "Nike Air Max 90 Running Shoe",
  basePrice: 129.99,
  totalStock: 32,
  variationTheme: "SizeColor",
  status: "ACTIVE",
  amazonAsin: "B08XYZ1234",
  ebayItemId: "123456789",
  brand: "Nike",
  bulletPoints: [...],
  keywords: [...],
  variations: [/* ... */],
  images: [/* ... */],
  createdAt: "2026-04-23T01:00:00Z",
  updatedAt: "2026-04-23T01:00:00Z"
}
```

### ProductVariation (Child)
```typescript
{
  id: "pv_cuid001",
  productId: "pg_cuid123456",
  sku: "NIKE-AM90-BLK-10",
  variationAttributes: {
    "Color": "Black",
    "Size": "10"
  },
  price: 129.99,
  stock: 8,
  amazonAsin: "B08XYZ5678",
  ebayVariationId: "var_001",
  isActive: true,
  channelListings: [/* ... */],
  images: [/* ... */],
  createdAt: "2026-04-23T01:00:00Z",
  updatedAt: "2026-04-23T01:00:00Z"
}
```

### VariantChannelListing
```typescript
{
  id: "vcl_cuid001",
  variantId: "pv_cuid001",
  channelId: "EBAY",
  channelProductId: "123456789",
  channelSku: "NIKE-AM90-BLK-10",
  channelPrice: 129.99,
  channelQuantity: 8,
  listingStatus: "ACTIVE",
  lastSyncedAt: "2026-04-23T01:00:00Z",
  lastSyncStatus: "SUCCESS"
}
```

---

## 🔄 Sync Flow Diagram

```
┌─────────────────────────────────────────────────────────────┐
│ Phase 0: syncAmazonCatalog()                                │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│ 1. Fetch catalog from Amazon                                │
│    ↓                                                          │
│ 2. Enrich with product details                              │
│    ↓                                                          │
│ 3. Call ProductSyncService.syncFromAmazon()                 │
│    ├─ Detect variation themes                               │
│    ├─ Group SKUs by parent                                  │
│    ├─ Create parent products                                │
│    └─ Create child variants                                 │
│    ↓                                                          │
│ 4. Validate parent-child relationships                      │
│    ↓                                                          │
│ 5. Record sync status                                       │
│                                                               │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│ Phase 1: syncNewListings()                                  │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│ 1. Find unlinked products (Amazon ASIN, no eBay)            │
│    ↓                                                          │
│ 2. For each product:                                        │
│    ├─ Validate parent-child structure                       │
│    ├─ Prepare for eBay                                      │
│    ├─ Publish parent listing                                │
│    ├─ Publish variants                                      │
│    ├─ Create VariantChannelListing records                  │
│    └─ Record sync status                                    │
│                                                               │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│ Phase 2: syncPriceParity()                                  │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│ 1. Find linked products (Amazon + eBay)                     │
│    ↓                                                          │
│ 2. For each variant with channel listings:                  │
│    ├─ Compare variant.price to channelListing.channelPrice  │
│    ├─ Update VariantChannelListing if drift detected        │
│    ├─ Call marketplace APIs to sync prices                  │
│    └─ Record sync status                                    │
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

---

## 🎯 Variation Theme Detection

### Pattern Analysis
```
Input SKUs:
  NIKE-AM90-BLK-10
  NIKE-AM90-WHT-09
  NIKE-AM90-RED-11

Analysis:
  Common prefix: NIKE-AM90
  Variable parts: BLK-10, WHT-09, RED-11
  Pattern: {COLOR}-{SIZE}
  
Output: "SizeColor"
```

### Attribute Extraction
```
From Product Details:
  {
    "Color": "Black",
    "Size": "10"
  }

Detected Attributes: ["Color", "Size"]
Variation Theme: "SizeColor"
```

### Theme Validation
```
Expected Attributes for "SizeColor": ["Color", "Size"]
Detected Attributes: ["Color", "Size"]
Match: ✓ Valid
```

---

## ⚠️ Validation Rules

### Rule 1: Parent Existence
```
✓ Every variant must have a valid parent
✗ Orphaned variants not allowed
```

### Rule 2: Theme Consistency
```
✓ If variationTheme = "SizeColor", all variants must have Size + Color
✗ Missing attributes not allowed
```

### Rule 3: Variant Requirement
```
✓ If variationTheme is set, must have at least 1 variant
✗ Empty variation groups not allowed
```

### Rule 4: Standalone Products
```
✓ If variationTheme = null, must have 0 variants
✗ Variants on standalone products not allowed
```

### Rule 5: Unique Combinations
```
✓ No duplicate attribute combinations within parent
✗ Duplicate variations not allowed
```

### Rule 6: Channel Listings
```
✓ Every variant with marketplace ID must have VariantChannelListing
✗ Orphaned marketplace IDs not allowed
```

---

## 🛠️ Common Tasks

### Task 1: Add New Variation Theme
```
1. Add to VARIATION_THEMES in schema.ts
2. Add axes mapping in getAttributesForTheme()
3. Update VariationsTab UI
4. Test in product editor
5. Update documentation
```

### Task 2: Add New Marketplace
```
1. Create new service in marketplaces/
2. Implement updateVariantPrice()
3. Implement updateVariantInventory()
4. Add to MarketplaceService
5. Update API routes
6. Add environment variables
```

### Task 3: Fix Orphaned Variants
```
1. Run DataValidationService.validateOrphanedVariants()
2. Identify orphaned variants
3. Either:
   a. Delete orphaned variants
   b. Assign to correct parent
4. Validate relationships
5. Record changes
```

### Task 4: Migrate Existing Products
```
1. Create migration SQL
2. Test on staging
3. Create backup
4. Run migration
5. Validate data integrity
6. Monitor for issues
7. Keep rollback script ready
```

---

## 🔍 Debugging Guide

### Issue: Variation Theme Not Detected
```
Possible Causes:
1. SKU pattern doesn't match expected format
2. Product attributes missing
3. Inconsistent attribute values

Solution:
1. Check SKU format (e.g., PARENT-ATTR1-ATTR2)
2. Verify product attributes in Amazon
3. Ensure all variants have same attributes
4. Check analyzeSkuPattern() logic
```

### Issue: Orphaned Variants Found
```
Possible Causes:
1. Parent product deleted
2. Migration error
3. Manual database manipulation

Solution:
1. Run DataValidationService.validateOrphanedVariants()
2. Identify affected variants
3. Either delete or reassign to parent
4. Validate relationships
5. Check logs for root cause
```

### Issue: Price Parity Not Syncing
```
Possible Causes:
1. VariantChannelListing missing
2. Marketplace API error
3. Rate limiting
4. Invalid marketplace ID

Solution:
1. Check VariantChannelListing exists
2. Verify marketplace ID is set
3. Check API response in logs
4. Implement retry logic
5. Check rate limit headers
```

### Issue: Sync Job Failing
```
Possible Causes:
1. Database connection error
2. Marketplace API unavailable
3. Invalid credentials
4. Data validation error

Solution:
1. Check database connection
2. Verify marketplace API status
3. Check environment variables
4. Review validation errors
5. Check logs for details
```

---

## 📈 Performance Optimization

### Database Queries
```
✓ Use indexes on frequently queried fields
✓ Batch operations where possible
✓ Use select() to limit returned fields
✓ Avoid N+1 queries

Fields to Index:
- Product.sku
- Product.amazonAsin
- Product.ebayItemId
- ProductVariation.productId
- ProductVariation.sku
- VariantChannelListing.variantId
- VariantChannelListing.channelId
```

### Sync Job Optimization
```
✓ Process products in batches
✓ Cache marketplace tokens
✓ Implement retry logic
✓ Use dry-run mode for testing
✓ Monitor response times

Batch Size: 10-50 products
Token Cache: 60 seconds
Retry Attempts: 3
Retry Backoff: Exponential (1s, 2s, 4s)
```

### API Rate Limiting
```
Amazon SP-API:
- Rate limit: 2 requests/second
- Burst: 10 requests/second
- Backoff: Exponential

eBay API:
- Rate limit: 5000 calls/hour
- Burst: 100 calls/minute
- Backoff: Exponential

Shopify API:
- Rate limit: 2 requests/second
- Burst: 40 requests/second
- Backoff: Exponential
```

---

## 📝 Logging Standards

### Log Levels
```
ERROR: Critical failures (sync failed, data corruption)
WARN: Non-critical issues (enrichment failed, validation warning)
INFO: Important events (product created, sync complete)
DEBUG: Detailed information (SKU grouping, theme detection)
```

### Log Format
```
[SyncJob] [LEVEL] [PHASE] Message

Examples:
[SyncJob] [INFO] Phase 0: Syncing Amazon catalog…
[SyncJob] [INFO] Phase 0: Detected variation theme: SizeColor for SKU NIKE-AM90
[SyncJob] [INFO] Phase 0: Created parent product: pg_cuid123456 (NIKE-AM90)
[SyncJob] [ERROR] Phase 0: Validation failed for NIKE-AM90: Missing attributes
```

---

## 🚀 Deployment Checklist

### Pre-Deployment
- [ ] All tests passing (unit, integration, e2e)
- [ ] Code review completed
- [ ] Documentation updated
- [ ] Staging environment tested
- [ ] Backup created
- [ ] Rollback plan documented
- [ ] Team notified

### Deployment
- [ ] Deploy code changes
- [ ] Run database migration
- [ ] Verify data integrity
- [ ] Monitor sync job
- [ ] Check error logs
- [ ] Validate marketplace syncs

### Post-Deployment
- [ ] Monitor for 24 hours
- [ ] Check sync success rates
- [ ] Verify data quality
- [ ] Monitor performance
- [ ] Gather feedback
- [ ] Document lessons learned

---

## 📚 Related Documents

### Planning Documents
- [`RITHUM-SYNC-REFACTOR-PLAN.md`](RITHUM-SYNC-REFACTOR-PLAN.md) — Comprehensive implementation plan
- [`RITHUM-SYNC-ARCHITECTURE.md`](RITHUM-SYNC-ARCHITECTURE.md) — System architecture and data flows
- [`RITHUM-IMPLEMENTATION-ROADMAP.md`](RITHUM-IMPLEMENTATION-ROADMAP.md) — Detailed code examples
- [`RITHUM-REFACTOR-SUMMARY.md`](RITHUM-REFACTOR-SUMMARY.md) — Executive summary

### Reference Documents
- [`rithum-architecture-study.md`](rithum-architecture-study.md) — Rithum platform analysis
- [`rithum-product-listing-architecture-part2.md`](rithum-product-listing-architecture-part2.md) — Parent-child hierarchy
- [`IMPLEMENTATION-INDEX.md`](IMPLEMENTATION-INDEX.md) — Phase 1-5 completion summary

---

## ✅ Success Indicators

### Functional
- ✅ All synced products have parent-child relationships
- ✅ Variation themes detected automatically
- ✅ No orphaned variants in database
- ✅ Relationships validated before operations
- ✅ Cascade operations work correctly

### Data Quality
- ✅ 100% of variants have valid parent
- ✅ 100% of parents have correct theme
- ✅ 100% of variants have matching attributes
- ✅ 100% of channel listings have valid variant
- ✅ No data inconsistencies

### Performance
- ✅ Sync < 5 minutes for 1000 products
- ✅ Theme detection < 100ms per product
- ✅ Validation < 50ms per product
- ✅ No database locks

### Reliability
- ✅ Sync runs every 30 minutes without errors
- ✅ Automatic error recovery
- ✅ Comprehensive logging
- ✅ Monitoring and alerting

---

**Last Updated**: April 23, 2026  
**Status**: Ready for Implementation  
**Next Step**: Switch to Code mode to begin implementation
