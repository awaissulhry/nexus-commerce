'use client'

// G.4.2 — Outlier alerts page. Reads /api/pricing/alerts (PricingSnapshot
// rows where source=FALLBACK, isClamped=true, or warnings non-empty).

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  RefreshCw,
} from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'

interface AlertRow {
  id: string
  sku: string
  channel: string
  marketplace: string
  fulfillmentMethod: string | null
  computedPrice: string
  currency: string
  source: string
  warnings: string[]
  isClamped: boolean
  clampedFrom: string | null
  computedAt: string
}

interface AlertsResponse {
  total: number
  counts: {
    fallback: number
    clamped: number
    warnings: number
  }
  rows: AlertRow[]
}

export default function PricingAlertsClient() {
  const [data, setData] = useState<AlertsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`${getBackendUrl()}/api/pricing/alerts`, {
        cache: 'no-store',
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setData(await res.json())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  if (loading && !data) {
    return (
      <Card>
        <div className="text-[13px] text-slate-500 py-8 text-center inline-flex items-center justify-center gap-2 w-full">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading alerts…
        </div>
      </Card>
    )
  }

  if (error) {
    return (
      <div className="border border-rose-200 bg-rose-50 rounded px-3 py-2 text-[12px] text-rose-700 inline-flex items-start gap-1.5">
        <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
        <span>{error}</span>
      </div>
    )
  }

  if (!data || data.rows.length === 0) {
    return (
      <EmptyState
        icon={CheckCircle2}
        title="No pricing alerts"
        description="Every snapshot resolved cleanly within its constraints."
      />
    )
  }

  return (
    <div className="space-y-4">
      {/* Counts banner */}
      <div className="grid grid-cols-3 gap-3">
        <CountTile
          label="No resolution"
          value={data.counts.fallback}
          tone="rose"
          hint="Engine had no master price or rules to fall back to."
        />
        <CountTile
          label="Clamped"
          value={data.counts.clamped}
          tone="amber"
          hint="Engine had to floor or ceiling-cap the computed price."
        />
        <CountTile
          label="Warnings only"
          value={data.counts.warnings}
          tone="blue"
          hint="Resolution succeeded but with caveats — review the breakdown."
        />
      </div>

      {/* Refresh */}
      <div className="flex items-center justify-end">
        <button
          onClick={fetchData}
          className="h-8 px-3 text-[12px] border border-slate-200 rounded-md hover:bg-slate-50 inline-flex items-center gap-1.5"
        >
          <RefreshCw size={12} /> Refresh
        </button>
      </div>

      {/* Table */}
      <Card noPadding>
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead className="border-b border-slate-200 bg-slate-50">
              <tr>
                <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-700">
                  Severity
                </th>
                <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-700">
                  SKU
                </th>
                <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-700">
                  Where
                </th>
                <th className="px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wider text-slate-700">
                  Price
                </th>
                <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-700">
                  Reason
                </th>
                <th className="px-3 py-2 w-24"></th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => {
                const severity =
                  r.source === 'FALLBACK'
                    ? { tone: 'rose', label: 'No resolution' }
                    : r.isClamped
                    ? { tone: 'amber', label: 'Clamped' }
                    : { tone: 'blue', label: 'Warning' }
                const reason =
                  r.source === 'FALLBACK'
                    ? 'Engine returned 0 — no master / variant / rule found'
                    : r.isClamped
                    ? `Clamped from ${r.clampedFrom} to ${r.computedPrice} ${r.currency}`
                    : r.warnings.join('; ') || '—'
                return (
                  <tr
                    key={r.id}
                    className="border-b border-slate-100 hover:bg-slate-50"
                  >
                    <td className="px-3 py-2">
                      <SeverityChip tone={severity.tone} label={severity.label} />
                    </td>
                    <td className="px-3 py-2 font-mono text-[12px] text-slate-800">
                      {r.sku}
                    </td>
                    <td className="px-3 py-2 text-slate-700">
                      {r.channel}{' '}
                      <span className="text-slate-400">·</span>{' '}
                      <span className="font-mono text-[11px]">{r.marketplace}</span>
                      {r.fulfillmentMethod && (
                        <span className="ml-1 text-[10px] text-slate-500">
                          {r.fulfillmentMethod}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-800">
                      {Number(r.computedPrice).toFixed(2)}{' '}
                      <span className="text-[11px] text-slate-500">{r.currency}</span>
                    </td>
                    <td className="px-3 py-2 text-[12px] text-slate-700">
                      {reason}
                    </td>
                    <td className="px-3 py-2">
                      <Link
                        href={`/pricing?search=${encodeURIComponent(r.sku)}`}
                        className="text-[11px] text-blue-600 hover:underline"
                      >
                        Open in pricing →
                      </Link>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}

function CountTile({
  label,
  value,
  tone,
  hint,
}: {
  label: string
  value: number
  tone: 'rose' | 'amber' | 'blue'
  hint: string
}) {
  const toneClasses = {
    rose: 'border-rose-200 bg-rose-50',
    amber: 'border-amber-200 bg-amber-50',
    blue: 'border-blue-200 bg-blue-50',
  }[tone]
  const textTone = {
    rose: 'text-rose-700',
    amber: 'text-amber-700',
    blue: 'text-blue-700',
  }[tone]
  return (
    <Card>
      <div className={cn('flex items-start gap-3', toneClasses, 'p-1 -m-1 rounded')}>
        <AlertTriangle size={16} className={textTone} />
        <div>
          <div className={cn('text-[24px] font-semibold tabular-nums', textTone)}>
            {value}
          </div>
          <div className="text-[12px] text-slate-700 font-medium">{label}</div>
          <div className="text-[11px] text-slate-500 mt-0.5">{hint}</div>
        </div>
      </div>
    </Card>
  )
}

function SeverityChip({ tone, label }: { tone: string; label: string }) {
  const cls =
    tone === 'rose'
      ? 'bg-rose-50 text-rose-700 border-rose-200'
      : tone === 'amber'
      ? 'bg-amber-50 text-amber-700 border-amber-200'
      : 'bg-blue-50 text-blue-700 border-blue-200'
  return (
    <span
      className={cn(
        'inline-block text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 border rounded',
        cls,
      )}
    >
      {label}
    </span>
  )
}
