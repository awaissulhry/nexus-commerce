import { workspaceKey } from '@nexus/database/workspace-context'
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
import type { Prisma } from '@prisma/client'
import { fetchEbayFeedbackPreferRest } from './adapters/ebay-feedback.adapter.js'
import { fetchAmazonVocFeed } from './adapters/amazon-voc.adapter.js'
import type { AdapterRawReview, AdapterResult, ReviewMediaInput } from './adapters/types.js'
import { publishReviewEvent } from '../review-events.service.js'
import { notifyReviewAlert } from './review-alert-notify.service.js'

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
  /** Reviews Inbox — the Nexus Order this review is about, when the source names it (eBay feedback). */
  orderId?: string
  /** Reviews eBay REST (PR G) — photos, eBay's AI topics, eBay's state of the feedback (see adapters/types.ts). */
  media?: AdapterRawReview['media']
  channelTopics?: AdapterRawReview['channelTopics']
  feedbackState?: AdapterRawReview['feedbackState']
  revisionEligible?: AdapterRawReview['revisionEligible']
  sameAs?: AdapterRawReview['sameAs']
  /** What the row is about ('SELLER' = feedback about the seller); left out = decided by the channel (review-visibility.ts). */
  kind?: 'SELLER' | 'PRODUCT'
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


const EXISTING_SELECT = {
  id: true, orderId: true, marketplace: true, channelTopics: true, feedbackState: true, revisionEligible: true,
  media: { select: { url: true, type: true, position: true }, orderBy: { position: 'asc' } },
} satisfies Prisma.ReviewSelect
type ExistingReview = Prisma.ReviewGetPayload<{ select: typeof EXISTING_SELECT }>

/**
 * Reviews eBay REST (PR G) — feedback read by eBay's REST API that the older Trading read already stored under its own
 * id: the same order line from the same buyer (Trading keeps the line as `OrderLineItemID` in the raw payload).
 */
async function findSameFeedback(raw: RawReview): Promise<ExistingReview | null> {
  if (!raw.sameAs || raw.channel !== 'EBAY') return null
  return prisma.review.findFirst({
    where: {
      channel: 'EBAY',
      rawPayload: { path: ['OrderLineItemID'], equals: raw.sameAs.orderLineItemId },
      ...(raw.sameAs.buyer ? { authorName: raw.sameAs.buyer } : {}),
    },
    select: EXISTING_SELECT,
  })
}

const sameMedia = (a: readonly { url: string; position: number }[], b: readonly { url: string; position: number }[]) =>
  a.length === b.length && a.every((m, i) => m.url === b[i].url && m.position === b[i].position)

/**
 * A review's photos as one set: replaced when the new read differs from what Nexus stored (`stored` in position
 * order), untouched otherwise. True when it wrote. Used here and by the Etsy and Judge.me reads (PR I) for a review the
 * buyer edited.
 */
export async function replaceReviewMedia(
  reviewId: string,
  stored: readonly { url: string; position: number }[],
  next: readonly ReviewMediaInput[],
): Promise<boolean> {
  if (sameMedia(stored, next)) return false
  await prisma.$transaction([
    prisma.reviewMedia.deleteMany({ where: { reviewId } }),
    prisma.reviewMedia.createMany({ data: next.map((m) => ({ reviewId, url: m.url, type: m.type, width: m.width ?? null, height: m.height ?? null, position: m.position })) }),
  ])
  return true
}

/**
 * What a new read changes on a row Nexus already has (only what differs, so a 30-minute pass writes nothing for an
 * unchanged feedback): the order link (and, with it, the order's market — the real one, where the Trading read used to
 * stamp a default), eBay's AI topics, eBay's state of the feedback, and the buyer's photos (replaced as a set).
 */
async function refreshExisting(existing: ExistingReview, raw: RawReview, now: Date): Promise<void> {
  const data: Prisma.ReviewUpdateInput = {}
  // Reviews Inbox — a row stored before its order was known gets the order link on the next read.
  if (raw.orderId && !existing.orderId) data.orderId = raw.orderId
  if (raw.orderId && raw.marketplace && raw.marketplace !== existing.marketplace) data.marketplace = raw.marketplace
  if (raw.channelTopics !== undefined && JSON.stringify(raw.channelTopics) !== JSON.stringify(existing.channelTopics ?? null)) {
    data.channelTopics = raw.channelTopics as unknown as Prisma.InputJsonValue
  }
  if (raw.feedbackState !== undefined && raw.feedbackState !== existing.feedbackState) {
    data.feedbackState = raw.feedbackState
    data.feedbackStateAt = now
  }
  if (raw.revisionEligible !== undefined && raw.revisionEligible !== existing.revisionEligible) data.revisionEligible = raw.revisionEligible
  if (Object.keys(data).length > 0) await prisma.review.update({ where: { id: existing.id }, data })
  if (raw.media !== undefined) await replaceReviewMedia(existing.id, existing.media, raw.media)
}

async function findOrCreateReview(
  raw: RawReview,
  ingestSource: string,
  importBatchId?: string,
): Promise<{ id: string; isNew: boolean } | null> {
  const now = new Date()
  const existing = (await prisma.review.findFirst({
    where: { channel: raw.channel, externalReviewId: raw.externalReviewId },
    select: EXISTING_SELECT,
  })) ?? (await findSameFeedback(raw))
  if (existing) {
    await refreshExisting(existing, raw, now)
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
      orderId: raw.orderId ?? null,
      importBatchId: importBatchId ?? null,
      ...(raw.channelTopics !== undefined ? { channelTopics: raw.channelTopics as unknown as Prisma.InputJsonValue } : {}),
      ...(raw.feedbackState !== undefined ? { feedbackState: raw.feedbackState, feedbackStateAt: raw.feedbackState ? now : null } : {}),
      ...(raw.revisionEligible !== undefined ? { revisionEligible: raw.revisionEligible } : {}),
      kind: raw.kind ?? null,
    },
    select: { id: true },
  })
  if (raw.media?.length) {
    await prisma.reviewMedia.createMany({
      data: raw.media.map((m) => ({ reviewId: row.id, url: m.url, type: m.type, width: m.width ?? null, height: m.height ?? null, position: m.position })),
    })
  }
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
        productId_marketplace_category_date: workspaceKey({
          productId: review.productId,
          marketplace: review.marketplace,
          category,
          date: day,
        }),
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

/**
 * Reviews Inbox — "Undo this import": take removed reviews back out of the rolling ReviewCategoryRate counters that
 * `updateCategoryRates` raised when they were read, so the spike detector stops counting them. Never below zero.
 */
export async function removeFromCategoryRates(
  reviews: { productId: string | null; marketplace: string | null; postedAt: Date; label: string | null; categories: string[] }[],
): Promise<void> {
  for (const review of reviews) {
    if (!review.productId || !review.marketplace || !review.label) continue
    const date = new Date(Date.UTC(review.postedAt.getUTCFullYear(), review.postedAt.getUTCMonth(), review.postedAt.getUTCDate()))
    const column = review.label === 'POSITIVE' ? 'positive' : review.label === 'NEGATIVE' ? 'negative' : 'neutral'
    for (const category of review.categories) {
      await prisma.reviewCategoryRate.updateMany({
        where: { productId: review.productId, marketplace: review.marketplace, category, date, total: { gt: 0 }, [column]: { gt: 0 } },
        data: { total: { decrement: 1 }, [column]: { decrement: 1 } },
      })
    }
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
  opts: { ingestSource: string; force?: boolean; summary?: IngestSummary; importBatchId?: string },
): Promise<IngestSummary> {
  const summary = opts.summary ?? emptySummary(reviewMode())
  summary.reviewsSeen += raws.length
  for (const raw of raws) {
    try {
      const result = await findOrCreateReview(raw, opts.ingestSource, opts.importBatchId)
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
      // Reviews Inbox — the language and the English text ride on the same AI call.
      if (extract.language) {
        await prisma.review.update({
          where: { id: result.id },
          data: { language: extract.language, bodyEnglish: extract.english },
        })
      }
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
        // Reviews Settings › Alerts — "New negative review" for the people the business picked (in Nexus and/or by
        // e-mail). It decides itself (1–2 stars or a negative reading, arrivals only — never an imported file) and
        // never throws.
        await notifyReviewAlert({
          reviewId: result.id,
          channel: raw.channel,
          marketplace: raw.marketplace ?? null,
          rating: raw.rating ?? null,
          label: extract.label,
          ingestSource: opts.ingestSource,
          title: raw.title ?? null,
          body: raw.body,
        })
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
    run: () => Promise<AdapterResult & { ingestSource?: string }>,
  ): Promise<void> => {
    try {
      const out = await run()
      if (out.note) summary.notes.push(`${label}: ${out.note}`)
      if (out.error) summary.errors.push(`${label}: ${out.error}`)
      if (out.reviews.length > 0) {
        // The eBay read says itself how the rows arrived (REST or the older Trading call).
        await ingestRawReviews(out.reviews, { ingestSource: out.ingestSource ?? ingestSource, force, summary })
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
  // eBay — channel-wide feedback (not per Amazon marketplace): eBay's REST Feedback API when the account has it, else
  // Trading GetFeedback (Reviews eBay REST, PR G).
  await absorb('ebay', 'EBAY_API', () => fetchEbayFeedbackPreferRest({ maxPages: 5 }))
  // Reviews eBay REST (PR G) — the sales that wait for the seller's feedback for the buyer (a read; leaving it is an
  // approval a person decides on the Reviews › eBay page).
  try {
    const { refreshEbayBuyerFeedback } = await import('./ebay-buyer-feedback.service.js')
    const out = await refreshEbayBuyerFeedback()
    if (out.note) summary.notes.push(`ebay buyer feedback: ${out.note}`)
  } catch (err) {
    summary.errors.push(`ebay buyer feedback: ${err instanceof Error ? err.message : String(err)}`)
  }
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
