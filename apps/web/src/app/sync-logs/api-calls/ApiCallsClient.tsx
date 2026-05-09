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
  Download,
  Filter,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  X,
} from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import TimeSeriesChart from './TimeSeriesChart'
import SavedSearchPicker from '../_shared/SavedSearchPicker'
import { getBackendUrl } from '@/lib/backend-url'
import { useTranslations } from '@/lib/i18n/use-translations'
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
  const { t } = useTranslations()

  const urlSinceKey = (searchParams.get('since') ?? '24h') as
    | (typeof SINCE_PRESETS)[number]['key']
    | string
  const urlChannel = searchParams.get('channel') ?? ''
  const urlErrorType = searchParams.get('errorType') ?? ''
  const urlSuccess = searchParams.get('success') ?? ''
  const urlRequestId = searchParams.get('requestId') ?? ''
  const urlOperation = searchParams.get('operation') ?? ''
  const urlProductId = searchParams.get('productId') ?? ''
  const urlListingId = searchParams.get('listingId') ?? ''
  const urlOrderId = searchParams.get('orderId') ?? ''

  const [rollup, setRollup] = useState<RollupResponse | null>(null)
  const [recent, setRecent] = useState<ApiCallRow[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<ApiCallRow | null>(null)
  const [highlightIndex, setHighlightIndex] = useState<number>(-1)
  const [live, setLive] = useState(false)
  const [liveStatus, setLiveStatus] = useState<
    'connecting' | 'open' | 'error' | 'closed'
  >('closed')
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
        if (urlRequestId) filters.requestId = urlRequestId
        if (urlOperation) filters.operation = urlOperation
        if (urlProductId) filters.productId = urlProductId
        if (urlListingId) filters.listingId = urlListingId
        if (urlOrderId) filters.orderId = urlOrderId

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
    [sinceMs, urlChannel, urlErrorType, urlSuccess, urlRequestId, urlOperation, urlProductId, urlListingId, urlOrderId, nextCursor],
  )

  useEffect(() => {
    void fetchAll(true)
    // fetchAll changes when filters change; avoid loop by depending only
    // on filter inputs, not nextCursor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sinceMs, urlChannel, urlErrorType, urlSuccess, urlRequestId, urlOperation, urlProductId, urlListingId, urlOrderId])

  // L.7.0 — live tail. Opens an EventSource against the backend SSE
  // endpoint while `live` is true. Each api-call.recorded event is
  // prepended to the table after passing the active filter set
  // (server doesn't filter the stream — too dynamic — so the client
  // applies the same predicate that scopes the rest fetch).
  useEffect(() => {
    if (!live) return
    setLiveStatus('connecting')
    const backend = getBackendUrl()
    const es = new EventSource(`${backend}/api/sync-logs/events`)

    es.onopen = () => setLiveStatus('open')
    es.onerror = () => setLiveStatus('error')
    es.onmessage = (msg) => {
      try {
        const event = JSON.parse(msg.data) as
          | { type: 'ping' }
          | {
              type: 'api-call.recorded'
              ts: number
              id: string
              channel: string
              marketplace: string | null
              operation: string
              statusCode: number | null
              success: boolean
              latencyMs: number
              errorType: string | null
              errorMessage: string | null
            }
        if (event.type !== 'api-call.recorded') return

        // Apply active filter predicates (mirror buildWhere on backend).
        if (urlChannel && event.channel !== urlChannel) return
        if (urlErrorType && event.errorType !== urlErrorType) return
        if (urlSuccess === 'false' && event.success) return
        if (urlSuccess === 'true' && !event.success) return

        setRecent((prev) => {
          if (prev.some((r) => r.id === event.id)) return prev
          const row: ApiCallRow = {
            id: event.id,
            channel: event.channel,
            marketplace: event.marketplace,
            connectionId: null,
            operation: event.operation,
            endpoint: null,
            method: null,
            statusCode: event.statusCode,
            success: event.success,
            latencyMs: event.latencyMs,
            errorMessage: event.errorMessage,
            errorCode: null,
            errorType: event.errorType,
            requestId: null,
            triggeredBy: 'api',
            requestPayload: null,
            responsePayload: null,
            productId: null,
            listingId: null,
            orderId: null,
            createdAt: new Date(event.ts).toISOString(),
          }
          // Cap the prepended live tail at 500 to keep memory bounded.
          return [row, ...prev].slice(0, 500)
        })
      } catch {
        // ignore malformed SSE frames
      }
    }

    return () => {
      es.close()
      setLiveStatus('closed')
    }
  }, [live, urlChannel, urlErrorType, urlSuccess])

  // L.20.0 — keyboard shortcuts (Linear-style):
  //   j        next row
  //   k        previous row
  //   Enter    open selected row's detail
  //   Esc      close detail panel
  //   /        focus the URL bar's filter (we don't have a search
  //            box yet so this is a no-op until L.x)
  // Skipped while typing into an input/textarea or while the detail
  // slide-over is already open (Esc closes it; nothing else applies).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      const tag = target?.tagName?.toLowerCase()
      const isTyping =
        tag === 'input' ||
        tag === 'textarea' ||
        tag === 'select' ||
        target?.isContentEditable
      if (selected) {
        if (e.key === 'Escape') {
          e.preventDefault()
          setSelected(null)
        }
        return
      }
      if (isTyping) return
      if (e.key === 'j') {
        e.preventDefault()
        setHighlightIndex((i) => Math.min(recent.length - 1, i + 1))
      } else if (e.key === 'k') {
        e.preventDefault()
        setHighlightIndex((i) => Math.max(0, i - 1))
      } else if (e.key === 'Enter' && highlightIndex >= 0) {
        const row = recent[highlightIndex]
        if (row) {
          e.preventDefault()
          setSelected(row)
        }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [recent, highlightIndex, selected])

  // Reset highlight when filters change so we don't hold a stale index.
  useEffect(() => {
    setHighlightIndex(-1)
  }, [urlChannel, urlErrorType, urlSuccess, urlSinceKey, urlOperation, urlRequestId])

  return (
    <div className="space-y-3">
      {/* Filter bar */}
      <div className="space-y-2">
        <div className="flex items-center gap-x-1 gap-y-1.5 flex-wrap">
          <span className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-500 font-medium mr-1 inline-flex items-center gap-1">
            <Filter className="w-3 h-3" /> {t('syncLogs.apiCalls.filter.window')}
          </span>
          {SINCE_PRESETS.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => updateUrl({ since: p.key })}
              className={cn(
                'px-2 py-0.5 text-sm font-medium rounded border transition-colors',
                urlSinceKey === p.key
                  ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 border-slate-900 dark:border-slate-100'
                  : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700',
              )}
            >
              {p.label}
            </button>
          ))}

          <span className="ml-3 text-xs uppercase tracking-wider text-slate-500 dark:text-slate-500 font-medium mr-1">
            {t('syncLogs.apiCalls.filter.channel')}
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
                  ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 border-slate-900 dark:border-slate-100'
                  : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700',
              )}
            >
              {c.channel}
              <span className="ml-1 opacity-70">{c.count}</span>
            </button>
          ))}

          <span className="ml-3 text-xs uppercase tracking-wider text-slate-500 dark:text-slate-500 font-medium mr-1">
            {t('syncLogs.apiCalls.filter.error')}
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
                  : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700',
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
                : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700',
            )}
          >
            {t('syncLogs.apiCalls.filter.failuresOnly')}
          </button>

          {/* L.14.1 — operation chip. Visible only when filtering by
              a specific operation (set via deep-link from the hub
              byOperation list); click X to clear. */}
          {urlOperation && (
            <button
              type="button"
              onClick={() => updateUrl({ operation: '' })}
              className="px-2 py-0.5 text-sm font-mono rounded border border-blue-300 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 inline-flex items-center gap-1.5 hover:bg-blue-100 dark:hover:bg-blue-950/60 transition-colors"
              title={t('syncLogs.apiCalls.filter.clearOperation')}
            >
              {t('syncLogs.apiCalls.filter.opPrefix', { value: urlOperation })}
              <X className="w-3 h-3" />
            </button>
          )}

          {/* L.22.0 — entity-scope chips (productId / listingId /
              orderId). Set when an operator deep-links from a
              product / listing / order page; click X to clear. */}
          {urlProductId && (
            <button
              type="button"
              onClick={() => updateUrl({ productId: '' })}
              className="px-2 py-0.5 text-sm font-mono rounded border border-blue-300 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 inline-flex items-center gap-1.5 hover:bg-blue-100 dark:hover:bg-blue-950/60 transition-colors"
              title="Clear product filter"
            >
              product: {urlProductId.slice(0, 12)}
              {urlProductId.length > 12 && '…'}
              <X className="w-3 h-3" />
            </button>
          )}
          {urlListingId && (
            <button
              type="button"
              onClick={() => updateUrl({ listingId: '' })}
              className="px-2 py-0.5 text-sm font-mono rounded border border-blue-300 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 inline-flex items-center gap-1.5 hover:bg-blue-100 dark:hover:bg-blue-950/60 transition-colors"
              title="Clear listing filter"
            >
              listing: {urlListingId.slice(0, 12)}
              {urlListingId.length > 12 && '…'}
              <X className="w-3 h-3" />
            </button>
          )}
          {urlOrderId && (
            <button
              type="button"
              onClick={() => updateUrl({ orderId: '' })}
              className="px-2 py-0.5 text-sm font-mono rounded border border-blue-300 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 inline-flex items-center gap-1.5 hover:bg-blue-100 dark:hover:bg-blue-950/60 transition-colors"
              title="Clear order filter"
            >
              order: {urlOrderId.slice(0, 12)}
              {urlOrderId.length > 12 && '…'}
              <X className="w-3 h-3" />
            </button>
          )}

          {/* L.12.0 — request-id chip. Visible only when filtering
              by a specific request; click X to clear. */}
          {urlRequestId && (
            <button
              type="button"
              onClick={() => updateUrl({ requestId: '' })}
              className="px-2 py-0.5 text-sm font-mono rounded border border-blue-300 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 inline-flex items-center gap-1.5 hover:bg-blue-100 dark:hover:bg-blue-950/60 transition-colors"
              title={t('syncLogs.apiCalls.filter.clearRequestId')}
            >
              {t('syncLogs.apiCalls.filter.reqPrefix', {
                value: urlRequestId.slice(0, 12) + (urlRequestId.length > 12 ? '…' : ''),
              })}
              <X className="w-3 h-3" />
            </button>
          )}

          <span
            className="ml-auto hidden md:inline-flex items-center gap-1 text-xs text-slate-400 dark:text-slate-500"
            aria-hidden
            title="Use j/k to navigate rows, Enter to open, Esc to close"
          >
            <kbd className="px-1 py-0.5 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 font-mono text-[10px]">
              j
            </kbd>
            <kbd className="px-1 py-0.5 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 font-mono text-[10px]">
              k
            </kbd>
            navigate
          </span>

          <button
            type="button"
            onClick={() => setLive((v) => !v)}
            className={cn(
              'h-7 px-2 text-sm font-medium rounded border inline-flex items-center gap-1.5 transition-colors',
              live
                ? 'bg-emerald-600 text-white border-emerald-600 hover:bg-emerald-700'
                : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700',
            )}
            title={live ? t('syncLogs.apiCalls.live.pause') : t('syncLogs.apiCalls.live.start')}
          >
            {live ? (
              <Pause className="w-3 h-3" />
            ) : (
              <Play className="w-3 h-3" />
            )}
            {t('syncLogs.apiCalls.live')}
            {live && (
              <span
                className={cn(
                  'inline-block w-1.5 h-1.5 rounded-full',
                  liveStatus === 'open'
                    ? 'bg-white animate-pulse'
                    : liveStatus === 'connecting'
                      ? 'bg-amber-200'
                      : 'bg-rose-200',
                )}
                aria-label={liveStatus}
              />
            )}
          </button>
          <SavedSearchPicker
            surface="api-calls"
            currentFilters={{
              since: urlSinceKey,
              channel: urlChannel,
              errorType: urlErrorType,
              success: urlSuccess,
              operation: urlOperation,
              requestId: urlRequestId,
            }}
            onApply={(filters) => {
              // Reset every URL param the picker manages, then apply the
              // saved set. updateUrl deletes empty values automatically.
              updateUrl({
                since: '',
                channel: '',
                errorType: '',
                success: '',
                operation: '',
                requestId: '',
                ...filters,
              })
            }}
          />
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              const since = new Date(Date.now() - sinceMs).toISOString()
              const params = new URLSearchParams({ since, format: 'csv' })
              if (urlChannel) params.set('channel', urlChannel)
              if (urlErrorType) params.set('errorType', urlErrorType)
              if (urlSuccess) params.set('success', urlSuccess)
              if (urlOperation) params.set('operation', urlOperation)
              if (urlRequestId) params.set('requestId', urlRequestId)
              window.open(
                `${getBackendUrl()}/api/sync-logs/api-calls/export?${params.toString()}`,
                '_blank',
              )
            }}
            title={t('syncLogs.apiCalls.csv.title')}
          >
            <Download className="w-3.5 h-3.5" />
            {t('syncLogs.apiCalls.csv')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void fetchAll(true)}
            disabled={loading}
          >
            {loading ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <RefreshCw className="w-3.5 h-3.5" />
            )}
            {t('syncLogs.apiCalls.refresh')}
          </Button>
        </div>
      </div>

      {/* KPI strip */}
      {rollup && (
        <section className="border border-slate-200 dark:border-slate-800 rounded-md px-4 py-3 grid grid-cols-2 md:grid-cols-5 gap-3 bg-white dark:bg-slate-900">
          <Kpi label={t('syncLogs.apiCalls.kpi.total')} value={rollup.stats.total} />
          <Kpi
            label={t('syncLogs.apiCalls.kpi.failed')}
            value={rollup.stats.failed}
            tone={rollup.stats.failed === 0 ? 'good' : 'bad'}
          />
          <Kpi
            label={t('syncLogs.apiCalls.kpi.errorRate')}
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
            label={t('syncLogs.apiCalls.kpi.p95')}
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
            label={t('syncLogs.apiCalls.kpi.p99')}
            value={
              rollup.stats.latencyP99Ms !== null
                ? `${rollup.stats.latencyP99Ms}ms`
                : '—'
            }
          />
        </section>
      )}

      {/* L.11.0 — time-series charts (latency percentiles + volume) */}
      {rollup && rollup.stats.total > 0 && (
        <TimeSeriesChart
          sinceMs={sinceMs}
          channel={urlChannel}
          operation={urlOperation}
        />
      )}

      {error && (
        <div className="border border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/40 rounded-md px-3 py-2 text-base text-rose-800 dark:text-rose-300 flex items-center gap-2">
          <AlertCircle className="w-3.5 h-3.5" /> {error}
        </div>
      )}

      {loading && recent.length === 0 ? (
        <div className="space-y-2">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div
              key={i}
              className="h-10 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md animate-pulse"
            />
          ))}
        </div>
      ) : recent.length === 0 ? (
        <EmptyState
          icon={Filter}
          title={t('syncLogs.apiCalls.empty.title')}
          description={t('syncLogs.apiCalls.empty.description')}
        />
      ) : (
        <div className="border border-slate-200 dark:border-slate-800 rounded-md bg-white dark:bg-slate-900 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-800">
              <tr>
                <th className="px-3 py-1.5 text-left font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider w-2"></th>
                <th className="px-3 py-1.5 text-left font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider w-20">
                  {t('syncLogs.apiCalls.col.time')}
                </th>
                <th className="px-3 py-1.5 text-left font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider w-20">
                  {t('syncLogs.apiCalls.col.channel')}
                </th>
                <th className="px-3 py-1.5 text-left font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider">
                  {t('syncLogs.apiCalls.col.operation')}
                </th>
                <th className="px-3 py-1.5 text-left font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider w-16">
                  {t('syncLogs.apiCalls.col.status')}
                </th>
                <th className="px-3 py-1.5 text-right font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider w-16">
                  {t('syncLogs.apiCalls.col.latency')}
                </th>
                <th className="px-3 py-1.5 text-left font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider">
                  {t('syncLogs.apiCalls.col.error')}
                </th>
              </tr>
            </thead>
            <tbody>
              {recent.map((r, idx) => (
                <tr
                  key={r.id}
                  onClick={() => {
                    setHighlightIndex(idx)
                    setSelected(r)
                  }}
                  className={cn(
                    'border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer transition-colors',
                    !r.success && 'bg-rose-50/30 dark:bg-rose-950/30',
                    idx === highlightIndex &&
                      'bg-blue-50 dark:bg-blue-950/40 hover:bg-blue-50 dark:hover:bg-blue-950/40',
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
                  <td className="px-3 py-1.5 text-xs text-slate-500 dark:text-slate-500 whitespace-nowrap">
                    {fmtRelative(r.createdAt)}
                  </td>
                  <td className="px-3 py-1.5 font-medium text-slate-700 dark:text-slate-300">
                    {r.channel}
                  </td>
                  <td className="px-3 py-1.5 font-mono text-slate-700 dark:text-slate-300 truncate max-w-md">
                    {r.operation}
                  </td>
                  <td className="px-3 py-1.5 font-mono text-xs text-slate-500 dark:text-slate-500">
                    {r.statusCode ?? '—'}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-xs text-slate-500 dark:text-slate-500 whitespace-nowrap">
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
                        className="ml-2 text-xs text-rose-700 dark:text-rose-400 truncate"
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
            <div className="border-t border-slate-200 dark:border-slate-800 p-2 flex justify-center">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void fetchAll(false)}
                disabled={loadingMore}
              >
                {loadingMore ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : null}
                {t('syncLogs.apiCalls.loadMore')}
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Detail slide-over */}
      {selected && (
        <DetailPanel
          row={selected}
          onClose={() => setSelected(null)}
          onFilterByRequestId={(id) => {
            updateUrl({ requestId: id })
            setSelected(null)
          }}
        />
      )}
    </div>
  )
}

function DetailPanel({
  row,
  onClose,
  onFilterByRequestId,
}: {
  row: ApiCallRow
  onClose: () => void
  onFilterByRequestId: (id: string) => void
}) {
  const { t } = useTranslations()
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
        className="relative w-full max-w-2xl bg-white dark:bg-slate-900 shadow-2xl border-l border-slate-200 dark:border-slate-800 overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={t('syncLogs.apiCalls.detail.aria')}
      >
        <header className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 sticky top-0 bg-white dark:bg-slate-900 flex items-center justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  'w-2 h-2 rounded-full inline-block',
                  row.success ? 'bg-emerald-500' : 'bg-rose-500',
                )}
                aria-hidden
              />
              <span className="font-mono text-base font-semibold text-slate-900 dark:text-slate-100 truncate">
                {row.operation}
              </span>
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-500 mt-0.5 flex items-center gap-2 flex-wrap">
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
            className="p-1 text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
            aria-label={t('syncLogs.apiCalls.detail.close')}
          >
            <X className="w-4 h-4" />
          </button>
        </header>

        <div className="px-4 py-3 space-y-4">
          {row.endpoint && (
            <Section label={t('syncLogs.apiCalls.detail.endpoint')}>
              <pre className="text-xs font-mono bg-slate-50 dark:bg-slate-800/50 px-2 py-1.5 rounded overflow-x-auto whitespace-pre-wrap break-all">
                {row.endpoint}
              </pre>
            </Section>
          )}

          {row.errorMessage && (
            <Section label={t('syncLogs.apiCalls.detail.error')}>
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
                <pre className="text-xs font-mono bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 px-2 py-1.5 rounded overflow-x-auto whitespace-pre-wrap break-all text-rose-900 dark:text-rose-200">
                  {row.errorMessage}
                </pre>
              </div>
            </Section>
          )}

          {row.requestId && (
            <Section label={t('syncLogs.apiCalls.detail.requestId')}>
              <button
                type="button"
                onClick={() => onFilterByRequestId(row.requestId!)}
                title={t('syncLogs.apiCalls.detail.requestIdFilter')}
                className="text-xs font-mono bg-slate-50 dark:bg-slate-800/50 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 px-2 py-1 rounded inline-flex items-center gap-1.5 transition-colors"
              >
                {row.requestId}
                <span className="text-slate-400">{t('syncLogs.apiCalls.detail.requestIdFilterArrow')}</span>
              </button>
            </Section>
          )}

          {row.requestPayload != null && (
            <Section label={t('syncLogs.apiCalls.detail.requestPayload')}>
              <pre className="text-xs font-mono bg-slate-50 dark:bg-slate-800/50 px-2 py-1.5 rounded overflow-x-auto max-h-64 whitespace-pre-wrap break-all">
                {JSON.stringify(row.requestPayload, null, 2)}
              </pre>
            </Section>
          )}

          {row.responsePayload != null && (
            <Section label={t('syncLogs.apiCalls.detail.responsePayload')}>
              <pre className="text-xs font-mono bg-slate-50 dark:bg-slate-800/50 px-2 py-1.5 rounded overflow-x-auto max-h-64 whitespace-pre-wrap break-all">
                {JSON.stringify(row.responsePayload, null, 2)}
              </pre>
            </Section>
          )}

          {(row.productId || row.listingId || row.orderId) && (
            <Section label={t('syncLogs.apiCalls.detail.relatedEntities')}>
              <div className="flex flex-wrap gap-2">
                {row.productId && (
                  <a
                    href={`/products?drawer=${row.productId}`}
                    className="text-sm text-blue-700 dark:text-blue-400 hover:underline"
                  >
                    {t('syncLogs.apiCalls.detail.product', { id: row.productId.slice(0, 12) })}
                  </a>
                )}
                {row.listingId && (
                  <a
                    href={`/listings?drawer=${row.listingId}`}
                    className="text-sm text-blue-700 dark:text-blue-400 hover:underline"
                  >
                    {t('syncLogs.apiCalls.detail.listing', { id: row.listingId.slice(0, 12) })}
                  </a>
                )}
                {row.orderId && (
                  <a
                    href={`/orders/${row.orderId}`}
                    className="text-sm text-blue-700 dark:text-blue-400 hover:underline"
                  >
                    {t('syncLogs.apiCalls.detail.order', { id: row.orderId.slice(0, 12) })}
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
      <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-500 font-semibold mb-1">
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
      ? 'text-emerald-700 dark:text-emerald-400'
      : tone === 'warn'
        ? 'text-amber-700 dark:text-amber-400'
        : tone === 'bad'
          ? 'text-rose-700 dark:text-rose-400'
          : 'text-slate-900 dark:text-slate-100'
  return (
    <div>
      <div className="text-xs text-slate-500 dark:text-slate-500 uppercase tracking-wider">
        {label}
      </div>
      <div className={`text-[20px] font-semibold tabular-nums ${valueClass}`}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
    </div>
  )
}
