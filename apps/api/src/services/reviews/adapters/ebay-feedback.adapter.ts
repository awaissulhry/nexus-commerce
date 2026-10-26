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

/** The order line a feedback is about, as GetFeedback names it (masked ids such as "11111111-0" are dropped). */
export function ebayFeedbackOrderRef(detail: Record<string, unknown>): { orderLineItemId: string | null; transactionId: string | null; itemId: string | null } {
  const text = (v: unknown) => {
    const s = v == null ? '' : String(v).trim()
    return s && !/^1+(-0)?$/.test(s) && s !== '0' ? s : null
  }
  return { orderLineItemId: text(detail.OrderLineItemID), transactionId: text(detail.TransactionID), itemId: text(detail.ItemID) }
}

/**
 * The Nexus order of each feedback, when exactly one order matches its order line: an eBay order stored under the
 * legacy order-line id ("ItemID-TransactionID"), or an order line whose eBay line id is the feedback's TransactionID
 * (and whose listing, when stored, is the feedback's ItemID). No match, or more than one: no link.
 */
export async function linkEbayFeedbackOrders(reviews: AdapterRawReview[]): Promise<void> {
  const refs = reviews.map((r) => ebayFeedbackOrderRef((r.rawPayload ?? {}) as Record<string, unknown>))
  const lineIds = [...new Set(refs.map((r) => r.orderLineItemId).filter((v): v is string => !!v))]
  const transactionIds = [...new Set(refs.map((r) => r.transactionId).filter((v): v is string => !!v))]
  if (lineIds.length === 0 && transactionIds.length === 0) return
  const [orders, items] = await Promise.all([
    lineIds.length > 0
      ? prisma.order.findMany({ where: { channel: 'EBAY', channelOrderId: { in: lineIds } }, select: { id: true, channelOrderId: true } })
      : Promise.resolve([] as { id: string; channelOrderId: string }[]),
    transactionIds.length > 0
      ? prisma.orderItem.findMany({
          where: { externalLineItemId: { in: transactionIds }, order: { channel: 'EBAY' } },
          select: { orderId: true, externalLineItemId: true, ebayMetadata: true },
        })
      : Promise.resolve([] as { orderId: string; externalLineItemId: string | null; ebayMetadata: unknown }[]),
  ])
  reviews.forEach((review, i) => {
    const ref = refs[i]
    const matches = new Set<string>()
    for (const o of orders) if (ref.orderLineItemId && o.channelOrderId === ref.orderLineItemId) matches.add(o.id)
    for (const item of items) {
      if (!ref.transactionId || item.externalLineItemId !== ref.transactionId) continue
      const listing = (item.ebayMetadata as { legacyItemId?: unknown } | null)?.legacyItemId
      if (ref.itemId && typeof listing === 'string' && listing && listing !== ref.itemId) continue
      matches.add(item.orderId)
    }
    if (matches.size === 1) review.orderId = [...matches][0]
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
  const marketplace = opts.marketplace ?? connection.marketplace ?? 'IT'

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
  logger.info('[ebay-feedback] fetched', { count: reviews.length })
  return { reviews }
}
