/**
 * Validation Schemas
 * Zod schemas for request validation across all routes
 */

import { z } from 'zod';

// ============================================================================
// Bulk Actions Validation
// ============================================================================

export const CreateBulkJobSchema = z.object({
  jobName: z.string().min(1, 'Job name is required').max(255),
  actionType: z.enum(['PRICING_UPDATE', 'INVENTORY_UPDATE', 'STATUS_UPDATE', 'ATTRIBUTE_UPDATE', 'LISTING_SYNC']),
  channel: z.string().optional(),
  targetProductIds: z.array(z.string()).optional(),
  targetVariationIds: z.array(z.string()).optional(),
  filters: z.record(z.string(), z.any()).optional(),
  actionPayload: z.record(z.string(), z.any()),
  createdBy: z.string().optional()
});

export type CreateBulkJobRequest = z.infer<typeof CreateBulkJobSchema>;

export const ProcessBulkJobSchema = z.object({
  jobId: z.string().min(1, 'Job ID is required')
});

export type ProcessBulkJobRequest = z.infer<typeof ProcessBulkJobSchema>;

// ============================================================================
// Pricing Rules Validation
// ============================================================================

export const CreatePricingRuleSchema = z.object({
  name: z.string().min(1, 'Rule name is required').max(255),
  type: z.enum(['MATCH_LOW', 'PERCENTAGE_BELOW', 'COST_PLUS_MARGIN', 'FIXED_PRICE', 'DYNAMIC_MARGIN']),
  description: z.string().optional(),
  priority: z.number().int().min(0, 'Priority must be >= 0'),
  minMarginPercent: z.number().optional(),
  maxMarginPercent: z.number().optional(),
  parameters: z.record(z.string(), z.any()),
  productIds: z.array(z.string()).optional(),
  variationIds: z.array(z.string()).optional()
});

export type CreatePricingRuleRequest = z.infer<typeof CreatePricingRuleSchema>;

export const EvaluatePriceSchema = z.object({
  variationId: z.string().min(1, 'Variation ID is required'),
  currentPrice: z.union([z.number(), z.string()]),
  competitorPrice: z.union([z.number(), z.string()]).optional(),
  costPrice: z.union([z.number(), z.string()])
});

export type EvaluatePriceRequest = z.infer<typeof EvaluatePriceSchema>;

// ============================================================================
// Sync Health Validation
// ============================================================================

export const LogErrorSchema = z.object({
  errorType: z.enum([
    'IMPORT_FAILED',
    'CONFLICT_DETECTED',
    'DUPLICATE_VARIATION',
    'VALIDATION_ERROR',
    'MAPPING_ERROR',
    'RATE_LIMIT',
    'AUTHENTICATION_ERROR'
  ]),
  severity: z.enum(['INFO', 'WARNING', 'ERROR', 'CRITICAL']),
  channel: z.string().min(1, 'Channel is required'),
  message: z.string().min(1, 'Message is required'),
  productId: z.string().optional(),
  variationId: z.string().optional(),
  errorDetails: z.record(z.string(), z.any()).optional(),
  syncJobId: z.string().optional()
});

export type LogErrorRequest = z.infer<typeof LogErrorSchema>;

export const ResolveConflictSchema = z.object({
  logId: z.string().min(1, 'Log ID is required'),
  status: z.enum(['AUTO_RESOLVED', 'MANUAL_RESOLVED', 'IGNORED']),
  notes: z.string().optional()
});

export type ResolveConflictRequest = z.infer<typeof ResolveConflictSchema>;

// ============================================================================
// Query Parameter Validation
// ============================================================================

export const ChannelQuerySchema = z.object({
  channel: z.string().optional()
});

export type ChannelQuery = z.infer<typeof ChannelQuerySchema>;

export const PaginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0)
});

export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;

export const HealthScoreQuerySchema = z.object({
  hoursBack: z.coerce.number().int().min(1).max(720).default(24)
});

export type HealthScoreQuery = z.infer<typeof HealthScoreQuerySchema>;
