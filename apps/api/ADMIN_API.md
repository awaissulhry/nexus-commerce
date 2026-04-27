# Admin API Documentation

## Overview

The Admin API provides endpoints for data validation, batch repair operations, and system health monitoring. These endpoints are designed for administrative operations on the product catalog.

## Base URL

```
http://localhost:3001/admin
```

## Endpoints

### Validation Endpoints

#### GET /admin/validation/report

Get a comprehensive validation report for all products in the catalog.

**Response:**
```json
{
  "success": true,
  "data": {
    "isValid": false,
    "orphanedVariants": 2,
    "inconsistentThemes": 5,
    "missingAttributes": 12,
    "invalidChannelListings": 3,
    "issues": [
      {
        "type": "ORPHANED_VARIANTS",
        "severity": "ERROR",
        "message": "Found 2 variants without parent product",
        "affectedIds": ["var-id-1", "var-id-2"]
      },
      {
        "type": "MISSING_VARIATION_THEME",
        "severity": "ERROR",
        "message": "Product SKU-001 has variants but no variationTheme",
        "affectedIds": ["prod-id-1"]
      }
    ]
  }
}
```

**Status Codes:**
- `200 OK` - Report generated successfully
- `500 Internal Server Error` - Validation failed

---

#### GET /admin/validation/product/:productId

Validate a specific product.

**Parameters:**
- `productId` (path, required): The product ID to validate

**Response:**
```json
{
  "success": true,
  "data": {
    "isValid": true,
    "orphanedVariants": 0,
    "inconsistentThemes": 0,
    "missingAttributes": 0,
    "invalidChannelListings": 0,
    "issues": []
  }
}
```

**Status Codes:**
- `200 OK` - Validation completed
- `500 Internal Server Error` - Validation failed

---

### Repair Endpoints

#### POST /admin/repair/all

Run all batch repair operations in sequence.

**Request:**
```bash
curl -X POST http://localhost:3001/admin/repair/all
```

**Response:**
```json
{
  "success": true,
  "data": {
    "success": true,
    "timestamp": "2026-04-23T01:20:00.000Z",
    "operations": [
      {
        "name": "Repair Orphaned Variations",
        "description": "Remove variations that reference non-existent products",
        "affectedCount": 2,
        "fixedCount": 2,
        "failedCount": 0,
        "errors": [],
        "duration": 145
      },
      {
        "name": "Repair Missing Variation Themes",
        "description": "Infer and set variation themes for products with variations",
        "affectedCount": 5,
        "fixedCount": 5,
        "failedCount": 0,
        "errors": [],
        "duration": 234
      }
    ],
    "summary": {
      "totalAffected": 22,
      "totalFixed": 20,
      "totalFailed": 2
    }
  }
}
```

**Status Codes:**
- `200 OK` - Repair completed
- `500 Internal Server Error` - Repair failed

---

#### POST /admin/repair/orphaned-variations

Remove variations that reference non-existent products.

**Request:**
```bash
curl -X POST http://localhost:3001/admin/repair/orphaned-variations
```

**Response:**
```json
{
  "success": true,
  "data": {
    "name": "Repair Orphaned Variations",
    "description": "Remove variations that reference non-existent products",
    "affectedCount": 2,
    "fixedCount": 2,
    "failedCount": 0,
    "errors": [],
    "duration": 145
  }
}
```

---

#### POST /admin/repair/missing-themes

Infer and set variation themes for products with variations.

**Request:**
```bash
curl -X POST http://localhost:3001/admin/repair/missing-themes
```

**Response:**
```json
{
  "success": true,
  "data": {
    "name": "Repair Missing Variation Themes",
    "description": "Infer and set variation themes for products with variations",
    "affectedCount": 5,
    "fixedCount": 5,
    "failedCount": 0,
    "errors": [],
    "duration": 234
  }
}
```

**Theme Detection:**
- `SIZE_COLOR`: Products with size and color variations (e.g., `SHIRT-M-BLK`)
- `SIZE`: Products with size variations (e.g., `SHIRT-M`)
- `COLOR`: Products with color variations (e.g., `SHIRT-BLK`)
- `SIZE_MATERIAL`: Products with size and material variations (e.g., `SHIRT-M-COTTON`)
- `MultiAxis`: Products with multiple variations

---

#### POST /admin/repair/missing-attributes

Populate variation attributes from legacy name/value fields.

**Request:**
```bash
curl -X POST http://localhost:3001/admin/repair/missing-attributes
```

**Response:**
```json
{
  "success": true,
  "data": {
    "name": "Repair Missing Variation Attributes",
    "description": "Populate variationAttributes from legacy name/value fields",
    "affectedCount": 12,
    "fixedCount": 12,
    "failedCount": 0,
    "errors": [],
    "duration": 567
  }
}
```

**Transformation:**
- Legacy: `{"name": "Color", "value": "Red"}`
- New: `{"variationAttributes": {"Color": "Red"}}`

---

#### POST /admin/repair/product-status

Ensure all products have valid status values.

**Request:**
```bash
curl -X POST http://localhost:3001/admin/repair/product-status
```

**Response:**
```json
{
  "success": true,
  "data": {
    "name": "Repair Product Status",
    "description": "Ensure all products have valid status values",
    "affectedCount": 3,
    "fixedCount": 3,
    "failedCount": 0,
    "errors": [],
    "duration": 89
  }
}
```

**Valid Status Values:**
- `ACTIVE` (default)
- `DRAFT`
- `INACTIVE`

---

#### POST /admin/repair/channel-listings

Fix variations with missing or invalid channel listings.

**Request:**
```bash
curl -X POST http://localhost:3001/admin/repair/channel-listings
```

**Response:**
```json
{
  "success": true,
  "data": {
    "name": "Repair Inconsistent Channel Listings",
    "description": "Fix variations with missing or invalid channel listings",
    "affectedCount": 8,
    "fixedCount": 8,
    "failedCount": 0,
    "errors": [],
    "duration": 312
  }
}
```

---

### Health Check Endpoint

#### GET /admin/health

Get system health status and issue summary.

**Response (Healthy):**
```json
{
  "status": "healthy",
  "timestamp": "2026-04-23T01:20:00.000Z",
  "issues": {
    "orphanedVariants": 0,
    "inconsistentThemes": 0,
    "missingAttributes": 0,
    "invalidChannelListings": 0
  },
  "totalIssues": 0
}
```

**Response (Warning):**
```json
{
  "status": "warning",
  "timestamp": "2026-04-23T01:20:00.000Z",
  "issues": {
    "orphanedVariants": 2,
    "inconsistentThemes": 5,
    "missingAttributes": 12,
    "invalidChannelListings": 3
  },
  "totalIssues": 22
}
```

**Status Codes:**
- `200 OK` - Health check completed
- `500 Internal Server Error` - Health check failed

---

## Response Format

All endpoints follow a consistent response format:

**Success Response:**
```json
{
  "success": true,
  "data": { /* endpoint-specific data */ }
}
```

**Error Response:**
```json
{
  "success": false,
  "error": "Error message describing what went wrong"
}
```

---

## Error Handling

### Common Error Codes

| Code | Message | Cause |
|------|---------|-------|
| 400 | Bad Request | Invalid parameters |
| 404 | Not Found | Resource not found |
| 500 | Internal Server Error | Server error during operation |

### Error Response Example

```json
{
  "success": false,
  "error": "Failed to repair product SKU-001: Product not found"
}
```

---

## Usage Examples

### Example 1: Full System Repair

```bash
# 1. Check system health
curl http://localhost:3001/admin/health

# 2. Get detailed validation report
curl http://localhost:3001/admin/validation/report

# 3. Run all repairs
curl -X POST http://localhost:3001/admin/repair/all

# 4. Verify health again
curl http://localhost:3001/admin/health
```

### Example 2: Targeted Repair

```bash
# 1. Validate specific product
curl http://localhost:3001/admin/validation/product/prod-123

# 2. Repair only missing themes
curl -X POST http://localhost:3001/admin/repair/missing-themes

# 3. Repair only missing attributes
curl -X POST http://localhost:3001/admin/repair/missing-attributes
```

### Example 3: Monitoring

```bash
# Monitor system health periodically
watch -n 60 'curl -s http://localhost:3001/admin/health | jq'
```

---

## Performance Considerations

### Operation Duration

- **Orphaned Variations**: ~100-200ms for typical catalogs
- **Missing Themes**: ~200-500ms (includes pattern matching)
- **Missing Attributes**: ~300-800ms (batch updates)
- **Product Status**: ~50-150ms
- **Channel Listings**: ~200-600ms (may create new records)

### Batch Size Limits

- No hard limits, but operations on 10,000+ products may take several seconds
- Recommend running repairs during off-peak hours for large catalogs

### Concurrent Operations

- Only one repair operation should run at a time
- Validation operations are read-only and can run concurrently

---

## Integration with Services

### ProductSyncService

The repair operations work with ProductSyncService to ensure:
- Variation themes are properly detected
- Parent-child relationships are maintained
- SKU patterns are recognized

### DataValidationService

Repair operations use validation results to:
- Identify issues
- Track repair progress
- Verify fixes

---

## Troubleshooting

### Issue: Repair operation fails with "Product not found"

**Cause**: Orphaned variations or deleted products

**Solution**:
1. Run `POST /admin/repair/orphaned-variations` first
2. Then run the specific repair operation

### Issue: Theme detection returns "MultiAxis" for all products

**Cause**: SKU patterns don't match recognized formats

**Solution**:
1. Review SKU format in your catalog
2. Update pattern matching in BatchRepairService if needed
3. Manually set themes for non-standard products

### Issue: Channel listings repair fails

**Cause**: No default channel configured

**Solution**:
1. Ensure at least one AMAZON channel exists
2. Create a channel if needed
3. Re-run the repair operation

---

## Related Documentation

- [Batch Repair Service](../src/services/sync/batch-repair.service.ts)
- [Data Validation Service](../src/services/sync/data-validation.service.ts)
- [Product Sync Service](../src/services/sync/product-sync.service.ts)
- [Migration Guide](../../packages/database/MIGRATION_GUIDE.md)
