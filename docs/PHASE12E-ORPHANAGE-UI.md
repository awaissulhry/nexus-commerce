# Phase 12e: The Orphanage - UI Upgrade for Orphaned SKUs

## Overview

The Orphanage is a UX upgrade that makes it easy to find and adopt orphaned Amazon SKUs (standalone child SKUs fetched by the Vacuum that lack a parent) into existing or new parent families. Since the Phase 12b architecture already supports linking standalone products as children, this upgrade simply makes finding these orphans easier.

## What Are Orphaned SKUs?

Orphaned SKUs are products that meet ALL of these criteria:
- `isParent === false` (not a parent product)
- `masterProductId === null` (not linked to a parent)
- Has at least one Amazon ChannelListing (fetched from Amazon)

These are typically child SKUs that were imported from Amazon but haven't been organized into parent/child families yet.

## Features Implemented

### 1. Catalog Dashboard Orphan Filter ([`apps/web/src/app/catalog/CatalogClient.tsx`](apps/web/src/app/catalog/CatalogClient.tsx))

**Location:** Main Catalog page (`/catalog`)

**Features:**
- **Orphan Filter Button** - Quick toggle to show only orphaned products
  - Shows count of orphaned products: "🏚️ Show Orphans (N)"
  - When active: "🏚️ Orphans Only (N)"
  - Yellow highlight when active for visibility

- **Visual Badges** - Orphaned products are marked with:
  - Yellow background row highlighting
  - Yellow "🏚️ Orphaned" badge in the Status column
  - Easy to spot at a glance

- **Smart Filtering** - Automatically filters based on:
  - `isParent === false`
  - `masterProductId === null`
  - Has Amazon ChannelListing

**UI Layout:**
```
┌─────────────────────────────────────────────────────────┐
│ Filter: [🏚️ Show Orphans (5)]  Showing 5 of 247 products │
├─────────────────────────────────────────────────────────┤
│ Product | SKU | Price | Stock | Status | Actions        │
├─────────────────────────────────────────────────────────┤
│ [Yellow Row] Product Name | SKU | $99 | 10 | 🏚️ Orphaned │
│ [Yellow Row] Product Name | SKU | $99 | 10 | 🏚️ Orphaned │
│ [Yellow Row] Product Name | SKU | $99 | 10 | 🏚️ Orphaned │
└─────────────────────────────────────────────────────────┘
```

### 2. Master Catalog Tab Orphan Search Filter ([`apps/web/src/app/catalog/[id]/edit/tabs/MasterCatalogTab.tsx`](apps/web/src/app/catalog/[id]/edit/tabs/MasterCatalogTab.tsx))

**Location:** Product edit page, Master Catalog tab, "Link Child Products" section

**Features:**
- **Orphan Toggle** - Quick filter in the child search section
  - Shows: "🏚️ Show Orphans" (inactive) or "🏚️ Orphans Only" (active)
  - Yellow highlight when active
  - Positioned next to "Link Child Products" heading

- **Smart Search** - When orphan filter is enabled:
  - Only shows products that are orphaned
  - Filters out normal standalone products
  - Filters out products already linked to parents
  - Filters out products already linked as children

- **Workflow:**
  1. User opens parent product edit page
  2. Clicks "🏚️ Show Orphans" toggle
  3. Searches for orphaned SKUs
  4. Results show only orphaned products
  5. Clicks "+ Add" to link as child
  6. Parent/child relationship established

**UI Layout:**
```
┌──────────────────────────────────────────────────────┐
│ Link Child Products          [🏚️ Show Orphans]       │
├──────────────────────────────────────────────────────┤
│ Search Products                                      │
│ [Search input field...]                             │
├──────────────────────────────────────────────────────┤
│ Search Results:                                      │
│ ┌────────────────────────────────────────────────┐  │
│ │ SKU-001 | Product Name | [+ Add]              │  │
│ │ SKU-002 | Product Name | [+ Add]              │  │
│ │ SKU-003 | Product Name | [+ Add]              │  │
│ └────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────┘
```

## Implementation Details

### CatalogClient Component

**State:**
```typescript
const [showOrphansOnly, setShowOrphansOnly] = useState(false)
```

**Filtering Logic:**
```typescript
const orphanedProducts = useMemo(() => {
  return products.filter(
    (p) =>
      !p.isParent &&
      !p.masterProductId &&
      p.channelListings.some((cl) => cl.channel === 'AMAZON')
  )
}, [products])

const displayedProducts = showOrphansOnly ? orphanedProducts : products
```

**Features:**
- Memoized orphan calculation for performance
- Shows count of orphaned products
- Displays "Showing X of Y products" summary
- Yellow background for orphaned rows
- Yellow badge in status column

### MasterCatalogTab Component

**State:**
```typescript
const [showOrphansOnly, setShowOrphansOnly] = useState(false)
```

**Search Logic:**
```typescript
const handleSearchChildren = useCallback(async (query: string) => {
  // ... existing search code ...
  
  // Filter orphans if toggle is enabled
  if (showOrphansOnly) {
    filtered = filtered.filter((p: any) => 
      !p.isParent && 
      !p.masterProductId && 
      p.channelListings?.some((cl: any) => cl.channel === 'AMAZON')
    )
  }
  
  setSearchResults(filtered)
}, [product.id, childProducts, showOrphansOnly])
```

**Features:**
- Toggle button in header of "Link Child Products" section
- Filters search results in real-time
- Maintains existing search functionality
- Yellow highlight when active

## Use Cases

### Use Case 1: Cleaning Up Imported Amazon Catalog

**Scenario:** User imported 500 SKUs from Amazon EU using the Vacuum. Many are child SKUs without parents.

**Workflow:**
1. Go to `/catalog`
2. Click "🏚️ Show Orphans" filter
3. See all 47 orphaned SKUs highlighted in yellow
4. Click "Edit" on a parent product
5. Go to Master Catalog tab
6. Click "🏚️ Show Orphans" toggle
7. Search for related child SKUs
8. Click "+ Add" to link them
9. Save parent/child relationships
10. Repeat for other parents

### Use Case 2: Organizing New Variations

**Scenario:** User has a parent product "Jacket" and wants to link color variations.

**Workflow:**
1. Open "Jacket" product edit page
2. Go to Master Catalog tab
3. Toggle "🏚️ Show Orphans"
4. Search "jacket-red"
5. See only orphaned jacket variants
6. Add jacket-red, jacket-blue, jacket-black
7. Save parent/child relationships

### Use Case 3: Finding Unorganized SKUs

**Scenario:** User wants to see all unorganized Amazon SKUs at a glance.

**Workflow:**
1. Go to `/catalog`
2. Click "🏚️ Show Orphans"
3. See all 23 orphaned products
4. Identify which ones need parents
5. Create parent products or link to existing ones

## Visual Design

### Color Scheme
- **Orphan Badge:** Yellow background (#FEF3C7) with yellow text (#92400E)
- **Toggle Active:** Yellow background with yellow border
- **Row Highlight:** Light yellow background (#FFFBEB)
- **Icon:** 🏚️ (House emoji) for visual recognition

### Typography
- **Toggle Text:** "🏚️ Show Orphans" or "🏚️ Orphans Only"
- **Badge Text:** "🏚️ Orphaned"
- **Count Display:** "(N)" showing number of orphaned products

## Database Query

The orphan filter uses these criteria:

```sql
WHERE 
  isParent = false 
  AND masterProductId IS NULL 
  AND EXISTS (
    SELECT 1 FROM ChannelListing 
    WHERE channel = 'AMAZON' 
    AND productId = Product.id
  )
```

## Performance Considerations

- **Memoization:** Orphan list is memoized to prevent recalculation on every render
- **Client-side Filtering:** Filtering happens on the client for instant feedback
- **No Additional Queries:** Uses existing product data with channelListings relation

## Files Created/Modified

**Created:**
- `apps/web/src/app/catalog/CatalogClient.tsx` - Catalog table with orphan filter

**Modified:**
- `apps/web/src/app/catalog/page.tsx` - Updated to use CatalogClient component
- `apps/web/src/app/catalog/[id]/edit/tabs/MasterCatalogTab.tsx` - Added orphan filter to child search

## Testing Checklist

- [x] Orphan filter button appears on catalog page
- [x] Clicking filter shows only orphaned products
- [x] Orphaned products have yellow background
- [x] Orphaned products have yellow badge
- [x] Count displays correctly
- [x] Orphan toggle appears in Master Catalog tab
- [x] Toggling filters search results
- [x] Search still works with orphan filter enabled
- [x] Adding orphaned child links correctly
- [x] UI is responsive on mobile

## Future Enhancements

1. **Bulk Actions** - Select multiple orphans and assign to parent in bulk
2. **Auto-Grouping** - Suggest parent products based on SKU patterns
3. **Orphan Dashboard** - Dedicated page showing orphan statistics
4. **Smart Linking** - AI-powered suggestions for parent/child relationships
5. **Orphan Reports** - Export list of orphaned SKUs for analysis

## Summary

The Orphanage UI upgrade makes it trivial to find and organize orphaned Amazon SKUs. With just one click, users can:
- See all orphaned products at a glance
- Filter search results to show only orphans
- Quickly link them to parent products
- Clean up messy Amazon catalogs

The yellow highlighting and emoji icon make orphaned products instantly recognizable, and the toggle buttons provide quick access to orphan-specific workflows.
