'use client'

/**
 * W9.3 — Export wizard UI.
 *
 * Top-half builder + bottom-half history. Builder lets the operator
 * pick name / format / target entity / columns / filter scope and
 * fire an export. History lists recent ExportJob rows with download
 * links + delete affordance.
 */

import { useCallback, useEffect, useState } from 'react'
import {
  AlertTriangle,
  Download,
  FileSpreadsheet,
  History as HistoryIcon,
  Play,
  RefreshCw,
  Trash2,
} from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { useConfirm } from '@/components/ui/ConfirmProvider'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'

type Format = 'csv' | 'xlsx' | 'json' | 'pdf'

interface ExportJob {
  id: string
  jobName: string
  format: string
  targetEntity: string
  status: string
  rowCount: number
  bytes: number
  errorMessage: string | null
  createdAt: string
  completedAt: string | null
}

interface ColumnSpec {
  id: string
  label: string
  format?: 'currency' | 'date' | 'number' | 'text'
}

const PRODUCT_COLUMNS: ColumnSpec[] = [
  { id: 'sku', label: 'SKU' },
  { id: 'name', label: 'Name' },
  { id: 'brand', label: 'Brand' },
  { id: 'productType', label: 'Type' },
  { id: 'status', label: 'Status' },
  { id: 'basePrice', label: 'Base price', format: 'currency' },
  { id: 'costPrice', label: 'Cost price', format: 'currency' },
  { id: 'totalStock', label: 'Stock', format: 'number' },
  { id: 'lowStockThreshold', label: 'Low-stock thresh', format: 'number' },
  { id: 'amazonAsin', label: 'ASIN' },
  { id: 'ean', label: 'EAN' },
  { id: 'upc', label: 'UPC' },
  { id: 'createdAt', label: 'Created', format: 'date' },
  { id: 'updatedAt', label: 'Updated', format: 'date' },
]

const FORMAT_LABELS: Record<Format, string> = {
  csv: 'CSV',
  xlsx: 'Excel (XLSX)',
  json: 'JSON',
  pdf: 'PDF',
}

function statusBadge(status: string) {
  if (status === 'COMPLETED') return <Badge variant="success" size="sm">Completed</Badge>
  if (status === 'FAILED') return <Badge variant="danger" size="sm">Failed</Badge>
  if (status === 'RUNNING') return <Badge variant="info" size="sm">Running</Badge>
  if (status === 'PENDING') return <Badge variant="default" size="sm">Pending</Badge>
  return <Badge variant="default" size="sm">{status}</Badge>
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} kB`
  return `${(b / 1024 / 1024).toFixed(1)} MB`
}

export default function ExportsClient() {
  const confirm = useConfirm()
  const [jobs, setJobs] = useState<ExportJob[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Builder state
  const [jobName, setJobName] = useState<string>(
    `Export ${new Date().toISOString().slice(0, 10)}`,
  )
  const [format, setFormat] = useState<Format>('csv')
  const [pickedColumns, setPickedColumns] = useState<string[]>(
    PRODUCT_COLUMNS.slice(0, 8).map((c) => c.id),
  )
  const [statusFilter, setStatusFilter] = useState<string>('')
  const [brandFilter, setBrandFilter] = useState<string>('')
  const [running, setRunning] = useState(false)

  const fetchJobs = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/export-jobs?limit=100`, {
        cache: 'no-store',
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const j = await res.json()
      setJobs(Array.isArray(j.jobs) ? j.jobs : [])
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchJobs()
  }, [fetchJobs])

  const toggleColumn = (id: string) => {
    setPickedColumns((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    )
  }

  const runExport = async () => {
    if (pickedColumns.length === 0) {
      setError('Pick at least one column')
      return
    }
    setRunning(true)
    setError(null)
    try {
      const filters: Record<string, unknown> = {}
      if (statusFilter) filters.status = statusFilter
      if (brandFilter) filters.brand = brandFilter
      const columns = pickedColumns
        .map((id) => PRODUCT_COLUMNS.find((c) => c.id === id))
        .filter((c): c is ColumnSpec => !!c)
      const res = await fetch(`${getBackendUrl()}/api/export-jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobName,
          format,
          targetEntity: 'product',
          columns,
          filters: Object.keys(filters).length > 0 ? filters : null,
        }),
      })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`)
      // Auto-download once the job is COMPLETED. Server runs the
      // export inline so the response carries the terminal status.
      if (j.job?.id && j.job?.status === 'COMPLETED') {
        window.location.href = `${getBackendUrl()}/api/export-jobs/${j.job.id}/download`
      }
      fetchJobs()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
    }
  }

  const deleteJob = async (job: ExportJob) => {
    const ok = await confirm({
      title: `Delete export "${job.jobName}"?`,
      description: 'The artifact and its row are removed permanently.',
      confirmLabel: 'Delete',
      tone: 'danger',
    })
    if (!ok) return
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/export-jobs/${job.id}`,
        { method: 'DELETE' },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      fetchJobs()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="px-3 md:px-6 space-y-4">
      {error && (
        <div className="text-base text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded px-3 py-2 inline-flex items-start gap-2">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
          <div>{error}</div>
        </div>
      )}

      {/* Builder */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-4 space-y-3">
        <div className="flex items-center gap-3">
          <FileSpreadsheet className="w-5 h-5 text-slate-400 dark:text-slate-500" />
          <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100 flex-1">
            New export
          </h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
          <label className="block">
            <span className="text-xs font-medium text-slate-600 dark:text-slate-300 mb-0.5 block">
              Name
            </span>
            <input
              type="text"
              value={jobName}
              onChange={(e) => setJobName(e.target.value)}
              className="w-full h-8 px-2 text-sm border border-slate-200 dark:border-slate-700 dark:bg-slate-900 rounded outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-slate-600 dark:text-slate-300 mb-0.5 block">
              Format
            </span>
            <select
              value={format}
              onChange={(e) => setFormat(e.target.value as Format)}
              className="w-full h-8 px-2 text-sm border border-slate-200 dark:border-slate-700 dark:bg-slate-900 rounded"
            >
              {(Object.keys(FORMAT_LABELS) as Format[]).map((f) => (
                <option key={f} value={f}>
                  {FORMAT_LABELS[f]}
                </option>
              ))}
            </select>
          </label>
          <div className="block">
            <span className="text-xs font-medium text-slate-600 dark:text-slate-300 mb-0.5 block">
              Filters (Status / Brand)
            </span>
            <div className="flex gap-1">
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="flex-1 h-8 px-2 text-sm border border-slate-200 dark:border-slate-700 dark:bg-slate-900 rounded"
              >
                <option value="">All</option>
                <option value="ACTIVE">ACTIVE</option>
                <option value="DRAFT">DRAFT</option>
                <option value="INACTIVE">INACTIVE</option>
              </select>
              <input
                type="text"
                value={brandFilter}
                onChange={(e) => setBrandFilter(e.target.value)}
                placeholder="brand"
                className="flex-1 h-8 px-2 text-sm border border-slate-200 dark:border-slate-700 dark:bg-slate-900 rounded outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
              />
            </div>
          </div>
        </div>

        <div className="border border-slate-200 dark:border-slate-800 rounded p-2">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-1.5">
            Columns ({pickedColumns.length} / {PRODUCT_COLUMNS.length})
          </div>
          <div className="flex flex-wrap gap-1">
            {PRODUCT_COLUMNS.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => toggleColumn(c.id)}
                className={cn(
                  'h-6 px-2 text-xs font-medium border rounded inline-flex items-center gap-1',
                  pickedColumns.includes(c.id)
                    ? 'bg-blue-50 border-blue-300 text-blue-700 dark:bg-blue-950/40 dark:border-blue-800 dark:text-blue-300'
                    : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800',
                )}
              >
                {pickedColumns.includes(c.id) && (
                  <span className="text-blue-500 dark:text-blue-400">✓</span>
                )}
                {c.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-end gap-2">
          <Button
            variant="primary"
            size="sm"
            onClick={runExport}
            disabled={running || pickedColumns.length === 0 || !jobName.trim()}
            loading={running}
          >
            <Play className="w-3 h-3 mr-1" />
            Run export
          </Button>
        </div>
      </div>

      {/* History */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
        <div className="px-3 py-2 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <div className="text-sm font-semibold text-slate-700 dark:text-slate-300 inline-flex items-center gap-1.5">
            <HistoryIcon className="w-3.5 h-3.5" />
            Recent exports
          </div>
          <Button variant="secondary" size="sm" onClick={fetchJobs} disabled={loading}>
            <RefreshCw className="w-3 h-3 mr-1" />
            Reload
          </Button>
        </div>
        {jobs.length === 0 ? (
          <div className="px-3 py-6 text-center text-sm text-slate-500 dark:text-slate-400">
            No exports yet. Pick columns above and hit Run export.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 dark:bg-slate-800/60 text-xs text-slate-500 dark:text-slate-400 uppercase tracking-wide">
              <tr>
                <th className="text-left px-3 py-2 font-medium">Name</th>
                <th className="text-left px-3 py-2 font-medium">Format</th>
                <th className="text-right px-3 py-2 font-medium">Rows</th>
                <th className="text-right px-3 py-2 font-medium">Size</th>
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
                    {j.errorMessage && (
                      <div
                        className="text-[10px] text-red-600 dark:text-red-400 truncate max-w-[260px]"
                        title={j.errorMessage}
                      >
                        {j.errorMessage}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs uppercase font-mono text-slate-500 dark:text-slate-400">
                    {j.format}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {j.rowCount.toLocaleString()}
                  </td>
                  <td className="px-3 py-2 text-right text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                    {j.bytes > 0 ? formatBytes(j.bytes) : '—'}
                  </td>
                  <td className="px-3 py-2">{statusBadge(j.status)}</td>
                  <td className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                    {new Date(j.createdAt).toLocaleString()}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="inline-flex items-center gap-1">
                      {j.status === 'COMPLETED' && (
                        <a
                          href={`${getBackendUrl()}/api/export-jobs/${j.id}/download`}
                          title="Download"
                          className="h-6 w-6 inline-flex items-center justify-center text-slate-500 hover:text-blue-700 hover:bg-blue-50 dark:hover:bg-blue-950/30 rounded"
                        >
                          <Download className="w-3 h-3" />
                        </a>
                      )}
                      <button
                        type="button"
                        onClick={() => deleteJob(j)}
                        title="Delete"
                        className="h-6 w-6 inline-flex items-center justify-center text-slate-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30 rounded"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
