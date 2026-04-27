# Phase 31: Visual Engine - Architecture Documentation

## System Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     Frontend Layer (Next.js)                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Product Images Page (/catalog/[id]/images)             │   │
│  │  - Main entry point for image management                │   │
│  │  - Integrates ImageGallery component                    │   │
│  │  - Handles page-level state and routing                 │   │
│  └──────────────────────────────────────────────────────────┘   │
│                              ↓                                    │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  ImageGallery Component                                  │   │
│  │  - Drag-and-drop upload interface                        │   │
│  │  - Image preview and management                          │   │
│  │  - Color picker and hero toggle                          │   │
│  │  - Variant assignment display                            │   │
│  └──────────────────────────────────────────────────────────┘   │
│                              ↓                                    │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  useImageManagement Hook                                 │   │
│  │  - State management (images, loading, error)             │   │
│  │  - API integration                                       │   │
│  │  - Error handling and loading states                     │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
                              ↓ HTTP
┌─────────────────────────────────────────────────────────────────┐
│                     API Layer (Express.js)                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Image Routes (/api/images/*)                            │   │
│  │  - POST /upload - Upload image                           │   │
│  │  - GET /:productId - Get product images                  │   │
│  │  - PUT /:imageId/hero - Set hero image                   │   │
│  │  - PUT /:imageId/color - Update color override           │   │
│  │  - DELETE /:imageId - Delete image                       │   │
│  │  - POST /:productId/auto-assign - Auto-assign variants   │   │
│  │  - POST /:imageId/assign-variants - Manual assignment    │   │
│  │  - GET /:imageId/assigned-variants - Get assignments     │   │
│  │  - GET /:productId/by-color/:color - Filter by color     │   │
│  │  - POST /analyze-color - Analyze image color             │   │
│  └──────────────────────────────────────────────────────────┘   │
│                              ↓                                    │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  ImageService                                            │   │
│  │  - uploadImage() - Upload and create record              │   │
│  │  - getProductImages() - Fetch all images                 │   │
│  │  - setHeroImage() - Set primary image                    │   │
│  │  - updateColorOverride() - Manual color override         │   │
│  │  - deleteImage() - Remove image                          │   │
│  │  - getImagesByColor() - Filter by color                  │   │
│  └──────────────────────────────────────────────────────────┘   │
│                              ↓                                    │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  AutoAssignImages                                        │   │
│  │  - assignImagesToVariants() - Auto-assign by color       │   │
│  │  - assignImageToVariants() - Manual assignment           │   │
│  │  - getAssignedVariants() - Get variant assignments       │   │
│  └──────────────────────────────────────────────────────────┘   │
│                              ↓                                    │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  ColorAnalyzer                                           │   │
│  │  - extractDominantColor() - Detect color from image      │   │
│  │  - colorNameFromHex() - Convert hex to name              │   │
│  │  - calculateColorSimilarity() - Compare colors           │   │
│  └──────────────────────────────────────────────────────────┘   │
│                              ↓                                    │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  MockCloudStorage                                        │   │
│  │  - initialize() - Setup storage                          │   │
│  │  - uploadImage() - Upload to storage                     │   │
│  │  - deleteImage() - Remove from storage                   │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
                              ↓ SQL
┌─────────────────────────────────────────────────────────────────┐
│                   Data Layer (PostgreSQL)                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Image Table                                             │   │
│  │  - id (PK)                                               │   │
│  │  - productId (FK)                                        │   │
│  │  - url, alt, type, sortOrder                             │   │
│  │  - dominantColor, colorConfidence                        │   │
│  │  - assignedVariants (array)                              │   │
│  │  - colorOverride, isHero                                 │   │
│  │  - storageMetadata, uploadStatus                         │   │
│  │  - platformMetadata                                      │   │
│  │  - createdAt, updatedAt                                  │   │
│  └──────────────────────────────────────────────────────────┘   │
│                              ↑                                    │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Product Table (existing)                                │   │
│  │  - cloudImages relation (new)                            │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
```

## Data Flow Diagrams

### Image Upload Flow
```
User Upload
    ↓
[ImageGallery] Drag-and-drop
    ↓
[useImageManagement] uploadImage()
    ↓
[API] POST /api/images/upload
    ↓
[ImageService] uploadImage()
    ├─→ [ColorAnalyzer] extractDominantColor()
    ├─→ [MockCloudStorage] uploadImage()
    └─→ [Prisma] Image.create()
    ↓
Return Image with metadata
    ↓
[useImageManagement] Update local state
    ↓
[ImageGallery] Display image with color tag
```

### Auto-Assignment Flow
```
User clicks "Auto-Assign"
    ↓
[ImageGallery] onAutoAssign()
    ↓
[useImageManagement] autoAssignImages()
    ↓
[API] POST /api/images/:productId/auto-assign
    ↓
[AutoAssignImages] assignImagesToVariants()
    ├─→ Get product with variations
    ├─→ For each image:
    │   ├─→ Get image color
    │   ├─→ For each variation:
    │   │   ├─→ Get variant color attribute
    │   │   ├─→ [ColorAnalyzer] calculateColorSimilarity()
    │   │   └─→ If similarity > 70%: add to matches
    │   └─→ [Prisma] Image.update() with assignedVariants
    └─→ Return assignment results
    ↓
[useImageManagement] Refresh images
    ↓
[ImageGallery] Display updated assignments
```

### Color Override Flow
```
User clicks color picker
    ↓
[ImageGallery] Show color palette
    ↓
User selects color
    ↓
[ImageGallery] onColorOverride()
    ↓
[useImageManagement] updateColorOverride()
    ↓
[API] PUT /api/images/:imageId/color
    ↓
[ImageService] updateColorOverride()
    ├─→ [Prisma] Image.update() with colorOverride
    └─→ Return updated image
    ↓
[useImageManagement] Update local state
    ↓
[ImageGallery] Display new color tag
```

## Component Hierarchy

```
ProductImagesPage
├── Header
│   ├── Title
│   └── Image count + Auto-Assign button
├── Error Alert (conditional)
├── Loading Spinner (conditional)
└── ImageGallery
    ├── Drag-and-drop Zone
    ├── Image Groups
    │   ├── Main Images
    │   │   └── ImageCard (multiple)
    │   │       ├── Image Preview
    │   │       ├── Type Badge
    │   │       ├── Hero Badge (conditional)
    │   │       ├── Color Tag
    │   │       ├── Variant Count
    │   │       ├── Hover Actions
    │   │       │   ├── Set Hero Button
    │   │       │   ├── Color Picker Button
    │   │       │   └── Delete Button
    │   │       └── Color Picker Dropdown (conditional)
    │   ├── Alt Images
    │   │   └── ImageCard (multiple)
    │   ├── Lifestyle Images
    │   │   └── ImageCard (multiple)
    │   └── Swatch Images
    │       └── ImageCard (multiple)
    ├── Empty State (conditional)
    └── Selected Image Details (conditional)
```

## State Management

### useImageManagement Hook State
```typescript
{
  images: ImageData[]           // Array of images
  isLoading: boolean            // Loading state
  error: string | null          // Error message
}
```

### ImageData Structure
```typescript
{
  id: string
  url: string
  alt?: string
  type: 'MAIN' | 'ALT' | 'LIFESTYLE' | 'SWATCH'
  dominantColor?: string        // Hex format
  colorConfidence?: number      // 0-100
  colorOverride?: string        // Color name
  isHero: boolean
  assignedVariants: string[]    // Variant IDs
  uploadStatus: 'PENDING' | 'UPLOADING' | 'SUCCESS' | 'FAILED'
  uploadError?: string
}
```

## API Contract

### Request/Response Examples

#### Upload Image
```
POST /api/images/upload
Content-Type: application/json

Request:
{
  "productId": "prod-123",
  "imageUrl": "data:image/png;base64,...",
  "type": "ALT",
  "alt": "Product image"
}

Response (200):
{
  "success": true,
  "image": {
    "id": "img-456",
    "productId": "prod-123",
    "url": "/uploads/images/products/prod-123/img-456.jpg",
    "type": "ALT",
    "dominantColor": "#FF0000",
    "colorConfidence": 85,
    "uploadStatus": "SUCCESS",
    "isHero": false,
    "assignedVariants": [],
    "createdAt": "2026-04-27T17:38:00Z",
    "updatedAt": "2026-04-27T17:38:00Z"
  }
}
```

#### Auto-Assign Images
```
POST /api/images/prod-123/auto-assign

Response (200):
{
  "success": true,
  "assigned": 3,
  "updated": 2,
  "message": "Assigned 3 images to 2 variants"
}
```

#### Get Product Images
```
GET /api/images/prod-123

Response (200):
{
  "success": true,
  "images": [
    {
      "id": "img-456",
      "productId": "prod-123",
      "url": "...",
      "type": "MAIN",
      "dominantColor": "#FF0000",
      "colorConfidence": 85,
      "isHero": true,
      "assignedVariants": ["var-1", "var-2"],
      "uploadStatus": "SUCCESS"
    },
    ...
  ],
  "count": 5
}
```

## Database Schema Details

### Image Table
```sql
CREATE TABLE "Image" (
  id TEXT PRIMARY KEY,
  "productId" TEXT NOT NULL REFERENCES "Product"(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  alt TEXT,
  type TEXT DEFAULT 'ALT',
  "sortOrder" INTEGER DEFAULT 0,
  "dominantColor" TEXT,
  "colorConfidence" INTEGER DEFAULT 0,
  "assignedVariants" TEXT[] DEFAULT '{}',
  "colorOverride" TEXT,
  "isHero" BOOLEAN DEFAULT false,
  "storageMetadata" JSONB,
  "uploadStatus" TEXT DEFAULT 'PENDING',
  "uploadError" TEXT,
  "platformMetadata" JSONB,
  "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "Image_productId_idx" ON "Image"("productId");
CREATE INDEX "Image_dominantColor_idx" ON "Image"("dominantColor");
CREATE INDEX "Image_uploadStatus_idx" ON "Image"("uploadStatus");
```

## Error Handling Strategy

### Frontend Error Handling
```typescript
try {
  await uploadImage(file, type)
} catch (error) {
  setError(error.message)
  // Display error alert to user
  // Log to console for debugging
}
```

### Backend Error Handling
```typescript
try {
  const image = await ImageService.uploadImage(...)
  res.json({ success: true, image })
} catch (error) {
  console.error('Upload error:', error)
  res.status(500).json({
    error: error.message || 'Upload failed'
  })
}
```

### Error Types
- **Validation Errors** (400): Invalid input
- **Not Found Errors** (404): Resource not found
- **Server Errors** (500): Unexpected failures

## Performance Optimization

### Database Optimization
- Indexes on frequently queried columns
- Efficient queries with Prisma
- Pagination for large image lists

### Frontend Optimization
- Lazy loading of images
- Memoization of components
- Efficient state updates
- Debounced API calls

### API Optimization
- Response compression
- Caching headers
- Batch operations support
- Rate limiting ready

## Security Considerations

### Input Validation
- File type validation
- File size limits
- URL validation
- Color name validation

### Data Protection
- SQL injection prevention (Prisma)
- XSS prevention (React escaping)
- CSRF protection (framework level)
- Secure error messages

### Access Control
- Product ownership verification (recommended)
- User authentication (recommended)
- Role-based access (recommended)

## Scalability Considerations

### Horizontal Scaling
- Stateless API design
- Database connection pooling
- CDN for image delivery
- Load balancing ready

### Vertical Scaling
- Efficient algorithms
- Database indexing
- Query optimization
- Memory management

### Data Volume
- Supports 1000+ images per product
- Handles 100+ concurrent uploads
- Efficient pagination
- Archive old images (recommended)

## Monitoring & Logging

### Metrics to Track
- Upload success rate
- Average upload time
- Color detection accuracy
- Auto-assignment success rate
- API response times
- Error rates

### Logging Points
- Image upload start/completion
- Color detection results
- Auto-assignment results
- API errors
- Database operations

## Integration Points

### With Existing Systems
- Prisma ORM
- Express.js framework
- Next.js frontend
- React hooks
- TypeScript types

### With Marketplaces
- Amazon image format
- eBay image structure
- Shopify variant images
- WooCommerce compatibility

## Future Architecture Enhancements

### Phase 32: Real Cloud Storage
```
MockCloudStorage → AWS S3 / GCS / Azure
```

### Phase 33: Advanced Image Processing
```
ColorAnalyzer → ML-based color detection
MockCloudStorage → Image processing pipeline
```

### Phase 34: Image Analytics
```
New ImageAnalytics service
New analytics database tables
Dashboard integration
```

---

**Architecture Version**: 1.0
**Last Updated**: 2026-04-27
**Status**: Production Ready
