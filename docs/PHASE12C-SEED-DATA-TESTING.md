# Phase 12c: Seed Data for Variation Matrix Testing

## Overview

Successfully created and executed a seed script (`scripts/seed-xracing-variations.ts`) to populate the xracing product with mock variation data for visual testing of the Phase 12b Variation Matrix implementation.

## What Was Created

### 1. Seed Script: `scripts/seed-xracing-variations.ts`

A comprehensive TypeScript seed script that:
- Finds or creates the xracing master product
- Creates 3 color variation children (Red, Blue, Black)
- Links children to parent via `masterProductId`
- Creates an Amazon ChannelListing with `variationTheme = "Color"`
- Populates `variationMapping` JSON with color attribute mappings
- Creates FBA and FBM offers for fulfillment flexibility
- Provides detailed console output for verification

**Key Features:**
- Idempotent: Safe to run multiple times (checks for existing records)
- Comprehensive logging with emoji indicators for clarity
- Proper error handling and Prisma disconnection
- Uses `(prisma as any)` pattern for accessing ChannelListing and Offer models

### 2. Database Population Results

**Master Product:**
- SKU: `xracing`
- Name: XRacing Pro Helmet
- ID: `cmoakom7o006vnjmpq9njn46w`
- Status: ACTIVE
- isParent: true
- Base Price: $199.99
- Total Stock: 150 units

**Child Products (Color Variations):**

| SKU | Color | ID | Stock |
|-----|-------|----|----|
| xracing-red | Red | cmodnp18m0001njoa658e9qns | 45 |
| xracing-blue | Blue | cmodnp18s0003njoalipmf9gf | 52 |
| xracing-black | Black | cmodnp18v0005njoa720g8r7h | 53 |

**Amazon ChannelListing:**
- Channel Market: AMAZON_US
- ID: cmodnp18y0007njoa4forfgy0
- Variation Theme: Color
- Listing Status: ACTIVE
- Price: $199.99
- Quantity: 150

**Variation Mapping:**
```json
{
  "Color": {
    "masterAttribute": "color",
    "platformAttribute": "Color",
    "values": {
      "Red": "Red",
      "Blue": "Blue",
      "Black": "Black"
    }
  }
}
```

**Offers:**
- FBA Offer (ID: cmodnp1920009njoaroqhya4x)
  - SKU: xracing-fba
  - Fulfillment Code: PHX3
  - Price: $199.99
  - Quantity: 150

- FBM Offer (ID: cmodnp196000bnjoamsvnayhe)
  - SKU: xracing-fbm
  - Shipping Template: Standard Shipping
  - Handling Time: 1 day
  - Price: $199.99
  - Quantity: 150

## Hub & Spoke Architecture in Action

The seed data demonstrates the Phase 12b Hub & Spoke architecture:

### Physical Hub (Master Catalog)
- **Parent Product**: xracing (master/non-buyable)
- **Child Products**: xracing-red, xracing-blue, xracing-black (buyable variants)
- **Relationship**: Children linked via `masterProductId` to parent
- **Variation Attributes**: Each child has `categoryAttributes.color` set

### Platform-Specific Spokes
- **Amazon US Listing**: Defines `variationTheme = "Color"`
- **Variation Mapping**: Maps master `color` attribute to Amazon's `Color` attribute
- **Fulfillment Options**: FBA and FBM offers for flexible fulfillment

## Visual Testing URL

Access the xracing product editor to see the Variation Matrix UI populated with real data:

```
http://localhost:3000/catalog/cmoakom7o006vnjmpq9njn46w/edit
```

### What You'll See

**Master Catalog Tab:**
- Parent toggle (enabled)
- Linked children table showing:
  - xracing-red (Color: Red)
  - xracing-blue (Color: Blue)
  - xracing-black (Color: Black)
- Search functionality to add more children
- Remove buttons for each child

**Platform Tab (Amazon):**
- Variation Theme dropdown (set to "Color")
- Attribute mapping section showing:
  - Master attribute: "color"
  - Platform attribute: "Color"
  - Value mappings: Red → Red, Blue → Blue, Black → Black
- Linked children preview table
- FBA and FBM offer cards with pricing and fulfillment details

## Execution Details

**Command:**
```bash
npx tsx scripts/seed-xracing-variations.ts
```

**Execution Time:** < 1 second
**Exit Code:** 0 (Success)

**Output:**
```
🌱 Starting xracing variation seed...

📦 Step 1: Finding/creating xracing master product...
   ✅ Found existing xracing product (ID: cmoakom7o006vnjmpq9njn46w)
   ✅ Already marked as parent

🎨 Step 2: Creating color variation children...
   ✅ Created xracing-red (ID: cmodnp18m0001njoa658e9qns)
   ✅ Created xracing-blue (ID: cmodnp18s0003njoalipmf9gf)
   ✅ Created xracing-black (ID: cmodnp18v0005njoa720g8r7h)

🛒 Step 3: Creating Amazon ChannelListing with variation theme...
   ✅ Created Amazon listing (ID: cmodnp18y0007njoa4forfgy0)

📦 Step 4: Creating Offers (FBA & FBM)...
   ✅ Created FBA offer (ID: cmodnp1920009njoaroqhya4x)
   ✅ Created FBM offer (ID: cmodnp196000bnjoamsvnayhe)

✨ Seed completed successfully!
```

## Technical Implementation

### Prisma Model Usage

The script demonstrates proper usage of Phase 12b models:

**Product Model:**
- `isParent`: Boolean flag for parent products
- `masterProductId`: Self-relation for parent/child linking
- `categoryAttributes`: JSON storage for variant attributes (color)

**ChannelListing Model:**
- `variationTheme`: Platform-specific variation strategy (e.g., "Color")
- `variationMapping`: JSON mapping of master attributes to platform attributes
- `channel` & `region`: Composite key for platform-specific listings

**Offer Model:**
- `fulfillmentMethod`: FBA or FBM
- `sku`: Fulfillment-specific SKU
- `offerMetadata`: JSON for fulfillment-specific configuration

### Database Relationships

```
Product (xracing - parent)
├── masterVariations (children)
│   ├── xracing-red
│   ├── xracing-blue
│   └── xracing-black
└── channelListings
    └── AMAZON_US
        ├── variationTheme: "Color"
        ├── variationMapping: {...}
        └── offers
            ├── FBA
            └── FBM
```

## Next Steps

### For Visual Testing:
1. Navigate to http://localhost:3000/catalog/cmoakom7o006vnjmpq9njn46w/edit
2. Click the "Master Catalog" tab to see parent/child relationships
3. Click the "Amazon" tab to see variation theme and attribute mapping
4. Verify the UI correctly displays:
   - Parent toggle (enabled)
   - Linked children with color attributes
   - Variation theme dropdown (Color)
   - Attribute mapping inputs
   - FBA/FBM offer cards

### For Phase 12c (Variation Sync Engine):
- Implement sync logic to push variation data to Amazon
- Handle variation theme validation per platform
- Map master attributes to platform-specific formats
- Create child ASIN relationships on Amazon
- Sync variation-specific pricing and inventory

## Files Modified/Created

- **Created:** `scripts/seed-xracing-variations.ts` - Seed script for variation data
- **Created:** `docs/PHASE12C-SEED-DATA-TESTING.md` - This documentation

## Verification Checklist

- [x] Seed script created and executable
- [x] Master product found/created with isParent = true
- [x] 3 child products created with color attributes
- [x] Children linked to parent via masterProductId
- [x] Amazon ChannelListing created with variationTheme
- [x] Variation mapping JSON populated correctly
- [x] FBA and FBM offers created
- [x] Script executed successfully with exit code 0
- [x] All database records created with correct IDs
- [x] Product accessible at edit URL
- [x] UI ready for visual testing

## Summary

The Phase 12b Variation Matrix implementation is now populated with real test data. The xracing product demonstrates the complete Hub & Spoke architecture with:
- Physical parent/child relationships in the Master Catalog
- Platform-specific variation configuration in Amazon ChannelListing
- Flexible fulfillment options via FBA and FBM offers

The UI is ready for visual testing to verify that the Parent/Child Matrix, Variation Theme dropdown, and Attribute Mapping sections display and function correctly with real data.
