# Phase 16: Dynamic Product Wizard - Quick Reference

## What Was Built

### 🎨 Frontend: 3-Step Wizard UI
**File**: `apps/web/src/app/catalog/add/page.tsx`

A modern, intuitive product creation flow with 4 distinct steps:

1. **Product Type Selection** - Choose from available Amazon product types
2. **Master Product Info** - Enter core product details (SKU, Name, Price) + schema-driven fields
3. **Variation Configuration** - Define variation axes and auto-generate child SKUs
4. **Platform Listings** - Add customer-facing content for Amazon & Shopify

**Key Components**:
- `FormField` - Reusable form field component with type-specific rendering
- `showToast` - Toast notification system for user feedback
- State management for multi-step form with validation

### 🔧 Backend: Bulk Creation API
**File**: `apps/api/src/routes/catalog.routes.ts`

**Endpoint**: `POST /api/catalog/products/bulk`

Atomic transaction-based creation of:
- 1 Master Product
- N Child Products (variations)
- M Channel Listings (platform-specific data)

**Key Features**:
- Prisma `$transaction` for all-or-nothing semantics
- Comprehensive validation before transaction
- Detailed error codes and messages
- SKU conflict detection
- Attribute schema validation

## API Contract

### Request
```json
{
  "master": {
    "sku": "JACKET-001",
    "name": "Premium Jacket",
    "basePrice": 99.99,
    "productType": "Clothing",
    "categoryAttributes": { "material": "Cotton" },
    "isParent": true
  },
  "children": [
    { "sku": "JACKET-001-RED-S", "quantity": 10, "price": 99.99 },
    { "sku": "JACKET-001-RED-M", "quantity": 15, "price": 99.99 },
    { "sku": "JACKET-001-BLUE-S", "quantity": 8, "price": 99.99 }
  ],
  "channelListings": [
    {
      "channel": "AMAZON",
      "title": "Premium Cotton Jacket",
      "description": "High-quality jacket...",
      "bulletPoints": ["100% Cotton", "Comfortable fit", "Durable", "Easy care", "Stylish"],
      "images": [],
      "priceOverride": 109.99
    },
    {
      "channel": "SHOPIFY",
      "title": "Premium Jacket",
      "description": "Perfect for any occasion...",
      "bulletPoints": ["Premium quality", "Multiple colors", "All sizes", "Free shipping", "30-day returns"],
      "images": []
    }
  ]
}
```

### Response (Success)
```json
{
  "success": true,
  "data": {
    "master": { "id": "...", "sku": "JACKET-001", ... },
    "childrenCount": 3,
    "listingsCount": 2,
    "message": "Created master product with 3 variations and 2 channel listings"
  }
}
```

### Response (Error)
```json
{
  "success": false,
  "error": {
    "code": "SKU_ALREADY_EXISTS",
    "message": "Product with SKU \"JACKET-001\" already exists"
  }
}
```

## Variation Generation Algorithm

The frontend automatically generates child SKUs using a Cartesian product:

```
Parent SKU: JACKET-001
Axes:
  - Color: Red, Blue
  - Size: S, M, L

Generated SKUs:
  JACKET-001-RED-S
  JACKET-001-RED-M
  JACKET-001-RED-L
  JACKET-001-BLUE-S
  JACKET-001-BLUE-M
  JACKET-001-BLUE-L
```

Total combinations = 2 colors × 3 sizes = 6 variations

## Database Changes

### Product Model
```prisma
model Product {
  // ... existing fields ...
  isMasterProduct  Boolean?        // True if this is a master product
  isParent         Boolean?        // True if this product has children
  masterProductId  String?         // FK to parent product
  master           Product?        @relation("MasterChild", fields: [masterProductId], references: [id])
  children         Product[]       @relation("MasterChild")
  channelListings  ChannelListing[]
}
```

### ChannelListing Model
```prisma
model ChannelListing {
  id                  String
  productId           String
  product             Product
  channel             String        // "AMAZON", "SHOPIFY", etc.
  channelMarket       String        // "AMAZON_US", "SHOPIFY_US", etc.
  region              String        // "US", "DE", "UK", etc.
  title               String?       // Platform-specific title
  description         String?       // Platform-specific description
  price               Decimal?      // Platform-specific price override
  platformAttributes  Json?         // { bulletPoints: [...], images: [...] }
}
```

## Usage Flow

### Step 1: User navigates to `/catalog/add`
```
GET /api/catalog/product-types
→ Returns: ["Clothing", "Electronics", "Books", ...]
```

### Step 2: User selects product type
```
GET /api/catalog/product-types/Clothing/schema
→ Returns: { requiredFields: [...], optionalFields: [...] }
```

### Step 3: User fills master product info
```
POST /api/catalog/validate
Body: { productType: "Clothing", attributes: {...} }
→ Returns: { valid: true, errors: [] }
```

### Step 4: User defines variations and platforms
```
Frontend generates variations locally (no API call)
```

### Step 5: User submits form
```
POST /api/catalog/products/bulk
Body: { master: {...}, children: [...], channelListings: [...] }
→ Returns: { success: true, data: {...} }
```

## Error Handling

| Scenario | Error Code | HTTP Status |
|----------|-----------|------------|
| Missing SKU | INVALID_REQUEST | 400 |
| SKU already exists | SKU_ALREADY_EXISTS | 409 |
| Duplicate child SKUs | INVALID_REQUEST | 400 |
| Attribute validation fails | VALIDATION_FAILED | 422 |
| Database error | INTERNAL_ERROR | 500 |

## Platform-Specific Fields

### Amazon Listing
- **Title**: Product title (max 200 chars)
- **Description**: Full product description
- **Bullet Points**: 5 key features
- **Price Override**: Optional per-product pricing
- **Images**: Product images

### Shopify Listing
- **Title**: Product title
- **Description**: Product description (supports HTML)
- **Bullet Points**: Key selling points
- **Price Override**: Optional per-product pricing
- **Images**: Product images

## Orphan Linking

Users can create a master product without variations, then link existing orphaned SKUs later:

1. Create master product (isParent: false)
2. Later, navigate to Edit Matrix
3. Link existing orphaned SKUs to master
4. System updates masterProductId for linked products

## Performance Notes

- **Variation Generation**: Client-side (instant, no API call)
- **Bulk Creation**: Single transaction (atomic, consistent)
- **Scalability**: Tested with 100+ variations
- **Database**: Minimal queries (1 transaction = 1 round-trip)

## Testing Scenarios

### Scenario 1: Simple Product (No Variations)
```
Master: SIMPLE-001
Children: []
Listings: 1 (Amazon)
Expected: 1 product, 1 listing
```

### Scenario 2: Product with Variations
```
Master: JACKET-001
Children: 6 (2 colors × 3 sizes)
Listings: 2 (Amazon + Shopify)
Expected: 7 products, 2 listings
```

### Scenario 3: Complex Product
```
Master: SHIRT-001
Children: 12 (3 colors × 2 styles × 2 sizes)
Listings: 2 (Amazon + Shopify)
Expected: 13 products, 2 listings
```

## Future Enhancements

- [ ] Bulk image upload for variations
- [ ] Variation template system
- [ ] AI-powered description generation
- [ ] Automatic pricing rules
- [ ] Inventory sync across platforms
- [ ] Dedicated orphan linking UI
- [ ] Variation matrix editor
- [ ] Bulk price/inventory updates

## Support & Troubleshooting

### Issue: "SKU already exists"
**Solution**: Check if SKU is already in database. Use unique SKU for master product.

### Issue: "Validation failed"
**Solution**: Ensure all required attributes are provided according to product type schema.

### Issue: Variations not generating
**Solution**: Ensure all axes have names and at least one value each.

### Issue: Channel listings not created
**Solution**: Ensure title and description are provided for each platform.

## Related Documentation

- [PHASE16-DYNAMIC-WIZARD-IMPLEMENTATION.md](./PHASE16-DYNAMIC-WIZARD-IMPLEMENTATION.md) - Full implementation details
- [AMAZON-SYNC-API.md](./AMAZON-SYNC-API.md) - Product sync to Amazon
- [MARKETPLACE-API-DOCUMENTATION.md](./MARKETPLACE-API-DOCUMENTATION.md) - Platform integrations
