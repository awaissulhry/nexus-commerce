/**
 * How each channel reports its rate headroom, as plain functions with no other imports. The connector
 * specs use them (`rateLimit.parse`) and so does the channel gateway (services/gateway/channels.ts),
 * which must not depend on the specs having been loaded first.
 */
import type { RateLimitReading } from './catalog.js'

/** Amazon SP-API: `x-amzn-RateLimit-Limit` is the operation's sustained rate (requests per second). */
export function amazonSpRateReading(headers: Headers, status: number): RateLimitReading | null {
  const rate = headers.get('x-amzn-ratelimit-limit')
  if (status === 429) return { model: 'token_bucket', retryAfterSec: rate ? Math.ceil(1 / Number(rate)) : undefined }
  return rate ? { model: 'token_bucket', limit: Number(rate) } : null
}

/** eBay: daily quotas; only a 429 / Retry-After says anything per call. */
export function ebayRateReading(headers: Headers, status: number): RateLimitReading | null {
  const retryAfter = headers.get('retry-after')
  if (status === 429 || retryAfter) {
    return { model: 'daily_quota', retryAfterSec: retryAfter ? Number(retryAfter) : undefined }
  }
  return null
}

/** Shopify REST: `x-shopify-shop-api-call-limit: used/max`. GraphQL reports its cost in the body instead. */
export function shopifyRateReading(headers: Headers, status: number): RateLimitReading | null {
  const call = headers.get('x-shopify-shop-api-call-limit')
  if (call) {
    const [used, max] = call.split('/').map(Number)
    return { model: 'leaky_bucket', remaining: max - used, limit: max, retryAfterSec: status === 429 ? Number(headers.get('retry-after') ?? 1) : undefined }
  }
  return status === 429 ? { model: 'points', retryAfterSec: 1 } : null
}

/** Amazon Ads: only a 429 with its Retry-After. */
export function amazonAdsRateReading(headers: Headers, status: number): RateLimitReading | null {
  return status === 429 ? { model: 'token_bucket', retryAfterSec: Number(headers.get('retry-after') ?? 0) || undefined } : null
}
