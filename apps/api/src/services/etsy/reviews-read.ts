/**
 * Reviews (2026-10-27, build spec B21 / PR I) — read an Etsy shop's reviews into `Review` (channel ETSY, kind product).
 *
 * Etsy Open API v3, `getReviewsByShop` (https://developers.etsy.com/documentation/reference#operation/getReviewsByShop;
 * schema `TransactionReview` in https://www.etsy.com/openapi/generated/oas/3.0.0.json, read 2026-10-27):
 *   GET /v3/application/shops/{shop_id}/reviews?limit=(1–100, default 25)&offset=&min_created=&max_created=
 *   → { count, results: TransactionReview[] }; a review: shop_id, listing_id, transaction_id, buyer_user_id (may be
 *   absent for privacy), rating (1–5), review (text, may be empty), language, image_url_fullxfull (one photo, may be
 *   absent for privacy), create_timestamp / created_timestamp, update_timestamp / updated_timestamp (epoch seconds).
 *   No review id (one review per transaction, so the transaction id is the review's id here), no seller reply, no
 *   video, no sub-ratings. Etsy has NO endpoint to reply: a person replies on Etsy.com, once, within 100 days of the
 *   buyer's last edit (https://help.etsy.com/hc/en-us/articles/115015808588) — the edit time is kept in
 *   `Review.channelEditedAt` for `reviewReplyRules('ETSY', { lastEditedAt })`.
 *
 * Every call goes through the account-scoped reader (`read-client.ts` → the channel gateway: the account's state, rate
 * bucket and call ledger), like the receipts read. The photo URL stays in `rawPayload` (`image_url_fullxfull`); there is
 * no ReviewMedia table yet. The product comes from the listing (ChannelListing.externalListingId), the order from the
 * transaction (OrderItem.externalLineItemId), the market from that order, else the connection's own market.
 *
 * A new review goes through the shared ingest (dedupe on channel + transaction id, sentiment, live events, alerts); a
 * review the buyer edited since (rating, text, photo or edit time changed) is updated in place.
 */
import type { Prisma } from '@prisma/client'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import type { AdapterRawReview } from '../reviews/adapters/types.js'
import { etsyReader } from './read-client.js'

export const ETSY_REVIEWS_INGEST_SOURCE = 'ETSY_API'
/** The CronRun name of the 30-minute read (jobs/shop-reviews-read.job.ts). */
export const ETSY_REVIEWS_JOB = 'etsy-reviews-read'
/** Etsy's documented ceiling for `limit` on this endpoint. */
export const ETSY_REVIEWS_PAGE = 100
/** Pages one run reads at most per shop (2,000 reviews). */
export const ETSY_REVIEWS_MAX_PAGES = 20
/** Each run reads the reviews created in this many days: a buyer's edit and the 100-day window both live in it. */
export const ETSY_REVIEWS_LOOKBACK_DAYS = 365
const DAY_MS = 24 * 60 * 60 * 1000

/** The deployment switch for the 30-minute read (never named on screen). */
export function etsyReviewsReadOn(env: Record<string, string | undefined> = process.env): boolean {
  return env.NEXUS_ENABLE_ETSY_REVIEWS_READ === '1'
}

export interface EtsyReviewPayload {
  source: 'etsy'
  shop_id: number | null
  listing_id: number | null
  transaction_id: number | null
  buyer_user_id: number | null
  language: string | null
  /** The one photo the buyer added (Etsy's fullxfull size); absent for privacy or when none. */
  image_url_fullxfull: string | null
  created_timestamp: number | null
  updated_timestamp: number | null
}

export interface EtsyParsedReview {
  raw: AdapterRawReview
  transactionId: string | null
  listingId: string | null
  /** The buyer's last edit (ISO); Etsy's update time. */
  editedAt: string | null
  language: string | null
}

const int = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null)
const seconds = (v: unknown): Date | null => {
  const n = int(v)
  return n != null && n >= 946_684_800 ? new Date(n * 1000) : null
}

/** One TransactionReview → a Nexus review; null when it has no transaction, no date or no rating Etsy allows. Pure. */
export function parseEtsyReview(input: unknown): EtsyParsedReview | null {
  if (!input || typeof input !== 'object') return null
  const r = input as Record<string, unknown>
  const transactionId = int(r.transaction_id)
  const created = seconds(r.created_timestamp) ?? seconds(r.create_timestamp)
  const rating = typeof r.rating === 'number' && Number.isInteger(r.rating) && r.rating >= 1 && r.rating <= 5 ? r.rating : null
  if (!transactionId || !created || rating == null) return null
  const updated = seconds(r.updated_timestamp) ?? seconds(r.update_timestamp)
  const image = typeof r.image_url_fullxfull === 'string' && /^https:\/\//.test(r.image_url_fullxfull) ? r.image_url_fullxfull : null
  const langRaw = typeof r.language === 'string' ? r.language.trim().toLowerCase() : ''
  const language = /^[a-z]{2}\b/.test(langRaw) ? langRaw.slice(0, 2) : null
  const payload: EtsyReviewPayload = {
    source: 'etsy',
    shop_id: int(r.shop_id),
    listing_id: int(r.listing_id),
    transaction_id: transactionId,
    buyer_user_id: int(r.buyer_user_id),
    language,
    image_url_fullxfull: image,
    created_timestamp: Math.floor(created.getTime() / 1000),
    updated_timestamp: updated ? Math.floor(updated.getTime() / 1000) : null,
  }
  return {
    raw: {
      externalReviewId: String(transactionId),
      channel: 'ETSY',
      rating,
      body: typeof r.review === 'string' ? r.review.trim() : '',
      authorId: payload.buyer_user_id != null ? String(payload.buyer_user_id) : undefined,
      // Etsy reviews come only from a purchase (one per transaction).
      verifiedPurchase: true,
      postedAt: created.toISOString(),
      rawPayload: payload,
    },
    transactionId: String(transactionId),
    listingId: payload.listing_id != null ? String(payload.listing_id) : null,
    // A review never edited has its update time equal to (or before) its creation: the edit time is the creation then.
    editedAt: (updated && updated > created ? updated : created).toISOString(),
    language,
  }
}

/** The shop path of one page; the shop id comes from the account (`etsyReader`), never from a caller. */
export function etsyReviewsPath(shopId: string, page: { offset: number; minCreated: number; limit?: number }): string {
  const limit = page.limit ?? ETSY_REVIEWS_PAGE
  if (!/^[1-9]\d*$/.test(shopId)) throw new Error('The Etsy account has no verified shop identity.')
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > ETSY_REVIEWS_PAGE) throw new Error(`limit must be 1..${ETSY_REVIEWS_PAGE}.`)
  if (!Number.isSafeInteger(page.offset) || page.offset < 0) throw new Error('offset must be 0 or more.')
  if (!Number.isSafeInteger(page.minCreated) || page.minCreated < 946_684_800) throw new Error('min_created must be epoch seconds after 2000-01-01.')
  return `/shops/${shopId}/reviews?limit=${limit}&offset=${page.offset}&min_created=${page.minCreated}`
}

export interface EtsyReviewsRead {
  reviews: EtsyParsedReview[]
  pages: number
  /** Etsy's count of reviews in the window; more than were read when the page cap stopped the run. */
  count: number
  more: boolean
}

/** Reads one shop's reviews created in the look-back window, page by page (through the gateway). Throws on a failed call. */
export async function readEtsyShopReviews(accountId: string, opts: { now?: Date; maxPages?: number } = {}): Promise<EtsyReviewsRead> {
  const { get, shopId } = await etsyReader(accountId)
  const now = opts.now ?? new Date()
  const minCreated = Math.floor((now.getTime() - ETSY_REVIEWS_LOOKBACK_DAYS * DAY_MS) / 1000)
  const maxPages = Math.max(1, Math.min(opts.maxPages ?? ETSY_REVIEWS_MAX_PAGES, ETSY_REVIEWS_MAX_PAGES))
  const reviews: EtsyParsedReview[] = []
  let offset = 0
  let count = 0
  let pages = 0
  while (pages < maxPages) {
    const body = await get<{ count?: unknown; results?: unknown }>(etsyReviewsPath(shopId, { offset, minCreated }))
    if (!body || !Array.isArray(body.results)) throw new Error('Etsy answered without a review list.')
    pages++
    count = typeof body.count === 'number' && Number.isSafeInteger(body.count) && body.count >= 0 ? body.count : count
    for (const item of body.results) {
      const parsed = parseEtsyReview(item)
      if (parsed) reviews.push(parsed)
    }
    offset += body.results.length
    if (body.results.length < ETSY_REVIEWS_PAGE || offset >= count) return { reviews, pages, count, more: false }
  }
  return { reviews, pages, count, more: offset < count }
}

/** What an already-stored Etsy review changes after the buyer edited it; null when nothing did. Pure. */
export function etsyChanges(
  stored: { rating: number | null; body: string; channelEditedAt: Date | null; rawPayload: unknown },
  parsed: EtsyParsedReview,
): Prisma.ReviewUpdateInput | null {
  const before = stored.rawPayload && typeof stored.rawPayload === 'object' ? stored.rawPayload as Partial<EtsyReviewPayload> : {}
  const after = parsed.raw.rawPayload as EtsyReviewPayload
  const editedAt = parsed.editedAt ? new Date(parsed.editedAt) : null
  const textChanged = stored.body !== parsed.raw.body
  const same = !textChanged && stored.rating === (parsed.raw.rating ?? null)
    && (stored.channelEditedAt?.getTime() ?? null) === (editedAt?.getTime() ?? null)
    && (before.image_url_fullxfull ?? null) === after.image_url_fullxfull
  if (same) return null
  return {
    rating: parsed.raw.rating ?? null,
    body: parsed.raw.body,
    channelEditedAt: editedAt,
    rawPayload: after as unknown as Prisma.InputJsonValue,
    ...(textChanged ? { bodyEnglish: null } : {}),
  }
}

export interface EtsyStoreResult { inserted: number; updated: number; errors: string[] }

/** Stores one shop's reviews: product, order and market where Nexus knows them; edits updated in place. */
export async function storeEtsyReviews(parsed: EtsyParsedReview[], ctx: { connectionMarket: string | null }): Promise<EtsyStoreResult> {
  if (parsed.length === 0) return { inserted: 0, updated: 0, errors: [] }
  const ids = parsed.map((p) => p.raw.externalReviewId)
  const listingIds = [...new Set(parsed.map((p) => p.listingId).filter((x): x is string => !!x))]
  const txIds = [...new Set(parsed.map((p) => p.transactionId).filter((x): x is string => !!x))]
  const [existing, listings, lines] = await Promise.all([
    prisma.review.findMany({ where: { channel: 'ETSY', externalReviewId: { in: ids } }, select: { id: true, externalReviewId: true, rating: true, body: true, channelEditedAt: true, rawPayload: true } }),
    listingIds.length
      ? prisma.channelListing.findMany({ where: { channel: 'ETSY', externalListingId: { in: listingIds } }, select: { externalListingId: true, product: { select: { sku: true } } } })
      : Promise.resolve([]),
    txIds.length
      ? prisma.orderItem.findMany({ where: { externalLineItemId: { in: txIds }, order: { channel: 'ETSY' } }, select: { externalLineItemId: true, orderId: true, order: { select: { marketplace: true, customerName: true } } } })
      : Promise.resolve([]),
  ])
  const skuOf = new Map(listings.map((l) => [l.externalListingId, l.product?.sku ?? null]))
  const lineOf = new Map(lines.map((l) => [l.externalLineItemId, l]))
  const known = new Map(existing.map((r) => [r.externalReviewId, r]))
  const market = (raw: string | null | undefined) => {
    const code = String(raw ?? '').trim().toUpperCase()
    return /^[A-Z]{2}$/.test(code) ? (code === 'GB' ? 'UK' : code) : null
  }

  const errors: string[] = []
  let updated = 0
  const fresh: EtsyParsedReview[] = []
  for (const p of parsed) {
    const stored = known.get(p.raw.externalReviewId)
    if (!stored) {
      const line = p.transactionId ? lineOf.get(p.transactionId) : undefined
      const sku = p.listingId ? skuOf.get(p.listingId) ?? undefined : undefined
      fresh.push({
        ...p,
        raw: {
          ...p.raw,
          sku: sku ?? undefined,
          orderId: line?.orderId,
          marketplace: market(line?.order.marketplace) ?? ctx.connectionMarket ?? undefined,
          // The buyer's name from the order Nexus holds (Etsy's review gives only a user id, and may hide that).
          authorName: line?.order.customerName?.trim() || undefined,
        },
      })
      continue
    }
    const change = etsyChanges(stored, p)
    if (!change) continue
    try {
      await prisma.review.update({ where: { id: stored.id }, data: change })
      updated++
    } catch (err) {
      errors.push(`review ${p.raw.externalReviewId}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const { ingestRawReviews } = await import('../reviews/review-ingest.service.js')
  const summary = await ingestRawReviews(fresh.map((p) => p.raw), { ingestSource: ETSY_REVIEWS_INGEST_SOURCE })
  // The edit time and Etsy's own language on the rows just made (the shared ingest does not know them).
  for (const p of fresh) {
    try {
      await prisma.review.updateMany({
        where: { channel: 'ETSY', externalReviewId: p.raw.externalReviewId, channelEditedAt: null },
        data: { channelEditedAt: p.editedAt ? new Date(p.editedAt) : null },
      })
      if (p.language) {
        await prisma.review.updateMany({ where: { channel: 'ETSY', externalReviewId: p.raw.externalReviewId, language: null }, data: { language: p.language } })
      }
    } catch (err) {
      errors.push(`review ${p.raw.externalReviewId}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return { inserted: summary.reviewsInserted, updated, errors: [...errors, ...summary.errors] }
}

export interface EtsyReviewsAccountOutcome {
  connectionId: string
  status: 'SUCCESS' | 'PARTIAL' | 'FAILED'
  seen: number
  inserted: number
  updated: number
  error: string | null
}

export interface EtsyReviewsReadReport { enabled: boolean; accounts: EtsyReviewsAccountOutcome[] }

/** Every active Etsy account this business owns (a shared account's reviews belong to its owner). Never throws per account. */
export async function readEtsyReviewsOnce(opts: { now?: Date } = {}): Promise<EtsyReviewsReadReport> {
  if (!etsyReviewsReadOn()) return { enabled: false, accounts: [] }
  const { listActiveConnections, isOwnConnection } = await import('../connection-resolver.service.js')
  const accounts: EtsyReviewsAccountOutcome[] = []
  for (const connection of await listActiveConnections('ETSY')) {
    if (!isOwnConnection(connection)) continue
    try {
      const read = await readEtsyShopReviews(connection.id, { now: opts.now })
      const marketCode = String(connection.marketplace ?? '').trim().toUpperCase()
      const stored = await storeEtsyReviews(read.reviews, { connectionMarket: /^[A-Z]{2}$/.test(marketCode) ? marketCode : null })
      accounts.push({
        connectionId: connection.id,
        status: stored.errors.length || read.more ? 'PARTIAL' : 'SUCCESS',
        seen: read.reviews.length, inserted: stored.inserted, updated: stored.updated,
        error: stored.errors[0] ?? (read.more ? 'More reviews wait than one run reads; the next runs read on.' : null),
      })
    } catch (err) {
      const words = err instanceof Error ? err.message : String(err)
      logger.warn('[etsy-reviews] read failed', { connectionId: connection.id, error: words.slice(0, 200) })
      accounts.push({ connectionId: connection.id, status: 'FAILED', seen: 0, inserted: 0, updated: 0, error: words.slice(0, 500) })
    }
  }
  return { enabled: true, accounts }
}

export function summarizeEtsyReviewsRead(report: EtsyReviewsReadReport): string {
  if (!report.enabled) return 'The Etsy review read is off in this setup; nothing was read.'
  if (report.accounts.length === 0) return 'No Etsy account is connected.'
  const sum = (k: 'seen' | 'inserted' | 'updated') => report.accounts.reduce((n, a) => n + a[k], 0)
  const by = (s: string) => report.accounts.filter((a) => a.status === s).length
  return `${report.accounts.length} Etsy account(s): ${by('SUCCESS')} ok, ${by('PARTIAL')} partial, ${by('FAILED')} failed; ${sum('seen')} read, ${sum('inserted')} new, ${sum('updated')} updated`
}
