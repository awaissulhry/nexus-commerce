/**
 * Amazon seller feedback (2026-10-27, Reviews area PR H, build spec B20) — Nexus asks Amazon for its seller feedback
 * report (`GET_SELLER_FEEDBACK_DATA`: only feedback of 1 to 3 stars) once a day per Amazon market in Europe the business
 * sells on, and whenever a person presses "Fetch now"; it stores each feedback as a `Review` row with `kind = 'SELLER'`.
 *
 * Amazon calls: the Reports API through the channel gateway — `createReport` → `getReport` (until DONE / FATAL /
 * CANCELLED) → `getReportDocument`, with the SP-API SDK routed through `gatewayCall` (services/gateway/amazon-sdk.ts,
 * via `fetchSpApiReport` in services/sp-api-reports.service.ts, which also records each run in `AmazonReportRun`). The
 * document itself is a pre-signed storage URL, not the API. Docs:
 *   https://developer-docs.amazon.com/sp-api/docs/request-a-report
 *   https://developer-docs.amazon.com/sp-api/docs/verify-that-report-processing-is-complete
 *   https://developer-docs.amazon.com/sp-api/docs/retrieve-a-report
 *   https://developer-docs.amazon.com/sp-api/docs/report-type-values-performance  (columns, "can only be requested")
 *
 * Off unless the deployment switches it on (`sellerFeedbackOn`); the Settings › Sources row and the Amazon page say so in
 * words, never by the switch's name. Nothing here asks Amazon to remove feedback or posts a reply: Amazon has no API
 * for either (build spec ruling 5). Rows: channel AMAZON, kind SELLER, the market, the Nexus order when Nexus has it,
 * stars 1–3, the comment, the date; a reply seen in the report ("Your Response") marks the row as responded.
 *
 * The reading, keying and upsert plan are pure in amazon-seller-feedback-report.ts.
 */
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { marketplaceCodeToId } from '../../utils/marketplace-code.js'
import { recordCronRun } from '../../utils/cron-observability.js'
import { workspaceIdForQuery } from '../../lib/workspace-context.js'
import { fetchSpApiReport, SpApiReportError } from '../sp-api-reports.service.js'
import { ingestRawReviews } from './review-ingest.service.js'
import { marketWords } from './overviewMath.js'
import { connectionProblem, settingsHref } from './review-sources.service.js'
import {
  cancelledForNoData, FeedbackReportShapeError, feedbackPayload, feedbackWindow, marketFetchStates, parseSellerFeedbackReport,
  planFeedbackUpserts, SELLER_FEEDBACK_REPORT_TYPE, SELLER_FEEDBACK_SOURCE, type MarketFetchState, type ParsedFeedback,
} from './amazon-seller-feedback-report.js'

/** The job's name in CronRun (Settings › Pipeline health reads it). */
export const SELLER_FEEDBACK_JOB = 'amazon-seller-feedback'
/** Daily, UTC. Amazon cannot schedule this report itself, so Nexus asks for it. */
export const SELLER_FEEDBACK_SCHEDULE_DEFAULT = '0 6 * * *'

/** Whether this deployment fetches Amazon seller feedback at all (read here, never shown by name). */
export function sellerFeedbackOn(env: Record<string, string | undefined> = process.env): boolean {
  return env.NEXUS_ENABLE_AMAZON_SELLER_FEEDBACK === '1'
}

export function sellerFeedbackSchedule(env: Record<string, string | undefined> = process.env): string {
  return env.NEXUS_AMAZON_SELLER_FEEDBACK_SCHEDULE ?? SELLER_FEEDBACK_SCHEDULE_DEFAULT
}

/** Amazon's markets in Europe — the ones the feedback report is read for. */
const EU_MARKETS: ReadonlySet<string> = new Set(['IT', 'DE', 'FR', 'ES', 'UK', 'NL', 'BE', 'SE', 'PL', 'IE'])

export interface FeedbackMarket {
  code: string
  marketplaceId: string
}

/** The business's active Amazon markets in Europe, with Amazon's marketplace id. */
export async function sellerFeedbackMarkets(): Promise<FeedbackMarket[]> {
  const rows = await prisma.marketplace.findMany({ where: { channel: 'AMAZON', isActive: true }, select: { code: true, marketplaceId: true } })
  const out = new Map<string, FeedbackMarket>()
  for (const r of rows) {
    const code = r.code.trim().toUpperCase() === 'GB' ? 'UK' : r.code.trim().toUpperCase()
    if (!EU_MARKETS.has(code)) continue
    const marketplaceId = r.marketplaceId?.trim() || marketplaceCodeToId(code)
    if (marketplaceId) out.set(code, { code, marketplaceId })
  }
  return [...out.values()].sort((a, b) => a.code.localeCompare(b.code))
}

// ── Writing one report ───────────────────────────────────────────────────────────────────────────────────────────

export interface MarketFetchResult {
  market: string
  ok: boolean
  /** Feedback lines Amazon's report held. */
  reportRows: number
  created: number
  updated: number
  skipped: number
  error: string | null
}

/**
 * Store one market's feedback: new rows through the ingest pipeline (language, English text, live update, the "New
 * negative review" alert), changed rows updated in place, a reply in the report marks an open row as responded.
 */
export async function upsertSellerFeedback(rows: readonly ParsedFeedback[], market: string, reportId: string | null, now: Date = new Date()): Promise<{ created: number; updated: number; unchanged: number }> {
  if (rows.length === 0) return { created: 0, updated: 0, unchanged: 0 }
  const externalIds = rows.map((r) => r.externalReviewId)
  const amazonOrderIds = [...new Set(rows.map((r) => r.amazonOrderId))]
  const [orders, stored] = await Promise.all([
    prisma.order.findMany({ where: { channel: 'AMAZON', channelOrderId: { in: amazonOrderIds } }, select: { id: true, channelOrderId: true } }),
    prisma.review.findMany({
      where: { channel: 'AMAZON', externalReviewId: { in: externalIds } },
      select: { id: true, externalReviewId: true, rating: true, body: true, orderId: true, triageStatus: true, rawPayload: true },
    }),
  ])
  const orderIds = new Map(orders.map((o) => [o.channelOrderId, o.id]))
  const plan = planFeedbackUpserts({ rows, stored, orderIds, market, reportId })

  if (plan.create.length) {
    const raws: Parameters<typeof ingestRawReviews>[0] = plan.create.map((r) => ({
      externalReviewId: r.externalReviewId,
      channel: 'AMAZON',
      marketplace: market,
      rating: r.rating,
      body: r.comment,
      postedAt: r.postedAt.toISOString(),
      rawPayload: feedbackPayload(r, market, reportId),
      orderId: orderIds.get(r.amazonOrderId),
      kind: 'SELLER',
    }))
    const summary = await ingestRawReviews(raws, { ingestSource: SELLER_FEEDBACK_SOURCE })
    if (summary.errors.length) logger.warn('[amazon-seller-feedback] some rows were not stored', { market, errors: summary.errors.slice(0, 5) })
    // Feedback that already has the seller's reply arrives as responded (one reply per feedback on Amazon).
    const replied = plan.create.filter((r) => r.response).map((r) => r.externalReviewId)
    if (replied.length) {
      await prisma.review.updateMany({
        where: { channel: 'AMAZON', externalReviewId: { in: replied }, triageStatus: null },
        data: { triageStatus: 'RESPONDED', triageUpdatedAt: now },
      })
    }
  }
  for (const u of plan.update) {
    await prisma.review.update({
      where: { id: u.id },
      data: {
        ...u.data,
        ...(u.data.rawPayload ? { rawPayload: u.data.rawPayload as object } : {}),
        ...(u.data.triageStatus ? { triageUpdatedAt: now } : {}),
        kind: 'SELLER',
      },
    })
  }
  return { created: plan.create.length, updated: plan.update.length, unchanged: plan.unchanged }
}

/** Ask Amazon for one market's report, read it and store it. Never throws: a failure is the result's words. */
export async function fetchSellerFeedbackForMarket(m: FeedbackMarket, now: Date = new Date()): Promise<MarketFetchResult> {
  const out: MarketFetchResult = { market: m.code, ok: false, reportRows: 0, created: 0, updated: 0, skipped: 0, error: null }
  const window = feedbackWindow(now)
  let text = ''
  let reportId: string | null = null
  try {
    const report = await fetchSpApiReport<unknown>({
      reportType: SELLER_FEEDBACK_REPORT_TYPE,
      marketplaceId: m.marketplaceId,
      dataStartTime: window.from,
      dataEndTime: window.to,
    })
    reportId = report.reportId
    text = typeof report.payload === 'string' ? report.payload : ''
  } catch (err) {
    // Amazon cancels a report it has no data for: no 1–3 star feedback in the window.
    if (err instanceof SpApiReportError && !err.abandoned && cancelledForNoData(err.message)) return { ...out, ok: true }
    out.error = err instanceof Error ? err.message : String(err)
    logger.warn('[amazon-seller-feedback] fetch failed', { market: m.code, error: out.error })
    return out
  }
  try {
    const parsed = parseSellerFeedbackReport(text, m.code)
    const written = await upsertSellerFeedback(parsed.rows, m.code, reportId, now)
    return { ...out, ok: true, reportRows: parsed.rows.length + parsed.skipped.length, created: written.created, updated: written.updated, skipped: parsed.skipped.length }
  } catch (err) {
    out.error = err instanceof FeedbackReportShapeError ? err.message : err instanceof Error ? err.message : String(err)
    logger.warn('[amazon-seller-feedback] reading the report failed', { market: m.code, error: out.error })
    return out
  }
}

// ── Running a fetch ──────────────────────────────────────────────────────────────────────────────────────────────

/** Businesses whose fetch runs in this process now (a second press waits for the first). */
const running = new Set<string>()

export interface FetchRunSummary {
  markets: MarketFetchResult[]
  summary: string
}

/** Every market, one after another (Amazon's createReport allows about one a minute per account). */
export async function runSellerFeedbackFetch(opts: { trigger: 'cron' | 'manual'; now?: Date } = { trigger: 'cron' }): Promise<FetchRunSummary> {
  if (!sellerFeedbackOn()) return { markets: [], summary: 'off in this setup' }
  const key = workspaceIdForQuery()
  if (running.has(key)) return { markets: [], summary: 'already fetching' }
  running.add(key)
  try {
    const run = await recordCronRun(SELLER_FEEDBACK_JOB, async () => {
      const markets = await sellerFeedbackMarkets()
      const results: MarketFetchResult[] = []
      for (const m of markets) results.push(await fetchSellerFeedbackForMarket(m, opts.now ?? new Date()))
      const failed = results.filter((r) => !r.ok).length
      const summary = `markets=${results.length} failed=${failed} · ${results.map((r) => `${r.market}:${r.ok ? `+${r.created}/~${r.updated}` : 'failed'}`).join(' ')}`
      const cronStatus = results.length === 0 ? 'NOT_CONFIGURED' as const : failed > 0 ? 'PARTIAL' as const : 'SUCCESS' as const
      return { markets: results, summary, cronStatus }
    }, { triggeredBy: opts.trigger })
    return { markets: run.markets, summary: run.summary }
  } finally {
    running.delete(key)
  }
}

// ── State and "Fetch now" ────────────────────────────────────────────────────────────────────────────────────────

export interface SellerFeedbackState {
  /** This deployment fetches Amazon seller feedback. */
  on: boolean
  /** "Daily 06:00 UTC". */
  every: string
  markets: MarketFetchState[]
  /** Whether "Fetch now" may be pressed (manage permission aside); `held` says why not. */
  canFetch: boolean
  held: string | null
  /** Where a person fixes what holds it (Settings › Channels › Amazon), or null. */
  fixHref: string | null
  fetching: boolean
  lastFetchAt: string | null
  lastOkAt: string | null
}

const OFF_WORDS = 'Nexus does not fetch Amazon seller feedback in this setup yet.'

function everyWords(expr: string): string {
  const p = expr.trim().split(/\s+/)
  if (p.length === 5 && /^\d+$/.test(p[0]) && /^\d+$/.test(p[1]) && p[2] === '*' && p[3] === '*' && p[4] === '*') {
    return `Daily ${p[1].padStart(2, '0')}:${p[0].padStart(2, '0')} UTC`
  }
  return 'On a schedule'
}

const newestIso = (values: Array<string | null>) => values.filter((v): v is string => !!v).sort().at(-1) ?? null

/** Each market's fetch state and whether "Fetch now" may run. */
export async function readSellerFeedbackState(now: Date = new Date()): Promise<SellerFeedbackState> {
  const on = sellerFeedbackOn()
  const [markets, runs, connections] = await Promise.all([
    sellerFeedbackMarkets(),
    prisma.amazonReportRun.findMany({
      where: { reportType: SELLER_FEEDBACK_REPORT_TYPE },
      orderBy: { requestedAt: 'desc' },
      take: 200,
      select: { marketplace: true, status: true, rowCount: true, errorMessage: true, requestedAt: true, completedAt: true },
    }),
    prisma.channelConnection.findMany({ where: { channelType: 'AMAZON' }, select: { isActive: true, authStatus: true, isPrimary: true } }),
  ])
  const states = marketFetchStates(markets.map((m) => m.code), runs, now)
  const fetching = states.some((s) => s.state === 'fetching')
  const active = connections.filter((c) => c.isActive)
  const signIn = connectionProblem(active.find((c) => c.isPrimary) ?? active[0] ?? connections[0], 'Amazon')
  let held: string | null = null
  let fixHref: string | null = null
  if (!on) held = OFF_WORDS
  else if (signIn) { held = `${signIn}. Nexus cannot ask Amazon for the report until someone connects Amazon again.`; fixHref = settingsHref('AMAZON') }
  else if (markets.length === 0) held = 'This business sells on no Amazon market in Europe, so there is no feedback report to fetch.'
  else if (fetching) held = 'Nexus is asking Amazon for the report now. It shows here in a few minutes.'
  return {
    on,
    every: everyWords(sellerFeedbackSchedule()),
    markets: states,
    canFetch: held == null,
    held,
    fixHref,
    fetching,
    lastFetchAt: newestIso(states.map((s) => s.lastFetchAt)),
    lastOkAt: newestIso(states.map((s) => s.lastOkAt)),
  }
}

export type FetchNowAnswer =
  | { ok: true; words: string; state: SellerFeedbackState }
  | { ok: false; held: string; state: SellerFeedbackState }

/**
 * POST /api/reviews/amazon/seller-feedback/fetch — start a fetch now, in the background (each market's report takes
 * Amazon up to a few minutes), and answer at once. Held, with its reason, when the switch is off, Amazon is not
 * connected, the business sells on no Amazon market in Europe, or a fetch is already running.
 */
export async function requestSellerFeedbackFetch(now: Date = new Date()): Promise<FetchNowAnswer> {
  const state = await readSellerFeedbackState(now)
  if (!state.canFetch || running.has(workspaceIdForQuery())) {
    return { ok: false, held: state.held ?? 'Nexus is asking Amazon for the report now. It shows here in a few minutes.', state }
  }
  // The request's business context carries into the background work (async context), so every write stays in it.
  void runSellerFeedbackFetch({ trigger: 'manual' }).catch((err) => {
    logger.warn('[amazon-seller-feedback] fetch now failed', { error: err instanceof Error ? err.message : String(err) })
  })
  const where = state.markets.map((m) => marketWords(m.market) ?? m.market).join(', ')
  return {
    ok: true,
    words: `Nexus asked Amazon for the seller feedback report (${where}). Amazon takes a few minutes to make it; the feedback shows here when it arrives.`,
    state: { ...state, canFetch: false, fetching: true, held: 'Nexus is asking Amazon for the report now. It shows here in a few minutes.' },
  }
}
