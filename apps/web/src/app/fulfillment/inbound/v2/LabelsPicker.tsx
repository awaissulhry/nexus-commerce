'use client'

/**
 * F.6.5 (TECH_DEBT #50) — label download UI for the v2024-03-20 FBA
 * inbound wizard.
 *
 * Replaces F.5 v1's `toast.success('Labels fetched for N shipments')`
 * (which left the operator with nothing to print) with a real per-
 * shipment download list.
 *
 * SP-API's getShipmentLabels returns `documentDownloads[]` with a
 * temporary `source` URL per label PDF. The URLs expire (Amazon
 * typically 1-2 hours), so the picker shows a relative expiration
 * countdown and provides a one-click re-fetch.
 *
 * Operator defaults (Xavia, Italy):
 *   - pageSize='A4'  (vs Letter — Italian printers default to A4)
 *   - format='PDF'   (vs PNG/ZPL — single-document, easy to print)
 *
 * Both are editable before fetch; the cached result includes the
 * chosen options so the operator can re-fetch with different settings
 * (e.g. ZPL when their warehouse printer is a thermal Zebra).
 */

import { useMemo, useState } from 'react'
import {
  Loader2,
  CheckCircle2,
  AlertTriangle,
  Download,
  ExternalLink,
  FileText,
  RotateCw,
} from 'lucide-react'
import { useToast } from '@/components/ui/Toast'
import { getBackendUrl } from '@/lib/backend-url'

interface DocumentDownload {
  source: string
  downloadType: string
  expiration?: string
}

interface LabelsResponse {
  labels: Record<
    string,
    | { documentDownloads?: DocumentDownload[] }
    | { error: string }
  >
}

interface PlanLabelsProps {
  planRowId: string
  shipmentIds: string[]
  /** Existing labels cached from a prior fetch (FbaInboundPlanV2.labels). */
  cachedLabels: Record<string, unknown> | null
  onAction: () => void
}

type FormatChoice = 'PDF' | 'PNG' | 'ZPL'
type PageSizeChoice = 'A4' | 'Letter'
type LabelTypeChoice = 'BARCODE_2D' | 'UNIQUE' | 'PALLET'

function expirationLabel(iso?: string): {
  label: string
  expired: boolean
} | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const mins = Math.round((d.getTime() - Date.now()) / 60_000)
  if (mins < 0) return { label: 'EXPIRED — re-fetch', expired: true }
  if (mins < 60) return { label: `expires in ${mins}m`, expired: false }
  if (mins < 60 * 24) return { label: `expires in ${Math.round(mins / 60)}h`, expired: false }
  return {
    label: `expires ${d.toLocaleDateString('it-IT')}`,
    expired: false,
  }
}

function normalizeCachedLabels(
  raw: Record<string, unknown> | null,
): LabelsResponse['labels'] {
  if (!raw) return {}
  // The cached blob is the same shape getShipmentLabels returns per
  // shipmentId, plus our own per-shipment error wrapper.
  return raw as LabelsResponse['labels']
}

export function LabelsPicker({
  planRowId,
  shipmentIds,
  cachedLabels,
  onAction,
}: PlanLabelsProps) {
  const { toast } = useToast()
  const [format, setFormat] = useState<FormatChoice>('PDF')
  const [pageSize, setPageSize] = useState<PageSizeChoice>('A4')
  const [labelType, setLabelType] = useState<LabelTypeChoice>('BARCODE_2D')
  const [fetching, setFetching] = useState(false)
  const [results, setResults] = useState<LabelsResponse['labels']>(
    normalizeCachedLabels(cachedLabels),
  )

  const hasCachedResults = useMemo(
    () => Object.keys(results).length > 0,
    [results],
  )

  const handleFetch = async () => {
    setFetching(true)
    try {
      const qs = new URLSearchParams({
        Format: format,
        PageSize: pageSize,
        LabelType: labelType,
      }).toString()
      const res = await fetch(
        `${getBackendUrl()}/api/fba/inbound/v2/${planRowId}/labels?${qs}`,
        { credentials: 'include' },
      )
      const j = (await res.json().catch(() => ({}))) as
        | LabelsResponse
        | { error?: string }
      if (!res.ok) {
        const err = (j as { error?: string }).error ?? `HTTP ${res.status}`
        throw new Error(err)
      }
      const newLabels = (j as LabelsResponse).labels ?? {}
      setResults(newLabels)
      const okCount = Object.values(newLabels).filter(
        (v): v is { documentDownloads?: DocumentDownload[] } =>
          !('error' in (v as object)),
      ).length
      toast.success(
        `Labels ready for ${okCount} shipment${okCount === 1 ? '' : 's'} (${format}, ${pageSize})`,
      )
      onAction()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setFetching(false)
    }
  }

  const handleOpenAll = () => {
    let opened = 0
    for (const sid of shipmentIds) {
      const row = results[sid]
      if (!row || 'error' in row) continue
      for (const doc of row.documentDownloads ?? []) {
        if (doc.source) {
          window.open(doc.source, '_blank', 'noopener,noreferrer')
          opened++
        }
      }
    }
    if (opened === 0) {
      toast.error('No downloadable labels — fetch first')
    } else {
      toast.success(`Opened ${opened} label${opened === 1 ? '' : 's'} in new tabs`)
    }
  }

  // Count labels currently downloadable across all shipments
  const downloadableCount = useMemo(() => {
    let n = 0
    for (const sid of shipmentIds) {
      const row = results[sid]
      if (!row || 'error' in row) continue
      n += (row.documentDownloads ?? []).length
    }
    return n
  }, [shipmentIds, results])

  if (shipmentIds.length === 0) {
    return (
      <div className="border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 rounded p-3 text-sm text-amber-700 dark:text-amber-300">
        <div className="inline-flex items-center gap-1.5">
          <AlertTriangle size={12} /> No shipment IDs on this plan
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {/* Format/page options */}
      <div className="border border-slate-200 dark:border-slate-700 rounded p-3 bg-slate-50/40 dark:bg-slate-900/30 space-y-2">
        <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">
          Label format
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <SelectField
            label="Format"
            value={format}
            disabled={fetching}
            onChange={(v) => setFormat(v as FormatChoice)}
            options={[
              { value: 'PDF', label: 'PDF (default)' },
              { value: 'PNG', label: 'PNG (one per page)' },
              { value: 'ZPL', label: 'ZPL (thermal printer)' },
            ]}
          />
          <SelectField
            label="Page size"
            value={pageSize}
            disabled={fetching || format === 'ZPL'}
            onChange={(v) => setPageSize(v as PageSizeChoice)}
            options={[
              { value: 'A4', label: 'A4 (default)' },
              { value: 'Letter', label: 'US Letter' },
            ]}
          />
          <SelectField
            label="Label type"
            value={labelType}
            disabled={fetching}
            onChange={(v) => setLabelType(v as LabelTypeChoice)}
            options={[
              { value: 'BARCODE_2D', label: '2D barcode (carton)' },
              { value: 'UNIQUE', label: 'Unique (per unit)' },
              { value: 'PALLET', label: 'Pallet' },
            ]}
          />
        </div>
        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            onClick={handleFetch}
            disabled={fetching}
            className="h-9 px-3 text-sm bg-blue-600 dark:bg-blue-700 text-white rounded hover:bg-blue-700 dark:hover:bg-blue-600 disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            {fetching ? (
              <Loader2 size={12} className="animate-spin" />
            ) : hasCachedResults ? (
              <RotateCw size={12} />
            ) : (
              <Download size={12} />
            )}
            {fetching
              ? 'Fetching from SP-API…'
              : hasCachedResults
                ? 'Re-fetch with these options'
                : `Fetch ${shipmentIds.length} label${shipmentIds.length === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>

      {/* Per-shipment download list */}
      {hasCachedResults && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">
              {downloadableCount} download{downloadableCount === 1 ? '' : 's'} across {shipmentIds.length} shipment{shipmentIds.length === 1 ? '' : 's'}
            </div>
            {downloadableCount > 1 && (
              <button
                onClick={handleOpenAll}
                disabled={fetching}
                className="h-7 px-2.5 text-xs border border-slate-300 dark:border-slate-700 rounded inline-flex items-center gap-1 hover:border-blue-400 disabled:opacity-50"
              >
                <ExternalLink size={11} /> Open all in new tabs
              </button>
            )}
          </div>

          <div className="space-y-1.5">
            {shipmentIds.map((sid, idx) => (
              <ShipmentLabelCard
                key={sid}
                index={idx}
                shipmentId={sid}
                row={results[sid]}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Per-shipment label card ────────────────────────────────────────────

function ShipmentLabelCard({
  index,
  shipmentId,
  row,
}: {
  index: number
  shipmentId: string
  row:
    | { documentDownloads?: DocumentDownload[] }
    | { error: string }
    | undefined
}) {
  const isError = row && 'error' in row
  const downloads = row && !isError ? row.documentDownloads ?? [] : []
  const allExpired =
    downloads.length > 0 &&
    downloads.every((d) => expirationLabel(d.expiration)?.expired)

  return (
    <div className="border border-slate-200 dark:border-slate-700 rounded">
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/50">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[11px] tabular-nums text-slate-500 dark:text-slate-400">
            Shipment {index + 1} of
          </span>
          <span className="font-mono text-xs text-slate-700 dark:text-slate-300 truncate">
            {shipmentId}
          </span>
          {!isError && downloads.length > 0 && !allExpired && (
            <CheckCircle2 size={12} className="text-emerald-600 dark:text-emerald-400 shrink-0" />
          )}
        </div>
        {!isError && downloads.length > 0 && (
          <span className="text-[11px] text-slate-500 dark:text-slate-400">
            {downloads.length} document{downloads.length === 1 ? '' : 's'}
          </span>
        )}
      </div>

      <div className="p-2">
        {isError ? (
          <div className="border border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/40 rounded p-2 text-xs text-rose-700 dark:text-rose-300">
            <div className="inline-flex items-center gap-1 mb-1">
              <AlertTriangle size={11} /> Label fetch failed
            </div>
            <div className="font-mono">{(row as { error: string }).error}</div>
          </div>
        ) : downloads.length === 0 ? (
          <div className="text-xs text-slate-500 dark:text-slate-400 px-1 py-1">
            No documents returned for this shipment.
          </div>
        ) : (
          <div className="space-y-1">
            {downloads.map((doc, i) => {
              const exp = expirationLabel(doc.expiration)
              return (
                <div
                  key={i}
                  className="flex items-center justify-between gap-3 p-2 rounded hover:bg-slate-50 dark:hover:bg-slate-800/40"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <FileText size={12} className="text-slate-400 dark:text-slate-500 shrink-0" />
                    <span className="text-sm text-slate-700 dark:text-slate-300 truncate">
                      {doc.downloadType || `Document ${i + 1}`}
                    </span>
                    {exp && (
                      <span
                        className={`text-[11px] shrink-0 ${
                          exp.expired
                            ? 'text-rose-600 dark:text-rose-400 font-medium'
                            : 'text-slate-500 dark:text-slate-400'
                        }`}
                      >
                        {exp.label}
                      </span>
                    )}
                  </div>
                  <a
                    href={doc.source}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`h-7 px-2.5 text-xs rounded inline-flex items-center gap-1 ${
                      exp?.expired
                        ? 'border border-rose-300 dark:border-rose-700 text-rose-600 dark:text-rose-400 pointer-events-none opacity-60'
                        : 'bg-blue-600 dark:bg-blue-700 text-white hover:bg-blue-700 dark:hover:bg-blue-600'
                    }`}
                  >
                    <Download size={11} /> Download
                  </a>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Small helper ───────────────────────────────────────────────────────

function SelectField({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string
  value: string
  options: Array<{ value: string; label: string }>
  onChange: (v: string) => void
  disabled?: boolean
}) {
  return (
    <label className="space-y-0.5 block">
      <span className="text-[11px] uppercase tracking-wider text-slate-500 dark:text-slate-400 font-medium">
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="h-9 w-full px-2 text-sm border border-slate-300 dark:border-slate-700 rounded bg-white dark:bg-slate-900 disabled:opacity-60"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  )
}
