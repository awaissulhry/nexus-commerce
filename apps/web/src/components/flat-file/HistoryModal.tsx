'use client'

/**
 * HistoryModal — H.1–H.4
 *
 * Unified DS Modal replacing three separate panels:
 *   • FeedSubmissionsPanel (Amazon push history)
 *   • EbayPushHistoryPanel (eBay push history)
 *   • PullHistoryDrawer (pull history — both channels)
 *   • VersionHistoryPanel (Amazon only — localStorage snapshots)
 *
 * Single entry point; channel-aware tabs.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ChevronDown, ChevronRight, Clock, Copy, Download,
  History, Loader2, RefreshCw, Repeat, Search,
} from 'lucide-react'

import { Modal } from '@/design-system/components/Modal'
import { Tabs } from '@/design-system/components/Tabs'
import { Banner } from '@/design-system/components/Banner'
import { EmptyState } from '@/design-system/components/EmptyState'
import { Skeleton } from '@/design-system/primitives/Skeleton'
import { Pill } from '@/design-system/primitives/Pill'

import { cn } from '@/lib/utils'
import { getBackendUrl } from '@/lib/backend-url'
import { useOrderEventsRefresh } from '@/hooks/use-order-events-refresh'
import {
  GROUP_BADGE_CLASS,
  GROUP_LABEL,
  type PullGroupId,
} from '@/app/products/_shared/pull-field-groups'
import type { PullHistoryRecord } from '@/app/products/_shared/PullHistoryDrawer'

// ── Amazon types ───────────────────────────────────────────────────────────

type AmazonSkuStatus = 'success' | 'warning' | 'error'
type IssueSeverity = 'error' | 'warning' | 'info'
interface FeedIssueColumn { id: string; label: string }
interface FeedIssue {
  code: string; severity: IssueSeverity; category?: string
  message: string; attributeNames: string[]; details?: string
  columns?: FeedIssueColumn[]
}
interface AmazonPerSku { sku: string; status: AmazonSkuStatus; code?: string; message?: string; issues?: FeedIssue[] }
interface FlatIssue extends FeedIssue { sku: string }

const issueSevCls: Record<IssueSeverity, string> = {
  error: 'text-red-600 dark:text-red-400',
  warning: 'text-amber-600 dark:text-amber-400',
  info: 'text-slate-500 dark:text-slate-400',
}
/** Friendly title for common opaque Amazon codes; falls back to category → code. */
const CODE_TITLE: Record<string, string> = {
  '20017': 'Image blocked by its hosting site',
  '90220': 'Missing required attribute',
  '8541': 'Invalid or missing value',
  '5000': 'Image quality',
}
const issueTitle = (i: { code: string; category?: string }) =>
  CODE_TITLE[i.code] ?? (i.category ? i.category.replace(/_/g, ' ').toLowerCase() : `code ${i.code || '—'}`)
const issueCols = (i: FeedIssue) => (i.columns?.length ? i.columns.map((c) => c.label).join(', ') : i.attributeNames.join(', '))
interface AmazonFeedJob {
  id: string
  feedId: string
  marketplace: string
  productType: string | null
  status: string
  skuCount: number
  resultSummary?: { messagesProcessed?: number; messagesSuccessful?: number; messagesWithWarning?: number; messagesWithError?: number } | null
  perSkuResults?: AmazonPerSku[] | null
  errorMessage?: string | null
  submittedAt: string
  completedAt?: string | null
}

// ── eBay types ─────────────────────────────────────────────────────────────

type EbaySkuStatus = 'PUSHED' | 'ERROR'
interface EbayPerSku { sku: string; market?: string; status: EbaySkuStatus; listingId?: string; message?: string }
interface EbayPushJob {
  id: string
  mode: string
  taskId?: string | null
  markets?: string[] | null
  status: string
  skuCount: number
  pushed: number
  failed: number
  perSkuResults?: EbayPerSku[] | null
  warnings?: Array<{ sku: string; requested?: number; published?: number; reason?: string }> | null
  errorMessage?: string | null
  submittedAt: string
  completedAt?: string | null
}

// ── VersionRecord (mirrors AmazonFlatFileClient's local type) ─────────────

interface VersionRecord {
  id: string
  label: string
  savedAt: string
  rowCount: number
  rows: unknown[]
}

// ── Props ──────────────────────────────────────────────────────────────────

export interface HistoryModalProps {
  open: boolean
  onClose: () => void
  channel: 'amazon' | 'ebay'
  marketplace: string
  productType?: string
  onResubmitErroredSkus?: (skus: string[], channel: 'amazon' | 'ebay') => void
  onGoToCell?: (sku: string, columnId: string) => void
  onRePull?: (rec: PullHistoryRecord) => void
  onRestoreVersion?: (rows: unknown[]) => void
  currentRows?: unknown[]
}

// ── Helpers ────────────────────────────────────────────────────────────────

const AMAZON_TERMINAL = new Set(['DONE', 'FATAL', 'CANCELLED'])

function fmtTime(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) +
      ' · ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  } catch { return iso }
}

const RELATIVE_FMT = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
function relativeTime(iso: string | null): string {
  if (!iso) return ''
  const deltaSec = Math.round((new Date(iso).getTime() - Date.now()) / 1000)
  const abs = Math.abs(deltaSec)
  if (abs < 60) return RELATIVE_FMT.format(deltaSec, 'second')
  if (abs < 3600) return RELATIVE_FMT.format(Math.round(deltaSec / 60), 'minute')
  if (abs < 86400) return RELATIVE_FMT.format(Math.round(deltaSec / 3600), 'hour')
  return RELATIVE_FMT.format(Math.round(deltaSec / 86400), 'day')
}

function versionHistoryKey(mp: string, pt: string) {
  return `ff-versions-${mp.toUpperCase()}-${pt.toUpperCase()}`
}

function exportCsvBlob(lines: string[], filename: string) {
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
}

// ── P5 export ────────────────────────────────────────────────────────────────
// Flatten every structured issue into one export row; jobs that predate issue
// capture fall back to their single per-SKU line so nothing is dropped.
interface IssueExportRow { sku: string; code: string; severity: string; category: string; columns: string; message: string; details: string }
function issueExportRows(job: AmazonFeedJob): IssueExportRow[] {
  const out: IssueExportRow[] = []
  for (const r of job.perSkuResults ?? []) {
    if (r.issues?.length) {
      for (const iss of r.issues) out.push({
        sku: r.sku, code: iss.code, severity: iss.severity, category: iss.category ?? '',
        columns: (iss.columns?.length ? iss.columns.map(c => c.label) : iss.attributeNames).join('; '),
        message: iss.message, details: iss.details ?? '',
      })
    } else {
      out.push({
        sku: r.sku, code: r.code ?? '',
        severity: r.status === 'error' ? 'error' : r.status === 'warning' ? 'warning' : 'info',
        category: '', columns: '', message: r.message ?? '', details: '',
      })
    }
  }
  return out
}
// Aggregate identical codes (Amazon's "per codice di errore").
function issueByCode(rows: IssueExportRow[]) {
  const map = new Map<string, { code: string; severity: string; title: string; columns: string; message: string; count: number; skus: Set<string> }>()
  for (const r of rows) {
    const key = r.code || r.category || r.message
    const hit = map.get(key)
    if (hit) { hit.count++; hit.skus.add(r.sku) }
    else map.set(key, { code: r.code, severity: r.severity, title: issueTitle(r), columns: r.columns, message: r.message, count: 1, skus: new Set([r.sku]) })
  }
  return [...map.values()].sort((a, b) => b.skus.size - a.skus.size)
}

function exportFeedCsv(job: AmazonFeedJob) {
  const rows = issueExportRows(job)
  const q = (v: string) => `"${(v ?? '').replace(/"/g, '""')}"`
  const lines = [['sku', 'code', 'severity', 'category', 'affected_columns', 'message', 'details'].join(',')]
  for (const r of rows) lines.push([q(r.sku), q(r.code), q(r.severity), q(r.category), q(r.columns), q(r.message), q(r.details)].join(','))
  exportCsvBlob(lines, `feed-${job.marketplace}-${job.feedId.slice(0, 12)}.csv`)
}

// Amazon-layout .xlsx — three groupings matching Seller Central's summary:
// Summary (Riepilogo) · By code (per codice di errore) · By SKU (per SKU).
async function exportFeedXlsx(job: AmazonFeedJob) {
  const mod: any = await import('exceljs')
  const ExcelJS = mod.default ?? mod
  const wb = new ExcelJS.Workbook()
  const rows = issueExportRows(job)
  const s = job.resultSummary
  const bold = { bold: true } as const

  const sum = wb.addWorksheet('Summary')
  sum.columns = [{ header: 'Metric', key: 'm', width: 22 }, { header: 'Value', key: 'v', width: 40 }]
  sum.getRow(1).font = bold
  sum.addRows([
    ['Marketplace', job.marketplace],
    ['Product type', job.productType ?? '—'],
    ['Feed ID', job.feedId],
    ['SKUs processed', s?.messagesProcessed ?? (job.perSkuResults?.length ?? 0)],
    ['Successful', s?.messagesSuccessful ?? 0],
    ['With warning', s?.messagesWithWarning ?? 0],
    ['With error', s?.messagesWithError ?? 0],
  ])

  const codeSheet = wb.addWorksheet('By code')
  codeSheet.columns = [
    { header: '#', key: 'n', width: 5 }, { header: 'Code', key: 'code', width: 10 },
    { header: 'Severity', key: 'sev', width: 10 }, { header: 'Issue', key: 'title', width: 34 },
    { header: 'Affected columns', key: 'cols', width: 28 }, { header: 'SKUs', key: 'count', width: 7 },
    { header: 'Message', key: 'msg', width: 70 },
  ]
  codeSheet.getRow(1).font = bold
  issueByCode(rows).forEach((g, i) => codeSheet.addRow([i + 1, g.code, g.severity, g.title, g.columns, g.skus.size, g.message]))

  const skuSheet = wb.addWorksheet('By SKU')
  skuSheet.columns = [
    { header: '#', key: 'n', width: 5 }, { header: 'SKU', key: 'sku', width: 22 },
    { header: 'Code', key: 'code', width: 10 }, { header: 'Severity', key: 'sev', width: 10 },
    { header: 'Category', key: 'cat', width: 22 }, { header: 'Affected columns', key: 'cols', width: 28 },
    { header: 'Message', key: 'msg', width: 70 }, { header: 'Details', key: 'det', width: 40 },
  ]
  skuSheet.getRow(1).font = bold
  rows.forEach((r, i) => skuSheet.addRow([i + 1, r.sku, r.code, r.severity, r.category, r.columns, r.message, r.details]))

  const buf = await wb.xlsx.writeBuffer()
  downloadBlob(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
    `feed-${job.marketplace}-${job.feedId.slice(0, 12)}.xlsx`)
}

// ── Pill tones ─────────────────────────────────────────────────────────────

function amazonJobTone(job: AmazonFeedJob): 'success' | 'danger' | 'warning' | 'neutral' {
  if (job.status === 'FATAL' || job.status === 'CANCELLED') return 'danger'
  if (job.status === 'DONE') {
    const errs = job.resultSummary?.messagesWithError ?? (job.perSkuResults ?? []).filter(p => p.status === 'error').length
    return errs > 0 ? 'danger' : 'success'
  }
  return 'warning' // IN_PROGRESS / IN_QUEUE
}

function amazonJobPillLabel(job: AmazonFeedJob): string {
  if (job.status === 'FATAL') return 'FATAL'
  if (job.status === 'CANCELLED') return 'CANCELLED'
  if (job.status === 'DONE') {
    const errs = job.resultSummary?.messagesWithError ?? (job.perSkuResults ?? []).filter(p => p.status === 'error').length
    return errs > 0 ? `DONE · ${errs} error${errs === 1 ? '' : 's'}` : 'DONE'
  }
  return job.status || '…'
}

function ebayJobTone(job: EbayPushJob): 'success' | 'danger' | 'warning' | 'info' {
  if (job.status === 'DONE') return 'success'
  if (job.status === 'PARTIAL') return 'warning'
  if (job.status === 'FATAL') return 'danger'
  return 'info' // SUBMITTED
}

function ebayJobPillLabel(job: EbayPushJob): string {
  if (job.status === 'DONE') return `DONE · ${job.pushed} pushed`
  if (job.status === 'PARTIAL') return `PARTIAL · ${job.failed} error${job.failed === 1 ? '' : 's'}`
  if (job.status === 'FATAL') return job.failed > 0 ? `FATAL · ${job.failed} error${job.failed === 1 ? '' : 's'}` : 'FATAL'
  return job.status || '…'
}

// ── LoadingSkeletons ────────────────────────────────────────────────────────

function LoadingSkeletons() {
  return (
    <div className="flex flex-col gap-3 p-4">
      <Skeleton height={48} radius={6} />
      <Skeleton height={48} radius={6} />
      <Skeleton height={48} radius={6} />
    </div>
  )
}

// ── AmazonPushesTab ─────────────────────────────────────────────────────────

function AmazonPushesTab({
  onResubmitErroredSkus,
  onGoToCell,
}: {
  onResubmitErroredSkus?: (skus: string[], channel: 'amazon' | 'ebay') => void
  onGoToCell?: (sku: string, columnId: string) => void
}) {
  const [jobs, setJobs] = useState<AmazonFeedJob[]>([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | AmazonSkuStatus>('all')
  const [viewMode, setViewMode] = useState<'error' | 'code'>('error')
  const [openMsg, setOpenMsg] = useState<string | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    fetch(`${getBackendUrl()}/api/amazon/flat-file/feeds?limit=50`, { cache: 'no-store' })
      .then(r => r.ok ? r.json() : Promise.reject(new Error(String(r.status))))
      .then(d => setJobs(Array.isArray(d?.jobs) ? d.jobs : []))
      .catch(() => setJobs([]))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load() }, [load])

  useOrderEventsRefresh(load, {
    eventTypes: ['flat_file_feed.status_changed'],
    debounceMs: 1500,
    enabled: jobs.some(j => !AMAZON_TERMINAL.has(j.status)),
  })

  const expandedJob = jobs.find(j => j.id === expanded) ?? null
  const filteredSkuRows = useMemo(() => {
    const all = expandedJob?.perSkuResults ?? []
    const q = query.trim().toLowerCase()
    return all.filter(r => {
      if (filter !== 'all' && r.status !== filter) return false
      if (!q) return true
      return r.sku?.toLowerCase().includes(q) || r.message?.toLowerCase().includes(q) || r.code?.toLowerCase().includes(q)
    })
  }, [expandedJob, query, filter])

  // P3 — flatten every structured issue across the filtered SKUs into one list,
  // so a SKU with several distinct problems shows each on its own row (Amazon's
  // "Errori e avvisi per SKU"). Falls back to legacy per-SKU rows when a job
  // predates structured capture (no `issues`).
  const hasIssues = useMemo(
    () => filteredSkuRows.some(r => (r.issues?.length ?? 0) > 0),
    [filteredSkuRows],
  )
  const flatIssues = useMemo<FlatIssue[]>(() => {
    const out: FlatIssue[] = []
    for (const r of filteredSkuRows) for (const iss of r.issues ?? []) out.push({ ...iss, sku: r.sku })
    return out
  }, [filteredSkuRows])
  // "Errori e avvisi per codice di errore" — roll identical codes up, count the
  // affected SKUs, keep a representative message + resolved columns.
  const byCode = useMemo(() => {
    const map = new Map<string, { code: string; severity: IssueSeverity; title: string; cols: string; message: string; skus: string[] }>()
    for (const iss of flatIssues) {
      const key = iss.code || iss.category || iss.message
      const hit = map.get(key)
      if (hit) { if (!hit.skus.includes(iss.sku)) hit.skus.push(iss.sku) }
      else map.set(key, { code: iss.code, severity: iss.severity, title: issueTitle(iss), cols: issueCols(iss), message: iss.message, skus: [iss.sku] })
    }
    return [...map.values()].sort((a, b) => b.skus.length - a.skus.length)
  }, [flatIssues])

  function copyErrored(job: AmazonFeedJob) {
    const skus = (job.perSkuResults ?? []).filter(r => r.status === 'error').map(r => r.sku)
    if (skus.length) void navigator.clipboard?.writeText(skus.join('\n'))
  }

  if (loading && jobs.length === 0) return <LoadingSkeletons />

  if (jobs.length === 0) {
    return (
      <div className="p-6">
        <EmptyState
          icon={<History className="w-8 h-8 text-slate-300" />}
          title="No submissions yet"
          description="When you submit a flat file it appears here with live status and the full per-SKU result — and stays, even if you close the tab."
        />
      </div>
    )
  }

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between px-4 py-2 border-b border-subtle dark:border-slate-800">
        <span className="text-xs text-slate-500">{jobs.length} submission{jobs.length !== 1 ? 's' : ''} · durable · all devices</span>
        <button type="button" onClick={load} className="text-tertiary hover:text-slate-600 dark:hover:text-slate-300 p-1 rounded" title="Refresh">
          <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
        </button>
      </div>
      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
        {jobs.map(job => {
          const isOpen = expanded === job.id
          const summary = job.resultSummary
          const errCount = summary?.messagesWithError ?? (job.perSkuResults ?? []).filter(p => p.status === 'error').length
          const warnCount = summary?.messagesWithWarning ?? (job.perSkuResults ?? []).filter(p => p.status === 'warning').length
          return (
            <li key={job.id}>
              <button
                type="button"
                onClick={() => setExpanded(isOpen ? null : job.id)}
                className="w-full flex items-center gap-2 px-4 py-2.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800/50"
              >
                {isOpen
                  ? <ChevronDown className="w-3.5 h-3.5 text-tertiary shrink-0" />
                  : <ChevronRight className="w-3.5 h-3.5 text-tertiary shrink-0" />}
                <span className="text-xs font-semibold text-slate-700 dark:text-slate-200 w-7 shrink-0">{job.marketplace}</span>
                <Pill tone={amazonJobTone(job)}>{amazonJobPillLabel(job)}</Pill>
                <span className="text-xs text-slate-500 dark:text-slate-400 truncate flex-1">{job.productType ?? '—'} · {job.skuCount} SKU{job.skuCount === 1 ? '' : 's'}</span>
                <span className="text-[11px] text-tertiary shrink-0">{fmtTime(job.submittedAt)}</span>
              </button>

              {isOpen && (
                <div className="px-4 pb-4 bg-slate-50/50 dark:bg-slate-950/30">
                  {/* Error / warning banner */}
                  {errCount > 0 && (
                    <div className="mb-2">
                      <Banner tone="danger" title={`${errCount} error${errCount === 1 ? '' : 's'} — ${errCount} SKU${errCount === 1 ? '' : 's'} failed`} />
                    </div>
                  )}
                  {errCount === 0 && warnCount > 0 && (
                    <div className="mb-2">
                      <Banner tone="warning" title={`${warnCount} warning${warnCount === 1 ? '' : 's'}`} />
                    </div>
                  )}

                  {/* Summary line */}
                  {summary && (
                    <div className="text-xs text-slate-500 dark:text-slate-400 mb-2 flex flex-wrap gap-x-3">
                      <span>{summary.messagesProcessed ?? 0} processed</span>
                      <span className="text-emerald-600 dark:text-emerald-400">{summary.messagesSuccessful ?? 0} ok</span>
                      {(summary.messagesWithWarning ?? 0) > 0 && <span className="text-amber-600 dark:text-amber-400">{summary.messagesWithWarning} warn</span>}
                      {(summary.messagesWithError ?? 0) > 0 && <span className="text-red-600 dark:text-red-400">{summary.messagesWithError} error</span>}
                      <span className="font-mono text-tertiary" title={job.feedId}>feed {job.feedId.slice(0, 14)}…</span>
                    </div>
                  )}
                  {job.errorMessage && <p className="text-xs text-red-600 dark:text-red-400 mb-2">{job.errorMessage}</p>}

                  {(job.perSkuResults?.length ?? 0) > 0 ? (
                    <>
                      {/* Controls */}
                      <div className="flex items-center gap-2 mb-2">
                        <div className="relative flex-1">
                          <Search className="w-3 h-3 text-tertiary absolute left-2 top-1/2 -translate-y-1/2" />
                          <input
                            value={query} onChange={e => setQuery(e.target.value)}
                            placeholder="Search SKU / message / code"
                            className="w-full h-7 pl-7 pr-2 text-xs border border-default dark:border-slate-700 rounded bg-white dark:bg-slate-900"
                          />
                        </div>
                        <select
                          value={filter} onChange={e => setFilter(e.target.value as 'all' | AmazonSkuStatus)}
                          className="h-7 px-1 text-xs border border-default dark:border-slate-700 rounded bg-white dark:bg-slate-900"
                        >
                          <option value="all">All</option>
                          <option value="error">Errors</option>
                          <option value="warning">Warnings</option>
                          <option value="success">OK</option>
                        </select>
                        {hasIssues && (
                          <div className="inline-flex h-7 rounded border border-default dark:border-slate-700 overflow-hidden shrink-0">
                            <button type="button" onClick={() => setViewMode('error')}
                              className={cn('px-2 text-xs', viewMode === 'error' ? 'bg-slate-900 text-white dark:bg-slate-200 dark:text-slate-900' : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300')}>
                              By error
                            </button>
                            <button type="button" onClick={() => setViewMode('code')}
                              className={cn('px-2 text-xs border-l border-default dark:border-slate-700', viewMode === 'code' ? 'bg-slate-900 text-white dark:bg-slate-200 dark:text-slate-900' : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300')}>
                              By code
                            </button>
                          </div>
                        )}
                        <button type="button" onClick={() => exportFeedCsv(job)}
                          className="h-7 px-2 text-xs border border-default dark:border-slate-700 rounded hover:bg-white dark:hover:bg-slate-800 inline-flex items-center gap-1"
                          title="Per-issue CSV: sku · code · severity · category · columns · message · details">
                          <Download className="w-3 h-3" />CSV
                        </button>
                        <button type="button" onClick={() => { void exportFeedXlsx(job) }}
                          className="h-7 px-2 text-xs border border-default dark:border-slate-700 rounded hover:bg-white dark:hover:bg-slate-800 inline-flex items-center gap-1"
                          title="Amazon-layout workbook: Summary · By code · By SKU">
                          <Download className="w-3 h-3" />XLSX
                        </button>
                        {errCount > 0 && (
                          <button type="button" onClick={() => copyErrored(job)}
                            className="h-7 px-2 text-xs border border-default dark:border-slate-700 rounded hover:bg-white dark:hover:bg-slate-800 inline-flex items-center gap-1">
                            <Copy className="w-3 h-3" />SKUs
                          </button>
                        )}
                        {errCount > 0 && onResubmitErroredSkus && (
                          <button type="button"
                            onClick={() => {
                              const erroredSkus = (job.perSkuResults ?? []).filter(r => r.status === 'error').map(r => r.sku)
                              onResubmitErroredSkus(erroredSkus, 'amazon')
                            }}
                            className="h-7 px-2 text-xs bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-800 rounded hover:bg-red-100 dark:hover:bg-red-900/40 inline-flex items-center gap-1">
                            Re-submit errors
                          </button>
                        )}
                      </div>

                      {/* Detail — structured issues (Amazon parity) or legacy per-SKU table */}
                      <div className="max-h-72 overflow-y-auto border border-default dark:border-slate-800 rounded">
                        {hasIssues && viewMode === 'error' && (
                          <table className="w-full text-xs">
                            <thead className="sticky top-0 bg-slate-50 dark:bg-slate-900 text-tertiary">
                              <tr className="text-left">
                                <th className="px-2 py-1 font-medium">Code</th>
                                <th className="px-2 py-1 font-medium">Issue</th>
                                <th className="px-2 py-1 font-medium">SKU</th>
                                <th className="px-2 py-1 font-medium">Column</th>
                                <th className="px-2 py-1 font-medium">Message</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                              {flatIssues.map((iss, i) => {
                                const firstCol = iss.columns?.[0]
                                const msgKey = `${iss.sku}-${iss.code}-${i}`
                                return (
                                  <tr key={msgKey} className="hover:bg-white dark:hover:bg-slate-800/40 align-top">
                                    <td className="px-2 py-1 whitespace-nowrap">
                                      <span className={cn('inline-flex items-center gap-1', issueSevCls[iss.severity])}>
                                        <span className="w-1.5 h-1.5 rounded-full bg-current shrink-0" />
                                        <span className="font-mono">{iss.code || '—'}</span>
                                      </span>
                                    </td>
                                    <td className="px-2 py-1 text-slate-700 dark:text-slate-200 whitespace-nowrap">{issueTitle(iss)}</td>
                                    <td className="px-2 py-1 font-mono text-slate-600 dark:text-slate-300 whitespace-nowrap">{iss.sku}</td>
                                    <td className="px-2 py-1 whitespace-nowrap">
                                      {firstCol && onGoToCell ? (
                                        <button type="button" onClick={() => onGoToCell(iss.sku, firstCol.id)}
                                          className="inline-flex items-center gap-0.5 text-blue-600 dark:text-blue-400 hover:underline" title="Jump to this cell">
                                          {issueCols(iss)}<span aria-hidden>↗</span>
                                        </button>
                                      ) : (
                                        <span className="text-tertiary">{issueCols(iss) || '—'}</span>
                                      )}
                                    </td>
                                    <td className="px-2 py-1 text-slate-500 dark:text-slate-400">
                                      <button type="button" onClick={() => setOpenMsg(openMsg === msgKey ? null : msgKey)}
                                        className={cn('text-left w-full', openMsg === msgKey ? '' : 'line-clamp-1')}>
                                        {iss.message}{iss.details ? ` — ${iss.details}` : ''}
                                      </button>
                                    </td>
                                  </tr>
                                )
                              })}
                              {flatIssues.length === 0 && (
                                <tr><td colSpan={5} className="px-2 py-3 text-center text-tertiary">No issues match.</td></tr>
                              )}
                            </tbody>
                          </table>
                        )}

                        {hasIssues && viewMode === 'code' && (
                          <table className="w-full text-xs">
                            <thead className="sticky top-0 bg-slate-50 dark:bg-slate-900 text-tertiary">
                              <tr className="text-left">
                                <th className="px-2 py-1 font-medium">Code</th>
                                <th className="px-2 py-1 font-medium">Issue</th>
                                <th className="px-2 py-1 font-medium">Count</th>
                                <th className="px-2 py-1 font-medium">Column</th>
                                <th className="px-2 py-1 font-medium">SKUs</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                              {byCode.map((g, i) => (
                                <tr key={`${g.code}-${i}`} className="hover:bg-white dark:hover:bg-slate-800/40 align-top">
                                  <td className="px-2 py-1 whitespace-nowrap">
                                    <span className={cn('inline-flex items-center gap-1', issueSevCls[g.severity])}>
                                      <span className="w-1.5 h-1.5 rounded-full bg-current shrink-0" />
                                      <span className="font-mono">{g.code || '—'}</span>
                                    </span>
                                  </td>
                                  <td className="px-2 py-1 text-slate-700 dark:text-slate-200">
                                    <div className="whitespace-nowrap">{g.title}</div>
                                    <div className="text-tertiary line-clamp-1">{g.message}</div>
                                  </td>
                                  <td className="px-2 py-1 text-slate-600 dark:text-slate-300 whitespace-nowrap">{g.skus.length}×</td>
                                  <td className="px-2 py-1 text-tertiary whitespace-nowrap">{g.cols || '—'}</td>
                                  <td className="px-2 py-1">
                                    <div className="flex flex-wrap gap-1">
                                      {g.skus.map(sku => (
                                        <button key={sku} type="button"
                                          onClick={() => { setViewMode('error'); setQuery(sku) }}
                                          className="font-mono text-[11px] px-1 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700"
                                          title="Filter to this SKU">
                                          {sku}
                                        </button>
                                      ))}
                                    </div>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}

                        {!hasIssues && (
                          <table className="w-full text-xs">
                            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                              {filteredSkuRows.map((r, i) => (
                                <tr key={`${r.sku}-${i}`} className="hover:bg-white dark:hover:bg-slate-800/40">
                                  <td className="px-2 py-1 font-mono text-slate-700 dark:text-slate-300 whitespace-nowrap">{r.sku}</td>
                                  <td className="px-2 py-1">
                                    <Pill tone={r.status === 'success' ? 'success' : r.status === 'warning' ? 'warning' : 'danger'}>
                                      {r.status}
                                    </Pill>
                                  </td>
                                  <td className="px-2 py-1 text-tertiary whitespace-nowrap">{r.code ?? ''}</td>
                                  <td className="px-2 py-1 text-slate-500 dark:text-slate-400">{r.message ?? ''}</td>
                                </tr>
                              ))}
                              {filteredSkuRows.length === 0 && (
                                <tr><td colSpan={4} className="px-2 py-3 text-center text-tertiary">No rows match.</td></tr>
                              )}
                            </tbody>
                          </table>
                        )}
                      </div>
                    </>
                  ) : (
                    <p className="text-xs text-tertiary">
                      {AMAZON_TERMINAL.has(job.status) ? 'No per-SKU detail in the report.' : 'Still processing — the per-SKU result appears when Amazon finishes.'}
                    </p>
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

// ── EbayPushesTab ───────────────────────────────────────────────────────────

function EbayPushesTab({
  onResubmitErroredSkus,
}: {
  onResubmitErroredSkus?: (skus: string[], channel: 'amazon' | 'ebay') => void
}) {
  const [jobs, setJobs] = useState<EbayPushJob[]>([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | EbaySkuStatus>('all')

  const load = useCallback(() => {
    setLoading(true)
    fetch(`${getBackendUrl()}/api/ebay/flat-file/pushes?limit=50`, { cache: 'no-store' })
      .then(r => r.ok ? r.json() : Promise.reject(new Error(String(r.status))))
      .then(d => setJobs(Array.isArray(d?.pushes) ? d.pushes : []))
      .catch(() => setJobs([]))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load() }, [load])

  useOrderEventsRefresh(load, {
    eventTypes: ['ebay_push.status_changed'],
    debounceMs: 1500,
    enabled: jobs.some(j => j.status === 'SUBMITTED'),
  })

  const expandedJob = jobs.find(j => j.id === expanded) ?? null
  const filteredSkuRows = useMemo(() => {
    const all = expandedJob?.perSkuResults ?? []
    const q = query.trim().toLowerCase()
    return all.filter(r => {
      if (filter !== 'all' && r.status !== filter) return false
      if (!q) return true
      return r.sku?.toLowerCase().includes(q) || r.message?.toLowerCase().includes(q) || r.market?.toLowerCase().includes(q)
    })
  }, [expandedJob, query, filter])

  function exportCsv(job: EbayPushJob) {
    const lines = [['sku', 'market', 'status', 'listingId', 'message'].join(',')]
    for (const r of job.perSkuResults ?? []) {
      lines.push([r.sku, r.market ?? '', r.status, r.listingId ?? '', `"${(r.message ?? '').replace(/"/g, '""')}"`].join(','))
    }
    exportCsvBlob(lines, `ebay-push-${(job.markets ?? []).join('-') || 'multi'}-${job.id.slice(0, 8)}.csv`)
  }

  function copyErrored(job: EbayPushJob) {
    const skus = (job.perSkuResults ?? []).filter(r => r.status === 'ERROR').map(r => r.sku)
    if (skus.length) void navigator.clipboard?.writeText(skus.join('\n'))
  }

  if (loading && jobs.length === 0) return <LoadingSkeletons />

  if (jobs.length === 0) {
    return (
      <div className="p-6">
        <EmptyState
          icon={<History className="w-8 h-8 text-slate-300" />}
          title="No pushes yet"
          description="When you push to eBay, every attempt appears here with its full per-SKU result — and stays, even if the push fails or you close the tab."
        />
      </div>
    )
  }

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between px-4 py-2 border-b border-subtle dark:border-slate-800">
        <span className="text-xs text-slate-500">{jobs.length} push{jobs.length !== 1 ? 'es' : ''} · durable · all devices</span>
        <button type="button" onClick={load} className="text-tertiary hover:text-slate-600 dark:hover:text-slate-300 p-1 rounded" title="Refresh">
          <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
        </button>
      </div>
      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
        {jobs.map(job => {
          const isOpen = expanded === job.id
          return (
            <li key={job.id}>
              <button
                type="button"
                onClick={() => setExpanded(isOpen ? null : job.id)}
                className="w-full flex items-center gap-2 px-4 py-2.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800/50"
              >
                {isOpen
                  ? <ChevronDown className="w-3.5 h-3.5 text-tertiary shrink-0" />
                  : <ChevronRight className="w-3.5 h-3.5 text-tertiary shrink-0" />}
                <span className="text-xs font-semibold text-slate-700 dark:text-slate-200 shrink-0 whitespace-nowrap">
                  {(job.markets ?? []).join(', ') || '—'}
                </span>
                <Pill tone={ebayJobTone(job)}>{ebayJobPillLabel(job)}</Pill>
                <span className="text-xs text-slate-500 dark:text-slate-400 truncate flex-1">{job.mode} · {job.skuCount} SKU{job.skuCount === 1 ? '' : 's'}</span>
                <span className="text-[11px] text-tertiary shrink-0">{fmtTime(job.submittedAt)}</span>
              </button>

              {isOpen && (
                <div className="px-4 pb-4 bg-slate-50/50 dark:bg-slate-950/30">
                  {/* Summary line */}
                  <div className="text-xs text-slate-500 dark:text-slate-400 mb-2 flex flex-wrap gap-x-3">
                    <span>{job.skuCount} row{job.skuCount === 1 ? '' : 's'}</span>
                    <span className="text-emerald-600 dark:text-emerald-400">{job.pushed} pushed</span>
                    {job.failed > 0 && <span className="text-red-600 dark:text-red-400">{job.failed} error{job.failed === 1 ? '' : 's'}</span>}
                    {job.taskId && <span className="font-mono text-tertiary" title={job.taskId}>task {job.taskId.slice(0, 14)}…</span>}
                  </div>
                  {job.errorMessage && <p className="text-xs text-red-600 dark:text-red-400 mb-2">{job.errorMessage}</p>}

                  {/* Oversell warnings */}
                  {(job.warnings?.length ?? 0) > 0 && (
                    <div className="text-[11px] text-amber-600 dark:text-amber-400 mb-2 space-y-0.5">
                      {job.warnings!.slice(0, 4).map((w, i) => (
                        <p key={i}>⚠ <span className="font-mono">{w.sku}</span>: {w.reason}</p>
                      ))}
                      {job.warnings!.length > 4 && <p>+{job.warnings!.length - 4} more warning{job.warnings!.length - 4 === 1 ? '' : 's'}</p>}
                    </div>
                  )}

                  {/* SUBMITTED pending */}
                  {job.status === 'SUBMITTED' && (job.perSkuResults?.length ?? 0) === 0 && (
                    <div className="flex items-center gap-2 text-xs text-blue-600 dark:text-blue-400 mb-2">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      Feed processing — result appears automatically when eBay finishes.
                    </div>
                  )}

                  {(job.perSkuResults?.length ?? 0) > 0 ? (
                    <>
                      {/* Controls */}
                      <div className="flex items-center gap-2 mb-2">
                        <div className="relative flex-1">
                          <Search className="w-3 h-3 text-tertiary absolute left-2 top-1/2 -translate-y-1/2" />
                          <input
                            value={query} onChange={e => setQuery(e.target.value)}
                            placeholder="Search SKU / message / market"
                            className="w-full h-7 pl-7 pr-2 text-xs border border-default dark:border-slate-700 rounded bg-white dark:bg-slate-900"
                          />
                        </div>
                        <select
                          value={filter} onChange={e => setFilter(e.target.value as 'all' | EbaySkuStatus)}
                          className="h-7 px-1 text-xs border border-default dark:border-slate-700 rounded bg-white dark:bg-slate-900"
                        >
                          <option value="all">All</option>
                          <option value="ERROR">Errors</option>
                          <option value="PUSHED">Pushed</option>
                        </select>
                        <button type="button" onClick={() => exportCsv(job)}
                          className="h-7 px-2 text-xs border border-default dark:border-slate-700 rounded hover:bg-white dark:hover:bg-slate-800 inline-flex items-center gap-1">
                          <Download className="w-3 h-3" />CSV
                        </button>
                        {job.failed > 0 && (
                          <button type="button" onClick={() => copyErrored(job)}
                            className="h-7 px-2 text-xs border border-default dark:border-slate-700 rounded hover:bg-white dark:hover:bg-slate-800 inline-flex items-center gap-1">
                            <Copy className="w-3 h-3" />SKUs
                          </button>
                        )}
                        {job.failed > 0 && onResubmitErroredSkus && (
                          <button type="button"
                            onClick={() => {
                              const erroredSkus = (job.perSkuResults ?? []).filter(r => r.status === 'ERROR').map(r => r.sku)
                              onResubmitErroredSkus(erroredSkus, 'ebay')
                            }}
                            className="h-7 px-2 text-xs bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-800 rounded hover:bg-red-100 dark:hover:bg-red-900/40 inline-flex items-center gap-1">
                            Re-submit errors
                          </button>
                        )}
                      </div>

                      {/* Per-SKU table */}
                      <div className="max-h-60 overflow-y-auto border border-default dark:border-slate-800 rounded">
                        <table className="w-full text-xs">
                          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                            {filteredSkuRows.map((r, i) => (
                              <tr key={`${r.sku}-${i}`} className="hover:bg-white dark:hover:bg-slate-800/40">
                                <td className="px-2 py-1 font-mono text-slate-700 dark:text-slate-300 whitespace-nowrap">{r.sku}</td>
                                <td className="px-2 py-1 text-tertiary whitespace-nowrap">{r.market ?? ''}</td>
                                <td className="px-2 py-1">
                                  <Pill tone={r.status === 'PUSHED' ? 'success' : 'danger'}>{r.status}</Pill>
                                </td>
                                <td className="px-2 py-1 text-tertiary whitespace-nowrap">{r.listingId ?? ''}</td>
                                <td className="px-2 py-1 text-slate-500 dark:text-slate-400">{r.message ?? ''}</td>
                              </tr>
                            ))}
                            {filteredSkuRows.length === 0 && (
                              <tr><td colSpan={5} className="px-2 py-3 text-center text-tertiary">No rows match.</td></tr>
                            )}
                          </tbody>
                        </table>
                      </div>
                    </>
                  ) : (
                    job.status !== 'SUBMITTED' && (
                      <p className="text-xs text-tertiary">No per-SKU detail recorded.</p>
                    )
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

// ── PullsTab ────────────────────────────────────────────────────────────────

function PullsTab({
  channel,
  marketplace,
  productType,
  onRePull,
  open,
}: {
  channel: 'amazon' | 'ebay'
  marketplace: string
  productType?: string
  onRePull?: (rec: PullHistoryRecord) => void
  open: boolean
}) {
  const [records, setRecords] = useState<PullHistoryRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const ch = channel.toUpperCase() as 'AMAZON' | 'EBAY'
      const params = new URLSearchParams({ channel: ch, marketplace, limit: '25' })
      if (channel === 'amazon' && productType) params.set('productType', productType)
      const res = await fetch(`${getBackendUrl()}/api/flat-file/pull-history?${params.toString()}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`)
      setRecords(Array.isArray(data.records) ? data.records : [])
    } catch (e: unknown) {
      setError((e as Error)?.message ?? 'Failed to load history')
    } finally {
      setLoading(false)
    }
  }, [channel, marketplace, productType])

  useEffect(() => {
    if (open) void load()
  }, [open, load])

  if (loading && records.length === 0) return <LoadingSkeletons />

  if (error) {
    return (
      <div className="p-4">
        <Banner tone="danger" title="Failed to load pull history">{error}</Banner>
      </div>
    )
  }

  if (!loading && records.length === 0) {
    return (
      <div className="p-6">
        <EmptyState
          icon={<History className="w-8 h-8 text-slate-300" />}
          title="No applied pulls yet"
          description={`Run "Pull from ${channel === 'amazon' ? 'Amazon' : 'eBay'}" and apply changes to see them here.`}
        />
      </div>
    )
  }

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between px-4 py-2 border-b border-subtle dark:border-slate-800">
        <span className="text-xs text-slate-500">Last {records.length} applied pull{records.length !== 1 ? 's' : ''}</span>
        <button type="button" onClick={() => void load()} disabled={loading}
          className="text-tertiary hover:text-slate-600 dark:hover:text-slate-300 p-1 rounded" title="Refresh">
          <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
        </button>
      </div>
      <div className="flex flex-col gap-2 p-3">
        {records.map(rec => {
          const isAllCols = rec.columnsApplied.includes('all') || rec.columnsApplied.length === 0
          const cols = rec.columnsApplied.filter(c => c !== 'all') as PullGroupId[]
          return (
            <div key={rec.id}
              className="border border-default dark:border-slate-700 rounded-lg p-3 bg-white dark:bg-slate-900 hover:border-slate-300 dark:hover:border-slate-600 transition-colors">
              {/* Top row */}
              <div className="flex items-start justify-between gap-2 mb-2">
                <div className="text-xs text-slate-700 dark:text-slate-200">
                  <span className="font-medium">{relativeTime(rec.appliedAt ?? rec.pulledAt)}</span>
                  <span className="text-tertiary ml-1.5 text-[11px]">
                    {new Date(rec.appliedAt ?? rec.pulledAt).toLocaleString()}
                  </span>
                </div>
                {onRePull && (
                  <button
                    type="button"
                    onClick={() => onRePull(rec)}
                    title="Re-pull these SKUs with the same scope and columns"
                    className="text-xs h-6 px-2 inline-flex items-center gap-1 border border-default dark:border-slate-700 rounded hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 flex-shrink-0"
                  >
                    <Repeat className="w-3 h-3" />Re-pull
                  </button>
                )}
              </div>

              {/* Stats */}
              <div className="flex items-center gap-3 text-[11px] text-slate-500 dark:text-slate-400 mb-2">
                <span><span className="text-slate-800 dark:text-slate-200 font-medium">{rec.skusRequested.length}</span> requested</span>
                <span><span className="text-slate-800 dark:text-slate-200 font-medium">{rec.skusReturned}</span> returned</span>
                <span><span className="text-slate-800 dark:text-slate-200 font-medium">{rec.rowsApplied}</span> applied</span>
                <span><span className="text-slate-800 dark:text-slate-200 font-medium">{rec.fieldsApplied}</span> cells</span>
              </div>

              {/* Column groups */}
              <div className="flex flex-wrap gap-1 mb-2">
                {isAllCols ? (
                  <span className="text-[10px] font-medium uppercase px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">All columns</span>
                ) : cols.length === 0 ? (
                  <span className="text-[10px] italic text-tertiary">no column data</span>
                ) : cols.map(c => (
                  <span key={c} className={cn('text-[10px] font-medium uppercase px-1.5 py-0.5 rounded', GROUP_BADGE_CLASS[c] ?? GROUP_BADGE_CLASS.other)}>
                    {GROUP_LABEL[c] ?? c}
                  </span>
                ))}
              </div>

              {/* SKUs preview */}
              {rec.skusRequested.length > 0 && (
                <div className="text-[10px] font-mono text-slate-500 dark:text-slate-400 truncate">
                  {rec.skusRequested.slice(0, 3).join(', ')}
                  {rec.skusRequested.length > 3 && ` + ${rec.skusRequested.length - 3} more`}
                </div>
              )}
              {rec.operatorNote && (
                <div className="text-[11px] text-slate-600 dark:text-slate-300 mt-1.5 italic">"{rec.operatorNote}"</div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── VersionsTab (Amazon only) ───────────────────────────────────────────────

function VersionsTab({
  marketplace,
  productType,
  currentRows,
  onRestoreVersion,
}: {
  marketplace: string
  productType: string
  currentRows: unknown[]
  onRestoreVersion?: (rows: unknown[]) => void
}) {
  const [versions, setVersions] = useState<VersionRecord[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(versionHistoryKey(marketplace, productType)) ?? '[]')
    } catch { return [] }
  })

  function diff(v: VersionRecord): string {
    const currentSkus = new Set((currentRows as Array<Record<string, unknown>>).map(r => String(r.item_sku ?? r._rowId)))
    const versionSkus = new Set((v.rows as Array<Record<string, unknown>>).map(r => String(r.item_sku ?? r._rowId)))
    const added = (currentRows as Array<Record<string, unknown>>).filter(r => !versionSkus.has(String(r.item_sku ?? r._rowId))).length
    const removed = (v.rows as Array<Record<string, unknown>>).filter(r => !currentSkus.has(String(r.item_sku ?? r._rowId))).length
    const parts: string[] = []
    if (added > 0) parts.push(`+${added} row${added !== 1 ? 's' : ''} now`)
    if (removed > 0) parts.push(`−${removed} row${removed !== 1 ? 's' : ''} then`)
    if (parts.length === 0) parts.push(`${v.rowCount} rows`)
    return parts.join(' · ')
  }

  function clearAll() {
    if (!confirm('Delete all saved versions? This cannot be undone.')) return
    try { localStorage.removeItem(versionHistoryKey(marketplace, productType)) } catch {}
    setVersions([])
  }

  if (versions.length === 0) {
    return (
      <div className="p-6">
        <EmptyState
          icon={<Clock className="w-8 h-8 text-slate-300" />}
          title="No versions saved yet"
          description="Versions are created automatically on Save, Submit, Import and Discard."
        />
      </div>
    )
  }

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between px-4 py-2 border-b border-subtle dark:border-slate-800">
        <span className="text-xs text-slate-500">{marketplace} · {productType} · up to 15 versions</span>
        <button type="button" onClick={clearAll}
          className="text-xs text-red-400 hover:text-red-600 dark:hover:text-red-300">
          Clear all
        </button>
      </div>
      <div className="divide-y divide-slate-100 dark:divide-slate-800">
        {versions.map((v, i) => (
          <div key={v.id} className="px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-800/40 flex items-center gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                {i === 0 && (
                  <span className="text-[10px] bg-violet-100 dark:bg-violet-900/40 text-violet-600 dark:text-violet-300 px-1.5 py-0.5 rounded font-medium">latest</span>
                )}
                <span className="text-xs font-medium text-slate-700 dark:text-slate-300 truncate">{v.label}</span>
              </div>
              <div className="text-[10px] text-tertiary mt-0.5 flex items-center gap-2">
                <span>{fmtTime(v.savedAt)}</span>
                <span>·</span>
                <span className="text-slate-500 dark:text-slate-400">{diff(v)}</span>
              </div>
            </div>
            {onRestoreVersion && (
              <button
                type="button"
                onClick={() => {
                  if (!confirm(`Restore to "${v.label}"? Current rows will be replaced (you can undo).`)) return
                  onRestoreVersion(v.rows)
                }}
                className="text-xs h-6 px-2 inline-flex items-center border border-default dark:border-slate-700 rounded hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 flex-shrink-0"
              >
                Restore
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

// ── HistoryModal ────────────────────────────────────────────────────────────

export function HistoryModal({
  open,
  onClose,
  channel,
  marketplace,
  productType,
  onResubmitErroredSkus,
  onGoToCell,
  onRePull,
  onRestoreVersion,
  currentRows = [],
}: HistoryModalProps) {
  const showVersions = channel === 'amazon'
  const defaultTab = 'pushes'
  const [activeTab, setActiveTab] = useState(defaultTab)

  // reset to pushes tab when modal opens
  useEffect(() => {
    if (open) setActiveTab('pushes')
  }, [open])

  const tabs = [
    { id: 'pushes', label: 'Pushes' },
    { id: 'pulls', label: 'Pulls' },
    ...(showVersions ? [{ id: 'versions', label: 'Versions' }] : []),
  ]

  const channelLabel = channel === 'amazon' ? 'Amazon' : 'eBay'
  const title = `History — ${channelLabel} ${marketplace}${productType ? ` · ${productType}` : ''}`

  return (
    <Modal open={open} onClose={onClose} title={title} size="xl">
      <div className="flex flex-col" style={{ minHeight: 480 }}>
        {/* Tab bar */}
        <div className="border-b border-default dark:border-slate-700 px-2 pt-1">
          <Tabs tabs={tabs} active={activeTab} onChange={setActiveTab} />
        </div>

        {/* Tab content */}
        <div className="flex-1 overflow-y-auto" style={{ maxHeight: 560 }}>
          {activeTab === 'pushes' && (
            channel === 'amazon'
              ? <AmazonPushesTab
                  onResubmitErroredSkus={onResubmitErroredSkus}
                  onGoToCell={onGoToCell ? (sku, columnId) => { onClose(); onGoToCell(sku, columnId) } : undefined}
                />
              : <EbayPushesTab onResubmitErroredSkus={onResubmitErroredSkus} />
          )}
          {activeTab === 'pulls' && (
            <PullsTab
              channel={channel}
              marketplace={marketplace}
              productType={productType}
              onRePull={onRePull}
              open={activeTab === 'pulls' && open}
            />
          )}
          {activeTab === 'versions' && showVersions && (
            <VersionsTab
              marketplace={marketplace}
              productType={productType ?? ''}
              currentRows={currentRows}
              onRestoreVersion={onRestoreVersion}
            />
          )}
        </div>
      </div>
    </Modal>
  )
}
