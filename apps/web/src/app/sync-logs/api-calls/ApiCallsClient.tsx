'use client'

/**
 * L.5.0 — /sync-logs/api-calls drill-down client.
 *
 * Reads:
 *   - GET /api/sync-logs/api-calls            (rollup → KPI strip)
 *   - GET /api/sync-logs/api-calls/recent     (paginated list)
 *
 * URL-shareable filter state via search params:
 *   ?since=ISO  &channel=AMAZON  &errorType=RATE_LIMIT  &success=false
 *
 * The detail panel (right slide-over) shows the full row including
 * any retained request/response payload from the failure path.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import {
  AlertCircle,
  Filter,
  Loader2,
  RefreshCw,
  X,
} from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'

const SINCE_PRESETS = [
  { key: '1h', label: '1h', ms: 60 * 60 * 1000 },
  { key: '24h', label: '24h', ms: 24 * 60 * 60 * 1000 },
  { key: '7d', label: '7d', ms: 7 * 24 * 60 * 60 * 1000 },
  { key: '30d', label: '30d', ms: 30 * 24 * 60 * 60 * 1000 },
] as const

const ERROR_TYPES = [
  'RATE_LIMIT',
  'AUTHENTICATION',
  'VALIDATION',
  'NETWORK',
  'SERVER',
] as const

interface RecentResponse {
  items: ApiCallRow[]
  nextCursor: string | null
  window: { since: string; until: string }
}

interface ApiCallRow {
  id: string
  channel: string
  marketplace: string | null
  connectionId: string | null
  operation: string
  endpoint: string | null
  method: string | null
  statusCode: number | null
  success: boolean
  latencyMs: number
  errorMessage: string | null
  errorCode: string | null
  errorType: string | null
  requestId: string | null
  triggeredBy: string
  requestPayload: unknown
  responsePayload: unknown
  productId: string | null
  listingId: string | null
  orderId: string | null
  createdAt: string
}

interface RollupResponse {
  stats: {
    total: number
    successful: number
    failed: number
    errorRate: number
    latencyP50Ms: number | null
    latencyP95Ms: number | null
    latencyP99Ms: number | null
  }
  byChannel: Array<{ channel: string; count: number }>
}

function fmtRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`
  return new Date(iso).toLocaleString()
}

export default function ApiCallsClient() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const urlSinceKey = (searchParams.get('since') ?? '24h') as
    | (typeof SINCE_PRESETS)[number]['key']
    | string
  const urlChannel = searchParams.get('channel') ?? ''
  const urlErrorType = searchParams.get('errorType') ?? ''
  const urlSuccess = searchParams.get('success') ?? ''

  const [rollup, setRollup] = useState<RollupResponse | null>(null)
  const [recent, setRecent] = useState<ApiCallRow[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<ApiCallRow | null>(null)
  const inFlightRef = useRef<AbortController | null>(null)

  const sinceMs = useMemo(() => {
    const preset = SINCE_PRESETS.find((p) => p.key === urlSinceKey)
    return preset ? preset.ms : 24 * 60 * 60 * 1000
  }, [urlSinceKey])

  const updateUrl = useCallback(
    (patch: Record<string, string>) => {
      const params = new URLSearchParams(searchParams.toString())
      for (const [k, v] of Object.entries(patch)) {
        if (!v) params.delete(k)
        else params.set(k, v)
      }
      const qs = params.toString()
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
    },
    [pathname, router, searchParams],
  )

  const fetchAll = useCallback(
    async (resetCursor = true) => {
      if (inFlightRef.current) inFlightRef.current.abort()
      const controller = new AbortController()
      inFlightRef.current = controller

      if (resetCursor) setLoading(true)
      else setLoadingMore(true)
      setError(null)

      try {
        const since = new Date(Date.now() - sinceMs).toISOString()
        const backend = getBackendUrl()

        const filters: Record<string, string> = { since }
        if (urlChannel) filters.channel = urlChannel
        if (urlErrorType) filters.errorType = urlErrorType
        if (urlSuccess) filters.success = urlSuccess

        const qs = new URLSearchParams(filters)
        const recentParams = new URLSearchParams(qs)
        recentParams.set('limit', '50')
        if (!resetCursor && nextCursor) recentParams.set('cursor', nextCursor)

        const fetches: Promise<Response>[] = [
          fetch(
            `${backend}/api/sync-logs/api-calls/recent?${recentParams.toString()}`,
            { cache: 'no-store', signal: controller.signal },
          ),
        ]
        if (resetCursor) {
          fetches.push(
            fetch(
              `${backend}/api/sync-logs/api-calls?${qs.toString()}`,
              { cache: 'no-store', signal: controller.signal },
            ),
          )
        }
        const responses = await Promise.all(fetches)
        const recentRes = responses[0]
        const rollupRes = resetCursor ? responses[1] : undefined

        if (!recentRes.ok) throw new Error(`HTTP ${recentRes.status}`)
        const recentJson = (await recentRes.json()) as RecentResponse

        if (resetCursor) {
          setRecent(recentJson.items)
          setNextCursor(recentJson.nextCursor)
          if (rollupRes && rollupRes.ok) {
            setRollup((await rollupRes.json()) as RollupResponse)
          }
        } else {
          setRecent((prev) => [...prev, ...recentJson.items])
          setNextCursor(recentJson.nextCursor)
        }
      } catch (e) {
        if (e instanceof Error && e.name === 'AbortError') return
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (resetCursor) setLoading(false)
        else setLoadingMore(false)
      }
    },
    [sinceMs, urlChannel, urlErrorType, urlSuccess, nextCursor],
  )

  useEffect(() => {
    void fetchAll(true)
    // fetchAll changes when filters change; avoid loop by depending only
    // on filter inputs, not nextCursor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sinceMs, urlChannel, urlErrorType, urlSuccess])

  return (
    <div className="space-y-3">
      {/* Filter bar */}
      <div className="space-y-2">
        <div className="flex items-center gap-1 flex-wrap">
          <span className="text-xs uppercase tracking-wider text-slate-500 font-medium mr-1 inline-flex items-center gap-1">
            <Filter className="w-3 h-3" /> Window
          </span>
          {SINCE_PRESETS.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => updateUrl({ since: p.key })}
              className={cn(
                'px-2 py-0.5 text-sm font-medium rounded border transition-colors',
                urlSinceKey === p.key
                  ? 'bg-slate-900 text-white border-slate-900'
                  : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300',
              )}
            >
              {p.label}
            </button>
          ))}

          <span className="ml-3 text-xs uppercase tracking-wider text-slate-500 font-medium mr-1">
            Channel
          </span>
          {(rollup?.byChannel ?? []).map((c) => (
            <button
              key={c.channel}
              type="button"
              onClick={() =>
                updateUrl({
                  channel: urlChannel === c.channel ? '' : c.channel,
                })
              }
              className={cn(
                'px-2 py-0.5 text-sm font-medium rounded border transition-colors',
                urlChannel === c.channel
                  ? 'bg-slate-900 text-white border-slate-900'
                  : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300',
              )}
            >
              {c.channel}
              <span className="ml-1 opacity-70">{c.count}</span>
            </button>
          ))}

          <span className="ml-3 text-xs uppercase tracking-wider text-slate-500 font-medium mr-1">
            Error
          </span>
          {ERROR_TYPES.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() =>
                updateUrl({
                  errorType: urlErrorType === t ? '' : t,
                  success: urlErrorType === t ? '' : 'false',
                })
              }
              className={cn(
                'px-2 py-0.5 text-sm font-medium rounded border transition-colors',
                urlErrorType === t
                  ? 'bg-rose-600 text-white border-rose-600'
                  : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300',
              )}
            >
              {t}
            </button>
          ))}

          <button
            type="button"
            onClick={() =>
              updateUrl({
                success: urlSuccess === 'false' ? '' : 'false',
                errorType: '',
              })
            }
            className={cn(
              'ml-3 px-2 py-0.5 text-sm font-medium rounded border transition-colors',
              urlSuccess === 'false'
                ? 'bg-rose-600 text-white border-rose-600'
                : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300',
            )}
          >
            Failures only
          </button>

          <Button
            variant="secondary"
            size="sm"
            onClick={() => void fetchAll(true)}
            disabled={loading}
            className="ml-auto"
          >
            {loading ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <RefreshCw className="w-3.5 h-3.5" />
            )}
            Refresh
          </Button>
        </div>
      </div>

      {/* KPI strip */}
      {rollup && (
        <section className="border border-slate-200 rounded-md px-4 py-3 grid grid-cols-2 md:grid-cols-5 gap-3 bg-white">
          <Kpi label="Total" value={rollup.stats.total} />
          <Kpi
            label="Failed"
            value={rollup.stats.failed}
            tone={rollup.stats.failed === 0 ? 'good' : 'bad'}
          />
          <Kpi
            label="Error rate"
            value={`${(rollup.stats.errorRate * 100).toFixed(2)}%`}
            tone={
              rollup.stats.errorRate >= 0.05
                ? 'bad'
                : rollup.stats.errorRate >= 0.01
                  ? 'warn'
                  : 'good'
            }
          />
          <Kpi
            label="p95 latency"
            value={
              rollup.stats.latencyP95Ms !== null
                ? `${rollup.stats.latencyP95Ms}ms`
                : '—'
            }
            tone={
              rollup.stats.latencyP95Ms == null
                ? 'default'
                : rollup.stats.latencyP95Ms > 5000
                  ? 'bad'
                  : rollup.stats.latencyP95Ms > 2000
                    ? 'warn'
                    : 'good'
            }
          />
          <Kpi
            label="p99 latency"
            value={
              rollup.stats.latencyP99Ms !== null
                ? `${rollup.stats.latencyP99Ms}ms`
                : '—'
            }
          />
        </section>
      )}

      {error && (
        <div className="border border-rose-200 bg-rose-50 rounded-md px-3 py-2 text-base text-rose-800 flex items-center gap-2">
          <AlertCircle className="w-3.5 h-3.5" /> {error}
        </div>
      )}

      {loading && recent.length === 0 ? (
        <div className="space-y-2">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div
              key={i}
              className="h-10 bg-white border border-slate-200 rounded-md animate-pulse"
            />
          ))}
        </div>
      ) : recent.length === 0 ? (
        <EmptyState
          icon={Filter}
          title="No API calls in this window"
          description="Try widening the time range, removing filters, or wait for the next cron tick to populate the log."
        />
      ) : (
        <div className="border border-slate-200 rounded-md bg-white overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="px-3 py-1.5 text-left font-semibold text-slate-700 uppercase tracking-wider w-2"></th>
                <th className="px-3 py-1.5 text-left font-semibold text-slate-700 uppercase tracking-wider w-20">
                  Time
                </th>
                <th className="px-3 py-1.5 text-left font-semibold text-slate-700 uppercase tracking-wider w-20">
                  Channel
                </th>
                <th className="px-3 py-1.5 text-left font-semibold text-slate-700 uppercase tracking-wider">
                  Operation
                </th>
                <th className="px-3 py-1.5 text-left font-semibold text-slate-700 uppercase tracking-wider w-16">
                  Status
                </th>
                <th className="px-3 py-1.5 text-right font-semibold text-slate-700 uppercase tracking-wider w-16">
                  Latency
                </th>
                <th className="px-3 py-1.5 text-left font-semibold text-slate-700 uppercase tracking-wider">
                  Error
                </th>
              </tr>
            </thead>
            <tbody>
              {recent.map((r) => (
                <tr
                  key={r.id}
                  onClick={() => setSelected(r)}
                  className={cn(
                    'border-b border-slate-100 hover:bg-slate-50 cursor-pointer transition-colors',
                    !r.success && 'bg-rose-50/30',
                  )}
                >
                  <td className="px-3 py-1.5">
                    <span
                      className={cn(
                        'w-1.5 h-1.5 rounded-full inline-block',
                        r.success ? 'bg-emerald-500' : 'bg-rose-500',
                      )}
                      aria-hidden
                    />
                  </td>
                  <td className="px-3 py-1.5 text-xs text-slate-500 whitespace-nowrap">
                    {fmtRelative(r.createdAt)}
                  </td>
                  <td className="px-3 py-1.5 font-medium text-slate-700">
                    {r.channel}
                  </td>
                  <td className="px-3 py-1.5 font-mono text-slate-700 truncate max-w-md">
                    {r.operation}
                  </td>
                  <td className="px-3 py-1.5 font-mono text-xs text-slate-500">
                    {r.statusCode ?? '—'}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-xs text-slate-500 whitespace-nowrap">
                    {r.latencyMs}ms
                  </td>
                  <td className="px-3 py-1.5 truncate max-w-md">
                    {r.errorType && (
                      <Badge
                        variant={
                          r.errorType === 'AUTHENTICATION' ||
                          r.errorType === 'SERVER'
                            ? 'danger'
                            : r.errorType === 'RATE_LIMIT'
                              ? 'warning'
                              : 'default'
                        }
                        size="sm"
                      >
                        {r.errorType}
                      </Badge>
                    )}
                    {r.errorMessage && (
                      <span
                        className="ml-2 text-xs text-rose-700 truncate"
                        title={r.errorMessage}
                      >
                        {r.errorMessage}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {nextCursor && (
            <div className="border-t border-slate-200 p-2 flex justify-center">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void fetchAll(false)}
                disabled={loadingMore}
              >
                {loadingMore ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : null}
                Load more
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Detail slide-over */}
      {selected && <DetailPanel row={selected} onClose={() => setSelected(null)} />}
    </div>
  )
}

function DetailPanel({
  row,
  onClose,
}: {
  row: ApiCallRow
  onClose: () => void
}) {
  return (
    <div
      className="fixed inset-0 z-40 flex justify-end"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="absolute inset-0 bg-slate-900/30"
        aria-hidden
      />
      <aside
        className="relative w-full max-w-2xl bg-white shadow-2xl border-l border-slate-200 overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="API call detail"
      >
        <header className="px-4 py-3 border-b border-slate-200 sticky top-0 bg-white flex items-center justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  'w-2 h-2 rounded-full inline-block',
                  row.success ? 'bg-emerald-500' : 'bg-rose-500',
                )}
                aria-hidden
              />
              <span className="font-mono text-base font-semibold text-slate-900 truncate">
                {row.operation}
              </span>
            </div>
            <div className="text-xs text-slate-500 mt-0.5 flex items-center gap-2 flex-wrap">
              <span>{row.channel}</span>
              {row.marketplace && <span>· {row.marketplace}</span>}
              <span>· {row.method ?? '—'}</span>
              <span>· {row.statusCode ?? '—'}</span>
              <span>· {row.latencyMs}ms</span>
              <span>· {fmtRelative(row.createdAt)}</span>
              <span>· {row.triggeredBy}</span>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-slate-700"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </header>

        <div className="px-4 py-3 space-y-4">
          {row.endpoint && (
            <Section label="Endpoint">
              <pre className="text-xs font-mono bg-slate-50 px-2 py-1.5 rounded overflow-x-auto whitespace-pre-wrap break-all">
                {row.endpoint}
              </pre>
            </Section>
          )}

          {row.errorMessage && (
            <Section label="Error">
              <div className="space-y-1">
                {row.errorType && (
                  <Badge variant="danger" size="md">
                    {row.errorType}
                  </Badge>
                )}
                {row.errorCode && (
                  <Badge variant="default" size="md" className="ml-2">
                    {row.errorCode}
                  </Badge>
                )}
                <pre className="text-xs font-mono bg-rose-50 border border-rose-200 px-2 py-1.5 rounded overflow-x-auto whitespace-pre-wrap break-all text-rose-900">
                  {row.errorMessage}
                </pre>
              </div>
            </Section>
          )}

          {row.requestId && (
            <Section label="Request ID">
              <code className="text-xs font-mono bg-slate-50 px-2 py-1 rounded">
                {row.requestId}
              </code>
            </Section>
          )}

          {row.requestPayload != null && (
            <Section label="Request payload">
              <pre className="text-xs font-mono bg-slate-50 px-2 py-1.5 rounded overflow-x-auto max-h-64 whitespace-pre-wrap break-all">
                {JSON.stringify(row.requestPayload, null, 2)}
              </pre>
            </Section>
          )}

          {row.responsePayload != null && (
            <Section label="Response payload">
              <pre className="text-xs font-mono bg-slate-50 px-2 py-1.5 rounded overflow-x-auto max-h-64 whitespace-pre-wrap break-all">
                {JSON.stringify(row.responsePayload, null, 2)}
              </pre>
            </Section>
          )}

          {(row.productId || row.listingId || row.orderId) && (
            <Section label="Related entities">
              <div className="flex flex-wrap gap-2">
                {row.productId && (
                  <a
                    href={`/products?drawer=${row.productId}`}
                    className="text-sm text-blue-700 hover:underline"
                  >
                    Product {row.productId.slice(0, 12)}…
                  </a>
                )}
                {row.listingId && (
                  <a
                    href={`/listings?drawer=${row.listingId}`}
                    className="text-sm text-blue-700 hover:underline"
                  >
                    Listing {row.listingId.slice(0, 12)}…
                  </a>
                )}
                {row.orderId && (
                  <a
                    href={`/orders/${row.orderId}`}
                    className="text-sm text-blue-700 hover:underline"
                  >
                    Order {row.orderId.slice(0, 12)}…
                  </a>
                )}
              </div>
            </Section>
          )}
        </div>
      </aside>
    </div>
  )
}

function Section({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold mb-1">
        {label}
      </div>
      {children}
    </div>
  )
}

function Kpi({
  label,
  value,
  tone = 'default',
}: {
  label: string
  value: string | number
  tone?: 'good' | 'warn' | 'bad' | 'default'
}) {
  const valueClass =
    tone === 'good'
      ? 'text-emerald-700'
      : tone === 'warn'
        ? 'text-amber-700'
        : tone === 'bad'
          ? 'text-rose-700'
          : 'text-slate-900'
  return (
    <div>
      <div className="text-xs text-slate-500 uppercase tracking-wider">
        {label}
      </div>
      <div className={`text-[20px] font-semibold tabular-nums ${valueClass}`}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
    </div>
  )
}
