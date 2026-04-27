# Phase 9: The Multi-Channel Matrix Architecture
## Enterprise-Grade PIM with Platform-Specific Listings & Offers

**Status:** Architecture Blueprint (Pre-Implementation)  
**Phase:** 9 of 9  
**Objective:** Redesign the Edit Product experience to support independent platform tabs with regional markets and multiple fulfillment offers per listing.

---

## Executive Summary

Phase 9 transforms Nexus into a true **Product Information Management (PIM) Matrix** by separating the Master Catalog (internal source of truth) from Channel-Specific Listings (platform-optimized data) and Offers (fulfillment-specific SKUs and pricing).

### Key Architectural Shifts

| Aspect | Phase 8 (Current) | Phase 9 (New) |
|--------|-------------------|---------------|
| **Data Model** | Product → Variations → ChannelListings | Product (Master) → ChannelListing → Offer |
| **Edit UI** | Single product form | Tabbed: Master + Platform tabs (Amazon US, Amazon DE, eBay, etc.) |
| **Images** | Product-level only | Master + Platform-specific images |
| **Pricing** | Variation-level | Master base + Platform-specific + Offer-specific |
| **Sync Trigger** | Product changes | Product, ChannelListing, or Offer changes |
| **Data Flow** | Unidirectional (Master → Channels) | Bidirectional with sync gates |

---

## 1. Database Refactor (schema.prisma)

### 1.1 New Models Overview

```
Product (Master Catalog)
├── ChannelListing (Amazon US, Amazon DE, eBay, etc.)
│   ├── Offer (FBA, FBM, etc.)
│   └── ChannelListingImage (platform-specific images)
├── ProductImage (master images)
└── ProductVariation (unchanged, still linked to Product)
```

### 1.2 Detailed Schema Changes

#### A. Enhance Product Model (Master Catalog)

```prisma
model Product {
  id         String  @id @default(cuid())
  sku        String  @unique  // Internal master SKU
  name       String
  basePrice  Decimal @db.Decimal(10, 2)
  totalStock Int     @default(0)

  // ── PHASE 9: Master Catalog Metadata ──────────────────────────────
  // Indicates this is a master product (not a variation)
  isMasterProduct Boolean @default(true)
  
  // Master product reference (for variations)
  masterProductId String?
  masterProduct   Product?  @relation("MasterVariations", fields: [masterProductId], references: [id], onDelete: Cascade)
  masterVariations Product[] @relation("MasterVariations")

  // ── Existing fields (unchanged) ──────────────────────────────────
  amazonAsin         String?
  ebayItemId         String?
  ebayTitle          String?
  shopifyProductId   String?
  woocommerceProductId Int?
  
  upc          String?
  ean          String?
  brand        String?
  manufacturer String?
  
  weightValue Decimal? @db.Decimal(10, 3)
  weightUnit  String?
  dimLength   Decimal? @db.Decimal(10, 2)
  dimWidth    Decimal? @db.Decimal(10, 2)
  dimHeight   Decimal? @db.Decimal(10, 2)
  dimUnit     String?
  
  bulletPoints String[]
  aPlusContent Json?
  keywords     String[]
  
  fulfillmentMethod FulfillmentMethod?
  variationTheme String?
  status String @default("ACTIVE")
  
  productType String?
  categoryAttributes Json?
  
  costPrice       Decimal? @db.Decimal(10, 2)
  minPrice        Decimal? @db.Decimal(10, 2)
  maxPrice        Decimal? @db.Decimal(10, 2)
  buyBoxPrice     Decimal? @db.Decimal(10, 2)
  competitorPrice Decimal? @db.Decimal(10, 2)
  
  firstInventoryDate DateTime?
  
  b2bPrice  Decimal? @db.Decimal(10, 2)
  b2bMinQty Int?
  
  isParent          Boolean   @default(false)
  parentId          String?
  parent            Product?  @relation("ProductHierarchy", fields: [parentId], references: [id], onDelete: Cascade)
  children          Product[] @relation("ProductHierarchy")
  
  parentAsin        String?
  fulfillmentChannel FulfillmentMethod?
  shippingTemplate  String?
  
  lastAmazonSync    DateTime?
  amazonSyncStatus  String?
  amazonSyncError   String?

  // ── PHASE 9: Relations to Channel Listings ──────────────────────
  channelListings     ChannelListing[]
  channelListingImages ChannelListingImage[]

  // ── Existing relations (unchanged) ──────────────────────────────
  variations          ProductVariation[]
  images              ProductImage[]
  listings            Listing[]
  draftListings       DraftListing[]
  stockLogs           StockLog[]
  marketplaceSyncs    MarketplaceSync[]
  fbaShipmentItems    FBAShipmentItem[]
  pricingRuleProducts PricingRuleProduct[]
  syncHealthLogs      SyncHealthLog[]
  syncLogs            SyncLog[]
  orderItems          OrderItem[]
  outboundSyncQueue   OutboundSyncQueue[]

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}
```

#### B. New ChannelListing Model (Platform-Specific Data)

```prisma
model ChannelListing {
  id                String  @id @default(cuid())
  
  // ── Master Product Reference ────────────────────────────────────
  product           Product @relation(fields: [productId], references: [id], onDelete: Cascade)
  productId         String
  
  // ── Channel & Market Identification ─────────────────────────────
  // Examples: "AMAZON_US", "AMAZON_DE", "EBAY_US", "EBAY_DE", "SHOPIFY", etc.
  channelMarket     String  // Composite key: CHANNEL_REGION
  channel           String  // "AMAZON", "EBAY", "SHOPIFY", "WOOCOMMERCE", "ETSY"
  region            String  // "US", "DE", "UK", "FR", "JP", etc.
  
  // ── Platform-Specific Identifiers ───────────────────────────────
  // Amazon: Parent ASIN (non-buyable) or child ASIN (buyable)
  // eBay: ItemID (12-digit number)
  // Shopify: Product ID
  externalListingId String?
  externalParentId  String?  // For Amazon parent ASIN
  
  // ── Platform-Specific Title & Description ──────────────────────
  // Can differ from master product name
  title             String?
  description       String?  // HTML or plain text
  
  // ── Platform-Specific Pricing ──────────────────────────────────
  // Overrides master basePrice if set
  price             Decimal? @db.Decimal(10, 2)
  salePrice         Decimal? @db.Decimal(10, 2)
  
  // ── Platform-Specific Inventory ────────────────────────────────
  // Overrides master totalStock if set
  quantity          Int?
  
  // ── Platform-Specific Attributes ───────────────────────────────
  // JSON structure varies by platform:
  // Amazon: { browseNodeId, bulletPoints, searchTerms, aplus_content }
  // eBay: { itemSpecifics, categoryId, conditionId, returnPolicy }
  // Shopify: { tags, vendor, collections }
  platformAttributes Json?
  
  // ── Listing Status & Sync Tracking ─────────────────────────────
  listingStatus     String  @default("DRAFT")  // DRAFT, ACTIVE, INACTIVE, ENDED, ERROR
  lastSyncedAt      DateTime?
  lastSyncStatus    String?  // SUCCESS, FAILED, PENDING
  lastSyncError     String?
  syncRetryCount    Int     @default(0)
  
  // ── Sync Control Flags ─────────────────────────────────────────
  // When true, next sync will pull from master product
  syncFromMaster    Boolean @default(false)
  // When true, this listing is locked from syncing
  syncLocked        Boolean @default(false)
  
  // ── Relations ───────────────────────────────────────────────────
  offers            Offer[]
  images            ChannelListingImage[]
  outboundSyncQueue OutboundSyncQueue[]
  
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt
  
  @@unique([productId, channelMarket])
  @@index([productId])
  @@index([channel])
  @@index([region])
  @@index([externalListingId])
  @@index([listingStatus])
}
```

#### C. New Offer Model (Fulfillment-Specific SKU & Pricing)

```prisma
model Offer {
  id                String  @id @default(cuid())
  
  // ── Channel Listing Reference ──────────────────────────────────
  channelListing    ChannelListing @relation(fields: [channelListingId], references: [id], onDelete: Cascade)
  channelListingId  String
  
  // ── Fulfillment Method ─────────────────────────────────────────
  // "FBA" (Fulfillment by Amazon), "FBM" (Fulfilled by Merchant), etc.
  fulfillmentMethod FulfillmentMethod
  
  // ── Offer-Specific SKU ─────────────────────────────────────────
  // Different SKU per fulfillment method (e.g., "PRODUCT-FBA" vs "PRODUCT-FBM")
  sku               String
  
  // ── Offer-Specific Pricing ─────────────────────────────────────
  // Overrides channel listing price if set
  price             Decimal? @db.Decimal(10, 2)
  
  // ── Offer-Specific Inventory ──────────────────────────────────
  // Overrides channel listing quantity if set
  quantity          Int?
  
  // ── Offer Status ───────────────────────────────────────────────
  isActive          Boolean @default(true)
  
  // ── Offer-Specific Metadata ────────────────────────────────────
  // FBA: { shipmentId, fcCode, prepRequired }
  // FBM: { shippingTemplate, handlingTime, shippingCost }
  offerMetadata     Json?
  
  // ── Sync Tracking ──────────────────────────────────────────────
  lastSyncedAt      DateTime?
  lastSyncStatus    String?
  lastSyncError     String?
  
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt
  
  @@unique([channelListingId, fulfillmentMethod])
  @@index([channelListingId])
  @@index([fulfillmentMethod])
  @@index([isActive])
}
```

#### D. New ChannelListingImage Model (Platform-Specific Images)

```prisma
model ChannelListingImage {
  id                String  @id @default(cuid())
  
  // ── Can link to either Master Product OR Channel Listing ────────
  // If productId is set: master image (inherited by all listings)
  // If channelListingId is set: platform-specific image override
  product           Product?  @relation(fields: [productId], references: [id], onDelete: Cascade)
  productId         String?
  
  channelListing    ChannelListing? @relation(fields: [channelListingId], references: [id], onDelete: Cascade)
  channelListingId  String?
  
  // ── Image Data ─────────────────────────────────────────────────
  url               String
  alt               String?
  type              String  // "MAIN", "ALT", "LIFESTYLE", "SWATCH"
  sortOrder         Int     @default(0)
  
  // ── Platform-Specific Metadata ────────────────────────────────
  // Amazon: { asin, imageType }
  // eBay: { pictureURL, galleryType }
  platformMetadata  Json?
  
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt
  
  @@index([productId])
  @@index([channelListingId])
  
  // Ensure at least one of productId or channelListingId is set
  // (Enforced at application level)
}
```

#### E. Update OutboundSyncQueue (Phase 8 → Phase 9)

```prisma
model OutboundSyncQueue {
  id                String              @id @default(cuid())
  
  // ── PHASE 9: Support both Product and ChannelListing changes ────
  // At least one must be set
  productId         String?
  product           Product?            @relation(fields: [productId], references: [id], onDelete: Cascade)
  
  channelListingId  String?
  channelListing    ChannelListing?     @relation(fields: [channelListingId], references: [id], onDelete: Cascade)
  
  offerId           String?
  // Note: Offer doesn't have direct relation; tracked via channelListingId
  
  // ── Target channel ─────────────────────────────────────────────
  targetChannel     SyncChannel         @default(AMAZON)
  targetRegion      String?             // e.g., "US", "DE" (for regional syncs)
  
  // ── Sync status ────────────────────────────────────────────────
  syncStatus        OutboundSyncStatus  @default(PENDING)
  
  // ── Payload (what to sync) ─────────────────────────────────────
  payload           Json                // { "price": 99.99, "quantity": 50, "title": "...", "offers": [...] }
  
  // ── Error tracking ─────────────────────────────────────────────
  errorMessage      String?
  errorCode         String?
  retryCount        Int                 @default(0)
  maxRetries        Int                 @default(3)
  
  // ── Timestamps ─────────────────────────────────────────────────
  createdAt         DateTime            @default(now())
  updatedAt         DateTime            @updatedAt
  syncedAt          DateTime?
  nextRetryAt       DateTime?
  
  // ── Metadata ───────────────────────────────────────────────────
  syncType          String              // "PRICE_UPDATE", "QUANTITY_UPDATE", "LISTING_SYNC", "OFFER_SYNC", "FULL_SYNC"
  externalListingId String?             // Amazon ASIN or eBay ItemID
  
  @@index([productId])
  @@index([channelListingId])
  @@index([syncStatus])
  @@index([targetChannel])
  @@index([nextRetryAt])
}
```

### 1.3 Migration Strategy

**Phase 9 Migration Path:**

1. **Create new models** (ChannelListing, Offer, ChannelListingImage)
2. **Backfill ChannelListings** from existing VariantChannelListing data
3. **Create default Offers** for each ChannelListing (one per fulfillment method)
4. **Migrate images** from ProductImage to ChannelListingImage (master images)
5. **Update OutboundSyncQueue** to support both Product and ChannelListing references
6. **Deprecate VariantChannelListing** (keep for backward compatibility during transition)

**Migration SQL Pseudocode:**

```sql
-- 1. Create ChannelListing from VariantChannelListing
INSERT INTO "ChannelListing" (
  "productId", "channelMarket", "channel", "region", 
  "externalListingId", "title", "price", "quantity", 
  "listingStatus", "createdAt", "updatedAt"
)
SELECT 
  pv."productId",
  CONCAT(vcl."channel", '_', COALESCE(vcl."region", 'US')),
  vcl."channel",
  COALESCE(vcl."region", 'US'),
  vcl."externalListingId",
  vcl."title",
  vcl."channelPrice",
  vcl."channelQuantity",
  vcl."listingStatus",
  vcl."createdAt",
  vcl."updatedAt"
FROM "VariantChannelListing" vcl
JOIN "ProductVariation" pv ON vcl."variantId" = pv."id";

-- 2. Create default Offers for each ChannelListing
INSERT INTO "Offer" (
  "channelListingId", "fulfillmentMethod", "sku", "price", "quantity", "isActive", "createdAt", "updatedAt"
)
SELECT 
  cl."id",
  'FBA',
  CONCAT(p."sku", '-FBA'),
  cl."price",
  cl."quantity",
  true,
  NOW(),
  NOW()
FROM "ChannelListing" cl
JOIN "Product" p ON cl."productId" = p."id";
```

---

## 2. The New Edit UI Layout

### 2.1 Tabbed Interface Architecture

```
Edit Product: [Product SKU]
├─ 📋 Master Catalog Tab
│  ├─ Internal SKU
│  ├─ Master Images (inherited by all channels)
│  ├─ Parent/Child Linking
│  ├─ Master Pricing & Inventory
│  └─ Master Attributes
│
├─ 🛒 Amazon Tab
│  ├─ Sub-tabs:
│  │  ├─ US Market
│  │  │  ├─ Listing Details (Title, Description, ASIN)
│  │  │  ├─ Offers Section
│  │  │  │  ├─ FBA Offer (SKU, Price, Quantity)
│  │  │  │  └─ FBM Offer (SKU, Price, Quantity)
│  │  │  ├─ Images (platform-specific overrides)
│  │  │  └─ [Sync from Master] Button
│  │  │
│  │  ├─ DE Market
│  │  │  └─ (Same structure as US)
│  │  │
│  │  └─ FR Market
│  │     └─ (Same structure as US)
│  │
│  └─ [Add Market] Button
│
├─ 🏪 eBay Tab
│  ├─ Sub-tabs:
│  │  ├─ US Market
│  │  │  ├─ Listing Details (Title, Description, ItemID)
│  │  │  ├─ Offers Section (typically 1 offer for eBay)
│  │  │  ├─ Images
│  │  │  └─ [Sync from Master] Button
│  │  │
│  │  └─ DE Market
│  │
│  └─ [Add Market] Button
│
├─ 🛍️ Shopify Tab
│  ├─ Listing Details
│  ├─ Offers (typically 1)
│  ├─ Images
│  └─ [Sync from Master] Button
│
└─ 🌐 WooCommerce Tab
   ├─ Listing Details
   ├─ Offers (typically 1)
   ├─ Images
   └─ [Sync from Master] Button
```

### 2.2 Master Catalog Tab (New)

**Purpose:** Single source of truth for product data

**Components:**

```tsx
// apps/web/src/app/catalog/[id]/edit/tabs/MasterCatalogTab.tsx

interface MasterCatalogTabProps {
  product: Product
  onUpdate: (data: Partial<Product>) => Promise<void>
}

export default function MasterCatalogTab({ product, onUpdate }: MasterCatalogTabProps) {
  return (
    <div className="space-y-6">
      {/* Section 1: Internal Identification */}
      <section>
        <h3 className="text-lg font-semibold mb-4">Internal Identification</h3>
        <div className="grid grid-cols-2 gap-4">
          <FormField label="Master SKU" value={product.sku} readOnly />
          <FormField label="Product Type" value={product.productType} />
          <FormField label="Brand" value={product.brand} />
          <FormField label="Manufacturer" value={product.manufacturer} />
        </div>
      </section>

      {/* Section 2: Master Images */}
      <section>
        <h3 className="text-lg font-semibold mb-4">Master Images</h3>
        <p className="text-sm text-gray-600 mb-4">
          These images are inherited by all channel listings unless overridden.
        </p>
        <ImageUploader 
          images={product.images}
          onUpload={(images) => onUpdate({ images })}
        />
      </section>

      {/* Section 3: Parent/Child Linking */}
      <section>
        <h3 className="text-lg font-semibold mb-4">Product Hierarchy</h3>
        {product.isParent ? (
          <div>
            <p className="text-sm text-green-600 mb-4">✓ This is a parent product</p>
            <ChildProductsList 
              children={product.children}
              onAddChild={() => {/* open modal */}}
            />
          </div>
        ) : product.parentId ? (
          <div>
            <p className="text-sm text-blue-600 mb-4">
              Child of: <strong>{product.parent?.name}</strong>
            </p>
            <button onClick={() => {/* navigate to parent */}}>
              View Parent Product
            </button>
          </div>
        ) : (
          <p className="text-sm text-gray-600">Standalone product (no parent/child)</p>
        )}
      </section>

      {/* Section 4: Master Pricing & Inventory */}
      <section>
        <h3 className="text-lg font-semibold mb-4">Master Pricing & Inventory</h3>
        <div className="grid grid-cols-2 gap-4">
          <FormField 
            label="Base Price" 
            type="number" 
            value={product.basePrice}
            onChange={(val) => onUpdate({ basePrice: val })}
          />
          <FormField 
            label="Total Stock" 
            type="number" 
            value={product.totalStock}
            onChange={(val) => onUpdate({ totalStock: val })}
          />
          <FormField 
            label="Cost Price" 
            type="number" 
            value={product.costPrice}
          />
          <FormField 
            label="Min Price" 
            type="number" 
            value={product.minPrice}
          />
        </div>
      </section>

      {/* Section 5: Master Attributes */}
      <section>
        <h3 className="text-lg font-semibold mb-4">Master Attributes</h3>
        <DynamicAttributeEditor 
          attributes={product.categoryAttributes}
          productType={product.productType}
          onChange={(attrs) => onUpdate({ categoryAttributes: attrs })}
        />
      </section>
    </div>
  )
}
```

### 2.3 Platform Tab (Amazon, eBay, etc.)

**Purpose:** Platform-specific listing management with regional markets

```tsx
// apps/web/src/app/catalog/[id]/edit/tabs/PlatformTab.tsx

interface PlatformTabProps {
  product: Product
  channel: 'AMAZON' | 'EBAY' | 'SHOPIFY' | 'WOOCOMMERCE'
  channelListings: ChannelListing[]
  onUpdate: (listing: ChannelListing) => Promise<void>
}

export default function PlatformTab({ 
  product, 
  channel, 
  channelListings, 
  onUpdate 
}: PlatformTabProps) {
  const [activeRegion, setActiveRegion] = useState<string>('US')
  const [showAddMarket, setShowAddMarket] = useState(false)

  const currentListing = channelListings.find(
    (cl) => cl.channel === channel && cl.region === activeRegion
  )

  return (
    <div className="space-y-6">
      {/* Region Selector */}
      <div className="flex items-center gap-2 border-b">
        {channelListings
          .filter((cl) => cl.channel === channel)
          .map((cl) => (
            <button
              key={cl.id}
              onClick={() => setActiveRegion(cl.region)}
              className={`px-4 py-2 font-medium ${
                activeRegion === cl.region
                  ? 'border-b-2 border-blue-600 text-blue-600'
                  : 'text-gray-600 hover:text-gray-900'
              }`}
            >
              {cl.region}
            </button>
          ))}
        <button
          onClick={() => setShowAddMarket(true)}
          className="ml-auto px-4 py-2 text-blue-600 hover:bg-blue-50 rounded"
        >
          + Add Market
        </button>
      </div>

      {currentListing ? (
        <RegionalMarketEditor 
          listing={currentListing}
          product={product}
          onUpdate={onUpdate}
        />
      ) : (
        <div className="text-center py-8 text-gray-500">
          No listing for {channel} {activeRegion}
        </div>
      )}

      {showAddMarket && (
        <AddMarketModal 
          channel={channel}
          existingRegions={channelListings
            .filter((cl) => cl.channel === channel)
            .map((cl) => cl.region)}
          onAdd={(region) => {
            // Create new ChannelListing
            setShowAddMarket(false)
            setActiveRegion(region)
          }}
          onClose={() => setShowAddMarket(false)}
        />
      )}
    </div>
  )
}
```

### 2.4 Regional Market Editor (Sub-component)

```tsx
// apps/web/src/app/catalog/[id]/edit/components/RegionalMarketEditor.tsx

interface RegionalMarketEditorProps {
  listing: ChannelListing
  product: Product
  onUpdate: (listing: ChannelListing) => Promise<void>
}

export default function RegionalMarketEditor({
  listing,
  product,
  onUpdate,
}: RegionalMarketEditorProps) {
  const [isSyncing, setIsSyncing] = useState(false)
  const [offers, setOffers] = useState<Offer[]>(listing.offers || [])

  const handleSyncFromMaster = async () => {
    setIsSyncing(true)
    try {
      // Copy master data to this listing
      const updated = {
        ...listing,
        title: product.name,
        description: product.bulletPoints.join('\n'),
        price: product.basePrice,
        quantity: product.totalStock,
        platformAttributes: {
          ...listing.platformAttributes,
          // Merge master attributes
        },
        syncFromMaster: false, // Reset flag after sync
      }
      await onUpdate(updated)
    } finally {
      setIsSyncing(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* Sync Control */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <div className="flex items-center justify-between">
          <div>
            <h4 className="font-semibold text-blue-900">Sync from Master</h4>
            <p className="text-sm text-blue-700">
              Pull master catalog data into this listing, then customize as needed.
            </p>
          </div>
          <button
            onClick={handleSyncFromMaster}
            disabled={isSyncing}
            className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-400"
          >
            {isSyncing ? 'Syncing…' : '🔄 Sync from Master'}
          </button>
        </div>
      </div>

      {/* Listing Details */}
      <section>
        <h3 className="text-lg font-semibold mb-4">Listing Details</h3>
        <div className="space-y-4">
          <FormField
            label="Title"
            value={listing.title || product.name}
            onChange={(val) => onUpdate({ ...listing, title: val })}
            maxLength={listing.channel === 'EBAY' ? 80 : 200}
          />
          <FormField
            label="Description"
            type="textarea"
            value={listing.description || ''}
            onChange={(val) => onUpdate({ ...listing, description: val })}
          />
          <FormField
            label={`${listing.channel} Listing ID`}
            value={listing.externalListingId || ''}
            readOnly
          />
        </div>
      </section>

      {/* Offers Section */}
      <section>
        <h3 className="text-lg font-semibold mb-4">Offers</h3>
        <p className="text-sm text-gray-600 mb-4">
          Manage multiple fulfillment methods (FBA, FBM, etc.) for this listing.
        </p>
        
        <div className="space-y-4">
          {offers.map((offer) => (
            <OfferCard
              key={offer.id}
              offer={offer}
              onUpdate={(updated) => {
                setOffers(offers.map((o) => (o.id === offer.id ? updated : o)))
              }}
              onDelete={(offerId) => {
                setOffers(offers.filter((o) => o.id !== offerId))
              }}
            />
          ))}
        </div>

        <button
          onClick={() => {
            // Add new offer
            const newOffer: Offer = {
              id: generateId(),
              channelListingId: listing.id,
              fulfillmentMethod: 'FBM',
              sku: `${product.sku}-FBM`,
              price: listing.price,
              quantity: listing.quantity,
              isActive: true,
              createdAt: new Date(),
              updatedAt: new Date(),
            }
            setOffers([...offers, newOffer])
          }}
          className="mt-4 px-4 py-2 border border-gray-300 rounded hover:bg-gray-50"
        >
          + Add Offer
        </button>
      </section>

      {/* Platform-Specific Images */}
      <section>
        <h3 className="text-lg font-semibold mb-4">Images</h3>
        <p className="text-sm text-gray-600 mb-4">
          Upload platform-specific images, or leave empty to use master images.
        </p>
        <ChannelListingImageUploader
          listing={listing}
          masterImages={product.images}
          onUpload={(images) => {
            // Update channel listing images
          }}
        />
      </section>
    </div>
  )
}
```

### 2.5 Offer Card Component

```tsx
// apps/web/src/app/catalog/[id]/edit/components/OfferCard.tsx

interface OfferCardProps {
  offer: Offer
  onUpdate: (offer: Offer) => Promise<void>
  onDelete: (offerId: string) => Promise<void>
}

export default function OfferCard({ offer, onUpdate, onDelete }: OfferCardProps) {
  const [isEditing, setIsEditing] = useState(false)

  return (
    <div className="border rounded-lg p-4 bg-gray-50">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <span className="font-semibold">{offer.fulfillmentMethod}</span>
          <span className="text-sm text-gray-600">SKU: {offer.sku}</span>
          <span
            className={`px-2 py-1 rounded text-xs font-medium ${
              offer.isActive
                ? 'bg-green-100 text-green-800'
                : 'bg-gray-200 text-gray-800'
            }`}
          >
            {offer.isActive ? 'Active' : 'Inactive'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setIsEditing(!isEditing)}
            className="px-3 py-1 text-sm border rounded hover:bg-white"
          >
            {isEditing ? 'Done' : 'Edit'}
          </button>
          <button
            onClick={() => onDelete(offer.id)}
            className="px-3 py-1 text-sm text-red-600 border border-red-300 rounded hover:bg-red-50"
          >
            Delete
          </button>
        </div>
      </div>

      {isEditing && (
        <div className="space-y-3 pt-4 border-t">
          <FormField
            label="SKU"
            value={offer.sku}
            onChange={(val) => onUpdate({ ...offer, sku: val })}
          />
          <div className="grid grid-cols-2 gap-4">
            <FormField
              label="Price"
              type="number"
              value={offer.price}
              onChange={(val) => onUpdate({ ...offer, price: val })}
            />
            <FormField
              label="Quantity"
              type="number"
              value={offer.quantity}
              onChange={(val) => onUpdate({ ...offer, quantity: val })}
            />
          </div>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={offer.isActive}
              onChange={(e) => onUpdate({ ...offer, isActive: e.target.checked })}
            />
            <span>Active</span>
          </label>
        </div>
      )}
    </div>
  )
}
```

---

## 3. Sync Engine Adjustments (Phase 8 → Phase 9)

### 3.1 OutboundSyncQueue Listener Updates

**Current (Phase 8):** Listens only to Product changes

**New (Phase 9):** Listens to Product, ChannelListing, and Offer changes

```typescript
// apps/api/src/services/outbound-sync.service.ts

export class OutboundSyncService {
  /**
   * Phase 9: Enhanced trigger detection
   * Listens to changes on Product, ChannelListing, and Offer models
   */
  async detectAndQueueChanges(
    entityType: 'PRODUCT' | 'CHANNEL_LISTING' | 'OFFER',
    entityId: string,
    changeType: 'CREATE' | 'UPDATE' | 'DELETE',
    payload: any
  ): Promise<void> {
    switch (entityType) {
      case 'PRODUCT':
        await this.handleProductChange(entityId, changeType, payload)
        break
      case 'CHANNEL_LISTING':
        await this.handleChannelListingChange(entityId, changeType, payload)
        break
      case 'OFFER':
        await this.handleOfferChange(entityId, changeType, payload)
        break
    }
  }

  /**
   * Handle Product changes (Master Catalog updates)
   * Queues sync for all connected channel listings
   */
  private async handleProductChange(
    productId: string,
    changeType: 'CREATE' | 'UPDATE' | 'DELETE',
    payload: Partial<Product>
  ): Promise<void> {
    const product = await prisma.product.findUnique({
      where: { id: productId },
      include: { channelListings: true },
    })

    if (!product) return

    // Determine what changed
    const changedFields = Object.keys(payload)
    const syncType = this.determineSyncType(changedFields)

    // Queue sync for each connected channel listing
    for (const listing of product.channelListings) {
      if (listing.syncLocked) continue // Skip if listing is locked

      await prisma.outboundSyncQueue.create({
        data: {
          productId,
          channelListingId: listing.id,
          targetChannel: listing.channel as SyncChannel,
          targetRegion: listing.region,
          syncStatus: 'PENDING',
          syncType,
          payload: {
            source: 'PRODUCT_CHANGE',
            changedFields,
            masterData: {
              name: product.name,
              basePrice: product.basePrice,
              totalStock: product.totalStock,
              bulletPoints: product.bulletPoints,
              categoryAttributes: product.categoryAttributes,
              images: product.images,
            },
          },
        },
      })
    }
  }

  /**
   * Handle ChannelListing changes (Platform-specific updates)
   * Queues sync for the specific channel listing
   */
  private async handleChannelListingChange(
    channelListingId: string,
    changeType: 'CREATE' | 'UPDATE' | 'DELETE',
    payload: Partial<ChannelListing>
  ): Promise<void> {
    const listing = await prisma.channelListing.findUnique({
      where: { id: channelListingId },
      include: { offers: true },
    })

    if (!listing) return

    const changedFields = Object.keys(payload)
    const syncType = this.determineSyncType(changedFields)

    // If syncFromMaster flag is set, merge master data
    let syncPayload: any = {
      source: 'CHANNEL_LISTING_CHANGE',
      changedFields,
      listingData: {
        title: listing.title,
        description: listing.description,
        price: listing.price,
        quantity: listing.quantity,
        platformAttributes: listing.platformAttributes,
      },
    }

    if (payload.syncFromMaster) {
      const product = await prisma.product.findUnique({
        where: { id: listing.productId },
      })
      syncPayload.masterData = {
        name: product?.name,
        basePrice: product?.basePrice,
        totalStock: product?.totalStock,
        bulletPoints: product?.bulletPoints,
      }
    }

    await prisma.outboundSyncQueue.create({
      data: {
        channelListingId,
        productId: listing.productId,
        targetChannel: listing.channel as SyncChannel,
        targetRegion: listing.region,
        syncStatus: 'PENDING',
        syncType,
        payload: syncPayload,
      },
    })
  }

  /**
   * Handle Offer changes (Fulfillment-specific updates)
   * Queues sync for the parent channel listing
   */
  private async handleOfferChange(
    offerId: string,
    changeType: 'CREATE' | 'UPDATE' | 'DELETE',
    payload: Partial<Offer>
  ): Promise<void> {
    const offer = await prisma.offer.findUnique({
      where: { id: offerId },
      include: { channelListing: true },
    })

    if (!offer) return

    const changedFields = Object.keys(payload)
    const syncType = this.determineSyncType(changedFields)

    await prisma.outboundSyncQueue.create({
      data: {
        channelListingId: offer.channelListingId,
        productId: offer.channelListing.productId,
        targetChannel: offer.channelListing.channel as SyncChannel,
        targetRegion: offer.channelListing.region,
        syncStatus: 'PENDING',
        syncType,
        payload: {
          source: 'OFFER_CHANGE',
          changedFields,
          offerData: {
            fulfillmentMethod: offer.fulfillmentMethod,
            sku: offer.sku,
            price: offer.price,
            quantity: offer.quantity,
            isActive: offer.isActive,
          },
        },
      },
    })
  }

  /**
   * Determine sync type based on changed fields
   */
  private determineSyncType(changedFields: string[]): string {
    if (changedFields.includes('price') || changedFields.includes('basePrice')) {
      return 'PRICE_UPDATE'
    }
    if (changedFields.includes('quantity') || changedFields.includes('totalStock')) {
      return 'QUANTITY_UPDATE'
    }
    if (changedFields.includes('title') || changedFields.includes('description')) {
      return 'LISTING_SYNC'
    }
    if (changedFields.includes('fulfillmentMethod') || changedFields.includes('sku')) {
      return 'OFFER_SYNC'
    }
    return 'FULL_SYNC'
  }
}
```

### 3.2 Sync Worker Updates

```typescript
// apps/api/src/services/sync/outbound-sync-worker.ts

export class OutboundSyncWorker {
  /**
   * Process queued sync items
   * Phase 9: Handle ChannelListing and Offer syncs
   */
  async processSyncQueue(): Promise<void> {
    const pendingItems = await prisma.outboundSyncQueue.findMany({
      where: {
        syncStatus: 'PENDING',
        nextRetryAt: { lte: new Date() },
      },
      include: {
        product: true,
        channelListing: { include: { offers: true } },
      },
      take: 100,
    })

    for (const item of pendingItems) {
      try {
        await this.processSyncItem(item)
      } catch (error) {
        await this.handleSyncError(item, error)
      }
    }
  }

  private async processSyncItem(item: OutboundSyncQueue): Promise<void> {
    // Route to appropriate sync handler based on source
    const payload = item.payload as any

    switch (payload.source) {
      case 'PRODUCT_CHANGE':
        await this.syncProductToChannels(item)
        break
      case 'CHANNEL_LISTING_CHANGE':
        await this.syncChannelListing(item)
        break
      case 'OFFER_CHANGE':
        await this.syncOffer(item)
        break
    }
  }

  /**
   * Sync Product changes to all connected channel listings
   */
  private async syncProductToChannels(item: OutboundSyncQueue): Promise<void> {
    const { product, channelListing, targetChannel, payload } = item

    if (!product || !channelListing) return

    // Route to channel-specific sync service
    switch (targetChannel) {
      case 'AMAZON':
        await this.amazonSyncService.syncProductToListing(
          product,
          channelListing,
          payload
        )
        break
      case 'EBAY':
        await this.ebaySyncService.syncProductToListing(
          product,
          channelListing,
          payload
        )
        break
      // ... other channels
    }

    // Mark as synced
    await prisma.outboundSyncQueue.update({
      where: { id: item.id },
      data: {
        syncStatus: 'SUCCESS',
        syncedAt: new Date(),
      },
    })
  }

  /**
   * Sync ChannelListing changes to the platform
   */
  private async syncChannelListing(item: OutboundSyncQueue): Promise<void> {
    const { channelListing, targetChannel, payload } = item

    if (!channelListing) return

    switch (targetChannel) {
      case 'AMAZON':
        await this.amazonSyncService.updateListing(channelListing, payload)
        break
      case 'EBAY':
        await this.ebaySyncService.updateListing(channelListing, payload)
        break
      // ... other channels
    }

    await prisma.outboundSyncQueue.update({
      where: { id: item.id },
      data: {
        syncStatus: 'SUCCESS',
        syncedAt: new Date(),
      },
    })
  }

  /**
   * Sync Offer changes to the platform
   */
  private async syncOffer(item: OutboundSyncQueue): Promise<void> {
    const { channelListing, targetChannel, payload } = item

    if (!channelListing) return

    switch (targetChannel) {
      case 'AMAZON':
        await this.amazonSyncService.updateOffers(channelListing, payload)
        break
      case 'EBAY':
        await this.ebaySyncService.updateOffers(channelListing, payload)
        break
      // ... other channels
    }

    await prisma.outboundSyncQueue.update({
      where: { id: item.id },
      data: {
        syncStatus: 'SUCCESS',
        syncedAt: new Date(),
      },
    })
  }

  private async handleSyncError(
    item: OutboundSyncQueue,
    error: Error
  ): Promise<void> {
    const nextRetryAt = new Date(Date.now() + 5 * 60 * 1000) // 5 min backoff

    await prisma.outboundSyncQueue.update({
      where: { id: item.id },
      data: {
        syncStatus: item.retryCount < item.maxRetries ? 'PENDING' : 'FAILED',
        errorMessage: error.message,
        retryCount: { increment: 1 },
        nextRetryAt: item.retryCount < item.maxRetries ? nextRetryAt : null,
      },
    })
  }
}
```

### 3.3 Sync Trigger Points

**Product Changes:**
- Master SKU, name, brand, manufacturer → Queue FULL_SYNC for all listings
- basePrice, totalStock → Queue PRICE_UPDATE / QUANTITY_UPDATE
- bulletPoints, categoryAttributes → Queue LISTING_SYNC
- images → Queue IMAGE_SYNC

**ChannelListing Changes:**
- title, description → Queue LISTING_SYNC
- price, quantity → Queue PRICE_UPDATE / QUANTITY_UPDATE
- platformAttributes → Queue LISTING_SYNC
- syncFromMaster flag → Merge master data + queue FULL_SYNC

**Offer Changes:**
- sku, price, quantity → Queue OFFER_SYNC
- fulfillmentMethod → Queue OFFER_SYNC
- isActive → Queue OFFER_SYNC

---

## 4. Implementation Roadmap

### Phase 9a: Database Migration (Week 1-2)
- [ ] Create Prisma migration for new models
- [ ] Backfill ChannelListings from VariantChannelListing
- [ ] Create default Offers for each ChannelListing
- [ ] Migrate ProductImages to ChannelListingImages
- [ ] Update OutboundSyncQueue schema

### Phase 9b: Backend Services (Week 2-3)
- [ ] Implement OutboundSyncService enhancements
- [ ] Create ChannelListing CRUD endpoints
- [ ] Create Offer CRUD endpoints
- [ ] Implement sync trigger detection
- [ ] Update sync worker for new entity types

### Phase 9c: Frontend UI (Week 3-4)
- [ ] Build Master Catalog Tab
- [ ] Build Platform Tab with regional sub-tabs
- [ ] Build Offer Card component
- [ ] Build ChannelListingImageUploader
- [ ] Implement "Sync from Master" functionality

### Phase 9d: Testing & Refinement (Week 4-5)
- [ ] Integration tests for sync triggers
- [ ] E2E tests for edit UI
- [ ] Performance testing with large product catalogs
- [ ] User acceptance testing

---

## 5. Data Flow Diagrams

### 5.1 Master Catalog → Channel Listings Flow

```
┌─────────────────────────────────────────────────────────────┐
│ User edits Master Product (name, price, images)             │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
        ┌────────────────────────────┐
        │ OutboundSyncService        │
        │ detectAndQueueChanges()    │
        └────────────┬───────────────┘
                     │
        ┌────────────▼──────────────────────────────────────┐
        │ For each ChannelListing (if not syncLocked):      │
        │ - Create OutboundSyncQueue entry                  │
        │ - Set syncType based on changed fields            │
        │ - Include master data in payload                  │
        └────────────┬──────────────────────────────────────┘
                     │
        ┌────────────▼──────────────────────────────────────┐
        │ OutboundSyncWorker                                │
        │ processSyncQueue()                                │
        │ - Fetch pending items                             │
        │ - Route to channel-specific sync service          │
        │ - Update listing on platform                      │
        │ - Mark as SUCCESS or FAILED                       │
        └────────────┬──────────────────────────────────────┘
                     │
        ┌────────────▼──────────────────────────────────────┐
        │ Amazon/eBay/Shopify Sync Service                  │
        │ syncProductToListing()                            │
        │ - Transform master data to platform format        │
        │ - Call platform API                               │
        │ - Update ChannelListing with response             │
        └──────────────────────────────────────────────────┘
```

### 5.2 Channel Listing → Offers Flow

```
┌──────────────────────────────────────────────────────────┐
│ User edits ChannelListing (title, price) or Offer        │
└────────────────────┬─────────────────────────────────────┘
                     │
                     ▼
        ┌────────────────────────────┐
        │ OutboundSyncService        │
        │ handleChannelListingChange()│
        │ or handleOfferChange()     │
        └────────────┬───────────────┘
                     │
        ┌────────────▼──────────────────────────────────────┐
        │ Create OutboundSyncQueue entry                    │
        │ - Source: CHANNEL_LISTING_CHANGE or OFFER_CHANGE  │
        │ - Include listing/offer data in payload           │
        │ - If syncFromMaster: merge master data            │
        └────────────┬──────────────────────────────────────┘
                     │
        ┌────────────▼──────────────────────────────────────┐
        │ OutboundSyncWorker                                │
        │ processSyncItem()                                 │
        │ - Route to syncChannelListing() or syncOffer()    │
        │ - Call platform API with updated data             │
        │ - Update ChannelListing/Offer status              │
        └──────────────────────────────────────────────────┘
```

---

## 6. Key Features & Benefits

### 6.1 Master Catalog Tab
✅ Single source of truth for product data
✅ Inherited by all channel listings
✅ Bulk updates propagate to all channels
✅ Parent/child product hierarchy management

### 6.2 Platform Tabs with Regional Markets
✅ Independent listings per region (Amazon US vs DE)
✅ Platform-specific titles, descriptions, attributes
✅ Regional pricing and inventory overrides
✅ Easy market expansion (add new region with one click)

### 6.3 Offer Management
✅ Multiple fulfillment methods per listing (FBA + FBM)
✅ Offer-specific SKUs, pricing, inventory
✅ Toggle offers active/inactive
✅ Fulfillment-specific metadata (shipping templates, etc.)

### 6.4 Sync Control
✅ "Sync from Master" button for easy data replication
✅ Sync lock to prevent accidental overwrites
✅ Granular sync triggers (product, listing, offer level)
✅ Retry logic with exponential backoff

### 6.5 Image Management
✅ Master images inherited by all listings
✅ Platform-specific image overrides
✅ Per-offer image variants (if needed)
✅ Image type classification (MAIN, ALT, LIFESTYLE, SWATCH)

---

## 7. Database Indexes & Performance

### Critical Indexes for Phase 9

```prisma
// ChannelListing indexes
@@unique([productId, channelMarket])  // Prevent duplicates
@@index([productId])                   // Find listings by product
@@index([channel])                     // Filter by channel
@@index([region])                      // Filter by region
@@index([externalListingId])           // Lookup by platform ID
@@index([listingStatus])               // Find active/inactive listings

// Offer indexes
@@unique([channelListingId, fulfillmentMethod])  // Prevent duplicates
@@index([channelListingId])            // Find offers by listing
@@index([fulfillmentMethod])           // Filter by fulfillment type
@@index([isActive])                    // Find active offers

// OutboundSyncQueue indexes
@@index([productId])                   // Find syncs by product
@@index([channelListingId])            // Find syncs by listing
@@index([syncStatus])                  // Find pending/failed syncs
@@index([targetChannel])               // Filter by channel
@@index([nextRetryAt])                 // Find items ready to retry
```

### Query Optimization Tips

1. **Eager load relations** when fetching ChannelListings:
   ```typescript
   const listing = await prisma.channelListing.findUnique({
     where: { id: listingId },
     include: {
       product: true,
       offers: true,
       images: true,
     },
   })
   ```

2. **Batch sync operations** to reduce database round-trips:
   ```typescript
   const listings = await prisma.channelListing.findMany({
     where: { productId, syncStatus: 'PENDING' },
     include: { offers: true },
   })
   ```

3. **Use pagination** for large result sets:
   ```typescript
   const listings = await prisma.channelListing.findMany({
     where: { channel: 'AMAZON' },
     skip: (page - 1) * pageSize,
     take: pageSize,
   })
   ```

---

## 8. Backward Compatibility & Deprecation

### Deprecated Models (Phase 9)
- `VariantChannelListing` → Replaced by `ChannelListing` + `Offer`
- Keep for 2 releases for backward compatibility
- Provide migration utilities

### API Versioning
- `/api/v1/products/{id}/listings` → Old endpoint (deprecated)
- `/api/v2/products/{id}/channel-listings` → New endpoint
- Support both during transition period

### Data Migration Utilities
```typescript
// Migrate old VariantChannelListing to new ChannelListing + Offer
async function migrateVariantChannelListings(): Promise<void> {
  const oldListings = await prisma.variantChannelListing.findMany()
  
  for (const old of oldListings) {
    // Create ChannelListing
    const listing = await prisma.channelListing.create({
      data: {
        productId: old.productId,
        channelMarket: `${old.channel}_${old.region || 'US'}`,
        channel: old.channel,
        region: old.region || 'US',
        externalListingId: old.externalListingId,
        title: old.title,
        price: old.channelPrice,
        quantity: old.channelQuantity,
        listingStatus: old.listingStatus,
      },
    })
    
    // Create default Offer
    await prisma.offer.create({
      data: {
        channelListingId: listing.id,
        fulfillmentMethod: 'FBM',
        sku: `${old.sku}-FBM`,
        price: old.channelPrice,
        quantity: old.channelQuantity,
        isActive: true,
      },
    })
  }
}
```

---

## 9. Monitoring & Observability

### Key Metrics to Track

1. **Sync Performance**
   - Sync queue depth (pending items)
   - Sync success rate by channel
   - Average sync latency
   - Retry rate

2. **Data Quality**
   - Listings with missing images
   - Listings with sync errors
   - Offers with inactive status
   - Price discrepancies between master and listings

3. **User Activity**
   - Edits per product
   - "Sync from Master" usage
   - Offer creation/deletion rate
   - Regional market expansion rate

### Logging Strategy

```typescript
// Log all sync operations
logger.info('Sync started', {
  entityType: 'CHANNEL_LISTING',
  entityId: listing.id,
  channel: listing.channel,
  region: listing.region,
  syncType: 'LISTING_SYNC',
})

// Log errors with context
logger.error('Sync failed', {
  entityType: 'CHANNEL_LISTING',
  entityId: listing.id,
  error: error.message,
  retryCount: item.retryCount,
  nextRetryAt: item.nextRetryAt,
})
```

---

## 10. Future Enhancements (Phase 10+)

- **Bulk Editing:** Edit multiple listings/offers at once
- **Template System:** Save and reuse listing templates per channel
- **A/B Testing:** Test different titles/descriptions per region
- **Inventory Sync:** Real-time inventory sync from warehouse systems
- **Pricing Intelligence:** AI-powered pricing recommendations per channel
- **Compliance Checking:** Validate listings against platform policies
- **Multi-language Support:** Auto-translate listings for different regions

---

## Conclusion

Phase 9 establishes Nexus as a true enterprise-grade PIM system with:
- **Separation of concerns:** Master catalog vs. platform-specific data
- **Scalability:** Support for unlimited channels and regional markets
- **Flexibility:** Independent offer management per listing
- **Control:** Granular sync triggers and data replication
- **Maintainability:** Clear data model and sync architecture

This blueprint provides the foundation for implementing the Multi-Channel Matrix while maintaining backward compatibility and enabling future enhancements.