# Phase 1: Foundation & Database Schema Enhancements
## Nexus Commerce Platform - Amazon & eBay Parent/Child Enhancements

**Date:** April 23, 2026  
**Status:** ✅ Complete  
**Migration:** `20260423_phase1_foundation_enhancements`

---

## Overview

Phase 1 implements production-grade enterprise features for the Nexus Commerce Platform's parent-child product architecture. This foundation enables advanced pricing rules, bulk action queuing, sync health monitoring, and deep variation attribute mapping across 5 marketplaces (Amazon, eBay, Shopify, WooCommerce, Etsy).

---

## Schema Enhancements

### 1. **Sync Health & Logging** (`SyncHealthLog` Model)

Tracks failed imports, conflict resolutions, and duplicate variation errors per channel with comprehensive audit trails.

#### Fields:

| Field | Type | Purpose |
|-------|------|---------|
| `id` | String (CUID) | Primary key |
| `channel` | String | Marketplace identifier (AMAZON, EBAY, SHOPIFY, WOOCOMMERCE, ETSY) |
| `syncJobId` | String? | Reference to the sync job that triggered this log |
| `errorType` | String | Classification: IMPORT_FAILED, CONFLICT_DETECTED, DUPLICATE_VARIATION, VALIDATION_ERROR, MAPPING_ERROR, RATE_LIMIT, AUTHENTICATION_ERROR |
| `severity` | String | INFO, WARNING, ERROR, CRITICAL (default: WARNING) |
| `productId` | String? | Foreign key to Product (nullable, SET NULL on delete) |
| `variationId` | String? | Foreign key to ProductVariation (nullable, SET NULL on delete) |
| `errorMessage` | String | Human-readable error description |
| `errorDetails` | JSON | Detailed context (stack trace, API response, etc.) |
| `conflictType` | String? | PRICE_MISMATCH, INVENTORY_MISMATCH, ATTRIBUTE_MISMATCH, DUPLICATE_SKU, DUPLICATE_ASIN |
| `conflictData` | JSON? | Conflict details: `{"local": {...}, "remote": {...}}` |
| `resolutionStatus` | String | UNRESOLVED, AUTO_RESOLVED, MANUAL_RESOLVED, IGNORED (default: UNRESOLVED) |
| `resolutionNotes` | String? | Notes on resolution |
| `duplicateVariationIds` | String[] | Array of duplicate variation IDs |
| `createdAt` | DateTime | Timestamp of error occurrence |
| `updatedAt` | DateTime | Last update timestamp |
| `resolvedAt` | DateTime? | When the issue was resolved |

#### Indexes:
- `channel` - Fast filtering by marketplace
- `errorType` - Query by error classification
- `severity` - Priority-based queries
- `productId` - Product-specific logs
- `variationId` - Variation-specific logs
- `resolutionStatus` - Unresolved issues tracking
- `createdAt` - Time-based queries

#### Use Cases:
```typescript
// Find all unresolved conflicts for Amazon
const conflicts = await prisma.syncHealthLog.findMany({
  where: {
    channel: 'AMAZON',
    resolutionStatus: 'UNRESOLVED',
    conflictType: { not: null }
  },
  orderBy: { severity: 'desc' }
});

// Track duplicate variations
const duplicates = await prisma.syncHealthLog.findMany({
  where: {
    errorType: 'DUPLICATE_VARIATION',
    channel: 'EBAY'
  }
});

// Monitor sync health by severity
const criticalErrors = await prisma.syncHealthLog.findMany({
  where: { severity: 'CRITICAL' },
  orderBy: { createdAt: 'desc' },
  take: 50
});
```

---

### 2. **Pricing Rules Engine** (Enhanced `PricingRule` Model)

Upgraded with priority-based execution and margin threshold constraints for granular pricing control.

#### New Fields:

| Field | Type | Purpose |
|-------|------|---------|
| `description` | String? | Human-readable rule description |
| `priority` | Int | Execution order (0 = highest, default: 100). Lower numbers execute first |
| `minMarginPercent` | Decimal(5,2)? | Minimum acceptable margin % (e.g., 15.00 for 15%) |
| `maxMarginPercent` | Decimal(5,2)? | Maximum acceptable margin % (e.g., 50.00 for 50%) |

#### Enhanced Type Field:
Now supports: `MATCH_LOW`, `PERCENTAGE_BELOW`, `COST_PLUS_MARGIN`, `FIXED_PRICE`, `DYNAMIC_MARGIN`

#### Relations:
- `products` → `PricingRuleProduct[]` (product-level rules)
- `variations` → `PricingRuleVariation[]` (variation-level rules)

#### Use Cases:
```typescript
// Create a high-priority margin-based rule
const rule = await prisma.pricingRule.create({
  data: {
    name: 'Amazon Premium Margin Rule',
    type: 'DYNAMIC_MARGIN',
    description: 'Maintain 25-35% margin on Amazon listings',
    priority: 10, // High priority
    minMarginPercent: new Decimal('25.00'),
    maxMarginPercent: new Decimal('35.00'),
    parameters: {
      adjustmentType: 'PERCENTAGE',
      adjustmentValue: 5
    },
    isActive: true,
    products: {
      connect: [{ id: 'product-1' }, { id: 'product-2' }]
    }
  }
});

// Apply rule to specific variations
await prisma.pricingRuleVariation.create({
  data: {
    ruleId: rule.id,
    variationId: 'variation-1'
  }
});

// Query rules by priority
const activeRules = await prisma.pricingRule.findMany({
  where: { isActive: true },
  orderBy: { priority: 'asc' }
});
```

---

### 3. **Variation Attribute Mapping** (Enhanced `ProductVariation` Model)

Robust `marketplaceMetadata` JSON field for storing marketplace-specific traits.

#### New Field:

| Field | Type | Purpose |
|-------|------|---------|
| `marketplaceMetadata` | JSON? | Marketplace-specific attributes and traits |

#### Metadata Structure:

```json
{
  "amazon": {
    "browseNodeId": "123456",
    "browseNodePath": ["Electronics", "Computers", "Laptops"],
    "bulletPoints": ["Feature 1", "Feature 2", "Feature 3"],
    "searchTerms": ["keyword1", "keyword2", "keyword3"],
    "asinParent": "B001PARENT",
    "asinChild": "B001CHILD",
    "fulfillmentChannel": "FBA"
  },
  "ebay": {
    "itemSpecifics": {
      "Brand": "Sony",
      "Color": "Black",
      "Storage Capacity": "512GB"
    },
    "categoryId": "15687",
    "conditionId": "3000",
    "itemId": "123456789",
    "variationSpecifics": {
      "Color": "Black",
      "Size": "Large"
    }
  },
  "shopify": {
    "tags": ["tag1", "tag2", "tag3"],
    "vendor": "Vendor Name",
    "productType": "Electronics",
    "variantId": "gid://shopify/ProductVariant/123"
  },
  "woocommerce": {
    "attributes": {
      "color": "black",
      "size": "large"
    },
    "variationId": "456"
  },
  "etsy": {
    "listingId": "789",
    "sku": "ETSY-SKU-001",
    "tags": ["handmade", "vintage"]
  }
}
```

#### Use Cases:
```typescript
// Store Amazon browse node information
const variation = await prisma.productVariation.update({
  where: { id: 'var-1' },
  data: {
    marketplaceMetadata: {
      amazon: {
        browseNodeId: '123456',
        browseNodePath: ['Electronics', 'Computers'],
        bulletPoints: ['High performance', 'Durable'],
        searchTerms: ['laptop', 'computer']
      }
    }
  }
});

// Query variations by marketplace metadata
const amazonVariations = await prisma.productVariation.findMany({
  where: {
    marketplaceMetadata: {
      path: ['amazon', 'browseNodeId'],
      equals: '123456'
    }
  }
});

// Update eBay item specifics
await prisma.productVariation.update({
  where: { id: 'var-1' },
  data: {
    marketplaceMetadata: {
      ...variation.marketplaceMetadata,
      ebay: {
        itemSpecifics: {
          Brand: 'Sony',
          Color: 'Black'
        },
        categoryId: '15687'
      }
    }
  }
});
```

---

### 4. **Bulk Action Queuing** (`BulkActionJob` Model)

Tracks asynchronous bulk operations with progress tracking, error handling, and rollback support.

#### Fields:

| Field | Type | Purpose |
|-------|------|---------|
| `id` | String (CUID) | Primary key |
| `jobName` | String | User-friendly name |
| `actionType` | String | PRICING_UPDATE, INVENTORY_UPDATE, STATUS_UPDATE, ATTRIBUTE_UPDATE, LISTING_SYNC |
| `channel` | String? | Target channel (null = all channels) |
| `targetProductIds` | String[] | Products to process |
| `targetVariationIds` | String[] | Variations to process (empty = all) |
| `filters` | JSON? | Dynamic targeting filters |
| `actionPayload` | JSON | Changes to apply (structure varies by actionType) |
| `status` | String | PENDING, QUEUED, IN_PROGRESS, COMPLETED, FAILED, PARTIALLY_COMPLETED, CANCELLED |
| `totalItems` | Int | Total items to process |
| `processedItems` | Int | Successfully processed |
| `failedItems` | Int | Failed items |
| `skippedItems` | Int | Skipped items |
| `progressPercent` | Int | 0-100 progress indicator |
| `errorLog` | JSON? | Array of errors: `[{"itemId": "...", "error": "...", "timestamp": "..."}]` |
| `lastError` | String? | Most recent error message |
| `isRollbackable` | Boolean | Can this job be rolled back? |
| `rollbackJobId` | String? | Reference to rollback job |
| `rollbackData` | JSON? | Snapshot of original values |
| `createdBy` | String? | User ID who created the job |
| `createdAt` | DateTime | Job creation timestamp |
| `startedAt` | DateTime? | Processing start time |
| `completedAt` | DateTime? | Processing completion time |
| `updatedAt` | DateTime | Last update timestamp |

#### Indexes:
- `actionType` - Query by action type
- `channel` - Filter by marketplace
- `status` - Track job status
- `createdAt` - Time-based queries
- `completedAt` - Completion tracking

#### Action Payload Examples:

**PRICING_UPDATE:**
```json
{
  "priceAdjustment": 5.00,
  "adjustmentType": "FIXED",
  "applyToVariations": true,
  "minPrice": 10.00,
  "maxPrice": 100.00
}
```

**INVENTORY_UPDATE:**
```json
{
  "quantityChange": -10,
  "reason": "Manual adjustment",
  "syncToChannels": ["AMAZON", "EBAY"],
  "reserveStock": 5
}
```

**STATUS_UPDATE:**
```json
{
  "newStatus": "INACTIVE",
  "reason": "Out of stock",
  "notifyChannels": true
}
```

**ATTRIBUTE_UPDATE:**
```json
{
  "attributes": {
    "color": "blue",
    "size": "large"
  },
  "updateMarketplaceMetadata": true
}
```

#### Use Cases:
```typescript
// Create a bulk pricing update job
const job = await prisma.bulkActionJob.create({
  data: {
    jobName: 'Q2 Price Adjustment - Electronics',
    actionType: 'PRICING_UPDATE',
    channel: 'AMAZON',
    targetProductIds: ['prod-1', 'prod-2', 'prod-3'],
    actionPayload: {
      priceAdjustment: 5.00,
      adjustmentType: 'FIXED'
    },
    status: 'PENDING',
    isRollbackable: true
  }
});

// Track job progress
const progress = await prisma.bulkActionJob.findUnique({
  where: { id: job.id }
});
console.log(`Progress: ${progress.progressPercent}% (${progress.processedItems}/${progress.totalItems})`);

// Handle job completion with errors
await prisma.bulkActionJob.update({
  where: { id: job.id },
  data: {
    status: 'PARTIALLY_COMPLETED',
    completedAt: new Date(),
    errorLog: [
      { itemId: 'var-5', error: 'Price below minimum', timestamp: new Date() }
    ]
  }
});

// Create rollback job
const rollbackJob = await prisma.bulkActionJob.create({
  data: {
    jobName: `Rollback: ${job.jobName}`,
    actionType: job.actionType,
    channel: job.channel,
    targetProductIds: job.targetProductIds,
    actionPayload: job.rollbackData,
    status: 'PENDING',
    isRollbackable: false
  }
});

// Query failed jobs for retry
const failedJobs = await prisma.bulkActionJob.findMany({
  where: {
    status: { in: ['FAILED', 'PARTIALLY_COMPLETED'] },
    createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
  },
  orderBy: { createdAt: 'desc' }
});
```

---

### 5. **Pricing Rule Variation Mapping** (`PricingRuleVariation` Model)

Junction table linking pricing rules to specific product variations for granular control.

#### Fields:

| Field | Type | Purpose |
|-------|------|---------|
| `id` | String (CUID) | Primary key |
| `ruleId` | String | Foreign key to PricingRule (CASCADE delete) |
| `variationId` | String | Foreign key to ProductVariation (CASCADE delete) |

#### Constraints:
- Unique constraint on `(ruleId, variationId)` - prevents duplicate rule assignments
- Indexes on both foreign keys for fast lookups

#### Use Cases:
```typescript
// Apply a rule to multiple variations
const variations = ['var-1', 'var-2', 'var-3'];
await Promise.all(
  variations.map(varId =>
    prisma.pricingRuleVariation.create({
      data: {
        ruleId: 'rule-1',
        variationId: varId
      }
    })
  )
);

// Find all rules for a variation
const rules = await prisma.pricingRuleVariation.findMany({
  where: { variationId: 'var-1' },
  include: { rule: true }
});

// Remove a rule from a variation
await prisma.pricingRuleVariation.delete({
  where: {
    ruleId_variationId: {
      ruleId: 'rule-1',
      variationId: 'var-1'
    }
  }
});
```

---

## Migration Details

### File Location:
`packages/database/prisma/migrations/20260423_phase1_foundation_enhancements/migration.sql`

### Key Operations:

1. **ProductVariation Enhancement**
   - Added `marketplaceMetadata` JSONB column
   - Added relation to `PricingRuleVariation`

2. **PricingRule Enhancement**
   - Added `description`, `priority`, `minMarginPercent`, `maxMarginPercent` columns
   - Added relation to `PricingRuleVariation`

3. **PricingRuleProduct Updates**
   - Modified foreign keys to use CASCADE delete
   - Added performance indexes

4. **New Tables**
   - `PricingRuleVariation` - Junction table with indexes
   - `SyncHealthLog` - Comprehensive sync tracking with 7 indexes
   - `BulkActionJob` - Async job queue with 5 indexes

### Execution:
```bash
cd packages/database
npx prisma migrate deploy
```

---

## Data Integrity & Relationships

### Cascade Delete Behavior:
- **PricingRule** → **PricingRuleProduct**: CASCADE
- **PricingRule** → **PricingRuleVariation**: CASCADE
- **Product** → **SyncHealthLog**: SET NULL (preserves logs)
- **ProductVariation** → **SyncHealthLog**: SET NULL (preserves logs)
- **ProductVariation** → **PricingRuleVariation**: CASCADE

### Referential Integrity:
All foreign keys are properly constrained with appropriate delete strategies to maintain data consistency.

---

## Performance Considerations

### Indexes Created:
- **SyncHealthLog**: 7 indexes for multi-dimensional querying
- **BulkActionJob**: 5 indexes for status and time-based queries
- **PricingRuleVariation**: 2 indexes for fast lookups
- **PricingRuleProduct**: 2 indexes for enhanced performance

### Query Optimization:
- Use `channel` index for marketplace-specific queries
- Use `status` index for job tracking
- Use `createdAt` for time-range queries
- Composite indexes support multi-field filtering

---

## Backward Compatibility

✅ **Fully backward compatible** - All new fields are optional (nullable) or have sensible defaults:
- `marketplaceMetadata` - Optional JSON field
- `SyncHealthLog` - New table, doesn't affect existing data
- `BulkActionJob` - New table, doesn't affect existing data
- `PricingRule` enhancements - All new fields have defaults
- `PricingRuleVariation` - New junction table

Existing code continues to work without modification.

---

## Testing Checklist

- [x] Schema validation passes
- [x] All foreign key relationships are correct
- [x] Cascade delete behavior is properly configured
- [x] Indexes are created for performance
- [x] JSON fields support marketplace-specific data
- [x] Backward compatibility maintained

---

## Next Steps

1. **Deploy Migration**: Run `npx prisma migrate deploy` in production
2. **Generate Prisma Client**: `npx prisma generate`
3. **Implement Services**: Create sync health, pricing rules, and bulk action services
4. **Add API Routes**: Implement endpoints for managing these features
5. **Create UI Components**: Build dashboard for monitoring and management

---

## Related Documentation

- [Prisma Schema Reference](https://www.prisma.io/docs/reference/api-reference/prisma-schema-reference)
- [Database Relationships](https://www.prisma.io/docs/concepts/components/prisma-schema/relations)
- [JSON Data Type](https://www.prisma.io/docs/reference/api-reference/prisma-schema-reference#json)

---

**Version:** 1.0  
**Last Updated:** April 23, 2026  
**Status:** ✅ Production Ready
