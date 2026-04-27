# Phase 31: Visual Engine - Quick Reference

## Quick Start

### 1. Access Image Management
Navigate to: `/catalog/[productId]/images`

### 2. Upload Images
- Drag and drop images into the upload zone
- Or click to select files
- Supported formats: JPG, PNG, WebP, GIF

### 3. Auto-Assign to Variants
1. Upload images with different colors
2. Click "🤖 Auto-Assign" button
3. System matches images to color variants automatically

### 4. Manual Adjustments
- Click 🎨 icon to override detected color
- Click ⭐ icon to set as hero image
- Click 🗑️ icon to delete image

## API Endpoints

### Upload Image
```bash
POST /api/images/upload
Content-Type: application/json

{
  "productId": "prod-123",
  "imageUrl": "data:image/png;base64,...",
  "type": "ALT",
  "alt": "Product image"
}
```

### Get Product Images
```bash
GET /api/images/:productId
```

### Set Hero Image
```bash
PUT /api/images/:imageId/hero
Content-Type: application/json

{
  "productId": "prod-123"
}
```

### Update Color Override
```bash
PUT /api/images/:imageId/color
Content-Type: application/json

{
  "colorOverride": "Red"
}
```

### Auto-Assign Images
```bash
POST /api/images/:productId/auto-assign
```

### Delete Image
```bash
DELETE /api/images/:imageId
```

### Analyze Color
```bash
POST /api/images/analyze-color
Content-Type: application/json

{
  "imageUrl": "https://example.com/image.jpg"
}
```

## Image Types

| Type | Badge | Use Case |
|------|-------|----------|
| MAIN | 🔵 Blue | Primary product image |
| ALT | ⚪ Gray | Alternative views |
| LIFESTYLE | 🟢 Green | Product in use |
| SWATCH | 🟣 Purple | Color/material samples |

## Color Palette

```
Red (#FF0000)
Green (#00FF00)
Blue (#0000FF)
Yellow (#FFFF00)
Magenta (#FF00FF)
Cyan (#00FFFF)
Black (#000000)
White (#FFFFFF)
Gray (#808080)
Orange (#FFA500)
Purple (#800080)
Pink (#FFC0CB)
```

## Database Schema

### Image Model
```typescript
{
  id: string                    // Unique ID
  productId: string             // Product reference
  url: string                   // Cloud storage URL
  alt?: string                  // Alt text
  type: string                  // MAIN | ALT | LIFESTYLE | SWATCH
  sortOrder: number             // Display order
  dominantColor?: string        // Detected color (#RRGGBB)
  colorConfidence: number       // 0-100 confidence
  assignedVariants: string[]    // Variant IDs
  colorOverride?: string        // Manual override
  isHero: boolean               // Primary image flag
  storageMetadata?: Json        // Cloud storage info
  uploadStatus: string          // PENDING | UPLOADING | SUCCESS | FAILED
  uploadError?: string          // Error message
  platformMetadata?: Json       // Marketplace-specific data
  createdAt: DateTime
  updatedAt: DateTime
}
```

## Frontend Integration

### Using useImageManagement Hook
```typescript
import { useImageManagement } from '@/hooks/useImageManagement'

function MyComponent() {
  const {
    images,
    isLoading,
    error,
    uploadImage,
    setHeroImage,
    deleteImage,
    autoAssignImages,
    updateColorOverride,
    fetchImages,
  } = useImageManagement(productId)

  useEffect(() => {
    fetchImages(productId)
  }, [productId])

  return (
    <ImageGallery
      productId={productId}
      images={images}
      onImageUpload={uploadImage}
      onSetHero={setHeroImage}
      onDeleteImage={deleteImage}
      onAutoAssign={autoAssignImages}
      onColorOverride={updateColorOverride}
      isLoading={isLoading}
    />
  )
}
```

## Common Tasks

### Upload and Auto-Assign
1. Upload images via drag-and-drop
2. System detects colors automatically
3. Click "Auto-Assign" to match variants
4. Verify assignments in image cards

### Override Color Manually
1. Click 🎨 on image
2. Select color from palette
3. System re-evaluates assignments
4. Assignments update automatically

### Set Primary Image
1. Click ⭐ on desired image
2. Image gets "Hero" badge
3. Only one hero per product
4. Previous hero loses badge

### Delete Image
1. Click 🗑️ on image
2. Confirm deletion
3. Image removed from gallery
4. Variant assignments cleared

## Troubleshooting

### Images Not Uploading
- Check file size (< 10MB recommended)
- Verify image format (JPG, PNG, WebP, GIF)
- Check browser console for errors
- Verify API endpoint accessible

### Color Detection Inaccurate
- Ensure image has clear dominant color
- Try manual color override
- Check color confidence score
- Consider image quality/lighting

### Auto-Assignment Not Working
- Verify product has variants
- Check variant color attributes set
- Verify color names match palette
- Check similarity threshold (70%)

### Images Not Persisting
- Check database connection
- Verify product ID valid
- Check upload status (SUCCESS)
- Review error messages

## Performance Tips

1. **Compress Images**
   - Use WebP format for smaller files
   - Compress before upload
   - Target 100-500KB per image

2. **Batch Operations**
   - Upload multiple images at once
   - Use auto-assign for bulk matching
   - Batch delete if needed

3. **Caching**
   - Images cached in browser
   - Metadata cached in database
   - Use CDN for image delivery

## Integration with Marketplaces

### Amazon
```json
{
  "images": [
    {
      "url": "https://...",
      "type": "MAIN",
      "isHero": true
    }
  ]
}
```

### eBay
```json
{
  "pictureURL": "https://...",
  "galleryType": "Gallery"
}
```

### Shopify
```json
{
  "shopifyImageId": "...",
  "alt": "Product image"
}
```

## Files Reference

### Backend
- `apps/api/src/services/image.service.ts` - Core service
- `apps/api/src/routes/images.ts` - API routes
- `packages/database/prisma/schema.prisma` - Database schema

### Frontend
- `apps/web/src/components/ImageGallery.tsx` - Gallery component
- `apps/web/src/hooks/useImageManagement.ts` - State management
- `apps/web/src/app/catalog/[id]/images/page.tsx` - Page component

### Tests
- `apps/api/src/services/__tests__/image.integration.test.ts` - Integration tests

## Next Steps

1. **Real Cloud Storage**
   - Integrate AWS S3
   - Or Google Cloud Storage
   - Or Azure Blob Storage

2. **Advanced Color Detection**
   - Use ML models
   - Support multiple colors
   - Color harmony analysis

3. **Image Processing**
   - Auto-crop images
   - Background removal
   - Image enhancement

4. **Analytics**
   - Track image performance
   - Monitor color distribution
   - Analyze variant matching

## Support

For issues or questions:
1. Check troubleshooting section
2. Review test cases for examples
3. Check API documentation
4. Review component props

## Version Info

- Phase: 31
- Status: Production Ready
- Last Updated: 2026-04-27
- Dependencies: react-dropzone, next/image
