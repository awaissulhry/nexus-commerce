# Phase 6: Publishing Engine - Full Stack Architecture

## Overview

Phase 6 implements a complete eBay publishing system that transforms AI-generated draft listings into live eBay listings. The system handles the entire publishing workflow: validation, eBay API integration, database updates, and UI feedback.

## System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Frontend (Next.js)                          │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Generator Page (/listings/generate)                     │  │
│  │  - Product list with generation status                   │  │
│  │  - Preview modal with draft details                      │  │
│  │  - Publish button (NEW)                                  │  │
│  │  - Success/error notifications                           │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                    API Layer (Fastify)                          │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  POST /api/listings/:draftId/publish                     │  │
│  │  - Validate draft exists and is in DRAFT status          │  │
│  │  - Call EbayPublishService                               │  │
│  │  - Update DraftListing status to PUBLISHED               │  │
│  │  - Create VariantChannelListing record                   │  │
│  │  - Return success response with listing details          │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                  Service Layer (TypeScript)                     │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  EbayPublishService (NEW)                                │  │
│  │  - publishDraft(draftId): Promise<PublishResult>         │  │
│  │    1. Fetch draft with product relations                 │  │
│  │    2. Validate draft data                                │  │
│  │    3. Call EbayService.publishNewListing()               │  │
│  │    4. Extract listing ID from response                   │  │
│  │    5. Return publish result with metadata                │  │
│  └──────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  EbayService (EXISTING - Enhanced)                       │  │
│  │  - publishNewListing(): Already implemented              │  │
│  │  - Returns eBay listing ID                               │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                   Database Layer (Prisma)                       │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  DraftListing                                            │  │
│  │  - status: DRAFT → PUBLISHED                             │  │
│  │  - publishedAt: DateTime (set on publish)                │  │
│  └──────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  VariantChannelListing (NEW RECORD)                      │  │
│  │  - Links ProductVariant to eBay listing                  │  │
│  │  - Stores externalListingId (eBay ItemID)                │  │
│  │  - Tracks listing status and sync metadata               │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                   External APIs                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  eBay Selling API                                        │  │
│  │  - POST /sell/inventory/v1/inventory_item/{sku}          │  │
│  │  - POST /sell/inventory/v1/offer                         │  │
│  │  - POST /sell/inventory/v1/offer/{offerId}/publish       │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

## Data Flow: Publishing a Draft

```
User clicks "Publish" button
    ↓
Frontend: POST /api/listings/{draftId}/publish
    ↓
API Endpoint:
  1. Validate draftId exists
  2. Fetch DraftListing with product relations
  3. Check status === "DRAFT"
    ↓
EbayPublishService.publishDraft():
  1. Validate draft has required fields
  2. Call EbayService.publishNewListing()
  3. Receive eBay listing ID
  4. Return { success: true, listingId, ... }
    ↓
API Endpoint (continued):
  1. Update DraftListing:
     - status = "PUBLISHED"
     - publishedAt = now()
  2. Create VariantChannelListing:
     - variantId = product.variants[0].id
     - channel = "EBAY"
     - externalListingId = listingId
     - listingStatus = "ACTIVE"
  3. Return success response
    ↓
Frontend:
  1. Show success notification
  2. Update UI state
  3. Remove from "Ready to Generate" queue
  4. Close preview modal
```

## Implementation Details

### 1. EbayPublishService

**File:** `apps/api/src/services/ebay-publish.service.ts`

```typescript
interface PublishResult {
  success: boolean
  draftId: string
  productId: string
  listingId: string
  listingUrl: string
  publishedAt: string
  message: string
}

interface PublishError {
  code: string
  message: string
  details?: Record<string, any>
}

export class EbayPublishService {
  constructor(
    private ebayService: EbayService,
    private prisma: PrismaClient
  ) {}

  async publishDraft(draftId: string): Promise<PublishResult> {
    // 1. Fetch draft with product relations
    const draft = await this.fetchDraftWithRelations(draftId)
    
    // 2. Validate draft data
    this.validateDraftData(draft)
    
    // 3. Call eBay API to publish
    const listingId = await this.ebayService.publishNewListing(
      draft.product.sku,
      {
        ebayTitle: draft.ebayTitle,
        categoryId: draft.categoryId,
        itemSpecifics: draft.itemSpecifics,
        htmlDescription: draft.htmlDescription,
      },
      draft.product.basePrice,
      draft.product.totalStock
    )
    
    // 4. Return result
    return {
      success: true,
      draftId,
      productId: draft.productId,
      listingId,
      listingUrl: `https://www.ebay.com/itm/${listingId}`,
      publishedAt: new Date().toISOString(),
      message: 'Listing published successfully',
    }
  }

  private async fetchDraftWithRelations(draftId: string) {
    const draft = await this.prisma.draftListing.findUnique({
      where: { id: draftId },
      include: {
        product: {
          include: {
            variations: true,
            images: true,
          },
        },
      },
    })

    if (!draft) {
      throw new Error(`Draft not found: ${draftId}`)
    }

    return draft
  }

  private validateDraftData(draft: any) {
    if (draft.status !== 'DRAFT') {
      throw new Error(`Draft is not in DRAFT status: ${draft.status}`)
    }

    if (!draft.ebayTitle || draft.ebayTitle.length === 0) {
      throw new Error('Draft missing required field: ebayTitle')
    }

    if (!draft.categoryId || draft.categoryId.length === 0) {
      throw new Error('Draft missing required field: categoryId')
    }

    if (!draft.htmlDescription || draft.htmlDescription.length === 0) {
      throw new Error('Draft missing required field: htmlDescription')
    }

    if (!draft.product) {
      throw new Error('Product not found for draft')
    }

    if (!draft.product.sku) {
      throw new Error('Product missing SKU')
    }
  }
}
```

### 2. API Endpoint

**File:** `apps/api/src/routes/listings.ts` (add to existing file)

```typescript
// POST /api/listings/:draftId/publish
app.post<{ Params: { draftId: string } }>(
  '/listings/:draftId/publish',
  async (request, reply) => {
    try {
      const { draftId } = request.params

      // Validate request
      if (!draftId || typeof draftId !== 'string') {
        return reply.status(400).send({
          success: false,
          error: {
            code: 'INVALID_REQUEST',
            message: 'draftId is required and must be a string',
          },
        })
      }

      // Initialize services
      const ebayService = new EbayService()
      const ebayPublishService = new EbayPublishService(
        ebayService,
        prisma
      )

      // Publish the draft
      const publishResult = await ebayPublishService.publishDraft(draftId)

      // Update DraftListing status
      await prisma.draftListing.update({
        where: { id: draftId },
        data: {
          status: 'PUBLISHED',
          publishedAt: new Date(),
        },
      })

      // Fetch the draft to get product and variant info
      const draft = await prisma.draftListing.findUnique({
        where: { id: draftId },
        include: {
          product: {
            include: {
              variations: true,
            },
          },
        },
      })

      // Create VariantChannelListing record
      if (draft && draft.product.variations.length > 0) {
        const variant = draft.product.variations[0]
        
        await prisma.variantChannelListing.upsert({
          where: {
            variantId_channelId: {
              variantId: variant.id,
              channelId: 'EBAY', // or use channelConnectionId if available
            },
          },
          update: {
            externalListingId: publishResult.listingId,
            listingStatus: 'ACTIVE',
            listingUrl: publishResult.listingUrl,
            lastSyncedAt: new Date(),
            lastSyncStatus: 'SUCCESS',
          },
          create: {
            variantId: variant.id,
            channel: 'EBAY',
            channelSku: draft.product.sku,
            externalListingId: publishResult.listingId,
            externalSku: draft.product.sku,
            channelPrice: draft.product.basePrice,
            channelQuantity: draft.product.totalStock,
            listingStatus: 'ACTIVE',
            listingUrl: publishResult.listingUrl,
            lastSyncedAt: new Date(),
            lastSyncStatus: 'SUCCESS',
          },
        })
      }

      return reply.status(200).send({
        success: true,
        data: publishResult,
      })
    } catch (error: any) {
      const message = error?.message ?? 'Unknown error'

      // Handle specific error cases
      if (message.includes('Draft not found')) {
        request.log.warn(error, 'Draft not found')
        return reply.status(404).send({
          success: false,
          error: {
            code: 'DRAFT_NOT_FOUND',
            message: 'Draft not found',
            details: { draftId: request.params.draftId },
          },
        })
      }

      if (message.includes('not in DRAFT status')) {
        request.log.warn(error, 'Draft already published')
        return reply.status(409).send({
          success: false,
          error: {
            code: 'DRAFT_ALREADY_PUBLISHED',
            message: 'Draft has already been published',
            details: { draftId: request.params.draftId },
          },
        })
      }

      if (message.includes('missing required field')) {
        request.log.warn(error, 'Invalid draft data')
        return reply.status(400).send({
          success: false,
          error: {
            code: 'INVALID_DRAFT_DATA',
            message: message,
            details: { draftId: request.params.draftId },
          },
        })
      }

      // eBay API errors
      if (message.includes('eBay')) {
        request.log.error(error, 'eBay API error')
        return reply.status(502).send({
          success: false,
          error: {
            code: 'EBAY_API_ERROR',
            message: 'Failed to publish to eBay',
            details: { error: message },
          },
        })
      }

      // Generic error handling
      request.log.error(error, 'Failed to publish draft')
      return reply.status(500).send({
        success: false,
        error: {
          code: 'PUBLISH_FAILED',
          message: 'Failed to publish draft',
          details: { error: message },
        },
      })
    }
  }
)
```

### 3. Frontend UI Updates

**File:** `apps/web/src/app/listings/generate/page.tsx`

Key changes:
1. Add `handlePublishDraft()` function
2. Update modal footer with publish button
3. Add loading state for publish operation
4. Update notification system for publish feedback
5. Remove published items from queue

```typescript
const handlePublishDraft = async (draftId: string) => {
  setGenerationState((prev) => ({
    ...prev,
    [selectedDraft!.productId]: {
      ...prev[selectedDraft!.productId],
      publishing: true,
    },
  }))

  try {
    const response = await fetch(`/api/listings/${draftId}/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })

    const result = await response.json()

    if (!response.ok) {
      throw new Error(result.error?.message || 'Failed to publish listing')
    }

    // Success
    showNotification('success', 'Listing published to eBay successfully!')
    
    // Update state to remove from queue
    setGenerationState((prev) => {
      const newState = { ...prev }
      delete newState[selectedDraft!.productId]
      return newState
    })

    // Close modal
    setShowPreviewModal(false)
    setSelectedDraft(null)
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error'
    
    showNotification('error', errorMessage)
    
    setGenerationState((prev) => ({
      ...prev,
      [selectedDraft!.productId]: {
        ...prev[selectedDraft!.productId],
        publishing: false,
        publishError: errorMessage,
      },
    }))
  }
}
```

## Database Schema Updates

### DraftListing (Already exists, no changes needed)
```prisma
model DraftListing {
  id                String   @id @default(cuid())
  product           Product  @relation(fields: [productId], references: [id], onDelete: Cascade)
  productId         String
  ebayTitle         String
  categoryId        String
  itemSpecifics     Json
  htmlDescription   String
  status            String   @default("DRAFT") // DRAFT, PUBLISHED, ARCHIVED
  publishedAt       DateTime? // Set when published
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt
  
  @@index([productId])
  @@index([status])
  @@index([createdAt])
}
```

### VariantChannelListing (Already exists, will be populated)
```prisma
model VariantChannelListing {
  id                  String           @id @default(cuid())
  variant             ProductVariation @relation(fields: [variantId], references: [id], onDelete: Cascade)
  variantId           String
  channelId           String?
  channelConnection   ChannelConnection? @relation(fields: [channelConnectionId], references: [id], onDelete: Cascade)
  channelConnectionId String?
  channel             String? // "EBAY"
  channelSku          String?
  channelProductId    String?
  externalListingId   String? // eBay ItemID
  externalSku         String?
  channelPrice        Decimal          @db.Decimal(10, 2)
  channelQuantity     Int              @default(0)
  currentPrice        Decimal?         @db.Decimal(10, 2)
  quantity            Int?
  quantitySold        Int              @default(0)
  channelCategoryId   String?
  listingStatus       String           @default("PENDING") // ACTIVE, INACTIVE, etc.
  listingUrl          String?
  channelSpecificData Json?
  lastSyncedAt        DateTime?
  lastSyncStatus      String?
  syncRetryCount      Int              @default(0)
  lastSyncError       String?
  
  @@unique([variantId, channelId])
  @@index([variantId])
  @@index([channelId])
  @@index([channelConnectionId])
  @@index([externalListingId])
}
```

## Error Handling Strategy

### Frontend Errors
- **Network errors**: Show "Connection failed" notification
- **Validation errors** (400): Show specific field error message
- **Not found** (404): Show "Draft not found" message
- **Conflict** (409): Show "Draft already published" message
- **Server errors** (500): Show "Publishing failed, please try again"

### Backend Errors
- **Missing draft**: Return 404 with DRAFT_NOT_FOUND code
- **Invalid status**: Return 409 with DRAFT_ALREADY_PUBLISHED code
- **Invalid data**: Return 400 with INVALID_DRAFT_DATA code
- **eBay API failure**: Return 502 with EBAY_API_ERROR code
- **Database errors**: Return 500 with PUBLISH_FAILED code

## Testing Strategy

### Unit Tests
- `EbayPublishService.publishDraft()` with valid draft
- `EbayPublishService.publishDraft()` with missing fields
- `EbayPublishService.publishDraft()` with non-DRAFT status
- Error handling for each validation case

### Integration Tests
- Full publish workflow: draft → eBay → database update
- VariantChannelListing creation
- DraftListing status update
- API endpoint with various error scenarios

### Manual Testing
1. Generate a listing draft
2. Open preview modal
3. Click "Publish" button
4. Verify success notification
5. Check database for PUBLISHED status
6. Verify VariantChannelListing record created
7. Verify item removed from queue

## Success Criteria

✅ EbayPublishService created with proper error handling
✅ POST /api/listings/:draftId/publish endpoint implemented
✅ DraftListing status updated to PUBLISHED with timestamp
✅ VariantChannelListing record created with eBay listing ID
✅ Frontend publish button functional with loading states
✅ Success/error notifications displayed correctly
✅ Published items removed from "Ready to Generate" queue
✅ Full workflow tested end-to-end

## Dependencies

- **EbayService**: Already exists, provides `publishNewListing()` method
- **Prisma Client**: For database operations
- **Fastify**: For API routing
- **React Hooks**: For frontend state management

## Files to Create/Modify

### Create
- `apps/api/src/services/ebay-publish.service.ts` (NEW)

### Modify
- `apps/api/src/routes/listings.ts` (add publish endpoint)
- `apps/web/src/app/listings/generate/page.tsx` (add publish button and handler)

## Timeline & Execution Order

1. Create EbayPublishService
2. Add publish endpoint to listings routes
3. Update generator UI with publish button
4. Implement success/error notifications
5. Add loading states and error handling
6. Test full publishing workflow

