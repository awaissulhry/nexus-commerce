'use client'

import { useEffect, useRef, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  FileSpreadsheet,
  Loader2,
  Upload,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'

interface PreviewSummary {
  filename: string
  totalRows: number
  toUpdate: number
  errorRows: number
  totalChanges: number
  errors: Array<{
    row: number
    sku: string
    field?: string
    message: string
  }>
  sampleChanges: Array<{
    row: number
    sku: string
    field: string
    oldValue: unknown
    newValue: unknown
  }>
  warnings?: string[]
  expiresAt: string
}

interface UploadResponse {
  uploadId: string
  preview: PreviewSummary
}

interface ApplyResponse {
  applied: number
  total: number
  status: 'SUCCESS' | 'PARTIAL' | 'FAILED'
  errors: Array<{ chunkStart: number; error: string }>
  elapsedMs: number
}

type Stage = 'select' | 'uploading' | 'preview' | 'applying'

interface Props {
  open: boolean
  onClose: () => void
  /** Called after a successful apply. Parent should refetch the
   *  products list to reflect the changes. */
  onApplied: (result: ApplyResponse) => void
}

const PREVIEW_LIMIT = 8

function formatValue(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—'
  return String(v)
}

export default function UploadModal({ open, onClose, onApplied }: Props) {
  const [stage, setStage] = useState<Stage>('select')
  const [error, setError] = useState<string | null>(null)
  const [upload, setUpload] = useState<UploadResponse | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [isDragOver, setIsDragOver] = useState(false)

  // Reset on open/close so a previous upload doesn't linger.
  useEffect(() => {
    if (!open) {
      setStage('select')
      setError(null)
      setUpload(null)
      setIsDragOver(false)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && stage !== 'uploading' && stage !== 'applying') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, stage, onClose])

  if (!open) return null

  async function handleFile(file: File) {
    setError(null)
    const ext = file.name.toLowerCase().split('.').pop() ?? ''
    if (!['csv', 'xlsx', 'xls', 'tsv', 'zip'].includes(ext)) {
      setError(
        'Unsupported file type. Drop a .csv, .xlsx, .xls, or .zip file.',
      )
      return
    }
    setStage('uploading')
    const endpoint =
      ext === 'zip'
        ? `${getBackendUrl()}/api/products/bulk-upload-zip`
        : `${getBackendUrl()}/api/products/bulk-upload`
    const fd = new FormData()
    fd.append('file', file)
    try {
      const res = await fetch(endpoint, { method: 'POST', body: fd })
      const json = (await res.json()) as
        | UploadResponse
        | { error: string }
      if (!res.ok || 'error' in json) {
        const msg =
          ('error' in json && json.error) || `Upload failed (HTTP ${res.status})`
        setError(msg)
        setStage('select')
        return
      }
      setUpload(json as UploadResponse)
      setStage('preview')
    } catch (err: any) {
      setError(err?.message ?? String(err))
      setStage('select')
    }
  }

  async function handleApply() {
    if (!upload) return
    setStage('applying')
    setError(null)
    try {
      const res = await fetch(`${getBackendUrl()}/api/products/bulk-apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uploadId: upload.uploadId }),
      })
      const json = (await res.json()) as ApplyResponse | { error: string }
      if (!res.ok || 'error' in json) {
        const msg =
          ('error' in json && json.error) || `Apply failed (HTTP ${res.status})`
        setError(msg)
        setStage('preview')
        return
      }
      onApplied(json as ApplyResponse)
      onClose()
    } catch (err: any) {
      setError(err?.message ?? String(err))
      setStage('preview')
    }
  }

  const preview = upload?.preview
  const canApply = preview && preview.toUpdate > 0
  const templateBase = `${getBackendUrl()}/api/products/bulk-template`

  return (
    <div
      className="fixed inset-0 bg-slate-900/40 backdrop-blur-[1px] z-50 flex items-center justify-center p-6"
      onClick={() => {
        if (stage !== 'uploading' && stage !== 'applying') onClose()
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Upload products"
    >
      <div
        className="bg-white rounded-lg shadow-2xl border border-slate-200 w-full max-w-3xl max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3 border-b border-slate-200 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FileSpreadsheet className="w-4 h-4 text-slate-500" />
            <h2 className="text-lg font-semibold text-slate-900">
              Upload products
            </h2>
            {preview && (
              <span className="text-base text-slate-500 truncate max-w-[280px]">
                {preview.filename}
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={stage === 'uploading' || stage === 'applying'}
            className="text-slate-400 hover:text-slate-700 rounded p-1 hover:bg-slate-100 disabled:opacity-40"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {stage === 'select' && (
            <div className="space-y-4">
              <div
                onDragOver={(e) => {
                  e.preventDefault()
                  setIsDragOver(true)
                }}
                onDragLeave={() => setIsDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault()
                  setIsDragOver(false)
                  const f = e.dataTransfer.files[0]
                  if (f) handleFile(f)
                }}
                onClick={() => fileInputRef.current?.click()}
                className={cn(
                  'border-2 border-dashed rounded-lg p-10 text-center cursor-pointer transition-colors',
                  isDragOver
                    ? 'border-blue-400 bg-blue-50'
                    : 'border-slate-300 hover:border-slate-400 hover:bg-slate-50',
                )}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv,.xlsx,.xls,.tsv,.zip"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    if (f) handleFile(f)
                  }}
                />
                <Upload className="w-7 h-7 mx-auto text-slate-400 mb-3" />
                <div className="text-md font-medium text-slate-700">
                  Drop CSV, Excel, or ZIP file here
                </div>
                <div className="text-base text-slate-500 mt-0.5">
                  or click to browse
                </div>
                <div className="text-sm text-slate-400 mt-3">
                  Supported: .csv, .xlsx, .xls, .zip · Max 50 MB · 50,000 rows
                </div>
                <div className="text-sm text-slate-400 mt-1">
                  ZIP layout: <code className="font-mono">SKU/data.json</code> +{' '}
                  <code className="font-mono">SKU/description.html</code> per
                  product folder
                </div>
              </div>

              <div className="border border-slate-200 rounded-md px-4 py-3 bg-slate-50/50">
                <div className="text-base font-semibold text-slate-700 mb-1.5">
                  Need a template?
                </div>
                <div className="flex flex-col gap-1 text-base">
                  <a
                    href={`${templateBase}?view=full`}
                    className="text-blue-700 hover:text-blue-900 hover:underline"
                  >
                    ↓ Download CSV template — all editable fields
                  </a>
                  <a
                    href={`${templateBase}?view=pricing`}
                    className="text-blue-700 hover:text-blue-900 hover:underline"
                  >
                    ↓ Download CSV template — pricing focus
                  </a>
                  <a
                    href={`${templateBase}?view=inventory`}
                    className="text-blue-700 hover:text-blue-900 hover:underline"
                  >
                    ↓ Download CSV template — inventory focus
                  </a>
                  <a
                    href={`${templateBase}?view=physical`}
                    className="text-blue-700 hover:text-blue-900 hover:underline"
                  >
                    ↓ Download CSV template — physical / dimensions
                  </a>
                </div>
                <div className="text-sm text-slate-500 mt-2">
                  Templates include a sample row demonstrating the format
                  (e.g. <code className="bg-white px-1 rounded">5kg</code> for
                  weight, <code className="bg-white px-1 rounded">60cm</code>{' '}
                  for dimensions). Empty cells in your file mean "no change".
                </div>
              </div>

              {error && (
                <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-md text-base text-red-800">
                  <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                  <span>{error}</span>
                </div>
              )}
            </div>
          )}

          {stage === 'uploading' && (
            <div className="flex flex-col items-center justify-center py-10 gap-3 text-slate-600">
              <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
              <div className="text-md">Parsing and validating…</div>
            </div>
          )}

          {stage === 'preview' && preview && (
            <div className="space-y-3">
              <PreviewSummaryGrid preview={preview} />

              {preview.warnings && preview.warnings.length > 0 && (
                <div className="space-y-1">
                  {preview.warnings.map((w, i) => (
                    <div
                      key={i}
                      className="flex items-start gap-2 px-3 py-1.5 bg-amber-50 border border-amber-200 rounded-md text-base text-amber-900"
                    >
                      <AlertCircle className="w-3 h-3 flex-shrink-0 mt-0.5" />
                      <span>{w}</span>
                    </div>
                  ))}
                </div>
              )}

              {preview.errors.length > 0 && (
                <PreviewSection
                  title={`Errors (${preview.errorRows})`}
                  iconClass="text-amber-600"
                  rowClass="bg-amber-50/40 border-amber-200"
                >
                  {preview.errors.slice(0, PREVIEW_LIMIT).map((e, i) => (
                    <li
                      key={`${e.row}:${e.field ?? ''}:${i}`}
                      className="px-3 py-1.5 flex items-center gap-2 text-base"
                    >
                      <span className="text-slate-400 tabular-nums w-12">
                        Row {e.row}
                      </span>
                      <span className="font-mono text-slate-500 truncate max-w-[140px]">
                        {e.sku || '(no sku)'}
                      </span>
                      {e.field && (
                        <span className="text-slate-700">{e.field}:</span>
                      )}
                      <span className="text-amber-800">{e.message}</span>
                    </li>
                  ))}
                  {preview.errors.length > PREVIEW_LIMIT && (
                    <li className="px-3 py-1.5 text-sm text-slate-500 italic">
                      + {preview.errors.length - PREVIEW_LIMIT} more
                    </li>
                  )}
                </PreviewSection>
              )}

              {preview.sampleChanges.length > 0 && (
                <PreviewSection
                  title="Sample changes"
                  iconClass="text-slate-500"
                  rowClass="bg-slate-50/50 border-slate-200"
                >
                  {preview.sampleChanges
                    .slice(0, PREVIEW_LIMIT)
                    .map((c, i) => (
                      <li
                        key={`${c.row}:${c.field}:${i}`}
                        className="px-3 py-1.5 flex items-center gap-2 text-base"
                      >
                        <span className="text-slate-400 tabular-nums w-12">
                          Row {c.row}
                        </span>
                        <span className="font-mono text-slate-500 truncate max-w-[140px]">
                          {c.sku}
                        </span>
                        <span className="text-slate-700">{c.field}:</span>
                        <span className="text-slate-400 line-through tabular-nums">
                          {formatValue(c.oldValue)}
                        </span>
                        <span className="text-slate-400">→</span>
                        <span className="bg-yellow-100 text-yellow-900 px-1.5 py-0.5 rounded tabular-nums">
                          {formatValue(c.newValue)}
                        </span>
                      </li>
                    ))}
                  {preview.totalChanges > preview.sampleChanges.length && (
                    <li className="px-3 py-1.5 text-sm text-slate-500 italic">
                      + {preview.totalChanges - preview.sampleChanges.length}{' '}
                      more changes across {preview.toUpdate} rows
                    </li>
                  )}
                </PreviewSection>
              )}

              {error && (
                <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-md text-base text-red-800">
                  <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                  <span>{error}</span>
                </div>
              )}
            </div>
          )}

          {stage === 'applying' && (
            <div className="flex flex-col items-center justify-center py-10 gap-3 text-slate-600">
              <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
              <div className="text-md">
                Applying {preview?.totalChanges ?? 0} change
                {preview?.totalChanges === 1 ? '' : 's'}…
              </div>
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-slate-200 flex items-center justify-end gap-2">
          {stage === 'preview' && (
            <>
              <Button variant="secondary" size="sm" onClick={onClose}>
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={handleApply}
                disabled={!canApply}
              >
                Apply {preview?.totalChanges ?? 0} change
                {preview?.totalChanges === 1 ? '' : 's'}
              </Button>
            </>
          )}
          {stage === 'select' && (
            <Button variant="secondary" size="sm" onClick={onClose}>
              Cancel
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

function PreviewSummaryGrid({ preview }: { preview: PreviewSummary }) {
  const cells: Array<{ label: string; value: string; tone: string }> = [
    {
      label: 'Total rows',
      value: preview.totalRows.toLocaleString(),
      tone: 'text-slate-700',
    },
    {
      label: 'Will update',
      value: preview.toUpdate.toLocaleString(),
      tone: 'text-emerald-700',
    },
    {
      label: 'Total changes',
      value: preview.totalChanges.toLocaleString(),
      tone: 'text-blue-700',
    },
    {
      label: 'Error rows',
      value: preview.errorRows.toLocaleString(),
      tone:
        preview.errorRows > 0 ? 'text-amber-700' : 'text-slate-500',
    },
  ]
  return (
    <div className="grid grid-cols-4 gap-2">
      {cells.map((c) => (
        <div
          key={c.label}
          className="border border-slate-200 rounded-md px-3 py-2 bg-white"
        >
          <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
            {c.label}
          </div>
          <div className={cn('text-2xl font-semibold tabular-nums mt-0.5', c.tone)}>
            {c.value}
          </div>
        </div>
      ))}
    </div>
  )
}

function PreviewSection({
  title,
  iconClass,
  rowClass,
  children,
}: {
  title: string
  iconClass: string
  rowClass: string
  children: React.ReactNode
}) {
  const Icon = title.startsWith('Errors') ? AlertCircle : CheckCircle2
  return (
    <div>
      <div className="text-sm font-semibold text-slate-500 uppercase tracking-wider mb-1.5 flex items-center gap-1.5">
        <Icon className={cn('w-3 h-3', iconClass)} />
        {title}
      </div>
      <ul className={cn('divide-y divide-slate-100 border rounded-md', rowClass)}>
        {children}
      </ul>
    </div>
  )
}
