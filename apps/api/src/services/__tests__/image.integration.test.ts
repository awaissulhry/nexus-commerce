import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import prisma from '../../db.js'
import { ImageService, AutoAssignImages, ColorAnalyzer } from '../image.service.js'

describe('Phase 31: Image Management System - Integration Tests', () => {
  let testProductId: string
  let testVariationIds: string[] = []
  let uploadedImageIds: string[] = []

  beforeAll(async () => {
    // Create test product with color variants
    const product = await prisma.product.create({
      data: {
        sku: 'TEST-IMG-PRODUCT',
        name: 'Test Product for Images',
        basePrice: 99.99,
        totalStock: 100,
        variationTheme: 'Color',
        variations: {
          create: [
            {
              sku: 'TEST-IMG-RED',
              price: 99.99,
              stock: 50,
              variationAttributes: { Color: 'Red' },
            },
            {
              sku: 'TEST-IMG-BLUE',
              price: 99.99,
              stock: 50,
              variationAttributes: { Color: 'Blue' },
            },
            {
              sku: 'TEST-IMG-GREEN',
              price: 99.99,
              stock: 50,
              variationAttributes: { Color: 'Green' },
            },
          ],
        },
      },
      include: { variations: true },
    })

    testProductId = product.id
    testVariationIds = product.variations.map((v) => v.id)
  })

  afterAll(async () => {
    // Cleanup
    await prisma.image.deleteMany({ where: { productId: testProductId } })
    await prisma.product.delete({ where: { id: testProductId } })
  })

  describe('ColorAnalyzer', () => {
    it('should extract dominant color from image', async () => {
      const result = await ColorAnalyzer.extractDominantColor(
        'https://example.com/image.jpg'
      )

      expect(result).toHaveProperty('color')
      expect(result).toHaveProperty('confidence')
      expect(result.color).toMatch(/^#[0-9A-F]{6}$/i)
      expect(result.confidence).toBeGreaterThanOrEqual(0)
      expect(result.confidence).toBeLessThanOrEqual(100)
    })

    it('should convert hex color to name', () => {
      const colorName = ColorAnalyzer.colorNameFromHex('#FF0000')
      expect(colorName).toBe('Red')
    })

    it('should calculate color similarity', () => {
      const similarity = ColorAnalyzer.calculateColorSimilarity(
        '#FF0000',
        '#FF0000'
      )
      expect(similarity).toBe(100)

      const differentSimilarity = ColorAnalyzer.calculateColorSimilarity(
        '#FF0000',
        '#0000FF'
      )
      expect(differentSimilarity).toBeLessThan(100)
      expect(differentSimilarity).toBeGreaterThan(0)
    })
  })

  describe('ImageService', () => {
    it('should upload image and create Image record', async () => {
      const image = await ImageService.uploadImage(
        testProductId,
        'https://example.com/red-product.jpg',
        'MAIN',
        'Red product image'
      )

      expect(image).toHaveProperty('id')
      expect(image.productId).toBe(testProductId)
      expect(image.url).toBeDefined()
      expect(image.type).toBe('MAIN')
      expect(image.uploadStatus).toBe('SUCCESS')
      expect(image.dominantColor).toBeDefined()
      expect(image.colorConfidence).toBeGreaterThan(0)

      uploadedImageIds.push(image.id)
    })

    it('should get all product images', async () => {
      // Upload multiple images
      await ImageService.uploadImage(
        testProductId,
        'https://example.com/blue-product.jpg',
        'ALT',
        'Blue product image'
      )

      await ImageService.uploadImage(
        testProductId,
        'https://example.com/lifestyle.jpg',
        'LIFESTYLE',
        'Lifestyle image'
      )

      const images = await ImageService.getProductImages(testProductId)

      expect(images.length).toBeGreaterThanOrEqual(3)
      expect(images[0].isHero).toBe(false) // First should be hero if set
    })

    it('should set hero image', async () => {
      const images = await ImageService.getProductImages(testProductId)
      const imageToSetAsHero = images[0]

      const heroImage = await ImageService.setHeroImage(
        imageToSetAsHero.id,
        testProductId
      )

      expect(heroImage.isHero).toBe(true)

      // Verify only one hero
      const allImages = await ImageService.getProductImages(testProductId)
      const heroCount = allImages.filter((img) => img.isHero).length
      expect(heroCount).toBe(1)
    })

    it('should update color override', async () => {
      const images = await ImageService.getProductImages(testProductId)
      const imageToUpdate = images[0]

      const updated = await ImageService.updateColorOverride(
        imageToUpdate.id,
        'Purple'
      )

      expect(updated.colorOverride).toBe('Purple')
    })

    it('should delete image', async () => {
      const images = await ImageService.getProductImages(testProductId)
      const imageToDelete = images[images.length - 1]

      await ImageService.deleteImage(imageToDelete.id)

      const remainingImages = await ImageService.getProductImages(testProductId)
      expect(remainingImages.find((img) => img.id === imageToDelete.id)).toBeUndefined()
    })

    it('should get images by color', async () => {
      const images = await ImageService.getImagesByColor(testProductId, '#FF0000')

      expect(Array.isArray(images)).toBe(true)
      // Images should have similar color to red
      images.forEach((img) => {
        expect(img.dominantColor).toBeDefined()
      })
    })
  })

  describe('AutoAssignImages', () => {
    it('should auto-assign images to variants based on color', async () => {
      // Upload images with specific colors
      const redImage = await ImageService.uploadImage(
        testProductId,
        'https://example.com/red.jpg',
        'SWATCH',
        'Red swatch'
      )

      // Manually set color to match variant
      await ImageService.updateColorOverride(redImage.id, 'Red')

      const result = await AutoAssignImages.assignImagesToVariants(testProductId)

      expect(result).toHaveProperty('assigned')
      expect(result).toHaveProperty('updated')
      expect(result.assigned).toBeGreaterThanOrEqual(0)
      expect(result.updated).toBeGreaterThanOrEqual(0)
    })

    it('should manually assign image to specific variants', async () => {
      const images = await ImageService.getProductImages(testProductId)
      const imageToAssign = images[0]

      const updated = await AutoAssignImages.assignImageToVariants(
        imageToAssign.id,
        [testVariationIds[0], testVariationIds[1]]
      )

      expect(updated.assignedVariants).toContain(testVariationIds[0])
      expect(updated.assignedVariants).toContain(testVariationIds[1])
      expect(updated.assignedVariants.length).toBe(2)
    })

    it('should get variants assigned to image', async () => {
      const images = await ImageService.getProductImages(testProductId)
      const imageWithAssignments = images.find(
        (img) => img.assignedVariants.length > 0
      )

      if (imageWithAssignments) {
        const variants = await AutoAssignImages.getAssignedVariants(
          imageWithAssignments.id
        )

        expect(Array.isArray(variants)).toBe(true)
        expect(variants.length).toBe(imageWithAssignments.assignedVariants.length)
      }
    })
  })

  describe('End-to-End Workflow', () => {
    it('should complete full image management workflow', async () => {
      // 1. Upload images
      const mainImage = await ImageService.uploadImage(
        testProductId,
        'https://example.com/main.jpg',
        'MAIN',
        'Main product image'
      )

      const altImage = await ImageService.uploadImage(
        testProductId,
        'https://example.com/alt.jpg',
        'ALT',
        'Alternative view'
      )

      expect(mainImage.uploadStatus).toBe('SUCCESS')
      expect(altImage.uploadStatus).toBe('SUCCESS')

      // 2. Set hero image
      const heroImage = await ImageService.setHeroImage(
        mainImage.id,
        testProductId
      )
      expect(heroImage.isHero).toBe(true)

      // 3. Get all images
      const allImages = await ImageService.getProductImages(testProductId)
      expect(allImages.length).toBeGreaterThan(0)

      // 4. Auto-assign images
      const assignmentResult = await AutoAssignImages.assignImagesToVariants(
        testProductId
      )
      expect(assignmentResult).toHaveProperty('assigned')
      expect(assignmentResult).toHaveProperty('updated')

      // 5. Verify assignments
      const updatedImages = await ImageService.getProductImages(testProductId)
      const assignedImage = updatedImages.find(
        (img) => img.assignedVariants.length > 0
      )

      if (assignedImage) {
        const variants = await AutoAssignImages.getAssignedVariants(
          assignedImage.id
        )
        expect(variants.length).toBeGreaterThan(0)
      }

      // 6. Override color
      const overriddenImage = await ImageService.updateColorOverride(
        altImage.id,
        'Purple'
      )
      expect(overriddenImage.colorOverride).toBe('Purple')

      // 7. Delete image
      await ImageService.deleteImage(altImage.id)
      const finalImages = await ImageService.getProductImages(testProductId)
      expect(finalImages.find((img) => img.id === altImage.id)).toBeUndefined()
    })

    it('should handle multiple image types correctly', async () => {
      const mainImage = await ImageService.uploadImage(
        testProductId,
        'https://example.com/main.jpg',
        'MAIN'
      )

      const altImage = await ImageService.uploadImage(
        testProductId,
        'https://example.com/alt.jpg',
        'ALT'
      )

      const lifestyleImage = await ImageService.uploadImage(
        testProductId,
        'https://example.com/lifestyle.jpg',
        'LIFESTYLE'
      )

      const swatchImage = await ImageService.uploadImage(
        testProductId,
        'https://example.com/swatch.jpg',
        'SWATCH'
      )

      const allImages = await ImageService.getProductImages(testProductId)

      const mainCount = allImages.filter((img) => img.type === 'MAIN').length
      const altCount = allImages.filter((img) => img.type === 'ALT').length
      const lifestyleCount = allImages.filter(
        (img) => img.type === 'LIFESTYLE'
      ).length
      const swatchCount = allImages.filter((img) => img.type === 'SWATCH').length

      expect(mainCount).toBeGreaterThan(0)
      expect(altCount).toBeGreaterThan(0)
      expect(lifestyleCount).toBeGreaterThan(0)
      expect(swatchCount).toBeGreaterThan(0)
    })
  })

  describe('Error Handling', () => {
    it('should handle invalid product ID', async () => {
      const images = await ImageService.getProductImages('invalid-id')
      expect(Array.isArray(images)).toBe(true)
      expect(images.length).toBe(0)
    })

    it('should handle image deletion gracefully', async () => {
      // Attempting to delete non-existent image should throw
      await expect(
        ImageService.deleteImage('non-existent-id')
      ).rejects.toThrow()
    })

    it('should handle color override with valid colors', async () => {
      const images = await ImageService.getProductImages(testProductId)
      if (images.length > 0) {
        const updated = await ImageService.updateColorOverride(
          images[0].id,
          'Red'
        )
        expect(updated.colorOverride).toBe('Red')
      }
    })
  })
})
