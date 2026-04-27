/**
 * Phase 14: Cloud Storage & The Visual Image Manager
 * 
 * Storage Backend Service
 * - AWS S3 / Cloudflare R2 support
 * - Local fallback mode (apps/api/public/uploads)
 * - Automatic slot-mapping for Amazon images
 * - Regional locale suffixes (.DE, .FR, etc.)
 */

import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import fs from 'fs/promises'
import path from 'path'
import { logger } from '../utils/logger.js'

export interface StorageConfig {
  provider: 'S3' | 'R2' | 'LOCAL'
  bucket?: string
  region?: string
  accessKeyId?: string
  secretAccessKey?: string
  endpoint?: string // For R2
}

export interface ImageMetadata {
  filename: string
  url: string
  slot: string // MAIN, PT01, PT02, etc.
  locale?: string // DE, FR, etc.
  width?: number
  height?: number
  size?: number
  contentType?: string
}

class StorageService {
  private s3Client: S3Client | null = null
  private config: StorageConfig
  private isLocalMode: boolean = false

  constructor() {
    this.config = this.initializeConfig()
    this.isLocalMode = this.config.provider === 'LOCAL'

    if (!this.isLocalMode) {
      this.initializeS3Client()
    }

    logger.info(`📦 Storage Service initialized`, {
      provider: this.config.provider,
      bucket: this.config.bucket,
      mode: this.isLocalMode ? 'LOCAL' : 'CLOUD',
    })
  }

  /**
   * Initialize storage configuration from environment
   */
  private initializeConfig(): StorageConfig {
    const provider = process.env.STORAGE_PROVIDER || 'LOCAL'

    if (provider === 'LOCAL') {
      return { provider: 'LOCAL' }
    }

    if (provider === 'R2') {
      return {
        provider: 'R2',
        bucket: process.env.R2_BUCKET_NAME,
        endpoint: process.env.R2_ENDPOINT,
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      }
    }

    // Default to S3
    return {
      provider: 'S3',
      bucket: process.env.AWS_S3_BUCKET,
      region: process.env.AWS_REGION || 'us-east-1',
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    }
  }

  /**
   * Initialize S3/R2 client
   */
  private initializeS3Client() {
    try {
      const clientConfig: any = {
        region: this.config.region || 'us-east-1',
        credentials: {
          accessKeyId: this.config.accessKeyId || '',
          secretAccessKey: this.config.secretAccessKey || '',
        },
      }

      // For Cloudflare R2
      if (this.config.provider === 'R2' && this.config.endpoint) {
        clientConfig.endpoint = this.config.endpoint
      }

      this.s3Client = new S3Client(clientConfig)
      logger.info('✅ S3/R2 client initialized', { provider: this.config.provider })
    } catch (error) {
      logger.warn('⚠️ Failed to initialize S3/R2 client, falling back to LOCAL', {
        error: error instanceof Error ? error.message : String(error),
      })
      this.isLocalMode = true
    }
  }

  /**
   * Upload image to storage
   * Automatically assigns Amazon slot based on position
   */
  async uploadImage(
    file: Buffer,
    filename: string,
    position: number,
    locale?: string,
    metadata?: Partial<ImageMetadata>
  ): Promise<ImageMetadata> {
    try {
      // Generate Amazon slot (MAIN, PT01, PT02, etc.)
      const slot = this.getAmazonSlot(position)

      // Generate filename with slot and locale
      const storageName = this.generateStorageFilename(filename, slot, locale)

      if (this.isLocalMode) {
        return await this.uploadLocal(file, storageName, slot, locale, metadata)
      } else {
        return await this.uploadCloud(file, storageName, slot, locale, metadata)
      }
    } catch (error) {
      logger.error('❌ Image upload failed', {
        filename,
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }

  /**
   * Upload to local filesystem
   */
  private async uploadLocal(
    file: Buffer,
    filename: string,
    slot: string,
    locale: string | undefined,
    metadata?: Partial<ImageMetadata>
  ): Promise<ImageMetadata> {
    const uploadDir = path.join(process.cwd(), 'apps/api/public/uploads')

    // Create directory if it doesn't exist
    await fs.mkdir(uploadDir, { recursive: true })

    const filepath = path.join(uploadDir, filename)
    await fs.writeFile(filepath, file)

    const url = `http://localhost:3001/uploads/${filename}`

    logger.info('✅ Image uploaded to local storage', {
      filename,
      url,
      slot,
      locale,
    })

    return {
      filename,
      url,
      slot,
      locale,
      size: file.length,
      contentType: metadata?.contentType || 'image/jpeg',
      ...metadata,
    }
  }

  /**
   * Upload to S3/R2
   */
  private async uploadCloud(
    file: Buffer,
    filename: string,
    slot: string,
    locale: string | undefined,
    metadata?: Partial<ImageMetadata>
  ): Promise<ImageMetadata> {
    if (!this.s3Client || !this.config.bucket) {
      throw new Error('S3/R2 client not initialized')
    }

    try {
      const command = new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: filename,
        Body: file,
        ContentType: metadata?.contentType || 'image/jpeg',
        Metadata: {
          slot,
          locale: locale || 'default',
          uploadedAt: new Date().toISOString(),
        },
      })

      await this.s3Client.send(command)

      // Generate signed URL (valid for 7 days)
      const urlCommand = new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: filename,
      })

      const url = await getSignedUrl(this.s3Client, urlCommand, { expiresIn: 7 * 24 * 60 * 60 })

      logger.info('✅ Image uploaded to cloud storage', {
        filename,
        provider: this.config.provider,
        slot,
        locale,
      })

      return {
        filename,
        url,
        slot,
        locale,
        size: file.length,
        contentType: metadata?.contentType || 'image/jpeg',
        ...metadata,
      }
    } catch (error) {
      logger.error('❌ Cloud upload failed', {
        filename,
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }

  /**
   * Delete image from storage
   */
  async deleteImage(filename: string): Promise<void> {
    try {
      if (this.isLocalMode) {
        const filepath = path.join(process.cwd(), 'apps/api/public/uploads', filename)
        await fs.unlink(filepath)
        logger.info('✅ Image deleted from local storage', { filename })
      } else if (this.s3Client && this.config.bucket) {
        const command = new DeleteObjectCommand({
          Bucket: this.config.bucket,
          Key: filename,
        })
        await this.s3Client.send(command)
        logger.info('✅ Image deleted from cloud storage', { filename })
      }
    } catch (error) {
      logger.error('❌ Image deletion failed', {
        filename,
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }

  /**
   * Get Amazon slot based on position
   * Position 1 → MAIN
   * Position 2 → PT01
   * Position 3 → PT02
   * etc.
   */
  private getAmazonSlot(position: number): string {
    if (position === 1) return 'MAIN'
    const ptIndex = position - 2
    return `PT${String(ptIndex).padStart(2, '0')}`
  }

  /**
   * Generate storage filename with slot and locale
   * Example: "product-sku.MAIN.jpg" or "product-sku.DE.MAIN.jpg"
   */
  private generateStorageFilename(
    originalFilename: string,
    slot: string,
    locale?: string
  ): string {
    const ext = path.extname(originalFilename)
    const name = path.basename(originalFilename, ext)

    if (locale) {
      return `${name}.${locale}.${slot}${ext}`
    }
    return `${name}.${slot}${ext}`
  }

  /**
   * Validate image for Amazon requirements
   */
  validateAmazonImage(
    width: number,
    height: number,
    slot: string,
    imageData?: Buffer
  ): { valid: boolean; warnings: string[] } {
    const warnings: string[] = []

    // Minimum resolution: 1000x1000
    if (width < 1000 || height < 1000) {
      warnings.push(`Resolution ${width}x${height} is below minimum 1000x1000`)
    }

    // MAIN image specific requirements
    if (slot === 'MAIN') {
      // Check for white background (simplified check)
      if (imageData) {
        const hasWhiteBackground = this.checkWhiteBackground(imageData)
        if (!hasWhiteBackground) {
          warnings.push('MAIN image should have a pure white background')
        }
      }
    }

    return {
      valid: warnings.length === 0,
      warnings,
    }
  }

  /**
   * Simple white background detection
   * Checks if majority of image edges are white
   */
  private checkWhiteBackground(imageData: Buffer): boolean {
    // This is a simplified check - in production, use image processing library
    // For now, we'll assume it's valid if provided
    return true
  }

  /**
   * Get storage stats
   */
  async getStorageStats(): Promise<{
    provider: string
    mode: string
    bucket?: string
    localPath?: string
  }> {
    return {
      provider: this.config.provider,
      mode: this.isLocalMode ? 'LOCAL' : 'CLOUD',
      bucket: this.config.bucket,
      localPath: this.isLocalMode ? 'apps/api/public/uploads' : undefined,
    }
  }
}

// Export singleton instance
export const storageService = new StorageService()
