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
  RotateCw,
  Webhook,
  X,
  XCircle,
} from 'lucide-react'
import { useToast } from '@/components/ui/Toast'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import SavedSearchPicker from '../_shared/SavedSearchPicker'
import { EmptyState } from '@/components/ui/EmptyState'
import { getBackendUrl } from '@/lib/backend-url'
import { useTranslations } from '@/lib/i18n/use-translations'
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
  const { t } = useTranslations()

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
      <div className="flex items-center gap-x-1 gap-y-1.5 flex-wrap">
        <span className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-500 font-medium mr-1">
          {t('syncLogs.webhooks.filter.channel')}
        </span>
        <button
          type="button"
          onClick={() => updateUrl({ channel: '' })}
          className={cn(
            'px-2 py-0.5 text-sm font-medium rounded border transition-colors',
            !urlChannel
              ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 border-slate-900 dark:border-slate-100'
              : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700',
          )}
        >
          {t('syncLogs.webhooks.filter.all')}
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
                ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 border-slate-900 dark:border-slate-100'
                : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700',
            )}
          >
            {c.channel}
            <span className="ml-1 opacity-70">{c.count}</span>
          </button>
        ))}

        <span className="ml-3 text-xs uppercase tracking-wider text-slate-500 dark:text-slate-500 font-medium mr-1">
          {t('syncLogs.webhooks.filter.status')}
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
              : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700',
          )}
        >
          {t('syncLogs.webhooks.filter.processed')}{totals && ` ${totals.processed}`}
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
              : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700',
          )}
        >
          {t('syncLogs.webhooks.filter.unprocessed')}{totals && ` ${totals.unprocessed}`}
        </button>

        {eventTypeOptions.length > 0 && (
          <>
            <span className="ml-3 text-xs uppercase tracking-wider text-slate-500 dark:text-slate-500 font-medium mr-1">
              {t('syncLogs.webhooks.filter.event')}
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
                    ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 border-slate-900 dark:border-slate-100'
                    : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700',
                )}
              >
                {et}
              </button>
            ))}
          </>
        )}

        <div className="ml-auto" />
        <SavedSearchPicker
          surface="webhooks"
          currentFilters={{
            channel: urlChannel,
            processed: urlProcessed,
            eventType: urlEventType,
          }}
          onApply={(filters) =>
            updateUrl({
              channel: '',
              processed: '',
              eventType: '',
              ...filters,
            })
          }
        />

        <Button
          variant="secondary"
          size="sm"
          onClick={() => void fetchList(true)}
          disabled={loading}
        >
          {loading ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <RefreshCw className="w-3.5 h-3.5" />
          )}
          {t('syncLogs.webhooks.refresh')}
        </Button>
      </div>

      {error && (
        <div className="border border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/40 rounded-md px-3 py-2 text-base text-rose-800 dark:text-rose-300 flex items-center gap-2">
          <AlertCircle className="w-3.5 h-3.5" /> {error}
        </div>
      )}

      {loading && items.length === 0 ? (
        <div className="space-y-2">
          {[1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="h-10 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md animate-pulse"
            />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={Webhook}
          title={t('syncLogs.webhooks.empty.title')}
          description={t('syncLogs.webhooks.empty.description')}
        />
      ) : (
        <div className="border border-slate-200 dark:border-slate-800 rounded-md bg-white dark:bg-slate-900 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-800">
              <tr>
                <th className="px-3 py-1.5 text-left font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider w-2"></th>
                <th className="px-3 py-1.5 text-left font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider w-20">
                  {t('syncLogs.webhooks.col.time')}
                </th>
                <th className="px-3 py-1.5 text-left font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider w-24">
                  {t('syncLogs.webhooks.col.channel')}
                </th>
                <th className="px-3 py-1.5 text-left font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider">
                  {t('syncLogs.webhooks.col.event')}
                </th>
                <th className="px-3 py-1.5 text-left font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider w-48">
                  {t('syncLogs.webhooks.col.externalId')}
                </th>
                <th className="px-3 py-1.5 text-left font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider">
                  {t('syncLogs.webhooks.col.error')}
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <tr
                  key={r.id}
                  onClick={() => void openDetail(r)}
                  className={cn(
                    'border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer transition-colors',
                    !r.isProcessed && 'bg-rose-50/30 dark:bg-rose-950/30',
                  )}
                >
                  <td className="px-3 py-1.5">
                    {r.isProcessed ? (
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                    ) : (
                      <XCircle className="w-3.5 h-3.5 text-rose-500" />
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-xs text-slate-500 dark:text-slate-500 whitespace-nowrap">
                    {fmtRelative(r.createdAt)}
                  </td>
                  <td className="px-3 py-1.5 font-medium text-slate-700 dark:text-slate-300">
                    {r.channel}
                  </td>
                  <td className="px-3 py-1.5 font-mono text-slate-700 dark:text-slate-300 truncate max-w-md">
                    {r.eventType}
                  </td>
                  <td className="px-3 py-1.5 font-mono text-xs text-slate-500 dark:text-slate-500 truncate">
                    {r.externalId}
                  </td>
                  <td className="px-3 py-1.5 truncate">
                    {r.error && (
                      <span
                        className="text-xs text-rose-700 dark:text-rose-400 truncate"
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
            <div className="border-t border-slate-200 dark:border-slate-800 p-2 flex justify-center">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void fetchList(false)}
                disabled={loadingMore}
              >
                {loadingMore ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : null}
                {t('syncLogs.webhooks.loadMore')}
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
          onReplayed={() => {
            // Refresh both the list and the detail row.
            void fetchList(true)
            void openDetail(selected)
          }}
        />
      )}
    </div>
  )
}

function DetailPanel({
  row,
  loading,
  onClose,
  onReplayed,
}: {
  row: WebhookDetail
  loading: boolean
  onClose: () => void
  onReplayed: () => void
}) {
  const { toast } = useToast()
  const { t } = useTranslations()
  const [replaying, setReplaying] = useState(false)

  const replay = async () => {
    if (
      !confirm(
        t('syncLogs.webhooks.detail.replayConfirm', {
          channel: row.channel,
          event: row.eventType,
        }),
      )
    )
      return
    setReplaying(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/sync-logs/webhooks/${row.id}/replay`,
        { method: 'POST' },
      )
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(json.error ?? `HTTP ${res.status}`)
      }
      toast.success(t('syncLogs.webhooks.detail.replayed'))
      onReplayed()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setReplaying(false)
    }
  }
  const replaySupported = ['SHOPIFY', 'WOOCOMMERCE', 'ETSY'].includes(row.channel)
  return (
    <div
      className="fixed inset-0 z-40 flex justify-end"
      onClick={onClose}
      role="presentation"
    >
      <div className="absolute inset-0 bg-slate-900/30" aria-hidden />
      <aside
        className="relative w-full max-w-2xl bg-white dark:bg-slate-900 shadow-2xl border-l border-slate-200 dark:border-slate-800 overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={t('syncLogs.webhooks.detail.aria')}
      >
        <header className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 sticky top-0 bg-white dark:bg-slate-900 flex items-center justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {row.isProcessed ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-500" />
              ) : (
                <XCircle className="w-4 h-4 text-rose-500" />
              )}
              <span className="font-mono text-base font-semibold text-slate-900 dark:text-slate-100 truncate">
                {row.eventType}
              </span>
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-500 mt-0.5 flex items-center gap-2 flex-wrap">
              <Badge
                variant={row.isProcessed ? 'success' : 'danger'}
                size="sm"
              >
                {row.isProcessed
                  ? t('syncLogs.webhooks.detail.processed')
                  : t('syncLogs.webhooks.detail.unprocessed')}
              </Badge>
              <span>{row.channel}</span>
              <span>· {fmtRelative(row.createdAt)}</span>
              {row.processedAt && (
                <span>
                  ·{' '}
                  {t('syncLogs.webhooks.detail.processedAt', {
                    when: fmtRelative(row.processedAt),
                  })}
                </span>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
            aria-label={t('syncLogs.webhooks.detail.close')}
          >
            <X className="w-4 h-4" />
          </button>
        </header>

        <div className="px-4 py-3 space-y-4">
          <Section label={t('syncLogs.webhooks.detail.externalId')}>
            <code className="text-xs font-mono bg-slate-50 dark:bg-slate-800/50 px-2 py-1 rounded">
              {row.externalId}
            </code>
          </Section>

          {row.signature && (
            <Section label={t('syncLogs.webhooks.detail.signature')}>
              <code className="text-xs font-mono bg-slate-50 dark:bg-slate-800/50 px-2 py-1 rounded break-all block">
                {row.signature}
              </code>
            </Section>
          )}

          {row.error && (
            <Section label={t('syncLogs.webhooks.detail.error')}>
              <pre className="text-xs font-mono bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 px-2 py-1.5 rounded overflow-x-auto whitespace-pre-wrap break-all text-rose-900 dark:text-rose-200">
                {row.error}
              </pre>
            </Section>
          )}

          <Section label={t('syncLogs.webhooks.detail.payload')}>
            {loading ? (
              <Loader2 className="w-4 h-4 animate-spin text-slate-400 dark:text-slate-500" />
            ) : (
              <pre className="text-xs font-mono bg-slate-50 dark:bg-slate-800/50 px-2 py-1.5 rounded overflow-x-auto max-h-96 whitespace-pre-wrap break-all">
                {JSON.stringify(row.payload, null, 2)}
              </pre>
            )}
          </Section>

          {/* L.17.0 — replay action */}
          {replaySupported && (
            <div className="pt-2 border-t border-slate-100 dark:border-slate-800">
              <button
                type="button"
                onClick={() => void replay()}
                disabled={replaying}
                className="h-8 px-3 text-sm font-medium rounded border border-blue-300 dark:border-blue-800 bg-white dark:bg-slate-900 text-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-950/40 inline-flex items-center gap-1.5 disabled:opacity-50"
              >
                {replaying ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <RotateCw className="w-3.5 h-3.5" />
                )}
                {t('syncLogs.webhooks.detail.replay')}
              </button>
              <p className="text-xs text-slate-500 dark:text-slate-500 italic mt-1.5">
                {t('syncLogs.webhooks.detail.replayInfo')}
              </p>
            </div>
          )}
          {!replaySupported && (
            <p className="text-xs text-slate-500 dark:text-slate-500 italic pt-2 border-t border-slate-100 dark:border-slate-800">
              {t('syncLogs.webhooks.detail.replayUnsupported', { channel: row.channel })}
            </p>
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
