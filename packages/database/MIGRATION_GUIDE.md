# Product Normalization Migration Guide

## Overview

This guide explains how to migrate existing products into the Rithum parent-child hierarchical structure. The migration normalizes your product catalog to support the new variation theme architecture.

## What Gets Migrated

### Before Migration
- Products with variations stored as separate records with legacy `name`/`value` fields
- No variation theme information
- Inconsistent product status values

### After Migration
- Products with variations have `variationTheme` set based on SKU patterns
- Variation attributes converted to multi-axis JSON format: `{"Color": "Red", "Size": "M"}`
- All products have valid `status` field (defaults to `ACTIVE`)
- Backward compatibility maintained (legacy fields preserved)

## Migration Strategy

### Step 1: Backup Your Database

**Critical**: Always backup your database before running migrations.

```bash
# PostgreSQL backup
pg_dump $DATABASE_URL > backup_$(date +%Y%m%d_%H%M%S).sql
```

### Step 2: Run the SQL Migration

The SQL migration handles the core data transformations:

```bash
# Apply the migration
npx prisma migrate deploy

# Or if you need to create a new migration
npx prisma migrate dev --name normalize_products_to_parent_child
```

**What the SQL migration does:**
1. Converts legacy `name`/`value` fields to `variationAttributes` JSON
2. Sets `variationTheme` to `'MultiAxis'` for products with multiple variations
3. Sets `variationTheme` to the attribute name for single-variation products
4. Ensures all products have a valid `status` field

### Step 3: Run the TypeScript Migration Script (Optional)

The TypeScript script provides more sophisticated theme detection using SKU pattern matching:

```bash
# Install dependencies if needed
npm install

# Run the migration script
npx ts-node packages/database/migrations/normalize-products.ts
```

**What the TypeScript script does:**
1. Analyzes SKU patterns to detect variation themes with confidence scores
2. Supports pattern detection for:
   - `SIZE_COLOR`: e.g., `SHIRT-M-BLK`
   - `SIZE`: e.g., `SHIRT-M`
   - `COLOR`: e.g., `SHIRT-BLK`
   - `SIZE_MATERIAL`: e.g., `SHIRT-M-COTTON`
3. Provides detailed migration report with statistics
4. Validates data integrity after migration

### Step 4: Verify Migration Results

Check the migration results:

```bash
# Count products by variation theme
SELECT variationTheme, COUNT(*) as count
FROM "Product"
WHERE variationTheme IS NOT NULL
GROUP BY variationTheme;

# Check for products with variations but no theme
SELECT id, sku, name
FROM "Product"
WHERE EXISTS (
  SELECT 1 FROM "ProductVariation" WHERE "productId" = "Product".id
)
AND variationTheme IS NULL;

# Verify variation attributes are populated
SELECT COUNT(*) as total_variations,
       COUNT(CASE WHEN "variationAttributes" IS NOT NULL THEN 1 END) as with_attributes
FROM "ProductVariation";
```

## Variation Theme Detection

### Supported Patterns

The migration detects the following SKU patterns:

| Theme | Pattern | Example |
|-------|---------|---------|
| `SIZE_COLOR` | `base-SIZE-COLOR` | `SHIRT-M-BLK` |
| `SIZE` | `base-SIZE` | `SHIRT-M` |
| `COLOR` | `base-COLOR` | `SHIRT-BLK` |
| `SIZE_MATERIAL` | `base-SIZE-MATERIAL` | `SHIRT-M-COTTON` |
| `MultiAxis` | Multiple variations (fallback) | Any product with 2+ variations |

### Size Values Recognized
- `XS`, `S`, `M`, `L`, `XL`, `XXL`, `XXXL`, or numeric (e.g., `10`, `12`)

### Color Values Recognized
- `BLK`, `WHT`, `RED`, `BLU`, `GRN`, `YEL`, `BRN`, `GRY`, `PNK`, `PRP`, `NAVY`, `GOLD`, `SILVER`

### Material Values Recognized
- `COTTON`, `POLY`, `WOOL`, `SILK`, `LINEN`

## Data Format Changes

### Legacy Format (Before)
```json
{
  "name": "Color",
  "value": "Red"
}
```

### New Format (After)
```json
{
  "variationAttributes": {
    "Color": "Red"
  }
}
```

### Multi-Axis Example
```json
{
  "variationAttributes": {
    "Color": "Black",
    "Size": "Medium"
  }
}
```

## Rollback Procedure

If you need to rollback the migration:

```bash
# Rollback to previous migration
npx prisma migrate resolve --rolled-back 20260423011800_normalize_products_to_parent_child

# Or restore from backup
psql $DATABASE_URL < backup_20260423_120000.sql
```

## Troubleshooting

### Issue: Products with variations but no theme detected

**Cause**: SKU patterns don't match any recognized patterns

**Solution**: 
1. Review the SKU format for these products
2. Manually set `variationTheme` in the database
3. Update SKU patterns in the migration script if needed

```sql
UPDATE "Product"
SET "variationTheme" = 'CustomTheme'
WHERE id = 'product-id';
```

### Issue: Variation attributes not populated

**Cause**: Variations have no legacy `name`/`value` fields

**Solution**:
1. Manually populate `variationAttributes` for these variations
2. Or update the legacy fields and re-run the migration

```sql
UPDATE "ProductVariation"
SET "variationAttributes" = jsonb_build_object('Variant', 'Default')
WHERE "variationAttributes" IS NULL
AND "productId" = 'product-id';
```

### Issue: Migration fails with constraint errors

**Cause**: Data integrity issues in the database

**Solution**:
1. Check for orphaned variations (variations without products)
2. Check for duplicate SKUs
3. Run the data validation service to identify issues

```bash
# Check for orphaned variations
SELECT pv.id, pv.sku
FROM "ProductVariation" pv
LEFT JOIN "Product" p ON pv."productId" = p.id
WHERE p.id IS NULL;

# Check for duplicate SKUs
SELECT sku, COUNT(*) as count
FROM "ProductVariation"
GROUP BY sku
HAVING COUNT(*) > 1;
```

## Post-Migration Tasks

### 1. Update Application Code

Ensure your application uses the new `variationAttributes` format:

```typescript
// Old way (deprecated)
const theme = variation.name;
const value = variation.value;

// New way
const attributes = variation.variationAttributes;
const theme = Object.keys(attributes)[0];
const value = attributes[theme];
```

### 2. Test Sync Operations

Test the sync services with migrated products:

```bash
# Run a test sync
npm run dev

# Navigate to /engine/ebay and trigger a sync
# Monitor the sync logs for any issues
```

### 3. Validate Data Integrity

Use the DataValidationService to check for issues:

```typescript
import { DataValidationService } from '@nexus/api/services/sync'

const validator = new DataValidationService()
const report = await validator.validateAllProducts()
console.log(report)
```

### 4. Monitor Marketplace Syncs

After migration, monitor your marketplace syncs to ensure:
- Products sync correctly with new variation structure
- Variation attributes are properly mapped to marketplace fields
- No data loss or corruption occurs

## Performance Considerations

- The migration processes all products in memory
- For large catalogs (10,000+ products), consider running during off-peak hours
- The TypeScript script provides progress logging for long-running migrations

## Support

If you encounter issues:

1. Check the troubleshooting section above
2. Review the migration logs for error messages
3. Consult the Rithum architecture documentation
4. Contact support with:
   - Migration error messages
   - Database backup (sanitized)
   - Product SKU examples that failed

## References

- [Rithum Architecture Study](../../plans/rithum-architecture-study.md)
- [Product Sync Service](../src/services/sync/product-sync.service.ts)
- [Data Validation Service](../src/services/sync/data-validation.service.ts)
