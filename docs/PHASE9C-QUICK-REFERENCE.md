# Phase 9c: Matrix API Integration - Quick Reference

## What Was Built

Complete API integration for the Multi-Channel Tabbed UI allowing users to manage products across multiple platforms (Amazon, eBay, Shopify, WooCommerce) with region-specific listings and fulfillment offers.

## Key Files

### Frontend Components
| File | Purpose |
|------|---------|
| `apps/web/src/app/catalog/[id]/edit/MatrixEditor.tsx` | Main orchestrator, fetches matrix data, handles saves |
| `apps/web/src/app/catalog/[id]/edit/tabs/MasterCatalogTab.tsx` | Master product management (SKU, name, price, attributes) |
| `apps/web/src/app/catalog/[id]/edit/tabs/PlatformTab.tsx` | Platform-specific listings with regional sub-tabs |
| `apps/web/src/app/catalog/[id]/edit/tabs/OfferCard.tsx` | Fulfillment offer management (FBA/FBM) |

### API Routes
| File | Purpose |
|------|---------|
| `apps/web/src/app/api/products/[id]/matrix/route.ts` | Next.js proxy routes (GET, POST, PUT, DELETE) |
| `apps/api/src/routes/matrix.routes.ts` | Fastify backend routes |

### Utilities
| File | Purpose |
|------|---------|
| `apps/web/src/lib/logger.ts` | Client-side structured logging |

## API Endpoints

### Fetch Matrix Data
```typescript
GET /api/products/:id/matrix
// Returns: { product, channelListings, masterImages }
```

### Create Channel Listing
```typescript
POST /api/products/:id/matrix?endpoint=channel-listing
// Body: { channel, region, title, description, price, quantity, ... }
```

### Update Channel Listing
```typescript
PUT /api/products/:id/matrix?endpoint=channel-listing&resourceId=:listingId
// Body: { title, description, price, quantity, ... }
```

### Create Offer
```typescript
POST /api/products/:id/matrix?endpoint=offer
// Body: { channelListingId, fulfillmentMethod, sku, price, quantity, ... }
```

### Update Offer
```typescript
PUT /api/products/:id/matrix?endpoint=offer&resourceId=:offerId
// Body: { fulfillmentMethod, sku, price, quantity, ... }
```

### Delete Offer
```typescript
DELETE /api/products/:id/matrix?endpoint=offer&resourceId=:offerId
```

## Component Hierarchy

```
ProductEditorForm
└── MatrixEditor (Main Orchestrator)
    ├── MasterCatalogTab
    │   ├── Attribute Manager
    │   └── Image Manager
    └── PlatformTab (Amazon, eBay, Shopify, WooCommerce)
        ├── Regional Sub-tabs
        └── OfferCard (FBA/FBM)
            ├── Pricing Controls
            ├── Inventory Controls
            └── Fulfillment Details
```

## Data Flow

### Load
```
User Opens Edit Page
    ↓
MatrixEditor mounts
    ↓
useEffect: fetchMatrixData()
    ↓
GET /api/products/:id/matrix
    ↓
Next.js Proxy → Fastify Backend
    ↓
Prisma queries database
    ↓
Response: { product, channelListings, masterImages }
    ↓
State updated, tabs render
```

### Save
```
User clicks "Save All Changes"
    ↓
handleSaveChanges() iterates through:
  - Master product (PUT /api/products/:id)
  - Each listing (PUT with endpoint=channel-listing)
  - Each offer (PUT with endpoint=offer)
    ↓
Next.js Proxy routes forward to Fastify
    ↓
Fastify updates database
    ↓
Success/error status displayed
```

## Supported Platforms & Regions

### Amazon (11 regions)
US, CA, MX, UK, DE, FR, IT, ES, JP, AU, IN

### eBay (8 regions)
US, UK, DE, FR, IT, ES, AU, CA

### Shopify (4 regions)
US, CA, UK, AU

### WooCommerce (6 regions)
US, CA, UK, AU, DE, FR

## Fulfillment Methods

- **FBA** (Fulfilled by Amazon): Amazon handles storage, shipping, returns
- **FBM** (Fulfilled by Merchant): Merchant handles all fulfillment

## Key Features

✅ Master Catalog management (SKU, name, price, attributes)
✅ Platform-specific listings per region
✅ Fulfillment offer management (FBA/FBM)
✅ Sync from Master functionality
✅ Profit margin calculation
✅ Universal save logic
✅ Real-time error handling
✅ Structured logging

## Environment Variables

```bash
# Frontend (.env.local)
NEXT_PUBLIC_API_URL=http://localhost:3001

# Backend (.env)
PORT=3001
DATABASE_URL=postgresql://...
```

## Testing Checklist

- [ ] Matrix tab loads without errors
- [ ] Master Catalog tab displays product data
- [ ] Platform tabs show regional sub-tabs
- [ ] Can create new listings
- [ ] Can edit listing details
- [ ] Can delete listings
- [ ] Can add fulfillment offers
- [ ] Can edit offer details
- [ ] Can delete offers
- [ ] Save All Changes persists data
- [ ] Error messages display correctly
- [ ] Logging works in browser console

## Common Issues & Solutions

| Issue | Solution |
|-------|----------|
| 404 on Matrix tab | Verify product exists, check API_URL env var |
| Save button not working | Check browser console, verify proxy routes exist |
| Data not persisting | Check Fastify logs, verify database connection |
| Proxy route not found | Restart Next.js, verify route.ts file exists |

## Performance Notes

- Current implementation loads all data at once (suitable for typical products)
- Save logic is sequential (consider batch endpoints for large datasets)
- No caching implemented (consider React Query for optimization)

## Security Notes

- Add authentication middleware to proxy routes
- Add input validation to proxy routes
- Implement rate limiting for save operations
- Add permission checks (user can only edit own products)

## Next Steps

1. Test with real product data
2. Add input validation
3. Implement authentication checks
4. Add batch operation endpoints
5. Implement real-time sync with WebSockets
6. Add image upload/delete via proxy routes
7. Implement conflict resolution for concurrent edits

## Related Documentation

- [Phase 9 Matrix Architecture](./PHASE9-MATRIX-ARCHITECTURE.md)
- [Phase 9c Full Integration Guide](./PHASE9C-MATRIX-API-INTEGRATION.md)
- [Database Schema](../packages/database/PHASE1-SCHEMA-SUMMARY.md)
