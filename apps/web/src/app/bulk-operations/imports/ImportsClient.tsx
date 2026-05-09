'use client'

/**
 * W8.3 — Import wizard UI.
 *
 * Two surfaces:
 *
 *   - Wizard (top): file picker → mapping confirmation → preview
 *     stats → Apply / Cancel. Replaces the legacy UploadModal which
 *     ran a 53% production failure rate with no per-row visibility.
 *   - History (bottom): list of recent ImportJob rows with status,
 *     row-counts, and actions (View rows, Retry failed, Rollback).
 *
 * Browser-side file reading: CSV / JSON go via FileReader.readAsText;
 * XLSX goes via readAsArrayBuffer + base64 encode. The preview
 * endpoint takes either `text` or `bytesBase64`.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  FileSpreadsheet,
  History as HistoryIcon,
  Loader2,
  Play,
  RefreshCw,
  RotateCcw,
  Table2,
  Upload,
  X,
} from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { useConfirm } from '@/components/ui/ConfirmProvider'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'

type Stage = 'idle' | 'uploading' | 'review' | 'applying' | 'done'

interface ImportJob {
  id: string
  jobName: string
  source: string
  filename: string | null
  fileKind: string
  targetEntity: string
  columnMapping: Record<string, string>
  onError: string
  status: string
  totalRows: number
  successRows: number
  failedRows: number
  skippedRows: number
  createdAt: string
  completedAt: string | null
  parentJobId: string | null
}

interface ImportRow {
  id: string
  rowIndex: number
  status: string
  errorMessage: string | null
  parsedValues: Record<string, unknown>
}

interface PreviewResponse {
  job: ImportJob
  headers: string[]
  mapping: Record<string, string>
  unmappedHeaders: string[]
  unmappedFields: string[]
}

const PRODUCT_FIELDS = [
  { id: 'sku', label: 'SKU', required: true },
  { id: 'name', label: 'Name' },
  { id: 'brand', label: 'Brand' },
  { id: 'description', label: 'Description' },
  { id: 'basePrice', label: 'Base price' },
  { id: 'costPrice', label: 'Cost price' },
  { id: 'minPrice', label: 'Min price' },
  { id: 'maxPrice', label: 'Max price' },
  { id: 'totalStock', label: 'Total stock' },
  { id: 'lowStockThreshold', label: 'Low stock threshold' },
  { id: 'status', label: 'Status' },
  { id: 'productType', label: 'Product type' },
  { id: 'hsCode', label: 'HS code' },
  { id: 'countryOfOrigin', label: 'Country of origin' },
]

function detectKind(filename: string): 'csv' | 'xlsx' | 'json' {
  const lo = filename.toLowerCase()
  if (lo.endsWith('.xlsx') || lo.endsWith('.xls')) return 'xlsx'
  if (lo.endsWith('.json')) return 'json'
  return 'csv'
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = ''
  const bytes = new Uint8Array(buffer)
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return typeof window !== 'undefined' ? window.btoa(binary) : ''
}

function statusBadge(status: string) {
  if (status === 'COMPLETED') return <Badge variant="success" size="sm">Completed</Badge>
  if (status === 'FAILED') return <Badge variant="danger" size="sm">Failed</Badge>
  if (status === 'PARTIAL') return <Badge variant="warning" size="sm">Partial</Badge>
  if (status === 'APPLYING') return <Badge variant="info" size="sm">Applying</Badge>
  if (status === 'PENDING_PREVIEW') return <Badge variant="default" size="sm">Preview</Badge>
  if (status === 'CANCELLED') return <Badge variant="default" size="sm">Cancelled</Badge>
  return <Badge variant="default" size="sm">{status}</Badge>
}

export default function ImportsClient() {
  const confirm = useConfirm()
  const [stage, setStage] = useState<Stage>('idle')
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<PreviewResponse | null>(null)
  const [mapping, setMapping] = useState<Record<string, string>>({})
  const [onError, setOnErrorMode] = useState<'skip' | 'abort'>('skip')

  const [jobs, setJobs] = useState<ImportJob[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [drillJob, setDrillJob] = useState<ImportJob | null>(null)
  const [drillRows, setDrillRows] = useState<ImportRow[]>([])
  const [drillLoading, setDrillLoading] = useState(false)
  const [drillFilter, setDrillFilter] = useState<string>('all')

  const fetchJobs = useCallback(async () => {
    setHistoryLoading(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/import-jobs?limit=100`, {
        cache: 'no-store',
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const j = await res.json()
      setJobs(Array.isArray(j.jobs) ? j.jobs : [])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setHistoryLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchJobs()
  }, [fetchJobs])

  const fetchRows = useCallback(async (jobId: string, status?: string) => {
    setDrillLoading(true)
    try {
      const url = status && status !== 'all'
        ? `${getBackendUrl()}/api/import-jobs/${jobId}/rows?status=${status}&limit=200`
        : `${getBackendUrl()}/api/import-jobs/${jobId}/rows?limit=200`
      const res = await fetch(url, { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const j = await res.json()
      setDrillRows(Array.isArray(j.rows) ? j.rows : [])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setDrillLoading(false)
    }
  }, [])

  const handleFile = async (file: File) => {
    setStage('uploading')
    setError(null)
    setPreview(null)
    try {
      const kind = detectKind(file.name)
      const body: Record<string, unknown> = {
        jobName: file.name.replace(/\.[^.]+$/, ''),
        filename: file.name,
        fileKind: kind,
        targetEntity: 'product',
        onError,
      }
      if (kind === 'xlsx') {
        const ab = await file.arrayBuffer()
        body.bytesBase64 = arrayBufferToBase64(ab)
      } else {
        body.text = await file.text()
      }
      const res = await fetch(
        `${getBackendUrl()}/api/import-jobs/preview`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      )
      const j = await res.json()
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`)
      setPreview({
        job: j.job,
        headers: j.headers ?? [],
        mapping: j.mapping ?? {},
        unmappedHeaders: j.unmappedHeaders ?? [],
        unmappedFields: j.unmappedFields ?? [],
      })
      setMapping(j.mapping ?? {})
      setStage('review')
      fetchJobs()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setStage('idle')
    }
  }

  const cancelImport = () => {
    setPreview(null)
    setMapping({})
    setStage('idle')
  }

  const apply = async () => {
    if (!preview) return
    setStage('applying')
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/import-jobs/${preview.job.id}/apply`,
        { method: 'POST' },
      )
      const j = await res.json()
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`)
      setPreview((prev) =>
        prev
          ? {
              ...prev,
              job: {
                ...prev.job,
                status: j.status,
                successRows: j.successRows,
                failedRows: j.failedRows,
                skippedRows: j.skippedRows,
              },
            }
          : prev,
      )
      setStage('done')
      fetchJobs()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setStage('review')
    }
  }

  const retryFailed = async (job: ImportJob) => {
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/import-jobs/${job.id}/retry-failed`,
        { method: 'POST' },
      )
      const j = await res.json()
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`)
      // Forked job lands in PENDING_PREVIEW — load it as the new
      // preview so the operator confirms before re-applying.
      const previewRes = await fetch(
        `${getBackendUrl()}/api/import-jobs/${j.job.id}`,
        { cache: 'no-store' },
      )
      const previewJson = await previewRes.json()
      setPreview({
        job: previewJson.job,
        headers: [],
        mapping: previewJson.job.columnMapping ?? {},
        unmappedHeaders: [],
        unmappedFields: [],
      })
      setMapping(previewJson.job.columnMapping ?? {})
      setStage('review')
      fetchJobs()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const rollback = async (job: ImportJob) => {
    const ok = await confirm({
      title: `Rollback "${job.jobName}"?`,
      description: `Re-applies the beforeState of every SUCCESS row. Creates a child rollback job linked via parentJobId for audit. ${job.successRows} rows will be reverted.`,
      confirmLabel: 'Roll back',
      tone: 'danger',
    })
    if (!ok) return
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/import-jobs/${job.id}/rollback`,
        { method: 'POST' },
      )
      const j = await res.json()
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`)
      fetchJobs()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const drillCounts = useMemo(() => {
    if (!drillJob) return null
    return {
      total: drillJob.totalRows,
      success: drillJob.successRows,
      failed: drillJob.failedRows,
      skipped: drillJob.skippedRows,
    }
  }, [drillJob])

  return (
    <div className="px-3 md:px-6 space-y-4">
      {error && (
        <div className="text-base text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded px-3 py-2 inline-flex items-start gap-2">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
          <div>{error}</div>
        </div>
      )}

      {/* Wizard */}
      {stage === 'idle' && (
        <div className="bg-white dark:bg-slate-900 border border-dashed border-slate-300 dark:border-slate-700 rounded-lg p-6">
          <div className="flex items-center gap-3 mb-3">
            <Upload className="w-5 h-5 text-slate-400" />
            <div className="flex-1">
              <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">
                Import to /products
              </h2>
              <p className="text-sm text-slate-500">
                CSV, Excel (.xlsx), or JSON. Auto-mapped columns confirmable
                before apply. Per-row results so failures never go silent.
              </p>
            </div>
            <select
              value={onError}
              onChange={(e) => setOnErrorMode(e.target.value as 'skip' | 'abort')}
              className="h-7 px-1.5 text-xs border border-slate-200 dark:border-slate-700 dark:bg-slate-900 rounded"
              title="What to do when a row fails validation"
            >
              <option value="skip">On error: skip failed</option>
              <option value="abort">On error: abort apply</option>
            </select>
            <label className="cursor-pointer">
              <input
                type="file"
                accept=".csv,.xlsx,.xls,.json"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) handleFile(file)
                  e.target.value = ''
                }}
              />
              <span className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-blue-600 text-white rounded hover:bg-blue-700 cursor-pointer">
                <FileSpreadsheet className="w-3.5 h-3.5" />
                Choose file
              </span>
            </label>
          </div>
        </div>
      )}

      {stage === 'uploading' && (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-6 inline-flex items-center gap-2 text-sm text-slate-600">
          <Loader2 className="w-4 h-4 animate-spin" />
          Parsing + auto-mapping…
        </div>
      )}

      {(stage === 'review' || stage === 'applying' || stage === 'done') && preview && (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-base font-semibold text-slate-800 dark:text-slate-100">
                {preview.job.jobName}
              </div>
              <div className="text-xs text-slate-500">
                {preview.job.fileKind.toUpperCase()} ·{' '}
                {preview.job.totalRows.toLocaleString()} rows · target ={' '}
                {preview.job.targetEntity}
                {preview.job.parentJobId && ' · retry-of-failed'}
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              {statusBadge(preview.job.status)}
              {stage !== 'done' && (
                <button
                  type="button"
                  onClick={cancelImport}
                  className="h-7 w-7 inline-flex items-center justify-center text-slate-500 hover:text-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800 rounded"
                  aria-label="Cancel"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>

          {/* Mapping table */}
          {preview.headers.length > 0 && (
            <details className="border border-slate-200 dark:border-slate-800 rounded p-2" open={stage === 'review'}>
              <summary className="cursor-pointer text-sm font-medium text-slate-700 dark:text-slate-300 inline-flex items-center gap-1.5">
                <Table2 className="w-3.5 h-3.5" />
                Column mapping ({Object.keys(mapping).length} mapped /{' '}
                {preview.headers.length} columns)
              </summary>
              <div className="mt-2 grid grid-cols-2 gap-1.5 text-xs">
                {PRODUCT_FIELDS.map((f) => (
                  <div key={f.id} className="flex items-center gap-1.5">
                    <span className={cn(
                      'min-w-[120px] font-medium',
                      f.required ? 'text-slate-800 dark:text-slate-200' : 'text-slate-600 dark:text-slate-400',
                    )}>
                      {f.label}
                      {f.required && <span className="text-red-600 ml-0.5">*</span>}
                    </span>
                    <ChevronRight className="w-3 h-3 text-slate-400" />
                    <select
                      value={mapping[f.id] ?? ''}
                      onChange={(e) =>
                        setMapping({ ...mapping, [f.id]: e.target.value })
                      }
                      disabled={stage !== 'review'}
                      className="flex-1 h-6 px-1 text-xs border border-slate-200 dark:border-slate-700 dark:bg-slate-900 rounded"
                    >
                      <option value="">(skip)</option>
                      {preview.headers.map((h) => (
                        <option key={h} value={h}>
                          {h}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
              {preview.unmappedHeaders.length > 0 && (
                <div className="mt-2 text-xs text-slate-500">
                  Unmapped columns: {preview.unmappedHeaders.join(', ')}
                </div>
              )}
            </details>
          )}

          {/* Stats */}
          <div className="grid grid-cols-4 gap-2 text-center">
            <div className="bg-slate-50 dark:bg-slate-800/40 rounded px-2 py-1.5">
              <div className="text-base font-semibold tabular-nums text-slate-700 dark:text-slate-200">
                {preview.job.totalRows.toLocaleString()}
              </div>
              <div className="text-[10px] uppercase tracking-wide text-slate-500">Total</div>
            </div>
            <div className="bg-emerald-50 dark:bg-emerald-950/30 rounded px-2 py-1.5">
              <div className="text-base font-semibold tabular-nums text-emerald-700 dark:text-emerald-300">
                {preview.job.successRows.toLocaleString()}
              </div>
              <div className="text-[10px] uppercase tracking-wide text-emerald-600/80">Success</div>
            </div>
            <div className="bg-red-50 dark:bg-red-950/30 rounded px-2 py-1.5">
              <div className="text-base font-semibold tabular-nums text-red-700 dark:text-red-300">
                {preview.job.failedRows.toLocaleString()}
              </div>
              <div className="text-[10px] uppercase tracking-wide text-red-600/80">Failed</div>
            </div>
            <div className="bg-slate-50 dark:bg-slate-800/40 rounded px-2 py-1.5">
              <div className="text-base font-semibold tabular-nums text-slate-700 dark:text-slate-200">
                {preview.job.skippedRows.toLocaleString()}
              </div>
              <div className="text-[10px] uppercase tracking-wide text-slate-500">Skipped</div>
            </div>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-end gap-2">
            {stage === 'review' && (
              <>
                <Button variant="secondary" size="sm" onClick={cancelImport}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={apply}
                  disabled={preview.job.totalRows === 0}
                >
                  <Play className="w-3 h-3 mr-1" />
                  Apply {preview.job.totalRows.toLocaleString()} rows
                </Button>
              </>
            )}
            {stage === 'applying' && (
              <Button variant="primary" size="sm" disabled loading>
                Applying…
              </Button>
            )}
            {stage === 'done' && (
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => fetchRows(preview.job.id)}
                >
                  <Table2 className="w-3 h-3 mr-1" />
                  View per-row results
                </Button>
                <Button variant="primary" size="sm" onClick={cancelImport}>
                  Done
                </Button>
              </>
            )}
          </div>
        </div>
      )}

      {/* History */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
        <div className="px-3 py-2 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <div className="text-sm font-semibold text-slate-700 dark:text-slate-300 inline-flex items-center gap-1.5">
            <HistoryIcon className="w-3.5 h-3.5" />
            Recent imports
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={fetchJobs}
            disabled={historyLoading}
          >
            <RefreshCw className="w-3 h-3 mr-1" />
            Reload
          </Button>
        </div>
        {jobs.length === 0 ? (
          <div className="px-3 py-6 text-center text-sm text-slate-500">
            No imports yet. Choose a file above to get started.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 dark:bg-slate-800/60 text-xs text-slate-500 dark:text-slate-400 uppercase tracking-wide">
              <tr>
                <th className="text-left px-3 py-2 font-medium">Name</th>
                <th className="text-left px-3 py-2 font-medium">File</th>
                <th className="text-right px-3 py-2 font-medium">Rows</th>
                <th className="text-right px-3 py-2 font-medium">Success</th>
                <th className="text-right px-3 py-2 font-medium">Failed</th>
                <th className="text-left px-3 py-2 font-medium">Status</th>
                <th className="text-left px-3 py-2 font-medium">When</th>
                <th className="text-right px-3 py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {jobs.map((j) => (
                <tr key={j.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                  <td className="px-3 py-2 max-w-[260px] truncate font-medium text-slate-800 dark:text-slate-200">
                    {j.jobName}
                    {j.parentJobId && (
                      <span className="ml-1 text-[10px] text-slate-400 font-normal">
                        (retry)
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-500 truncate max-w-[160px]">
                    {j.filename ?? j.source}
                    <span className="ml-1 text-slate-400">{j.fileKind}</span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{j.totalRows}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                    {j.successRows}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-red-600 dark:text-red-400">
                    {j.failedRows}
                  </td>
                  <td className="px-3 py-2">{statusBadge(j.status)}</td>
                  <td className="px-3 py-2 text-xs text-slate-500 tabular-nums">
                    {new Date(j.createdAt).toLocaleString()}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="inline-flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => {
                          setDrillJob(j)
                          setDrillFilter('all')
                          fetchRows(j.id)
                        }}
                        title="View per-row results"
                        className="h-6 w-6 inline-flex items-center justify-center text-slate-500 hover:text-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800 rounded"
                      >
                        <Table2 className="w-3 h-3" />
                      </button>
                      {j.failedRows > 0 && j.status !== 'PENDING_PREVIEW' && (
                        <button
                          type="button"
                          onClick={() => retryFailed(j)}
                          title="Retry failed rows"
                          className="h-6 w-6 inline-flex items-center justify-center text-slate-500 hover:text-blue-700 hover:bg-blue-50 dark:hover:bg-blue-950/30 rounded"
                        >
                          <RefreshCw className="w-3 h-3" />
                        </button>
                      )}
                      {j.successRows > 0 &&
                        j.status !== 'PENDING_PREVIEW' &&
                        j.status !== 'APPLYING' && (
                          <button
                            type="button"
                            onClick={() => rollback(j)}
                            title="Rollback"
                            className="h-6 w-6 inline-flex items-center justify-center text-slate-500 hover:text-amber-700 hover:bg-amber-50 dark:hover:bg-amber-950/30 rounded"
                          >
                            <RotateCcw className="w-3 h-3" />
                          </button>
                        )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Drill-in panel */}
      {drillJob && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm p-4"
          onClick={() => setDrillJob(null)}
        >
          <div
            className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg shadow-2xl w-full max-w-3xl max-h-[80vh] flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
              <div>
                <div className="text-base font-semibold text-slate-800 dark:text-slate-100">
                  {drillJob.jobName}
                </div>
                {drillCounts && (
                  <div className="text-xs text-slate-500">
                    {drillCounts.total} rows · {drillCounts.success} success ·{' '}
                    {drillCounts.failed} failed · {drillCounts.skipped} skipped
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => setDrillJob(null)}
                className="h-7 w-7 inline-flex items-center justify-center text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 rounded"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="px-3 py-2 border-b border-slate-200 dark:border-slate-700 flex items-center gap-2">
              {(['all', 'SUCCESS', 'FAILED', 'SKIPPED'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => {
                    setDrillFilter(s)
                    fetchRows(drillJob.id, s)
                  }}
                  className={cn(
                    'h-6 px-2 text-xs font-medium rounded',
                    drillFilter === s
                      ? 'bg-blue-100 text-blue-800 dark:bg-blue-950/40 dark:text-blue-300'
                      : 'text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800',
                  )}
                >
                  {s === 'all' ? 'All' : s}
                </button>
              ))}
            </div>
            <div className="flex-1 overflow-auto">
              {drillLoading ? (
                <div className="p-6 text-center text-sm text-slate-500 inline-flex items-center gap-1.5">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Loading…
                </div>
              ) : drillRows.length === 0 ? (
                <div className="p-6 text-center text-sm text-slate-500">
                  No rows in this filter.
                </div>
              ) : (
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 dark:bg-slate-800/60 text-[10px] uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="text-left px-3 py-1.5 font-medium">#</th>
                      <th className="text-left px-3 py-1.5 font-medium">Status</th>
                      <th className="text-left px-3 py-1.5 font-medium">SKU / Values</th>
                      <th className="text-left px-3 py-1.5 font-medium">Error</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {drillRows.map((r) => (
                      <tr
                        key={r.id}
                        className={cn(
                          'hover:bg-slate-50 dark:hover:bg-slate-800/40',
                          r.status === 'FAILED' &&
                            'bg-red-50/40 dark:bg-red-950/20',
                          r.status === 'SUCCESS' &&
                            'bg-emerald-50/30 dark:bg-emerald-950/15',
                        )}
                      >
                        <td className="px-3 py-1.5 tabular-nums">{r.rowIndex}</td>
                        <td className="px-3 py-1.5">
                          {r.status === 'SUCCESS' && (
                            <CheckCircle2 className="w-3 h-3 inline text-emerald-600" />
                          )}
                          {r.status === 'FAILED' && (
                            <AlertTriangle className="w-3 h-3 inline text-red-600" />
                          )}
                          {r.status === 'SKIPPED' && '—'}
                          <span className="ml-1 text-[10px]">{r.status}</span>
                        </td>
                        <td className="px-3 py-1.5 font-mono text-[10px] truncate max-w-[260px]">
                          {String(r.parsedValues?.sku ?? '')}
                        </td>
                        <td className="px-3 py-1.5 text-[10px] text-red-600 dark:text-red-400 truncate max-w-[300px]">
                          {r.errorMessage ?? ''}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
