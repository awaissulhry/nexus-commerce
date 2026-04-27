# Phase 29: Matrix Variation Generator - Implementation Guide

## Overview
Built a visual matrix builder that allows users to define Option Types (Color, Size, etc.) and their values, then generate all possible SKU combinations in bulk with a single click.

## Components Created

### 1. SKU Generator Helper (`apps/web/src/lib/sku-generator.ts`)
Utility functions for generating variation matrices and SKUs:

- **`slugify(text: string)`** - Converts text to URL-safe slugs
  - Removes special characters
  - Replaces spaces with hyphens
  - Handles multiple hyphens

- **`generateVariationMatrix(parentSku, optionTypes)`** - Generates all combinations
  - Creates cartesian product of all option values
  - Returns array of `GeneratedVariation` objects with SKU and name
  - Example: `JACKET` + `[Color: Red/Blue]` + `[Size: S/M/L]` = 6 variations

- **`calculateVariationCount(optionTypes)`** - Calculates total variations
  - Multiplies all option value counts
  - Used for preview and validation

### 2. VariationGenerator Component (`apps/web/src/components/catalog/VariationGenerator.tsx`)
Interactive UI for building variation matrices:

**Features:**
- Add/remove option types (Color, Size, Material, etc.)
- Add/remove values for each option
- Live preview of generated SKUs
- Global price and stock settings
- Variation count summary
- Collapsible preview showing all generated SKUs

**Props:**
```typescript
interface VariationGeneratorProps {
  parentSku: string              // Parent product SKU
  onGenerate: (variations, price, stock) => Promise<void>
  isLoading?: boolean
}
```

**State Management:**
- `optionTypes[]` - Array of option type definitions
- `globalPrice` - Price applied to all variants
- `globalStock` - Stock quantity applied to all variants
- `showPreview` - Toggle preview visibility
- `error` - Error message display

### 3. API Endpoint (`POST /api/catalog/products/:parentId/bulk-variants`)
Bulk creates variants in a single transaction:

**Request Body:**
```typescript
{
  variations: Array<{
    sku: string;
    name: string;
    optionValues: Record<string, string>;
  }>;
  globalPrice: number;
  globalStock: number;
}
```

**Response:**
```typescript
{
  success: true;
  data: {
    parentId: string;
    createdCount: number;
    variations: Product[];
  };
  message: string;
}
```

**Validations:**
- Parent product exists
- At least one variation provided
- Global price > 0
- Global stock >= 0
- No duplicate SKUs in request
- No existing SKUs in database
- All variations created in atomic transaction

**Side Effects:**
- Marks parent as `isParent: true` if not already
- Inherits parent's `productType` and `categoryAttributes`
- Sets `syncChannels` from parent
- Creates with `status: ACTIVE` and `validationStatus: VALID`

### 4. MasterCatalogTab Integration
Added new section "Bulk Variation Generator" with:
- Collapsible accordion UI
- Error handling and display
- Integration with existing variation management
- Automatic list refresh after generation

## Usage Flow

### Step 1: Define Option Types
1. Click "Bulk Variation Generator" button
2. Click "Add Option" to create first option type
3. Enter option name (e.g., "Color")
4. Click "+ Add Value" to add values (Red, Blue, Green)

### Step 2: Configure Global Settings
1. Set global price (applied to all variants)
2. Set global stock quantity (applied to all variants)

### Step 3: Preview & Generate
1. View preview showing all generated SKUs
2. Review variation count and settings
3. Click "Generate X Variations" button
4. Wait for API response
5. New variants appear in "Active Variations" table

## Example: T-Shirt with Color and Size

**Input:**
- Parent SKU: `TSHIRT`
- Option 1: Color (Red, Blue, Black)
- Option 2: Size (S, M, L, XL)
- Price: $19.99
- Stock: 50

**Generated SKUs:**
```
TSHIRT-RED-S
TSHIRT-RED-M
TSHIRT-RED-L
TSHIRT-RED-XL
TSHIRT-BLUE-S
TSHIRT-BLUE-M
TSHIRT-BLUE-L
TSHIRT-BLUE-XL
TSHIRT-BLACK-S
TSHIRT-BLACK-M
TSHIRT-BLACK-L
TSHIRT-BLACK-XL
```

**Total:** 12 variations (3 colors × 4 sizes)

## Technical Details

### SKU Generation Algorithm
Uses cartesian product to generate all combinations:
```
For each option type:
  For each value in option:
    Combine with all combinations of other options
```

### Database Transaction
All variations created atomically:
- If any variation fails, entire operation rolls back
- Parent marked as parent in same transaction
- Ensures data consistency

### Validation Strategy
1. **Client-side:** Immediate feedback on form validity
2. **Server-side:** Comprehensive validation before creation
3. **Database-level:** Unique constraint on SKU field

## Error Handling

**Client Errors:**
- Empty option types
- Missing option names or values
- Invalid price/stock values
- Duplicate SKUs in request

**Server Errors:**
- Parent not found (404)
- SKU already exists (409)
- Database transaction failure (500)

**User Feedback:**
- Error messages displayed in red banner
- Loading state during generation
- Success message with count

## Performance Considerations

### Variation Count Limits
- Recommended max: 100 variations per generation
- Example: 5 colors × 5 sizes × 4 materials = 100 variations
- Larger matrices may impact performance

### Database Impact
- Single transaction for all variations
- Bulk insert optimized by Prisma
- No N+1 queries

### UI Responsiveness
- Preview limited to scrollable container (max-h-96)
- Lazy rendering of preview items
- Debounced preview updates

## Testing Checklist

- [ ] Create option types with multiple values
- [ ] Generate SKUs and verify format
- [ ] Preview shows all combinations
- [ ] Global price/stock applied correctly
- [ ] Bulk creation succeeds
- [ ] Variants appear in Active Variations table
- [ ] Parent marked as parent
- [ ] Duplicate SKU detection works
- [ ] Error messages display correctly
- [ ] Can edit generated variants
- [ ] Can delete generated variants

## Future Enhancements

1. **Variant-Specific Pricing**
   - Allow different prices per variant
   - Price multipliers based on option values

2. **Bulk Import**
   - CSV upload for option types and values
   - Template download

3. **Variant Templates**
   - Save common option configurations
   - Reuse across products

4. **Advanced SKU Patterns**
   - Custom SKU format templates
   - Prefix/suffix configuration

5. **Batch Operations**
   - Edit multiple variants at once
   - Bulk price/stock updates

## Files Modified

- `apps/web/src/lib/sku-generator.ts` - NEW
- `apps/web/src/components/catalog/VariationGenerator.tsx` - NEW
- `apps/api/src/routes/catalog.routes.ts` - Added bulk-variants endpoint
- `apps/web/src/app/catalog/[id]/edit/tabs/MasterCatalogTab.tsx` - Integrated generator

## API Endpoint Summary

```
POST /api/catalog/products/:parentId/bulk-variants
├── Validates parent exists
├── Validates variations array
├── Checks for duplicate SKUs
├── Creates all variations in transaction
└── Returns created variations
```

## Related Documentation

- [PHASE12B-VARIATION-MATRIX-IMPLEMENTATION.md](./PHASE12B-VARIATION-MATRIX-IMPLEMENTATION.md)
- [PHASE15-PUBLISHING-MATRIX.md](./PHASE15-PUBLISHING-MATRIX.md)
- [PHASE16-DYNAMIC-WIZARD-IMPLEMENTATION.md](./PHASE16-DYNAMIC-WIZARD-IMPLEMENTATION.md)
