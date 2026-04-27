/**
 * Rate Limiter Utility
 * Implements token bucket algorithm with exponential backoff for marketplace APIs
 */

import { RateLimitConfig, RateLimitState, MarketplaceChannel } from "../types/marketplace.js";

export interface RateLimitBucket {
  tokens: number;
  lastRefillAt: number;
  resetAt: number;
}

export class RateLimiter {
  private buckets: Map<string, RateLimitBucket> = new Map();
  private readonly configs: Map<MarketplaceChannel, RateLimitConfig> = new Map([
    [
      "SHOPIFY",
      {
        requestsPerSecond: 2,
        burstSize: 40,
        windowMs: 60000, // 1 minute
      },
    ],
    [
      "WOOCOMMERCE",
      {
        requestsPerSecond: 10,
        burstSize: 100,
        windowMs: 10000, // 10 seconds
      },
    ],
    [
      "ETSY",
      {
        requestsPerSecond: 10,
        burstSize: 100,
        windowMs: 10000, // 10 seconds
      },
    ],
    [
      "AMAZON",
      {
        requestsPerSecond: 2,
        burstSize: 40,
        windowMs: 60000, // 1 minute
      },
    ],
    [
      "EBAY",
      {
        requestsPerSecond: 10,
        burstSize: 100,
        windowMs: 10000, // 10 seconds
      },
    ],
  ]);

  /**
   * Get or create a rate limit bucket for a channel/endpoint
   */
  private getBucket(key: string): RateLimitBucket {
    if (!this.buckets.has(key)) {
      const now = Date.now();
      this.buckets.set(key, {
        tokens: 0,
        lastRefillAt: now,
        resetAt: now + 60000,
      });
    }
    return this.buckets.get(key)!;
  }

  /**
   * Refill tokens based on elapsed time
   */
  private refillTokens(bucket: RateLimitBucket, config: RateLimitConfig): void {
    const now = Date.now();
    const elapsedMs = now - bucket.lastRefillAt;
    const tokensToAdd = (elapsedMs / 1000) * config.requestsPerSecond;

    bucket.tokens = Math.min(bucket.tokens + tokensToAdd, config.burstSize);
    bucket.lastRefillAt = now;

    // Reset window if expired
    if (now >= bucket.resetAt) {
      bucket.resetAt = now + config.windowMs;
    }
  }

  /**
   * Check if a request can be made without waiting
   */
  canMakeRequest(channel: MarketplaceChannel, endpoint: string = "default"): boolean {
    const config = this.configs.get(channel);
    if (!config) {
      throw new Error(`Unknown marketplace channel: ${channel}`);
    }

    const key = `${channel}:${endpoint}`;
    const bucket = this.getBucket(key);

    this.refillTokens(bucket, config);

    return bucket.tokens >= 1;
  }

  /**
   * Consume a token and return wait time if rate limited
   */
  async consumeToken(
    channel: MarketplaceChannel,
    endpoint: string = "default"
  ): Promise<number> {
    const config = this.configs.get(channel);
    if (!config) {
      throw new Error(`Unknown marketplace channel: ${channel}`);
    }

    const key = `${channel}:${endpoint}`;
    const bucket = this.getBucket(key);

    this.refillTokens(bucket, config);

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return 0; // No wait needed
    }

    // Calculate wait time until next token is available
    const tokensNeeded = 1 - bucket.tokens;
    const waitTimeMs = (tokensNeeded / config.requestsPerSecond) * 1000;

    return Math.ceil(waitTimeMs);
  }

  /**
   * Get current rate limit state
   */
  getState(channel: MarketplaceChannel, endpoint: string = "default"): RateLimitState {
    const config = this.configs.get(channel);
    if (!config) {
      throw new Error(`Unknown marketplace channel: ${channel}`);
    }

    const key = `${channel}:${endpoint}`;
    const bucket = this.getBucket(key);

    this.refillTokens(bucket, config);

    const isLimited = bucket.tokens < 1;
    const retryAfter = isLimited
      ? Math.ceil(((1 - bucket.tokens) / config.requestsPerSecond) * 1000)
      : undefined;

    return {
      channel,
      endpoint,
      requestCount: Math.floor(config.burstSize - bucket.tokens),
      resetAt: new Date(bucket.resetAt),
      isLimited,
      retryAfter,
    };
  }

  /**
   * Reset rate limit for a channel
   */
  reset(channel: MarketplaceChannel, endpoint?: string): void {
    if (endpoint) {
      const key = `${channel}:${endpoint}`;
      this.buckets.delete(key);
    } else {
      // Reset all endpoints for this channel
      const keysToDelete = Array.from(this.buckets.keys()).filter((k) =>
        k.startsWith(`${channel}:`)
      );
      keysToDelete.forEach((k) => this.buckets.delete(k));
    }
  }

  /**
   * Clear all rate limit data
   */
  clear(): void {
    this.buckets.clear();
  }
}

/**
 * Exponential backoff calculator
 */
export class ExponentialBackoff {
  constructor(
    private initialDelayMs: number = 1000,
    private maxDelayMs: number = 32000,
    private multiplier: number = 2
  ) {}

  /**
   * Calculate delay for a given attempt number
   */
  getDelay(attemptNumber: number): number {
    const delay = this.initialDelayMs * Math.pow(this.multiplier, attemptNumber);
    return Math.min(delay, this.maxDelayMs);
  }

  /**
   * Calculate delay with jitter to prevent thundering herd
   */
  getDelayWithJitter(attemptNumber: number): number {
    const delay = this.getDelay(attemptNumber);
    const jitter = Math.random() * delay * 0.1; // 10% jitter
    return Math.ceil(delay + jitter);
  }

  /**
   * Wait for the calculated delay
   */
  async wait(attemptNumber: number): Promise<void> {
    const delay = this.getDelayWithJitter(attemptNumber);
    return new Promise((resolve) => setTimeout(resolve, delay));
  }
}

/**
 * Retry helper with exponential backoff
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  initialDelayMs: number = 1000,
  maxDelayMs: number = 32000,
  multiplier: number = 2,
  onRetry?: (attempt: number, error: Error) => void
): Promise<T> {
  const backoff = new ExponentialBackoff(initialDelayMs, maxDelayMs, multiplier);

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === maxRetries - 1) {
        throw error;
      }

      const err = error instanceof Error ? error : new Error(String(error));
      onRetry?.(attempt + 1, err);

      await backoff.wait(attempt);
    }
  }

  throw new Error("Max retries exceeded");
}

// Export singleton instance
export const rateLimiter = new RateLimiter();
