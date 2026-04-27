# Phase 18: Bulk Creation Pipeline - Debugging Guide

## Issue Summary

The Dynamic Product Wizard's "Create Product" button was failing silently. The frontend was correctly posting to `/api/catalog/products/bulk`, but the backend error handling was too generic.

## Root Causes Identified & Fixed

### 1. **Generic Error Messages**
**Problem**: The catch block was returning a generic "Failed to create bulk product" message without any details.

**Solution**: Enhanced error handling to:
- Log full error stack traces
- Return detailed error messages in development mode
- Handle specific Prisma error codes (P2002, P2025)
- Include error code and name for debugging

### 2. **Missing Error Details**
**Problem**: Frontend couldn't determine what went wrong (validation error, SKU conflict, database error, etc.)

**Solution**: Now returns structured error responses with:
```json
{
  "success": false,
  "error": {
    "code": "INTERNAL_ERROR",
    "message": "Detailed error message",
    "details": {
      "errorCode": "P2002",
      "errorName": "PrismaClientKnownRequestError",
      "stack": "..."
    }
  }
}
```

## Debugging Checklist

### Frontend Issues

- [ ] **Check Fetch URL**: Verify frontend is posting to `/api/catalog/products/bulk` (not `/api/catalog/products`)
  - Location: `apps/web/src/app/catalog/add/page.tsx` line 339
  - Should be: `fetch('/api/catalog/products/bulk', ...)`

- [ ] **Check Payload Structure**: Ensure payload matches expected format
  ```typescript
  {
    master: {
      sku: string,
      name: string,
      basePrice: number,  // Must be number, not string
      productType: string,
      categoryAttributes: Record<string, any>,
      isParent: boolean
    },
    children: Array<{
      sku: string,
      quantity: number,
      price: number
    }>,
    channelListings: Array<{
      channel: 'AMAZON' | 'SHOPIFY',
      title: string,
      priceOverride?: number,
      description: string,
      bulletPoints: string[],
      images: string[]
    }>
  }
  ```

- [ ] **Check Data Types**: 
  - `basePrice` must be `parseFloat()` not string
  - `quantity` and `price` in children must be numbers
  - `bulletPoints` must be array of strings

- [ ] **Check Error Display**: Frontend should display error message from response
  - Location: `apps/web/src/app/catalog/add/page.tsx` line 355-361
  - Should show: `createData.error?.message`

### Backend Issues

- [ ] **Check Endpoint Registration**: Verify route is registered
  - Location: `apps/api/src/routes/catalog.routes.ts` line 329-330
  - Should be: `app.post<{ Body: BulkCreateProductBody }>("/products/bulk", ...)`

- [ ] **Check Validation Logic**: 
  - Master SKU validation (line 336-344)
  - Master name validation (line 346-354)
  - Master basePrice validation (line 356-364)
  - Child SKU uniqueness (line 367-377)
  - SKU conflict detection (line 380-410)

- [ ] **Check Parent Product Logic**:
  - Parent detection: `isParent || children.length > 0` (line 415)
  - Variation attribute filtering (line 427-432)
  - Non-variation error handling (line 435-444)

- [ ] **Check Transaction**:
  - Master product creation (line 463-474)
  - Child product creation (line 480-497)
  - Channel listing creation (line 503-521)

- [ ] **Check Error Handling**:
  - Prisma error codes (P2002, P2025)
  - Development mode error details
  - Stack trace logging

## Common Errors & Solutions

### Error: "SKU_ALREADY_EXISTS"
**Cause**: Product with that SKU already exists in database
**Solution**: Use a unique SKU that hasn't been used before

### Error: "VALIDATION_FAILED"
**Cause**: Required attributes missing or invalid
**Solution**: 
- For parent products: Variation attributes (Color, Size, etc.) are optional
- For standalone products: All required attributes must be provided
- Check schema for required fields

### Error: "INVALID_REQUEST"
**Cause**: Missing or invalid master product fields
**Solution**: Ensure:
- `sku` is not empty
- `name` is not empty
- `basePrice` is a valid number (not string)

### Error: "INTERNAL_ERROR" with P2002
**Cause**: Unique constraint violation (SKU already exists)
**Solution**: Use a different SKU

### Error: "INTERNAL_ERROR" with P2025
**Cause**: Referenced record not found
**Solution**: Verify all foreign key references exist

## Testing the Pipeline

### Manual Test with cURL

```bash
curl -X POST http://localhost:3001/api/catalog/products/bulk \
  -H "Content-Type: application/json" \
  -d '{
    "master": {
      "sku": "TEST-PARENT-001",
      "name": "Test Parent Product",
      "basePrice": 99.99,
      "productType": "OUTERWEAR",
      "categoryAttributes": {
        "brand": "TestBrand",
        "material": "Cotton"
      },
      "isParent": true
    },
    "children": [
      {
        "sku": "TEST-PARENT-001-RED-S",
        "quantity": 10,
        "price": 99.99
      },
      {
        "sku": "TEST-PARENT-001-RED-M",
        "quantity": 15,
        "price": 99.99
      }
    ],
    "channelListings": [
      {
        "channel": "AMAZON",
        "title": "Test Product - Amazon",
        "description": "Test description for Amazon",
        "bulletPoints": ["Feature 1", "Feature 2", "Feature 3"],
        "images": []
      }
    ]
  }'
```

### Expected Success Response

```json
{
  "success": true,
  "data": {
    "master": {
      "id": "...",
      "sku": "TEST-PARENT-001",
      "name": "Test Parent Product",
      ...
    },
    "childrenCount": 2,
    "listingsCount": 1,
    "message": "Created master product with 2 variations and 1 channel listings"
  }
}
```

### Expected Error Response (Development)

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Master product attribute validation failed",
    "details": [
      {
        "field": "brand",
        "message": "Brand is required"
      }
    ]
  }
}
```

## Monitoring & Logging

### API Logs to Check

1. **Console Errors**: Look for "Error creating bulk product:" in API logs
2. **Stack Traces**: Full error stack is logged for debugging
3. **Error Details**: JSON stringified error object for inspection

### Frontend Logs to Check

1. **Network Tab**: Check request/response in browser DevTools
2. **Console**: Look for fetch errors or JSON parse errors
3. **Toast Messages**: User-facing error messages

## Performance Considerations

- **Transaction Size**: Tested with 100+ variations
- **Database Queries**: Single transaction = minimal round-trips
- **Timeout**: Ensure API timeout is sufficient for large batches

## Future Improvements

1. **Batch Size Limits**: Implement max variations per request
2. **Progress Tracking**: Return progress for large batches
3. **Async Processing**: Queue large batches for background processing
4. **Validation Caching**: Cache schema validation results
5. **Retry Logic**: Implement exponential backoff for transient errors

## Related Files

- Frontend: `apps/web/src/app/catalog/add/page.tsx`
- Backend: `apps/api/src/routes/catalog.routes.ts`
- Types: `apps/api/src/routes/catalog.routes.ts` (lines 27-45)
- Database: `packages/database/prisma/schema.prisma`

## Conclusion

The bulk creation pipeline is now fully debuggable with:
- ✅ Detailed error messages
- ✅ Structured error responses
- ✅ Development mode debugging info
- ✅ Comprehensive validation
- ✅ Atomic transactions
- ✅ Proper error handling
