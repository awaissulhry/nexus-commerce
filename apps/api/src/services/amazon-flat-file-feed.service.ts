/**
 * Flat-file feed reconcile + processing-report parsing (FFS.2).
 *
 * Shared by the GET /feeds/:id endpoint and the FFS.3 poll cron. Reconcile calls
 * getFeed, and on a terminal status downloads + parses the processing report,
 * updating the durable AmazonFlatFileFeedJob row.
 *
 * The parser handles the REAL JSON_LISTINGS_FEED report shape ({issues[], summary})
 * — the previous inline parser assumed the legacy {processingReport.rows} format,
 * which silently yielded an empty per-SKU breakdown for JSON feeds. Tri-state
 * per-SKU (success / warning / error) with Amazon issue codes; legacy-JSON and
 * tab-delimited fallbacks kept for safety.
 */

import prisma from '../db.js'
import { getAmazonSpClient } from '../lib/amazon-sp-client.js'
import { logger } from '../utils/logger.js'
import { publishOrderEvent } from './order-events.service.js'

export type SkuStatus = 'success' | 'warning' | 'error'
export interface PerSkuResult { sku: string; status: SkuStatus; code?: string; message?: string }
export interface FeedReportSummary {
  messagesProcessed: number
  messagesSuccessful: number
  messagesWithWarning: number
  messagesWithError: number
}
export interface ParsedReport { summary: FeedReportSummary; perSku: PerSkuResult[]; feedError?: string; pending?: boolean }

const TERMINAL = new Set(['DONE', 'FATAL', 'CANCELLED'])

// Amazon can return a terminal status (DONE) before the processing report is
// written. We re-poll (as IN_PROGRESS) until the report lands, up to this many
// total polls, then finalize with a "report unavailable" note — rather than EVER
// caching a false all-success (the bug that hid a fully-rejected DE feed).
const MAX_REPORT_RETRIES = 20

function zeroSummary(): FeedReportSummary {
  return { messagesProcessed: 0, messagesSuccessful: 0, messagesWithWarning: 0, messagesWithError: 0 }
}

function sevToStatus(sev: unknown): SkuStatus {
  const s = String(sev ?? '').toUpperCase()
  if (s === 'ERROR') return 'error'
  if (s === 'WARNING') return 'warning'
  return 'success' // INFORMATIONAL / INFO / unknown
}
const worse = (a: SkuStatus, b: SkuStatus): SkuStatus => {
  const rank: Record<SkuStatus, number> = { success: 0, warning: 1, error: 2 }
  return rank[a] >= rank[b] ? a : b
}

/**
 * Parse an Amazon feed processing report. `submittedSkus` lets us mark
 * issue-free SKUs as success (the report only lists SKUs that had issues).
 */
export function parseProcessingReport(reportText: string, submittedSkus?: string[]): ParsedReport {
  const skus = (submittedSkus ?? []).filter(Boolean)
  const trimmed = (reportText ?? '').trim()
  // An empty report body = Amazon returned a terminal status before the report was
  // written. This is NOT success — signal pending so the caller re-polls instead
  // of caching a false all-accepted result.
  if (!trimmed) return { summary: zeroSummary(), perSku: [], pending: true }

  let obj: any = null
  try { obj = JSON.parse(trimmed) } catch { /* not JSON → TSV fallback below */ }

  // ── Format 1: JSON_LISTINGS_FEED — { issues:[{sku,code,severity,message}], summary:{...} }
  if (obj && Array.isArray(obj.issues)) {
    // A real report — even an all-accepted one — always carries a summary with a
    // processed count. issues:[] AND no summary = the report isn't finalized yet.
    if (obj.issues.length === 0 && !Number.isFinite(Number(obj.summary?.messagesProcessed))) {
      return { summary: zeroSummary(), perSku: [], pending: true }
    }
    const bySku = new Map<string, PerSkuResult>()
    let feedError: string | undefined
    for (const iss of obj.issues) {
      const status = sevToStatus(iss?.severity)
      const sku = typeof iss?.sku === 'string' ? iss.sku : ''
      if (!sku) {
        // feed-level issue (no SKU) — surface the first error as the feed error
        if (status === 'error' && !feedError) feedError = String(iss?.message ?? iss?.code ?? 'Feed-level error')
        continue
      }
      const prev = bySku.get(sku)
      const message = String(iss?.message ?? '')
      if (prev) {
        prev.status = worse(prev.status, status)
        if (message) prev.message = prev.message ? `${prev.message}; ${message}` : message
        if (!prev.code && iss?.code) prev.code = String(iss.code)
      } else {
        bySku.set(sku, { sku, status, code: iss?.code != null ? String(iss.code) : undefined, message: message || undefined })
      }
    }
    // issue-free submitted SKUs = success
    for (const s of skus) if (!bySku.has(s)) bySku.set(s, { sku: s, status: 'success' })

    const perSku = [...bySku.values()]
    const sum = obj.summary ?? {}
    const errCount = perSku.filter((p) => p.status === 'error').length
    const warnCount = perSku.filter((p) => p.status === 'warning').length
    const processed = Number(sum.messagesProcessed) || perSku.length || skus.length
    const invalid = Number(sum.messagesInvalid)
    const accepted = Number(sum.messagesAccepted)
    return {
      summary: {
        messagesProcessed: processed,
        messagesSuccessful: Number.isFinite(accepted) ? accepted : Math.max(0, processed - (Number.isFinite(invalid) ? invalid : errCount)),
        messagesWithWarning: Number.isFinite(Number(sum.warnings)) ? Number(sum.warnings) : warnCount,
        messagesWithError: Number.isFinite(invalid) ? invalid : (Number.isFinite(Number(sum.errors)) ? Number(sum.errors) : errCount),
      },
      perSku,
      feedError,
    }
  }

  // ── Format 2: legacy JSON — { processingReport: { rows:[{sku,processingStatus,issues[]}] } }
  const rows: any[] = obj?.processingReport?.rows ?? obj?.rows ?? []
  if (Array.isArray(rows) && rows.length) {
    const perSku: PerSkuResult[] = rows.map((r: any) => {
      const issues: any[] = Array.isArray(r?.issues) ? r.issues : []
      const hasErr = r?.processingStatus && r.processingStatus !== 'DONE'
      const sev = issues.some((i) => sevToStatus(i?.severity) === 'error') || hasErr ? 'error'
        : issues.some((i) => sevToStatus(i?.severity) === 'warning') ? 'warning' : 'success'
      return {
        sku: r?.sku ?? r?.messageId ?? '',
        status: sev as SkuStatus,
        code: issues[0]?.code != null ? String(issues[0].code) : undefined,
        message: issues.map((i: any) => i?.message).filter(Boolean).join('; ') || undefined,
      }
    })
    return summarize(perSku)
  }

  // ── Format 3: tab-delimited legacy POST_FLAT_FILE report (best-effort)
  if (reportText && reportText.includes('\t')) {
    const lines = reportText.split(/\r?\n/).filter(Boolean)
    // header row often contains "sku" + "error-code"/"error-message"
    const header = (lines[0] ?? '').toLowerCase().split('\t')
    const iSku = header.findIndex((h) => h.includes('sku'))
    const iCode = header.findIndex((h) => h.includes('error-code') || h.includes('code'))
    const iMsg = header.findIndex((h) => h.includes('error-message') || h.includes('message'))
    if (iSku >= 0 && lines.length > 1) {
      const perSku: PerSkuResult[] = lines.slice(1).map((ln) => {
        const c = ln.split('\t')
        const code = iCode >= 0 ? c[iCode] : ''
        const message = iMsg >= 0 ? c[iMsg] : ''
        return { sku: c[iSku] ?? '', status: (code || message ? 'error' : 'success') as SkuStatus, code: code || undefined, message: message || undefined }
      })
      return summarize(perSku)
    }
  }

  // Nothing parseable from a non-empty body — ambiguous. Do NOT assume success;
  // that false-positive is exactly what masked a fully-rejected feed. Signal
  // pending so the caller re-polls for a real report.
  return { summary: zeroSummary(), perSku: [], pending: true }
}

function summarize(perSku: PerSkuResult[]): ParsedReport {
  return {
    summary: {
      messagesProcessed: perSku.length,
      messagesSuccessful: perSku.filter((p) => p.status === 'success').length,
      messagesWithWarning: perSku.filter((p) => p.status === 'warning').length,
      messagesWithError: perSku.filter((p) => p.status === 'error').length,
    },
    perSku,
  }
}

/** Poll backoff: feeds usually finish in a few minutes → poll briskly early, ease off. */
export function backoffMs(pollCount: number): number {
  return Math.min(300_000, 25_000 + pollCount * 15_000) // 25s → … → cap 5min
}

/**
 * Download the processing report with a hard timeout. Amazon's report-document
 * URLs expire/stall, and an unbounded fetch here could hang the whole reconcile
 * (manual poll or cron) until the gateway 502'd. AbortController guarantees a
 * bounded wall-clock cost regardless of Amazon's CDN.
 */
async function fetchReportText(url: string, timeoutMs: number): Promise<string> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: ctrl.signal })
    return await res.text()
  } finally {
    clearTimeout(timer)
  }
}

export interface ReconcileResult {
  feedId: string
  processingStatus: string
  resultFeedDocumentId: string | null
  results: PerSkuResult[]
  summary: FeedReportSummary | null
  errorMessage: string | null
  terminal: boolean
  changed: boolean
}

/**
 * Poll Amazon for a feed, parse its report on terminal status, and update the
 * durable job row. Safe to call for a feedId with no DB job (older feeds) — it
 * still returns live status, just doesn't persist.
 */
export async function reconcileFeedJob(feedId: string, opts?: { force?: boolean }): Promise<ReconcileResult> {
  const job = await prisma.amazonFlatFileFeedJob.findUnique({ where: { feedId } }).catch(() => null)

  // FFS.9 — fast path: a feed that already reached a terminal state never changes
  // again (a re-submit gets a brand-new feedId). Return the persisted result
  // without touching SP-API. This makes GET /feeds/:id instant for finished feeds
  // and — critically — stops re-downloading the processing report on every call:
  // Amazon's report-document URLs expire/stall, and the report fetch could hang
  // until the gateway 502'd (observed on a DONE feed). The cron already skips
  // terminal jobs (nextPollAt=null), so this only changes the manual-poll path.
  // `force` bypasses it to re-fetch the now-final report (re-validate / repair a
  // job that finalized against a premature empty report).
  if (!opts?.force && job && job.completedAt && TERMINAL.has(job.status)) {
    return {
      feedId,
      processingStatus: job.status,
      resultFeedDocumentId: null,
      results: (Array.isArray(job.perSkuResults) ? job.perSkuResults : []) as unknown as PerSkuResult[],
      summary: (job.resultSummary as unknown as FeedReportSummary) ?? null,
      errorMessage: job.errorMessage ?? null,
      terminal: true,
      changed: false,
    }
  }

  const sp = await getAmazonSpClient()
  const feedRes: any = await sp.callAPI({ operation: 'getFeed', endpoint: 'feeds', path: { feedId } })
  const status: string = feedRes.processingStatus
  const resultDocId: string | null = feedRes.resultFeedDocumentId ?? null
  const terminal = TERMINAL.has(status)

  let perSku: PerSkuResult[] = []
  let summary: FeedReportSummary | null = null
  let errorMessage: string | null = null
  // A terminal status whose report we can't yet read (empty / not-finalized /
  // fetch failed). Must NOT be treated as success — re-poll until it lands.
  let reportPending = false

  if (terminal && resultDocId) {
    try {
      const docRes: any = await sp.callAPI({ operation: 'getFeedDocument', endpoint: 'feeds', path: { feedDocumentId: resultDocId } })
      const reportText = await fetchReportText(docRes.url, 20_000)
      const parsed = parseProcessingReport(reportText, (job?.skus as string[] | undefined) ?? undefined)
      if (parsed.pending) {
        reportPending = true
      } else {
        perSku = parsed.perSku
        summary = parsed.summary
        if (parsed.feedError) errorMessage = parsed.feedError
      }
    } catch (e: any) {
      logger.warn('[flat-file-feed] report fetch/parse failed — will retry', { feedId, error: e?.message })
      reportPending = true
    }
    if (status === 'FATAL' && !errorMessage) errorMessage = 'Feed processing failed (FATAL)'
  } else if (status === 'FATAL') {
    errorMessage = 'Feed processing failed (FATAL)'
  } else if (terminal && status === 'DONE' && !resultDocId) {
    // DONE but no report document yet — premature; re-poll.
    reportPending = true
  }

  const pollCount = (job?.pollCount ?? 0) + 1
  // If the Amazon status is DONE but the report isn't ready, keep the job "live"
  // (status IN_PROGRESS, no completedAt, nextPollAt set) so the cron + UI keep
  // polling — UNLESS retries are exhausted, in which case finalize with a clear
  // note rather than a fake success. FATAL/CANCELLED have no report and are final.
  const retriesExhausted = reportPending && pollCount > MAX_REPORT_RETRIES
  const reportBlocks = reportPending && status === 'DONE' && !retriesExhausted
  const effectiveStatus = reportBlocks ? 'IN_PROGRESS' : status
  const effectiveTerminal = TERMINAL.has(effectiveStatus)
  if (retriesExhausted && status === 'DONE' && !errorMessage) {
    errorMessage = 'Amazon marked the feed complete but its processing report was unavailable after repeated attempts — verify the result in Seller Central.'
  }

  const prevStatus = job?.status
  // Fire on a status change OR a corrected result summary (so a force re-validate
  // that flips a false 19-ok → 19-error still pushes the fix to open tabs).
  const changed = !job || prevStatus !== effectiveStatus ||
    (!!summary && JSON.stringify(job?.resultSummary ?? null) !== JSON.stringify(summary))

  if (job) {
    await prisma.amazonFlatFileFeedJob.update({
      where: { id: job.id },
      data: {
        status: effectiveStatus,
        resultSummary: summary ? (summary as any) : (job.resultSummary ?? undefined),
        perSkuResults: perSku.length ? (perSku as any) : (job.perSkuResults ?? undefined),
        errorMessage: errorMessage ?? job.errorMessage,
        lastPolledAt: new Date(),
        pollCount,
        completedAt: effectiveTerminal ? (job.completedAt ?? new Date()) : null,
        nextPollAt: effectiveTerminal ? null : new Date(Date.now() + backoffMs(pollCount)),
      },
    }).catch((e) => logger.warn('[flat-file-feed] job update failed', { feedId, error: e?.message }))
  }

  // FFS.4 — push a live status change to any open flat-file tab (cron + manual
  // poll both flow through here, so both drive the live UI).
  if (changed) {
    try {
      publishOrderEvent({
        type: 'flat_file_feed.status_changed',
        feedId,
        processingStatus: effectiveStatus,
        marketplace: job?.marketplace ?? null,
        productType: job?.productType ?? null,
        messagesWithError: summary?.messagesWithError ?? null,
        terminal: effectiveTerminal,
        ts: Date.now(),
      })
    } catch (e: any) {
      logger.warn('[flat-file-feed] SSE emit failed', { feedId, error: e?.message })
    }
  }

  return { feedId, processingStatus: effectiveStatus, resultFeedDocumentId: resultDocId, results: perSku, summary, errorMessage, terminal: effectiveTerminal, changed }
}
