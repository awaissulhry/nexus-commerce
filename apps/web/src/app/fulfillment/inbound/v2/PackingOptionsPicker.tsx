'use client'

/**
 * F.6.2 (TECH_DEBT #50) — packing-options picker for the v2024-03-20
 * FBA inbound wizard.
 *
 * Replaces F.5 v1's `prompt('packingOptionId to confirm?')` with a
 * card list showing status / expiration / packing groups / features /
 * fees per option. Operator selects one and confirms.
 *
 * SP-API returns 1+ packing options; the recommended pick is usually
 * the cheapest by fee sum, but the operator might pick another for
 * feature reasons (e.g. avoids INDIVIDUAL_BARCODE_REQUIRED).
 */

import { useEffect, useMemo, useState } from 'react'
import { Loader2, CheckCircle2, ChevronRight, AlertTriangle, Package } from 'lucide-react'
import { useToast } from '@/components/ui/Toast'
import { getBackendUrl } from '@/lib/backend-url'

interface PackingOptionFee {
  type?: string
  value?: { amount: number; currencyCode: string }
  description?: string
  target?: string
}

interface PackingOption {
  packingOptionId: string
  status: string
  expiration?: string
  packingGroups?: string[]
  packingFeatures?: string[]
  fees?: PackingOptionFee[]
}

interface ListResponse {
  packingOptions: PackingOption[]
  nextToken?: string
}

interface PackingOptionsPickerProps {
  planRowId: string
  /** Called after confirm succeeds; parent should refetch the plan list. */
  onConfirmed: () => void
}

function sumFees(fees: PackingOption['fees']): {
  total: number
  currency: string
} | null {
  if (!fees || fees.length === 0) return null
  let total = 0
  let currency = ''
  for (const f of fees) {
    if (!f.value) continue
    if (!currency) currency = f.value.currencyCode
    if (currency !== f.value.currencyCode) {
      // Mixed-currency fees are unusual for a single packing option but
      // SP-API doesn't forbid it. Surface as "—" rather than mixing.
      return null
    }
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

export function PackingOptionsPicker({ planRowId, onConfirmed }: PackingOptionsPickerProps) {
  const { toast } = useToast()
  const [options, setOptions] = useState<PackingOption[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fba/inbound/v2/${planRowId}/packing-options`,
        { credentials: 'include' },
      )
      const j = (await res.json().catch(() => ({}))) as ListResponse & { error?: string }
      if (!res.ok) throw new Error(j?.error ?? `HTTP ${res.status}`)
      setOptions(j.packingOptions ?? [])
      // Auto-select the cheapest valid option as a starting hint.
      const opts = j.packingOptions ?? []
      if (opts.length > 0) {
        const sorted = [...opts].sort((a, b) => {
          const sa = sumFees(a.fees)?.total ?? Infinity
          const sb = sumFees(b.fees)?.total ?? Infinity
          return sa - sb
        })
        setSelected(sorted[0]?.packingOptionId ?? null)
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
      toast.error(msg)
    } finally {
      setLoading(false)
    }
  }

  // Auto-load on first mount.
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
        `${getBackendUrl()}/api/fba/inbound/v2/${planRowId}/packing-options/${encodeURIComponent(selected)}/confirm`,
        { method: 'POST', credentials: 'include' },
      )
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j?.error ?? `HTTP ${res.status}`)
      toast.success('Packing confirmed — listing placement options next')
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
      if (!best || f.total < best.total) best = { id: o.packingOptionId, total: f.total }
    }
    return best
  }, [options])

  if (loading && options === null) {
    return (
      <div className="border border-default dark:border-slate-700 rounded p-4 bg-slate-50 dark:bg-slate-900/50">
        <div className="inline-flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
          <Loader2 size={12} className="animate-spin" />
          Loading packing options from SP-API…
        </div>
      </div>
    )
  }
  if (error) {
    return (
      <div className="border border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/40 rounded p-3 text-sm text-rose-700 dark:text-rose-300">
        <div className="inline-flex items-center gap-1.5 mb-1">
          <AlertTriangle size={12} /> Could not load packing options
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
        No packing options returned by SP-API.
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold flex items-center justify-between">
        <span>{options.length} packing {options.length === 1 ? 'option' : 'options'}</span>
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
          const isSelected = selected === opt.packingOptionId
          const isCheapest = cheapest?.id === opt.packingOptionId && options.length > 1
          const expLabel = expirationLabel(opt.expiration)
          const expired = expLabel === 'EXPIRED'
          return (
            <button
              key={opt.packingOptionId}
              onClick={() => !expired && setSelected(opt.packingOptionId)}
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
                {/* Left: id + groups + features */}
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    {isSelected && <CheckCircle2 size={12} className="text-blue-600 dark:text-blue-400 shrink-0" />}
                    <Package size={12} className="text-tertiary dark:text-slate-500 shrink-0" />
                    <span className="font-mono text-xs text-slate-700 dark:text-slate-300 truncate">
                      {opt.packingOptionId}
                    </span>
                    <StatusBadge status={opt.status} />
                    {isCheapest && <Chip tone="emerald">Cheapest</Chip>}
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

                  {opt.packingGroups && opt.packingGroups.length > 0 && (
                    <div className="text-xs text-slate-600 dark:text-slate-400">
                      {opt.packingGroups.length} packing {opt.packingGroups.length === 1 ? 'group' : 'groups'}
                    </div>
                  )}

                  {opt.packingFeatures && opt.packingFeatures.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {opt.packingFeatures.map((f) => (
                        <Chip key={f} tone="slate">
                          {f.replace(/_/g, ' ').toLowerCase()}
                        </Chip>
                      ))}
                    </div>
                  )}
                </div>

                {/* Right: fees */}
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

              {/* Fee breakdown when selected, for transparency */}
              {isSelected && opt.fees && opt.fees.length > 0 && (
                <div className="mt-2 pt-2 border-t border-blue-200 dark:border-blue-900 space-y-0.5">
                  {opt.fees.map((f, i) => (
                    <div key={i} className="flex items-center justify-between text-[11px]">
                      <span className="text-slate-600 dark:text-slate-400">
                        {f.type?.replace(/_/g, ' ').toLowerCase() ?? 'unspecified'}
                        {f.description ? ` — ${f.description}` : ''}
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
          {confirming ? 'Confirming…' : 'Confirm packing'}
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

function Chip({ children, tone = 'slate' }: { children: React.ReactNode; tone?: 'slate' | 'emerald' }) {
  const cls =
    tone === 'emerald'
      ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-300 dark:border-emerald-800'
      : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-default dark:border-slate-700'
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded border ${cls}`}>
      {children}
    </span>
  )
}
