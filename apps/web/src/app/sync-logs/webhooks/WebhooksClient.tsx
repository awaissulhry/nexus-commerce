'use client'

/**
 * L.9.1 — /sync-logs/webhooks client.
 *
 * Lists WebhookEvent rows from the GET /api/sync-logs/webhooks
 * endpoint. Click a row → fetches /webhooks/:id (full row including
 * payload + signature) and opens a slide-over with a JSON viewer.
 *
 * URL state via search params:
 *   ?channel=SHOPIFY  &processed=false  &eventType=product/update
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  RefreshCw,
  Webhook,
  X,
  XCircle,
} from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'

interface WebhookListRow {
  id: string
  channel: string
  eventType: string
  externalId: string
  isProcessed: boolean
  processedAt: string | null
  error: string | null
  createdAt: string
  updatedAt: string
}

interface WebhookDetail extends WebhookListRow {
  payload: unknown
  signature: string | null
}

interface ListResponse {
  items: WebhookListRow[]
  nextCursor: string | null
  totals: {
    byChannel: Array<{ channel: string; count: number }>
    processed: number
    unprocessed: number
  }
}

function fmtRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`
  return new Date(iso).toLocaleString()
}

export default function WebhooksClient() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const urlChannel = searchParams.get('channel') ?? ''
  const urlProcessed = searchParams.get('processed') ?? ''
  const urlEventType = searchParams.get('eventType') ?? ''

  const [items, setItems] = useState<WebhookListRow[]>([])
  const [totals, setTotals] = useState<ListResponse['totals'] | null>(null)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<WebhookDetail | null>(null)
  const [loadingDetail, setLoadingDetail] = useState(false)

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

  const fetchList = useCallback(
    async (resetCursor = true) => {
      if (resetCursor) setLoading(true)
      else setLoadingMore(true)
      setError(null)
      try {
        const params = new URLSearchParams()
        if (urlChannel) params.set('channel', urlChannel)
        if (urlProcessed) params.set('processed', urlProcessed)
        if (urlEventType) params.set('eventType', urlEventType)
        params.set('limit', '50')
        if (!resetCursor && nextCursor) params.set('cursor', nextCursor)

        const res = await fetch(
          `${getBackendUrl()}/api/sync-logs/webhooks?${params.toString()}`,
          { cache: 'no-store' },
        )
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json = (await res.json()) as ListResponse
        if (resetCursor) {
          setItems(json.items)
          setTotals(json.totals)
        } else {
          setItems((prev) => [...prev, ...json.items])
        }
        setNextCursor(json.nextCursor)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (resetCursor) setLoading(false)
        else setLoadingMore(false)
      }
    },
    [urlChannel, urlProcessed, urlEventType, nextCursor],
  )

  useEffect(() => {
    void fetchList(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlChannel, urlProcessed, urlEventType])

  const openDetail = useCallback(async (row: WebhookListRow) => {
    setLoadingDetail(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/sync-logs/webhooks/${row.id}`,
        { cache: 'no-store' },
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setSelected((await res.json()) as WebhookDetail)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoadingDetail(false)
    }
  }, [])

  const eventTypeOptions = useMemo(() => {
    const set = new Set(items.map((i) => i.eventType))
    return Array.from(set).sort()
  }, [items])

  return (
    <div className="space-y-3">
      {/* Filter bar */}
      <div className="flex items-center gap-1 flex-wrap">
        <span className="text-xs uppercase tracking-wider text-slate-500 font-medium mr-1">
          Channel
        </span>
        <button
          type="button"
          onClick={() => updateUrl({ channel: '' })}
          className={cn(
            'px-2 py-0.5 text-sm font-medium rounded border transition-colors',
            !urlChannel
              ? 'bg-slate-900 text-white border-slate-900'
              : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300',
          )}
        >
          All
        </button>
        {(totals?.byChannel ?? []).map((c) => (
          <button
            key={c.channel}
            type="button"
            onClick={() =>
              updateUrl({ channel: urlChannel === c.channel ? '' : c.channel })
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
          Status
        </span>
        <button
          type="button"
          onClick={() =>
            updateUrl({
              processed: urlProcessed === 'true' ? '' : 'true',
            })
          }
          className={cn(
            'px-2 py-0.5 text-sm font-medium rounded border transition-colors',
            urlProcessed === 'true'
              ? 'bg-emerald-600 text-white border-emerald-600'
              : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300',
          )}
        >
          Processed{totals && ` ${totals.processed}`}
        </button>
        <button
          type="button"
          onClick={() =>
            updateUrl({
              processed: urlProcessed === 'false' ? '' : 'false',
            })
          }
          className={cn(
            'px-2 py-0.5 text-sm font-medium rounded border transition-colors',
            urlProcessed === 'false'
              ? 'bg-rose-600 text-white border-rose-600'
              : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300',
          )}
        >
          Unprocessed{totals && ` ${totals.unprocessed}`}
        </button>

        {eventTypeOptions.length > 0 && (
          <>
            <span className="ml-3 text-xs uppercase tracking-wider text-slate-500 font-medium mr-1">
              Event
            </span>
            {eventTypeOptions.slice(0, 8).map((et) => (
              <button
                key={et}
                type="button"
                onClick={() =>
                  updateUrl({ eventType: urlEventType === et ? '' : et })
                }
                className={cn(
                  'px-2 py-0.5 text-sm font-mono rounded border transition-colors',
                  urlEventType === et
                    ? 'bg-slate-900 text-white border-slate-900'
                    : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300',
                )}
              >
                {et}
              </button>
            ))}
          </>
        )}

        <Button
          variant="secondary"
          size="sm"
          onClick={() => void fetchList(true)}
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

      {error && (
        <div className="border border-rose-200 bg-rose-50 rounded-md px-3 py-2 text-base text-rose-800 flex items-center gap-2">
          <AlertCircle className="w-3.5 h-3.5" /> {error}
        </div>
      )}

      {loading && items.length === 0 ? (
        <div className="space-y-2">
          {[1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="h-10 bg-white border border-slate-200 rounded-md animate-pulse"
            />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={Webhook}
          title="No webhooks in this window"
          description="Once a Shopify / WooCommerce / Etsy webhook hits the platform, the row appears here. Try widening the time window or removing filters."
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
                <th className="px-3 py-1.5 text-left font-semibold text-slate-700 uppercase tracking-wider w-24">
                  Channel
                </th>
                <th className="px-3 py-1.5 text-left font-semibold text-slate-700 uppercase tracking-wider">
                  Event
                </th>
                <th className="px-3 py-1.5 text-left font-semibold text-slate-700 uppercase tracking-wider w-48">
                  External ID
                </th>
                <th className="px-3 py-1.5 text-left font-semibold text-slate-700 uppercase tracking-wider">
                  Error
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <tr
                  key={r.id}
                  onClick={() => void openDetail(r)}
                  className={cn(
                    'border-b border-slate-100 hover:bg-slate-50 cursor-pointer transition-colors',
                    !r.isProcessed && 'bg-rose-50/30',
                  )}
                >
                  <td className="px-3 py-1.5">
                    {r.isProcessed ? (
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                    ) : (
                      <XCircle className="w-3.5 h-3.5 text-rose-500" />
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-xs text-slate-500 whitespace-nowrap">
                    {fmtRelative(r.createdAt)}
                  </td>
                  <td className="px-3 py-1.5 font-medium text-slate-700">
                    {r.channel}
                  </td>
                  <td className="px-3 py-1.5 font-mono text-slate-700 truncate max-w-md">
                    {r.eventType}
                  </td>
                  <td className="px-3 py-1.5 font-mono text-xs text-slate-500 truncate">
                    {r.externalId}
                  </td>
                  <td className="px-3 py-1.5 truncate">
                    {r.error && (
                      <span
                        className="text-xs text-rose-700 truncate"
                        title={r.error}
                      >
                        {r.error}
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
                onClick={() => void fetchList(false)}
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

      {selected && (
        <DetailPanel
          row={selected}
          loading={loadingDetail}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  )
}

function DetailPanel({
  row,
  loading,
  onClose,
}: {
  row: WebhookDetail
  loading: boolean
  onClose: () => void
}) {
  return (
    <div
      className="fixed inset-0 z-40 flex justify-end"
      onClick={onClose}
      role="presentation"
    >
      <div className="absolute inset-0 bg-slate-900/30" aria-hidden />
      <aside
        className="relative w-full max-w-2xl bg-white shadow-2xl border-l border-slate-200 overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Webhook detail"
      >
        <header className="px-4 py-3 border-b border-slate-200 sticky top-0 bg-white flex items-center justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {row.isProcessed ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-500" />
              ) : (
                <XCircle className="w-4 h-4 text-rose-500" />
              )}
              <span className="font-mono text-base font-semibold text-slate-900 truncate">
                {row.eventType}
              </span>
            </div>
            <div className="text-xs text-slate-500 mt-0.5 flex items-center gap-2 flex-wrap">
              <Badge
                variant={row.isProcessed ? 'success' : 'danger'}
                size="sm"
              >
                {row.isProcessed ? 'PROCESSED' : 'UNPROCESSED'}
              </Badge>
              <span>{row.channel}</span>
              <span>· {fmtRelative(row.createdAt)}</span>
              {row.processedAt && (
                <span>· processed {fmtRelative(row.processedAt)}</span>
              )}
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
          <Section label="External ID">
            <code className="text-xs font-mono bg-slate-50 px-2 py-1 rounded">
              {row.externalId}
            </code>
          </Section>

          {row.signature && (
            <Section label="Signature">
              <code className="text-xs font-mono bg-slate-50 px-2 py-1 rounded break-all block">
                {row.signature}
              </code>
            </Section>
          )}

          {row.error && (
            <Section label="Error">
              <pre className="text-xs font-mono bg-rose-50 border border-rose-200 px-2 py-1.5 rounded overflow-x-auto whitespace-pre-wrap break-all text-rose-900">
                {row.error}
              </pre>
            </Section>
          )}

          <Section label="Payload">
            {loading ? (
              <Loader2 className="w-4 h-4 animate-spin text-slate-400" />
            ) : (
              <pre className="text-xs font-mono bg-slate-50 px-2 py-1.5 rounded overflow-x-auto max-h-96 whitespace-pre-wrap break-all">
                {JSON.stringify(row.payload, null, 2)}
              </pre>
            )}
          </Section>

          <p className="text-xs text-slate-500 italic pt-2 border-t border-slate-100">
            Replay capability ships in a follow-up. To re-process this
            webhook today, copy the payload and POST it back to the
            corresponding endpoint with a fresh HMAC signature.
          </p>
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
