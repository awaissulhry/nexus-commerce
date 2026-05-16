/**
 * SR.1 — Review ingest pipeline.
 *
 * Pulls reviews per marketplace, writes Review rows, fires the
 * sentiment classifier, persists ReviewSentiment, and bumps the
 * rolling ReviewCategoryRate counters.
 *
 * Channel sources:
 *   AMAZON   — Amazon's customer-review text isn't directly exposed
 *              via SP-API. Brand Analytics has a "Catalog Performance"
 *              feed with star averages but not review bodies. Real
 *              implementations either (a) scrape via authenticated
 *              session (TOS-grey) or (b) use a third-party feed
 *              (Helium10/Jungle Scout) under license. This service
 *              ships with sandbox fixtures so the loop runs end-to-end;
 *              the live HTTP path is intentionally stubbed.
 *   EBAY/SHOPIFY — webhook-driven (future). Stub returns no rows.
 *
 * Idempotent on (channel, externalReviewId) — re-running the cron is
 * safe. New reviews flow through sentiment extraction; existing rows
 * skip unless `force=true`.
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import {
  extractSentiment,
  persistSentiment,
  type ExtractResult,
} from './sentiment-extraction.service.js'

const FIXTURE_DIR =
  process.env.NEXUS_REVIEW_FIXTURE_DIR ??
  path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__')

interface RawReview {
  externalReviewId: string
  channel: string
  marketplace?: string
  asin?: string
  sku?: string
  rating?: number
  title?: string
  body: string
  authorName?: string
  authorId?: string
  verifiedPurchase?: boolean
  helpfulVotes?: number
  postedAt: string // ISO
  rawPayload?: unknown
}

export interface IngestSummary {
  mode: 'sandbox' | 'live'
  marketplaces: string[]
  reviewsSeen: number
  reviewsInserted: number
  reviewsSkippedExisting: number
  sentimentExtracted: number
  sentimentSkipped: number // had existing sentiment, force=false
  errors: string[]
}

function reviewMode(): 'sandbox' | 'live' {
  return process.env.NEXUS_REVIEW_INGEST_MODE === 'live' ? 'live' : 'sandbox'
}

async function loadFixtures(marketplace?: string): Promise<RawReview[]> {
  try {
    const buf = await readFile(path.join(FIXTURE_DIR, 'reviews-it.json'), 'utf8')
    const all = JSON.parse(buf) as RawReview[]
    if (marketplace) {
      return all.filter((r) => r.marketplace === marketplace)
    }
    return all
  } catch (err) {
    logger.warn('[review-ingest] fixture load failed', {
      error: err instanceof Error ? err.message : String(err),
    })
    return []
  }
}

async function liveFetch(_marketplace: string): Promise<RawReview[]> {
  // Stub — live SP-API / Brand Analytics integration deferred.
  // Real impl would call:
  //   - GET_BRAND_ANALYTICS_CATALOG_PERFORMANCE_REPORT for stats
  //   - third-party feed for review bodies
  return []
}

async function findOrCreateReview(raw: RawReview): Promise<{ id: string; isNew: boolean } | null> {
  const existing = await prisma.review.findFirst({
    where: { channel: raw.channel, externalReviewId: raw.externalReviewId },
    select: { id: true },
  })
  if (existing) {
    return { id: existing.id, isNew: false }
  }
  // Resolve productId via ASIN or SKU when possible.
  let productId: string | null = null
  if (raw.asin) {
    const p = await prisma.product.findFirst({
      where: { amazonAsin: raw.asin },
      select: { id: true },
    })
    productId = p?.id ?? null
  }
  if (!productId && raw.sku) {
    const p = await prisma.product.findFirst({
      where: { sku: raw.sku },
      select: { id: true },
    })
    productId = p?.id ?? null
  }
  const row = await prisma.review.create({
    data: {
      channel: raw.channel,
      marketplace: raw.marketplace ?? null,
      externalReviewId: raw.externalReviewId,
      productId,
      asin: raw.asin ?? null,
      sku: raw.sku ?? null,
      rating: raw.rating ?? null,
      title: raw.title ?? null,
      body: raw.body,
      authorName: raw.authorName ?? null,
      authorId: raw.authorId ?? null,
      verifiedPurchase: raw.verifiedPurchase ?? false,
      helpfulVotes: raw.helpfulVotes ?? 0,
      postedAt: new Date(raw.postedAt),
      rawPayload: (raw.rawPayload as object | null) ?? null,
    },
    select: { id: true },
  })
  return { id: row.id, isNew: true }
}

async function updateCategoryRates(reviewId: string, result: ExtractResult): Promise<void> {
  // Find the review to get productId + marketplace + postedAt.
  const review = await prisma.review.findUnique({
    where: { id: reviewId },
    select: { productId: true, marketplace: true, postedAt: true },
  })
  if (!review?.productId || !review.marketplace) return
  const day = new Date(
    Date.UTC(
      review.postedAt.getUTCFullYear(),
      review.postedAt.getUTCMonth(),
      review.postedAt.getUTCDate(),
    ),
  )
  for (const category of result.categories) {
    const sentimentDelta = {
      positive: result.label === 'POSITIVE' ? 1 : 0,
      neutral: result.label === 'NEUTRAL' ? 1 : 0,
      negative: result.label === 'NEGATIVE' ? 1 : 0,
    }
    await prisma.reviewCategoryRate.upsert({
      where: {
        productId_marketplace_category_date: {
          productId: review.productId,
          marketplace: review.marketplace,
          category,
          date: day,
        },
      },
      create: {
        productId: review.productId,
        marketplace: review.marketplace,
        category,
        date: day,
        total: 1,
        ...sentimentDelta,
      },
      update: {
        total: { increment: 1 },
        positive: { increment: sentimentDelta.positive },
        neutral: { increment: sentimentDelta.neutral },
        negative: { increment: sentimentDelta.negative },
      },
    })
  }
}

export interface IngestOptions {
  marketplaces?: string[]
  force?: boolean // re-run sentiment on already-classified reviews
}

export async function runReviewIngestOnce(
  options: IngestOptions = {},
): Promise<IngestSummary> {
  const mode = reviewMode()
  const summary: IngestSummary = {
    mode,
    marketplaces: [],
    reviewsSeen: 0,
    reviewsInserted: 0,
    reviewsSkippedExisting: 0,
    sentimentExtracted: 0,
    sentimentSkipped: 0,
    errors: [],
  }
  const marketplaces =
    options.marketplaces ??
    (process.env.NEXUS_AMAZON_ADS_MARKETPLACES ?? 'IT,DE')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  summary.marketplaces = marketplaces

  for (const mp of marketplaces) {
    const raws = mode === 'sandbox' ? await loadFixtures(mp) : await liveFetch(mp)
    summary.reviewsSeen += raws.length
    for (const raw of raws) {
      try {
        const result = await findOrCreateReview(raw)
        if (!result) continue
        if (result.isNew) {
          summary.reviewsInserted += 1
        } else {
          summary.reviewsSkippedExisting += 1
        }
        // Sentiment: re-run only when (new) OR (force=true).
        let needsSentiment = result.isNew
        if (!needsSentiment && options.force) {
          needsSentiment = true
        }
        if (!needsSentiment) {
          // Confirm existing sentiment is there — otherwise extract.
          const has = await prisma.reviewSentiment.findUnique({
            where: { reviewId: result.id },
            select: { id: true },
          })
          if (!has) needsSentiment = true
        }
        if (!needsSentiment) {
          summary.sentimentSkipped += 1
          continue
        }
        // Resolve product context for richer classification.
        let productType: string | null = null
        let brand: string | null = null
        if (raw.asin || raw.sku) {
          const p = await prisma.product.findFirst({
            where: raw.asin ? { amazonAsin: raw.asin } : { sku: raw.sku ?? '' },
            select: { productType: true, brand: true },
          })
          productType = p?.productType ?? null
          brand = p?.brand ?? null
        }
        const extract = await extractSentiment({
          reviewId: result.id,
          body: raw.body,
          title: raw.title ?? null,
          rating: raw.rating ?? null,
          marketplace: raw.marketplace ?? null,
          productType,
          brand,
        })
        await persistSentiment(extract)
        await updateCategoryRates(result.id, extract)
        summary.sentimentExtracted += 1
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        summary.errors.push(`review ${raw.externalReviewId}: ${msg}`)
        logger.warn('[review-ingest] review failed', {
          externalReviewId: raw.externalReviewId,
          error: msg,
        })
      }
    }
  }
  return summary
}

export function summarizeReviewIngest(s: IngestSummary): string {
  return [
    `mode=${s.mode}`,
    `markets=${s.marketplaces.join(',') || 'none'}`,
    `seen=${s.reviewsSeen}`,
    `new=${s.reviewsInserted}`,
    `existing=${s.reviewsSkippedExisting}`,
    `sentiment+=${s.sentimentExtracted}`,
    s.errors.length > 0 ? `errors=${s.errors.length}` : null,
  ]
    .filter(Boolean)
    .join(' · ')
}
