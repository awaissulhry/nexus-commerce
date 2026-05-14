'use client'

/**
 * ES.5 — Time-travel snapshot modal.
 *
 * Shows the reconstructed product state at a selected point in time
 * with per-field coverage tags:
 *   reconstructed — prior value recovered from AuditLog.before ✓
 *   uncertain     — changed after `at` but no prior value recorded ⚠
 *   unchanged     — no edits after `at`, current value is correct
 *
 * Includes a "Restore" action that PATCHes the product back to the
 * snapshot values, with a warning when flat-file imports were involved.
 */

import { useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  HelpCircle,
  Loader2,
  Minus,
  RotateCcw,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useConfirm } from '@/components/ui/ConfirmProvider'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'

// ── Types ─────────────────────────────────────────────────────────────

type Coverage = 'reconstructed' | 'uncertain' | 'unchanged'

interface SnapshotData {
  state: Record<string, unknown>
  coverage: Record<string, Coverage>
  warnings: string[]
  reconstructedAt: string
  eventCount: number
  auditCount: number
}

interface Props {
  productId: string
  productVersion: number
  onClose: () => void
  onRestored: () => void
}

// ── Helpers ───────────────────────────────────────────────────────────

const DISPLAY_FIELDS: Array<{ key: string; label: string }> = [
  { key: 'name', label: 'Name' },
  { key: 'status', label: 'Status' },
  { key: 'brand', label: 'Brand' },
  { key: 'description', label: 'Description' },
  { key: 'basePrice', label: 'Base Price' },
  { key: 'costPrice', label: 'Cost Price' },
  { key: 'totalStock', label: 'Stock' },
  { key: 'productType', label: 'Product Type' },
  { key: 'ean', label: 'EAN' },
  { key: 'gtin', label: 'GTIN' },
  { key: 'weightValue', label: 'Weight' },
  { key: 'bulletPoints', label: 'Bullet Points' },
  { key: 'keywords', label: 'Keywords' },
]

const RESTORABLE_FIELDS = new Set([
  'name', 'description', 'status', 'basePrice', 'costPrice', 'minPrice', 'maxPrice',
  'brand', 'manufacturer', 'ean', 'gtin', 'upc', 'productType',
  'bulletPoints', 'keywords', 'weightValue', 'weightUnit',
  'dimLength', 'dimWidth', 'dimHeight', 'dimUnit',
  'hsCode', 'countryOfOrigin', 'totalStock', 'lowStockThreshold',
])

function CoverageIcon({ c }: { c?: Coverage }) {
  if (c === 'reconstructed')
    return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
  if (c === 'uncertain')
    return <HelpCircle className="h-3.5 w-3.5 text-amber-500 shrink-0" />
  return <Minus className="h-3.5 w-3.5 text-slate-300 dark:text-slate-600 shrink-0" />
}

function formatValue(v: unknown): string {
  if (v == null) return '—'
  if (Array.isArray(v)) return v.join(', ')
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

// ── Snapshot result panel ─────────────────────────────────────────────

function SnapshotPanel({
  data,
  onRestore,
  restoring,
}: {
  data: SnapshotData
  onRestore: (fields: Record<string, unknown>) => void
  restoring: boolean
}) {
  const [showAll, setShowAll] = useState(false)

  const reconstructedCount = Object.values(data.coverage).filter(
    (v) => v === 'reconstructed',
  ).length
  const uncertainCount = Object.values(data.coverage).filter(
    (v) => v === 'uncertain',
  ).length

  // Build restorable field set: reconstructed fields only
  const restorableFields: Record<string, unknown> = {}
  for (const [key, cov] of Object.entries(data.coverage)) {
    if (cov === 'reconstructed' && RESTORABLE_FIELDS.has(key)) {
      restorableFields[key] = data.state[key]
    }
  }

  const visibleFields = showAll
    ? DISPLAY_FIELDS
    : DISPLAY_FIELDS.filter(
        (f) => data.coverage[f.key] === 'reconstructed' || data.coverage[f.key] === 'uncertain',
      )

  return (
    <div className="space-y-4">
      {/* Coverage summary */}
      <div className="flex flex-wrap gap-2">
        <div className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-400">
          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
          <span>{reconstructedCount} reconstructed</span>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-400">
          <HelpCircle className="h-3.5 w-3.5 text-amber-500" />
          <span>{uncertainCount} uncertain</span>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-slate-500">
          <span className="text-slate-400">{data.eventCount} events · {data.auditCount} audit entries scanned</span>
        </div>
      </div>

      {/* Warnings */}
      {data.warnings.length > 0 && (
        <div className="space-y-1.5">
          {data.warnings.map((w, i) => (
            <div
              key={i}
              className="flex items-start gap-2 rounded-md bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
            >
              <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              {w}
            </div>
          ))}
        </div>
      )}

      {/* Field table */}
      <div className="rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden">
        <div className="px-3 py-2 bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
          <span className="text-xs font-medium text-slate-600 dark:text-slate-400 uppercase tracking-wide">
            Field values
          </span>
          <div className="flex items-center gap-3 text-xs text-slate-400">
            <span className="flex items-center gap-1"><CheckCircle2 className="h-3 w-3 text-emerald-500" /> reconstructed</span>
            <span className="flex items-center gap-1"><HelpCircle className="h-3 w-3 text-amber-500" /> uncertain</span>
            <span className="flex items-center gap-1"><Minus className="h-3 w-3 text-slate-300" /> unchanged</span>
          </div>
        </div>

        {visibleFields.length === 0 ? (
          <div className="px-3 py-4 text-sm text-slate-400 text-center">
            No field changes detected after this point in time.
          </div>
        ) : (
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {visibleFields.map(({ key, label }) => {
              const cov = data.coverage[key] ?? 'unchanged'
              const val = data.state[key]
              return (
                <div
                  key={key}
                  className={cn(
                    'flex items-start gap-3 px-3 py-2',
                    cov === 'uncertain' && 'bg-amber-50/50 dark:bg-amber-900/10',
                  )}
                >
                  <CoverageIcon c={cov} />
                  <span className="w-28 shrink-0 text-xs font-medium text-slate-600 dark:text-slate-400">
                    {label}
                  </span>
                  <span
                    className={cn(
                      'text-xs flex-1 break-all',
                      cov === 'uncertain'
                        ? 'text-amber-700 dark:text-amber-400 italic'
                        : 'text-slate-800 dark:text-slate-200',
                    )}
                  >
                    {cov === 'uncertain' ? '(value unknown — changed after this time)' : formatValue(val)}
                  </span>
                </div>
              )
            })}
          </div>
        )}

        {DISPLAY_FIELDS.length > visibleFields.length && (
          <button
            onClick={() => setShowAll((v) => !v)}
            className="w-full flex items-center justify-center gap-1 px-3 py-2 text-xs text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 border-t border-slate-100 dark:border-slate-800"
          >
            {showAll ? (
              <><ChevronUp className="h-3 w-3" /> Show changed fields only</>
            ) : (
              <><ChevronDown className="h-3 w-3" /> Show all {DISPLAY_FIELDS.length} tracked fields</>
            )}
          </button>
        )}
      </div>

      {/* Restore button */}
      <div className="flex items-center justify-between pt-1">
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Only <strong>{Object.keys(restorableFields).length}</strong> reconstructed field(s) will be restored.
          Uncertain fields are skipped.
        </p>
        <Button
          variant="primary"
          size="sm"
          onClick={() => onRestore(restorableFields)}
          disabled={restoring || Object.keys(restorableFields).length === 0}
        >
          {restoring ? (
            <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
          ) : (
            <RotateCcw className="h-4 w-4 mr-1.5" />
          )}
          Restore {Object.keys(restorableFields).length} field(s)
        </Button>
      </div>
    </div>
  )
}

// ── Main modal ────────────────────────────────────────────────────────

export function SnapshotModal({ productId, productVersion, onClose, onRestored }: Props) {
  const confirm = useConfirm()
  const [selectedDate, setSelectedDate] = useState('')
  const [selectedTime, setSelectedTime] = useState('12:00')
  const [snapshot, setSnapshot] = useState<SnapshotData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [restoring, setRestoring] = useState(false)

  const fetchSnapshot = async () => {
    if (!selectedDate) return
    setLoading(true)
    setError(null)
    setSnapshot(null)
    try {
      const at = new Date(`${selectedDate}T${selectedTime}:00`).toISOString()
      const res = await fetch(
        `${getBackendUrl()}/api/products/${productId}/state?at=${encodeURIComponent(at)}`,
        { cache: 'no-store' },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      setSnapshot(await res.json())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  const handleRestore = async (fields: Record<string, unknown>) => {
    if (!snapshot) return

    const hasFlatFileWarning = snapshot.warnings.some((w) =>
      w.toLowerCase().includes('flat file'),
    )
    const ok = await confirm({
      title: 'Restore to this point?',
      description: [
        `This will overwrite ${Object.keys(fields).length} field(s) with the reconstructed values from ${new Date(snapshot.reconstructedAt).toLocaleString()}.`,
        hasFlatFileWarning
          ? ' Note: a flat file import after this time may re-overwrite these values if uploaded again.'
          : '',
      ]
        .join('')
        .trim(),
      confirmLabel: 'Restore',
      tone: 'warning',
    })
    if (!ok) return

    setRestoring(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/products/${productId}/restore`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            at: snapshot.reconstructedAt,
            fields,
            expectedVersion: productVersion,
          }),
        },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      onRestored()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setRestoring(false)
    }
  }

  // Max date = today; prevent selecting future dates
  const today = new Date().toISOString().slice(0, 10)

  return (
    /* Backdrop */
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 backdrop-blur-sm p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="w-full max-w-2xl bg-white dark:bg-slate-900 rounded-xl shadow-2xl overflow-hidden max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-700">
          <div className="flex items-center gap-2">
            <Clock className="h-5 w-5 text-blue-500" />
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              Time Travel
            </h2>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto flex-1 px-5 py-5 space-y-5">
          {/* Date/time picker */}
          <div>
            <p className="text-sm text-slate-600 dark:text-slate-400 mb-3">
              Select a point in time to view what this product looked like then.
            </p>
            <div className="flex items-end gap-2 flex-wrap">
              <div className="space-y-1">
                <label className="text-xs font-medium text-slate-600 dark:text-slate-400">Date</label>
                <input
                  type="date"
                  value={selectedDate}
                  max={today}
                  onChange={(e) => {
                    setSelectedDate(e.target.value)
                    setSnapshot(null)
                    setError(null)
                  }}
                  className="block rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-1.5 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-slate-600 dark:text-slate-400">Time</label>
                <input
                  type="time"
                  value={selectedTime}
                  onChange={(e) => {
                    setSelectedTime(e.target.value)
                    setSnapshot(null)
                    setError(null)
                  }}
                  className="block rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-1.5 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <Button
                variant="secondary"
                size="sm"
                onClick={fetchSnapshot}
                disabled={!selectedDate || loading}
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : null}
                View snapshot
              </Button>
            </div>
          </div>

          {/* Coverage legend */}
          {!snapshot && !loading && !error && (
            <div className="rounded-lg bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 px-4 py-3 space-y-2">
              <p className="text-xs font-medium text-slate-600 dark:text-slate-400 uppercase tracking-wide">
                How reconstruction works
              </p>
              <div className="space-y-1.5 text-xs text-slate-600 dark:text-slate-400">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                  <span><strong>Reconstructed</strong> — prior value recovered from audit history. Safe to restore.</span>
                </div>
                <div className="flex items-center gap-2">
                  <HelpCircle className="h-3.5 w-3.5 text-amber-500 shrink-0" />
                  <span><strong>Uncertain</strong> — field changed after this time but no prior value was recorded. Skipped during restore.</span>
                </div>
                <div className="flex items-center gap-2">
                  <Minus className="h-3.5 w-3.5 text-slate-300 shrink-0" />
                  <span><strong>Unchanged</strong> — no edits detected after this time. Current value matches the historical state.</span>
                </div>
              </div>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="flex items-start gap-2 rounded-md bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 px-3 py-2.5 text-sm text-red-700 dark:text-red-300">
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
              {error}
            </div>
          )}

          {/* Loading */}
          {loading && (
            <div className="flex justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
            </div>
          )}

          {/* Snapshot result */}
          {snapshot && !loading && (
            <>
              <div className="flex items-center gap-2 rounded-md bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 px-3 py-2 text-xs text-blue-700 dark:text-blue-300">
                <Clock className="h-3.5 w-3.5 shrink-0" />
                Viewing state as of{' '}
                <strong>{new Date(snapshot.reconstructedAt).toLocaleString()}</strong>
              </div>
              <SnapshotPanel
                data={snapshot}
                onRestore={handleRestore}
                restoring={restoring}
              />
            </>
          )}
        </div>
      </div>
    </div>
  )
}
