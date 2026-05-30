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
import { fetchEbayFeedback } from './adapters/ebay-feedback.adapter.js'
import { fetchAmazonVocFeed } from './adapters/amazon-voc.adapter.js'
import type { AdapterResult } from './adapters/types.js'
import { publishReviewEvent } from '../review-events.service.js'

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
  // RX.1b — non-error adapter notes (e.g. "no eBay connection", "feed
  // not configured"). Helps operators see *why* a live channel was a
  // no-op without treating it as a failure.
  notes: string[]
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


async function findOrCreateReview(
  raw: RawReview,
  ingestSource: string,
): Promise<{ id: string; isNew: boolean } | null> {
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
      ingestSource,
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

function emptySummary(mode: 'sandbox' | 'live'): IngestSummary {
  return {
    mode,
    marketplaces: [],
    reviewsSeen: 0,
    reviewsInserted: 0,
    reviewsSkippedExisting: 0,
    sentimentExtracted: 0,
    sentimentSkipped: 0,
    errors: [],
    notes: [],
  }
}

/**
 * Core ingest loop for a batch of already-fetched raw reviews. Used by
 * the sandbox cron, the live channel adapters (RX.1b), and the operator
 * import endpoint (RX.1a) — every path funnels through the same dedup →
 * sentiment → category-rate flow so provenance and counters stay
 * consistent. `ingestSource` is stamped on freshly-created rows.
 *
 * Resilient: a single bad row records an error and continues; it never
 * aborts the batch. Idempotent on (channel, externalReviewId).
 */
export async function ingestRawReviews(
  raws: RawReview[],
  opts: { ingestSource: string; force?: boolean; summary?: IngestSummary },
): Promise<IngestSummary> {
  const summary = opts.summary ?? emptySummary(reviewMode())
  summary.reviewsSeen += raws.length
  for (const raw of raws) {
    try {
      const result = await findOrCreateReview(raw, opts.ingestSource)
      if (!result) continue
      if (result.isNew) {
        summary.reviewsInserted += 1
      } else {
        summary.reviewsSkippedExisting += 1
      }
      // Sentiment: re-run only when (new) OR (force=true).
      let needsSentiment = result.isNew
      if (!needsSentiment && opts.force) {
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

      // RX.3 — broadcast to the live bus so the Feed/Desk auto-refresh
      // and negative reviews fire operator alerts. Only for genuinely
      // new rows (a forced re-classify shouldn't re-alert).
      if (result.isNew) {
        const now = Date.now()
        publishReviewEvent({
          type: 'review.created',
          reviewId: result.id,
          channel: raw.channel,
          marketplace: raw.marketplace ?? null,
          rating: raw.rating ?? null,
          label: extract.label,
          productId: null,
          ts: now,
        })
        if (extract.label === 'NEGATIVE' || (raw.rating != null && raw.rating <= 2)) {
          publishReviewEvent({
            type: 'review.negative',
            reviewId: result.id,
            channel: raw.channel,
            marketplace: raw.marketplace ?? null,
            rating: raw.rating ?? null,
            productId: null,
            productName: null,
            excerpt: raw.body.slice(0, 160),
            ts: now,
          })
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      summary.errors.push(`review ${raw.externalReviewId}: ${msg}`)
      logger.warn('[review-ingest] review failed', {
        externalReviewId: raw.externalReviewId,
        error: msg,
      })
    }
  }
  return summary
}

export async function runReviewIngestOnce(
  options: IngestOptions = {},
): Promise<IngestSummary> {
  const mode = reviewMode()
  const summary = emptySummary(mode)
  const marketplaces =
    options.marketplaces ??
    (process.env.NEXUS_AMAZON_ADS_MARKETPLACES ?? 'IT,DE')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  summary.marketplaces = marketplaces

  if (mode === 'sandbox') {
    for (const mp of marketplaces) {
      const raws = await loadFixtures(mp)
      await ingestRawReviews(raws, { ingestSource: 'FIXTURE', force: options.force, summary })
    }
  } else {
    await runLiveAdapters(marketplaces, options.force ?? false, summary)
  }
  return summary
}

/**
 * RX.1b — live channel adapters. Each is read-only, gated on its own
 * credentials, and error-isolated: a thrown adapter or a returned
 * { error } is recorded and ingestion continues with the next channel.
 */
async function runLiveAdapters(
  marketplaces: string[],
  force: boolean,
  summary: IngestSummary,
): Promise<void> {
  const absorb = async (
    label: string,
    ingestSource: string,
    run: () => Promise<AdapterResult>,
  ): Promise<void> => {
    try {
      const out = await run()
      if (out.note) summary.notes.push(`${label}: ${out.note}`)
      if (out.error) summary.errors.push(`${label}: ${out.error}`)
      if (out.reviews.length > 0) {
        await ingestRawReviews(out.reviews, { ingestSource, force, summary })
      }
    } catch (err) {
      summary.errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // Amazon — per-marketplace third-party feed (review bodies come from a
  // licensed feed or the import pipeline; no official Amazon review API).
  for (const mp of marketplaces) {
    await absorb(`amazon:${mp}`, 'AMAZON_VOC', () => fetchAmazonVocFeed({ marketplace: mp }))
  }
  // eBay — channel-wide GetFeedback (not per Amazon marketplace).
  await absorb('ebay', 'EBAY_API', () => fetchEbayFeedback({ maxPages: 5 }))
}

export function summarizeReviewIngest(s: IngestSummary): string {
  return [
    `mode=${s.mode}`,
    `markets=${s.marketplaces.join(',') || 'none'}`,
    `seen=${s.reviewsSeen}`,
    `new=${s.reviewsInserted}`,
    `existing=${s.reviewsSkippedExisting}`,
    `sentiment+=${s.sentimentExtracted}`,
    s.notes.length > 0 ? `notes=${s.notes.length}` : null,
    s.errors.length > 0 ? `errors=${s.errors.length}` : null,
  ]
    .filter(Boolean)
    .join(' · ')
}
