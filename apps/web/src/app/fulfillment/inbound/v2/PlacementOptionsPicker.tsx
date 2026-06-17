'use client'

/**
 * F.6.3 (TECH_DEBT #50) — placement-options picker for the v2024-03-20
 * FBA inbound wizard.
 *
 * Replaces F.5 v1's `prompt('placementOptionId to confirm?')` with a
 * card list showing status / expected shipmentIds / fees per option.
 * Operator selects one and confirms.
 *
 * Placement is the "FC routing" step — Amazon splits the inbound across
 * multiple shipments depending on which fulfillment centers it routes
 * to. Each placement option proposes a different (cost, shipment-count)
 * tradeoff. Cheapest is the conventional default but operators
 * sometimes prefer fewer-shipments for handling simplicity.
 */

import { useEffect, useMemo, useState } from 'react'
import {
  Loader2,
  CheckCircle2,
  ChevronRight,
  AlertTriangle,
  Truck,
} from 'lucide-react'
import { useToast } from '@/components/ui/Toast'
import { getBackendUrl } from '@/lib/backend-url'

interface PlacementFee {
  type?: string
  value?: { amount: number; currencyCode: string }
}

interface PlacementOption {
  placementOptionId: string
  status: string
  shipmentIds?: string[]
  fees?: PlacementFee[]
  /** F.6.3 — surfaced by SP-API on some options; null otherwise. */
  expiration?: string
}

interface ListResponse {
  placementOptions: PlacementOption[]
  nextToken?: string
}

interface PlacementOptionsPickerProps {
  planRowId: string
  /** Called after confirm succeeds; parent should refetch the plan list. */
  onConfirmed: () => void
}

function sumFees(fees: PlacementOption['fees']): {
  total: number
  currency: string
} | null {
  if (!fees || fees.length === 0) return null
  let total = 0
  let currency = ''
  for (const f of fees) {
    if (!f.value) continue
    if (!currency) currency = f.value.currencyCode
    if (currency !== f.value.currencyCode) return null
    total += f.value.amount
  }
  return currency ? { total, currency } : null
}

function currencyLabel(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat('it-IT', {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(value)
  } catch {
    return `${value.toFixed(2)} ${currency}`
  }
}

function expirationLabel(iso?: string): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const mins = Math.round((d.getTime() - Date.now()) / 60_000)
  if (mins < 0) return 'EXPIRED'
  if (mins < 60) return `expires in ${mins}m`
  if (mins < 60 * 24) return `expires in ${Math.round(mins / 60)}h`
  return `expires ${d.toLocaleDateString('it-IT')}`
}

export function PlacementOptionsPicker({
  planRowId,
  onConfirmed,
}: PlacementOptionsPickerProps) {
  const { toast } = useToast()
  const [options, setOptions] = useState<PlacementOption[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fba/inbound/v2/${planRowId}/placement-options`,
        { credentials: 'include' },
      )
      const j = (await res.json().catch(() => ({}))) as ListResponse & { error?: string }
      if (!res.ok) throw new Error(j?.error ?? `HTTP ${res.status}`)
      setOptions(j.placementOptions ?? [])
      // Auto-select cheapest as a starting hint. Operator can override.
      const opts = j.placementOptions ?? []
      if (opts.length > 0) {
        const sorted = [...opts].sort((a, b) => {
          const sa = sumFees(a.fees)?.total ?? Infinity
          const sb = sumFees(b.fees)?.total ?? Infinity
          return sa - sb
        })
        setSelected(sorted[0]?.placementOptionId ?? null)
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
      toast.error(msg)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (options === null && !loading) {
      load()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleConfirm = async () => {
    if (!selected) return
    setConfirming(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fba/inbound/v2/${planRowId}/placement-options/${encodeURIComponent(selected)}/confirm`,
        { method: 'POST', credentials: 'include' },
      )
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j?.error ?? `HTTP ${res.status}`)
      toast.success('Placement confirmed — shipmentIds emitted; transport options next')
      onConfirmed()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setConfirming(false)
    }
  }

  const cheapest = useMemo(() => {
    if (!options || options.length === 0) return null
    let best: { id: string; total: number } | null = null
    for (const o of options) {
      const f = sumFees(o.fees)
      if (!f) continue
      if (!best || f.total < best.total) best = { id: o.placementOptionId, total: f.total }
    }
    return best
  }, [options])

  const fewestShipments = useMemo(() => {
    if (!options || options.length === 0) return null
    let best: { id: string; count: number } | null = null
    for (const o of options) {
      const count = o.shipmentIds?.length ?? 0
      if (count === 0) continue
      if (!best || count < best.count) best = { id: o.placementOptionId, count }
    }
    return best
  }, [options])

  if (loading && options === null) {
    return (
      <div className="border border-default dark:border-slate-700 rounded p-4 bg-slate-50 dark:bg-slate-900/50">
        <div className="inline-flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
          <Loader2 size={12} className="animate-spin" />
          Loading placement options from SP-API…
        </div>
      </div>
    )
  }
  if (error) {
    return (
      <div className="border border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/40 rounded p-3 text-sm text-rose-700 dark:text-rose-300">
        <div className="inline-flex items-center gap-1.5 mb-1">
          <AlertTriangle size={12} /> Could not load placement options
        </div>
        <div className="text-xs mb-2">{error}</div>
        <button
          onClick={load}
          className="h-7 px-2.5 text-xs border border-rose-300 dark:border-rose-700 rounded hover:bg-rose-100/50 dark:hover:bg-rose-900/40"
        >
          Retry
        </button>
      </div>
    )
  }
  if (!options || options.length === 0) {
    return (
      <div className="border border-default dark:border-slate-700 rounded p-4 bg-slate-50 dark:bg-slate-900/50 text-sm text-slate-500 dark:text-slate-400">
        No placement options returned by SP-API.
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold flex items-center justify-between">
        <span>{options.length} placement {options.length === 1 ? 'option' : 'options'}</span>
        <button
          onClick={load}
          disabled={loading}
          className="h-6 px-2 text-[11px] border border-slate-300 dark:border-slate-700 rounded hover:border-blue-400 disabled:opacity-50"
        >
          Refresh
        </button>
      </div>

      <div className="space-y-1.5">
        {options.map((opt) => {
          const fees = sumFees(opt.fees)
          const isSelected = selected === opt.placementOptionId
          const isCheapest = cheapest?.id === opt.placementOptionId && options.length > 1
          const isFewest = fewestShipments?.id === opt.placementOptionId && options.length > 1
          const expLabel = expirationLabel(opt.expiration)
          const expired = expLabel === 'EXPIRED'
          const shipmentCount = opt.shipmentIds?.length ?? 0
          return (
            <button
              key={opt.placementOptionId}
              onClick={() => !expired && setSelected(opt.placementOptionId)}
              disabled={expired || confirming}
              className={`w-full text-left border rounded p-3 transition-colors ${
                isSelected
                  ? 'border-blue-400 bg-blue-50/40 dark:bg-blue-950/30 ring-1 ring-blue-400'
                  : expired
                    ? 'border-default dark:border-slate-800 bg-slate-50 dark:bg-slate-900/30 opacity-60 cursor-not-allowed'
                    : 'border-default dark:border-slate-700 hover:border-blue-300 dark:hover:border-blue-600 bg-white dark:bg-slate-900'
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    {isSelected && <CheckCircle2 size={12} className="text-blue-600 dark:text-blue-400 shrink-0" />}
                    <Truck size={12} className="text-tertiary dark:text-slate-500 shrink-0" />
                    <span className="font-mono text-xs text-slate-700 dark:text-slate-300 truncate">
                      {opt.placementOptionId}
                    </span>
                    <StatusBadge status={opt.status} />
                    {isCheapest && <Chip tone="emerald">Cheapest</Chip>}
                    {isFewest && !isCheapest && <Chip tone="sky">Fewest shipments</Chip>}
                    {expLabel && (
                      <span
                        className={`text-[11px] ${
                          expired
                            ? 'text-rose-600 dark:text-rose-400 font-medium'
                            : 'text-slate-500 dark:text-slate-400'
                        }`}
                      >
                        {expLabel}
                      </span>
                    )}
                  </div>

                  <div className="text-xs text-slate-600 dark:text-slate-400">
                    Splits into{' '}
                    <span className="font-semibold tabular-nums text-slate-700 dark:text-slate-300">
                      {shipmentCount}
                    </span>{' '}
                    {shipmentCount === 1 ? 'shipment' : 'shipments'}
                  </div>
                </div>

                <div className="text-right shrink-0">
                  {fees ? (
                    <>
                      <div className="text-sm font-semibold text-slate-900 dark:text-slate-100 tabular-nums">
                        {currencyLabel(fees.total, fees.currency)}
                      </div>
                      <div className="text-[11px] text-slate-500 dark:text-slate-400">
                        {opt.fees?.length ?? 0} fee{(opt.fees?.length ?? 0) === 1 ? '' : 's'}
                      </div>
                    </>
                  ) : (
                    <div className="text-xs text-slate-500 dark:text-slate-400 italic">
                      no fee data
                    </div>
                  )}
                </div>
              </div>

              {/* Selected: show shipmentId previews + fee breakdown */}
              {isSelected && (
                <div className="mt-2 pt-2 border-t border-blue-200 dark:border-blue-900 space-y-1.5">
                  {opt.shipmentIds && opt.shipmentIds.length > 0 && (
                    <div className="space-y-0.5">
                      <div className="text-[11px] uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">
                        Shipment IDs (preview)
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {opt.shipmentIds.slice(0, 6).map((sid) => (
                          <span
                            key={sid}
                            className="font-mono text-[11px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300"
                          >
                            {sid}
                          </span>
                        ))}
                        {opt.shipmentIds.length > 6 && (
                          <span className="text-[11px] text-slate-500 dark:text-slate-400">
                            +{opt.shipmentIds.length - 6} more
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                  {opt.fees && opt.fees.length > 0 && (
                    <div className="space-y-0.5">
                      <div className="text-[11px] uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">
                        Fee breakdown
                      </div>
                      {opt.fees.map((f, i) => (
                        <div key={i} className="flex items-center justify-between text-[11px]">
                          <span className="text-slate-600 dark:text-slate-400">
                            {f.type?.replace(/_/g, ' ').toLowerCase() ?? 'unspecified'}
                          </span>
                          <span className="text-slate-700 dark:text-slate-300 tabular-nums">
                            {f.value
                              ? currencyLabel(f.value.amount, f.value.currencyCode)
                              : '—'}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </button>
          )
        })}
      </div>

      <div className="flex items-center justify-end gap-2 pt-1">
        <button
          onClick={handleConfirm}
          disabled={!selected || confirming || loading}
          className="h-9 px-3 text-sm bg-blue-600 dark:bg-blue-700 text-white rounded hover:bg-blue-700 dark:hover:bg-blue-600 disabled:opacity-50 inline-flex items-center gap-1.5"
        >
          {confirming ? <Loader2 size={12} className="animate-spin" /> : <ChevronRight size={12} />}
          {confirming ? 'Confirming…' : 'Confirm placement'}
        </button>
      </div>
    </div>
  )
}

// ── Small helpers ──────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const tone =
    status === 'OFFERED'
      ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-300 dark:border-emerald-800'
      : status === 'ACCEPTED'
        ? 'bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 border-blue-300 dark:border-blue-800'
        : status === 'EXPIRED'
          ? 'bg-slate-50 dark:bg-slate-900 text-slate-500 dark:text-slate-400 border-slate-300 dark:border-slate-700'
          : 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-300 dark:border-amber-800'
  return (
    <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border ${tone}`}>
      {status}
    </span>
  )
}

function Chip({ children, tone = 'slate' }: { children: React.ReactNode; tone?: 'slate' | 'emerald' | 'sky' }) {
  const cls =
    tone === 'emerald'
      ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-300 dark:border-emerald-800'
      : tone === 'sky'
        ? 'bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300 border-sky-300 dark:border-sky-800'
        : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-default dark:border-slate-700'
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded border ${cls}`}>
      {children}
    </span>
  )
}
