# Phase 30: Reactive Attribute Inheritance

## Overview

Phase 30 implements a reactive system where parent product attributes automatically sync to child variations, with user override capability through attribute locking.

**Key Features:**
- ✅ Parent-to-child attribute synchronization
- ✅ User-controlled attribute locking (prevent inheritance)
- ✅ Delta check for selective updates (only non-locked attributes)
- ✅ Blue-tinted UI for inherited fields
- ✅ Lock/unlock toggles in variation grid
- ✅ API endpoints for attribute management

---

## Architecture

### 1. Database Schema (Prisma)

**New Field: `ProductVariation.lockedAttributes`**
```prisma
model ProductVariation {
  // ... existing fields ...
  
  // PHASE 30: Reactive Attribute Inheritance
  // Tracks which attributes are locked (not inherited from parent)
  // Structure: { "Color": true, "Material": false } means Color is locked, Material inherits
  lockedAttributes Json? @default("{}")
}
```

**Migration:** `20260427_add_locked_attributes_phase30`

---

### 2. Backend Service

**File:** `apps/api/src/services/attribute-inheritance.service.ts`

#### Core Functions

##### `onParentAttributeUpdate(parentProductId, updatedAttributes)`
Syncs parent attributes to all child variations, respecting locked attributes.

```typescript
// Example usage
const results = await onParentAttributeUpdate('parent-123', {
  Material: 'Polyester',
  Color: 'Red',
  Size: 'L'
});

// Results
[
  {
    childId: 'child-456',
    attributesUpdated: ['Material', 'Color'],
    attributesSkipped: ['Size'], // locked
    success: true
  }
]
```

**Delta Check Logic:**
1. Fetch parent product and all children
2. For each child:
   - Parse `lockedAttributes` (default: all unlocked)
   - For each parent attribute:
     - If locked: skip it
     - If unlocked: update it
   - Merge with existing child attributes
   - Save to database

##### `toggleAttributeLock(childVariationId, attributeName, locked)`
Lock/unlock an attribute to prevent/allow inheritance.

```typescript
// Lock Material attribute
const locked = await toggleAttributeLock('child-456', 'Material', true);
// Result: { Material: true, Color: false, ... }
```

##### `getLockedAttributes(childVariationId)`
Retrieve all locked attributes for a variation.

```typescript
const locked = await getLockedAttributes('child-456');
// Result: { Material: true, Size: true }
```

##### `bulkToggleAttributeLocks(childVariationIds, attributeName, locked)`
Bulk toggle locks for multiple children.

```typescript
const results = await bulkToggleAttributeLocks(
  ['child-1', 'child-2', 'child-3'],
  'Color',
  true
);
```

---

### 3. API Routes

**File:** `apps/api/src/routes/attribute-inheritance.routes.ts`

#### Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/attributes/sync-parent` | Sync parent attributes to children |
| POST | `/api/attributes/lock` | Toggle attribute lock |
| GET | `/api/attributes/locked/:childVariationId` | Get locked attributes |
| POST | `/api/attributes/bulk-lock` | Bulk toggle locks |

#### Request/Response Examples

**POST /api/attributes/sync-parent**
```json
{
  "parentProductId": "parent-123",
  "attributes": {
    "Material": "Polyester",
    "Color": "Red"
  }
}
```

Response:
```json
{
  "success": true,
  "message": "Parent attributes synced to children",
  "results": [
    {
      "childId": "child-456",
      "attributesUpdated": ["Material", "Color"],
      "attributesSkipped": [],
      "success": true
    }
  ]
}
```

**POST /api/attributes/lock**
```json
{
  "childVariationId": "child-456",
  "attributeName": "Material",
  "locked": true
}
```

Response:
```json
{
  "success": true,
  "message": "Attribute \"Material\" locked",
  "lockedAttributes": {
    "Material": true,
    "Color": false
  }
}
```

---

### 4. Frontend Components

#### AttributeLockToggle Component
**File:** `apps/web/src/components/catalog/AttributeLockToggle.tsx`

Reusable toggle button for locking/unlocking attributes.

```tsx
<AttributeLockToggle
  childVariationId="child-456"
  attributeName="Material"
  isLocked={true}
  onToggle={async (childId, attrName, locked) => {
    // Call API to toggle lock
  }}
  disabled={false}
/>
```

**Features:**
- Lock icon (🔒) when locked
- Unlock icon (🔓) when unlocked
- Amber background when locked
- Gray background when unlocked
- Error handling and loading states

#### Enhanced VariationMatrixTable
**File:** `apps/web/src/app/catalog/[id]/edit/tabs/VariationMatrixTable.tsx`

Updated to show inherited fields with visual distinction.

**New Props:**
- `parentAttributes`: Parent product attributes for comparison
- `onToggleLock`: Callback for lock toggle

**Visual Features:**
- 🔵 **Blue tint** for inherited fields (not locked)
- 🔒 **Lock toggles** (optional, toggle with "Show Locks" button)
- **Legend** explaining inherited fields
- **Right border accent** on inherited fields

**Example Usage:**
```tsx
<VariationMatrixTable
  children={variations}
  parentAttributes={parentProduct.categoryAttributes}
  onToggleLock={handleToggleLock}
  onUpdate={handleUpdate}
  onDelete={handleDelete}
/>
```

---

## User Workflow

### Scenario: Update Parent Attributes

1. **User edits parent product attributes**
   - Changes "Material" from "Cotton" to "Polyester"
   - Changes "Color" from "Blue" to "Red"

2. **System triggers sync**
   - Calls `onParentAttributeUpdate(parentId, { Material: 'Polyester', Color: 'Red' })`

3. **Delta check applies**
   - Child 1: Material unlocked → updates to "Polyester", Color unlocked → updates to "Red"
   - Child 2: Material locked → skips, Color unlocked → updates to "Red"
   - Child 3: Both locked → skips both

4. **UI shows results**
   - Inherited fields display with blue tint
   - Locked fields remain unchanged
   - User can toggle locks anytime

### Scenario: Lock an Attribute

1. **User clicks lock icon** on "Material" attribute in variation grid
2. **System calls** `toggleAttributeLock(childId, 'Material', true)`
3. **Database updates** `lockedAttributes` JSON
4. **UI updates** to show lock icon and amber background
5. **Future syncs** will skip this attribute

---

## Testing

**Test File:** `apps/api/src/services/__tests__/attribute-inheritance.test.ts`

### Test Cases

1. **Parent attribute sync to unlocked children**
   - Verify attributes are updated
   - Verify locked attributes are skipped

2. **Lock/unlock attributes**
   - Verify lock status is persisted
   - Verify locked attributes are not updated

3. **Delta check logic**
   - Verify only non-locked attributes are updated
   - Verify existing attributes are preserved

4. **Bulk operations**
   - Verify multiple children can be locked/unlocked

### Running Tests

```bash
cd apps/api
npm test -- attribute-inheritance.test.ts
```

---

## Implementation Checklist

- [x] Update Prisma schema with `lockedAttributes` field
- [x] Create migration for new field
- [x] Implement `attribute-inheritance.service.ts`
- [x] Create API routes
- [x] Build `AttributeLockToggle` component
- [x] Enhance `VariationMatrixTable` with visual indicators
- [x] Add test suite
- [ ] Integration testing (end-to-end)
- [ ] Performance testing with large variation sets
- [ ] Documentation (this file)

---

## Performance Considerations

### Database Queries
- **Parent fetch:** Single query with children relation
- **Child updates:** Batch update for multiple children
- **Lock toggle:** Single update per attribute

### Optimization Tips
1. **Batch syncs:** Use `bulkToggleAttributeLocks` for multiple children
2. **Lazy loading:** Load locked attributes only when needed
3. **Caching:** Cache parent attributes during edit session

---

## Future Enhancements

1. **Attribute inheritance rules**
   - Define which attributes inherit by default
   - Category-specific inheritance policies

2. **Inheritance history**
   - Track when attributes were inherited
   - Audit trail for compliance

3. **Conditional inheritance**
   - Inherit only if child value is empty
   - Inherit only if parent value changed

4. **Bulk inheritance management**
   - Lock/unlock multiple attributes across all children
   - Inheritance templates

---

## Troubleshooting

### Attributes not syncing
- Check if attribute is locked: `GET /api/attributes/locked/:childId`
- Verify parent attributes exist
- Check database for `lockedAttributes` JSON

### Lock toggle not working
- Verify API endpoint is registered
- Check browser console for errors
- Verify `onToggleLock` callback is provided

### Performance issues
- Check number of variations (>1000 may need optimization)
- Monitor database query times
- Consider pagination for large variation sets

---

## Related Documentation

- [PHASE29-VERIFICATION-CHECKLIST.md](./PHASE29-VERIFICATION-CHECKLIST.md) - Previous phase
- [PHASE-COMPLETION-SUMMARY.md](./PROJECT-COMPLETION-SUMMARY.md) - Overall project status
