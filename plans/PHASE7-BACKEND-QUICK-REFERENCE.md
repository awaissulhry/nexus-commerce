# Phase 7: Dynamic Catalog Engine - Backend Quick Reference

## Overview

Phase 7 backend enables dynamic product type schema loading from Amazon SP-API with intelligent caching and validation.

**Status:** ✅ COMPLETE
**Test Results:** 10/10 passing
**Performance:** Cache hit time 0.037ms (100x faster)

---

## Key Files

### Backend Services
| File | Purpose |
|------|---------|
| [`apps/api/src/services/amazon-catalog.service.ts`](../apps/api/src/services/amazon-catalog.service.ts) | Schema fetching, parsing, caching, validation |
| [`apps/api/src/routes/catalog.routes.ts`](../apps/api/src/routes/catalog.routes.ts) | 6 API endpoints |

### Database
| File | Changes |
|------|---------|
| [`packages/database/prisma/schema.prisma`](../packages/database/prisma/schema.prisma) | Added `productType` and `categoryAttributes` |

### Testing
| File | Purpose |
|------|---------|
| [`scripts/test-catalog-schema.ts`](../scripts/test-catalog-schema.ts) | 10 comprehensive tests |

### Documentation
| File | Purpose |
|------|---------|
| [`plans/PHASE7-PIM-ARCHITECTURE.md`](./PHASE7-PIM-ARCHITECTURE.md) | Full architecture blueprint |
| [`plans/PHASE7-BACKEND-IMPLEMENTATION-COMPLETE.md`](./PHASE7-BACKEND-IMPLEMENTATION-COMPLETE.md) | Implementation details |

---

## API Endpoints

### 1. GET /api/catalog/product-types
List available product types

```bash
curl http://localhost:3001/api/catalog/product-types
```

**Response:**
```json
{
  "success": true,
  "data": ["LUGGAGE", "OUTERWEAR", "ELECTRONICS"]
}
```

### 2. GET /api/catalog/product-types/:productType/schema
Fetch schema for a product type

```bash
curl http://localhost:3001/api/catalog/product-types/LUGGAGE/schema
```

**Response:**
```json
{
  "success": true,
  "data": {
    "productType": "LUGGAGE",
    "requiredFields": [
      {
        "name": "material",
        "label": "Material",
        "dataType": "ENUM",
        "required": true,
        "enumValues": ["Nylon", "Leather", "Canvas", "Polycarbonate", "ABS"]
      },
      {
        "name": "dimensions",
        "label": "Dimensions",
        "dataType": "STRING",
        "required": true,
        "maxLength": 50
      },
      {
        "name": "weight",
        "label": "Weight",
        "dataType": "DECIMAL",
        "required": true,
        "minValue": 0,
        "maxValue": 100
      }
    ],
    "optionalFields": [
      {
        "name": "color",
        "label": "Color",
        "dataType": "STRING",
        "required": false
      }
    ]
  }
}
```

### 3. POST /api/catalog/validate
Validate product attributes

```bash
curl -X POST http://localhost:3001/api/catalog/validate \
  -H "Content-Type: application/json" \
  -d '{
    "productType": "LUGGAGE",
    "attributes": {
      "material": "Nylon",
      "dimensions": "20x14x9",
      "weight": 2.5
    }
  }'
```

**Response (Valid):**
```json
{
  "success": true,
  "data": {
    "valid": true,
    "errors": []
  }
}
```

**Response (Invalid):**
```json
{
  "success": true,
  "data": {
    "valid": false,
    "errors": [
      {
        "field": "material",
        "message": "Material is required"
      }
    ]
  }
}
```

### 4. POST /api/products
Create product with dynamic attributes

```bash
curl -X POST http://localhost:3001/api/products \
  -H "Content-Type: application/json" \
  -d '{
    "sku": "LUG-001",
    "name": "Travel Luggage",
    "basePrice": 99.99,
    "productType": "LUGGAGE",
    "categoryAttributes": {
      "material": "Nylon",
      "dimensions": "20x14x9",
      "weight": 2.5,
      "color": "Black"
    }
  }'
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "cuid123",
    "sku": "LUG-001",
    "name": "Travel Luggage",
    "basePrice": 99.99,
    "productType": "LUGGAGE",
    "categoryAttributes": {
      "material": "Nylon",
      "dimensions": "20x14x9",
      "weight": 2.5,
      "color": "Black"
    },
    "status": "ACTIVE",
    "createdAt": "2026-04-24T23:03:34.000Z"
  }
}
```

### 5. GET /api/catalog/cache-stats
Get cache statistics

```bash
curl http://localhost:3001/api/catalog/cache-stats
```

**Response:**
```json
{
  "success": true,
  "data": {
    "size": 2,
    "entries": [
      {
        "productType": "LUGGAGE",
        "expiresAt": "2026-04-25T23:03:34.000Z"
      },
      {
        "productType": "OUTERWEAR",
        "expiresAt": "2026-04-25T23:03:34.000Z"
      }
    ]
  }
}
```

### 6. POST /api/catalog/cache-clear
Clear schema cache (admin)

```bash
curl -X POST http://localhost:3001/api/catalog/cache-clear
```

**Response:**
```json
{
  "success": true,
  "message": "Cache cleared successfully"
}
```

---

## Service Methods

### AmazonCatalogService

```typescript
// Get parsed schema (required + optional fields)
async getProductTypeSchema(productType: string): Promise<ParsedSchema>

// Validate attributes against schema
async validateAttributes(
  productType: string,
  attributes: Record<string, any>
): Promise<ValidationResult>

// Get list of available product types
async getAvailableProductTypes(): Promise<string[]>

// Get required fields only
async getRequiredFields(productType: string): Promise<string[]>

// Get all fields
async getAllFields(productType: string): Promise<FieldDefinition[]>

// Cache management
clearCache(): void
getCacheStats(): { size: number; entries: Array<...> }
```

---

## Database Schema

### Product Model

```prisma
model Product {
  // ... existing fields ...
  
  // NEW: Dynamic PIM Fields
  productType String?              // e.g., "LUGGAGE", "OUTERWEAR"
  categoryAttributes Json?          // { "material": "Nylon", "color": "Black" }
  
  // ... rest of fields ...
}
```

---

## Testing

### Run All Tests

```bash
npx tsx scripts/test-catalog-schema.ts
```

### Test Results

```
✅ Test 1: Fetch product types (3 types found)
✅ Test 2: Fetch LUGGAGE schema (3 required, 2 optional)
✅ Test 3: Fetch OUTERWEAR schema (3 required, 2 optional)
✅ Test 4: Validate valid attributes (PASS)
✅ Test 5: Validate missing required field (FAIL - detected)
✅ Test 6: Validate invalid enum value (FAIL - detected)
✅ Test 7: Cache stats (2 entries, 1440 min TTL)
✅ Test 8: Cache hit performance (0.037ms)
✅ Test 9: Fetch ELECTRONICS schema (2 required, 2 optional)
✅ Test 10: Invalid product type error (error thrown)
```

---

## Mock Product Types

### LUGGAGE
**Required Fields:**
- `material` (ENUM): Nylon, Leather, Canvas, Polycarbonate, ABS
- `dimensions` (STRING): e.g., "20x14x9"
- `weight` (DECIMAL): 0-100 lbs

**Optional Fields:**
- `color` (STRING)
- `warranty` (STRING)

### OUTERWEAR
**Required Fields:**
- `material` (ENUM): Cotton, Polyester, Wool, Silk, Synthetic
- `size` (ENUM): XS, S, M, L, XL, XXL
- `color` (STRING)

**Optional Fields:**
- `care_instructions` (STRING)
- `gender` (ENUM): Men, Women, Unisex

### ELECTRONICS
**Required Fields:**
- `voltage` (ENUM): 110V, 220V, 110-220V
- `wattage` (INT): 1-10000

**Optional Fields:**
- `warranty_months` (INT): 0-60
- `color` (STRING)

---

## Error Codes

| Code | HTTP | Meaning |
|------|------|---------|
| `INVALID_REQUEST` | 400 | Missing or invalid parameters |
| `PRODUCT_TYPE_NOT_FOUND` | 404 | Product type doesn't exist |
| `VALIDATION_FAILED` | 422 | Attribute validation failed |
| `SKU_ALREADY_EXISTS` | 409 | Duplicate SKU |
| `INTERNAL_ERROR` | 500 | Server error |

---

## Performance Metrics

| Metric | Value | Target |
|--------|-------|--------|
| First schema fetch | ~5ms | < 100ms |
| Cache hit time | 0.037ms | < 5ms |
| Validation time | ~1ms | < 10ms |
| Cache TTL | 24 hours | 24 hours |

---

## Configuration

### Environment Variables

```bash
# Optional: Real Amazon SP-API credentials
AMAZON_SP_API_ACCESS_TOKEN=your_token
AMAZON_SP_API_REGION=na  # na, eu, fe

# Database
DATABASE_URL=postgresql://user:password@localhost:5432/nexus_commerce
```

### Mock Data Toggle

In [`apps/api/src/services/amazon-catalog.service.ts`](../apps/api/src/services/amazon-catalog.service.ts):

```typescript
private readonly USE_MOCK_DATA = true;  // Set to false for real Amazon API
```

---

## Integration Points

### Frontend (Phase 7.4)
- Calls `GET /api/catalog/product-types` to populate dropdown
- Calls `GET /api/catalog/product-types/:type/schema` to load form fields
- Calls `POST /api/catalog/validate` to validate before submission
- Calls `POST /api/products` to create product

### Database
- Stores `productType` and `categoryAttributes` in Product table
- Enables querying by product type
- Supports JSON field operations

### Amazon SP-API (Future)
- Replace mock data with real API calls
- Fetch latest product type definitions
- Handle API rate limiting

---

## Next Steps

### Phase 7.4: Frontend UI
- [ ] Create dynamic Add Product page
- [ ] Implement product type selector
- [ ] Implement dynamic form fields
- [ ] Add required field highlighting
- [ ] Implement form validation

### Phase 7.5: Testing & Deployment
- [ ] End-to-end testing
- [ ] Performance testing
- [ ] Production deployment

---

## Troubleshooting

### "Product type not found" error
- Check product type spelling (case-sensitive)
- Verify product type exists in mock data
- Check Amazon SP-API if using real API

### Cache not working
- Check cache stats: `GET /api/catalog/cache-stats`
- Clear cache: `POST /api/catalog/cache-clear`
- Verify cache TTL hasn't expired

### Validation failing unexpectedly
- Check field names match schema
- Verify enum values are exact matches
- Check numeric ranges (min/max)
- Check string length limits

---

## Support

For issues or questions:
1. Check [`PHASE7-BACKEND-IMPLEMENTATION-COMPLETE.md`](./PHASE7-BACKEND-IMPLEMENTATION-COMPLETE.md)
2. Review test results: `npx tsx scripts/test-catalog-schema.ts`
3. Check API error responses
4. Review service logs

---

**Status:** ✅ COMPLETE
**Version:** 1.0.0
**Last Updated:** April 24, 2026
