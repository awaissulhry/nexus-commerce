'use client'

/**
 * CS.3 — Channel-stock-drift triage surface.
 *
 * Lists ChannelStockEvent rows the operator needs to decide on:
 *   PENDING       — fresh ingest, never auto-applied or reviewed
 *   REVIEW_NEEDED — drift exceeded auto-apply threshold (per channel)
 *
 * Default filter is "OPEN" (PENDING + REVIEW_NEEDED). Each row
 * shows the channel-reported value vs our local snapshot at ingest,
 * the resulting drift, the SKU + product, and (channel, timestamp).
 *
 * Per-row actions:
 *   • Apply  — operator confirms, fires applyStockMovement(reason:
 *              CHANNEL_STOCK_RECONCILIATION) so local stock snaps
 *              to channel value.
 *   • Ignore — operator confirms the channel is wrong; requires a
 *              short reason. Status flips to IGNORED, no DB change.
 *
 * View filter: status chips (OPEN | REVIEW_NEEDED | PENDING |
 * APPLIED | AUTO_APPLIED | IGNORED | ALL) + channel chips.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, RefreshCw, X } from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { StockSubNav } from '@/components/inventory/StockSubNav'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { useToast } from '@/components/ui/Toast'
import { useTranslations } from '@/lib/i18n/use-translations'
import { getBackendUrl } from '@/lib/backend-url'

interface ChannelStockEvent {
  id: string
  channel: string
  channelEventId: string
  productId: string | null
  variationId: string | null
  sku: string
  locationId: string | null
  channelReportedQty: number
  localQtyAtObservation: number
  drift: number
  status: 'PENDING' | 'AUTO_APPLIED' | 'REVIEW_NEEDED' | 'APPLIED' | 'IGNORED'
  resolution: string | null
  resultingMovementId: string | null
  resolvedByUserId: string | null
  resolvedAt: string | null
  createdAt: string
  product: { id: string; sku: string; name: string } | null
}

type StatusFilter = 'OPEN' | 'PENDING' | 'REVIEW_NEEDED' | 'AUTO_APPLIED' | 'APPLIED' | 'IGNORED' | 'ALL'

const STATUS_TONE: Record<string, string> = {
  PENDING: 'bg-slate-50 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700',
  REVIEW_NEEDED: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900',
  AUTO_APPLIED: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-900',
  APPLIED: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900',
  IGNORED: 'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-900',
}

export default function ChannelDriftClient() {
  const { t } = useTranslations()
  const { toast } = useToast()
  const [events, setEvents] = useState<ChannelStockEvent[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('OPEN')
  const [channelFilter, setChannelFilter] = useState<string>('')
  const [busy, setBusy] = useState<string | null>(null)
  const [ignoreModal, setIgnoreModal] = useState<{ id: string; sku: string } | null>(null)
  const [ignoreReason, setIgnoreReason] = useState('')

  const fetchEvents = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      params.set('status', statusFilter)
      if (channelFilter) params.set('channel', channelFilter)
      const res = await fetch(`${getBackendUrl()}/api/stock/channel-events?${params}`, { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setEvents(data.items ?? [])
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('common.error'))
    } finally {
      setLoading(false)
    }
  }, [statusFilter, channelFilter, t, toast])

  useEffect(() => { fetchEvents() }, [fetchEvents])

  const channels = useMemo(() => {
    if (!events) return [] as string[]
    return Array.from(new Set(events.map((e) => e.channel))).sort()
  }, [events])

  const apply = async (id: string) => {
    setBusy(id)
    try {
      const res = await fetch(`${getBackendUrl()}/api/stock/channel-events/${id}/apply`, { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`)
      toast.success(t('channelDrift.toast.applied'))
      await fetchEvents()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('common.error'))
    } finally {
      setBusy(null)
    }
  }

  const submitIgnore = async () => {
    if (!ignoreModal || !ignoreReason.trim()) return
    setBusy(ignoreModal.id)
    try {
      const res = await fetch(`${getBackendUrl()}/api/stock/channel-events/${ignoreModal.id}/ignore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: ignoreReason.trim() }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`)
      toast.success(t('channelDrift.toast.ignored'))
      setIgnoreModal(null)
      setIgnoreReason('')
      await fetchEvents()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('common.error'))
    } finally {
      setBusy(null)
    }
  }

  const STATUS_CHIPS: Array<{ key: StatusFilter; labelKey: string }> = [
    { key: 'OPEN', labelKey: 'channelDrift.filter.open' },
    { key: 'REVIEW_NEEDED', labelKey: 'channelDrift.status.REVIEW_NEEDED' },
    { key: 'PENDING', labelKey: 'channelDrift.status.PENDING' },
    { key: 'AUTO_APPLIED', labelKey: 'channelDrift.status.AUTO_APPLIED' },
    { key: 'APPLIED', labelKey: 'channelDrift.status.APPLIED' },
    { key: 'IGNORED', labelKey: 'channelDrift.status.IGNORED' },
    { key: 'ALL', labelKey: 'channelDrift.filter.all' },
  ]

  return (
    <div className="p-3 sm:p-6 space-y-3 sm:space-y-6">
      <PageHeader
        title={t('channelDrift.pageTitle')}
        description={t('channelDrift.pageDescription')}
        breadcrumbs={[
          { label: t('nav.fulfillment'), href: '/fulfillment' },
          { label: t('stock.title'), href: '/fulfillment/stock' },
          { label: t('channelDrift.pageTitle') },
        ]}
        actions={
          <Button variant="secondary" size="sm" onClick={fetchEvents} disabled={loading}>
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} aria-hidden="true" />
          </Button>
        }
      />
      <StockSubNav />

      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mr-1">
          {t('channelDrift.filter.statusLabel')}
        </span>
        {STATUS_CHIPS.map((chip) => (
          <button
            key={chip.key}
            onClick={() => setStatusFilter(chip.key)}
            aria-pressed={statusFilter === chip.key}
            className={
              'h-7 px-3 text-sm rounded-full font-medium border ' +
              (statusFilter === chip.key
                ? 'bg-slate-900 dark:bg-slate-100 text-white border-slate-900 dark:text-slate-900'
                : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600')
            }
          >
            {t(chip.labelKey as any)}
          </button>
        ))}
        {channels.length > 1 && (
          <>
            <span className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mx-1">
              {t('channelDrift.filter.channelLabel')}
            </span>
            <button
              onClick={() => setChannelFilter('')}
              aria-pressed={channelFilter === ''}
              className={
                'h-7 px-3 text-sm rounded-full font-medium border ' +
                (channelFilter === ''
                  ? 'bg-slate-900 dark:bg-slate-100 text-white border-slate-900 dark:text-slate-900'
                  : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-700')
              }
            >
              {t('channelDrift.filter.allChannels')}
            </button>
            {channels.map((c) => (
              <button
                key={c}
                onClick={() => setChannelFilter(c)}
                aria-pressed={channelFilter === c}
                className={
                  'h-7 px-3 text-sm rounded-full font-medium border ' +
                  (channelFilter === c
                    ? 'bg-slate-900 dark:bg-slate-100 text-white border-slate-900 dark:text-slate-900'
                    : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-700')
                }
              >
                {c}
              </button>
            ))}
          </>
        )}
      </div>

      {!loading && events?.length === 0 && (
        <EmptyState
          icon={CheckCircle2}
          title={t('channelDrift.empty.title')}
          description={t('channelDrift.empty.description')}
        />
      )}

      {events && events.length > 0 && (
        <Card noPadding>
          <div className="overflow-x-auto">
            <table className="w-full text-base">
              <thead className="border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800">
                <tr>
                  <th className="px-3 py-2 text-left text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">{t('channelDrift.col.channel')}</th>
                  <th className="px-3 py-2 text-left text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">{t('channelDrift.col.product')}</th>
                  <th className="px-3 py-2 text-right text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">{t('channelDrift.col.local')}</th>
                  <th className="px-3 py-2 text-right text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">{t('channelDrift.col.channelReported')}</th>
                  <th className="px-3 py-2 text-right text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">{t('channelDrift.col.drift')}</th>
                  <th className="px-3 py-2 text-left text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">{t('channelDrift.col.status')}</th>
                  <th className="px-3 py-2 text-left text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">{t('channelDrift.col.observed')}</th>
                  <th className="px-3 py-2 text-right text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold"></th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => {
                  const isOpen = e.status === 'PENDING' || e.status === 'REVIEW_NEEDED'
                  const driftLarge = Math.abs(e.drift) > 5
                  return (
                    <tr key={e.id} className="border-b border-slate-100 dark:border-slate-800 last:border-0">
                      <td className="px-3 py-2 font-mono text-xs text-slate-700 dark:text-slate-300">{e.channel}</td>
                      <td className="px-3 py-2">
                        {e.product ? (
                          <div className="space-y-0.5">
                            <div className="text-md text-slate-900 dark:text-slate-100 truncate max-w-md">{e.product.name}</div>
                            <div className="font-mono text-xs text-slate-500 dark:text-slate-400">{e.product.sku}</div>
                          </div>
                        ) : (
                          <div>
                            <div className="font-mono text-xs text-slate-500 dark:text-slate-400">{e.sku}</div>
                            <div className="text-xs text-amber-700 dark:text-amber-300 inline-flex items-center gap-1">
                              <AlertTriangle size={10} aria-hidden="true" /> {t('channelDrift.unmappedSku')}
                            </div>
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-700 dark:text-slate-300">{e.localQtyAtObservation}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-700 dark:text-slate-300">{e.channelReportedQty}</td>
                      <td className={`px-3 py-2 text-right tabular-nums font-semibold ${
                        e.drift === 0 ? 'text-slate-400 dark:text-slate-500'
                          : driftLarge ? 'text-rose-700 dark:text-rose-300'
                          : 'text-amber-700 dark:text-amber-300'
                      }`}>
                        {e.drift > 0 ? '+' : ''}{e.drift}
                      </td>
                      <td className="px-3 py-2">
                        <span className={`text-xs uppercase tracking-wider font-semibold px-1.5 py-0.5 border rounded ${STATUS_TONE[e.status] ?? ''}`}>
                          {e.status.replace(/_/g, ' ')}
                        </span>
                        {e.resolution && (
                          <div className="text-xs text-slate-500 dark:text-slate-400 italic mt-1 truncate max-w-[200px]" title={e.resolution}>
                            {e.resolution}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400 whitespace-nowrap">
                        {new Date(e.createdAt).toLocaleString('it-IT', { year: '2-digit', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {isOpen && e.product && (
                          <div className="inline-flex items-center gap-1.5 justify-end">
                            <button
                              onClick={() => apply(e.id)}
                              disabled={busy === e.id}
                              className="h-7 px-2 text-sm bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-900 rounded hover:bg-emerald-100 dark:hover:bg-emerald-900/60 disabled:opacity-50 inline-flex items-center gap-1"
                            >
                              {busy === e.id ? t('channelDrift.action.applying') : t('channelDrift.action.apply')}
                            </button>
                            <button
                              onClick={() => { setIgnoreModal({ id: e.id, sku: e.sku }); setIgnoreReason('') }}
                              disabled={busy === e.id}
                              className="h-7 px-2 text-sm bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 rounded hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-50 inline-flex items-center gap-1"
                            >
                              {t('channelDrift.action.ignore')}
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Ignore reason modal */}
      {ignoreModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={(e) => { if (e.target === e.currentTarget && busy === null) { setIgnoreModal(null); setIgnoreReason('') } }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="ignore-title"
        >
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg shadow-xl w-full max-w-md">
            <div className="flex items-center justify-between gap-2 px-5 py-3 border-b border-slate-200 dark:border-slate-700">
              <h2 id="ignore-title" className="text-lg font-semibold text-slate-900 dark:text-slate-100">
                {t('channelDrift.ignore.title', { sku: ignoreModal.sku })}
              </h2>
              <button
                onClick={() => { setIgnoreModal(null); setIgnoreReason('') }}
                disabled={busy !== null}
                className="h-8 w-8 inline-flex items-center justify-center rounded text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
                aria-label={t('common.close')}
              >
                <X size={16} />
              </button>
            </div>
            <div className="p-5 space-y-3">
              <p className="text-base text-slate-600 dark:text-slate-400">
                {t('channelDrift.ignore.help')}
              </p>
              <textarea
                value={ignoreReason}
                onChange={(e) => setIgnoreReason(e.target.value)}
                placeholder={t('channelDrift.ignore.placeholder')}
                rows={3}
                autoFocus
                className="w-full px-2 py-1.5 text-base border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
              />
            </div>
            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-slate-200 dark:border-slate-700">
              <Button variant="secondary" size="sm" onClick={() => { setIgnoreModal(null); setIgnoreReason('') }} disabled={busy !== null}>
                {t('common.cancel')}
              </Button>
              <Button variant="primary" size="sm" onClick={submitIgnore} disabled={!ignoreReason.trim() || busy !== null}>
                {busy ? t('channelDrift.ignore.submitting') : t('channelDrift.ignore.submit')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
