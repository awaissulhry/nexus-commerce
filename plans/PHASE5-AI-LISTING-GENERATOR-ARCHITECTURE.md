# Phase 5: AI Listing Generator - Full Stack Architecture

## Overview

This document outlines the complete architecture for the AI-powered eBay listing generator that transforms Amazon product data into optimized eBay listings using LLM (Gemini API).

**Goal**: Enable sellers to generate draft eBay listings from Amazon products with AI-optimized titles, descriptions, and item specifics before publishing.

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Frontend (Next.js)                        │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Generator Page (/listings/generate)                     │   │
│  │  • Product list with search/filter                       │   │
│  │  • Generate button (triggers AI)                         │   │
│  │  • Preview modal (shows AI-generated content)            │   │
│  │  • Publish/Save draft actions                            │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              ↓ HTTP
┌─────────────────────────────────────────────────────────────────┐
│                      Backend API (Fastify)                       │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  POST /api/listings/generate                             │   │
│  │  • Fetch product data (with variations, images)          │   │
│  │  • Call AI Listing Service                               │   │
│  │  • Store draft in DraftListing table                      │   │
│  │  • Return generated content for preview                  │   │
│  └──────────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  AI Listing Service (ai-listing.service.ts)              │   │
│  │  • Fetch product with relations (variations, images)     │   │
│  │  • Format data for Gemini prompt                         │   │
│  │  • Call Gemini API (generateEbayListingData)             │   │
│  │  • Parse and validate response                           │   │
│  │  • Return structured eBay listing data                   │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                    External Services                             │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Google Gemini API (generateEbayListingData)             │   │
│  │  • Generates eBay-optimized titles (max 80 chars)        │   │
│  │  • Creates mobile-responsive HTML descriptions          │   │
│  │  • Extracts item specifics from product data             │   │
│  │  • Suggests eBay category ID                             │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                    Database (PostgreSQL)                         │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  DraftListing (NEW)                                      │   │
│  │  • id, productId, ebayTitle, categoryId                  │   │
│  │  • itemSpecifics (JSON), htmlDescription                 │   │
│  │  • status (DRAFT, PUBLISHED, ARCHIVED)                   │   │
│  │  • createdAt, updatedAt, publishedAt                     │   │
│  └──────────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Product (existing)                                      │   │
│  │  • Used to fetch source data for AI generation           │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

---

## Database Schema Changes

### New Model: DraftListing

```prisma
model DraftListing {
  id                String   @id @default(cuid())
  
  // Product Reference
  product           Product  @relation(fields: [productId], references: [id], onDelete: Cascade)
  productId         String
  
  // AI-Generated Content
  ebayTitle         String   // Max 80 chars (eBay limit)
  categoryId        String   // eBay category ID
  itemSpecifics     Json     // { "Brand": "Sony", "Color": "Black", ... }
  htmlDescription   String   // Mobile-responsive HTML (max 4000 chars)
  
  // Status & Metadata
  status            String   @default("DRAFT") // DRAFT, PUBLISHED, ARCHIVED
  publishedAt       DateTime? // When listing was published to eBay
  
  // Audit Trail
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt
  
  @@index([productId])
  @@index([status])
  @@index([createdAt])
}
```

**Relation Update**: Add to Product model:
```prisma
draftListings    DraftListing[]
```

---

## API Endpoint Specification

### POST /api/listings/generate

**Purpose**: Generate an AI-optimized eBay listing draft from a product

**Request**:
```typescript
{
  productId: string;  // Product to generate listing for
  regenerate?: boolean; // If true, overwrite existing draft (default: false)
}
```

**Response** (Success - 200):
```typescript
{
  success: true;
  data: {
    draftListingId: string;
    productId: string;
    productName: string;
    productSku: string;
    ebayTitle: string;
    categoryId: string;
    itemSpecifics: Record<string, string>;
    htmlDescription: string;
    status: "DRAFT";
    createdAt: string;
  };
}
```

**Response** (Error - 400/500):
```typescript
{
  success: false;
  error: {
    code: string;
    message: string;
    details?: Record<string, any>;
  };
}
```

**Error Cases**:
- `PRODUCT_NOT_FOUND` (404): Product doesn't exist
- `DRAFT_EXISTS` (409): Draft already exists (unless regenerate=true)
- `AI_GENERATION_FAILED` (500): Gemini API call failed
- `INVALID_PRODUCT_DATA` (400): Product missing required fields for AI generation

---

## Service Layer: AI Listing Service

**File**: `apps/api/src/services/ai/ai-listing.service.ts`

### Class: AiListingService

```typescript
export class AiListingService {
  constructor(
    private geminiService: GeminiService,
    private prisma: PrismaClient
  ) {}

  /**
   * Generate an eBay listing draft from a product
   * 
   * Flow:
   * 1. Fetch product with relations (variations, images)
   * 2. Validate product has required data
   * 3. Check if draft already exists
   * 4. Call Gemini to generate eBay listing
   * 5. Store draft in database
   * 6. Return generated content
   */
  async generateListingDraft(
    productId: string,
    regenerate: boolean = false
  ): Promise<DraftListingResponse>

  /**
   * Fetch product with all relations needed for AI generation
   */
  private async fetchProductForGeneration(
    productId: string
  ): Promise<ProductWithRelations>

  /**
   * Validate product has minimum required data
   */
  private validateProductData(product: ProductWithRelations): void

  /**
   * Check if draft already exists
   */
  private async checkExistingDraft(
    productId: string
  ): Promise<DraftListing | null>

  /**
   * Store generated listing as draft
   */
  private async storeDraft(
    productId: string,
    generatedData: EbayListingData
  ): Promise<DraftListing>

  /**
   * Format response for API
   */
  private formatResponse(
    draft: DraftListing,
    product: ProductWithRelations
  ): DraftListingResponse
}
```

### Key Methods

#### generateListingDraft()
- Orchestrates the entire generation flow
- Handles regeneration logic (delete old draft if regenerate=true)
- Catches and logs errors
- Returns structured response

#### fetchProductForGeneration()
- Queries product with eager-loaded relations:
  - `variations` (with pricing, stock)
  - `images` (product images)
  - `bulletPoints`, `keywords`, `brand`, `manufacturer`
- Throws error if product not found

#### validateProductData()
- Ensures product has:
  - `name` (for title generation)
  - `basePrice` (for pricing context)
  - At least one image (for visual context)
  - Either bullet points or description content
- Throws `INVALID_PRODUCT_DATA` if validation fails

#### storeDraft()
- Creates DraftListing record with:
  - `productId`
  - `ebayTitle`, `categoryId`, `itemSpecifics`, `htmlDescription`
  - `status: "DRAFT"`
  - `createdAt`, `updatedAt`
- Returns created record

---

## Frontend: Generator Page

**File**: `apps/web/src/app/listings/generate/page.tsx`

### Features

1. **Product List Section**
   - Display all active products with search/filter
   - Show SKU, name, base price, stock
   - Status badge (DRAFT, NO_DRAFT, GENERATING)
   - Generate button per product

2. **Preview Modal**
   - Shows AI-generated content before saving
   - Displays: title, category, item specifics, HTML description
   - Edit capability (optional for Phase 5)
   - Save/Publish/Cancel actions

3. **State Management**
   - Loading states during AI generation
   - Error handling with user-friendly messages
   - Success notifications
   - Draft status tracking

### Component Structure

```
GeneratorPage
├── ProductListSection
│   ├── SearchBar
│   ├── FilterBar
│   └── ProductTable
│       └── ProductRow (with Generate button)
├── PreviewModal
│   ├── TitlePreview
│   ├── CategoryPreview
│   ├── ItemSpecificsPreview
│   ├── DescriptionPreview
│   └── ActionButtons
└── Toast/Notification System
```

### User Flow

1. User navigates to `/listings/generate`
2. Page loads list of products
3. User clicks "Generate" on a product
4. Loading spinner appears
5. API calls POST /api/listings/generate
6. Preview modal opens with AI-generated content
7. User can:
   - **Save Draft**: Stores in database (status: DRAFT)
   - **Publish**: Publishes to eBay (status: PUBLISHED) [Phase 6]
   - **Cancel**: Closes modal without saving
8. Product list updates with new status

---

## Data Flow Diagram

```
User clicks "Generate"
        ↓
POST /api/listings/generate { productId }
        ↓
AiListingService.generateListingDraft()
        ↓
Fetch Product with relations
        ↓
Validate product data
        ↓
Check existing draft
        ↓
Call GeminiService.generateEbayListingData()
        ↓
Gemini API returns:
  - ebayTitle (80 chars max)
  - categoryId
  - itemSpecifics (JSON)
  - htmlDescription (4000 chars max)
        ↓
Store DraftListing in database
        ↓
Return response to frontend
        ↓
Preview modal displays content
        ↓
User saves/publishes
        ↓
Update DraftListing status
```

---

## Implementation Checklist

### Phase 5.1: Database Schema
- [ ] Add DraftListing model to Prisma schema
- [ ] Add draftListings relation to Product model
- [ ] Run `npx prisma db push` to apply migration
- [ ] Verify migration in database

### Phase 5.2: Backend Service
- [ ] Create `ai-listing.service.ts`
- [ ] Implement AiListingService class
- [ ] Implement all methods with error handling
- [ ] Add TypeScript interfaces for responses
- [ ] Add logging for debugging

### Phase 5.3: API Endpoint
- [ ] Add POST /api/listings/generate to listings.ts
- [ ] Implement request validation
- [ ] Implement error handling
- [ ] Add response formatting
- [ ] Test with curl/Postman

### Phase 5.4: Frontend UI
- [ ] Create `/listings/generate/page.tsx`
- [ ] Build ProductListSection component
- [ ] Build PreviewModal component
- [ ] Implement API integration
- [ ] Add loading/error states
- [ ] Add success notifications

### Phase 5.5: Testing
- [ ] Test with sample products
- [ ] Verify AI generation quality
- [ ] Test error scenarios
- [ ] Test draft persistence
- [ ] Test UI responsiveness

---

## Error Handling Strategy

### Backend Errors

| Error | Status | Message | Action |
|-------|--------|---------|--------|
| Product not found | 404 | "Product not found" | Return error |
| Draft exists | 409 | "Draft already exists for this product" | Return error (unless regenerate=true) |
| Invalid product data | 400 | "Product missing required fields" | Return error with details |
| Gemini API error | 500 | "Failed to generate listing" | Log error, return error |
| Database error | 500 | "Failed to save draft" | Log error, return error |

### Frontend Errors

- Display toast notifications for errors
- Show retry button for transient errors
- Log errors to console for debugging
- Graceful degradation (show form even if generation fails)

---

## Performance Considerations

1. **AI Generation Time**: Gemini API calls typically take 2-5 seconds
   - Show loading spinner during generation
   - Disable button to prevent duplicate requests

2. **Database Queries**:
   - Use eager loading for product relations
   - Index on `productId` and `status` for fast lookups

3. **Frontend Optimization**:
   - Lazy load preview modal
   - Paginate product list (50 items per page)
   - Debounce search input

---

## Security Considerations

1. **Input Validation**:
   - Validate productId is valid UUID/CUID
   - Validate regenerate is boolean
   - Sanitize HTML description before storing

2. **Authorization**:
   - Ensure user owns the product (Phase 6)
   - Rate limit AI generation (prevent abuse)

3. **Data Privacy**:
   - Don't log sensitive product data
   - Encrypt HTML descriptions if needed

---

## Future Enhancements (Phase 6+)

1. **Listing Publishing**:
   - Publish draft directly to eBay
   - Update VariantChannelListing with eBay ItemID

2. **Draft Management**:
   - View all drafts
   - Edit draft before publishing
   - Archive old drafts
   - Bulk generate for multiple products

3. **AI Improvements**:
   - Support for OpenAI API (fallback)
   - Custom prompt templates
   - A/B testing different prompts
   - Feedback loop to improve generations

4. **Analytics**:
   - Track generation success rate
   - Monitor Gemini API costs
   - Measure listing performance (CTR, conversions)

---

## Environment Variables Required

```bash
# .env (Backend)
GEMINI_API_KEY=your_gemini_api_key

# .env.local (Frontend)
NEXT_PUBLIC_API_URL=http://localhost:3001
```

---

## Testing Strategy

### Unit Tests
- Test AiListingService methods
- Test validation logic
- Test error handling

### Integration Tests
- Test full flow: product → AI generation → draft storage
- Test with real Gemini API (or mock)
- Test database persistence

### E2E Tests
- Test complete user flow in UI
- Test preview modal functionality
- Test save/publish actions

---

## Success Criteria

✅ DraftListing model created and migrated
✅ AI Listing Service generates valid eBay listings
✅ API endpoint returns correct response format
✅ Frontend displays product list and preview modal
✅ Drafts persist in database
✅ Error handling works for all scenarios
✅ UI is responsive and user-friendly
✅ AI-generated content is high quality

---

## Timeline & Dependencies

- **Depends on**: Phase 1 (Product schema), Gemini API setup
- **Blocks**: Phase 6 (Publishing to eBay)
- **Estimated effort**: 2-3 days for full implementation

---

## References

- [Gemini Service](apps/api/src/services/ai/gemini.service.ts) - Existing AI integration
- [Listings Routes](apps/api/src/routes/listings.ts) - Existing endpoint patterns
- [Prisma Schema](packages/database/prisma/schema.prisma) - Database models
- [Frontend Patterns](apps/web/src/app/listings/page.tsx) - UI component examples
