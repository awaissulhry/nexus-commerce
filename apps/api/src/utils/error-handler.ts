/**
 * Error Handling Framework
 * Comprehensive error handling and retry logic for marketplace integrations
 */

import { SyncErrorType, SyncErrorContext, MarketplaceChannel } from "../types/marketplace.js";

/**
 * Marketplace sync error class
 */
export class MarketplaceSyncError extends Error {
  constructor(
    public channel: MarketplaceChannel,
    public errorType: SyncErrorType,
    message: string,
    public context?: SyncErrorContext,
    public statusCode?: number
  ) {
    super(message);
    this.name = "MarketplaceSyncError";
  }
}

/**
 * Error classifier and handler
 */
export class ErrorHandler {
  /**
   * Classify error type based on error message and status code
   */
  static classifyError(error: Error | unknown, statusCode?: number): SyncErrorType {
    const message = error instanceof Error ? error.message : String(error);

    // Rate limit errors
    if (statusCode === 429 || message.includes("rate limit") || message.includes("too many")) {
      return "RATE_LIMIT";
    }

    // Authentication errors
    if (
      statusCode === 401 ||
      statusCode === 403 ||
      message.includes("unauthorized") ||
      message.includes("forbidden") ||
      message.includes("authentication")
    ) {
      return "AUTHENTICATION";
    }

    // Validation errors
    if (
      statusCode === 400 ||
      message.includes("invalid") ||
      message.includes("validation") ||
      message.includes("bad request")
    ) {
      return "VALIDATION";
    }

    // Network errors
    if (
      message.includes("ECONNREFUSED") ||
      message.includes("ENOTFOUND") ||
      message.includes("ETIMEDOUT") ||
      message.includes("network")
    ) {
      return "NETWORK";
    }

    // Timeout errors
    if (
      statusCode === 408 ||
      message.includes("timeout") ||
      message.includes("timed out")
    ) {
      return "TIMEOUT";
    }

    // Conflict errors
    if (statusCode === 409 || message.includes("conflict")) {
      return "CONFLICT";
    }

    // Not found errors
    if (statusCode === 404 || message.includes("not found")) {
      return "NOT_FOUND";
    }

    return "UNKNOWN";
  }

  /**
   * Determine if an error is retryable
   */
  static isRetryable(errorType: SyncErrorType): boolean {
    const retryableErrors: SyncErrorType[] = [
      "RATE_LIMIT",
      "NETWORK",
      "TIMEOUT",
      "UNKNOWN",
    ];
    return retryableErrors.includes(errorType);
  }

  /**
   * Get recommended retry delay based on error type
   */
  static getRetryDelay(
    errorType: SyncErrorType,
    attemptNumber: number,
    initialDelayMs: number = 1000,
    maxDelayMs: number = 32000
  ): number {
    // Rate limit errors should have longer delays
    if (errorType === "RATE_LIMIT") {
      const delay = initialDelayMs * Math.pow(2, attemptNumber + 1);
      return Math.min(delay, maxDelayMs);
    }

    // Other retryable errors use standard exponential backoff
    const delay = initialDelayMs * Math.pow(2, attemptNumber);
    return Math.min(delay, maxDelayMs);
  }

  /**
   * Format error for logging
   */
  static formatError(error: Error | unknown): string {
    if (error instanceof MarketplaceSyncError) {
      return `[${error.channel}] ${error.errorType}: ${error.message}`;
    }

    if (error instanceof Error) {
      return `${error.name}: ${error.message}`;
    }

    return String(error);
  }

  /**
   * Extract error details for database storage
   */
  static extractErrorDetails(error: Error | unknown): {
    message: string;
    stack?: string;
  } {
    if (error instanceof Error) {
      return {
        message: error.message,
        stack: error.stack,
      };
    }

    return {
      message: String(error),
    };
  }
}

/**
 * Retry policy configuration
 */
export interface RetryPolicy {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  retryableErrors: SyncErrorType[];
}

/**
 * Default retry policies for different scenarios
 */
export const DEFAULT_RETRY_POLICIES: Record<string, RetryPolicy> = {
  // Aggressive retry for rate limits
  RATE_LIMIT: {
    maxRetries: 5,
    initialDelayMs: 2000,
    maxDelayMs: 60000,
    backoffMultiplier: 2,
    retryableErrors: ["RATE_LIMIT"],
  },

  // Standard retry for transient errors
  TRANSIENT: {
    maxRetries: 3,
    initialDelayMs: 1000,
    maxDelayMs: 32000,
    backoffMultiplier: 2,
    retryableErrors: ["NETWORK", "TIMEOUT", "UNKNOWN"],
  },

  // No retry for permanent errors
  PERMANENT: {
    maxRetries: 0,
    initialDelayMs: 0,
    maxDelayMs: 0,
    backoffMultiplier: 1,
    retryableErrors: [],
  },

  // Aggressive retry for all retryable errors
  AGGRESSIVE: {
    maxRetries: 5,
    initialDelayMs: 500,
    maxDelayMs: 30000,
    backoffMultiplier: 2,
    retryableErrors: ["RATE_LIMIT", "NETWORK", "TIMEOUT", "UNKNOWN"],
  },
};

/**
 * Retry executor with comprehensive error handling
 */
export class RetryExecutor {
  constructor(private policy: RetryPolicy = DEFAULT_RETRY_POLICIES.TRANSIENT) {}

  /**
   * Execute function with retry logic
   */
  async execute<T>(
    fn: () => Promise<T>,
    context?: SyncErrorContext,
    onRetry?: (attempt: number, error: Error, delay: number) => void
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.policy.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        const statusCode = (error as any)?.statusCode;
        const errorType = ErrorHandler.classifyError(err, statusCode);

        lastError = err;

        // Check if error is retryable
        if (!this.policy.retryableErrors.includes(errorType) || attempt === this.policy.maxRetries) {
          const channel = (context?.channelId as MarketplaceChannel) || "AMAZON";
          throw new MarketplaceSyncError(
            channel,
            errorType,
            err.message,
            context,
            statusCode
          );
        }

        // Calculate delay
        const delay = ErrorHandler.getRetryDelay(
          errorType,
          attempt,
          this.policy.initialDelayMs,
          this.policy.maxDelayMs
        );

        onRetry?.(attempt + 1, err, delay);

        // Wait before retry
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw lastError || new Error("Max retries exceeded");
  }

  /**
   * Set retry policy
   */
  setPolicy(policy: RetryPolicy): void {
    this.policy = policy;
  }

  /**
   * Get current retry policy
   */
  getPolicy(): RetryPolicy {
    return this.policy;
  }
}

/**
 * Circuit breaker pattern for failing services
 */
export class CircuitBreaker {
  private failureCount: number = 0;
  private lastFailureTime: number = 0;
  private state: "CLOSED" | "OPEN" | "HALF_OPEN" = "CLOSED";

  constructor(
    private failureThreshold: number = 5,
    private resetTimeoutMs: number = 60000
  ) {}

  /**
   * Check if circuit is open
   */
  isOpen(): boolean {
    if (this.state === "OPEN") {
      // Check if we should transition to HALF_OPEN
      if (Date.now() - this.lastFailureTime > this.resetTimeoutMs) {
        this.state = "HALF_OPEN";
        return false;
      }
      return true;
    }
    return false;
  }

  /**
   * Record a failure
   */
  recordFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.failureCount >= this.failureThreshold) {
      this.state = "OPEN";
    }
  }

  /**
   * Record a success
   */
  recordSuccess(): void {
    this.failureCount = 0;
    this.state = "CLOSED";
  }

  /**
   * Get circuit state
   */
  getState(): "CLOSED" | "OPEN" | "HALF_OPEN" {
    return this.state;
  }

  /**
   * Reset circuit
   */
  reset(): void {
    this.failureCount = 0;
    this.state = "CLOSED";
  }
}

/**
 * Error logger for persistent storage
 */
export class ErrorLogger {
  /**
   * Log error to database
   */
  static async logError(
    db: any,
    channel: MarketplaceChannel,
    errorType: SyncErrorType,
    errorMessage: string,
    context?: SyncErrorContext,
    errorStack?: string
  ): Promise<void> {
    try {
      await db.syncError.create({
        data: {
          channel,
          errorType,
          errorMessage,
          errorStack,
          context,
          retryCount: 0,
          maxRetries: 3,
          nextRetryAt: new Date(Date.now() + 60000), // Retry in 1 minute
        },
      });
    } catch (error) {
      console.error("[ErrorLogger] Failed to log error:", error);
    }
  }

  /**
   * Update error retry count
   */
  static async updateErrorRetry(
    db: any,
    errorId: string,
    retryCount: number,
    nextRetryAt?: Date
  ): Promise<void> {
    try {
      await db.syncError.update({
        where: { id: errorId },
        data: {
          retryCount,
          nextRetryAt,
        },
      });
    } catch (error) {
      console.error("[ErrorLogger] Failed to update error:", error);
    }
  }

  /**
   * Mark error as resolved
   */
  static async resolveError(db: any, errorId: string): Promise<void> {
    try {
      await db.syncError.update({
        where: { id: errorId },
        data: {
          resolvedAt: new Date(),
        },
      });
    } catch (error) {
      console.error("[ErrorLogger] Failed to resolve error:", error);
    }
  }
}
