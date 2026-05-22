'use client'

/**
 * RT.3 — Push-latency widget on /insights/live.
 *
 * Charts end-to-end provider-push latency per source:
 *   p50 / p95 / p99 in milliseconds, plus a histogram of where the
 *   sampled deltas fall (0-1s, 1-5s, …, >1h).
 *
 * The chip on /orders + /insights/live (RT.1) tells operators
 * "the push pipeline is alive". This widget tells them "and it's
 * delivering inside SLA" (or doesn't). Without it a degradation —
 * Amazon push latency creeping from 30s to 5min — would only show
 * up as user complaints about stale data.
 *
 * Polls /api/admin/push-latency every 60s. Toggle between 24h + 7d
 * windows.
 */

import { useEffect, useState } from 'react'
import { Card } from '@/components/ui/Card'
import { getBackendUrl } from '@/lib/backend-url'

interface SourceLatency {
  source: 'AMAZON' | 'EBAY' | 'SHOPIFY'
  sampleCount: number
  missingTimestamp: number
  p50Ms: number | null
  p95Ms: number | null
  p99Ms: number | null
  minMs: number | null
  maxMs: number | null
  histogram: Array<{ bucket: string; count: number }>
}

interface LatencyResponse {
  window: '24h' | '7d'
  sources: SourceLatency[]
  checkedAt: string
}

const SOURCE_LABEL: Record<SourceLatency['source'], string> = {
  AMAZON: 'Amazon SP-API',
  EBAY: 'eBay',
  SHOPIFY: 'Shopify',
}

const SOURCE_ACCENT: Record<SourceLatency['source'], string> = {
  AMAZON: 'bg-amber-500',
  EBAY: 'bg-blue-500',
  SHOPIFY: 'bg-emerald-500',
}

function formatMs(ms: number | null): string {
  if (ms === null) return '—'
  if (ms < 1_000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`
  return `${(ms / 3_600_000).toFixed(1)}h`
}

function latencyTone(p95: number | null): string {
  if (p95 === null) return 'text-slate-400'
  if (p95 < 60_000) return 'text-emerald-600 dark:text-emerald-400'
  if (p95 < 5 * 60_000) return 'text-amber-600 dark:text-amber-400'
  return 'text-rose-600 dark:text-rose-400'
}

export function PushLatencyWidget() {
  const [data, setData] = useState<LatencyResponse | null>(null)
  const [window, setWindow] = useState<'24h' | '7d'>('24h')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const res = await fetch(
          `${getBackendUrl()}/api/admin/push-latency?window=${window}`,
          { credentials: 'include', cache: 'no-store' },
        )
        if (!res.ok || cancelled) return
        const d: LatencyResponse = await res.json()
        if (!cancelled) {
          setData(d)
          setLoading(false)
        }
      } catch {
        if (!cancelled) setLoading(false)
      }
    }
    setLoading(true)
    void load()
    const id = setInterval(load, 60_000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [window])

  return (
    <Card
      title="Push latency"
      description="End-to-end provider-push latency per source — provider timestamp → DB write"
      noPadding
    >
      <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center gap-2">
        <span className="text-xs text-slate-500 dark:text-slate-400">Window:</span>
        {(['24h', '7d'] as const).map((w) => (
          <button
            key={w}
            type="button"
            onClick={() => setWindow(w)}
            className={
              window === w
                ? 'text-xs font-medium px-2 py-1 rounded bg-slate-100 dark:bg-slate-800 text-slate-900 dark:text-slate-100'
                : 'text-xs font-medium px-2 py-1 rounded text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800'
            }
          >
            {w}
          </button>
        ))}
        {data && (
          <span className="ml-auto text-[10px] text-slate-400 dark:text-slate-500">
            Updated {new Date(data.checkedAt).toLocaleTimeString('it-IT')}
          </span>
        )}
      </div>

      {loading && !data && (
        <div className="px-4 py-8 text-center text-sm text-slate-400">Loading…</div>
      )}

      {data && (
        <div className="divide-y divide-slate-100 dark:divide-slate-800">
          {data.sources.map((s) => {
            const maxBucket = Math.max(...s.histogram.map((b) => b.count), 1)
            return (
              <div key={s.source} className="px-4 py-3">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span
                      className={`inline-block w-2 h-2 rounded-full ${SOURCE_ACCENT[s.source]}`}
                      aria-hidden="true"
                    />
                    <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                      {SOURCE_LABEL[s.source]}
                    </span>
                  </div>
                  <span className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                    {s.sampleCount} sample{s.sampleCount === 1 ? '' : 's'}
                    {s.missingTimestamp > 0 && (
                      <span
                        className="ml-1 text-slate-400"
                        title="Rows in window without a provider timestamp (excluded from percentile)"
                      >
                        · +{s.missingTimestamp} missing ts
                      </span>
                    )}
                  </span>
                </div>

                <div className="grid grid-cols-3 gap-2 mb-3 text-xs">
                  <Stat label="p50" value={formatMs(s.p50Ms)} tone="slate" />
                  <Stat label="p95" value={formatMs(s.p95Ms)} tone={latencyTone(s.p95Ms)} />
                  <Stat label="p99" value={formatMs(s.p99Ms)} tone={latencyTone(s.p99Ms)} />
                </div>

                {s.sampleCount > 0 ? (
                  <div className="space-y-1">
                    {s.histogram.map((b) => (
                      <div key={b.bucket} className="flex items-center gap-2 text-[10px]">
                        <span className="w-14 text-slate-500 dark:text-slate-400 tabular-nums text-right">
                          {b.bucket}
                        </span>
                        <div className="flex-1 h-2.5 bg-slate-100 dark:bg-slate-800 rounded-sm relative overflow-hidden">
                          <div
                            className={`absolute inset-y-0 left-0 ${SOURCE_ACCENT[s.source]} opacity-80`}
                            style={{ width: `${(b.count / maxBucket) * 100}%` }}
                            aria-hidden="true"
                          />
                        </div>
                        <span className="w-10 text-slate-500 dark:text-slate-400 tabular-nums text-right">
                          {b.count}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-xs text-slate-400 italic py-2">
                    No samples in this window
                    {s.missingTimestamp > 0 && (
                      <> ({s.missingTimestamp} row{s.missingTimestamp === 1 ? '' : 's'} without provider timestamp)</>
                    )}.
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone: string
}) {
  return (
    <div className="rounded border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30 px-2.5 py-1.5">
      <div className="text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">
        {label}
      </div>
      <div className={`text-base font-semibold tabular-nums ${tone}`}>{value}</div>
    </div>
  )
}
