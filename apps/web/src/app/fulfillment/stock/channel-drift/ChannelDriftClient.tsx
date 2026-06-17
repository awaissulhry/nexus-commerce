'use client'

/**
 * CS.3 — Channel-stock-drift triage surface.
 *
 * Lists ChannelStockEvent rows needing operator decision.
 * Per-row actions: Apply (snaps local stock to channel value) and
 * Ignore (marks wrong with a required reason).
 *
 * S.3 — table replaced with SharedVirtualizedGrid.
 * REVIEW_NEEDED rows surfaced via stagedIds (teal tint = urgent).
 * CycleCountListClient deliberately kept as card layout — navigation
 * list with progress bars is semantically a card surface, not a grid.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, X } from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { StockSubNav } from '@/components/inventory/StockSubNav'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { useToast } from '@/components/ui/Toast'
import FreshnessIndicator from '@/components/filters/FreshnessIndicator'
import { useTranslations } from '@/lib/i18n/use-translations'
import { getBackendUrl } from '@/lib/backend-url'
import { useInvalidationChannel } from '@/lib/sync/invalidation-channel'
import { useListingEvents } from '@/lib/sync/use-listing-events'
import { useInboundEvents } from '@/lib/sync/use-inbound-events'
import { AutoRefreshSelect, DensityToggle, GridToolbar, VirtualizedGrid, GridFooter } from '@/app/_shared/grid-lens'
import type { GridLensColumn, GridLensRow } from '@/app/_shared/grid-lens'
import { type Density, DENSITY_CELL_CLASS } from '@/lib/products/theme'

// ── Types ─────────────────────────────────────────────────────────────

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

type DriftRow = ChannelStockEvent & GridLensRow
type StatusFilter = 'OPEN' | 'PENDING' | 'REVIEW_NEEDED' | 'AUTO_APPLIED' | 'APPLIED' | 'IGNORED' | 'ALL'

// ── Constants ─────────────────────────────────────────────────────────

const DRIFT_COLUMNS: GridLensColumn[] = [
  { key: 'channel',  label: 'Channel',  subLabel: 'Source',         width: 110 },
  { key: 'product',  label: 'Product',  subLabel: 'SKU · Name',     width: 260 },
  { key: 'local',    label: 'Local',    subLabel: 'At observation',  width: 90  },
  { key: 'reported', label: 'Reported', subLabel: 'Channel qty',     width: 90  },
  { key: 'drift',    label: 'Drift',    subLabel: 'Δ qty',           width: 80  },
  { key: 'status',   label: 'Status',   subLabel: 'Resolution',      width: 170 },
  { key: 'observed', label: 'Observed', subLabel: 'Timestamp',       width: 160 },
  { key: 'actions',  label: '',                                       width: 170 },
]

const DRIFT_SORT_KEYS: Record<string, string> = {
  channel: 'channel', drift: 'drift', observed: 'observed',
}

const STATUS_CHIPS: Array<{ key: StatusFilter; labelKey: string }> = [
  { key: 'OPEN',         labelKey: 'channelDrift.filter.open' },
  { key: 'REVIEW_NEEDED',labelKey: 'channelDrift.status.REVIEW_NEEDED' },
  { key: 'PENDING',      labelKey: 'channelDrift.status.PENDING' },
  { key: 'AUTO_APPLIED', labelKey: 'channelDrift.status.AUTO_APPLIED' },
  { key: 'APPLIED',      labelKey: 'channelDrift.status.APPLIED' },
  { key: 'IGNORED',      labelKey: 'channelDrift.status.IGNORED' },
  { key: 'ALL',          labelKey: 'channelDrift.filter.all' },
]

const STATUS_TONE: Record<string, string> = {
  PENDING:       'bg-slate-50 text-slate-600 border-default dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700',
  REVIEW_NEEDED: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900',
  AUTO_APPLIED:  'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-900',
  APPLIED:       'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900',
  IGNORED:       'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-900',
}

const STORAGE_KEY = 'stock-channel-drift'
const _EMPTY_SET = new Set<string>()
const _EMPTY_MAP = {}
const _NOOP = () => {}

// ── Component ─────────────────────────────────────────────────────────

export default function ChannelDriftClient() {
  const { t } = useTranslations()
  const { toast } = useToast()
  const [events, setEvents]             = useState<ChannelStockEvent[] | null>(null)
  const [loading, setLoading]           = useState(true)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('OPEN')
  const [channelFilter, setChannelFilter] = useState<string>('')
  const [busy, setBusy]                 = useState<string | null>(null)
  const [ignoreModal, setIgnoreModal]   = useState<{ id: string; sku: string } | null>(null)
  const [ignoreReason, setIgnoreReason] = useState('')
  const [sortBy, setSortBy]             = useState('observed')
  const [lastFetchedAt, setLastFetchedAt] = useState<number | null>(null)
  const [autoRefreshMin, setAutoRefreshMin] = useState<0 | 5 | 15>(0)
  const [density, setDensity]           = useState<Density>(() => {
    try { return (localStorage.getItem(`${STORAGE_KEY}.density`) as Density) ?? 'comfortable' } catch { return 'comfortable' }
  })

  useEffect(() => {
    try { localStorage.setItem(`${STORAGE_KEY}.density`, density) } catch {}
  }, [density])

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
      setLastFetchedAt(Date.now())
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('common.error'))
    } finally { setLoading(false) }
  }, [statusFilter, channelFilter, t, toast])

  useEffect(() => { fetchEvents() }, [fetchEvents])

  // SD-RT.2 — channel-drift queue feeds on ChannelStockEvent rows
  // minted by Shopify inventory_levels/update + eBay ItemRevised +
  // Amazon FBA_INVENTORY_AVAILABILITY_CHANGES. Each of those lands
  // a stock.adjusted on the bus (via CS-series + RT.9/10/11 paths).
  // inbound.received can ALSO close a drift when receipt brings
  // local back to channel-reported.
  useListingEvents()
  useInboundEvents()
  useInvalidationChannel(
    [
      'stock.adjusted', 'stock.transferred',
      'inbound.received', 'inbound.discrepancy',
      'product.updated',
    ],
    fetchEvents,
  )

  const channels = useMemo(() =>
    Array.from(new Set((events ?? []).map(e => e.channel))).sort(),
  [events])

  const apply = useCallback(async (id: string) => {
    setBusy(id)
    try {
      const res = await fetch(`${getBackendUrl()}/api/stock/channel-events/${id}/apply`, { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`)
      toast.success(t('channelDrift.toast.applied'))
      await fetchEvents()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('common.error'))
    } finally { setBusy(null) }
  }, [fetchEvents, t, toast])

  const openIgnore = useCallback((id: string, sku: string) => {
    setIgnoreModal({ id, sku })
    setIgnoreReason('')
  }, [])

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
    } finally { setBusy(null) }
  }

  const onSort = useCallback((key: string) => {
    setSortBy(prev => {
      const base = key.replace(/-asc$/, '')
      if (prev === base) return `${base}-asc`
      if (prev === `${base}-asc`) return base
      return base
    })
  }, [])

  const { rows, reviewIds } = useMemo(() => {
    if (!events) return { rows: [] as DriftRow[], reviewIds: _EMPTY_SET }
    const base = events.map(e => ({ ...e, isParent: false as const, childCount: 0, parentId: null }))
    const [key, dir] = sortBy.endsWith('-asc') ? [sortBy.slice(0, -4), 'asc'] : [sortBy, 'desc']
    const sorted = [...base].sort((a, b) => {
      let av: any, bv: any
      switch (key) {
        case 'channel':  av = a.channel;    bv = b.channel;    break
        case 'drift':    av = a.drift;      bv = b.drift;      break
        case 'observed': av = a.createdAt;  bv = b.createdAt;  break
        default: return 0
      }
      const cmp = typeof av === 'string' ? av.localeCompare(bv) : ((av ?? 0) - (bv ?? 0))
      return dir === 'asc' ? cmp : -cmp
    })
    const urgentIds = new Set(sorted.filter(r => r.status === 'REVIEW_NEEDED').map(r => r.id))
    return { rows: sorted, reviewIds: urgentIds }
  }, [events, sortBy])

  const cellPad = DENSITY_CELL_CLASS[density] ?? DENSITY_CELL_CLASS.comfortable

  const renderCell = useCallback((row: DriftRow, colKey: string) => {
    const isOpen = row.status === 'PENDING' || row.status === 'REVIEW_NEEDED'
    const driftLarge = Math.abs(row.drift) > 5

    switch (colKey) {
      case 'channel':
        return <span className="font-mono text-xs text-slate-700 dark:text-slate-300">{row.channel}</span>
      case 'product':
        return row.product ? (
          <div>
            <div className="text-sm text-slate-900 dark:text-slate-100 truncate">{row.product.name}</div>
            <div className="font-mono text-xs text-slate-500 dark:text-slate-400">{row.product.sku}</div>
          </div>
        ) : (
          <div>
            <div className="font-mono text-xs text-slate-500 dark:text-slate-400">{row.sku}</div>
            <div className="text-xs text-amber-700 dark:text-amber-300 inline-flex items-center gap-1">
              <AlertTriangle size={10} /> {t('channelDrift.unmappedSku')}
            </div>
          </div>
        )
      case 'local':
        return <span className="tabular-nums text-sm text-slate-700 dark:text-slate-300">{row.localQtyAtObservation}</span>
      case 'reported':
        return <span className="tabular-nums text-sm text-slate-700 dark:text-slate-300">{row.channelReportedQty}</span>
      case 'drift':
        return (
          <span className={`tabular-nums text-sm font-semibold ${
            row.drift === 0 ? 'text-tertiary dark:text-slate-500'
              : driftLarge ? 'text-rose-700 dark:text-rose-300'
              : 'text-amber-700 dark:text-amber-300'
          }`}>
            {row.drift > 0 ? '+' : ''}{row.drift}
          </span>
        )
      case 'status':
        return (
          <div>
            <span className={`text-xs uppercase tracking-wider font-semibold px-1.5 py-0.5 border rounded ${STATUS_TONE[row.status] ?? ''}`}>
              {row.status.replace(/_/g, ' ')}
            </span>
            {row.resolution && (
              <div className="text-xs text-slate-500 dark:text-slate-400 italic mt-1 truncate max-w-[180px]" title={row.resolution}>
                {row.resolution}
              </div>
            )}
          </div>
        )
      case 'observed':
        return (
          <span className="text-xs text-slate-500 dark:text-slate-400 whitespace-nowrap">
            {new Date(row.createdAt).toLocaleString('it-IT', { year: '2-digit', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
          </span>
        )
      case 'actions':
        return isOpen && row.product ? (
          <div className="inline-flex items-center gap-1.5">
            <button
              onClick={() => apply(row.id)}
              disabled={busy === row.id}
              className="h-7 px-2 text-sm bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-900 rounded hover:bg-emerald-100 dark:hover:bg-emerald-900/60 disabled:opacity-50 inline-flex items-center gap-1"
            >
              {busy === row.id ? t('channelDrift.action.applying') : t('channelDrift.action.apply')}
            </button>
            <button
              onClick={() => openIgnore(row.id, row.sku)}
              disabled={busy === row.id}
              className="h-7 px-2 text-sm bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border border-default dark:border-slate-700 rounded hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-50 inline-flex items-center gap-1"
            >
              {t('channelDrift.action.ignore')}
            </button>
          </div>
        ) : null
      default:
        return null
    }
  }, [t, busy, apply, openIgnore])

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
      />
      <StockSubNav />

      {/* Status + channel filters */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mr-1">
          {t('channelDrift.filter.statusLabel')}
        </span>
        {STATUS_CHIPS.map(chip => (
          <button key={chip.key} onClick={() => setStatusFilter(chip.key)} aria-pressed={statusFilter === chip.key}
            className={`h-7 px-3 text-sm rounded-full font-medium border ${statusFilter === chip.key
              ? 'bg-slate-900 dark:bg-slate-100 text-white border-slate-900 dark:text-slate-900'
              : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 border-default dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600'}`}>
            {t(chip.labelKey as any)}
          </button>
        ))}
        {channels.length > 1 && (
          <>
            <span className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mx-1">
              {t('channelDrift.filter.channelLabel')}
            </span>
            <button onClick={() => setChannelFilter('')} aria-pressed={channelFilter === ''}
              className={`h-7 px-3 text-sm rounded-full font-medium border ${channelFilter === ''
                ? 'bg-slate-900 dark:bg-slate-100 text-white border-slate-900 dark:text-slate-900'
                : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 border-default dark:border-slate-700'}`}>
              {t('channelDrift.filter.allChannels')}
            </button>
            {channels.map(c => (
              <button key={c} onClick={() => setChannelFilter(c)} aria-pressed={channelFilter === c}
                className={`h-7 px-3 text-sm rounded-full font-medium border ${channelFilter === c
                  ? 'bg-slate-900 dark:bg-slate-100 text-white border-slate-900 dark:text-slate-900'
                  : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 border-default dark:border-slate-700'}`}>
                {c}
              </button>
            ))}
          </>
        )}
      </div>

      <GridToolbar
        quickFilterSlot={
          events && events.length > 0 ? (
            <span className="text-sm text-slate-500 dark:text-slate-400">
              {rows.length} event{rows.length === 1 ? '' : 's'}
              {reviewIds.size > 0 && <span className="ml-1.5 text-amber-700 dark:text-amber-400 font-medium">· {reviewIds.size} need review</span>}
            </span>
          ) : undefined
        }
        density={<DensityToggle density={density} onChange={setDensity} />}
        autoRefresh={
          <AutoRefreshSelect
            value={autoRefreshMin}
            onChange={setAutoRefreshMin}
            onTick={fetchEvents}
          />
        }
        freshness={
          <FreshnessIndicator
            lastFetchedAt={lastFetchedAt}
            onRefresh={fetchEvents}
            loading={loading}
          />
        }
      />

      {!loading && rows.length === 0 && (
        <EmptyState icon={CheckCircle2} title={t('channelDrift.empty.title')} description={t('channelDrift.empty.description')} />
      )}

      {rows.length > 0 && (<>
        <VirtualizedGrid
          rows={rows}
          visible={DRIFT_COLUMNS}
          density={density}
          cellPad={cellPad}
          selected={_EMPTY_SET}
          toggleSelect={_NOOP as any}
          toggleSelectAll={_NOOP}
          allSelected={false}
          sortBy={sortBy}
          onSort={onSort}
          sortKeys={DRIFT_SORT_KEYS}
          expandedParents={_EMPTY_SET}
          childrenByParent={_EMPTY_MAP}
          loadingChildren={_EMPTY_SET}
          onToggleExpand={_NOOP}
          focusedRowId={null}
          searchTerm=""
          riskFlaggedSkus={_EMPTY_SET}
          storageKey={STORAGE_KEY}
          showExpandColumn={false}
          stagedIds={reviewIds}
          renderCell={renderCell}
        />
        <GridFooter count={rows.length} label="events" />
      </>)}

      {/* Ignore reason modal — unchanged from original */}
      {ignoreModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={e => { if (e.target === e.currentTarget && busy === null) { setIgnoreModal(null); setIgnoreReason('') } }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="ignore-title"
        >
          <div className="bg-white dark:bg-slate-900 border border-default dark:border-slate-700 rounded-lg shadow-xl w-full max-w-md">
            <div className="flex items-center justify-between gap-2 px-5 py-3 border-b border-default dark:border-slate-700">
              <h2 id="ignore-title" className="text-lg font-semibold text-slate-900 dark:text-slate-100">
                {t('channelDrift.ignore.title', { sku: ignoreModal.sku })}
              </h2>
              <button onClick={() => { setIgnoreModal(null); setIgnoreReason('') }} disabled={busy !== null}
                className="h-8 w-8 inline-flex items-center justify-center rounded text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
                aria-label={t('common.close')}>
                <X size={16} />
              </button>
            </div>
            <div className="p-5 space-y-3">
              <p className="text-base text-slate-600 dark:text-slate-400">{t('channelDrift.ignore.help')}</p>
              <textarea
                value={ignoreReason}
                onChange={e => setIgnoreReason(e.target.value)}
                placeholder={t('channelDrift.ignore.placeholder')}
                rows={3}
                autoFocus
                className="w-full px-2 py-1.5 text-base border border-default dark:border-slate-700 rounded bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
              />
            </div>
            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-default dark:border-slate-700">
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
