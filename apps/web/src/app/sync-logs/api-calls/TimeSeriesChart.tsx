'use client'

/**
 * L.11.0 — time-series chart for /sync-logs/api-calls.
 *
 * Reads /api/sync-logs/api-calls/timeseries with the active filter
 * window + channel + operation. Renders two stacked panels:
 *
 *   1. Latency p50 / p95 / p99 over time (line chart)
 *   2. Total + failed call count over time (stacked bars), with
 *      error-rate annotation on hover
 *
 * Recharts is already a dep (used by /dashboard/overview's Sparkline).
 * Theme-aware via dark: classes and currentColor on text fills.
 */

import { useEffect, useState } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { Loader2 } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

interface TimeseriesPoint {
  bucket: string
  total: number
  failed: number
  errorRate: number
  p50: number | null
  p95: number | null
  p99: number | null
}

interface TimeseriesResponse {
  bucket: string
  window: { since: string; until: string }
  points: TimeseriesPoint[]
}

export default function TimeSeriesChart({
  sinceMs,
  channel,
  operation,
}: {
  sinceMs: number
  channel: string
  operation: string
}) {
  const [data, setData] = useState<TimeseriesResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    const since = new Date(Date.now() - sinceMs).toISOString()
    const params = new URLSearchParams({ since })
    if (channel) params.set('channel', channel)
    if (operation) params.set('operation', operation)

    fetch(
      `${getBackendUrl()}/api/sync-logs/api-calls/timeseries?${params.toString()}`,
      { cache: 'no-store' },
    )
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((j: TimeseriesResponse) => {
        if (!cancelled) setData(j)
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [sinceMs, channel, operation])

  // Format tick labels — show HH:MM for short windows, MM-DD for longer.
  const isShort = sinceMs <= 48 * 60 * 60 * 1000
  const formatTick = (raw: string): string => {
    const d = new Date(raw)
    if (Number.isNaN(d.getTime())) return ''
    if (isShort) {
      return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
    }
    return `${(d.getMonth() + 1).toString().padStart(2, '0')}-${d.getDate().toString().padStart(2, '0')}`
  }

  if (loading) {
    return (
      <div className="border border-slate-200 dark:border-slate-800 rounded-md bg-white dark:bg-slate-900 p-6 flex items-center justify-center">
        <Loader2 className="w-4 h-4 animate-spin text-slate-400 dark:text-slate-500" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="border border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/40 rounded-md px-3 py-2 text-sm text-rose-800 dark:text-rose-300">
        {error}
      </div>
    )
  }

  if (!data || data.points.length === 0) {
    // No chart when there's no data — KPI strip already shows zeroes
    return null
  }

  const tickStride = Math.max(1, Math.ceil(data.points.length / 8))

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {/* Latency percentiles */}
      <div className="border border-slate-200 dark:border-slate-800 rounded-md bg-white dark:bg-slate-900 px-3 py-2">
        <header className="flex items-center justify-between mb-1">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300">
            Latency over time
          </h3>
          <div className="flex items-center gap-3 text-xs text-slate-500 dark:text-slate-400">
            <span className="inline-flex items-center gap-1">
              <span className="inline-block w-2 h-0.5 bg-slate-400" /> p50
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="inline-block w-2 h-0.5 bg-amber-500" /> p95
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="inline-block w-2 h-0.5 bg-rose-500" /> p99
            </span>
          </div>
        </header>
        <div className="h-[160px]" role="img" aria-label="Latency over time">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={data.points}
              margin={{ top: 4, right: 4, left: 0, bottom: 0 }}
            >
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="rgb(241 245 249)"
                className="dark:[&_line]:stroke-slate-800"
                vertical={false}
              />
              <XAxis
                dataKey="bucket"
                tickFormatter={formatTick}
                interval={tickStride - 1}
                tickLine={false}
                axisLine={false}
                tick={{ fontSize: 10, fill: 'currentColor' }}
                className="text-slate-500 dark:text-slate-400"
              />
              <YAxis
                tickFormatter={(v: number) => `${v}ms`}
                width={48}
                tickLine={false}
                axisLine={false}
                tick={{ fontSize: 10, fill: 'currentColor' }}
                className="text-slate-500 dark:text-slate-400"
              />
              <Tooltip
                contentStyle={{
                  background: '#fff',
                  border: '1px solid rgb(226 232 240)',
                  borderRadius: 6,
                  fontSize: 12,
                  padding: '6px 10px',
                }}
                wrapperClassName="dark:[&>div]:!bg-slate-900 dark:[&>div]:!border-slate-700 dark:[&>div]:!text-slate-100"
                formatter={(value, name) => [`${value ?? '—'}ms`, String(name)]}
                labelFormatter={(raw) => {
                  const d = new Date(String(raw))
                  return d.toLocaleString()
                }}
              />
              <Line
                type="monotone"
                dataKey="p50"
                stroke="rgb(148 163 184)"
                strokeWidth={1.5}
                dot={false}
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                dataKey="p95"
                stroke="rgb(245 158 11)"
                strokeWidth={1.5}
                dot={false}
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                dataKey="p99"
                stroke="rgb(244 63 94)"
                strokeWidth={1.5}
                dot={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Volume + failures */}
      <div className="border border-slate-200 dark:border-slate-800 rounded-md bg-white dark:bg-slate-900 px-3 py-2">
        <header className="flex items-center justify-between mb-1">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300">
            Call volume over time
          </h3>
          <div className="flex items-center gap-3 text-xs text-slate-500 dark:text-slate-400">
            <span className="inline-flex items-center gap-1">
              <span className="inline-block w-2 h-2 bg-emerald-400" /> success
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="inline-block w-2 h-2 bg-rose-500" /> failed
            </span>
          </div>
        </header>
        <div className="h-[160px]" role="img" aria-label="Call volume over time">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={data.points.map((p) => ({
                ...p,
                successful: p.total - p.failed,
              }))}
              margin={{ top: 4, right: 4, left: 0, bottom: 0 }}
            >
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="rgb(241 245 249)"
                className="dark:[&_line]:stroke-slate-800"
                vertical={false}
              />
              <XAxis
                dataKey="bucket"
                tickFormatter={formatTick}
                interval={tickStride - 1}
                tickLine={false}
                axisLine={false}
                tick={{ fontSize: 10, fill: 'currentColor' }}
                className="text-slate-500 dark:text-slate-400"
              />
              <YAxis
                width={36}
                tickLine={false}
                axisLine={false}
                tick={{ fontSize: 10, fill: 'currentColor' }}
                className="text-slate-500 dark:text-slate-400"
              />
              <Tooltip
                contentStyle={{
                  background: '#fff',
                  border: '1px solid rgb(226 232 240)',
                  borderRadius: 6,
                  fontSize: 12,
                  padding: '6px 10px',
                }}
                wrapperClassName="dark:[&>div]:!bg-slate-900 dark:[&>div]:!border-slate-700 dark:[&>div]:!text-slate-100"
                labelFormatter={(raw) => new Date(String(raw)).toLocaleString()}
              />
              <Bar
                dataKey="successful"
                stackId="vol"
                fill="rgb(52 211 153)"
                isAnimationActive={false}
              />
              <Bar
                dataKey="failed"
                stackId="vol"
                fill="rgb(244 63 94)"
                isAnimationActive={false}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  )
}
