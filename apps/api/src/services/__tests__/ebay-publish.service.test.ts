import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EbayPublishService } from '../ebay-publish.service.js'
import { EbayService } from '../marketplaces/ebay.service.js'

/**
 * Unit tests for EbayPublishService
 * Tests the publishing workflow with various scenarios
 */

describe('EbayPublishService', () => {
  let ebayPublishService: EbayPublishService
  let mockEbayService: any
  let mockPrisma: any

  beforeEach(() => {
    // Mock EbayService
    mockEbayService = {
      publishNewListing: vi.fn(),
    }

    // Mock Prisma client
    mockPrisma = {
      draftListing: {
        findUnique: vi.fn(),
        update: vi.fn(),
      },
      variantChannelListing: {
        upsert: vi.fn(),
      },
    }

    ebayPublishService = new EbayPublishService(
      mockEbayService as any,
      mockPrisma
    )
  })

  describe('publishDraft', () => {
    it('should successfully publish a valid draft', async () => {
      // Arrange
      const draftId = 'draft-123'
      const mockDraft = {
        id: draftId,
        productId: 'product-123',
        status: 'DRAFT',
        ebayTitle: 'Test Product Title',
        categoryId: '12345',
        itemSpecifics: { Brand: 'TestBrand', Color: 'Red' },
        htmlDescription: '<p>Test description</p>',
        product: {
          id: 'product-123',
          sku: 'TEST-SKU-001',
          basePrice: 29.99,
          totalStock: 100,
          variations: [{ id: 'var-1' }],
          images: [],
        },
      }

      mockPrisma.draftListing.findUnique.mockResolvedValue(mockDraft)
      mockEbayService.publishNewListing.mockResolvedValue('123456789')

      // Act
      const result = await ebayPublishService.publishDraft(draftId)

      // Assert
      expect(result.success).toBe(true)
      expect(result.draftId).toBe(draftId)
      expect(result.productId).toBe('product-123')
      expect(result.listingId).toBe('123456789')
      expect(result.listingUrl).toBe('https://www.ebay.com/itm/123456789')
      expect(mockEbayService.publishNewListing).toHaveBeenCalledWith(
        'TEST-SKU-001',
        {
          ebayTitle: 'Test Product Title',
          categoryId: '12345',
          itemSpecifics: { Brand: 'TestBrand', Color: 'Red' },
          htmlDescription: '<p>Test description</p>',
        },
        29.99,
        100
      )
    })

    it('should throw error when draft not found', async () => {
      // Arrange
      const draftId = 'nonexistent-draft'
      mockPrisma.draftListing.findUnique.mockResolvedValue(null)

      // Act & Assert
      await expect(ebayPublishService.publishDraft(draftId)).rejects.toThrow(
        'Draft not found'
      )
    })

    it('should throw error when draft is not in DRAFT status', async () => {
      // Arrange
      const draftId = 'draft-123'
      const mockDraft = {
        id: draftId,
        status: 'PUBLISHED',
        product: { sku: 'TEST-SKU' },
      }
      mockPrisma.draftListing.findUnique.mockResolvedValue(mockDraft)

      // Act & Assert
      await expect(ebayPublishService.publishDraft(draftId)).rejects.toThrow(
        'not in DRAFT status'
      )
    })

    it('should throw error when ebayTitle is missing', async () => {
      // Arrange
      const draftId = 'draft-123'
      const mockDraft = {
        id: draftId,
        status: 'DRAFT',
        ebayTitle: '',
        categoryId: '12345',
        htmlDescription: '<p>Test</p>',
        product: { sku: 'TEST-SKU' },
      }
      mockPrisma.draftListing.findUnique.mockResolvedValue(mockDraft)

      // Act & Assert
      await expect(ebayPublishService.publishDraft(draftId)).rejects.toThrow(
        'ebayTitle'
      )
    })

    it('should throw error when categoryId is missing', async () => {
      // Arrange
      const draftId = 'draft-123'
      const mockDraft = {
        id: draftId,
        status: 'DRAFT',
        ebayTitle: 'Test Title',
        categoryId: '',
        htmlDescription: '<p>Test</p>',
        product: { sku: 'TEST-SKU' },
      }
      mockPrisma.draftListing.findUnique.mockResolvedValue(mockDraft)

      // Act & Assert
      await expect(ebayPublishService.publishDraft(draftId)).rejects.toThrow(
        'categoryId'
      )
    })

    it('should throw error when htmlDescription is missing', async () => {
      // Arrange
      const draftId = 'draft-123'
      const mockDraft = {
        id: draftId,
        status: 'DRAFT',
        ebayTitle: 'Test Title',
        categoryId: '12345',
        htmlDescription: '',
        product: { sku: 'TEST-SKU' },
      }
      mockPrisma.draftListing.findUnique.mockResolvedValue(mockDraft)

      // Act & Assert
      await expect(ebayPublishService.publishDraft(draftId)).rejects.toThrow(
        'htmlDescription'
      )
    })

    it('should throw error when product is missing', async () => {
      // Arrange
      const draftId = 'draft-123'
      const mockDraft = {
        id: draftId,
        status: 'DRAFT',
        ebayTitle: 'Test Title',
        categoryId: '12345',
        htmlDescription: '<p>Test</p>',
        product: null,
      }
      mockPrisma.draftListing.findUnique.mockResolvedValue(mockDraft)

      // Act & Assert
      await expect(ebayPublishService.publishDraft(draftId)).rejects.toThrow(
        'Product not found'
      )
    })

    it('should throw error when product SKU is missing', async () => {
      // Arrange
      const draftId = 'draft-123'
      const mockDraft = {
        id: draftId,
        status: 'DRAFT',
        ebayTitle: 'Test Title',
        categoryId: '12345',
        htmlDescription: '<p>Test</p>',
        product: { sku: null },
      }
      mockPrisma.draftListing.findUnique.mockResolvedValue(mockDraft)

      // Act & Assert
      await expect(ebayPublishService.publishDraft(draftId)).rejects.toThrow(
        'SKU'
      )
    })
  })
})
