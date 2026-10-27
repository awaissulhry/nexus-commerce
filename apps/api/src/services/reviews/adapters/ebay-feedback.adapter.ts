/**
 * RX.1b — eBay GetFeedback adapter (live).
 *
 * Pulls the feedback the seller has *received* (Trading API GetFeedback,
 * FeedbackReceivedAsSeller) and maps each comment to a review row. eBay
 * feedback is the closest thing eBay has to a product review: a buyer
 * comment + a Positive/Neutral/Negative rating tied to a transaction.
 *
 * Safety discipline (mirrors ebay.provider.ts callTradingApi):
 *   - Runs only when NEXUS_EBAY_REAL_API=true AND an active eBay
 *     ChannelConnection exists. Otherwise returns { note } — a no-op.
 *   - Read-only. No writes to eBay.
 *   - Never throws past its boundary: parse/HTTP failures come back as
 *     { error } so the ingest pipeline records them and moves on.
 *
 * Reviews Inbox (2026-10-26): each feedback is linked to its Nexus order (`orderId`) from its order line, and the
 * reply limit is eBay's 500 characters (RespondToFeedback `ResponseText` "Max length: 500",
 * https://developer.ebay.com/devzone/xml/docs/reference/ebay/RespondToFeedback.html) — `EBAY_REPLY_LIMIT` in
 * @nexus/shared/review-reply-rules, which reply/send checks before this adapter is called.
 *
 * Reviews › eBay page (2026-10-26, B18): `fetchEbayFeedbackSummary` reads eBay's own summary for one account — the
 * feedback score, counts by type per period and the four detailed seller ratings (GetFeedback, a read on the gateway);
 * pages call it through ebay-feedback-summary.service.ts, at most once an hour per account.
 *
 * Reviews eBay REST (2026-10-27, B19): the review pass reads by eBay's REST Feedback API first
 * (`fetchEbayFeedbackPreferRest`, ebay-feedback-rest.adapter.ts) and falls back to the Trading read here. Neither read
 * stamps a default market any more: a feedback's market is its Nexus order's (or the account's, when it is connected for
 * one market only), else none.
 */

import { ebayTradingSend } from '../../gateway/ebay.js'
import { GatewayRefusal } from '../../gateway/gateway.js'
import { XMLParser } from 'fast-xml-parser'
import { EBAY_REPLY_LIMIT, replyLength } from '@nexus/shared/review-reply-rules'
import prisma from '../../../db.js'
import { logger } from '../../../utils/logger.js'
import { ebayAuthService } from '../../ebay-auth.service.js'
import type { AdapterRawReview, AdapterResult } from './types.js'
import { tryResolveConnection } from '../../connection-resolver.service.js'
import { ebayFeedbackSummaryRequest, parseEbayFeedbackSummary, type EbayFeedbackSummary } from './ebay-feedback-summary.js'
import { applyTopics, readRestFeedback, readRestTopics, respondToEbayFeedbackRest, type RestDeps } from './ebay-feedback-rest.adapter.js'

const TRADING_ENDPOINT =
  process.env.EBAY_SANDBOX === 'true'
    ? 'https://api.sandbox.ebay.com/ws/api.dll'
    : 'https://api.ebay.com/ws/api.dll'

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * RX.2 — post a public seller reply to a received feedback comment
 * (Trading API RespondToFeedback, ResponseType=Reply). Same opt-in +
 * connection gating as the read path; never throws past its boundary.
 */
export async function respondToEbayFeedback(
  feedbackId: string,
  responseText: string,
  /** The buyer's eBay user ID (the feedback's CommentingUser): eBay's RespondToFeedback requires it as TargetUserID. */
  targetUserId: string,
): Promise<{ ok: boolean; code: string; error?: string }> {
  if (!targetUserId?.trim()) return { ok: false, code: 'NO_BUYER_ID', error: 'eBay needs the buyer’s user ID to post a reply' }
  if (process.env.NEXUS_EBAY_REAL_API !== 'true') {
    return { ok: false, code: 'OPT_IN_OFF', error: 'NEXUS_EBAY_REAL_API not enabled' }
  }
  if (replyLength(responseText) > EBAY_REPLY_LIMIT) {
    return { ok: false, code: 'TOO_LONG', error: `eBay allows at most ${EBAY_REPLY_LIMIT} characters` }
  }
  // MAP.3 — DECLARED. Note the old ordering was `lastSyncAt desc`, a second way of
  // spelling "whichever account synced most recently" — the same coin flip.
  const connection = await tryResolveConnection({ channel: 'EBAY', primary: true })
  if (!connection) return { ok: false, code: 'NO_CONNECTION', error: 'no active eBay connection' }
  let token: string
  try {
    token = await ebayAuthService.getValidToken(connection.id)
  } catch (err) {
    return { ok: false, code: 'TOKEN', error: err instanceof Error ? err.message : String(err) }
  }
  const compatLevel = process.env.EBAY_COMPAT_LEVEL || '1193'
  const siteId = process.env.EBAY_SITE_ID || '101'
  const xml =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<RespondToFeedbackRequest xmlns="urn:ebay:apis:eBLBaseComponents">` +
    `<FeedbackID>${escapeXml(feedbackId)}</FeedbackID>` +
    `<TargetUserID>${escapeXml(targetUserId.trim())}</TargetUserID>` +
    `<ResponseType>Reply</ResponseType>` +
    `<ResponseText>${escapeXml(responseText)}</ResponseText>` +
    `</RespondToFeedbackRequest>`
  try {
    const res = await ebayTradingSend(connection.id, TRADING_ENDPOINT, {
      method: 'POST',
      headers: {
        'X-EBAY-API-CALL-NAME': 'RespondToFeedback',
        'X-EBAY-API-COMPATIBILITY-LEVEL': compatLevel,
        'X-EBAY-API-SITEID': siteId,
        'X-EBAY-API-IAF-TOKEN': token,
        'Content-Type': 'text/xml',
      },
      body: xml,
    })
    if (!res.ok) return { ok: false, code: `HTTP_${res.status}`, error: `HTTP ${res.status}` }
    const text = await res.text()
    const ack = text.match(/<Ack>([^<]+)<\/Ack>/)?.[1]
    if (ack === 'Failure') {
      const msg = text.match(/<ShortMessage>([^<]+)<\/ShortMessage>/)?.[1]
      return { ok: false, code: 'FAILURE', error: msg ?? 'unknown' }
    }
    return { ok: true, code: ack ?? 'Success' }
  } catch (err) {
    return { ok: false, code: 'EXCEPTION', error: err instanceof Error ? err.message : String(err) }
  }
}

function commentTypeToRating(t: string | undefined): number | undefined {
  switch ((t ?? '').toLowerCase()) {
    case 'positive':
      return 5
    case 'neutral':
      return 3
    case 'negative':
      return 1
    default:
      return undefined
  }
}

function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v == null) return []
  return Array.isArray(v) ? v : [v]
}

/**
 * The order line a feedback is about (masked ids such as "11111111-0" are dropped): as Trading GetFeedback names it
 * (`OrderLineItemID`, `TransactionID`, `ItemID`), or as eBay's REST getFeedback does (`orderLineItemSummary.orderLineItemId`
 * "<listingId>-<transactionId>", `listingId`).
 */
export function ebayFeedbackOrderRef(detail: Record<string, unknown>): { orderLineItemId: string | null; transactionId: string | null; itemId: string | null } {
  const text = (v: unknown) => {
    const s = v == null ? '' : String(v).trim()
    return s && !/^1+(-0)?$/.test(s) && s !== '0' ? s : null
  }
  const summary = detail.orderLineItemSummary
  if (summary && typeof summary === 'object' && !Array.isArray(summary)) {
    const line = text((summary as Record<string, unknown>).orderLineItemId)
    const [item, transaction] = line && /^\d+-\d+$/.test(line) ? line.split('-') : [null, null]
    return { orderLineItemId: line, transactionId: text(transaction), itemId: text((summary as Record<string, unknown>).listingId) ?? text(item) }
  }
  return { orderLineItemId: text(detail.OrderLineItemID), transactionId: text(detail.TransactionID), itemId: text(detail.ItemID) }
}

/** A market code as the Reviews pages use it (two letters, GB as UK); anything else null. */
function marketOf(raw: string | null | undefined): string | null {
  const code = raw?.trim().toUpperCase() ?? ''
  if (!/^[A-Z]{2}$/.test(code)) return null
  return code === 'GB' ? 'UK' : code
}

/**
 * The Nexus order of each feedback, when exactly one order matches its order line: an eBay order stored under the
 * legacy order-line id ("ItemID-TransactionID"), or an order line whose eBay line id is the feedback's TransactionID
 * (and whose listing, when stored, is the feedback's ItemID). No match, or more than one: no link.
 *
 * Reviews eBay REST (PR G): the feedback's market is that order's market — eBay gives none with the feedback (it belongs
 * to the account, not to a site). Without a matched order the market stays as the adapter set it (never a guess).
 */
export async function linkEbayFeedbackOrders(reviews: AdapterRawReview[]): Promise<void> {
  const refs = reviews.map((r) => ebayFeedbackOrderRef((r.rawPayload ?? {}) as Record<string, unknown>))
  const found = await matchEbayOrderLines(refs)
  reviews.forEach((review, i) => {
    const match = found[i]
    if (!match) return
    review.orderId = match.orderId
    if (match.market) review.marketplace = match.market
  })
}

/**
 * The Nexus product of each feedback (live audit B13: eBay feedback names no product, so no product's reviews showed
 * any). From the feedback's listing (ItemID → Nexus's eBay listing → its product; a listing whose rows are variations of
 * one family gives the family), else the first line of its matched order. No match, or more than one product: none.
 */
export async function linkEbayFeedbackProducts(reviews: AdapterRawReview[]): Promise<void> {
  const itemOf = reviews.map((r) => ebayFeedbackOrderRef((r.rawPayload ?? {}) as Record<string, unknown>).itemId)
  const itemIds = [...new Set(itemOf.filter((v): v is string => !!v))]
  const orderIds = [...new Set(reviews.map((r) => r.orderId).filter((v): v is string => !!v))]
  const [listings, lines] = await Promise.all([
    itemIds.length
      ? prisma.channelListing.findMany({ where: { channel: 'EBAY', externalListingId: { in: itemIds } }, select: { externalListingId: true, productId: true, product: { select: { parentId: true } } } })
      : Promise.resolve([] as Array<{ externalListingId: string | null; productId: string; product: { parentId: string | null } | null }>),
    orderIds.length
      ? prisma.orderItem.findMany({ where: { orderId: { in: orderIds }, productId: { not: null } }, select: { orderId: true, productId: true, product: { select: { parentId: true } } } })
      : Promise.resolve([] as Array<{ orderId: string; productId: string | null; product: { parentId: string | null } | null }>),
  ])
  // A variation counts as its family: one listing of several sizes is one product's feedback.
  const familyOf = (productId: string | null, parentId: string | null | undefined) => parentId ?? productId
  const byItem = new Map<string, Set<string>>()
  for (const l of listings) {
    if (!l.externalListingId) continue
    const id = familyOf(l.productId, l.product?.parentId)
    if (id) byItem.set(l.externalListingId, (byItem.get(l.externalListingId) ?? new Set()).add(id))
  }
  const byOrder = new Map<string, Set<string>>()
  for (const line of lines) {
    const id = familyOf(line.productId, line.product?.parentId)
    if (id) byOrder.set(line.orderId, (byOrder.get(line.orderId) ?? new Set()).add(id))
  }
  reviews.forEach((review, i) => {
    if (review.productId) return
    const fromListing = itemOf[i] ? byItem.get(itemOf[i]!) : undefined
    const fromOrder = review.orderId ? byOrder.get(review.orderId) : undefined
    const one = fromListing?.size === 1 ? [...fromListing][0] : fromOrder?.size === 1 ? [...fromOrder][0] : null
    if (one) review.productId = one
  })
}

/** The product link is a convenience too: the feedback is stored without it. */
async function linkProductsQuietly(reviews: AdapterRawReview[]): Promise<void> {
  try {
    await linkEbayFeedbackProducts(reviews)
  } catch (err) {
    logger.warn('[ebay-feedback] product link failed', { error: err instanceof Error ? err.message : String(err) })
  }
}

export type EbayOrderLineRef = ReturnType<typeof ebayFeedbackOrderRef>

/**
 * The Nexus order of each eBay order line (feedback, or a sale waiting for the seller's feedback), when exactly one
 * matches (the rule above), with that order's market; null otherwise. One read for all of them.
 */
export async function matchEbayOrderLines(refs: readonly EbayOrderLineRef[]): Promise<Array<{ orderId: string; market: string | null } | null>> {
  const lineIds = [...new Set(refs.map((r) => r.orderLineItemId).filter((v): v is string => !!v))]
  const transactionIds = [...new Set(refs.map((r) => r.transactionId).filter((v): v is string => !!v))]
  if (lineIds.length === 0 && transactionIds.length === 0) return refs.map(() => null)
  const [orders, items] = await Promise.all([
    lineIds.length > 0
      ? prisma.order.findMany({ where: { channel: 'EBAY', channelOrderId: { in: lineIds } }, select: { id: true, channelOrderId: true, marketplace: true } })
      : Promise.resolve([] as { id: string; channelOrderId: string; marketplace: string | null }[]),
    transactionIds.length > 0
      ? prisma.orderItem.findMany({
          where: { externalLineItemId: { in: transactionIds }, order: { channel: 'EBAY' } },
          select: { orderId: true, externalLineItemId: true, ebayMetadata: true, order: { select: { marketplace: true } } },
        })
      : Promise.resolve([] as { orderId: string; externalLineItemId: string | null; ebayMetadata: unknown; order: { marketplace: string | null } }[]),
  ])
  const marketOfOrder = new Map<string, string | null>()
  for (const o of orders) marketOfOrder.set(o.id, marketOf(o.marketplace))
  for (const item of items) marketOfOrder.set(item.orderId, marketOf(item.order?.marketplace))
  return refs.map((ref) => {
    const matches = new Set<string>()
    for (const o of orders) if (ref.orderLineItemId && o.channelOrderId === ref.orderLineItemId) matches.add(o.id)
    for (const item of items) {
      if (!ref.transactionId || item.externalLineItemId !== ref.transactionId) continue
      const listing = (item.ebayMetadata as { legacyItemId?: unknown } | null)?.legacyItemId
      if (ref.itemId && typeof listing === 'string' && listing && listing !== ref.itemId) continue
      matches.add(item.orderId)
    }
    if (matches.size !== 1) return null
    const orderId = [...matches][0]
    return { orderId, market: marketOfOrder.get(orderId) ?? null }
  })
}

export type EbayFeedbackSummaryRead =
  | { ok: true; summary: EbayFeedbackSummary }
  /**
   * `called`: whether eBay was asked at all — a read that never left Nexus (eBay reading off, no sign-in) is not
   * counted against the hourly limit (ebay-feedback-summary.service.ts).
   */
  | { ok: false; called: boolean; words: string }

/**
 * Reviews › eBay page (2026-10-26, B18) — eBay's feedback summary for ONE seller account: score, positive / neutral /
 * negative counts per period and the four detailed seller ratings (Trading `GetFeedback`, a read, through the channel
 * gateway's `ebayTradingSend`). Same gates as the 30-minute feedback read: eBay reading switched on for this Nexus and a
 * working sign-in. Never throws; the words are for a person ("Sign-in expired …"), never a code or a setting's name.
 * Call it through `readEbayFeedbackSummary` (at most once an hour per account), not directly.
 */
export async function fetchEbayFeedbackSummary(connectionId: string): Promise<EbayFeedbackSummaryRead> {
  if (process.env.NEXUS_EBAY_REAL_API !== 'true') {
    return { ok: false, called: false, words: 'Nexus does not read eBay in this setup yet.' }
  }
  let token: string
  try {
    token = await ebayAuthService.getValidToken(connectionId)
  } catch {
    return { ok: false, called: false, words: 'The eBay sign-in did not work. Reconnect eBay in Settings › Channels.' }
  }
  try {
    const res = await ebayTradingSend(connectionId, TRADING_ENDPOINT, {
      method: 'POST',
      headers: {
        'X-EBAY-API-CALL-NAME': 'GetFeedback',
        'X-EBAY-API-COMPATIBILITY-LEVEL': process.env.EBAY_COMPAT_LEVEL || '1193',
        'X-EBAY-API-SITEID': process.env.EBAY_SITE_ID || '101',
        'X-EBAY-API-IAF-TOKEN': token,
        'Content-Type': 'text/xml',
      },
      body: ebayFeedbackSummaryRequest(),
    })
    const text = await res.text()
    if (!res.ok && !text.includes('<GetFeedbackResponse')) {
      return { ok: false, called: true, words: 'eBay did not answer. Nexus tries again within the hour.' }
    }
    const parsed = parseEbayFeedbackSummary(text)
    if (parsed.ok === true) return { ok: true, summary: parsed.summary }
    return { ok: false, called: true, words: (parsed as Extract<typeof parsed, { ok: false }>).error }
  } catch (err) {
    // The gateway held the call before sending (the account needs a sign-in, its rate bucket is full): nothing reached
    // eBay, so it does not count against the hour. Otherwise the network failed. Words, never the error.
    logger.warn('[ebay-feedback] summary read failed', { error: err instanceof Error ? err.message : String(err) })
    if (err instanceof GatewayRefusal) {
      return { ok: false, called: false, words: 'Nexus held the read: the eBay account needs attention in Settings › Channels, or eBay’s limit for the hour is reached.' }
    }
    return { ok: false, called: true, words: 'eBay could not be read just now. Nexus tries again within the hour.' }
  }
}

export interface EbayFeedbackOptions {
  maxPages?: number
  entriesPerPage?: number
  marketplace?: string | null
}

export async function fetchEbayFeedback(opts: EbayFeedbackOptions = {}): Promise<AdapterResult> {
  // Gate 1 — explicit opt-in, same flag the write-path uses.
  if (process.env.NEXUS_EBAY_REAL_API !== 'true') {
    return { reviews: [], note: 'NEXUS_EBAY_REAL_API not enabled' }
  }
  // Gate 2 — an active eBay connection must exist.
  // MAP.3 — DECLARED.
  const connection = await tryResolveConnection({ channel: 'EBAY', primary: true })
  if (!connection) {
    return { reviews: [], note: 'no active eBay connection' }
  }

  let token: string
  try {
    token = await ebayAuthService.getValidToken(connection.id)
  } catch (err) {
    return { reviews: [], error: `token: ${err instanceof Error ? err.message : String(err)}` }
  }

  const compatLevel = process.env.EBAY_COMPAT_LEVEL || '1193'
  const siteId = process.env.EBAY_SITE_ID || '101' // 101 = Italy
  const entriesPerPage = Math.min(opts.entriesPerPage ?? 200, 200)
  const maxPages = Math.min(opts.maxPages ?? 5, 50)
  // Reviews eBay REST (PR G): feedback belongs to the eBay account, not to a site, and eBay names no market with it. The
  // market comes from the feedback's Nexus order (linkEbayFeedbackOrders); before that, only an account connected for
  // ONE market gives one. Never a default market (it stamped every feedback 'IT' before).
  const marketplace = marketOf(opts.marketplace) ?? marketOf(connection.marketplace) ?? undefined

  const parser = new XMLParser({ ignoreAttributes: true, parseTagValue: false })
  const reviews: AdapterRawReview[] = []

  try {
    let page = 1
    let totalPages = 1
    do {
      const xml =
        `<?xml version="1.0" encoding="utf-8"?>` +
        `<GetFeedbackRequest xmlns="urn:ebay:apis:eBLBaseComponents">` +
        `<DetailLevel>ReturnAll</DetailLevel>` +
        `<FeedbackType>FeedbackReceivedAsSeller</FeedbackType>` +
        `<Pagination><EntriesPerPage>${entriesPerPage}</EntriesPerPage>` +
        `<PageNumber>${page}</PageNumber></Pagination>` +
        `</GetFeedbackRequest>`

      const res = await ebayTradingSend(connection.id, TRADING_ENDPOINT, {
        method: 'POST',
        headers: {
          'X-EBAY-API-CALL-NAME': 'GetFeedback',
          'X-EBAY-API-COMPATIBILITY-LEVEL': compatLevel,
          'X-EBAY-API-SITEID': siteId,
          'X-EBAY-API-IAF-TOKEN': token,
          'Content-Type': 'text/xml',
        },
        body: xml,
      })
      if (!res.ok) {
        return { reviews, error: `GetFeedback HTTP ${res.status}` }
      }
      const text = await res.text()
      const doc = parser.parse(text) as Record<string, unknown>
      const resp = (doc.GetFeedbackResponse ?? {}) as Record<string, unknown>
      const ack = String(resp.Ack ?? '')
      if (ack === 'Failure') {
        const errors = resp.Errors as { ShortMessage?: string } | undefined
        return { reviews, error: `GetFeedback Failure: ${errors?.ShortMessage ?? 'unknown'}` }
      }

      const arrayWrap = (resp.FeedbackDetailArray ?? {}) as Record<string, unknown>
      const details = asArray(arrayWrap.FeedbackDetail as Record<string, unknown> | Record<string, unknown>[])
      for (const d of details) {
        const body = String(d.CommentText ?? '').trim()
        const feedbackId = String(d.FeedbackID ?? '').trim()
        if (!body || !feedbackId) continue
        const commentTime = d.CommentTime ? String(d.CommentTime) : new Date().toISOString()
        reviews.push({
          externalReviewId: feedbackId,
          channel: 'EBAY',
          marketplace,
          body,
          authorName: d.CommentingUser ? String(d.CommentingUser) : undefined,
          rating: commentTypeToRating(d.CommentType ? String(d.CommentType) : undefined),
          verifiedPurchase: true,
          postedAt: new Date(commentTime).toISOString(),
          rawPayload: d,
        })
      }

      const total = (resp.PaginationResult ?? {}) as Record<string, unknown>
      totalPages = Number(total.TotalNumberOfPages ?? 1) || 1
      page += 1
    } while (page <= totalPages && page <= maxPages)
  } catch (err) {
    return { reviews, error: err instanceof Error ? err.message : String(err) }
  }

  try {
    await linkEbayFeedbackOrders(reviews)
  } catch (err) {
    // The order link is a convenience: the feedback is stored without it.
    logger.warn('[ebay-feedback] order link failed', { error: err instanceof Error ? err.message : String(err) })
  }
  await linkProductsQuietly(reviews)
  logger.info('[ebay-feedback] fetched', { count: reviews.length })
  return { reviews }
}

export interface EbayIngestRead extends AdapterResult {
  /** How the rows arrived: eBay's REST Feedback API, or the older Trading GetFeedback read. */
  ingestSource: 'EBAY_REST' | 'EBAY_API'
  /** The eBay account read (the primary one), when there is one. */
  connectionId: string | null
}

/**
 * Reviews eBay REST (2026-10-27, B19 / PR G) — the 30-minute feedback read. eBay's REST Feedback API when it works for
 * the account (photos, eBay's AI topics, revision state; ebay-feedback-rest.adapter.ts), else — no eBay user name on the
 * account, or a sign-in without the feedback permission — the Trading GetFeedback read as before. Same gates as before;
 * never throws.
 */
export async function fetchEbayFeedbackPreferRest(opts: { maxPages?: number } = {}, deps: RestDeps = {}): Promise<EbayIngestRead> {
  if (process.env.NEXUS_EBAY_REAL_API !== 'true' && !deps.enabled) {
    return { reviews: [], note: 'NEXUS_EBAY_REAL_API not enabled', ingestSource: 'EBAY_API', connectionId: null }
  }
  const connection = await tryResolveConnection({ channel: 'EBAY', primary: true })
  if (!connection) return { reviews: [], note: 'no active eBay connection', ingestSource: 'EBAY_API', connectionId: null }
  const ids = await prisma.channelConnection.findUnique({ where: { id: connection.id }, select: { ebaySignInName: true, externalAccountId: true } })
  const account = { connectionId: connection.id, sellerId: ids?.ebaySignInName?.trim() || ids?.externalAccountId?.trim() || null }
  const maxPages = opts.maxPages ?? 5
  const read = await readRestFeedback(account, { maxPages }, deps)
  if (read.ok === false) {
    const refused = read as Extract<typeof read, { ok: false }>
    if (!refused.fallback) return { reviews: [], error: `REST: ${refused.words}`, ingestSource: 'EBAY_REST', connectionId: connection.id }
    const trading = await fetchEbayFeedback({ maxPages })
    return {
      ...trading,
      note: [trading.note, `REST not available (${refused.words}); read by the Trading call instead`].filter(Boolean).join(' · '),
      ingestSource: 'EBAY_API',
      connectionId: connection.id,
    }
  }
  const reviews = (read as Extract<typeof read, { ok: true }>).reviews
  const fixed = marketOf(connection.marketplace)
  if (fixed) for (const r of reviews) r.marketplace = fixed
  applyTopics(reviews, await readRestTopics(account, deps))
  try {
    await linkEbayFeedbackOrders(reviews)
  } catch (err) {
    logger.warn('[ebay-feedback] order link failed', { error: err instanceof Error ? err.message : String(err) })
  }
  await linkProductsQuietly(reviews)
  logger.info('[ebay-feedback] fetched by REST', { count: reviews.length })
  return { reviews, ingestSource: 'EBAY_REST', connectionId: connection.id }
}

/**
 * The public reply to a feedback first read by eBay's REST API (its id is REST's): REST respondToFeedback for the primary
 * eBay account. Same answer shape and gates as `respondToEbayFeedback`; never throws.
 */
export async function respondToEbayFeedbackByRest(feedbackId: string, responseText: string, targetUserId: string, deps: RestDeps = {}): Promise<{ ok: boolean; code: string; error?: string }> {
  if (!targetUserId?.trim()) return { ok: false, code: 'NO_BUYER_ID', error: 'eBay needs the buyer’s user ID to post a reply' }
  if (process.env.NEXUS_EBAY_REAL_API !== 'true' && !deps.enabled) return { ok: false, code: 'OPT_IN_OFF', error: 'NEXUS_EBAY_REAL_API not enabled' }
  const connection = await tryResolveConnection({ channel: 'EBAY', primary: true })
  if (!connection) return { ok: false, code: 'NO_CONNECTION', error: 'no active eBay connection' }
  const answer = await respondToEbayFeedbackRest(connection.id, feedbackId, responseText, targetUserId, deps)
  return { ok: answer.ok, code: answer.code, ...(answer.error ? { error: answer.error } : {}) }
}
