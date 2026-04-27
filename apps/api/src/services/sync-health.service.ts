/**
 * SyncHealthService
 * Monitors sync health, tracks errors, and calculates channel health scores
 * Provides comprehensive error logging and conflict resolution tracking
 */

import { prisma } from '@nexus/database';
import { logger } from '../utils/logger';

// Type aliases for Prisma types that aren't being generated
type PrismaClient = any;
type SyncHealthLog = any;

export type ErrorType =
  | 'IMPORT_FAILED'
  | 'CONFLICT_DETECTED'
  | 'DUPLICATE_VARIATION'
  | 'VALIDATION_ERROR'
  | 'MAPPING_ERROR'
  | 'RATE_LIMIT'
  | 'AUTHENTICATION_ERROR';

export type Severity = 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';

export type ConflictType =
  | 'PRICE_MISMATCH'
  | 'INVENTORY_MISMATCH'
  | 'ATTRIBUTE_MISMATCH'
  | 'DUPLICATE_SKU'
  | 'DUPLICATE_ASIN';

export type ResolutionStatus = 'UNRESOLVED' | 'AUTO_RESOLVED' | 'MANUAL_RESOLVED' | 'IGNORED';

export interface LogErrorInput {
  errorType: ErrorType;
  severity: Severity;
  channel: string;
  message: string;
  productId?: string;
  variationId?: string;
  errorDetails?: Record<string, any>;
  syncJobId?: string;
}

export interface LogConflictInput {
  channel: string;
  conflictType: ConflictType;
  message: string;
  productId?: string;
  variationId?: string;
  localData: Record<string, any>;
  remoteData: Record<string, any>;
}

export interface LogDuplicateVariationInput {
  channel: string;
  productId: string;
  primaryVariationId: string;
  duplicateVariationIds: string[];
}

export interface UnresolvedConflict {
  id: string;
  channel: string;
  errorType: ErrorType;
  conflictType?: ConflictType;
  message: string;
  severity: Severity;
  productId?: string;
  variationId?: string;
  createdAt: Date;
  conflictData?: Record<string, any>;
}

export interface ChannelHealthScore {
  channel: string;
  healthScore: number;
  totalErrors: number;
  criticalErrors: number;
  unresolvedConflicts: number;
  duplicateVariations: number;
  successRate: number;
  lastUpdated: Date;
}

export class SyncHealthService {
  constructor(private prisma: PrismaClient) {}

  /**
   * Log a sync error
   */
  async logError(input: LogErrorInput): Promise<SyncHealthLog> {
    try {
      logger.warn(`Logging sync error`, {
        errorType: input.errorType,
        severity: input.severity,
        channel: input.channel,
        message: input.message
      });

      const log = await this.prisma.syncHealthLog.create({
        data: {
          channel: input.channel,
          errorType: input.errorType,
          severity: input.severity,
          errorMessage: input.message,
          productId: input.productId || null,
          variationId: input.variationId || null,
          errorDetails: input.errorDetails || null,
          syncJobId: input.syncJobId || null,
          resolutionStatus: 'UNRESOLVED'
        }
      });

      logger.info(`Sync error logged successfully`, {
        logId: log.id,
        errorType: input.errorType
      });

      return log;
    } catch (error) {
      logger.error(`Failed to log sync error`, {
        errorType: input.errorType,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Log a conflict
   */
  async logConflict(input: LogConflictInput): Promise<SyncHealthLog> {
    try {
      logger.warn(`Logging sync conflict`, {
        conflictType: input.conflictType,
        channel: input.channel,
        message: input.message
      });

      const log = await this.prisma.syncHealthLog.create({
        data: {
          channel: input.channel,
          errorType: 'CONFLICT_DETECTED',
          severity: 'WARNING',
          errorMessage: input.message,
          productId: input.productId || null,
          variationId: input.variationId || null,
          conflictType: input.conflictType,
          conflictData: {
            local: input.localData,
            remote: input.remoteData
          },
          resolutionStatus: 'UNRESOLVED'
        }
      });

      logger.info(`Sync conflict logged successfully`, {
        logId: log.id,
        conflictType: input.conflictType
      });

      return log;
    } catch (error) {
      logger.error(`Failed to log sync conflict`, {
        conflictType: input.conflictType,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Log duplicate variations
   */
  async logDuplicateVariation(input: LogDuplicateVariationInput): Promise<SyncHealthLog> {
    try {
      logger.warn(`Logging duplicate variations`, {
        channel: input.channel,
        productId: input.productId,
        duplicateCount: input.duplicateVariationIds.length
      });

      const log = await this.prisma.syncHealthLog.create({
        data: {
          channel: input.channel,
          errorType: 'DUPLICATE_VARIATION',
          severity: 'ERROR',
          errorMessage: `Found ${input.duplicateVariationIds.length} duplicate variations`,
          productId: input.productId,
          variationId: input.primaryVariationId,
          duplicateVariationIds: input.duplicateVariationIds,
          resolutionStatus: 'UNRESOLVED'
        }
      });

      logger.info(`Duplicate variations logged successfully`, {
        logId: log.id,
        duplicateCount: input.duplicateVariationIds.length
      });

      return log;
    } catch (error) {
      logger.error(`Failed to log duplicate variations`, {
        productId: input.productId,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Get all unresolved conflicts
   */
  async getUnresolvedConflicts(channel?: string): Promise<UnresolvedConflict[]> {
    try {
      logger.debug(`Fetching unresolved conflicts`, { channel });

      const conflicts = await this.prisma.syncHealthLog.findMany({
        where: {
          resolutionStatus: 'UNRESOLVED',
          conflictType: { not: null },
          ...(channel && { channel })
        },
        orderBy: [
          { severity: 'desc' },
          { createdAt: 'desc' }
        ]
      });

      logger.info(`Fetched unresolved conflicts`, {
        count: conflicts.length,
        channel
      });

      return conflicts.map(c => ({
        id: c.id,
        channel: c.channel,
        errorType: c.errorType as ErrorType,
        conflictType: c.conflictType as ConflictType | undefined,
        message: c.errorMessage,
        severity: c.severity as Severity,
        productId: c.productId || undefined,
        variationId: c.variationId || undefined,
        createdAt: c.createdAt,
        conflictData: c.conflictData as Record<string, any> | undefined
      }));
    } catch (error) {
      logger.error(`Failed to get unresolved conflicts`, {
        channel,
        error: error instanceof Error ? error.message : String(error)
      });
      return [];
    }
  }

  /**
   * Resolve a conflict
   */
  async resolveConflict(
    logId: string,
    status: ResolutionStatus,
    notes?: string
  ): Promise<SyncHealthLog> {
    try {
      logger.info(`Resolving conflict`, {
        logId,
        status,
        notes
      });

      const log = await this.prisma.syncHealthLog.update({
        where: { id: logId },
        data: {
          resolutionStatus: status,
          resolutionNotes: notes || null,
          resolvedAt: new Date(),
          updatedAt: new Date()
        }
      });

      logger.info(`Conflict resolved successfully`, {
        logId,
        status
      });

      return log;
    } catch (error) {
      logger.error(`Failed to resolve conflict`, {
        logId,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Calculate channel health score
   * Analyzes error ratio and returns 0-100 score
   */
  async calculateChannelHealthScore(channel: string, hoursBack: number = 24): Promise<ChannelHealthScore> {
    try {
      logger.debug(`Calculating health score for channel`, {
        channel,
        hoursBack
      });

      const since = new Date(Date.now() - hoursBack * 60 * 60 * 1000);

      // Get error counts
      const totalErrors = await this.prisma.syncHealthLog.count({
        where: {
          channel,
          createdAt: { gte: since }
        }
      });

      const criticalErrors = await this.prisma.syncHealthLog.count({
        where: {
          channel,
          severity: 'CRITICAL',
          createdAt: { gte: since }
        }
      });

      const unresolvedConflicts = await this.prisma.syncHealthLog.count({
        where: {
          channel,
          conflictType: { not: null },
          resolutionStatus: 'UNRESOLVED',
          createdAt: { gte: since }
        }
      });

      const duplicateVariations = await this.prisma.syncHealthLog.count({
        where: {
          channel,
          errorType: 'DUPLICATE_VARIATION',
          createdAt: { gte: since }
        }
      });

      const successfulSyncs = await this.prisma.marketplaceSync.count({
        where: {
          channel,
          lastSyncStatus: 'SUCCESS',
          lastSyncAt: { gte: since }
        }
      });

      // Calculate metrics
      const totalSyncAttempts = totalErrors + successfulSyncs;
      const successRate = totalSyncAttempts > 0
        ? (successfulSyncs / totalSyncAttempts) * 100
        : 100;

      // Calculate health score (0-100)
      let healthScore = 100;
      healthScore -= Math.min(criticalErrors * 10, 50);
      healthScore -= Math.min(unresolvedConflicts * 5, 25);
      healthScore -= Math.min(duplicateVariations * 2, 20);

      if (successRate < 95) {
        healthScore -= (100 - successRate) * 0.5;
      }

      healthScore = Math.max(0, Math.min(100, healthScore));

      const result: ChannelHealthScore = {
        channel,
        healthScore: Math.round(healthScore),
        totalErrors,
        criticalErrors,
        unresolvedConflicts,
        duplicateVariations,
        successRate: Math.round(successRate * 100) / 100,
        lastUpdated: new Date()
      };

      logger.info(`Health score calculated`, {
        channel,
        healthScore: result.healthScore,
        successRate: result.successRate,
        totalErrors,
        criticalErrors
      });

      return result;
    } catch (error) {
      logger.error(`Failed to calculate health score`, {
        channel,
        error: error instanceof Error ? error.message : String(error)
      });

      return {
        channel,
        healthScore: 0,
        totalErrors: 0,
        criticalErrors: 0,
        unresolvedConflicts: 0,
        duplicateVariations: 0,
        successRate: 0,
        lastUpdated: new Date()
      };
    }
  }

  /**
   * Get health scores for all channels
   */
  async getAllChannelHealthScores(hoursBack: number = 24): Promise<ChannelHealthScore[]> {
    try {
      logger.debug(`Calculating health scores for all channels`, { hoursBack });

      const channels = await this.prisma.syncHealthLog.findMany({
        distinct: ['channel'],
        select: { channel: true }
      });

      const scores = await Promise.all(
        channels.map(c => this.calculateChannelHealthScore(c.channel, hoursBack))
      );

      logger.info(`Health scores calculated for all channels`, {
        channelCount: scores.length
      });

      return scores;
    } catch (error) {
      logger.error(`Failed to get all channel health scores`, {
        error: error instanceof Error ? error.message : String(error)
      });
      return [];
    }
  }

  /**
   * Get error summary for a channel
   */
  async getChannelErrorSummary(
    channel: string,
    hoursBack: number = 24
  ): Promise<Record<ErrorType, number>> {
    try {
      logger.debug(`Getting error summary for channel`, {
        channel,
        hoursBack
      });

      const since = new Date(Date.now() - hoursBack * 60 * 60 * 1000);

      const errorTypes: ErrorType[] = [
        'IMPORT_FAILED',
        'CONFLICT_DETECTED',
        'DUPLICATE_VARIATION',
        'VALIDATION_ERROR',
        'MAPPING_ERROR',
        'RATE_LIMIT',
        'AUTHENTICATION_ERROR'
      ];

      const summary: Record<ErrorType, number> = {} as Record<ErrorType, number>;

      for (const errorType of errorTypes) {
        const count = await this.prisma.syncHealthLog.count({
          where: {
            channel,
            errorType,
            createdAt: { gte: since }
          }
        });
        summary[errorType] = count;
      }

      logger.info(`Error summary retrieved`, {
        channel,
        summary
      });

      return summary;
    } catch (error) {
      logger.error(`Failed to get error summary`, {
        channel,
        error: error instanceof Error ? error.message : String(error)
      });
      return {} as Record<ErrorType, number>;
    }
  }

  /**
   * Get recent errors for a channel
   */
  async getRecentErrors(
    channel: string,
    limit: number = 50,
    hoursBack: number = 24
  ): Promise<SyncHealthLog[]> {
    try {
      logger.debug(`Getting recent errors for channel`, {
        channel,
        limit,
        hoursBack
      });

      const since = new Date(Date.now() - hoursBack * 60 * 60 * 1000);

      const errors = await this.prisma.syncHealthLog.findMany({
        where: {
          channel,
          createdAt: { gte: since }
        },
        orderBy: { createdAt: 'desc' },
        take: limit
      });

      logger.info(`Recent errors retrieved`, {
        channel,
        count: errors.length
      });

      return errors;
    } catch (error) {
      logger.error(`Failed to get recent errors`, {
        channel,
        error: error instanceof Error ? error.message : String(error)
      });
      return [];
    }
  }

  /**
   * Get errors for a specific product
   */
  async getProductErrors(productId: string): Promise<SyncHealthLog[]> {
    try {
      logger.debug(`Getting errors for product`, { productId });

      const errors = await this.prisma.syncHealthLog.findMany({
        where: { productId },
        orderBy: { createdAt: 'desc' }
      });

      logger.info(`Product errors retrieved`, {
        productId,
        count: errors.length
      });

      return errors;
    } catch (error) {
      logger.error(`Failed to get product errors`, {
        productId,
        error: error instanceof Error ? error.message : String(error)
      });
      return [];
    }
  }

  /**
   * Get errors for a specific variation
   */
  async getVariationErrors(variationId: string): Promise<SyncHealthLog[]> {
    try {
      logger.debug(`Getting errors for variation`, { variationId });

      const errors = await this.prisma.syncHealthLog.findMany({
        where: { variationId },
        orderBy: { createdAt: 'desc' }
      });

      logger.info(`Variation errors retrieved`, {
        variationId,
        count: errors.length
      });

      return errors;
    } catch (error) {
      logger.error(`Failed to get variation errors`, {
        variationId,
        error: error instanceof Error ? error.message : String(error)
      });
      return [];
    }
  }

  /**
   * Clear resolved logs older than specified days
   */
  async clearResolvedLogs(daysOld: number = 30): Promise<number> {
    try {
      logger.info(`Clearing resolved logs older than ${daysOld} days`);

      const cutoffDate = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000);

      const result = await this.prisma.syncHealthLog.deleteMany({
        where: {
          resolutionStatus: { not: 'UNRESOLVED' },
          resolvedAt: { lt: cutoffDate }
        }
      });

      logger.info(`Resolved logs cleared`, {
        deletedCount: result.count
      });

      return result.count;
    } catch (error) {
      logger.error(`Failed to clear resolved logs`, {
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }
}
