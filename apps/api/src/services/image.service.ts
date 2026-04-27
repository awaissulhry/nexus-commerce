import prisma from '../db';
import * as fs from 'fs';
import * as path from 'path';
import { v2 as cloudinary } from 'cloudinary';

/**
 * Initialize Cloudinary with environment variables
 */
function initializeCloudinary() {
  if (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET) {
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
    });
    return true;
  }
  return false;
}

/**
 * Color detection and analysis utilities
 */
export class ColorAnalyzer {
  /**
   * Extract dominant color from image URL (mock implementation)
   * In production, this would use image processing libraries like sharp or jimp
   */
  static async extractDominantColor(imageUrl: string): Promise<{
    color: string;
    confidence: number;
  }> {
    // Mock color detection - in production, use image processing
    // For now, return a random color with confidence
    const colors = [
      '#FF0000', // Red
      '#00FF00', // Green
      '#0000FF', // Blue
      '#FFFF00', // Yellow
      '#FF00FF', // Magenta
      '#00FFFF', // Cyan
      '#000000', // Black
      '#FFFFFF', // White
      '#808080', // Gray
      '#FFA500', // Orange
      '#800080', // Purple
      '#FFC0CB', // Pink
    ];

    const randomColor = colors[Math.floor(Math.random() * colors.length)];
    const confidence = Math.floor(Math.random() * 40) + 60; // 60-100

    return {
      color: randomColor,
      confidence,
    };
  }

  /**
   * Map color hex to human-readable color name
   */
  static colorNameFromHex(hex: string): string {
    const colorMap: Record<string, string> = {
      '#FF0000': 'Red',
      '#00FF00': 'Green',
      '#0000FF': 'Blue',
      '#FFFF00': 'Yellow',
      '#FF00FF': 'Magenta',
      '#00FFFF': 'Cyan',
      '#000000': 'Black',
      '#FFFFFF': 'White',
      '#808080': 'Gray',
      '#FFA500': 'Orange',
      '#800080': 'Purple',
      '#FFC0CB': 'Pink',
    };

    return colorMap[hex.toUpperCase()] || 'Unknown';
  }

  /**
   * Calculate color similarity (0-100)
   */
  static calculateColorSimilarity(color1: string, color2: string): number {
    // Simple hex distance calculation
    const hex1 = color1.replace('#', '');
    const hex2 = color2.replace('#', '');

    let distance = 0;
    for (let i = 0; i < 6; i += 2) {
      const r1 = parseInt(hex1.substr(i, 2), 16);
      const r2 = parseInt(hex2.substr(i, 2), 16);
      distance += Math.abs(r1 - r2);
    }

    // Normalize to 0-100 scale (max distance is 765)
    return Math.max(0, 100 - (distance / 765) * 100);
  }
}

/**
 * Cloudinary cloud storage implementation
 */
export class CloudinaryStorage {
  private static isInitialized = initializeCloudinary();

  /**
   * Upload image to Cloudinary
   */
  static async uploadImage(
    imageUrl: string,
    productId: string,
    imageId: string
  ): Promise<{
    url: string;
    secure_url: string;
    public_id: string;
    cloudName: string;
  }> {
    if (!this.isInitialized) {
      throw new Error('Cloudinary is not configured. Please set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET environment variables.');
    }

    try {
      // Upload image to Cloudinary
      const result = await cloudinary.uploader.upload(imageUrl, {
        folder: `nexus-commerce/products/${productId}`,
        public_id: imageId,
        resource_type: 'auto',
        quality: 'auto',
        fetch_format: 'auto',
      });

      return {
        url: result.url,
        secure_url: result.secure_url,
        public_id: result.public_id,
        cloudName: result.cloud_name,
      };
    } catch (error) {
      throw new Error(`Failed to upload image to Cloudinary: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Delete image from Cloudinary
   */
  static async deleteImage(publicId: string): Promise<void> {
    if (!this.isInitialized) {
      throw new Error('Cloudinary is not configured.');
    }

    try {
      await cloudinary.uploader.destroy(publicId);
    } catch (error) {
      throw new Error(`Failed to delete image from Cloudinary: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/**
 * Mock cloud storage implementation (fallback for local development)
 */
export class MockCloudStorage {
  private static readonly STORAGE_DIR = path.join(
    process.cwd(),
    'public',
    'uploads',
    'images'
  );

  /**
   * Initialize storage directory
   */
  static async initialize(): Promise<void> {
    if (!fs.existsSync(this.STORAGE_DIR)) {
      fs.mkdirSync(this.STORAGE_DIR, { recursive: true });
    }
  }

  /**
   * Upload image to mock cloud storage
   */
  static async uploadImage(
    imageUrl: string,
    productId: string,
    imageId: string
  ): Promise<{
    url: string;
    key: string;
    bucket: string;
  }> {
    // Mock upload - in production, use AWS S3, GCS, or similar
    const key = `products/${productId}/${imageId}.jpg`;
    const bucket = 'nexus-images';
    const url = `/uploads/images/${key}`;

    // Simulate upload delay
    await new Promise((resolve) => setTimeout(resolve, 100));

    return {
      url,
      key,
      bucket,
    };
  }

  /**
   * Delete image from mock cloud storage
   */
  static async deleteImage(key: string): Promise<void> {
    const filePath = path.join(this.STORAGE_DIR, key);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }
}

/**
 * Image Management Service
 */
export class ImageService {
  /**
   * Upload image and create Image record
   */
  static async uploadImage(
    productId: string,
    imageUrl: string,
    imageType: 'MAIN' | 'ALT' | 'LIFESTYLE' | 'SWATCH' = 'ALT',
    alt?: string
  ) {
    // Create image record
    const image = await prisma.image.create({
      data: {
        productId,
        url: imageUrl,
        alt,
        type: imageType,
        uploadStatus: 'UPLOADING',
      },
    });

    try {
      // Extract dominant color
      const { color, confidence } = await ColorAnalyzer.extractDominantColor(
        imageUrl
      );

      let uploadedUrl: string;
      let storageMetadata: Record<string, unknown>;

      // Try Cloudinary first, fall back to mock storage
      if (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET) {
        try {
          const cloudinaryResult = await CloudinaryStorage.uploadImage(
            imageUrl,
            productId,
            image.id
          );

          uploadedUrl = cloudinaryResult.secure_url;
          storageMetadata = {
            provider: 'cloudinary',
            public_id: cloudinaryResult.public_id,
            cloud_name: cloudinaryResult.cloudName,
            uploadedAt: new Date().toISOString(),
          };
        } catch (error) {
          console.warn('Cloudinary upload failed, falling back to mock storage:', error);
          // Fall back to mock storage
          await MockCloudStorage.initialize();
          const mockResult = await MockCloudStorage.uploadImage(
            imageUrl,
            productId,
            image.id
          );
          uploadedUrl = mockResult.url;
          storageMetadata = {
            provider: 'mock',
            bucket: mockResult.bucket,
            key: mockResult.key,
            uploadedAt: new Date().toISOString(),
          };
        }
      } else {
        // Use mock storage if Cloudinary is not configured
        await MockCloudStorage.initialize();
        const mockResult = await MockCloudStorage.uploadImage(
          imageUrl,
          productId,
          image.id
        );
        uploadedUrl = mockResult.url;
        storageMetadata = {
          provider: 'mock',
          bucket: mockResult.bucket,
          key: mockResult.key,
          uploadedAt: new Date().toISOString(),
        };
      }

      // Update image with cloud storage metadata
      const updatedImage = await prisma.image.update({
        where: { id: image.id },
        data: {
          url: uploadedUrl,
          dominantColor: color,
          colorConfidence: confidence,
          uploadStatus: 'SUCCESS',
          storageMetadata: storageMetadata as any,
        },
      });

      return updatedImage;
    } catch (error) {
      // Mark upload as failed
      await prisma.image.update({
        where: { id: image.id },
        data: {
          uploadStatus: 'FAILED',
          uploadError: error instanceof Error ? error.message : 'Unknown error',
        },
      });

      throw error;
    }
  }

  /**
   * Get all images for a product
   */
  static async getProductImages(productId: string) {
    return prisma.image.findMany({
      where: { productId },
      orderBy: [{ isHero: 'desc' }, { sortOrder: 'asc' }],
    });
  }

  /**
   * Set hero image for product
   */
  static async setHeroImage(imageId: string, productId: string) {
    // Clear previous hero
    await prisma.image.updateMany({
      where: { productId, isHero: true },
      data: { isHero: false },
    });

    // Set new hero
    return prisma.image.update({
      where: { id: imageId },
      data: { isHero: true },
    });
  }

  /**
   * Update image color override
   */
  static async updateColorOverride(
    imageId: string,
    colorOverride: string
  ) {
    return prisma.image.update({
      where: { id: imageId },
      data: { colorOverride },
    });
  }

  /**
   * Delete image
   */
  static async deleteImage(imageId: string): Promise<void> {
    const image = await prisma.image.findUnique({
      where: { id: imageId },
    });

    if (!image) {
      throw new Error(`Image ${imageId} not found`);
    }

    // Delete from cloud storage if metadata exists
    if (image.storageMetadata) {
      const metadata = image.storageMetadata as Record<string, unknown>;
      
      if (metadata.provider === 'cloudinary' && metadata.public_id) {
        try {
          await CloudinaryStorage.deleteImage(metadata.public_id as string);
        } catch (error) {
          console.warn('Failed to delete image from Cloudinary:', error);
        }
      } else if (metadata.provider === 'mock' && metadata.key) {
        try {
          await MockCloudStorage.deleteImage(metadata.key as string);
        } catch (error) {
          console.warn('Failed to delete image from mock storage:', error);
        }
      }
    }

    // Delete from database
    await prisma.image.delete({
      where: { id: imageId },
    });
  }

  /**
   * Get images by dominant color
   */
  static async getImagesByColor(
    productId: string,
    color: string
  ) {
    const images = await prisma.image.findMany({
      where: { productId },
    });

    // Filter by color similarity
    return images.filter((img) => {
      if (!img.dominantColor) return false;
      const similarity = ColorAnalyzer.calculateColorSimilarity(
        img.dominantColor,
        color
      );
      return similarity > 70; // 70% similarity threshold
    });
  }
}

/**
 * Auto-assign images to variants based on color matching
 */
export class AutoAssignImages {
  /**
   * Automatically assign images to product variants based on color matching
   */
  static async assignImagesToVariants(productId: string): Promise<{
    assigned: number;
    updated: number;
  }> {
    // Get product with variations
    const product = await prisma.product.findUnique({
      where: { id: productId },
      include: {
        variations: true,
        cloudImages: true,
      },
    });

    if (!product) {
      throw new Error(`Product ${productId} not found`);
    }

    let assigned = 0;
    let updated = 0;

    // For each image, find matching variants
    for (const image of product.cloudImages) {
      const matchingVariants: string[] = [];

      // Check each variation for color match
      for (const variation of product.variations) {
        const variationAttrs = variation.variationAttributes as Record<
          string,
          string
        > | null;

        if (!variationAttrs) continue;

        // Get color attribute from variation
        const colorAttr = variationAttrs['Color'] || variationAttrs['color'];

        if (!colorAttr) continue;

        // Check if image color matches variation color
        const imageColorName = ColorAnalyzer.colorNameFromHex(
          image.dominantColor || '#808080'
        );

        if (
          colorAttr.toLowerCase() === imageColorName.toLowerCase() ||
          this.isColorMatch(colorAttr, imageColorName)
        ) {
          matchingVariants.push(variation.id);
        }
      }

      // Update image with assigned variants
      if (matchingVariants.length > 0) {
        await prisma.image.update({
          where: { id: image.id },
          data: {
            assignedVariants: matchingVariants,
          },
        });

        assigned += matchingVariants.length;
        updated++;
      }
    }

    return { assigned, updated };
  }

  /**
   * Check if two color names match (handles variations like "Red" vs "red")
   */
  private static isColorMatch(color1: string, color2: string): boolean {
    const normalize = (c: string) => c.toLowerCase().trim();
    const c1 = normalize(color1);
    const c2 = normalize(color2);

    // Exact match
    if (c1 === c2) return true;

    // Partial match (e.g., "Dark Red" contains "Red")
    if (c1.includes(c2) || c2.includes(c1)) return true;

    // Color aliases
    const aliases: Record<string, string[]> = {
      red: ['crimson', 'scarlet', 'maroon'],
      blue: ['navy', 'cobalt', 'azure'],
      green: ['lime', 'forest', 'olive'],
      black: ['charcoal', 'ebony'],
      white: ['ivory', 'cream'],
      gray: ['grey', 'silver'],
    };

    for (const [primary, alternates] of Object.entries(aliases)) {
      if (c1 === primary && alternates.includes(c2)) return true;
      if (c2 === primary && alternates.includes(c1)) return true;
    }

    return false;
  }

  /**
   * Manually assign image to specific variants
   */
  static async assignImageToVariants(
    imageId: string,
    variantIds: string[]
  ) {
    return prisma.image.update({
      where: { id: imageId },
      data: {
        assignedVariants: variantIds,
      },
    });
  }

  /**
   * Get variants assigned to an image
   */
  static async getAssignedVariants(imageId: string): Promise<any[]> {
    const image = await prisma.image.findUnique({
      where: { id: imageId },
    });

    if (!image || image.assignedVariants.length === 0) {
      return [];
    }

    return prisma.productVariation.findMany({
      where: {
        id: {
          in: image.assignedVariants,
        },
      },
    });
  }
}
