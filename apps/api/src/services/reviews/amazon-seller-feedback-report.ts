/**
 * Amazon seller feedback (2026-10-27, Reviews area PR H, build spec B20) — the pure half: reading Amazon's
 * `GET_SELLER_FEEDBACK_DATA` report, keying its rows, planning the Review upserts, and the per-market fetch state in
 * words. No I/O here (amazon-seller-feedback.service.ts does the fetching and writing); tested in
 * amazon-seller-feedback.vitest.test.ts.
 *
 * Facts (Amazon's own docs, checked 2026-10-27):
 * - https://developer-docs.amazon.com/sp-api/docs/report-type-values-performance — `GET_SELLER_FEEDBACK_DATA`
 *   "Contains negative and neutral feedback (one to three stars) from buyers who rated the seller's performance."
 *   Tab-delimited flat file, columns Date, Rating, Comments, Your Response, Order ID, Rater Email (deprecated: always
 *   no-reply@amazon.com, so Nexus never reads it). "This report can only be requested" — it cannot be scheduled at
 *   Amazon, so Nexus requests it itself. Roles: Selling Partner Insights or Amazon Fulfillment.
 * - https://developer-docs.amazon.com/sp-api/docs/verify-that-report-processing-is-complete — a report ends DONE,
 *   FATAL or CANCELLED; CANCELLED includes "an automatic cancellation if there is no data to return".
 *
 * One feedback per order on Amazon, so the order id keys a row (`Review.externalReviewId` = `amazon-feedback:<order>`;
 * the existing `(workspaceId, channel, externalReviewId)` unique key makes a re-read update, never duplicate).
 */
import { MARKETPLACE_ID_TO_CODE } from '../../utils/marketplace-code.js'

export const SELLER_FEEDBACK_REPORT_TYPE = 'GET_SELLER_FEEDBACK_DATA'
/** `Review.ingestSource` of rows read from Amazon's seller feedback report. */
export const SELLER_FEEDBACK_SOURCE = 'AMAZON_SELLER_FEEDBACK'
/** How far back each fetch asks: Amazon's removal window, and long enough for a buyer's late feedback. */
export const FEEDBACK_WINDOW_DAYS = 90
/** A fetch that has not finished after this long stopped (the report poll gives up after about 5 minutes). */
export const FETCH_STALE_MS = 20 * 60 * 1000

const DAY_MS = 24 * 60 * 60 * 1000

export class FeedbackReportShapeError extends Error {
  /**
   * @param missing the columns found neither by name nor by contents ("Date", "Rating", "Order ID")
   * @param headers the report's column titles, for the log (titles are not personal data; a cell that looks like a value
   *   is already hidden, see `headerForLog`). Never row values.
   */
  constructor(readonly missing: string[], readonly headers: string[] = []) {
    const seen = headers.length ? ` Columns seen: ${headers.slice(0, 12).map((h) => `“${h}”`).join(', ')}.` : ''
    super(`Amazon's feedback report has no ${missing.join(', ')} column Nexus could find by name or by its contents, so Nexus could not read it.${seen}`)
    this.name = 'FeedbackReportShapeError'
  }
}

export interface ParsedFeedback {
  externalReviewId: string
  /** Amazon's order id ("028-1234567-1234567"). */
  amazonOrderId: string
  rating: number
  /** The buyer's comment ('' when none). */
  comment: string
  /** The seller's public reply from Feedback Manager, when there is one. */
  response: string | null
  postedAt: Date
  /** The report's own date text, kept for the raw payload. */
  rawDate: string
}

export interface ParseResult {
  rows: ParsedFeedback[]
  /** Lines that could not be read, with the reason in words (1-based line numbers, header = 1). */
  skipped: Array<{ line: number; reason: string }>
  /** How the columns were found when the report had feedback lines: by their names, or by what they hold. */
  columnsFrom?: 'names' | 'contents'
}

const BOM = /^\uFEFF/

/** A header as a key: accents folded, lower case, letters and digits only ("Order ID" → "orderid", "Évaluation" → "evaluation"). */
export function headerKey(h: string): string {
  return h.replace(BOM, '').normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

type Column = 'date' | 'rating' | 'comments' | 'response' | 'orderId' | 'raterEmail'

/**
 * Column names Nexus knows, as keys (`headerKey`) — only names with a source:
 * - English: Amazon's own list (report-type-values-performance, above): Date, Rating, Comments, Your Response, Order ID,
 *   Rater Email (plus the spellings Nexus read before 2026-10-27).
 * - Every other language (IT, DE, FR, ES, NL, PL, SV, TR): no source publishes Amazon's localized header texts (searched
 *   2026-10-27: Amazon's docs list the English names only; seller forums, GitHub code and issues give none). What open
 *   source readers do say: Airbyte's connector (github.com/airbytehq/airbyte, source-amazon-seller-partner/components.py,
 *   `SellerFeedbackReportsGzipCsvDecoder`) — the header names "differ per marketplace (are localized to marketplace
 *   language) but columns come in the same order", so it reads them by position; wimoor (github.com/wimoor-erp/wimoor,
 *   ReportAmzFeedbackServiceImpl.java) reads positions 0–5 too. So a header Nexus does not know is read by what its
 *   columns hold (`findColumns`), never by a guessed translation.
 */
const COLUMN_KEYS: Record<Column, readonly string[]> = {
  date: ['date', 'feedbackdate'],
  rating: ['rating'],
  comments: ['comments', 'comment'],
  response: ['yourresponse', 'response'],
  orderId: ['orderid', 'amazonorderid'],
  raterEmail: ['rateremail'],
}

/** Amazon's documented column order (report-type-values-performance), the same in every market (Airbyte, above). */
const DOCUMENTED_ORDER: readonly Column[] = ['date', 'rating', 'comments', 'response', 'orderId', 'raterEmail']

/** Amazon's order id: 3, 7 and 7 digits. */
const AMAZON_ORDER_ID = /^\d{3}-\d{7}-\d{7}$/

const REQUIRED_LABEL: Record<'date' | 'rating' | 'orderId', string> = { date: 'Date', rating: 'Rating', orderId: 'Order ID' }

/** One TSV field: surrounding quotes taken off and doubled quotes made single. */
function field(raw: string | undefined): string {
  const t = (raw ?? '').trim()
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1).replace(/""/g, '"').trim()
  return t
}

/** Stars as a whole number 1–5 ("2", "2.0"); null for anything else. */
export function parseFeedbackRating(raw: string | null | undefined): number | null {
  const t = (raw ?? '').trim().replace(',', '.')
  if (!/^\d+(\.0+)?$/.test(t)) return null
  const n = Number(t)
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null
}

/** Markets whose Seller Central writes the month first (US style). Every European market writes the day first. */
const MONTH_FIRST_MARKETS: ReadonlySet<string> = new Set(['US', 'CA', 'MX'])

function utcDate(y: number, m: number, d: number): Date | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null
  const at = new Date(Date.UTC(y, m - 1, d))
  return at.getUTCFullYear() === y && at.getUTCMonth() === m - 1 && at.getUTCDate() === d ? at : null
}

/**
 * The report's date → a UTC day. Amazon's docs give no format, so every form a flat file uses is read: ISO
 * ("2026-10-25", with or without a time), and day/month/year with "/", "." or "-" and a 2- or 4-digit year. (Airbyte's
 * connector, `SellerFeedbackReportsTypeTransformer.MARKETPLACE_DATE_FORMAT_MAP`, reads this report as d.m.yy in DE,
 * yyyy-mm-dd in SE and d/m/yy in the other European markets — all read here.) A date
 * whose first or second part is over 12 is read the only way it can be; otherwise the market decides (day first in
 * Europe, month first in the US, Canada and Mexico). Null when it is not a real date.
 */
export function parseFeedbackDate(raw: string | null | undefined, market?: string | null): Date | null {
  const t = (raw ?? '').trim()
  if (!t) return null
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(t)
  if (iso) {
    if (t.length > 10) {
      const full = new Date(t)
      if (!Number.isNaN(full.getTime())) return full
    }
    return utcDate(Number(iso[1]), Number(iso[2]), Number(iso[3]))
  }
  const parts = /^(\d{1,4})[./-](\d{1,2})[./-](\d{2,4})(?:\s.*)?$/.exec(t)
  if (!parts) return null
  let [a, b, c] = [Number(parts[1]), Number(parts[2]), Number(parts[3])]
  if (parts[1].length === 4) return utcDate(a, b, c) // 2026/10/25
  if (parts[3].length === 2) c += 2000
  else if (parts[3].length !== 4) return null
  let day: number
  let month: number
  if (a > 12) [day, month] = [a, b]
  else if (b > 12) [day, month] = [b, a]
  else if (MONTH_FIRST_MARKETS.has((market ?? '').toUpperCase())) [day, month] = [b, a]
  else [day, month] = [a, b]
  return utcDate(c, month, day)
}

/** The Review key of one feedback: Amazon allows one seller feedback per order. */
export function feedbackExternalId(amazonOrderId: string): string {
  return `amazon-feedback:${amazonOrderId.trim()}`
}

/** A header cell fit for a log line. Titles are not personal data; a cell that looks like a value (digits, an e-mail, long
 *  text) is hidden all the same, in case the first line of a file was a feedback line. */
function headerForLog(cell: string): string {
  const t = field(cell.replace(BOM, ''))
  if (!t) return '(empty)'
  return t.length > 40 || /[\d@]/.test(t) ? '(hidden)' : t
}

interface FeedbackColumns {
  date: number
  rating: number
  orderId: number
  /** -1 when the report has none. */
  comments: number
  response: number
  from: 'names' | 'contents'
}

/**
 * Where each column is. First by name (`COLUMN_KEYS`). When the Date, Rating or Order ID name is not one Nexus knows (a
 * report in the market's language), by what the feedback lines hold: the order id is the column of Amazon order ids
 * (3-7-7 digits), the date the column `parseFeedbackDate` reads for this market, the stars the column of whole numbers
 * 1–5 — each the column where at least half of the lines fit, most first. When two columns fit equally (a comment that is
 * just "3"), Amazon's documented order decides, and only when the report has its column count (6, or 5 without the
 * deprecated Rater Email) and that column is one that fits. Comments and the seller's response, when their names are
 * unknown too, are the columns beside them in that order: the comment right after the stars, the response right
 * before the order id. Throws `FeedbackReportShapeError` with the column titles when Date, Rating or Order ID is still
 * not found.
 */
function findColumns(headerCells: readonly string[], rows: readonly string[][], market?: string | null): FeedbackColumns {
  const keys = headerCells.map(headerKey)
  const at: Partial<Record<Column, number>> = {}
  for (const name of DOCUMENTED_ORDER) {
    const i = keys.findIndex((k) => COLUMN_KEYS[name].includes(k))
    if (i !== -1) at[name] = i
  }
  const named = at.date != null && at.rating != null && at.orderId != null
  if (!named) {
    const taken = new Set(Object.values(at))
    const width = Math.max(headerCells.length, ...rows.map((r) => r.length))
    const documentedCount = headerCells.length === DOCUMENTED_ORDER.length || headerCells.length === DOCUMENTED_ORDER.length - 1
    const fits: Record<'date' | 'rating' | 'orderId', (v: string) => boolean> = {
      orderId: (v) => AMAZON_ORDER_ID.test(v),
      date: (v) => parseFeedbackDate(v, market) != null,
      rating: (v) => parseFeedbackRating(v) != null,
    }
    // The most telling first: an order id fits nothing else, a date never looks like stars.
    for (const name of ['orderId', 'date', 'rating'] as const) {
      if (at[name] != null) continue
      const counts: Array<{ i: number; n: number }> = []
      for (let i = 0; i < width; i++) {
        if (taken.has(i)) continue
        const n = rows.filter((r) => fits[name](field(r[i]))).length
        if (n > 0 && n * 2 >= rows.length) counts.push({ i, n })
      }
      const most = Math.max(0, ...counts.map((c) => c.n))
      const best = counts.filter((c) => c.n === most)
      const documented = DOCUMENTED_ORDER.indexOf(name)
      const pick = best.length === 1 ? best[0].i : documentedCount && best.some((c) => c.i === documented) ? documented : null
      if (pick != null) { at[name] = pick; taken.add(pick) }
    }
  }
  const missing = (['date', 'rating', 'orderId'] as const).filter((name) => at[name] == null)
  if (missing.length) throw new FeedbackReportShapeError(missing.map((name) => REQUIRED_LABEL[name]), headerCells.map(headerForLog))

  const rating = at.rating!
  const orderId = at.orderId!
  const used = new Set(Object.values(at))
  const free = (i: number) => i >= 0 && i < headerCells.length && !used.has(i)
  const comments = at.comments ?? (free(rating + 1) ? rating + 1 : -1)
  const response = at.response ?? (free(orderId - 1) && orderId - 1 !== comments ? orderId - 1 : -1)
  return { date: at.date!, rating, orderId, comments, response, from: named ? 'names' : 'contents' }
}

/**
 * Amazon's tab-delimited report → feedback rows. A report with a header line and no feedback line is no feedback (Amazon
 * only reports 1–3 stars, and a market without any is normal), whatever its header says. The columns are found by
 * name, else by what they hold (`findColumns`); `FeedbackReportShapeError` when the Date, Rating or Order ID column is
 * still not found (the file is not this report). A row without an order id, a real date or a 1–5 rating is skipped
 * with its reason. The same order twice keeps the newest line.
 */
export function parseSellerFeedbackReport(text: string, market?: string | null): ParseResult {
  const lines = String(text ?? '').replace(BOM, '').split(/\r?\n/)
  const headerIndex = lines.findIndex((l) => l.trim().length > 0)
  if (headerIndex === -1) return { rows: [], skipped: [] }
  const feedbackLines: Array<{ line: number; cells: string[] }> = []
  for (let i = headerIndex + 1; i < lines.length; i++) {
    if (lines[i].trim()) feedbackLines.push({ line: i + 1, cells: lines[i].split('\t') })
  }
  if (feedbackLines.length === 0) return { rows: [], skipped: [] }
  const at = findColumns(lines[headerIndex].split('\t'), feedbackLines.map((l) => l.cells), market)

  const byKey = new Map<string, ParsedFeedback>()
  const skipped: ParseResult['skipped'] = []
  for (const { line, cells } of feedbackLines) {
    const orderId = field(cells[at.orderId])
    const rawDate = field(cells[at.date])
    const postedAt = parseFeedbackDate(rawDate, market)
    const rating = parseFeedbackRating(field(cells[at.rating]))
    if (!orderId) { skipped.push({ line, reason: 'No order ID' }); continue }
    if (!postedAt) { skipped.push({ line, reason: `The date “${rawDate}” could not be read` }); continue }
    if (rating == null) { skipped.push({ line, reason: 'No rating from 1 to 5' }); continue }
    const response = at.response === -1 ? '' : field(cells[at.response])
    const row: ParsedFeedback = {
      externalReviewId: feedbackExternalId(orderId),
      amazonOrderId: orderId,
      rating,
      comment: at.comments === -1 ? '' : field(cells[at.comments]),
      response: response || null,
      postedAt,
      rawDate,
    }
    const before = byKey.get(row.externalReviewId)
    if (!before || row.postedAt >= before.postedAt) byKey.set(row.externalReviewId, row)
  }
  return { rows: [...byKey.values()].sort((x, y) => y.postedAt.getTime() - x.postedAt.getTime()), skipped, columnsFrom: at.from }
}

// ── Upserts ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** What a stored feedback row holds that a re-read can change. */
export interface StoredFeedback {
  id: string
  externalReviewId: string
  rating: number | null
  body: string
  orderId: string | null
  triageStatus: string | null
  rawPayload: unknown
}

/** The raw payload stored with a row: the report's own values, never the (deprecated) rater e-mail. */
export function feedbackPayload(row: ParsedFeedback, market: string, reportId: string | null): Record<string, unknown> {
  return {
    report: SELLER_FEEDBACK_REPORT_TYPE,
    reportId,
    market,
    date: row.rawDate,
    rating: row.rating,
    comments: row.comment,
    yourResponse: row.response,
    amazonOrderId: row.amazonOrderId,
  }
}

const OPEN = new Set([null, 'NEW', 'IN_PROGRESS'])

function storedResponse(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null
  const r = (raw as Record<string, unknown>).yourResponse
  return typeof r === 'string' && r.trim() ? r : null
}

export interface FeedbackUpdate {
  id: string
  data: {
    rating?: number
    body?: string
    orderId?: string
    rawPayload?: Record<string, unknown>
    triageStatus?: 'RESPONDED'
  }
}

export interface FeedbackPlan {
  /** Not stored yet: created through the ingest pipeline (language, English text, alerts). */
  create: ParsedFeedback[]
  update: FeedbackUpdate[]
  unchanged: number
}

/**
 * What to write for one report: new feedback is created; stored feedback is updated only when the report says
 * something new (stars or comment changed, a reply appeared, the order became known). A reply seen in the report marks
 * an open row as responded (Amazon allows one reply per feedback). Running the same report twice plans nothing.
 */
export function planFeedbackUpserts(input: {
  rows: readonly ParsedFeedback[]
  stored: readonly StoredFeedback[]
  /** Amazon order id → the Nexus Order id, for orders Nexus has. */
  orderIds: ReadonlyMap<string, string>
  market: string
  reportId: string | null
}): FeedbackPlan {
  const stored = new Map(input.stored.map((s) => [s.externalReviewId, s]))
  const plan: FeedbackPlan = { create: [], update: [], unchanged: 0 }
  for (const row of input.rows) {
    const s = stored.get(row.externalReviewId)
    if (!s) { plan.create.push(row); continue }
    const data: FeedbackUpdate['data'] = {}
    if (s.rating !== row.rating) data.rating = row.rating
    if (s.body !== row.comment) data.body = row.comment
    const orderId = input.orderIds.get(row.amazonOrderId)
    if (orderId && s.orderId !== orderId) data.orderId = orderId
    if ((row.response ?? null) !== storedResponse(s.rawPayload) || data.rating != null || data.body != null) {
      data.rawPayload = feedbackPayload(row, input.market, input.reportId)
    }
    if (row.response && OPEN.has(s.triageStatus)) data.triageStatus = 'RESPONDED'
    if (Object.keys(data).length) plan.update.push({ id: s.id, data })
    else plan.unchanged += 1
  }
  return plan
}

// ── Fetch state per market ───────────────────────────────────────────────────────────────────────────────────────

/** One `AmazonReportRun` row of this report. */
export interface FeedbackRunFact {
  marketplace: string | null
  status: string
  rowCount: number | null
  errorMessage: string | null
  requestedAt: Date
  completedAt: Date | null
}

export type FetchStateKind = 'never' | 'fetching' | 'ok' | 'failed'

export interface MarketFetchState {
  market: string
  state: FetchStateKind
  /** When the newest fetch started (ISO). */
  lastFetchAt: string | null
  /** When a fetch last worked (ISO). */
  lastOkAt: string | null
  /** Feedback lines in the newest report that worked (Amazon's 1–3 star feedback of the last 90 days). */
  rows: number | null
  /** What happened, in words (never a setting name or an Amazon code). */
  words: string
}

/** A report run's market as a code ("APJ6JRA9NG5V4" → "IT"). */
export function runMarket(marketplace: string | null): string | null {
  if (!marketplace) return null
  const t = marketplace.trim().toUpperCase()
  if (/^[A-Z]{2}$/.test(t)) return t === 'GB' ? 'UK' : t
  return MARKETPLACE_ID_TO_CODE[marketplace.trim()] ?? null
}

/** Amazon cancels a report it has no data for (docs above): for this report that means "no 1–3 star feedback". */
export function cancelledForNoData(message: string | null | undefined): boolean {
  return /terminal status CANCELLED/i.test(message ?? '')
}

/** Why a fetch failed, in words. */
export function fetchFailureWords(message: string | null | undefined): string {
  const m = message ?? ''
  if (/\b403\b|unauthori[sz]ed|access (to the requested resource )?is denied|forbidden|role/i.test(m)) {
    return 'Amazon refused: the Amazon connection needs the Selling Partner Insights or Amazon Fulfillment role. The account owner adds it in Seller Central, then connects Amazon again.'
  }
  if (/did not reach DONE/i.test(m)) return 'Amazon was still making the report after 5 minutes. Nexus asks again at the next fetch.'
  if (/sign-in|refresh token|needs_reauth|retired|not connected|no amazon account/i.test(m)) {
    return 'Nexus could not sign in to Amazon. Reconnect Amazon in Settings › Channels.'
  }
  if (/terminal status FATAL/i.test(m)) return 'Amazon could not make the report. Nexus asks again at the next fetch.'
  if (/column/i.test(m)) return 'Amazon’s report did not look like the feedback report, so nothing was read. Nexus asks again at the next fetch.'
  return 'The fetch failed. Nexus asks again at the next fetch.'
}

function dayTime(at: Date): string {
  const day = at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
  const time = at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC', hour12: false })
  return `${day}, ${time} UTC`
}

/** Each market's newest fetch in words, from the report runs (newest first or any order). Pure. */
export function marketFetchStates(markets: readonly string[], runs: readonly FeedbackRunFact[], now: Date): MarketFetchState[] {
  return markets.map((market) => {
    const mine = runs.filter((r) => runMarket(r.marketplace) === market).sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime())
    const worked = (r: FeedbackRunFact) => r.status === 'DONE' || cancelledForNoData(r.errorMessage)
    const lastOk = mine.find(worked) ?? null
    const latest = mine[0] ?? null
    const base = {
      market,
      lastFetchAt: latest?.requestedAt.toISOString() ?? null,
      lastOkAt: lastOk ? (lastOk.completedAt ?? lastOk.requestedAt).toISOString() : null,
      rows: lastOk ? (lastOk.status === 'DONE' ? lastOk.rowCount ?? 0 : 0) : null,
    }
    if (!latest) return { ...base, state: 'never' as const, words: 'Not fetched yet.' }
    if (latest.status === 'IN_PROGRESS' || latest.status === 'REQUESTED') {
      if (now.getTime() - latest.requestedAt.getTime() < FETCH_STALE_MS) return { ...base, state: 'fetching' as const, words: 'Asking Amazon for the report now.' }
      return { ...base, state: 'failed' as const, words: 'The last fetch stopped without finishing. Nexus asks again at the next fetch.' }
    }
    if (worked(latest)) {
      const n = latest.status === 'DONE' ? latest.rowCount ?? 0 : 0
      const when = dayTime(latest.completedAt ?? latest.requestedAt)
      return {
        ...base,
        state: 'ok' as const,
        words: n === 0
          ? `Fetched ${when}: no 1–3 star feedback in the last ${FEEDBACK_WINDOW_DAYS} days.`
          : `Fetched ${when}: ${n} feedback of 1–3 stars in the last ${FEEDBACK_WINDOW_DAYS} days.`,
      }
    }
    const since = lastOk ? ` The last good fetch was ${dayTime(new Date(base.lastOkAt!))}.` : ''
    return { ...base, state: 'failed' as const, words: `${fetchFailureWords(latest.errorMessage)}${since}` }
  })
}

/** The window one fetch asks for. */
export function feedbackWindow(now: Date): { from: Date; to: Date } {
  return { from: new Date(now.getTime() - FEEDBACK_WINDOW_DAYS * DAY_MS), to: now }
}
