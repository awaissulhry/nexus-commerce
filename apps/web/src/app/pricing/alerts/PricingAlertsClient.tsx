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
import { Button } from '@/components/ui/Button'
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

interface DriftRow {
  id: string
  kind: 'DRIFT'
  sku: string
  channel: string
  marketplace: string
  masterPrice: string | null
  listingPrice: string | null
  message: string
  createdAt: string
}

interface AlertsResponse {
  total: number
  counts: {
    fallback: number
    clamped: number
    warnings: number
    drift: number
  }
  rows: AlertRow[]
  driftRows: DriftRow[]
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
        <div className="text-md text-slate-500 py-8 text-center inline-flex items-center justify-center gap-2 w-full">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading alerts…
        </div>
      </Card>
    )
  }

  if (error) {
    return (
      <div className="border border-rose-200 bg-rose-50 rounded px-3 py-2 text-base text-rose-700 inline-flex items-start gap-1.5">
        <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
        <span>{error}</span>
      </div>
    )
  }

  if (!data || (data.rows.length === 0 && data.driftRows.length === 0)) {
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
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <CountTile
          label="Drift"
          value={data.counts.drift}
          tone="rose"
          hint="Listing price drifted from master. Sync-drift detector last 24h."
        />
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
        <Button
          variant="secondary"
          size="md"
          onClick={fetchData}
          icon={<RefreshCw size={12} />}
        >
          Refresh
        </Button>
      </div>

      {/* B.2 — Drift table. Shown above engine alerts because drift means
          actual customer-visible prices are wrong, while engine alerts are
          materialization-time warnings only. */}
      {data.driftRows.length > 0 && (
        <div className="space-y-2">
          <div className="text-sm uppercase tracking-wider text-slate-500 font-semibold">
            Master cascade drift · {data.driftRows.length}
          </div>
          <Card noPadding>
            <div className="overflow-x-auto">
              <table className="w-full text-md">
                <thead className="border-b border-slate-200 bg-rose-50">
                  <tr>
                    <th className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-rose-800">
                      Severity
                    </th>
                    <th className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-rose-800">
                      SKU
                    </th>
                    <th className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-rose-800">
                      Where
                    </th>
                    <th className="px-3 py-2 text-right text-sm font-semibold uppercase tracking-wider text-rose-800">
                      Master
                    </th>
                    <th className="px-3 py-2 text-right text-sm font-semibold uppercase tracking-wider text-rose-800">
                      Listing
                    </th>
                    <th className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-rose-800">
                      Detected
                    </th>
                    <th className="px-3 py-2 w-24"></th>
                  </tr>
                </thead>
                <tbody>
                  {data.driftRows.map((d) => (
                    <tr
                      key={d.id}
                      className="border-b border-slate-100 hover:bg-slate-50"
                    >
                      <td className="px-3 py-2">
                        <SeverityChip tone="rose" label="Drift" />
                      </td>
                      <td className="px-3 py-2 font-mono text-base text-slate-800">
                        {d.sku}
                      </td>
                      <td className="px-3 py-2 text-slate-700">
                        {d.channel}{' '}
                        <span className="text-slate-400">·</span>{' '}
                        <span className="font-mono text-sm">
                          {d.marketplace}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-800">
                        {d.masterPrice
                          ? Number(d.masterPrice).toFixed(2)
                          : '—'}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-rose-700 font-semibold">
                        {d.listingPrice
                          ? Number(d.listingPrice).toFixed(2)
                          : '—'}
                      </td>
                      <td className="px-3 py-2 text-sm text-slate-500">
                        {new Date(d.createdAt).toLocaleString()}
                      </td>
                      <td className="px-3 py-2">
                        <Link
                          href={`/pricing?search=${encodeURIComponent(d.sku)}`}
                          className="text-sm text-blue-600 hover:underline"
                        >
                          Open in pricing →
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}

      {/* Engine-time alerts (clamped / fallback / warnings) */}
      {data.rows.length > 0 && (
        <div className="space-y-2">
          {data.driftRows.length > 0 && (
            <div className="text-sm uppercase tracking-wider text-slate-500 font-semibold">
              Engine resolution alerts · {data.rows.length}
            </div>
          )}
      <Card noPadding>
        <div className="overflow-x-auto">
          <table className="w-full text-md">
            <thead className="border-b border-slate-200 bg-slate-50">
              <tr>
                <th className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700">
                  Severity
                </th>
                <th className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700">
                  SKU
                </th>
                <th className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700">
                  Where
                </th>
                <th className="px-3 py-2 text-right text-sm font-semibold uppercase tracking-wider text-slate-700">
                  Price
                </th>
                <th className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700">
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
                    <td className="px-3 py-2 font-mono text-base text-slate-800">
                      {r.sku}
                    </td>
                    <td className="px-3 py-2 text-slate-700">
                      {r.channel}{' '}
                      <span className="text-slate-400">·</span>{' '}
                      <span className="font-mono text-sm">{r.marketplace}</span>
                      {r.fulfillmentMethod && (
                        <span className="ml-1 text-xs text-slate-500">
                          {r.fulfillmentMethod}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-800">
                      {Number(r.computedPrice).toFixed(2)}{' '}
                      <span className="text-sm text-slate-500">{r.currency}</span>
                    </td>
                    <td className="px-3 py-2 text-base text-slate-700">
                      {reason}
                    </td>
                    <td className="px-3 py-2">
                      <Link
                        href={`/pricing?search=${encodeURIComponent(r.sku)}`}
                        className="text-sm text-blue-600 hover:underline"
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
      )}
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
          <div className="text-base text-slate-700 font-medium">{label}</div>
          <div className="text-sm text-slate-500 mt-0.5">{hint}</div>
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
        'inline-block text-xs font-semibold uppercase tracking-wider px-1.5 py-0.5 border rounded',
        cls,
      )}
    >
      {label}
    </span>
  )
}
