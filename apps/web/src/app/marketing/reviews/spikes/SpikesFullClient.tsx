'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Loader2 } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { CATEGORY_LABEL } from '../_shared/ReviewsNav'

interface SpikeRow {
  id: string
  marketplace: string
  category: string
  rate7dNumerator: number
  rate7dDenominator: number
  rate28dNumerator: number
  rate28dDenominator: number
  spikeMultiplier: string | null
  sampleTopPhrases: string[]
  status: 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED'
  detectedAt: string
  acknowledgedAt: string | null
  acknowledgedBy: string | null
  resolvedAt: string | null
  product: { id: string; sku: string; name: string } | null
}

const STATUS_TONE: Record<SpikeRow['status'], string> = {
  OPEN: 'bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:ring-rose-900',
  ACKNOWLEDGED:
    'bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-900',
  RESOLVED:
    'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-900',
}

export function SpikesFullClient({ initial }: { initial: SpikeRow[] }) {
  const router = useRouter()
  const [items, setItems] = useState<SpikeRow[]>(initial)
  const [statusFilter, setStatusFilter] = useState<string>('OPEN')
  const [marketplaceFilter, setMarketplaceFilter] = useState<string>('')
  const [busy, setBusy] = useState<string | null>(null)

  const marketplaces = useMemo(
    () => Array.from(new Set(initial.map((s) => s.marketplace))).sort(),
    [initial],
  )

  const visible = useMemo(() => {
    let list = items
    if (statusFilter) list = list.filter((s) => s.status === statusFilter)
    if (marketplaceFilter) list = list.filter((s) => s.marketplace === marketplaceFilter)
    return list.sort(
      (a, b) => new Date(b.detectedAt).getTime() - new Date(a.detectedAt).getTime(),
    )
  }, [items, statusFilter, marketplaceFilter])

  async function patch(id: string, status: 'ACKNOWLEDGED' | 'RESOLVED') {
    setBusy(id)
    try {
      const res = await fetch(`${getBackendUrl()}/api/reviews/spikes/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      })
      if (res.ok) {
        const json = (await res.json()) as { spike: SpikeRow }
        setItems((prev) => prev.map((s) => (s.id === id ? { ...s, ...json.spike } : s)))
        router.refresh()
      }
    } finally {
      setBusy(null)
    }
  }

  return (
    <div>
      <div className="flex items-center gap-2 flex-wrap mb-3">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="text-sm rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1"
        >
          <option value="">All statuses</option>
          <option value="OPEN">Open</option>
          <option value="ACKNOWLEDGED">Acknowledged</option>
          <option value="RESOLVED">Resolved</option>
        </select>
        <select
          value={marketplaceFilter}
          onChange={(e) => setMarketplaceFilter(e.target.value)}
          className="text-sm rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1"
        >
          <option value="">All marketplaces</option>
          {marketplaces.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <span className="ml-auto text-xs text-slate-500 dark:text-slate-400">
          {visible.length} of {items.length}
        </span>
      </div>

      {visible.length === 0 ? (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md px-4 py-6 text-center text-sm text-slate-500">
          No spikes matching these filters.
        </div>
      ) : (
        <ul className="space-y-2">
          {visible.map((s) => {
            const rate7 =
              s.rate7dDenominator > 0 ? s.rate7dNumerator / s.rate7dDenominator : 0
            const rate28 =
              s.rate28dDenominator > 0 ? s.rate28dNumerator / s.rate28dDenominator : 0
            return (
              <li
                key={s.id}
                className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md p-3"
              >
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  <span
                    className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ring-1 ring-inset ${
                      STATUS_TONE[s.status]
                    }`}
                  >
                    {s.status === 'OPEN'
                      ? 'Open'
                      : s.status === 'ACKNOWLEDGED'
                        ? 'Acknowledged'
                        : 'Resolved'}
                  </span>
                  <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ring-1 ring-inset bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:ring-rose-900">
                    {CATEGORY_LABEL[s.category] ?? s.category}
                  </span>
                  <span className="font-mono text-xs text-slate-500">{s.marketplace}</span>
                  {s.spikeMultiplier && (
                    <span className="font-mono text-rose-700 dark:text-rose-300 text-sm">
                      {Number(s.spikeMultiplier).toFixed(1)}×
                    </span>
                  )}
                  {s.product && (
                    <Link
                      href={`/marketing/reviews/products/${s.product.id}`}
                      className="text-blue-600 dark:text-blue-400 hover:underline font-mono text-xs"
                    >
                      {s.product.sku}
                    </Link>
                  )}
                  <span className="ml-auto text-xs text-slate-500">
                    {new Date(s.detectedAt).toLocaleString('en-GB', {
                      dateStyle: 'short',
                      timeStyle: 'short',
                    })}
                  </span>
                </div>
                <div className="text-[11px] text-slate-600 dark:text-slate-400 tabular-nums mb-1">
                  7g: {s.rate7dNumerator}/{s.rate7dDenominator} ({(rate7 * 100).toFixed(0)}%) ·
                  28g: {s.rate28dNumerator}/{s.rate28dDenominator} ({(rate28 * 100).toFixed(0)}
                  %)
                </div>
                {s.sampleTopPhrases.length > 0 && (
                  <ul className="space-y-0.5 mb-2">
                    {s.sampleTopPhrases.slice(0, 3).map((p, i) => (
                      <li
                        key={i}
                        className="text-[11px] italic text-slate-600 dark:text-slate-400"
                      >
                        “{p}”
                      </li>
                    ))}
                  </ul>
                )}
                {s.status === 'OPEN' && (
                  <div className="flex items-center gap-2 mt-1">
                    <button
                      type="button"
                      onClick={() => patch(s.id, 'ACKNOWLEDGED')}
                      disabled={busy === s.id}
                      className="text-xs px-2 py-1 rounded ring-1 ring-inset ring-amber-300 text-amber-700 hover:bg-amber-50 dark:ring-amber-700 dark:text-amber-300 dark:hover:bg-amber-950/40 disabled:opacity-40 inline-flex items-center gap-1"
                    >
                      {busy === s.id && <Loader2 className="h-3 w-3 animate-spin" />}
                      Acknowledge
                    </button>
                    <button
                      type="button"
                      onClick={() => patch(s.id, 'RESOLVED')}
                      disabled={busy === s.id}
                      className="text-xs px-2 py-1 rounded ring-1 ring-inset ring-emerald-300 text-emerald-700 hover:bg-emerald-50 dark:ring-emerald-700 dark:text-emerald-300 dark:hover:bg-emerald-950/40 disabled:opacity-40"
                    >
                      Resolve
                    </button>
                  </div>
                )}
                {s.status === 'ACKNOWLEDGED' && (
                  <div className="flex items-center gap-2 mt-1">
                    <button
                      type="button"
                      onClick={() => patch(s.id, 'RESOLVED')}
                      disabled={busy === s.id}
                      className="text-xs px-2 py-1 rounded ring-1 ring-inset ring-emerald-300 text-emerald-700 hover:bg-emerald-50 dark:ring-emerald-700 dark:text-emerald-300 dark:hover:bg-emerald-950/40 disabled:opacity-40 inline-flex items-center gap-1"
                    >
                      {busy === s.id && <Loader2 className="h-3 w-3 animate-spin" />}
                      Resolve
                    </button>
                    {s.acknowledgedBy && (
                      <span className="text-[11px] text-slate-500 ml-2">
                        Acknowledged by {s.acknowledgedBy}
                      </span>
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
