/**
 * RX.1b — Amazon "Voice of the Customer" / review-feed adapter (live).
 *
 * Reality: Amazon exposes **no** official customer-review-text API. SP-API
 * Brand Analytics returns search/catalog metrics, not review bodies, and
 * scraping the storefront is against Amazon's ToS. The compliant ways to
 * get real Amazon review text are (a) operator export from Seller Central
 * Voice-of-the-Customer → the RX.1a import pipeline, or (b) a **licensed
 * third-party feed** (Helium10 / Jungle Scout / DataHawk) the seller
 * already pays for.
 *
 * This adapter implements (b): when NEXUS_AMAZON_REVIEW_FEED_URL points at
 * a JSON feed of reviews, it fetches + maps them. Otherwise it's a no-op
 * with an explanatory note (import remains the fallback). Read-only;
 * never throws past its boundary.
 *
 * Expected feed shape (flexible — common field names are auto-detected):
 *   [{ id|reviewId, asin, sku?, rating|stars, title?, body|text|content,
 *      author|reviewer?, date|reviewDate, verified?, marketplace? }, ...]
 */

import { logger } from '../../../utils/logger.js'
import type { AdapterRawReview, AdapterResult } from './types.js'

function pick(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    if (obj[k] != null && obj[k] !== '') return obj[k]
  }
  return undefined
}

function toRating(v: unknown): number | undefined {
  if (v == null || v === '') return undefined
  const m = String(v).match(/(\d+(?:[.,]\d+)?)/)
  if (!m) return undefined
  const n = Number(m[1].replace(',', '.'))
  return Number.isFinite(n) ? Math.min(5, Math.max(1, Math.round(n))) : undefined
}

export interface AmazonVocOptions {
  marketplace?: string | null
}

export async function fetchAmazonVocFeed(opts: AmazonVocOptions = {}): Promise<AdapterResult> {
  const feedUrl = process.env.NEXUS_AMAZON_REVIEW_FEED_URL
  if (!feedUrl) {
    return {
      reviews: [],
      note: 'no Amazon review feed configured (NEXUS_AMAZON_REVIEW_FEED_URL); use import',
    }
  }

  const reviews: AdapterRawReview[] = []
  try {
    const url = opts.marketplace
      ? `${feedUrl}${feedUrl.includes('?') ? '&' : '?'}marketplace=${encodeURIComponent(opts.marketplace)}`
      : feedUrl
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (process.env.NEXUS_AMAZON_REVIEW_FEED_TOKEN) {
      headers.Authorization = `Bearer ${process.env.NEXUS_AMAZON_REVIEW_FEED_TOKEN}`
    }
    const res = await fetch(url, { headers })
    if (!res.ok) {
      return { reviews, error: `feed HTTP ${res.status}` }
    }
    const json = (await res.json()) as unknown
    const rows: Record<string, unknown>[] = Array.isArray(json)
      ? (json as Record<string, unknown>[])
      : Array.isArray((json as Record<string, unknown>)?.reviews)
        ? ((json as Record<string, unknown>).reviews as Record<string, unknown>[])
        : []

    for (const r of rows) {
      const body = pick(r, ['body', 'text', 'content', 'reviewBody', 'comment'])
      const externalReviewId = pick(r, ['id', 'reviewId', 'externalReviewId'])
      if (!body || !externalReviewId) continue
      const dateRaw = pick(r, ['date', 'reviewDate', 'postedAt', 'createdAt'])
      const postedAt = dateRaw ? new Date(String(dateRaw)) : new Date()
      reviews.push({
        externalReviewId: String(externalReviewId),
        channel: 'AMAZON',
        marketplace:
          (pick(r, ['marketplace', 'market', 'country']) as string | undefined) ??
          (opts.marketplace ?? undefined),
        asin: pick(r, ['asin']) ? String(pick(r, ['asin'])) : undefined,
        sku: pick(r, ['sku', 'sellerSku']) ? String(pick(r, ['sku', 'sellerSku'])) : undefined,
        rating: toRating(pick(r, ['rating', 'stars', 'starRating', 'score'])),
        title: pick(r, ['title', 'reviewTitle']) ? String(pick(r, ['title', 'reviewTitle'])) : undefined,
        body: String(body),
        authorName: pick(r, ['author', 'reviewer', 'authorName']) ? String(pick(r, ['author', 'reviewer', 'authorName'])) : undefined,
        verifiedPurchase: Boolean(pick(r, ['verified', 'verifiedPurchase'])),
        postedAt: Number.isNaN(postedAt.getTime()) ? new Date().toISOString() : postedAt.toISOString(),
        rawPayload: r,
      })
    }
  } catch (err) {
    return { reviews, error: err instanceof Error ? err.message : String(err) }
  }

  logger.info('[amazon-voc] fetched from feed', { count: reviews.length })
  return { reviews }
}
