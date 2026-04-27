# Database Migrations

This directory contains database migration scripts for the Nexus Commerce platform.

## Available Migrations

### normalize-products.ts

**Purpose**: Normalize existing products into the Rithum parent-child hierarchical structure

**Type**: TypeScript utility script (optional, enhances SQL migration)

**Features**:
- Sophisticated SKU pattern matching for variation theme detection
- Converts legacy single-axis variations to multi-axis format
- Provides detailed migration report with statistics
- Validates data integrity after migration
- Supports confidence scoring for theme detection

**Usage**:
```bash
npx ts-node packages/database/migrations/normalize-products.ts
```

**Output**:
```
🔄 Starting product normalization migration...

📊 Found 42 products to process

✅ Product SKU-001: Theme detected as "SIZE_COLOR" (confidence: 100.0%)
✅ Product SKU-002: Theme detected as "SIZE" (confidence: 100.0%)
...

📈 Migration Summary:
   • Products updated: 15
   • Themes detected: 15
   • Variations updated: 42

🔍 Data Integrity Check:
   • Products with variations but no theme: 0
   • Variations with legacy fields but no attributes: 0

✨ Migration completed successfully!
```

## SQL Migrations

SQL migrations are managed by Prisma and located in the `prisma/migrations/` directory.

### 20260423011800_normalize_products_to_parent_child

**Purpose**: SQL-level normalization of products to parent-child structure

**Changes**:
1. Populates `ProductVariation.variationAttributes` from legacy `name`/`value` fields
2. Sets `Product.variationTheme` based on variation count
3. Ensures all products have valid `status` field

**Applied via**:
```bash
npx prisma migrate deploy
```

## Migration Workflow

### Recommended Order

1. **Backup Database** (Critical)
   ```bash
   pg_dump $DATABASE_URL > backup_$(date +%Y%m%d_%H%M%S).sql
   ```

2. **Apply SQL Migration**
   ```bash
   npx prisma migrate deploy
   ```

3. **Run TypeScript Migration** (Optional but recommended)
   ```bash
   npx ts-node packages/database/migrations/normalize-products.ts
   ```

4. **Verify Results**
   ```bash
   # Check migration statistics
   SELECT variationTheme, COUNT(*) FROM "Product" 
   WHERE variationTheme IS NOT NULL 
   GROUP BY variationTheme;
   ```

5. **Test Application**
   - Run sync operations
   - Verify product display
   - Check marketplace integrations

## Data Transformations

### Variation Attributes

**Before**:
```json
{
  "name": "Color",
  "value": "Red"
}
```

**After**:
```json
{
  "variationAttributes": {
    "Color": "Red"
  }
}
```

### Variation Theme Detection

The TypeScript migration detects themes using SKU pattern matching:

| Pattern | Example | Theme |
|---------|---------|-------|
| `base-SIZE-COLOR` | `SHIRT-M-BLK` | `SIZE_COLOR` |
| `base-SIZE` | `SHIRT-M` | `SIZE` |
| `base-COLOR` | `SHIRT-BLK` | `COLOR` |
| `base-SIZE-MATERIAL` | `SHIRT-M-COTTON` | `SIZE_MATERIAL` |
| Multiple variations | Any | `MultiAxis` |

## Troubleshooting

### Migration Fails

**Check database connectivity**:
```bash
psql $DATABASE_URL -c "SELECT 1"
```

**Check for constraint violations**:
```bash
# Orphaned variations
SELECT pv.id FROM "ProductVariation" pv
LEFT JOIN "Product" p ON pv."productId" = p.id
WHERE p.id IS NULL;

# Duplicate SKUs
SELECT sku, COUNT(*) FROM "ProductVariation"
GROUP BY sku HAVING COUNT(*) > 1;
```

### Theme Not Detected

**Cause**: SKU format doesn't match recognized patterns

**Solution**: 
1. Review SKU format
2. Manually set theme:
   ```sql
   UPDATE "Product" SET "variationTheme" = 'CustomTheme' WHERE id = '...';
   ```
3. Update pattern matching in migration script

### Variation Attributes Not Populated

**Cause**: No legacy `name`/`value` fields

**Solution**:
```sql
UPDATE "ProductVariation"
SET "variationAttributes" = jsonb_build_object('Variant', 'Default')
WHERE "variationAttributes" IS NULL;
```

## Rollback

### Rollback SQL Migration

```bash
# Rollback to previous migration
npx prisma migrate resolve --rolled-back 20260423011800_normalize_products_to_parent_child
```

### Restore from Backup

```bash
psql $DATABASE_URL < backup_20260423_120000.sql
```

## Performance Notes

- SQL migration: O(n) where n = number of variations
- TypeScript migration: O(n log n) due to pattern matching
- For 10,000+ products, run during off-peak hours
- Both migrations are idempotent (safe to run multiple times)

## Related Documentation

- [Migration Guide](../MIGRATION_GUIDE.md)
- [Rithum Architecture](../../plans/rithum-architecture-study.md)
- [Product Sync Service](../../apps/api/src/services/sync/product-sync.service.ts)
- [Data Validation Service](../../apps/api/src/services/sync/data-validation.service.ts)
