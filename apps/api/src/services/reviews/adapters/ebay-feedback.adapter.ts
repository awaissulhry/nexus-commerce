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
 */

import { XMLParser } from 'fast-xml-parser'
import prisma from '../../../db.js'
import { logger } from '../../../utils/logger.js'
import { ebayAuthService } from '../../ebay-auth.service.js'
import type { AdapterRawReview, AdapterResult } from './types.js'

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
): Promise<{ ok: boolean; code: string; error?: string }> {
  if (process.env.NEXUS_EBAY_REAL_API !== 'true') {
    return { ok: false, code: 'OPT_IN_OFF', error: 'NEXUS_EBAY_REAL_API not enabled' }
  }
  const connection = await prisma.channelConnection.findFirst({
    where: { channelType: 'EBAY', isActive: true },
    orderBy: { lastSyncAt: 'desc' },
  })
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
    `<ResponseType>Reply</ResponseType>` +
    `<ResponseText>${escapeXml(responseText)}</ResponseText>` +
    `</RespondToFeedbackRequest>`
  try {
    const res = await fetch(TRADING_ENDPOINT, {
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
  const connection = await prisma.channelConnection.findFirst({
    where: { channelType: 'EBAY', isActive: true },
    orderBy: { lastSyncAt: 'desc' },
  })
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

      const res = await fetch(TRADING_ENDPOINT, {
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

  logger.info('[ebay-feedback] fetched', { count: reviews.length })
  return { reviews }
}
