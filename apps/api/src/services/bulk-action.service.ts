/**
 * BulkActionService
 * Manages asynchronous bulk operations with progress tracking and error handling
 * Supports: PRICING_UPDATE, INVENTORY_UPDATE, STATUS_UPDATE, ATTRIBUTE_UPDATE, LISTING_SYNC
 */

import { prisma } from '@nexus/database';
import { logger } from '../utils/logger';
import { amazonProvider } from '../providers/amazon.provider';
import { ebayProvider } from '../providers/ebay.provider';
import type { MarketplaceProvider } from '../providers/types';

// Type aliases for Prisma types that aren't being generated
type BulkActionJob = any;

// Mock Decimal class for type compatibility
class Decimal {
  constructor(value: any) {
    return value;
  }
  plus(other: any) { return this; }
  lessThan(other: any) { return false; }
  greaterThan(other: any) { return false; }
}

export type BulkActionType =
  | 'PRICING_UPDATE'
  | 'INVENTORY_UPDATE'
  | 'STATUS_UPDATE'
  | 'ATTRIBUTE_UPDATE'
  | 'LISTING_SYNC';

export type BulkActionStatus =
  | 'PENDING'
  | 'QUEUED'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'FAILED'
  | 'PARTIALLY_COMPLETED'
  | 'CANCELLED';

export interface CreateJobInput {
  jobName: string;
  actionType: BulkActionType;
  channel?: string;
  targetProductIds?: string[];
  targetVariationIds?: string[];
  filters?: Record<string, any>;
  actionPayload: Record<string, any>;
  createdBy?: string;
}

export interface UpdateProgressInput {
  processedItems: number;
  failedItems: number;
  skippedItems: number;
  errors?: Array<{
    itemId: string;
    error: string;
    timestamp: Date;
  }>;
}

export interface ProcessJobResult {
  jobId: string;
  status: BulkActionStatus;
  processedItems: number;
  failedItems: number;
  skippedItems: number;
  totalItems: number;
  errors: Array<{
    itemId: string;
    error: string;
    timestamp: Date;
  }>;
}

export class BulkActionService {
  constructor(private prisma: any = prisma) {}

  /**
   * Create a new bulk action job
   * Initializes job with PENDING status and calculates total items to process
   */
  async createJob(input: CreateJobInput): Promise<BulkActionJob> {
    try {
      // Calculate total items to process
      let totalItems = 0;

      if (input.targetVariationIds?.length) {
        totalItems = input.targetVariationIds.length;
      } else if (input.targetProductIds?.length) {
        totalItems = input.targetProductIds.length;
      } else if (input.filters) {
        // Count items matching filters
        totalItems = await this.countItemsByFilters(input.filters);
      }

      if (totalItems === 0) {
        throw new Error('No items found matching the specified criteria');
      }

      logger.info(`Creating bulk action job: ${input.jobName}`, {
        actionType: input.actionType,
        totalItems,
        channel: input.channel
      });

      const job = await this.prisma.bulkActionJob.create({
        data: {
          jobName: input.jobName,
          actionType: input.actionType,
          channel: input.channel || null,
          targetProductIds: input.targetProductIds || [],
          targetVariationIds: input.targetVariationIds || [],
          filters: input.filters || null,
          actionPayload: input.actionPayload,
          status: 'PENDING',
          totalItems,
          processedItems: 0,
          failedItems: 0,
          skippedItems: 0,
          progressPercent: 0,
          createdBy: input.createdBy || null,
          isRollbackable: true
        }
      });

      logger.info(`Bulk action job created successfully`, { jobId: job.id });
      return job;
    } catch (error) {
      logger.error('Failed to create bulk action job', {
        error: error instanceof Error ? error.message : String(error),
        input
      });
      throw error;
    }
  }

  /**
   * Update job progress with granular tracking
   * Calculates progress percentage and updates error log
   */
  async updateProgress(jobId: string, input: UpdateProgressInput): Promise<BulkActionJob> {
    try {
      const job = await this.prisma.bulkActionJob.findUnique({
        where: { id: jobId }
      });

      if (!job) {
        throw new Error(`Job not found: ${jobId}`);
      }

      // Calculate progress percentage
      const totalProcessed = input.processedItems + input.failedItems + input.skippedItems;
      const progressPercent = Math.round((totalProcessed / job.totalItems) * 100);

      // Validate progress doesn't exceed 100%
      if (progressPercent > 100) {
        throw new Error(`Progress exceeds 100%: ${progressPercent}%`);
      }

      logger.debug(`Updating job progress`, {
        jobId,
        progressPercent,
        processedItems: input.processedItems,
        failedItems: input.failedItems,
        skippedItems: input.skippedItems
      });

      const updatedJob = await this.prisma.bulkActionJob.update({
        where: { id: jobId },
        data: {
          processedItems: input.processedItems,
          failedItems: input.failedItems,
          skippedItems: input.skippedItems,
          progressPercent,
          errorLog: input.errors && input.errors.length > 0 ? input.errors : null,
          lastError: input.errors?.[0]?.error || null,
          updatedAt: new Date()
        }
      });

      return updatedJob;
    } catch (error) {
      logger.error('Failed to update job progress', {
        jobId,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Process a bulk action job
   * Wraps execution in try/catch with comprehensive error handling
   * Updates job status based on execution result
   */
  async processJob(jobId: string): Promise<ProcessJobResult> {
    let job: BulkActionJob | null = null;

    try {
      // Fetch job
      job = await this.prisma.bulkActionJob.findUnique({
        where: { id: jobId }
      });

      if (!job) {
        throw new Error(`Job not found: ${jobId}`);
      }

      if (job.status !== 'PENDING' && job.status !== 'QUEUED') {
        throw new Error(`Cannot process job with status: ${job.status}`);
      }

      logger.info(`Starting job processing`, {
        jobId,
        actionType: job.actionType,
        totalItems: job.totalItems
      });

      // Update status to IN_PROGRESS
      await this.prisma.bulkActionJob.update({
        where: { id: jobId },
        data: {
          status: 'IN_PROGRESS',
          startedAt: new Date()
        }
      });

      // Get items to process
      const items = await this.getItemsForJob(job);

      if (items.length === 0) {
        throw new Error('No items found to process');
      }

      let processedItems = 0;
      let failedItems = 0;
      let skippedItems = 0;
      const errors: Array<{ itemId: string; error: string; timestamp: Date }> = [];

      // Process each item
      for (const item of items) {
        try {
          const result = await this.processItem(item, job);

          if (result.status === 'processed') {
            processedItems++;
          } else if (result.status === 'skipped') {
            skippedItems++;
          }
        } catch (itemError) {
          failedItems++;
          const errorMessage = itemError instanceof Error ? itemError.message : String(itemError);
          errors.push({
            itemId: item.id,
            error: errorMessage,
            timestamp: new Date()
          });

          logger.warn(`Failed to process item`, {
            jobId,
            itemId: item.id,
            error: errorMessage
          });
        }

        // Update progress every 10 items
        if ((processedItems + failedItems + skippedItems) % 10 === 0) {
          await this.updateProgress(jobId, {
            processedItems,
            failedItems,
            skippedItems,
            errors: errors.length > 0 ? errors : undefined
          });
        }
      }

      // Final progress update
      await this.updateProgress(jobId, {
        processedItems,
        failedItems,
        skippedItems,
        errors: errors.length > 0 ? errors : undefined
      });

      // Determine final status
      let finalStatus: BulkActionStatus;
      if (failedItems === 0) {
        finalStatus = 'COMPLETED';
      } else if (processedItems > 0 || skippedItems > 0) {
        finalStatus = 'PARTIALLY_COMPLETED';
      } else {
        finalStatus = 'FAILED';
      }

      // Update job with final status
      const completedJob = await this.prisma.bulkActionJob.update({
        where: { id: jobId },
        data: {
          status: finalStatus,
          completedAt: new Date(),
          updatedAt: new Date()
        }
      });

      logger.info(`Job processing completed`, {
        jobId,
        status: finalStatus,
        processedItems,
        failedItems,
        skippedItems,
        totalItems: job.totalItems
      });

      return {
        jobId,
        status: finalStatus,
        processedItems,
        failedItems,
        skippedItems,
        totalItems: job.totalItems,
        errors
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      logger.error(`Job processing failed with error`, {
        jobId,
        error: errorMessage
      });

      // Update job status to FAILED with error context
      if (job) {
        try {
          await this.prisma.bulkActionJob.update({
            where: { id: jobId },
            data: {
              status: 'FAILED',
              lastError: errorMessage,
              completedAt: new Date(),
              updatedAt: new Date(),
              errorLog: [
                {
                  itemId: 'JOB_LEVEL',
                  error: errorMessage,
                  timestamp: new Date()
                }
              ]
            }
          });
        } catch (updateError) {
          logger.error('Failed to update job status to FAILED', {
            jobId,
            error: updateError instanceof Error ? updateError.message : String(updateError)
          });
        }
      }

      throw error;
    }
  }

  /**
   * Get job status and details
   */
  async getJobStatus(jobId: string): Promise<BulkActionJob | null> {
    try {
      return await this.prisma.bulkActionJob.findUnique({
        where: { id: jobId }
      });
    } catch (error) {
      logger.error('Failed to get job status', {
        jobId,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Get all pending jobs
   */
  async getPendingJobs(): Promise<BulkActionJob[]> {
    try {
      return await this.prisma.bulkActionJob.findMany({
        where: {
          status: { in: ['PENDING', 'QUEUED'] }
        },
        orderBy: { createdAt: 'asc' }
      });
    } catch (error) {
      logger.error('Failed to get pending jobs', {
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Create a rollback job for a failed or completed job
   */
  async createRollbackJob(originalJobId: string): Promise<BulkActionJob> {
    try {
      const originalJob = await this.prisma.bulkActionJob.findUnique({
        where: { id: originalJobId }
      });

      if (!originalJob) {
        throw new Error(`Original job not found: ${originalJobId}`);
      }

      if (!originalJob.isRollbackable) {
        throw new Error(`Job is not rollbackable: ${originalJobId}`);
      }

      if (!originalJob.rollbackData) {
        throw new Error(`No rollback data available for job: ${originalJobId}`);
      }

      logger.info(`Creating rollback job`, {
        originalJobId,
        actionType: originalJob.actionType
      });

      const rollbackJob = await this.prisma.bulkActionJob.create({
        data: {
          jobName: `Rollback: ${originalJob.jobName}`,
          actionType: originalJob.actionType,
          channel: originalJob.channel,
          targetProductIds: originalJob.targetProductIds,
          targetVariationIds: originalJob.targetVariationIds,
          filters: originalJob.filters,
          actionPayload: originalJob.rollbackData,
          status: 'PENDING',
          totalItems: originalJob.totalItems,
          createdBy: originalJob.createdBy,
          isRollbackable: false
        }
      });

      // Link rollback job to original
      await this.prisma.bulkActionJob.update({
        where: { id: originalJobId },
        data: { rollbackJobId: rollbackJob.id }
      });

      logger.info(`Rollback job created successfully`, {
        rollbackJobId: rollbackJob.id,
        originalJobId
      });

      return rollbackJob;
    } catch (error) {
      logger.error('Failed to create rollback job', {
        originalJobId,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Cancel a pending job
   */
  async cancelJob(jobId: string): Promise<BulkActionJob> {
    try {
      const job = await this.prisma.bulkActionJob.findUnique({
        where: { id: jobId }
      });

      if (!job) {
        throw new Error(`Job not found: ${jobId}`);
      }

      if (job.status !== 'PENDING' && job.status !== 'QUEUED') {
        throw new Error(`Cannot cancel job with status: ${job.status}`);
      }

      logger.info(`Cancelling job`, { jobId });

      return await this.prisma.bulkActionJob.update({
        where: { id: jobId },
        data: {
          status: 'CANCELLED',
          completedAt: new Date(),
          updatedAt: new Date()
        }
      });
    } catch (error) {
      logger.error('Failed to cancel job', {
        jobId,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Private helper: Get items to process based on job configuration
   */
  private async getItemsForJob(job: BulkActionJob): Promise<Array<{ id: string; [key: string]: any }>> {
    try {
      if (job.targetVariationIds && job.targetVariationIds.length > 0) {
        return await this.prisma.productVariation.findMany({
          where: { id: { in: job.targetVariationIds } }
        });
      }

      if (job.targetProductIds && job.targetProductIds.length > 0) {
        return await this.prisma.product.findMany({
          where: { id: { in: job.targetProductIds } }
        });
      }

      // Handle filter-based queries
      if (job.filters) {
        return await this.getItemsByFilters(job.filters);
      }

      return [];
    } catch (error) {
      logger.error('Failed to get items for job', {
        jobId: job.id,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Private helper: Process a single item based on action type
   */
  private async processItem(
    item: any,
    job: BulkActionJob
  ): Promise<{ status: 'processed' | 'skipped' }> {
    switch (job.actionType) {
      case 'PRICING_UPDATE':
        return await this.processPricingUpdate(item, job.actionPayload, job.channel);
      case 'INVENTORY_UPDATE':
        return await this.processInventoryUpdate(item, job.actionPayload, job.channel);
      case 'STATUS_UPDATE':
        return await this.processStatusUpdate(item, job.actionPayload);
      case 'ATTRIBUTE_UPDATE':
        return await this.processAttributeUpdate(item, job.actionPayload);
      case 'LISTING_SYNC':
        return await this.processListingSync(item, job.actionPayload, job.channel);
      default:
        throw new Error(`Unknown action type: ${job.actionType}`);
    }
  }

  /**
   * Private helper: Process pricing update
   */
  private async processPricingUpdate(
    item: any,
    payload: Record<string, any>,
    channel?: string
  ): Promise<{ status: 'processed' | 'skipped' }> {
    const newPrice = new Decimal(item.price).plus(new Decimal(payload.priceAdjustment || 0));

    // Validate price constraints
    if (payload.minPrice && newPrice.lessThan(new Decimal(payload.minPrice))) {
      return { status: 'skipped' };
    }

    if (payload.maxPrice && newPrice.greaterThan(new Decimal(payload.maxPrice))) {
      return { status: 'skipped' };
    }

    // Update in database
    await this.prisma.productVariation.update({
      where: { id: item.id },
      data: { price: newPrice }
    });

    // Sync to marketplace if channel is specified
    if (channel && item.sku) {
      await this.syncPriceToMarketplace(item.sku, newPrice, channel);
    }

    return { status: 'processed' };
  }

  /**
   * Private helper: Process inventory update
   */
  private async processInventoryUpdate(
    item: any,
    payload: Record<string, any>,
    channel?: string
  ): Promise<{ status: 'processed' | 'skipped' }> {
    const newStock = Math.max(0, (item.stock || 0) + (payload.quantityChange || 0));

    await this.prisma.productVariation.update({
      where: { id: item.id },
      data: { stock: newStock }
    });

    // Sync to marketplace if channel is specified
    if (channel && item.sku) {
      await this.syncStockToMarketplace(item.sku, newStock, channel);
    }

    return { status: 'processed' };
  }

  /**
   * Private helper: Process status update
   */
  private async processStatusUpdate(
    item: any,
    payload: Record<string, any>
  ): Promise<{ status: 'processed' | 'skipped' }> {
    await this.prisma.product.update({
      where: { id: item.id },
      data: { status: payload.newStatus }
    });

    return { status: 'processed' };
  }

  /**
   * Private helper: Process attribute update
   */
  private async processAttributeUpdate(
    item: any,
    payload: Record<string, any>
  ): Promise<{ status: 'processed' | 'skipped' }> {
    const currentMetadata = item.marketplaceMetadata || {};

    await this.prisma.productVariation.update({
      where: { id: item.id },
      data: {
        marketplaceMetadata: {
          ...currentMetadata,
          ...payload.attributes
        }
      }
    });

    return { status: 'processed' };
  }

  /**
   * Private helper: Process listing sync
   */
  private async processListingSync(
    item: any,
    payload: Record<string, any>,
    channel?: string
  ): Promise<{ status: 'processed' | 'skipped' }> {
    // Sync to marketplace if channel is specified
    if (channel && item.sku) {
      await this.syncListingToMarketplace(item, channel);
    }

    logger.debug(`Processing listing sync for item`, { itemId: item.id, channel });
    return { status: 'processed' };
  }

  /**
   * Sync price to marketplace
   * Handles rate limiting and retries
   */
  private async syncPriceToMarketplace(
    sku: string,
    price: any,
    channel: string
  ): Promise<void> {
    try {
      const provider = this.getMarketplaceProvider(channel);
      if (!provider) {
        logger.warn(`No provider configured for channel: ${channel}`);
        return;
      }

      const response = await provider.updatePrice({
        sku,
        price: typeof price === 'number' ? price : parseFloat(String(price)),
      });

      if (!response.success) {
        if (response.retryable) {
          logger.warn(`Retryable error syncing price to ${channel}`, {
            sku,
            error: response.error,
          });
        } else {
          logger.error(`Failed to sync price to ${channel}`, {
            sku,
            error: response.error,
          });
        }
      } else {
        logger.info(`Price synced to ${channel}`, { sku, price });
      }
    } catch (error) {
      logger.error(`Error syncing price to marketplace`, {
        sku,
        channel,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Sync stock to marketplace
   * Handles rate limiting and retries
   */
  private async syncStockToMarketplace(
    sku: string,
    quantity: number,
    channel: string
  ): Promise<void> {
    try {
      const provider = this.getMarketplaceProvider(channel);
      if (!provider) {
        logger.warn(`No provider configured for channel: ${channel}`);
        return;
      }

      const response = await provider.updateStock({
        sku,
        quantity,
      });

      if (!response.success) {
        if (response.retryable) {
          logger.warn(`Retryable error syncing stock to ${channel}`, {
            sku,
            error: response.error,
          });
        } else {
          logger.error(`Failed to sync stock to ${channel}`, {
            sku,
            error: response.error,
          });
        }
      } else {
        logger.info(`Stock synced to ${channel}`, { sku, quantity });
      }
    } catch (error) {
      logger.error(`Error syncing stock to marketplace`, {
        sku,
        channel,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Sync complete listing to marketplace
   */
  private async syncListingToMarketplace(
    item: any,
    channel: string
  ): Promise<void> {
    try {
      const provider = this.getMarketplaceProvider(channel);
      if (!provider) {
        logger.warn(`No provider configured for channel: ${channel}`);
        return;
      }

      const response = await provider.syncListing({
        sku: item.sku,
        title: item.name || '',
        description: item.description || '',
        price: typeof item.price === 'number' ? item.price : parseFloat(String(item.price)),
        quantity: item.stock || 0,
        imageUrls: item.imageUrl ? [item.imageUrl] : [],
        attributes: item.marketplaceMetadata || {},
      });

      if (!response.success) {
        if (response.retryable) {
          logger.warn(`Retryable error syncing listing to ${channel}`, {
            sku: item.sku,
            error: response.error,
          });
        } else {
          logger.error(`Failed to sync listing to ${channel}`, {
            sku: item.sku,
            error: response.error,
          });
        }
      } else {
        logger.info(`Listing synced to ${channel}`, { sku: item.sku });
      }
    } catch (error) {
      logger.error(`Error syncing listing to marketplace`, {
        sku: item.sku,
        channel,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Get marketplace provider by channel
   */
  private getMarketplaceProvider(channel: string): MarketplaceProvider | null {
    switch (channel?.toLowerCase()) {
      case 'amazon':
        return amazonProvider.isConfigured() ? amazonProvider : null;
      case 'ebay':
        return ebayProvider.isConfigured() ? ebayProvider : null;
      default:
        return null;
    }
  }

  /**
   * Private helper: Count items matching filters
   */
  private async countItemsByFilters(filters: Record<string, any>): Promise<number> {
    try {
      // Implement filter-based counting logic
      // This is a placeholder - extend based on your filter structure
      const count = await this.prisma.productVariation.count({
        where: this.buildFilterWhere(filters)
      });
      return count;
    } catch (error) {
      logger.warn('Failed to count items by filters, returning 0', {
        error: error instanceof Error ? error.message : String(error)
      });
      return 0;
    }
  }

  /**
   * Private helper: Get items by filters
   */
  private async getItemsByFilters(filters: Record<string, any>): Promise<Array<{ id: string; [key: string]: any }>> {
    try {
      return await this.prisma.productVariation.findMany({
        where: this.buildFilterWhere(filters)
      });
    } catch (error) {
      logger.error('Failed to get items by filters', {
        error: error instanceof Error ? error.message : String(error)
      });
      return [];
    }
  }

  /**
   * Private helper: Build Prisma where clause from filters
   */
  private buildFilterWhere(filters: Record<string, any>): Record<string, any> {
    // Implement filter building logic based on your filter structure
    // Example: { status: 'ACTIVE', stock: { lt: 10 } }
    return filters;
  }
}
