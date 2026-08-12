/**
 * F.3.1 — Generic SP-API report puller.
 *
 * Wraps Amazon's three-step report flow (createReport → poll getReport →
 * getReportDocument) into a single async call that takes a reportType +
 * marketplaceId + date window and returns the parsed payload. JSON reports
 * (sales/traffic) come back as objects; flat-file reports stay as strings
 * for the caller to parse with csv-parse or similar.
 *
 * Reuses the existing amazon-sp-api credential setup. Same env vars as
 * AmazonService.getClient(): AMAZON_LWA_CLIENT_ID, AMAZON_LWA_CLIENT_SECRET,
 * AMAZON_REFRESH_TOKEN, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY,
 * AWS_ROLE_ARN.
 *
 * NOT END-TO-END TESTED — needs real SP-API credentials. Without them the
 * createReport call returns 401 and the function throws with the exact
 * SP-API error message so the caller can surface it cleanly.
 */

import { SellingPartner } from 'amazon-sp-api'
import { logger } from '../utils/logger.js'
import { instrumentSellingPartner } from './outbound-api-call-log.service.js'
import {
  startReportRun,
  completeReportRun,
  failReportRun,
} from './amazon-report-registry.service.js'

const POLL_INTERVAL_MS = 10_000 // 10 s between status checks
const MAX_POLL_ATTEMPTS = 30 // ~5 min total

export interface FetchReportArgs {
  /** SP-API report type identifier, e.g. 'GET_SALES_AND_TRAFFIC_REPORT' or
   *  'GET_MERCHANT_LISTINGS_ALL_DATA'. */
  reportType: string
  /** SP-API marketplace ID (APJ6JRA9NG5V4 for IT, A1PA6795UKMFR9 for DE, …).
   *  The Marketplace lookup table maps codes → IDs; pass the resolved value
   *  here, not the country code. */
  marketplaceId: string
  /** Inclusive start of the data window (UTC). */
  dataStartTime: Date
  /** Inclusive end of the data window (UTC). */
  dataEndTime: Date
  /** Optional report-specific options forwarded to createReport.body. */
  reportOptions?: Record<string, unknown>
}

export interface FetchReportResult<T = unknown> {
  reportId: string
  reportDocumentId: string
  /** Parsed payload. JSON reports → object; flat-file reports → string. */
  payload: T
  /** SP-API region used (e.g. 'eu', 'na', 'fe'). */
  region: string
  durationMs: number
}

let cachedClient: SellingPartner | null = null

function getClient(): SellingPartner {
  if (cachedClient) return cachedClient

  const clientId = process.env.AMAZON_LWA_CLIENT_ID
  const clientSecret = process.env.AMAZON_LWA_CLIENT_SECRET
  const refreshToken = process.env.AMAZON_REFRESH_TOKEN
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY
  const roleArn = process.env.AWS_ROLE_ARN

  if (
    !clientId ||
    !clientSecret ||
    !refreshToken ||
    !accessKeyId ||
    !secretAccessKey ||
    !roleArn
  ) {
    throw new Error(
      'sp-api-reports: missing one or more required env vars ' +
        '(AMAZON_LWA_CLIENT_ID, AMAZON_LWA_CLIENT_SECRET, AMAZON_REFRESH_TOKEN, ' +
        'AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_ROLE_ARN). ' +
        'See AMAZON_API_AUTHORIZATION.md.',
    )
  }

  // Region selection: env override or default to 'eu' (Xavia primary).
  // For multi-region sellers (NA + EU + FE), use a different cached client
  // per region — out of v0 scope, single-region cache is fine for now.
  const region = (process.env.AMAZON_REGION ?? 'eu') as 'eu' | 'na' | 'fe'

  cachedClient = new SellingPartner({
    region,
    refresh_token: refreshToken,
    credentials: {
      SELLING_PARTNER_APP_CLIENT_ID: clientId,
      SELLING_PARTNER_APP_CLIENT_SECRET: clientSecret,
    },
    options: {
      auto_request_tokens: true,
      auto_request_throttled: true,
    },
  } as any)

  // L.3.2 — every callAPI now writes an OutboundApiCallLog row.
  instrumentSellingPartner(cachedClient as never, {
    channel: 'AMAZON',
    triggeredBy: 'cron',
  })

  return cachedClient
}

/**
 * RPT.9 — how many rows a report actually returned.
 *
 * `AmazonReportRun.rowCount` was NEVER populated: 4,775 runs, zero with a
 * count, including 1,718 successful Brand Analytics pulls. The column and the
 * setter both existed — the single call site simply never passed the value — so
 * "succeeded with 0 rows" and "succeeded with 9,000 rows" were indistinguishable,
 * and a feed that quietly went empty looked identical to a healthy one.
 *
 * Returns NULL, never 0, when the shape is unrecognised. A guessed zero would
 * recreate exactly the ambiguity this is meant to remove.
 */
export function deriveRowCount(payload: unknown): number | null {
  if (payload == null) return null
  // Flat-file reports arrive as TSV text with a header line.
  if (typeof payload === 'string') {
    const trimmed = payload.trim()
    if (!trimmed) return 0
    const lines = trimmed.split(/\r?\n/)
    return Math.max(0, lines.length - 1)
  }
  if (Array.isArray(payload)) return payload.length
  if (typeof payload === 'object') {
    // JSON reports nest their rows under one array property (salesAndTrafficByDate,
    // dataByAsin, …). Take the longest array rather than guessing a key name.
    const arrays = Object.values(payload as Record<string, unknown>).filter(Array.isArray) as unknown[][]
    if (arrays.length) return Math.max(...arrays.map((a) => a.length))
  }
  return null
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * SQP.1 — an error that still knows which report it was about.
 *
 * Both failures below happen AFTER createReport succeeded, so Amazon is holding a real report we
 * have simply stopped waiting for — and in the abandoned case it goes on to finish (104 of 104 on
 * record did). The id was previously lost at the throw and survived only in the message text, which
 * is no basis for collecting anything. See docs/2026-08-12-sqp-feed.md §6.3.
 */
export class SpApiReportError extends Error {
  constructor(
    message: string,
    readonly reportId: string,
    /** true = abandoned at OUR poll ceiling (still generating); false = Amazon ended it. */
    readonly abandoned: boolean,
  ) {
    super(message)
    this.name = 'SpApiReportError'
  }
}

/**
 * Fetch an SP-API report end-to-end. Polls until DONE / CANCELLED / FATAL,
 * downloads the document, returns the parsed payload. Throws on auth
 * failure, polling timeout, or report fatal status — caller wraps in
 * try/catch.
 *
 * Polling cadence: 10 s × 30 attempts = ~5 min ceiling. Sales & Traffic
 * reports for a single day typically complete in 30-90 s.
 */
export async function fetchSpApiReport<T = unknown>(
  args: FetchReportArgs,
): Promise<FetchReportResult<T>> {
  // R0.2 — register this pull in the AmazonReportRun freshness registry.
  // Best-effort: registry bookkeeping must NEVER break a real report pull,
  // so the start swallows (runId = null) and complete/fail swallow internally.
  const runId = await startReportRun({
    reportType: args.reportType,
    marketplace: args.marketplaceId,
    source: 'REPORTS_API',
    dataStartTime: args.dataStartTime,
    dataEndTime: args.dataEndTime,
    triggeredBy: 'cron',
  }).catch(() => null)
  try {
    const result = await doFetchSpApiReport<T>(args)
    if (runId)
      await completeReportRun(runId, {
        reportId: result.reportId,
        reportDocumentId: result.reportDocumentId,
        rowCount: deriveRowCount(result.payload),
        freshAsOf: args.dataEndTime ?? new Date(),
      })
    return result
  } catch (err) {
    if (runId)
      await failReportRun(runId, {
        errorMessage: err instanceof Error ? err.message : String(err),
        // SQP.1 — keep the id when there is one, so an abandoned report stays addressable.
        reportId: err instanceof SpApiReportError ? err.reportId : undefined,
      })
    throw err
  }
}

async function doFetchSpApiReport<T = unknown>(
  args: FetchReportArgs,
): Promise<FetchReportResult<T>> {
  const startedAt = Date.now()
  const sp = getClient()

  // ── Step 1: createReport ────────────────────────────────────────
  logger.info('sp-api-reports: createReport', {
    reportType: args.reportType,
    marketplaceId: args.marketplaceId,
    dataStartTime: args.dataStartTime.toISOString(),
    dataEndTime: args.dataEndTime.toISOString(),
  })
  const createRes: any = await (sp as any).callAPI({
    operation: 'createReport',
    endpoint: 'reports',
    body: {
      reportType: args.reportType,
      marketplaceIds: [args.marketplaceId],
      dataStartTime: args.dataStartTime.toISOString(),
      dataEndTime: args.dataEndTime.toISOString(),
      ...(args.reportOptions ? { reportOptions: args.reportOptions } : {}),
    },
  })
  const reportId: string | undefined = createRes?.reportId
  if (!reportId) {
    throw new Error(
      `sp-api-reports: createReport returned no reportId for ${args.reportType}`,
    )
  }

  // ── Step 2: poll getReport until terminal status ────────────────
  let reportDocumentId: string | null = null
  for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
    await sleep(POLL_INTERVAL_MS)
    const statusRes: any = await (sp as any).callAPI({
      operation: 'getReport',
      endpoint: 'reports',
      path: { reportId },
    })
    const status: string = statusRes?.processingStatus
    if (status === 'DONE') {
      reportDocumentId = statusRes?.reportDocumentId ?? null
      break
    }
    if (status === 'CANCELLED' || status === 'FATAL') {
      // FATAL reports often attach an error document explaining WHY (bad
      // reportOptions, no data for the period, brand not enrolled, …). Surface
      // it so callers don't have to guess. Best-effort — never mask the original.
      let detail = ''
      const errDocId: string | undefined = statusRes?.reportDocumentId
      if (errDocId) {
        try {
          const d: any = await (sp as any).callAPI({ operation: 'getReportDocument', endpoint: 'reports', path: { reportDocumentId: errDocId } })
          const txt: string = typeof d === 'string' ? d : await (sp as any).download(d)
          if (txt) detail = ` — ${String(txt).slice(0, 500)}`
        } catch { /* no error document available */ }
      }
      throw new SpApiReportError(
        `sp-api-reports: report ${reportId} ended with terminal status ${status}${detail}`,
        reportId,
        false,
      )
    }
    // IN_QUEUE / IN_PROGRESS → keep polling
  }
  if (!reportDocumentId) {
    throw new SpApiReportError(
      `sp-api-reports: report ${reportId} did not reach DONE within ${MAX_POLL_ATTEMPTS} polling attempts (~${(MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS) / 1000}s)`,
      reportId,
      true,
    )
  }

  // ── Step 3: getReportDocument + auto-decompress ────────────────
  const docRes: any = await (sp as any).callAPI({
    operation: 'getReportDocument',
    endpoint: 'reports',
    path: { reportDocumentId },
  })
  // The amazon-sp-api library can either return a string directly OR a
  // metadata object that needs sp.download() to fetch + decompress.
  let raw: string =
    typeof docRes === 'string'
      ? docRes
      : await (sp as any).download(docRes)

  // Try to parse as JSON first (Sales & Traffic comes back as JSON).
  // Fall back to returning the string for flat-file reports — the caller
  // parses TSV/CSV with whatever library fits.
  let payload: T
  try {
    payload = JSON.parse(raw) as T
  } catch {
    payload = raw as unknown as T
  }

  const durationMs = Date.now() - startedAt
  logger.info('sp-api-reports: report fetched', {
    reportType: args.reportType,
    reportId,
    reportDocumentId,
    durationMs,
    payloadIsObject: typeof payload === 'object',
  })

  return {
    reportId,
    reportDocumentId,
    payload,
    region: (process.env.AMAZON_REGION ?? 'eu') as string,
    durationMs,
  }
}

/**
 * Convenience wrapper for reports that return JSON. Throws if the payload
 * isn't an object (e.g. flat-file reports).
 */
export async function fetchSpApiJsonReport<T extends object>(
  args: FetchReportArgs,
): Promise<FetchReportResult<T>> {
  const result = await fetchSpApiReport<T>(args)
  if (typeof result.payload !== 'object' || result.payload == null) {
    throw new Error(
      `sp-api-reports: expected JSON payload for ${args.reportType}, got ${typeof result.payload}`,
    )
  }
  return result
}
