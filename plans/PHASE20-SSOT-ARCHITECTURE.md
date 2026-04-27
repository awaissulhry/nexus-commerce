# Phase 20: Amazon-Grade SSOT Architecture with Channel Overrides

## Executive Summary

This phase implements an enterprise-grade **Single Source of Truth (SSOT)** pattern inspired by Amazon's multi-channel listing system. The architecture enables:

1. **Master Data as SSOT**: One canonical product record with all base attributes
2. **Channel-Specific Overrides**: Per-channel customizations (Amazon Price ≠ eBay Price)
3. **Inheritance-Based Variations**: Child products inherit parent data but can override specific fields
4. **Real-Time Sync Queue**: BullMQ integration to push changes to marketplace APIs
5. **Validation State Icons**: Visual indicators showing sync status and override state
6. **Cascade Logic**: Price/stock changes propagate intelligently to children and channels

---

## Current State Analysis

### What Works ✅
- **Variation Matrix Table**: Inline editing for SKU, price, stock (Phase 19.14.8)
- **Child Product API**: PATCH `/api/products/:parentId/children/:childId` endpoint exists
- **Parent/Child Relationships**: Database schema supports `parentId` and `isParent` flags
- **Basic Sync Queuing**: `outboundSyncService.queueProductUpdate()` exists

### What's Broken ❌
- **404 Errors on PATCH**: Child update endpoint returns 404 in logs (needs investigation)
- **No Channel Overrides**: All channels use master data directly
- **No SSOT Pattern**: No distinction between master data and channel-specific values
- **No Override Toggles**: UI doesn't show "Follow Master Data" vs "Custom Value"
- **No Sync Status Icons**: No visual feedback on sync state
- **No Cascade Logic**: Price/stock changes don't propagate intelligently

### Architecture Gaps
- **ChannelListing Model**: Exists but doesn't store overrides (price, title, description)
- **No Override Tracking**: Can't distinguish master value from override
- **No Sync State**: No way to track if a channel is in sync or pending
- **No Validation State**: No icons showing validation errors per channel

---

## Phase 20 Implementation Plan

### Phase 20.1: Fix 404 Errors on PATCH Child Endpoints

**Problem**: Child update API returns 404 despite endpoint existing at line 919 in `catalog.routes.ts`

**Root Cause Analysis**:
1. Route registration might be missing or misconfigured
2. Fastify route prefix might not match client fetch URL
3. Request body parsing might fail silently

**Solution**:
```typescript
// In apps/api/src/routes/index.ts, verify route registration:
app.register(catalogRoutes, { prefix: '/api/catalog' })
// OR
app.register(catalogRoutes, { prefix: '/api' })

// The endpoint should be accessible at:
// PATCH /api/products/:parentId/children/:childId
// OR
// PATCH /api/catalog/products/:parentId/children/:childId
```

**Action Items**:
- [ ] Check `apps/api/src/routes/index.ts` for route registration
- [ ] Verify Fastify prefix configuration
- [ ] Add console logging to PATCH handler to confirm it's being called
- [ ] Test endpoint with curl/Postman
- [ ] Update client fetch URL if prefix is different

---

### Phase 20.2: Design SSOT Data Model & Schema Extensions

**Core Concept**: Master Product → Channel Listings → Channel Overrides

```
Product (Master)
├── basePrice: 99.99 (SSOT)
├── name: "Premium Headphones" (SSOT)
├── description: "..." (SSOT)
├── totalStock: 100 (SSOT)
│
├── ChannelListing (Amazon)
│   ├── channel: "AMAZON"
│   ├── priceOverride: 89.99 (custom)
│   ├── titleOverride: "Amazon-Optimized Title"
│   ├── descriptionOverride: "Amazon-specific description"
│   ├── followMasterPrice: false (override active)
│   ├── followMasterTitle: false (override active)
│   ├── syncStatus: "IN_SYNC" | "PENDING" | "ERROR"
│   └── lastSyncAt: DateTime
│
├── ChannelListing (eBay)
│   ├── channel: "EBAY"
│   ├── priceOverride: null (null = follow master)
│   ├── titleOverride: null
│   ├── followMasterPrice: true (using master)
│   ├── followMasterTitle: true (using master)
│   ├── syncStatus: "PENDING"
│   └── lastSyncAt: DateTime
│
└── ProductVariation (Child)
    ├── basePrice: 79.99 (inherits from parent, can override)
    ├── totalStock: 50 (inherits from parent, can override)
    └── ChannelListings[] (same override pattern)
```

**Prisma Schema Changes**:

```prisma
// Extend ChannelListing model
model ChannelListing {
  id                    String   @id @default(cuid())
  productId             String
  product               Product  @relation(fields: [productId], references: [id], onDelete: Cascade)
  
  channel               String   // AMAZON, EBAY, SHOPIFY, WOOCOMMERCE
  channelMarket         String   // AMAZON_US, AMAZON_EU, etc.
  region                String   // US, EU, UK, etc.
  
  // Master data references (read-only, for display)
  masterTitle           String?
  masterPrice           Decimal? @db.Decimal(10, 2)
  masterDescription     String?
  
  // Channel-specific overrides
  title                 String?  // If null, use master
  priceOverride         Decimal? @db.Decimal(10, 2)
  descriptionOverride   String?
  
  // Override toggles (explicit control)
  followMasterTitle     Boolean  @default(true)
  followMasterPrice     Boolean  @default(true)
  followMasterDescription Boolean @default(true)
  
  // Sync state tracking
  syncStatus            String   @default("PENDING") // PENDING, IN_SYNC, ERROR, SYNCING
  lastSyncAt            DateTime?
  lastSyncError         String?
  syncAttempts          Int      @default(0)
  
  // Platform-specific attributes
  platformAttributes    Json?    // bulletPoints, images, etc.
  
  createdAt             DateTime @default(now())
  updatedAt             DateTime @updatedAt
  
  @@unique([productId, channel, region])
}

// New model: Track override history for audit trail
model ChannelListingOverride {
  id                    String   @id @default(cuid())
  channelListingId      String
  channelListing        ChannelListing @relation(fields: [channelListingId], references: [id], onDelete: Cascade)
  
  field                 String   // "price", "title", "description"
  masterValue           String?
  overrideValue         String?
  reason                String?  // Why was this overridden?
  
  createdAt             DateTime @default(now())
  createdBy             String?  // User ID
}

// Extend Product model
model Product {
  // ... existing fields ...
  
  // SSOT indicators
  isMasterProduct       Boolean  @default(false)
  isParent              Boolean  @default(false)
  
  // Sync configuration
  syncChannels          String[] @default(["AMAZON", "EBAY"]) // Which channels to sync to
  autoSyncEnabled       Boolean  @default(true)
  
  // Validation state
  validationStatus      String   @default("VALID") // VALID, WARNING, ERROR
  validationErrors      Json?    // { channel: [errors] }
}
```

**Data Flow Diagram**:
```
User edits Master Price (99.99)
    ↓
Product.basePrice = 99.99 (SSOT updated)
    ↓
For each ChannelListing:
  - If followMasterPrice = true:
    → Use Product.basePrice for display
    → Queue sync to marketplace
  - If followMasterPrice = false:
    → Use ChannelListing.priceOverride
    → Queue sync to marketplace
    ↓
BullMQ Queue receives sync job
    ↓
Marketplace API updated
    ↓
ChannelListing.syncStatus = "IN_SYNC"
ChannelListing.lastSyncAt = now()
```

---

### Phase 20.3: Implement Channel Override UI Components

**New Component**: `ChannelOverrideToggle.tsx`

```typescript
interface ChannelOverrideToggleProps {
  field: 'price' | 'title' | 'description'
  masterValue: string | number
  overrideValue: string | number | null
  followMaster: boolean
  onToggle: (followMaster: boolean) => void
  onOverrideChange: (value: string | number) => void
  syncStatus: 'PENDING' | 'IN_SYNC' | 'ERROR' | 'SYNCING'
  lastSyncAt?: Date
  validationError?: string
}

export function ChannelOverrideToggle({
  field,
  masterValue,
  overrideValue,
  followMaster,
  onToggle,
  onOverrideChange,
  syncStatus,
  lastSyncAt,
  validationError,
}: ChannelOverrideToggleProps) {
  return (
    <div className="border border-gray-200 rounded-lg p-4 space-y-3">
      {/* Header with sync status icon */}
      <div className="flex items-center justify-between">
        <label className="text-sm font-medium text-gray-700">
          {field.charAt(0).toUpperCase() + field.slice(1)}
        </label>
        <SyncStatusIcon status={syncStatus} lastSyncAt={lastSyncAt} />
      </div>

      {/* Master value display */}
      <div className="bg-gray-50 rounded p-3 border border-gray-200">
        <p className="text-xs text-gray-600 mb-1">Master Value (SSOT)</p>
        <p className="text-sm font-mono text-gray-900">{masterValue}</p>
      </div>

      {/* Follow Master toggle */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => onToggle(!followMaster)}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
            followMaster ? 'bg-green-600' : 'bg-gray-300'
          }`}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
              followMaster ? 'translate-x-6' : 'translate-x-1'
            }`}
          />
        </button>
        <span className="text-sm text-gray-700">
          {followMaster ? '✓ Follow Master Data' : '✎ Custom Override'}
        </span>
      </div>

      {/* Override input (shown only if not following master) */}
      {!followMaster && (
        <div>
          <input
            type={field === 'price' ? 'number' : 'text'}
            value={overrideValue || ''}
            onChange={(e) => onOverrideChange(e.target.value)}
            className={`w-full px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none ${
              validationError ? 'border-red-300 bg-red-50' : 'border-gray-300'
            }`}
            placeholder={`Enter custom ${field}`}
          />
          {validationError && (
            <p className="text-xs text-red-600 mt-1">{validationError}</p>
          )}
        </div>
      )}

      {/* Last sync info */}
      {lastSyncAt && (
        <p className="text-xs text-gray-500">
          Last synced: {new Date(lastSyncAt).toLocaleString()}
        </p>
      )}
    </div>
  )
}
```

**New Component**: `SyncStatusIcon.tsx`

```typescript
interface SyncStatusIconProps {
  status: 'PENDING' | 'IN_SYNC' | 'ERROR' | 'SYNCING'
  lastSyncAt?: Date
}

export function SyncStatusIcon({ status, lastSyncAt }: SyncStatusIconProps) {
  const icons = {
    PENDING: { icon: '⏳', color: 'text-yellow-600', label: 'Pending sync' },
    SYNCING: { icon: '⟳', color: 'text-blue-600 animate-spin', label: 'Syncing...' },
    IN_SYNC: { icon: '✓', color: 'text-green-600', label: 'In sync' },
    ERROR: { icon: '✕', color: 'text-red-600', label: 'Sync error' },
  }

  const { icon, color, label } = icons[status]

  return (
    <div className="flex items-center gap-2">
      <span className={`text-lg ${color}`}>{icon}</span>
      <span className="text-xs text-gray-600">{label}</span>
    </div>
  )
}
```

---

### Phase 20.4: Build Channel-Specific Tabs with Override Toggles

**New Component**: `ChannelOverridesTab.tsx`

```typescript
interface ChannelOverridesTabProps {
  product: Product
  channelListings: ChannelListing[]
  onUpdate: (channelListingId: string, updates: any) => Promise<void>
}

export function ChannelOverridesTab({
  product,
  channelListings,
  onUpdate,
}: ChannelOverridesTabProps) {
  const [activeChannel, setActiveChannel] = useState<string>('AMAZON')
  const [loading, setLoading] = useState(false)

  const currentListing = channelListings.find((cl) => cl.channel === activeChannel)

  if (!currentListing) {
    return <div>No channel listing found</div>
  }

  return (
    <div className="space-y-6">
      {/* Channel Tabs */}
      <div className="flex gap-2 border-b border-gray-200">
        {['AMAZON', 'EBAY', 'SHOPIFY', 'WOOCOMMERCE'].map((channel) => (
          <button
            key={channel}
            onClick={() => setActiveChannel(channel)}
            className={`px-4 py-2 font-medium border-b-2 transition-colors ${
              activeChannel === channel
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-gray-600 hover:text-gray-900'
            }`}
          >
            {channel}
          </button>
        ))}
      </div>

      {/* Channel-Specific Overrides */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Price Override */}
        <ChannelOverrideToggle
          field="price"
          masterValue={product.basePrice}
          overrideValue={currentListing.priceOverride}
          followMaster={currentListing.followMasterPrice}
          onToggle={async (followMaster) => {
            setLoading(true)
            try {
              await onUpdate(currentListing.id, {
                followMasterPrice: followMaster,
                priceOverride: followMaster ? null : currentListing.priceOverride,
              })
            } finally {
              setLoading(false)
            }
          }}
          onOverrideChange={async (value) => {
            setLoading(true)
            try {
              await onUpdate(currentListing.id, {
                priceOverride: parseFloat(String(value)),
              })
            } finally {
              setLoading(false)
            }
          }}
          syncStatus={currentListing.syncStatus as any}
          lastSyncAt={currentListing.lastSyncAt}
        />

        {/* Title Override */}
        <ChannelOverrideToggle
          field="title"
          masterValue={product.name}
          overrideValue={currentListing.title}
          followMaster={currentListing.followMasterTitle}
          onToggle={async (followMaster) => {
            setLoading(true)
            try {
              await onUpdate(currentListing.id, {
                followMasterTitle: followMaster,
                title: followMaster ? null : currentListing.title,
              })
            } finally {
              setLoading(false)
            }
          }}
          onOverrideChange={async (value) => {
            setLoading(true)
            try {
              await onUpdate(currentListing.id, {
                title: String(value),
              })
            } finally {
              setLoading(false)
            }
          }}
          syncStatus={currentListing.syncStatus as any}
          lastSyncAt={currentListing.lastSyncAt}
        />
      </div>

      {/* Description Override */}
      <ChannelOverrideToggle
        field="description"
        masterValue={product.description || ''}
        overrideValue={currentListing.descriptionOverride}
        followMaster={currentListing.followMasterDescription}
        onToggle={async (followMaster) => {
          setLoading(true)
          try {
            await onUpdate(currentListing.id, {
              followMasterDescription: followMaster,
              descriptionOverride: followMaster ? null : currentListing.descriptionOverride,
            })
          } finally {
            setLoading(false)
          }
        }}
        onOverrideChange={async (value) => {
          setLoading(true)
          try {
            await onUpdate(currentListing.id, {
              descriptionOverride: String(value),
            })
          } finally {
            setLoading(false)
          }
        }}
        syncStatus={currentListing.syncStatus as any}
        lastSyncAt={currentListing.lastSyncAt}
      />

      {/* Sync Control */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <h3 className="font-semibold text-blue-900 mb-3">Sync Control</h3>
        <button
          onClick={async () => {
            setLoading(true)
            try {
              await onUpdate(currentListing.id, {
                syncStatus: 'PENDING',
              })
            } finally {
              setLoading(false)
            }
          }}
          disabled={loading}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
        >
          Force Sync to {activeChannel}
        </button>
      </div>
    </div>
  )
}
```

---

### Phase 20.5: Create Real-Time Sync Queue Integration

**Backend Service**: `channel-sync.service.ts`

```typescript
import { Queue } from 'bullmq'
import prisma from '../db.js'

export class ChannelSyncService {
  private syncQueue: Queue

  constructor(redisConnection: any) {
    this.syncQueue = new Queue('channel-sync', { connection: redisConnection })
  }

  /**
   * Queue a channel listing for sync
   */
  async queueChannelSync(
    channelListingId: string,
    syncType: 'FULL' | 'PRICE' | 'TITLE' | 'DESCRIPTION'
  ) {
    const listing = await prisma.channelListing.findUnique({
      where: { id: channelListingId },
      include: { product: true },
    })

    if (!listing) throw new Error('Channel listing not found')

    // Update sync status to PENDING
    await prisma.channelListing.update({
      where: { id: channelListingId },
      data: { syncStatus: 'PENDING' },
    })

    // Queue the sync job
    await this.syncQueue.add(
      'sync-channel-listing',
      {
        channelListingId,
        productId: listing.productId,
        channel: listing.channel,
        syncType,
        masterPrice: listing.product.basePrice,
        masterTitle: listing.product.name,
        masterDescription: listing.product.description,
        overridePrice: listing.priceOverride,
        overrideTitle: listing.title,
        overrideDescription: listing.descriptionOverride,
        followMasterPrice: listing.followMasterPrice,
        followMasterTitle: listing.followMasterTitle,
        followMasterDescription: listing.followMasterDescription,
      },
      {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
        removeOnComplete: true,
      }
    )

    return { queued: true, channelListingId }
  }

  /**
   * Handle cascade sync when master product changes
   */
  async cascadeSyncToChannels(productId: string, changedFields: string[]) {
    const product = await prisma.product.findUnique({
      where: { id: productId },
      include: { channelListings: true },
    })

    if (!product) throw new Error('Product not found')

    // Determine sync type based on changed fields
    let syncType: 'FULL' | 'PRICE' | 'TITLE' | 'DESCRIPTION' = 'FULL'
    if (changedFields.length === 1) {
      if (changedFields[0] === 'basePrice') syncType = 'PRICE'
      else if (changedFields[0] === 'name') syncType = 'TITLE'
      else if (changedFields[0] === 'description') syncType = 'DESCRIPTION'
    }

    // Queue sync for each channel listing that follows master
    const syncPromises = product.channelListings.map((listing) => {
      const shouldSync =
        (syncType === 'PRICE' && listing.followMasterPrice) ||
        (syncType === 'TITLE' && listing.followMasterTitle) ||
        (syncType === 'DESCRIPTION' && listing.followMasterDescription) ||
        syncType === 'FULL'

      if (shouldSync) {
        return this.queueChannelSync(listing.id, syncType)
      }
    })

    await Promise.all(syncPromises)
  }

  /**
   * Handle cascade sync for child products
   */
  async cascadeSyncToChildren(parentId: string, changedFields: string[]) {
    const children = await prisma.product.findMany({
      where: { parentId },
      include: { channelListings: true },
    })

    // For each child, queue syncs to its channel listings
    const syncPromises = children.flatMap((child) =>
      child.channelListings.map((listing) =>
        this.queueChannelSync(listing.id, 'FULL')
      )
    )

    await Promise.all(syncPromises)
  }
}
```

**Worker**: `channel-sync.worker.ts`

```typescript
import { Worker } from 'bullmq'
import { amazonService } from '../services/marketplaces/amazon.service.js'
import { ebayService } from '../services/marketplaces/ebay.service.js'
import prisma from '../db.js'

export function createChannelSyncWorker(redisConnection: any) {
  return new Worker(
    'channel-sync',
    async (job) => {
      const {
        channelListingId,
        channel,
        syncType,
        masterPrice,
        masterTitle,
        overridePrice,
        overrideTitle,
        followMasterPrice,
        followMasterTitle,
      } = job.data

      try {
        // Update status to SYNCING
        await prisma.channelListing.update({
          where: { id: channelListingId },
          data: { syncStatus: 'SYNCING' },
        })

        // Determine actual values to sync
        const priceToSync = followMasterPrice ? masterPrice : overridePrice
        const titleToSync = followMasterTitle ? masterTitle : overrideTitle

        // Call appropriate marketplace service
        let result
        if (channel === 'AMAZON') {
          result = await amazonService.updateListing({
            channelListingId,
            price: syncType === 'PRICE' || syncType === 'FULL' ? priceToSync : undefined,
            title: syncType === 'TITLE' || syncType === 'FULL' ? titleToSync : undefined,
          })
        } else if (channel === 'EBAY') {
          result = await ebayService.updateListing({
            channelListingId,
            price: syncType === 'PRICE' || syncType === 'FULL' ? priceToSync : undefined,
            title: syncType === 'TITLE' || syncType === 'FULL' ? titleToSync : undefined,
          })
        }

        // Update sync status to IN_SYNC
        await prisma.channelListing.update({
          where: { id: channelListingId },
          data: {
            syncStatus: 'IN_SYNC',
            lastSyncAt: new Date(),
            syncAttempts: 0,
            lastSyncError: null,
          },
        })

        return { success: true, result }
      } catch (error: any) {
        // Update sync status to ERROR
        await prisma.channelListing.update({
          where: { id: channelListingId },
          data: {
            syncStatus: 'ERROR',
            lastSyncError: error.message,
            syncAttempts: (job.attemptsMade || 0) + 1,
          },
        })

        throw error
      }
    },
    { connection: redisConnection }
  )
}
```

---

### Phase 20.6: Add Validation State Icons to Tabs

**Component**: `TabValidationIcon.tsx`

```typescript
interface TabValidationIconProps {
  status: 'valid' | 'warning' | 'error'
  errorCount?: number
  tooltipText?: string
}

export function TabValidationIcon({
  status,
  errorCount = 0,
  tooltipText,
}: TabValidationIconProps) {
  const icons = {
    valid: { icon: '✓', color: 'text-green-600', bg: 'bg-green-50' },
    warning: { icon: '⚠', color: 'text-yellow-600', bg: 'bg-yellow-50' },
    error: { icon: '✕', color: 'text-red-600', bg: 'bg-red-50' },
  }

  const { icon, color, bg } = icons[status]

  return (
    <div
      className={`inline-flex items-center gap-1 px-2 py-1 rounded ${bg}`}
      title={tooltipText}
    >
      <span className={`text-sm font-bold ${color}`}>{icon}</span>
      {errorCount > 0 && <span className={`text-xs ${color}`}>{errorCount}</span>}
    </div>
  )
}
```

**Usage in Tab Navigation**:

```typescript
// In ProductEditorForm.tsx
const tabs = [
  {
    id: 'vital-info',
    label: 'Vital Info',
    icon: '📋',
    validationStatus: getTabValidationStatus('vital-info'),
  },
  {
    id: 'offer',
    label: 'Offer',
    icon: '💰',
    validationStatus: getTabValidationStatus('offer'),
  },
  {
    id: 'master-catalog',
    label: 'Master Catalog',
    icon: '🔗',
    validationStatus: getTabValidationStatus('master-catalog'),
  },
  {
    id: 'channel-overrides',
    label: 'Channel Overrides',
    icon: '🌐',
    validationStatus: getTabValidationStatus('channel-overrides'),
  },
]

// Render with validation icon
{tabs.map((tab) => (
  <button key={tab.id} className="flex items-center gap-2">
    <span>{tab.icon}</span>
    <span>{tab.label}</span>
    <TabValidationIcon status={tab.validationStatus} />
  </button>
))}
```

---

### Phase 20.7: Implement Cascade Logic for Price/Stock Updates

**API Endpoint**: `PATCH /api/products/:id` (Enhanced)

```typescript
app.patch<{
  Params: { id: string }
  Body: {
    basePrice?: number
    totalStock?: number
    name?: string
    description?: string
    cascadeToChildren?: boolean
    cascadeToChannels?: boolean
  }
}>('/products/:id', async (request, reply) => {
  try {
    const { id } = request.params
    const {
      basePrice,
      totalStock,
      name,
      description,
      cascadeToChildren = true,
      cascadeToChannels = true,
    } = request.body

    // Find product
    const product = await prisma.product.findUnique({
      where: { id },
      include: {
        children: { select: { id: true } },
        channelListings: true,
      },
    })

    if (!product) {
      return reply.status(404).send({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Product not found' },
      })
    }

    // Track changed fields
    const changedFields: string[] = []
    if (basePrice !== undefined && basePrice !== product.basePrice.toNumber())
      changedFields.push('basePrice')
    if (totalStock !== undefined && totalStock !== product.totalStock)
      changedFields.push('totalStock')
    if (name !== undefined && name !== product.name) changedFields.push('name')
    if (description !== undefined && description !== product.description)
      changedFields.push('description')

    // Update master product
    const updatedProduct = await prisma.product.update({
      where: { id },
      data: {
        ...(basePrice !== undefined && { basePrice }),
        ...(totalStock !== undefined && { totalStock }),
        ...(name !== undefined && { name }),
        ...(description !== undefined && { description }),
      },
    })

    // Cascade to children if enabled
    if (cascadeToChildren && product.isParent && product.children.length > 0) {
      await prisma.product.updateMany({
        where: { parentId: id },
        data: {
          ...(basePrice !== undefined && { basePrice }),
          ...(totalStock !== undefined && { totalStock }),
        },
      })
    }

    // Cascade to channels if enabled
    if (cascadeToChannels && changedFields.length > 0) {
      const channelSyncService = new ChannelSyncService(redisConnection)
      await channelSyncService.cascadeSyncToChannels(id, changedFields)

      // If parent, also cascade to children's channels
      if (product.isParent && product.children.length > 0) {
        await channelSyncService.cascadeSyncToChildren(id, changedFields)
      }
    }

    return reply.send({
      success: true,
      data: updatedProduct,
      cascaded: {
        children: cascadeToChildren ? product.children.length : 0,
        channels: cascadeToChannels ? product.