# Phase 12b: Variation Matrix - Quick Reference

## What Was Built

### 1. API Routes Update
**File**: `apps/api/src/routes/matrix.routes.ts`

- ✅ `updateChannelListing()` now accepts `variationTheme` and `variationMapping`
- ✅ `createChannelListing()` now accepts variation fields
- ✅ `getProductMatrix()` returns variation metadata in response

### 2. Master Catalog Tab
**File**: `apps/web/src/app/catalog/[id]/edit/tabs/MasterCatalogTab.tsx`

**New Features**:
- ✅ Parent/Child toggle button
- ✅ Child product search with real-time filtering
- ✅ Add/remove child products
- ✅ Linked children table with variant display
- ✅ Automatic filtering of current product and already-linked children

**State Variables**:
```typescript
isParent: boolean              // Parent toggle state
childProducts: any[]           // Linked child products
searchQuery: string            // Search input
searchResults: any[]           // Search results
isSearching: boolean           // Loading state
```

### 3. Platform Tab (Amazon)
**File**: `apps/web/src/app/catalog/[id]/edit/tabs/PlatformTab.tsx`

**New Features**:
- ✅ Variation theme dropdown (Size, Color, SizeColor, Style, Material, SizeMaterial)
- ✅ Conditional attribute mapping inputs
- ✅ Linked children preview with variant badges
- ✅ Amazon-only section (not shown for other platforms)

**Supported Themes**:
| Theme | Attributes |
|-------|-----------|
| Size | Size |
| Color | Color |
| SizeColor | Size + Color |
| Style | Style |
| Material | Material |
| SizeMaterial | Size + Material |

## How to Use

### Creating a Parent Product

1. **Open Product Edit Page**
   - Navigate to `/catalog/[id]/edit`

2. **Go to Master Catalog Tab**
   - Scroll to "Variations (Parent/Child)" section
   - Click "Standalone" button to toggle to "Parent"

3. **Link Child Products**
   - Type product SKU or name in search box (minimum 2 characters)
   - Click "+ Add" on desired product
   - Repeat for all child products

4. **Save**
   - Click "💾 Save Master Catalog"

### Configuring Amazon Variation Mapping

1. **Go to Platform Tab**
   - Select "amazon" platform

2. **Select Regional Tab**
   - Choose region (US, UK, DE, etc.)

3. **Scroll to "Variation Mapping" Section**
   - Select variation theme from dropdown
   - Enter attribute mappings for each dimension
   - Example: Size → "SizeMap", Color → "ColorMap"

4. **Verify Linked Children**
   - See preview of linked child products
   - Confirm variant attributes are correct

5. **Save**
   - Changes auto-save when you update fields

## Data Structure

### Product Model
```typescript
{
  id: string
  sku: string
  name: string
  isParent: boolean
  children: Product[]  // Linked child products
  // ... other fields
}
```

### ChannelListing Model
```typescript
{
  id: string
  channel: string
  region: string
  variationTheme?: string  // "Size", "Color", "SizeColor", etc.
  variationMapping?: {
    [attributeName: string]: string  // e.g., { "Size": "SizeMap" }
  }
  // ... other fields
}
```

## API Examples

### Get Product Matrix
```bash
GET /api/products/:id/matrix
```

**Response**:
```json
{
  "product": {
    "id": "prod_123",
    "sku": "PARENT-SKU",
    "name": "Parent Product",
    "isParent": true
  },
  "channelListings": [
    {
      "id": "listing_123",
      "channel": "AMAZON",
      "region": "US",
      "variationTheme": "SizeColor",
      "variationMapping": {
        "Size": "SizeMap",
        "Color": "ColorMap"
      }
    }
  ]
}
```

### Update Channel Listing with Variation
```bash
PUT /api/products/:id/matrix/channel-listing/:listingId
Content-Type: application/json

{
  "title": "Product Title",
  "description": "...",
  "price": 99.99,
  "quantity": 100,
  "variationTheme": "SizeColor",
  "variationMapping": {
    "Size": "SizeMap",
    "Color": "ColorMap"
  }
}
```

## Testing Checklist

### Manual Testing
- [ ] Toggle parent/child mode
- [ ] Search for products to link
- [ ] Add child product
- [ ] Remove child product
- [ ] Select variation theme
- [ ] Enter attribute mappings
- [ ] Verify data saves to database
- [ ] Check linked children preview

### Verification
- [ ] Parent toggle shows correct state
- [ ] Search filters current product
- [ ] Search filters already-linked children
- [ ] Child table displays correctly
- [ ] Variation theme dropdown works
- [ ] Attribute inputs appear/disappear based on theme
- [ ] Linked children preview shows variants

## Common Issues & Solutions

### Issue: Child products not appearing in search
**Solution**: 
- Ensure products exist in database
- Check that products have valid SKU and name
- Verify search query is at least 2 characters

### Issue: Variation mapping not saving
**Solution**:
- Select a variation theme first
- Ensure attribute mapping inputs are visible
- Check browser console for errors

### Issue: Children not showing in table
**Solution**:
- Toggle parent mode ON
- Verify children were added (check search results)
- Refresh page to reload data

### Issue: Amazon variation section not showing
**Solution**:
- Ensure you're on Amazon platform tab
- Select a regional tab (US, UK, etc.)
- Scroll down to find "Variation Mapping" section

## File Locations

| File | Purpose |
|------|---------|
| `apps/api/src/routes/matrix.routes.ts` | API endpoints |
| `apps/web/src/app/catalog/[id]/edit/tabs/MasterCatalogTab.tsx` | Parent/child UI |
| `apps/web/src/app/catalog/[id]/edit/tabs/PlatformTab.tsx` | Variation mapping UI |
| `packages/database/prisma/schema.prisma` | Database schema |

## Next Steps

### Phase 12c: Variation Sync Engine
- Implement variation sync to Amazon Catalog API
- Handle multi-variant listing creation
- Map child products to variation dimensions

### Phase 12d: Variation Inventory
- Sync child inventory to parent listing
- Aggregate stock across variations
- Implement variation-specific pricing

### Phase 12e: Variation Analytics
- Track variation performance
- Analyze sales by variant
- Provide optimization recommendations

## Key Concepts

### Hub & Spoke Architecture
- **Hub** (Master Catalog): Parent/child relationships
- **Spokes** (Channel Listings): Platform-specific variation rules
- **Benefit**: Different platforms can use different variation strategies

### Variation Theme
- Defines which attributes create the variation matrix
- Examples: Size, Color, SizeColor, Style, Material
- Platform-specific (Amazon uses different themes than eBay)

### Variation Mapping
- Maps master product attributes to platform-specific names
- Example: Master "Size" → Amazon "SizeMap"
- Enables consistent attribute naming across platforms

## Support

For issues or questions:
1. Check the troubleshooting section above
2. Review the implementation documentation
3. Check browser console for error messages
4. Review API logs for backend errors
