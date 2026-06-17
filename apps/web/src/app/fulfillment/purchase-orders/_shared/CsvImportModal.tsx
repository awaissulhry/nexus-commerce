'use client'

// PO.15 — CSV import modal for /fulfillment/purchase-orders.
//
// Three-step flow:
//   1. paste OR drop a .csv file
//   2. preview parsed groups → see validation errors per row
//   3. confirm → server creates POs and reports created vs failed
//
// Format matches the export endpoint. Groups by `groupKey` column.
// Required columns: groupKey, sku, quantityOrdered.

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  Download,
  FileText,
  Loader2,
  Upload,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'

interface ImportLine {
  sku: string
  supplierSku?: string
  quantityOrdered: number
  unitCostCents: number
  lineNote?: string
  error?: string
}

interface ImportGroup {
  groupKey: string
  supplierName: string | null
  supplierId: string | null
  warehouseCode: string | null
  expectedDeliveryDate: string | null
  currencyCode: string
  lines: ImportLine[]
  groupErrors: string[]
}

interface PreviewResult {
  groups: ImportGroup[]
  totalRows: number
  rejectedRows: number
}

interface CommitResult {
  created: Array<{ id: string; poNumber: string }>
  failed: Array<{ groupKey: string; error: string }>
  totalGroups: number
}

const SAMPLE_CSV = `groupKey,supplierName,warehouseCode,expectedDeliveryDate,currencyCode,sku,quantityOrdered,unitCostCents,lineNote
PO-IMPORT-1,Acme Fabrics,DEFAULT,2026-06-15,EUR,XAV-001,50,1200,Lot 7
PO-IMPORT-1,Acme Fabrics,DEFAULT,2026-06-15,EUR,XAV-002,30,1500,
PO-IMPORT-2,Guangzhou Helmets,DEFAULT,2026-07-01,USD,XAV-HELM-A1,100,2200,Glossy black finish`

export function CsvImportModal({
  onClose,
  onImported,
}: {
  onClose: () => void
  onImported: () => void | Promise<void>
}) {
  const [csv, setCsv] = useState('')
  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [commitResult, setCommitResult] = useState<CommitResult | null>(null)
  const [busy, setBusy] = useState<'preview' | 'commit' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Esc closes.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [busy, onClose])

  const onFileChosen = useCallback((file: File) => {
    const reader = new FileReader()
    reader.onload = () => {
      setCsv(String(reader.result ?? ''))
      setPreview(null)
      setCommitResult(null)
    }
    reader.readAsText(file)
  }, [])

  const runPreview = useCallback(async () => {
    if (!csv.trim()) return
    setBusy('preview')
    setError(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/purchase-orders/import-preview`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ csv }),
        },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.error ?? `HTTP ${res.status}`)
      }
      setPreview(await res.json())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }, [csv])

  const runCommit = useCallback(async () => {
    if (!csv.trim()) return
    setBusy('commit')
    setError(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/purchase-orders/import`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ csv }),
        },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.error ?? `HTTP ${res.status}`)
      }
      const data = (await res.json()) as CommitResult
      setCommitResult(data)
      await onImported()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }, [csv, onImported])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Import POs from CSV"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose()
      }}
    >
      <div className="bg-white dark:bg-slate-900 border border-default dark:border-slate-700 rounded-lg shadow-xl w-full max-w-4xl max-h-[90vh] overflow-y-auto">
        <div className="sticky top-0 bg-white dark:bg-slate-900 z-10 border-b border-default dark:border-slate-700 px-5 py-3 flex items-center justify-between gap-2">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100 inline-flex items-center gap-2">
            <Upload className="w-4 h-4" />
            Import POs from CSV
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={!!busy}
            className="h-8 w-8 inline-flex items-center justify-center rounded text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {commitResult ? (
            <CommitSummary result={commitResult} onClose={onClose} />
          ) : (
            <>
              {/* CSV input */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-sm font-medium text-slate-700 dark:text-slate-300">
                    Paste CSV or upload a .csv file
                  </label>
                  <button
                    type="button"
                    onClick={() => setCsv(SAMPLE_CSV)}
                    className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
                  >
                    Use sample
                  </button>
                </div>
                <textarea
                  value={csv}
                  onChange={(e) => {
                    setCsv(e.target.value)
                    setPreview(null)
                  }}
                  placeholder="groupKey,supplierName,warehouseCode,…"
                  rows={6}
                  spellCheck={false}
                  className="w-full px-2 py-1.5 text-sm font-mono border border-default dark:border-slate-700 rounded bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 placeholder:text-tertiary dark:placeholder:text-slate-500"
                />
                <div className="flex items-center justify-between mt-2">
                  <div>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".csv,text/csv"
                      onChange={(e) => {
                        const f = e.target.files?.[0]
                        if (f) onFileChosen(f)
                        e.target.value = ''
                      }}
                      className="hidden"
                    />
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="h-8 px-3 text-sm rounded border border-default dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1.5"
                    >
                      <FileText className="w-3.5 h-3.5" />
                      Choose .csv…
                    </button>
                  </div>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={runPreview}
                    disabled={!csv.trim() || busy !== null}
                  >
                    {busy === 'preview' ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Upload className="w-3.5 h-3.5" />
                    )}
                    Parse preview
                  </Button>
                </div>
                <div className="text-xs text-slate-500 dark:text-slate-400 mt-2">
                  Required columns: <code>groupKey</code>, <code>sku</code>,{' '}
                  <code>quantityOrdered</code>. Optional:{' '}
                  <code>supplierName</code>, <code>warehouseCode</code>,{' '}
                  <code>expectedDeliveryDate</code> (YYYY-MM-DD),{' '}
                  <code>currencyCode</code>, <code>unitCostCents</code>,{' '}
                  <code>lineNote</code>. Rows with the same <code>groupKey</code> form one PO.
                </div>
              </div>

              {error && (
                <div className="text-md text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded px-3 py-2 inline-flex items-center gap-2">
                  <AlertCircle className="w-4 h-4" />
                  {error}
                </div>
              )}

              {preview && <PreviewTable preview={preview} />}
            </>
          )}
        </div>

        {!commitResult && (
          <div className="sticky bottom-0 bg-white dark:bg-slate-900 border-t border-default dark:border-slate-700 px-5 py-3 flex items-center justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={onClose} disabled={!!busy}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={runCommit}
              disabled={!preview || preview.groups.length === 0 || busy !== null}
            >
              {busy === 'commit' ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <CheckCircle2 className="w-3.5 h-3.5" />
              )}
              Import {preview ? `${preview.groups.length} PO${preview.groups.length === 1 ? '' : 's'}` : ''}
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}

function PreviewTable({ preview }: { preview: PreviewResult }) {
  return (
    <div className="border border-default dark:border-slate-700 rounded overflow-hidden">
      <div className="px-3 py-2 bg-slate-50 dark:bg-slate-800 border-b border-default dark:border-slate-700 flex items-center justify-between">
        <span className="text-sm font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wide">
          Preview
        </span>
        <span className="text-sm text-slate-500 dark:text-slate-400">
          {preview.groups.length} group{preview.groups.length === 1 ? '' : 's'} · {preview.totalRows} rows
          {preview.rejectedRows > 0 && ` · ${preview.rejectedRows} row${preview.rejectedRows === 1 ? '' : 's'} rejected`}
        </span>
      </div>
      <div className="max-h-72 overflow-y-auto">
        {preview.groups.map((g) => {
          const validLines = g.lines.filter((l) => !l.error)
          return (
            <div key={g.groupKey} className="border-b border-subtle dark:border-slate-800 last:border-0">
              <div className="px-3 py-2 bg-slate-50/40 dark:bg-slate-800/40 text-base">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono font-semibold text-slate-900 dark:text-slate-100">
                    {g.groupKey}
                  </span>
                  {g.supplierName && (
                    <span className="text-sm text-slate-700 dark:text-slate-300">
                      · {g.supplierName}
                      {!g.supplierId && (
                        <span className="text-amber-700 dark:text-amber-300"> (unknown)</span>
                      )}
                    </span>
                  )}
                  {g.warehouseCode && (
                    <span className="text-sm text-slate-700 dark:text-slate-300">· {g.warehouseCode}</span>
                  )}
                  {g.expectedDeliveryDate && (
                    <span className="text-sm text-slate-700 dark:text-slate-300">
                      · ETA {g.expectedDeliveryDate}
                    </span>
                  )}
                  <span className="text-sm text-slate-500 dark:text-slate-400">
                    · {g.currencyCode}
                  </span>
                  <span className="ml-auto text-sm text-slate-500 dark:text-slate-400">
                    {validLines.length} valid line{validLines.length === 1 ? '' : 's'}
                  </span>
                </div>
                {g.groupErrors.map((e, i) => (
                  <div key={i} className="text-xs text-amber-700 dark:text-amber-300 mt-1 inline-flex items-center gap-1">
                    <AlertCircle className="w-3 h-3" /> {e}
                  </div>
                ))}
              </div>
              <table className="w-full text-sm">
                <thead className="bg-slate-50 dark:bg-slate-800 text-xs text-slate-500 dark:text-slate-400">
                  <tr>
                    <th className="text-left px-3 py-1">SKU</th>
                    <th className="text-right px-3 py-1 w-20">Qty</th>
                    <th className="text-right px-3 py-1 w-24">Unit cost</th>
                    <th className="text-left px-3 py-1">Note</th>
                  </tr>
                </thead>
                <tbody>
                  {g.lines.map((l, i) => (
                    <tr
                      key={i}
                      className={cn(
                        l.error && 'bg-red-50/40 dark:bg-red-950/20',
                      )}
                    >
                      <td className="px-3 py-1 font-mono">
                        {l.sku || <span className="text-red-700 dark:text-red-300">missing</span>}
                        {l.error && (
                          <span className="ml-2 text-xs text-red-700 dark:text-red-300">{l.error}</span>
                        )}
                      </td>
                      <td className="px-3 py-1 text-right tabular-nums">{l.quantityOrdered || '—'}</td>
                      <td className="px-3 py-1 text-right tabular-nums">
                        {l.unitCostCents > 0 ? `€${(l.unitCostCents / 100).toFixed(2)}` : '—'}
                      </td>
                      <td className="px-3 py-1 text-slate-500 dark:text-slate-400 italic">
                        {l.lineNote ?? ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function CommitSummary({
  result,
  onClose,
}: {
  result: CommitResult
  onClose: () => void
}) {
  return (
    <div className="space-y-3">
      <div className="text-base">
        <div className="font-semibold text-slate-900 dark:text-slate-100 mb-1">
          Import done — {result.created.length} of {result.totalGroups} PO
          {result.totalGroups === 1 ? '' : 's'} created
        </div>
      </div>

      {result.created.length > 0 && (
        <div>
          <div className="text-sm font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wide mb-1">
            Created
          </div>
          <ul className="text-base space-y-0.5">
            {result.created.map((p) => (
              <li key={p.id} className="inline-flex items-center gap-2 text-green-700 dark:text-green-300">
                <CheckCircle2 className="w-3 h-3" />
                <span className="font-mono">{p.poNumber}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {result.failed.length > 0 && (
        <div>
          <div className="text-sm font-semibold text-red-700 dark:text-red-300 uppercase tracking-wide mb-1">
            Failed
          </div>
          <ul className="text-base space-y-0.5">
            {result.failed.map((f) => (
              <li key={f.groupKey} className="inline-flex items-center gap-2 text-red-700 dark:text-red-300">
                <AlertCircle className="w-3 h-3" />
                <span className="font-mono">{f.groupKey}</span>
                <span className="text-slate-500 dark:text-slate-400">— {f.error}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex items-center justify-end pt-2">
        <Button variant="primary" size="sm" onClick={onClose}>
          Done
        </Button>
      </div>
    </div>
  )
}

// ── Companion export button ────────────────────────────────────────

export function ExportCsvButton({
  filterQuery,
}: {
  /** The current URLSearchParams string (without the leading `?`). */
  filterQuery: string
}) {
  const href = `${getBackendUrl()}/api/fulfillment/purchase-orders/export.csv${
    filterQuery ? `?${filterQuery}` : ''
  }`
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="h-8 px-3 text-base border border-default dark:border-slate-700 rounded-md inline-flex items-center gap-1.5 hover:bg-slate-50 dark:hover:bg-slate-800"
      title="Export the current filter view as CSV"
    >
      <Download className="w-3 h-3" />
      Export CSV
    </a>
  )
}
