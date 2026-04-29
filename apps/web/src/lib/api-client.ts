/**
 * API Client
 * Type-safe Axios wrapper for backend API integration
 * Handles response unwrapping and error handling
 */

import axios, { AxiosInstance, AxiosError } from 'axios';
import { getBackendUrl } from '@/lib/backend-url';

// ============================================================================
// Response Types (matching backend ApiResponse<T>)
// ============================================================================

export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: Record<string, any>;
  };
  meta?: {
    timestamp: string;
    path?: string;
  };
}

export interface PaginatedResponse<T = any> extends ApiResponse<T[]> {
  meta?: {
    timestamp: string;
    path?: string;
    pagination?: {
      total: number;
      limit: number;
      offset: number;
      hasMore: boolean;
    };
  };
}

// ============================================================================
// Sync Health Types
// ============================================================================

export interface ChannelHealthScore {
  channel: string;
  healthScore: number;
  totalErrors: number;
  criticalErrors: number;
  unresolvedConflicts: number;
  duplicateVariations: number;
  successRate: number;
  lastUpdated: string;
}

export interface UnresolvedConflict {
  id: string;
  channel: string;
  errorType: string;
  conflictType?: string;
  message: string;
  severity: 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';
  productId?: string;
  variationId?: string;
  createdAt: string;
  conflictData?: Record<string, any>;
}

export interface SyncError {
  id: string;
  channel: string;
  errorType: string;
  severity: 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';
  errorMessage: string;
  productId?: string;
  variationId?: string;
  createdAt: string;
  errorDetails?: Record<string, any>;
}

export interface ResolveConflictPayload {
  status: 'AUTO_RESOLVED' | 'MANUAL_RESOLVED' | 'IGNORED';
  notes?: string;
}

// ============================================================================
// Bulk Action Types
// ============================================================================

export interface BulkActionJob {
  id: string;
  jobName: string;
  actionType: string;
  channel?: string;
  status: 'PENDING' | 'QUEUED' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'PARTIALLY_COMPLETED' | 'CANCELLED';
  totalItems: number;
  processedItems: number;
  failedItems: number;
  skippedItems: number;
  progressPercent: number;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

// ============================================================================
// Pricing Rule Types
// ============================================================================

export interface PricingRule {
  id: string;
  name: string;
  type: string;
  description?: string;
  priority: number;
  minMarginPercent?: number;
  maxMarginPercent?: number;
  parameters: Record<string, any>;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PriceEvaluationResult {
  originalPrice: string;
  calculatedPrice: string;
  appliedRuleId?: string;
  appliedRuleName?: string;
  marginPercent: number;
  isValid: boolean;
  reason?: string;
}

// ============================================================================
// API Client Class
// ============================================================================

class ApiClient {
  private client: AxiosInstance;
  private baseURL: string;

  constructor(baseURL: string = getBackendUrl()) {
    this.baseURL = baseURL;

    this.client = axios.create({
      baseURL: this.baseURL,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    // Response interceptor to unwrap data
    this.client.interceptors.response.use(
      (response) => response.data,
      (error) => this.handleError(error)
    );
  }

  /**
   * Handle API errors and throw structured error messages
   */
  private handleError(error: AxiosError<ApiResponse>): never {
    if (error.response?.data?.error) {
      const apiError = error.response.data.error;
      throw new Error(apiError.message || 'An error occurred');
    }

    if (error.message) {
      throw new Error(error.message);
    }

    throw new Error('An unexpected error occurred');
  }

  /**
   * Generic GET request
   */
  async get<T>(url: string, params?: Record<string, any>): Promise<T> {
    const response = await this.client.get<ApiResponse<T>>(url, { params });
    return response.data as T;
  }

  /**
   * Generic POST request
   */
  async post<T>(url: string, data?: any): Promise<T> {
    const response = await this.client.post<ApiResponse<T>>(url, data);
    return response.data as T;
  }

  /**
   * Generic PUT request
   */
  async put<T>(url: string, data?: any): Promise<T> {
    const response = await this.client.put<ApiResponse<T>>(url, data);
    return response.data as T;
  }

  /**
   * Generic DELETE request
   */
  async delete<T>(url: string): Promise<T> {
    const response = await this.client.delete<ApiResponse<T>>(url);
    return response.data as T;
  }

  // ========================================================================
  // Sync Health Endpoints
  // ========================================================================

  /**
   * Get health score for a specific channel
   */
  async getHealthScore(channel: string, hoursBack: number = 24): Promise<ChannelHealthScore> {
    return this.get<ChannelHealthScore>(`/sync-health/${channel}/score`, { hoursBack });
  }

  /**
   * Get all unresolved conflicts
   */
  async getConflicts(channel?: string): Promise<UnresolvedConflict[]> {
    return this.get<UnresolvedConflict[]>('/sync-health/conflicts', { channel });
  }

  /**
   * Get recent errors for a channel
   */
  async getErrors(channel: string, limit: number = 50, hoursBack: number = 24): Promise<SyncError[]> {
    return this.get<SyncError[]>(`/sync-health/errors/${channel}`, { limit, hoursBack });
  }

  /**
   * Resolve a conflict
   */
  async resolveConflict(logId: string, payload: ResolveConflictPayload): Promise<SyncError> {
    return this.post<SyncError>(`/sync-health/conflicts/${logId}/resolve`, payload);
  }

  /**
   * Log a new error
   */
  async logError(data: {
    errorType: string;
    severity: 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';
    channel: string;
    message: string;
    productId?: string;
    variationId?: string;
    errorDetails?: Record<string, any>;
  }): Promise<SyncError> {
    return this.post<SyncError>('/sync-health/log', data);
  }

  /**
   * Get health scores for all channels
   */
  async getAllHealthScores(hoursBack: number = 24): Promise<ChannelHealthScore[]> {
    return this.get<ChannelHealthScore[]>('/sync-health/summary', { hoursBack });
  }

  // ========================================================================
  // Bulk Actions Endpoints
  // ========================================================================

  /**
   * Create a new bulk action job
   */
  async createBulkJob(data: {
    jobName: string;
    actionType: string;
    channel?: string;
    targetProductIds?: string[];
    targetVariationIds?: string[];
    actionPayload: Record<string, any>;
  }): Promise<BulkActionJob> {
    return this.post<BulkActionJob>('/bulk-actions', data);
  }

  /**
   * Get bulk job status
   */
  async getBulkJobStatus(jobId: string): Promise<BulkActionJob> {
    return this.get<BulkActionJob>(`/bulk-actions/${jobId}`);
  }

  /**
   * Start processing a bulk job
   */
  async processBulkJob(jobId: string): Promise<{ jobId: string; status: string; message: string }> {
    return this.post(`/bulk-actions/${jobId}/process`, {});
  }

  /**
   * Get all pending bulk jobs
   */
  async getPendingBulkJobs(): Promise<BulkActionJob[]> {
    return this.get<BulkActionJob[]>('/bulk-actions');
  }

  /**
   * Cancel a bulk job
   */
  async cancelBulkJob(jobId: string): Promise<BulkActionJob> {
    return this.post<BulkActionJob>(`/bulk-actions/${jobId}/cancel`, {});
  }

  // ========================================================================
  // Pricing Rules Endpoints
  // ========================================================================

  /**
   * Create a new pricing rule
   */
  async createPricingRule(data: {
    name: string;
    type: string;
    description?: string;
    priority: number;
    minMarginPercent?: number;
    maxMarginPercent?: number;
    parameters: Record<string, any>;
    productIds?: string[];
    variationIds?: string[];
  }): Promise<PricingRule> {
    return this.post<PricingRule>('/pricing-rules', data);
  }

  /**
   * Get all active pricing rules
   */
  async getPricingRules(): Promise<PricingRule[]> {
    return this.get<PricingRule[]>('/pricing-rules');
  }

  /**
   * Get rules for a specific variation
   */
  async getVariationRules(variationId: string): Promise<PricingRule[]> {
    return this.get<PricingRule[]>(`/pricing-rules/variation/${variationId}`);
  }

  /**
   * Evaluate price based on rules
   */
  async evaluatePrice(data: {
    variationId: string;
    currentPrice: number | string;
    competitorPrice?: number | string;
    costPrice: number | string;
  }): Promise<PriceEvaluationResult> {
    return this.post<PriceEvaluationResult>('/pricing-rules/evaluate', data);
  }

  /**
   * Update a pricing rule
   */
  async updatePricingRule(ruleId: string, data: Partial<PricingRule>): Promise<PricingRule> {
    return this.put<PricingRule>(`/pricing-rules/${ruleId}`, data);
  }

  /**
   * Deactivate a pricing rule
   */
  async deactivatePricingRule(ruleId: string): Promise<PricingRule> {
    return this.delete<PricingRule>(`/pricing-rules/${ruleId}`);
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

export const apiClient = new ApiClient();

export default apiClient;
