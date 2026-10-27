/**
 * Reviews eBay REST (2026-10-27, build spec B19 / PR G) — eBay's REST Feedback API (Commerce Feedback v1, released
 * 2025-10-15), every call through the channel gateway (`ebaySend`, services/gateway/ebay.ts). Checked against eBay's
 * official reference (OpenAPI spec https://developer.ebay.com/develop/api/spec/feedback_api.json):
 *
 *   GET  /commerce/feedback/v1/feedback            getFeedback — read. `user_id` + `feedback_type=FEEDBACK_RECEIVED`
 *        (required), `filter=role:BUYER,…`, `sort=TIME`, `limit` ≤ 200, `offset`. Each entry: `feedbackId`,
 *        `commentType` (POSITIVE | NEUTRAL | NEGATIVE), `feedbackComment.commentText`, `feedbackEnteredDate`, `images[].url`
 *        (a buyer adds up to 5), `topics[]` (eBay's AI topics: `coarseTopic`, `sentiment`, `highlightedTexts` — returned for
 *        a `filter=topics:<topic>` request), `feedbackState` (ENTERED | REVISION_OPEN | REVISED |
 *        REVISION_DECLINED_OR_EXPIRED | WITHDRAWN | HIDDEN), `eligibleForRevision`, `replyComment`, `providerUserDetail`,
 *        `orderLineItemSummary` (`orderLineItemId` "<listingId>-<transactionId>", `listingId`, `listingTitle`).
 *        Scope commerce.feedback or commerce.feedback.readonly.
 *        https://developer.ebay.com/api-docs/commerce/feedback/resources/feedback/methods/getFeedback
 *   GET  /commerce/feedback/v1/awaiting_feedback   getItemsAwaitingFeedback — read. `filter=userRole:SELLER`, `limit` ≤ 25,
 *        `offset`, `sort=END_TIME_DESC`. Each line: `orderLineItemId`, `listingId`, `transactionId`, `listingTitle`,
 *        `listingPrice`, `ratingTemplates`; plus `itemsAwaitingFeedbackCount.asSeller`. No buyer, no date.
 *        https://developer.ebay.com/api-docs/commerce/feedback/resources/awaiting_feedback/methods/getItemsAwaitingFeedback
 *   POST /commerce/feedback/v1/feedback            leaveFeedback — a WRITE that reaches a buyer: `commentType`
 *        (a seller: POSITIVE only), `commentText` ≤ 500, `listingId`, `transactionId`, `orderLineItemId`. Scope
 *        commerce.feedback. Called ONLY by the approved tool `leave-buyer-feedback` (agents/tools/review-actions.tools.ts).
 *        https://developer.ebay.com/api-docs/commerce/feedback/resources/feedback/methods/leaveFeedback
 *   POST /commerce/feedback/v1/respond_to_feedback respondToFeedback — the public reply (`feedbackId`, `recipientUserId`,
 *        `responseText` ≤ 500, `responseType` REPLY), for feedback first read by this API (its feedback id is REST's).
 *        https://developer.ebay.com/api-docs/commerce/feedback/resources/respond_to_feedback/methods/respondToFeedback
 *
 * No method takes a marketplace: feedback belongs to the eBay account, not to one eBay site. A feedback's market is
 * therefore never guessed: it is the market of the Nexus order its order line matches (`linkEbayFeedbackOrders`), or —
 * for an account connected for one market only — that market; otherwise it stays empty (account-wide).
 *
 * Gates as the Trading read: eBay reading switched on for this Nexus (NEXUS_EBAY_REAL_API) and an active eBay account.
 * getFeedback needs the account's eBay user name (or eBay's public user id); a token without the feedback scope is
 * refused by eBay (403) — both fall back to the Trading GetFeedback read (review-ingest.service.ts). Nothing here throws
 * past its boundary: a failure comes back in words.
 */
import { ebaySend } from '../../gateway/ebay.js'
import { WorkspaceCache } from '../../../lib/workspace-cache.js'
import { logger } from '../../../utils/logger.js'
import { EBAY_BUYER_FEEDBACK_LIMIT, EBAY_REPLY_LIMIT, replyLength } from '@nexus/shared/review-reply-rules'
import type { AdapterRawReview, ReviewMediaInput, ReviewTopic } from './types.js'
import { EBAY_FEEDBACK_TOPICS } from './ebay-topics.js'

export const FEEDBACK_API = 'https://api.ebay.com/commerce/feedback/v1'
/** getFeedback `limit` maximum. */
export const FEEDBACK_PAGE_SIZE = 200
/** getItemsAwaitingFeedback `limit` maximum. */
export const AWAITING_PAGE_SIZE = 25
/** At most this many pages of lines awaiting feedback per read (25 each). */
export const AWAITING_MAX_PAGES = 8
/** eBay's AI topics are asked per topic; the pass covers the feedback of the last 30 days, at most every 6 hours. */
export const TOPIC_PASS_EVERY_MS = 6 * 60 * 60 * 1000
export const TOPIC_PERIOD_DAYS = 30

type Json = Record<string, unknown>
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null)
const int = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
  return Number.isFinite(n) ? Math.trunc(n) : null
}

// ── Pure: reading eBay's answers ─────────────────────────────────────

export interface FeedbackPage {
  entries: Json[]
  /** eBay's relative link to the next page, when there is one. */
  next: string | null
  total: number | null
}

/** eBay's error words from a REST error body, or null. */
export function ebayErrorWords(text: string): string | null {
  try {
    const first = arr(obj(JSON.parse(text)).errors)[0]
    const e = obj(first)
    return str(e.longMessage) ?? str(e.message)
  } catch {
    return null
  }
}

/** One getFeedback page; null when the text is not eBay's answer. */
export function parseFeedbackPage(text: string): FeedbackPage | null {
  let body: Json
  try {
    body = obj(JSON.parse(text))
  } catch {
    return null
  }
  if (!('feedbackEntries' in body) && !('pagination' in body)) return null
  const pagination = obj(body.pagination)
  return { entries: arr(body.feedbackEntries).map(obj), next: str(pagination.next), total: int(pagination.total) }
}

function commentTypeToRating(t: string | null): number | undefined {
  switch ((t ?? '').toUpperCase()) {
    case 'POSITIVE': return 5
    case 'NEUTRAL': return 3
    case 'NEGATIVE': return 1
    default: return undefined
  }
}

function sentimentOf(v: unknown): ReviewTopic['sentiment'] {
  const s = (str(v) ?? '').toUpperCase()
  return s === 'POSITIVE' || s === 'NEUTRAL' || s === 'NEGATIVE' ? s : null
}

/** eBay's AI topics of one entry (deduplicated by topic, eBay's order kept). */
export function topicsOf(entry: Json): ReviewTopic[] {
  const out: ReviewTopic[] = []
  for (const t of arr(entry.topics).map(obj)) {
    const topic = str(t.coarseTopic)?.toLowerCase()
    if (!topic || out.some((o) => o.topic === topic)) continue
    out.push({
      topic,
      sentiment: sentimentOf(t.sentiment),
      texts: arr(t.highlightedTexts).map(str).filter((x): x is string => !!x).slice(0, 3),
    })
  }
  return out
}

/** The buyer's photos of one entry, in eBay's order (eBay sends no size; videos are not offered by this API). */
export function mediaOf(entry: Json): ReviewMediaInput[] {
  const urls = arr(entry.images).map((i) => str(obj(i).url)).filter((u): u is string => !!u && /^https:\/\//i.test(u))
  return [...new Set(urls)].map((url, position) => ({ url, type: 'image', width: null, height: null, position }))
}

/** The order line an entry is about: eBay's "<listingId>-<transactionId>" and its two parts. */
export function restOrderLine(entry: Json): { orderLineItemId: string | null; itemId: string | null; transactionId: string | null; title: string | null } {
  const summary = obj(entry.orderLineItemSummary)
  const line = str(summary.orderLineItemId)
  const [itemFromLine, transactionFromLine] = line && /^\d+-\d+$/.test(line) ? line.split('-') : [null, null]
  return {
    orderLineItemId: line,
    itemId: str(summary.listingId) ?? itemFromLine,
    transactionId: transactionFromLine,
    title: str(summary.listingTitle),
  }
}

/**
 * One getFeedback entry as a review row. Null for what is not a buyer's feedback with words (eBay's automated feedback,
 * feedback from a SELLER role, no id, no comment — the Trading read skipped comment-less feedback too).
 */
export function restFeedbackToReview(entry: Json, now: Date = new Date()): AdapterRawReview | null {
  const feedbackId = str(entry.feedbackId)
  if (!feedbackId) return null
  if (entry.automatedFeedback === true) return null
  const provider = obj(entry.providerUserDetail)
  const role = (str(provider.role) ?? 'BUYER').toUpperCase()
  if (role !== 'BUYER') return null
  const comment = obj(entry.feedbackComment)
  const body = str(comment.commentText)
  if (!body) return null
  const entered = str(entry.feedbackEnteredDate)
  const posted = entered && !Number.isNaN(new Date(entered).getTime()) ? new Date(entered) : now
  const state = str(entry.feedbackState)?.toUpperCase() ?? null
  const line = restOrderLine(entry)
  const buyer = str(provider.userId)
  return {
    externalReviewId: feedbackId,
    channel: 'EBAY',
    body,
    authorName: buyer ?? undefined,
    rating: commentTypeToRating(str(entry.commentType)),
    verifiedPurchase: true,
    postedAt: posted.toISOString(),
    rawPayload: entry,
    media: mediaOf(entry),
    feedbackState: state,
    revisionEligible: typeof entry.eligibleForRevision === 'boolean' ? entry.eligibleForRevision : null,
    ...(line.orderLineItemId ? { sameAs: { orderLineItemId: line.orderLineItemId, buyer } } : {}),
  }
}

export interface AwaitingLine {
  orderLineItemId: string
  listingId: string | null
  transactionId: string | null
  title: string | null
  price: number | null
  currency: string | null
  /** eBay's rating template for the seller allows POSITIVE (always so for a seller; false only if eBay says otherwise). */
  positiveAllowed: boolean
}

/** One getItemsAwaitingFeedback page; null when the text is not eBay's answer. */
export function parseAwaitingPage(text: string): { lines: AwaitingLine[]; next: string | null; total: number | null; asSeller: number | null } | null {
  let body: Json
  try {
    body = obj(JSON.parse(text))
  } catch {
    return null
  }
  if (!('lineItems' in body) && !('pagination' in body) && !('itemsAwaitingFeedbackCount' in body)) return null
  const lines: AwaitingLine[] = []
  for (const l of arr(body.lineItems).map(obj)) {
    const orderLineItemId = str(l.orderLineItemId)
    if (!orderLineItemId) continue
    const listingId = str(l.listingId) ?? (/^\d+-\d+$/.test(orderLineItemId) ? orderLineItemId.split('-')[0] : null)
    const transactionId = str(l.transactionId) ?? (/^\d+-\d+$/.test(orderLineItemId) ? orderLineItemId.split('-')[1] : null)
    const price = obj(l.listingPrice)
    const overall = arr(l.ratingTemplates).map(obj).find((t) => str(t.ratingKey) === 'OVERALL_EXPERIENCE')
    const positive = overall ? arr(overall.acceptableValues).map(obj).find((v) => str(v.value) === 'POSITIVE') : undefined
    lines.push({
      orderLineItemId,
      listingId,
      transactionId,
      title: str(l.listingTitle),
      price: typeof price.value === 'number' ? price.value : price.value != null && Number.isFinite(Number(price.value)) ? Number(price.value) : null,
      currency: str(price.currency),
      positiveAllowed: positive ? positive.enabled !== false : true,
    })
  }
  const pagination = obj(body.pagination)
  return { lines, next: str(pagination.next), total: int(pagination.total), asSeller: int(obj(body.itemsAwaitingFeedbackCount).asSeller) }
}

/** The getFeedback address for one page (received from buyers, newest first). */
export function feedbackUrl(sellerId: string, opts: { offset?: number; limit?: number; topic?: string; periodDays?: number } = {}): string {
  const filter = ['role:BUYER', ...(opts.topic ? [`topics:${opts.topic}`] : []), ...(opts.periodDays ? [`period:${opts.periodDays}`] : [])].join(',')
  const q = new URLSearchParams({
    user_id: sellerId,
    feedback_type: 'FEEDBACK_RECEIVED',
    filter,
    sort: 'TIME',
    limit: String(Math.min(opts.limit ?? FEEDBACK_PAGE_SIZE, FEEDBACK_PAGE_SIZE)),
    offset: String(opts.offset ?? 0),
  })
  return `${FEEDBACK_API}/feedback?${q.toString()}`
}

/** The getItemsAwaitingFeedback address for one page (the seller's side only). */
export function awaitingUrl(offset = 0): string {
  const q = new URLSearchParams({ filter: 'userRole:SELLER', limit: String(AWAITING_PAGE_SIZE), offset: String(offset), sort: 'END_TIME_DESC' })
  return `${FEEDBACK_API}/awaiting_feedback?${q.toString()}`
}

export interface LeaveFeedbackInput {
  orderLineItemId: string
  listingId: string | null
  transactionId: string | null
  text: string
}

/** The leaveFeedback body: a seller leaves POSITIVE feedback only (eBay refuses anything else from a seller). */
export function leaveFeedbackBody(input: LeaveFeedbackInput): Json {
  return {
    commentType: 'POSITIVE',
    commentText: input.text.trim(),
    orderLineItemId: input.orderLineItemId,
    ...(input.listingId ? { listingId: input.listingId } : {}),
    ...(input.transactionId ? { transactionId: input.transactionId } : {}),
  }
}

// ── I/O (through the gateway) ────────────────────────────────────────

/** A fetch-shaped eBay sender bound to an account; tests pass their own (never eBay). */
export type EbaySender = (connectionId: string | null, url: string, init?: RequestInit) => Promise<Response>

export interface RestDeps {
  send?: EbaySender
  /** eBay reading switched on (default: NEXUS_EBAY_REAL_API === 'true'). */
  enabled?: () => boolean
  now?: () => Date
}

const live = () => process.env.NEXUS_EBAY_REAL_API === 'true'
const sender = (deps: RestDeps): EbaySender => deps.send ?? ((connectionId, url, init = {}) => ebaySend(connectionId, url, init))

export interface RestAccount {
  connectionId: string
  /** eBay user name (or eBay's public user id) of the seller: getFeedback's `user_id`. */
  sellerId: string | null
}

export type RestFeedbackRead =
  | { ok: true; reviews: AdapterRawReview[] }
  /** `fallback`: REST is not available for this account (no user name, no feedback scope) — read by Trading instead. */
  | { ok: false; fallback: boolean; words: string }

/**
 * The feedback buyers left for the seller, newest first, up to `maxPages` pages of 200, with photos and eBay's state
 * (revision) of each. Never throws.
 */
export async function readRestFeedback(account: RestAccount, opts: { maxPages?: number } = {}, deps: RestDeps = {}): Promise<RestFeedbackRead> {
  if (!(deps.enabled ?? live)()) return { ok: false, fallback: false, words: 'Nexus does not read eBay in this setup yet.' }
  if (!account.sellerId) {
    return { ok: false, fallback: true, words: 'eBay’s feedback read needs the account’s eBay user name, which Nexus does not have: reconnect eBay in Settings › Channels.' }
  }
  const send = sender(deps)
  const now = (deps.now ?? (() => new Date()))()
  const maxPages = Math.min(Math.max(opts.maxPages ?? 5, 1), 50)
  const reviews: AdapterRawReview[] = []
  try {
    for (let page = 0; page < maxPages; page++) {
      const res = await send(account.connectionId, feedbackUrl(account.sellerId, { offset: page * FEEDBACK_PAGE_SIZE }))
      const text = await res.text()
      if (!res.ok) {
        // 403: the sign-in lacks the feedback scope; 404/400 on the first page: the account is not on this API yet.
        const fallback = page === 0 && (res.status === 403 || res.status === 404 || res.status === 400)
        return { ok: false, fallback, words: `eBay refused the feedback read (${res.status})${ebayErrorWords(text) ? `: ${ebayErrorWords(text)}` : ''}.` }
      }
      const parsed = parseFeedbackPage(text)
      if (!parsed) return { ok: false, fallback: page === 0, words: 'eBay’s answer was not a feedback list.' }
      for (const entry of parsed.entries) {
        const review = restFeedbackToReview(entry, now)
        if (review) reviews.push(review)
      }
      if (!parsed.next || parsed.entries.length < FEEDBACK_PAGE_SIZE) break
    }
  } catch (err) {
    logger.warn('[ebay-feedback-rest] read failed', { error: err instanceof Error ? err.message : String(err) })
    return reviews.length > 0 ? { ok: true, reviews } : { ok: false, fallback: false, words: 'eBay could not be read just now. Nexus tries again in 30 minutes.' }
  }
  return { ok: true, reviews }
}

const topicPassAt = new WorkspaceCache<string, number>(50)

/**
 * eBay's AI topics of the feedback of the last 30 days: one getFeedback per topic (`filter=topics:<t>,period:30`), at most
 * every 6 hours per account. A map feedback id → its topics, or null when the pass did not run (too soon, eBay off) —
 * then stored topics are kept as they are. A feedback of the period that no topic returned has none ([]).
 */
export async function readRestTopics(
  account: RestAccount,
  deps: RestDeps & { lastRun?: Map<string, number> } = {},
): Promise<{ topics: Map<string, ReviewTopic[]>; since: Date } | null> {
  if (!(deps.enabled ?? live)() || !account.sellerId) return null
  const now = (deps.now ?? (() => new Date()))()
  const last = deps.lastRun ?? topicPassAt
  const at = last.get(account.connectionId)
  if (at != null && now.getTime() - at < TOPIC_PASS_EVERY_MS) return null
  last.set(account.connectionId, now.getTime())
  const send = sender(deps)
  const topics = new Map<string, ReviewTopic[]>()
  try {
    for (const topic of EBAY_FEEDBACK_TOPICS) {
      const res = await send(account.connectionId, feedbackUrl(account.sellerId, { topic, periodDays: TOPIC_PERIOD_DAYS }))
      if (!res.ok) {
        // A refused topic read leaves the stored topics alone (and tries again next pass).
        last.delete(account.connectionId)
        return null
      }
      const parsed = parseFeedbackPage(await res.text())
      for (const entry of parsed?.entries ?? []) {
        const id = str(entry.feedbackId)
        if (!id) continue
        const found = topicsOf(entry)
        const mine = found.length > 0 ? found : [{ topic, sentiment: null, texts: [] }]
        const list = topics.get(id) ?? []
        for (const t of mine) if (!list.some((x) => x.topic === t.topic)) list.push(t)
        topics.set(id, list)
      }
    }
  } catch (err) {
    last.delete(account.connectionId)
    logger.warn('[ebay-feedback-rest] topics read failed', { error: err instanceof Error ? err.message : String(err) })
    return null
  }
  return { topics, since: new Date(now.getTime() - TOPIC_PERIOD_DAYS * 24 * 60 * 60 * 1000) }
}

/** Puts eBay's topics on the rows they cover; a row of the topic period no topic named gets [] (none). */
export function applyTopics(reviews: AdapterRawReview[], pass: { topics: Map<string, ReviewTopic[]>; since: Date } | null): void {
  if (!pass) return
  for (const r of reviews) {
    const found = pass.topics.get(r.externalReviewId)
    if (found) r.channelTopics = found
    else if (new Date(r.postedAt).getTime() >= pass.since.getTime()) r.channelTopics = []
  }
}

export type AwaitingRead =
  | { ok: true; lines: AwaitingLine[]; asSeller: number | null; complete: boolean }
  | { ok: false; words: string }

/** The seller's order lines that wait for feedback for the buyer (up to 8 pages of 25). Never throws. */
export async function readItemsAwaitingFeedback(connectionId: string, deps: RestDeps = {}): Promise<AwaitingRead> {
  if (!(deps.enabled ?? live)()) return { ok: false, words: 'Nexus does not read eBay in this setup yet.' }
  const send = sender(deps)
  const lines: AwaitingLine[] = []
  let asSeller: number | null = null
  try {
    for (let page = 0; page < AWAITING_MAX_PAGES; page++) {
      const res = await send(connectionId, awaitingUrl(page * AWAITING_PAGE_SIZE))
      const text = await res.text()
      if (!res.ok) return { ok: false, words: `eBay refused the list of sales waiting for feedback (${res.status})${ebayErrorWords(text) ? `: ${ebayErrorWords(text)}` : ''}.` }
      const parsed = parseAwaitingPage(text)
      if (!parsed) return { ok: false, words: 'eBay’s answer was not a list of sales waiting for feedback.' }
      asSeller = parsed.asSeller ?? asSeller
      lines.push(...parsed.lines)
      if (!parsed.next || parsed.lines.length < AWAITING_PAGE_SIZE) return { ok: true, lines, asSeller, complete: true }
    }
  } catch (err) {
    logger.warn('[ebay-feedback-rest] awaiting read failed', { error: err instanceof Error ? err.message : String(err) })
    return { ok: false, words: 'eBay could not be read just now. Nexus tries again in 30 minutes.' }
  }
  return { ok: true, lines, asSeller, complete: false }
}

export interface WriteAnswer {
  ok: boolean
  code: string
  /** eBay's id of the new feedback (leaveFeedback). */
  feedbackId?: string | null
  error?: string
}

/**
 * leaveFeedback — POSITIVE feedback for the buyer of one order line. A write that reaches a buyer and cannot be taken
 * back: the only caller is the approved tool `leave-buyer-feedback`. Refuses (nothing sent) when eBay posting is off or
 * the text breaks eBay's limit. Never throws.
 */
export async function leaveEbayBuyerFeedback(connectionId: string, input: LeaveFeedbackInput, deps: RestDeps = {}): Promise<WriteAnswer> {
  if (!(deps.enabled ?? live)()) return { ok: false, code: 'OPT_IN_OFF', error: 'Nexus does not post to eBay in this setup. Nothing was sent.' }
  const text = input.text.trim()
  if (!text) return { ok: false, code: 'EMPTY', error: 'The feedback has no text. Nothing was sent.' }
  if (replyLength(text) > EBAY_BUYER_FEEDBACK_LIMIT) return { ok: false, code: 'TOO_LONG', error: `eBay allows at most ${EBAY_BUYER_FEEDBACK_LIMIT} characters. Nothing was sent.` }
  try {
    const res = await sender(deps)(connectionId, `${FEEDBACK_API}/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(leaveFeedbackBody({ ...input, text })),
    })
    const answer = await res.text()
    if (!res.ok) return { ok: false, code: `HTTP_${res.status}`, error: ebayErrorWords(answer) ?? `eBay answered ${res.status}.` }
    let feedbackId: string | null = null
    try {
      feedbackId = str(obj(JSON.parse(answer)).feedbackId)
    } catch {
      feedbackId = null
    }
    return { ok: true, code: 'Success', feedbackId }
  } catch (err) {
    return { ok: false, code: 'EXCEPTION', error: err instanceof Error ? err.message : String(err) }
  }
}

/** respondToFeedback — the public reply under a feedback read by this API (one reply, ≤ 500). Never throws. */
export async function respondToEbayFeedbackRest(
  connectionId: string,
  feedbackId: string,
  responseText: string,
  recipientUserId: string,
  deps: RestDeps = {},
): Promise<WriteAnswer> {
  if (!recipientUserId?.trim()) return { ok: false, code: 'NO_BUYER_ID', error: 'eBay needs the buyer’s user ID to post a reply' }
  if (!(deps.enabled ?? live)()) return { ok: false, code: 'OPT_IN_OFF', error: 'NEXUS_EBAY_REAL_API not enabled' }
  if (replyLength(responseText) > EBAY_REPLY_LIMIT) return { ok: false, code: 'TOO_LONG', error: `eBay allows at most ${EBAY_REPLY_LIMIT} characters` }
  try {
    const res = await sender(deps)(connectionId, `${FEEDBACK_API}/respond_to_feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ feedbackId, recipientUserId: recipientUserId.trim(), responseText, responseType: 'REPLY' }),
    })
    if (!res.ok) return { ok: false, code: res.status === 409 || res.status === 403 ? 'FAILURE' : `HTTP_${res.status}`, error: ebayErrorWords(await res.text()) ?? `HTTP ${res.status}` }
    return { ok: true, code: 'Success' }
  } catch (err) {
    return { ok: false, code: 'EXCEPTION', error: err instanceof Error ? err.message : String(err) }
  }
}
