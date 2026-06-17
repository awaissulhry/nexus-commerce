'use client'

// PO.13 — Right-side drawer that pulls the supplier scorecard
// (/api/fulfillment/suppliers/:id/scorecard). Opened from the
// supplier-name cell in PO rows + from the spend tile's Top
// Suppliers list.
//
// Scorecard fields surfaced (from the H.13 endpoint):
//   - leadTimeDays  avg / median / max (observed)
//   - onTimePercent supplier OTIF
//   - defectRate    quality
//   - openPOs       count
//   - spend         all-time total

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { AlertCircle, ExternalLink, Loader2, X } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { formatCurrency } from './po-lens'

interface SupplierScorecard {
  supplier: { id: string; name: string }
  windowDays: number
  leadTimeDays: {
    avg: number | null
    median: number | null
    max: number | null
    sampleCount: number
  }
  onTimePercent: number | null
  defectRate: number | null
  openPOs: number
  spend: { cents: number; currencyCode: string }
}

export function SupplierScorecardDrawer({
  supplierId,
  onClose,
}: {
  supplierId: string
  onClose: () => void
}) {
  const [data, setData] = useState<SupplierScorecard | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/suppliers/${supplierId}/scorecard`,
        { cache: 'no-store' },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.error ?? `HTTP ${res.status}`)
      }
      setData(await res.json())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [supplierId])

  useEffect(() => {
    load()
  }, [load])

  // Esc closes the drawer.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/30"
      role="dialog"
      aria-modal="true"
      aria-label="Supplier scorecard"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="w-full max-w-md bg-white dark:bg-slate-900 border-l border-default dark:border-slate-700 shadow-xl overflow-y-auto">
        <div className="sticky top-0 bg-white dark:bg-slate-900 border-b border-default dark:border-slate-700 px-5 py-3 flex items-center justify-between gap-2">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
            Supplier scorecard
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="h-8 w-8 inline-flex items-center justify-center rounded text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {loading && !data && (
            <div className="text-base text-slate-500 dark:text-slate-400 inline-flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading scorecard…
            </div>
          )}
          {error && (
            <div className="text-md text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded px-3 py-2 inline-flex items-center gap-2">
              <AlertCircle className="w-4 h-4" />
              {error}
            </div>
          )}
          {data && (
            <>
              <div>
                <div className="text-lg font-semibold text-slate-900 dark:text-slate-100">
                  {data.supplier.name}
                </div>
                <div className="text-sm text-slate-500 dark:text-slate-400">
                  Window: trailing {data.windowDays} days
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <Tile
                  label="Lead time (avg)"
                  value={
                    data.leadTimeDays.avg != null
                      ? `${data.leadTimeDays.avg.toFixed(0)} d`
                      : '—'
                  }
                  secondary={
                    data.leadTimeDays.sampleCount > 0
                      ? `median ${data.leadTimeDays.median ?? '—'}d · max ${data.leadTimeDays.max ?? '—'}d`
                      : 'no observed receipts in window'
                  }
                />
                <Tile
                  label="OTIF"
                  value={
                    data.onTimePercent != null
                      ? `${(data.onTimePercent * 100).toFixed(0)}%`
                      : '—'
                  }
                  secondary="on-time deliveries"
                  tone={
                    data.onTimePercent == null
                      ? 'slate'
                      : data.onTimePercent >= 0.9
                        ? 'green'
                        : data.onTimePercent >= 0.7
                          ? 'amber'
                          : 'red'
                  }
                />
                <Tile
                  label="Defect rate"
                  value={
                    data.defectRate != null
                      ? `${(data.defectRate * 100).toFixed(1)}%`
                      : '—'
                  }
                  secondary="FAIL + HOLD items / received"
                  tone={
                    data.defectRate == null
                      ? 'slate'
                      : data.defectRate <= 0.01
                        ? 'green'
                        : data.defectRate <= 0.05
                          ? 'amber'
                          : 'red'
                  }
                />
                <Tile
                  label="Open POs"
                  value={`${data.openPOs}`}
                  secondary="non-terminal"
                />
              </div>

              <div className="bg-slate-50 dark:bg-slate-800 rounded p-3">
                <div className="text-sm text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                  All-time spend
                </div>
                <div className="text-2xl font-semibold tabular-nums text-slate-900 dark:text-slate-100 mt-1">
                  {formatCurrency(data.spend.cents, data.spend.currencyCode)}
                </div>
              </div>

              <div className="flex items-center gap-2">
                <Link
                  href={`/fulfillment/purchase-orders?supplierId=${data.supplier.id}`}
                  className="h-8 px-3 inline-flex items-center gap-1.5 text-base border border-default dark:border-slate-700 rounded hover:bg-slate-50 dark:hover:bg-slate-800"
                >
                  POs from this supplier
                </Link>
                <Link
                  href={`/products?supplierId=${data.supplier.id}`}
                  className="h-8 px-3 inline-flex items-center gap-1.5 text-base border border-default dark:border-slate-700 rounded hover:bg-slate-50 dark:hover:bg-slate-800"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  Catalog products
                </Link>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function Tile({
  label,
  value,
  secondary,
  tone = 'slate',
}: {
  label: string
  value: string
  secondary?: string
  tone?: 'green' | 'amber' | 'red' | 'slate'
}) {
  const toneCls: Record<typeof tone, string> = {
    green: 'text-green-700 dark:text-green-300',
    amber: 'text-amber-700 dark:text-amber-300',
    red: 'text-red-700 dark:text-red-300',
    slate: 'text-slate-900 dark:text-slate-100',
  } as any
  return (
    <div className="border border-default dark:border-slate-700 rounded p-3">
      <div className="text-sm text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-1">
        {label}
      </div>
      <div className={`text-xl font-semibold tabular-nums ${toneCls[tone]}`}>{value}</div>
      {secondary && (
        <div className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">{secondary}</div>
      )}
    </div>
  )
}
