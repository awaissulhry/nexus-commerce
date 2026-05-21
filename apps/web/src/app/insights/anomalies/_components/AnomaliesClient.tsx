'use client'

import { useCallback, useEffect, useState } from 'react'
import { useInsightsLiveRefresh } from '../../_components/useInsightsLiveRefresh'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { AlertOctagon, ArrowDown, ArrowUp, ChevronLeft, Info } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import {
  InsightsHeader,
  KPICard,
  formatNum,
  readFilterState,
  type InsightsFilterState,
} from '@/components/insights'
import { cn } from '@/lib/utils'
import { getBackendUrl } from '@/lib/backend-url'

type AnomalySeverity = 'info' | 'attention' | 'critical'
type AnomalyKind =
  | 'REVENUE_SPIKE'
  | 'REVENUE_DROP'
  | 'ORDERS_SPIKE'
  | 'ORDERS_DROP'
  | 'RETURN_SPIKE'
  | 'AD_SPEND_SPIKE'
  | 'CHANNEL_DROP'

interface AnomalyPoint {
  id: string
  date: string
  kind: AnomalyKind
  severity: AnomalySeverity
  headline: string
  observedValue: number
  expectedMean: number
  expectedStd: number
  zScore: number
  context?: { channel?: string }
}

interface AnomalyReport {
  window: { from: string; to: string }
  referenceWindow: { from: string; to: string }
  items: AnomalyPoint[]
  summary: {
    critical: number
    attention: number
    info: number
  }
}

const SEVERITY_STYLES: Record<
  AnomalySeverity,
  { ring: string; badge: string; iconColor: string }
> = {
  critical: {
    ring: 'border-l-rose-500 bg-rose-50/60 dark:bg-rose-950/40',
    badge: 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300',
    iconColor: 'text-rose-500',
  },
  attention: {
    ring: 'border-l-amber-500 bg-amber-50/60 dark:bg-amber-950/40',
    badge: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
    iconColor: 'text-amber-500',
  },
  info: {
    ring: 'border-l-blue-400 bg-blue-50/40 dark:bg-blue-950/30',
    badge: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
    iconColor: 'text-blue-500',
  },
}

function iconFor(kind: AnomalyKind) {
  if (kind.endsWith('SPIKE')) return ArrowUp
  return ArrowDown
}

function buildQuery(state: InsightsFilterState): URLSearchParams {
  const p = new URLSearchParams()
  if (state.window) p.set('window', state.window)
  if (state.from) p.set('from', state.from)
  if (state.to) p.set('to', state.to)
  if (state.compare) p.set('compare', state.compare)
  if (state.channels.length) p.set('channels', state.channels.join(','))
  if (state.markets.length) p.set('markets', state.markets.join(','))
  if (state.brands.length) p.set('brands', state.brands.join(','))
  return p
}

export default function AnomaliesClient() {
  const params = useSearchParams()
  const filterState = readFilterState(
    new URLSearchParams(params?.toString() ?? ''),
  )
  const [report, setReport] = useState<AnomalyReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  // AL.1 — live refresh on order events (debounced 2s)
  const bumpNonce = useCallback(() => setNonce((n) => n + 1), [])
  useInsightsLiveRefresh(bumpNonce)
  const [severityFilter, setSeverityFilter] = useState<AnomalySeverity | 'all'>('all')

  useEffect(() => {
    let cancelled = false
    async function load() {
      if (report) setRefreshing(true)
      try {
        const qs = buildQuery(filterState).toString()
        const res = await fetch(
          `${getBackendUrl()}/api/insights/anomalies?${qs}`,
          { credentials: 'include' },
        )
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json: AnomalyReport = await res.json()
        if (!cancelled) {
          setReport(json)
          setError(null)
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed')
      } finally {
        if (!cancelled) {
          setLoading(false)
          setRefreshing(false)
        }
      }
    }
    load()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    filterState.window,
    filterState.from,
    filterState.to,
    filterState.compare,
    filterState.channels.join(','),
    filterState.markets.join(','),
    filterState.brands.join(','),
    nonce,
  ])

  const filtered = report
    ? severityFilter === 'all'
      ? report.items
      : report.items.filter((i) => i.severity === severityFilter)
    : []

  return (
    <div className="p-6 max-w-[1400px] mx-auto">
      <div className="mb-2">
        <Link
          href="/insights"
          className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700"
        >
          <ChevronLeft className="w-3 h-3" />
          Insights
        </Link>
      </div>
      <InsightsHeader
        title="Anomalies"
        description="Z-score deviations over the trailing 90-day reference window. Daily revenue, orders, returns, ad spend and per-channel drops."
        filterState={filterState}
        refreshing={refreshing}
        onRefresh={() => setNonce((n) => n + 1)}
      />

      {error && (
        <div className="mb-4 rounded-md border border-rose-200 bg-rose-50 dark:bg-rose-950/40 px-3 py-2 text-sm text-rose-700 dark:text-rose-300">
          {error}
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        <KPICard
          label="Critical"
          value={report ? formatNum(report.summary.critical) : loading ? '…' : '—'}
          accent="rose"
          invertDelta
          onClick={() => setSeverityFilter('critical')}
        />
        <KPICard
          label="Attention"
          value={report ? formatNum(report.summary.attention) : loading ? '…' : '—'}
          accent="amber"
          invertDelta
          onClick={() => setSeverityFilter('attention')}
        />
        <KPICard
          label="Info"
          value={report ? formatNum(report.summary.info) : loading ? '…' : '—'}
          accent="blue"
          onClick={() => setSeverityFilter('info')}
        />
        <KPICard
          label="All"
          value={
            report
              ? formatNum(
                  report.summary.critical +
                    report.summary.attention +
                    report.summary.info,
                )
              : loading
                ? '…'
                : '—'
          }
          accent="slate"
          onClick={() => setSeverityFilter('all')}
        />
      </div>

      <Card
        title={
          severityFilter === 'all'
            ? 'All anomalies'
            : `${severityFilter[0]!.toUpperCase()}${severityFilter.slice(1)} anomalies`
        }
        description="Days where the observed value deviates >2 standard deviations from the 90-day mean"
        action={
          severityFilter !== 'all' && (
            <button
              type="button"
              onClick={() => setSeverityFilter('all')}
              className="text-xs text-slate-500 hover:text-slate-900 dark:hover:text-slate-100"
            >
              Show all
            </button>
          )
        }
      >
        {filtered.length === 0 ? (
          <div className="text-center py-10 text-slate-500">
            {loading ? (
              'Loading…'
            ) : (
              <div className="flex flex-col items-center gap-1.5">
                <Info className="w-6 h-6 opacity-40" />
                <p className="text-sm">
                  No anomalies detected for this window — everything looks normal.
                </p>
              </div>
            )}
          </div>
        ) : (
          <ul className="space-y-2">
            {filtered.map((item) => {
              const styles = SEVERITY_STYLES[item.severity]
              const Icon = iconFor(item.kind)
              return (
                <li
                  key={item.id}
                  className={cn(
                    'rounded-md border-l-2 pl-3 pr-3 py-2 flex items-start gap-3',
                    styles.ring,
                  )}
                >
                  <div className="shrink-0 pt-0.5">
                    {item.severity === 'critical' ? (
                      <AlertOctagon className={cn('w-4 h-4', styles.iconColor)} />
                    ) : (
                      <Icon className={cn('w-4 h-4', styles.iconColor)} />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          'inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider',
                          styles.badge,
                        )}
                      >
                        {item.severity}
                      </span>
                      <span className="text-[11px] text-slate-500 tabular-nums">
                        {item.date}
                      </span>
                      <span className="text-[11px] text-slate-500 font-mono">
                        {item.kind}
                      </span>
                      {item.context?.channel && (
                        <span className="text-[11px] text-slate-500">
                          · {item.context.channel}
                        </span>
                      )}
                    </div>
                    <div className="text-sm text-slate-900 dark:text-slate-100 mt-0.5">
                      {item.headline}
                    </div>
                    <div className="text-[11px] text-slate-500 mt-0.5 tabular-nums">
                      observed {formatNum(item.observedValue)} · mean {formatNum(item.expectedMean)} ± σ{item.expectedStd} · z={item.zScore}
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </Card>
    </div>
  )
}
