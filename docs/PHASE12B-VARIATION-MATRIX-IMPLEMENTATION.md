# Phase 12b: Variation Matrix - Build UI & Integration

**Status**: ✅ Complete  
**Date**: 2026-04-25  
**Version**: 1.0

## Overview

Phase 12b implements the Variation Matrix UI and integration layer, enabling parent/child product relationships and platform-specific variation mapping. This phase builds on the database schema updates from Phase 12a and implements the Hub & Spoke architecture for multi-channel variation management.

## Architecture

### Hub & Spoke Model

```
┌─────────────────────────────────────────────────────────────┐
│                    Master Catalog (Hub)                      │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ Product (Parent)                                     │   │
│  │ - isParent: true                                     │   │
│  │ - children: [Child1, Child2, Child3]                │   │
│  │ - variationTheme: "SizeColor" (master level)        │   │
│  └──────────────────────────────────────────────────────┘   │
│           │                    │                    │        │
│           ▼                    ▼                    ▼        │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐  │
│  │ Child (S-M)  │    │ Child (S-L)  │    │ Child (M-L)  │  │
│  │ SKU: PROD-SM │    │ SKU: PROD-SL │    │ SKU: PROD-ML │  │
│  └──────────────┘    └──────────────┘    └──────────────┘  │
└─────────────────────────────────────────────────────────────┘
         │                    │                    │
         └────────────────────┼────────────────────┘
                              │
         ┌────────────────────┼────────────────────┐
         │                    │                    │
         ▼                    ▼                    ▼
    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
    │   Amazon    │    │    eBay     │    │   Shopify   │
    │   US        │    │    US       │    │   Global    │
    │             │    │             │    │             │
    │ Theme:      │    │ Theme:      │    │ Theme:      │
    │ SizeColor   │    │ Size        │    │ Color       │
    │             │    │             │    │             │
    │ Mapping:    │    │ Mapping:    │    │ Mapping:    │
    │ Size→Size   │    │ Size→Size   │    │ Color→Color │
    │ Color→Color │    │             │    │             │
    └─────────────┘    └─────────────┘    └─────────────┘
```

**Key Principles**:
- **Physical Relationships** (Master Catalog): Parent/Child links stored in `Product.parentId` and `Product.children`
- **Platform Rules** (Channel Listings): Variation theme and mapping stored in `ChannelListing.variationTheme` and `ChannelListing.variationMapping`
- **Flexibility**: Different platforms can use different variation strategies for the same parent product

## Implementation Details

### 1. API Routes (`apps/api/src/routes/matrix.routes.ts`)

#### Updated Endpoints

**`PUT /api/products/:id/matrix/channel-listing/:listingId`**
- Now accepts and saves `variationTheme` and `variationMapping`
- Logs variation theme changes for audit trail

**`POST /api/products/:id/matrix/channel-listing`**
- Creates new channel listings with optional variation configuration
- Supports `variationTheme` and `variationMapping` in request body

**`GET /api/products/:id/matrix`**
- Returns complete product matrix including variation metadata
- Includes `variationTheme` and `variationMapping` in channel listing responses

### 2. Master Catalog UI (`apps/web/src/app/catalog/[id]/edit/tabs/MasterCatalogTab.tsx`)

#### New Components

**Variations (Parent/Child) Section**
- Prominent purple-themed section at the top of the tab
- Displays parent/child relationship status

**Parent Toggle**
- Toggle button: "Is this a Parent Product?"
- Visual indicator showing current state
- Conditionally shows child management UI when enabled

**Child Product Search & Linking**
- Real-time search input (minimum 2 characters)
- Filters out current product and already-linked children
- Displays search results with SKU and name
- "Add" button to link child products

**Linked Children Table**
- Displays all linked child products
- Columns:
  - **SKU**: Product SKU (monospace font)
  - **Name**: Product name
  - **Base Price**: Formatted currency
  - **Variant Options**: Displays variation attributes as badges
  - **Action**: Remove button
- Shows count of linked children
- Empty state message when no children linked

#### State Management

```typescript
const [formData, setFormData] = useState({
  sku: product?.sku || '',
  name: product?.name || '',
  basePrice: product?.basePrice || 0,
  description: product?.description || '',
  attributes: product?.attributes || {},
  isParent: product?.isParent || false,  // NEW
})

const [childProducts, setChildProducts] = useState<any[]>(product?.children || [])  // NEW
const [searchQuery, setSearchQuery] = useState('')  // NEW
const [searchResults, setSearchResults] = useState<any[]>([])  // NEW
const [isSearching, setIsSearching] = useState(false)  // NEW
```

#### Key Handlers

- `handleParentToggle()`: Toggle parent status
- `handleSearchChildren(query)`: Search for products to link
- `handleAddChild(childProduct)`: Add child to parent
- `handleRemoveChild(childId)`: Remove child from parent
- `handleSave()`: Save parent and children data

### 3. Platform Mapping UI (`apps/web/src/app/catalog/[id]/edit/tabs/PlatformTab.tsx`)

#### New Components (Amazon Only)

**Variation Mapping Section**
- Only displayed for Amazon platform
- Positioned before Image Management section
- Blue-themed section for visual distinction

**Variation Theme Dropdown**
- Options:
  - Size
  - Color
  - Size + Color
  - Style
  - Material
  - Size + Material
- Dynamically shows attribute mapping inputs based on selected theme

**Attribute Mapping Inputs**
- Conditional rendering based on selected theme
- Examples:
  - **Size Theme**: Input for "Size Attribute Mapping" (e.g., "SizeMap", "Apparel_Size")
  - **Color Theme**: Input for "Color Attribute Mapping" (e.g., "ColorMap", "Color")
  - **SizeColor Theme**: Both Size and Color inputs
  - **Style Theme**: Input for "Style Attribute Mapping"
  - **Material Theme**: Input for "Material Attribute Mapping"

**Linked Children Preview**
- Shows all child products linked to parent
- Displays variation attributes as badges
- Helps users verify correct mapping configuration

#### State Management

```typescript
interface ChannelListing {
  // ... existing fields
  variationTheme?: string  // NEW
  variationMapping?: Record<string, any>  // NEW
}
```

#### Key Handlers

- `handleVariationThemeChange(theme)`: Update selected theme
- `handleVariationMappingChange(masterAttr, mappedValue)`: Update attribute mapping

### 4. Data Flow

#### Saving Parent/Child Relationships

```
User toggles "Is Parent?" → handleParentToggle()
                          ↓
                    setFormData()
                          ↓
                    User clicks Save
                          ↓
                    handleSave() called
                          ↓
                    onUpdate({...formData, children: childProducts})
                          ↓
                    Parent component saves to API
                          ↓
                    Product.isParent = true
                    Product.children = [...]
```

#### Saving Variation Mapping

```
User selects variation theme → handleVariationThemeChange()
                              ↓
                        handleListingUpdate()
                              ↓
                        ChannelListing.variationTheme = "SizeColor"
                              ↓
User enters attribute mapping → handleVariationMappingChange()
                              ↓
                        handleListingUpdate()
                              ↓
                        ChannelListing.variationMapping = {
                          Size: "SizeMap",
                          Color: "ColorMap"
                        }
```

## Database Schema

### Product Model
```prisma
model Product {
  // ... existing fields
  
  // Parent/Child Hierarchy
  isParent          Boolean   @default(false)
  parentId          String?
  parent            Product?  @relation("ProductHierarchy", fields: [parentId], references: [id], onDelete: Cascade)
  children          Product[] @relation("ProductHierarchy")
}
```

### ChannelListing Model
```prisma
model ChannelListing {
  // ... existing fields
  
  // PHASE 12b: Variation Matrix
  variationTheme    String?
  variationMapping  Json?
}
```

## UI/UX Features

### Visual Design

**Master Catalog Tab**
- Purple gradient background for Variations section
- Clear parent/child toggle with status indicator
- Search results with hover effects
- Table with alternating row colors
- Variant badges with color coding

**Platform Tab (Amazon)**
- Blue-themed variation mapping section
- Conditional attribute inputs based on theme selection
- Child product preview with variation badges
- Helpful hints and examples for each attribute

### User Experience

1. **Parent Toggle**: One-click toggle to enable/disable parent mode
2. **Smart Search**: Filters out current product and already-linked children
3. **Visual Feedback**: Loading spinner during search, empty states with guidance
4. **Attribute Mapping**: Dynamic form that shows only relevant inputs
5. **Preview**: See linked children and their attributes while configuring mapping

## Testing Checklist

### Unit Tests
- [ ] Parent toggle functionality
- [ ] Child product search and filtering
- [ ] Add/remove child operations
- [ ] Variation theme selection
- [ ] Attribute mapping updates
- [ ] Data persistence

### Integration Tests
- [ ] Parent/child relationship creation
- [ ] Variation mapping with multiple themes
- [ ] Cross-platform variation strategies
- [ ] API endpoint validation

### Manual Testing
- [ ] Create parent product and link children
- [ ] Configure Amazon variation mapping
- [ ] Verify data saves to database
- [ ] Test with different variation themes
- [ ] Verify child product removal
- [ ] Test search functionality

## API Examples

### Create Parent Product with Children

```bash
PUT /api/products/:id/matrix/channel-listing/:listingId
Content-Type: application/json

{
  "title": "Premium Wireless Headphones",
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

### Response

```json
{
  "id": "listing_123",
  "channel": "AMAZON",
  "region": "US",
  "variationTheme": "SizeColor",
  "variationMapping": {
    "Size": "SizeMap",
    "Color": "ColorMap"
  },
  "offers": [...],
  "images": [...]
}
```

## File Changes Summary

### Modified Files

1. **`apps/api/src/routes/matrix.routes.ts`**
   - Updated `updateChannelListing()` to handle `variationTheme` and `variationMapping`
   - Updated `createChannelListing()` to accept variation fields
   - Updated `getProductMatrix()` response to include variation metadata

2. **`apps/web/src/app/catalog/[id]/edit/tabs/MasterCatalogTab.tsx`**
   - Added parent/child state management
   - Added Variations section with parent toggle
   - Added child product search and linking UI
   - Added linked children table with variant display
   - Updated save handler to persist children

3. **`apps/web/src/app/catalog/[id]/edit/tabs/PlatformTab.tsx`**
   - Added `variationTheme` and `variationMapping` to ChannelListing interface
   - Added Variation Mapping section (Amazon only)
   - Added variation theme dropdown
   - Added conditional attribute mapping inputs
   - Added linked children preview
   - Added handlers for theme and mapping changes

## Next Steps

### Phase 12c: Variation Sync Engine
- Implement variation sync logic for Amazon Catalog API
- Handle multi-variant listing creation
- Map child products to variation dimensions
- Sync variation attributes to marketplace

### Phase 12d: Variation Inventory Management
- Sync child product inventory to parent listing
- Handle stock aggregation across variations
- Implement variation-specific pricing rules

### Phase 12e: Variation Analytics
- Track variation performance metrics
- Analyze which variations sell best
- Provide recommendations for variation optimization

## Troubleshooting

### Issue: Child products not appearing in search
**Solution**: Ensure products exist in database and have valid SKU/name fields

### Issue: Variation mapping not saving
**Solution**: Verify variation theme is selected before entering attribute mappings

### Issue: Children not showing in table
**Solution**: Check that parent toggle is enabled and children are properly linked

## References

- [Hub & Spoke Architecture Pattern](../plans/PHASE9-MATRIX-ARCHITECTURE.md)
- [Database Schema](../packages/database/prisma/schema.prisma)
- [Matrix API Routes](../apps/api/src/routes/matrix.routes.ts)
- [Amazon Variation Documentation](https://developer.amazon.com/docs/catalog-items-api/variations.html)

## Conclusion

Phase 12b successfully implements the Variation Matrix UI and integration layer, providing a robust foundation for multi-channel variation management. The Hub & Spoke architecture allows flexible, platform-specific variation strategies while maintaining clean separation of concerns between master catalog and channel-specific rules.
