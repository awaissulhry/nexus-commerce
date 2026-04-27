# Phase 19.14: Edit Form Intelligence & Matrix - Implementation Plan

## Overview
Implement two critical features for the product editor:
1. **Fix isParent State Initialization**: Remember if a product is a parent and lock the toggle if it has children
2. **Build Variation Matrix**: Create an inline-editable data grid for child products with SKU, Price, and Stock columns

## Current State Analysis

### What Exists
- **ProductEditorForm.tsx**: Main form component with tab navigation
- **MasterCatalogTab.tsx**: Displays parent/child relationships but lacks inline editing
- **VitalInfoTab.tsx**: Shows product vital info but no parent toggle lock
- **Database Schema**: Product model has `isParent` boolean and `children` relation
- **API**: PATCH endpoint exists for product updates but not for child-specific updates

### What's Missing
1. **isParent initialization**: Edit page doesn't fetch `isParent` flag
2. **Parent toggle lock**: No mechanism to disable toggle when product has children
3. **Variation matrix**: No inline-editable table for child products
4. **Child update endpoint**: No dedicated PATCH endpoint for updating child products
5. **Inline editing**: No edit handlers for SKU, Price, Stock in matrix

## Implementation Strategy

### Phase 1: Fix isParent State Initialization

#### 1.1 Update Edit Page (page.tsx)
**File**: `apps/web/src/app/catalog/[id]/edit/page.tsx`

**Changes**:
- Fetch `isParent` and `children` count from database
- Pass `isParent` to ProductEditorForm as part of defaultValues
- Include children count for UI indicators

**Data to fetch**:
```typescript
{
  id,
  isParent,
  children: { select: { id: true } }
}
```

#### 1.2 Update ProductEditorForm
**File**: `apps/web/src/app/catalog/[id]/edit/ProductEditorForm.tsx`

**Changes**:
- Add `isParent` to form schema (if not already present)
- Pass `isParent` state to VitalInfoTab via context or props
- Track whether product has children to lock toggle

#### 1.3 Update VitalInfoTab
**File**: `apps/web/src/app/catalog/[id]/edit/tabs/VitalInfoTab.tsx`

**Changes**:
- Add parent toggle section (similar to MasterCatalogTab)
- Disable toggle if product has children
- Show lock icon when disabled
- Display status message

### Phase 2: Build Variation Matrix with Inline Editing

#### 2.1 Create VariationMatrixTable Component
**File**: `apps/web/src/app/catalog/[id]/edit/tabs/VariationMatrixTable.tsx`

**Features**:
- Display child products in structured table
- Columns: SKU, Name, Base Price, Total Stock, Actions
- Inline editing for SKU, Price, Stock
- Edit mode toggle per row
- Save/Cancel buttons for each row
- Delete child product button

**Structure**:
```typescript
interface VariationMatrixTableProps {
  children: Product[]
  onUpdate: (childId: string, updates: ChildUpdatePayload) => Promise<void>
  onRemove: (childId: string) => Promise<void>
  isLoading?: boolean
}
```

#### 2.2 Update MasterCatalogTab
**File**: `apps/web/src/app/catalog/[id]/edit/tabs/MasterCatalogTab.tsx`

**Changes**:
- Replace read-only child table with VariationMatrixTable
- Wire inline edit handlers to API calls
- Add loading states during updates
- Show success/error messages

#### 2.3 Implement Inline Edit Handlers
**Features**:
- Click to edit mode for each cell
- Input validation (SKU format, price > 0, stock >= 0)
- Optimistic UI updates
- Rollback on error
- Debounced API calls (optional)

### Phase 3: API Endpoint for Child Updates

#### 3.1 Create PATCH Endpoint for Child Products
**File**: `apps/api/src/routes/catalog.routes.ts`

**Endpoint**: `PATCH /api/products/:parentId/children/:childId`

**Request Body**:
```typescript
{
  sku?: string
  basePrice?: number
  totalStock?: number
  name?: string
}
```

**Response**:
```typescript
{
  success: boolean
  data: UpdatedChildProduct
  syncs?: SyncQueueResult[]
}
```

**Logic**:
- Validate child belongs to parent
- Validate SKU uniqueness (excluding current child)
- Update child product
- Queue syncs to marketplaces if price/stock changed
- Return updated child data

#### 3.2 Add Validation
- SKU must be unique across all products
- Price must be > 0
- Stock must be >= 0
- Child must belong to specified parent

### Phase 4: Wire Changes to API

#### 4.1 Update Handlers in MasterCatalogTab
**Changes**:
- Create `handleChildUpdate` function
- Create `handleChildDelete` function
- Add error handling and retry logic
- Show loading states during API calls

#### 4.2 Optimistic Updates
**Strategy**:
- Update UI immediately
- Make API call in background
- Rollback on error
- Show error toast

### Phase 5: Testing & Validation

#### 5.1 Test Scenarios
1. Load parent product with children
   - Verify isParent is true
   - Verify toggle is disabled
   - Verify children display in matrix

2. Edit child SKU
   - Verify inline edit works
   - Verify API call succeeds
   - Verify SKU uniqueness validation

3. Edit child price
   - Verify inline edit works
   - Verify price validation (> 0)
   - Verify sync is queued

4. Edit child stock
   - Verify inline edit works
   - Verify stock validation (>= 0)
   - Verify sync is queued

5. Delete child
   - Verify child is removed from matrix
   - Verify parent isParent flag updates if no children left
   - Verify toggle becomes enabled

6. Form state persistence
   - Switch tabs and return
   - Verify form state is preserved
   - Verify unsaved changes indicator works

## File Structure

```
apps/web/src/app/catalog/[id]/edit/
├── page.tsx (MODIFY - fetch isParent)
├── ProductEditorForm.tsx (MODIFY - pass isParent state)
├── tabs/
│   ├── VitalInfoTab.tsx (MODIFY - add parent toggle with lock)
│   ├── MasterCatalogTab.tsx (MODIFY - use VariationMatrixTable)
│   └── VariationMatrixTable.tsx (CREATE - inline editable matrix)

apps/api/src/routes/
└── catalog.routes.ts (MODIFY - add PATCH /products/:parentId/children/:childId)
```

## Key Implementation Details

### isParent Lock Mechanism
```typescript
const isLocked = product.isParent && product.children.length > 0

<button
  disabled={isLocked}
  title={isLocked ? "Cannot change parent status - product has children" : ""}
  className={isLocked ? "opacity-50 cursor-not-allowed" : ""}
>
  {isLocked ? "🔒 Parent (Locked)" : "Parent"}
</button>
```

### Inline Edit Pattern
```typescript
const [editingId, setEditingId] = useState<string | null>(null)
const [editValues, setEditValues] = useState<Record<string, any>>({})

// Click to edit
const handleStartEdit = (childId: string, field: string) => {
  setEditingId(childId)
  setEditValues({ [field]: currentValue })
}

// Save edit
const handleSaveEdit = async (childId: string) => {
  await onUpdate(childId, editValues)
  setEditingId(null)
}
```

### API Call Pattern
```typescript
const handleChildUpdate = async (childId: string, updates: any) => {
  try {
    setLoading(true)
    const response = await fetch(
      `/api/products/${productId}/children/${childId}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      }
    )
    if (!response.ok) throw new Error('Update failed')
    const data = await response.json()
    // Update local state
    setChildren(prev => prev.map(c => c.id === childId ? data.data : c))
  } catch (error) {
    // Show error toast
    // Rollback UI
  } finally {
    setLoading(false)
  }
}
```

## Success Criteria

✅ isParent state is fetched and initialized correctly
✅ Parent toggle is disabled when product has children
✅ Lock icon/message displays when toggle is disabled
✅ Variation matrix displays all child products
✅ Inline editing works for SKU, Price, Stock
✅ Validation prevents invalid data entry
✅ API calls succeed and update database
✅ Syncs are queued for price/stock changes
✅ Form state persists across tab switches
✅ Error handling and rollback work correctly
✅ Loading states display during API calls
✅ Success messages confirm updates

## Dependencies
- React Hook Form (already in use)
- Zod (already in use)
- Prisma (already in use)
- Fastify (already in use)

## Estimated Complexity
- **High**: Multiple interconnected components
- **Medium**: API endpoint creation
- **Medium**: Inline editing state management
- **Low**: Validation (reuse existing patterns)
