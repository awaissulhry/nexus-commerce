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
export interface ParsedReport { summary: FeedReportSummary; perSku: PerSkuResult[]; feedError?: string }

const TERMINAL = new Set(['DONE', 'FATAL', 'CANCELLED'])

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
  let obj: any = null
  try { obj = JSON.parse(reportText) } catch { /* not JSON → TSV fallback below */ }

  // ── Format 1: JSON_LISTINGS_FEED — { issues:[{sku,code,severity,message}], summary:{...} }
  if (obj && Array.isArray(obj.issues)) {
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

  // Nothing parseable → mark submitted SKUs as success (feed was accepted, no report rows)
  return summarize(skus.map((s) => ({ sku: s, status: 'success' as SkuStatus })))
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
export async function reconcileFeedJob(feedId: string): Promise<ReconcileResult> {
  const sp = await getAmazonSpClient()
  const job = await prisma.amazonFlatFileFeedJob.findUnique({ where: { feedId } }).catch(() => null)

  const feedRes: any = await sp.callAPI({ operation: 'getFeed', endpoint: 'feeds', path: { feedId } })
  const status: string = feedRes.processingStatus
  const resultDocId: string | null = feedRes.resultFeedDocumentId ?? null
  const terminal = TERMINAL.has(status)

  let perSku: PerSkuResult[] = []
  let summary: FeedReportSummary | null = null
  let errorMessage: string | null = null

  if (terminal && resultDocId) {
    try {
      const docRes: any = await sp.callAPI({ operation: 'getFeedDocument', endpoint: 'feeds', path: { feedDocumentId: resultDocId } })
      const reportText = await fetch(docRes.url).then((r) => r.text())
      const parsed = parseProcessingReport(reportText, (job?.skus as string[] | undefined) ?? undefined)
      perSku = parsed.perSku
      summary = parsed.summary
      if (parsed.feedError) errorMessage = parsed.feedError
      if (status === 'FATAL' && !errorMessage) errorMessage = 'Feed processing failed (FATAL)'
    } catch (e: any) {
      logger.warn('[flat-file-feed] report parse failed', { feedId, error: e?.message })
      if (status === 'FATAL') errorMessage = 'Feed processing failed (FATAL)'
    }
  } else if (status === 'FATAL') {
    errorMessage = 'Feed processing failed (FATAL)'
  }

  const prevStatus = job?.status
  const changed = !job || prevStatus !== status

  if (job) {
    const pollCount = job.pollCount + 1
    await prisma.amazonFlatFileFeedJob.update({
      where: { id: job.id },
      data: {
        status,
        resultSummary: summary ? (summary as any) : (job.resultSummary ?? undefined),
        perSkuResults: perSku.length ? (perSku as any) : (job.perSkuResults ?? undefined),
        errorMessage: errorMessage ?? job.errorMessage,
        lastPolledAt: new Date(),
        pollCount,
        completedAt: terminal ? (job.completedAt ?? new Date()) : null,
        nextPollAt: terminal ? null : new Date(Date.now() + backoffMs(pollCount)),
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
        processingStatus: status,
        marketplace: job?.marketplace ?? null,
        productType: job?.productType ?? null,
        messagesWithError: summary?.messagesWithError ?? null,
        terminal,
        ts: Date.now(),
      })
    } catch (e: any) {
      logger.warn('[flat-file-feed] SSE emit failed', { feedId, error: e?.message })
    }
  }

  return { feedId, processingStatus: status, resultFeedDocumentId: resultDocId, results: perSku, summary, errorMessage, terminal, changed }
}
