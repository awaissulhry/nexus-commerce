'use client'

/**
 * S.24 — MCF dashboard. Lists Amazon Multi-Channel Fulfillment shipments.
 *
 * S.2 — table replaced with SharedVirtualizedGrid.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Truck, ArrowLeft, RefreshCw, AlertCircle, X } from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { StockSubNav } from '@/components/inventory/StockSubNav'
import { Badge } from '@/components/ui/Badge'
import { EmptyState } from '@/components/ui/EmptyState'
import { useToast } from '@/components/ui/Toast'
import { useConfirm } from '@/components/ui/ConfirmProvider'
import FreshnessIndicator from '@/components/filters/FreshnessIndicator'
import { getBackendUrl } from '@/lib/backend-url'
import { useInvalidationChannel } from '@/lib/sync/invalidation-channel'
import { useOrderEventsRefresh } from '@/hooks/use-order-events-refresh'
import { useOutboundEvents } from '@/lib/sync/use-outbound-events'
import { useTranslations } from '@/lib/i18n/use-translations'
import { formatRelative } from '@/components/inventory/formatRelative'
import { cn } from '@/lib/utils'
import { AutoRefreshSelect, DensityToggle, GridToolbar, VirtualizedGrid, GridFooter } from '@/app/_shared/grid-lens'
import type { GridLensColumn, GridLensRow } from '@/app/_shared/grid-lens'
import { type Density, DENSITY_CELL_CLASS } from '@/lib/products/theme'

// ── Types ─────────────────────────────────────────────────────────────

type StatusFilter = 'all' | 'active' | 'COMPLETE' | 'CANCELLED'

interface MCFRow {
  id: string
  orderId: string
  channelOrderId: string
  channel: string
  amazonFulfillmentOrderId: string
  status: string
  trackingNumber: string | null
  carrier: string | null
  shippedAt: string | null
  deliveredAt: string | null
  requestedAt: string
  lastSyncedAt: string | null
  lastError: string | null
}

type MCFGridRow = MCFRow & GridLensRow

// ── Constants ─────────────────────────────────────────────────────────

const MCF_COLUMNS: GridLensColumn[] = [
  { key: 'order',     label: 'Order',      subLabel: 'Channel · ID',      width: 220 },
  { key: 'amazonId',  label: 'Amazon ID',  subLabel: 'Fulfillment order', width: 180 },
  { key: 'status',    label: 'Status',     subLabel: 'State',             width: 150 },
  { key: 'tracking',  label: 'Tracking',   subLabel: 'Number · Carrier',  width: 170 },
  { key: 'requested', label: 'Requested',  subLabel: 'When',              width: 130 },
  { key: 'actions',   label: '',                                           width: 100 },
]

const MCF_SORT_KEYS: Record<string, string> = {
  status: 'status', requested: 'requested',
}

const FILTERS: { key: StatusFilter; labelKey: string }[] = [
  { key: 'all',       labelKey: 'stock.mcf.filter.all' },
  { key: 'active',    labelKey: 'stock.mcf.filter.active' },
  { key: 'COMPLETE',  labelKey: 'stock.mcf.filter.complete' },
  { key: 'CANCELLED', labelKey: 'stock.mcf.filter.cancelled' },
]

const TERMINAL_STATUSES = new Set(['COMPLETE', 'COMPLETE_PARTIALLED', 'CANCELLED', 'UNFULFILLABLE', 'INVALID'])

function statusVariant(status: string): 'success' | 'warning' | 'danger' | 'info' | 'default' {
  if (status === 'COMPLETE' || status === 'COMPLETE_PARTIALLED') return 'success'
  if (TERMINAL_STATUSES.has(status) && status !== 'COMPLETE' && status !== 'COMPLETE_PARTIALLED') return 'danger'
  if (status === 'PROCESSING' || status === 'PLANNING') return 'info'
  if (status === 'NEW' || status === 'RECEIVED') return 'warning'
  return 'default'
}

const STORAGE_KEY = 'stock-mcf'
const _EMPTY_SET = new Set<string>()
const _EMPTY_MAP = {}
const _NOOP = () => {}

// ── Component ─────────────────────────────────────────────────────────

export default function MCFClient() {
  const { t } = useTranslations()
  const { toast } = useToast()
  const askConfirm = useConfirm()
  const [shipments, setShipments] = useState<MCFRow[] | null>(null)
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState<string | null>(null)
  const [filter, setFilter]       = useState<StatusFilter>('active')
  const [actingId, setActingId]   = useState<string | null>(null)
  const [sortBy, setSortBy]       = useState('requested')
  const [lastFetchedAt, setLastFetchedAt] = useState<number | null>(null)
  const [autoRefreshMin, setAutoRefreshMin] = useState<0 | 5 | 15>(0)
  const [density, setDensity]     = useState<Density>(() => {
    try { return (localStorage.getItem(`${STORAGE_KEY}.density`) as Density) ?? 'comfortable' } catch { return 'comfortable' }
  })

  useEffect(() => {
    try { localStorage.setItem(`${STORAGE_KEY}.density`, density) } catch {}
  }, [density])

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`${getBackendUrl()}/api/stock/mcf?status=${filter}&limit=200`, { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      setShipments(json.shipments ?? [])
      setLastFetchedAt(Date.now())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally { setLoading(false) }
  }, [filter])

  useEffect(() => { fetchData() }, [fetchData])

  // SD-RT.3 — MCF (FBA Outbound) status flows from Amazon SP-API push
  // covered by RT.6 (`f1d62365 feat(sync): MCF push-notification
  // path`). order events drive new MCF submissions (orders flagged
  // for MCF fulfillment); shipment.updated catches tracking events
  // from MCF outbound shipments through Sendcloud.
  useOutboundEvents()
  useOrderEventsRefresh(fetchData, {
    eventTypes: ['order.created', 'order.updated', 'order.cancelled'],
  })
  useInvalidationChannel(
    ['shipment.updated', 'shipment.created', 'order.shipped'],
    fetchData,
  )

  const handleSync = useCallback(async (s: MCFRow) => {
    setActingId(s.id)
    try {
      const res = await fetch(`${getBackendUrl()}/api/stock/mcf/${s.id}/sync`, { method: 'POST' })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
      if (body.changed) toast.success(t('stock.mcf.toast.synced', { status: body.status }))
      else toast.success(t('stock.mcf.toast.syncedNoChange'))
      await fetchData()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally { setActingId(null) }
  }, [t, toast, fetchData])

  const handleCancel = useCallback(async (s: MCFRow) => {
    if (!(await askConfirm({
      title: t('stock.mcf.cancelConfirmTitle'),
      description: t('stock.mcf.cancelConfirmDescription'),
      confirmLabel: t('stock.mcf.cancel'),
      tone: 'warning',
    }))) return
    setActingId(s.id)
    try {
      const res = await fetch(`${getBackendUrl()}/api/stock/mcf/${s.id}/cancel`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
      toast.success(t('stock.mcf.toast.cancelled'))
      await fetchData()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally { setActingId(null) }
  }, [askConfirm, t, toast, fetchData])

  const rows = useMemo((): MCFGridRow[] => {
    if (!shipments) return []
    const base = shipments.map(s => ({ ...s, isParent: false as const, childCount: 0, parentId: null }))
    const [key, dir] = sortBy.endsWith('-asc') ? [sortBy.slice(0, -4), 'asc'] : [sortBy, 'desc']
    return [...base].sort((a, b) => {
      let av: any, bv: any
      switch (key) {
        case 'status':    av = a.status;      bv = b.status;      break
        case 'requested': av = a.requestedAt; bv = b.requestedAt; break
        default: return 0
      }
      const cmp = typeof av === 'string' ? av.localeCompare(bv) : ((av ?? 0) - (bv ?? 0))
      return dir === 'asc' ? cmp : -cmp
    })
  }, [shipments, sortBy])

  const cellPad = DENSITY_CELL_CLASS[density] ?? DENSITY_CELL_CLASS.comfortable

  const onSort = useCallback((key: string) => {
    setSortBy(prev => {
      const base = key.replace(/-asc$/, '')
      if (prev === base) return `${base}-asc`
      if (prev === `${base}-asc`) return base
      return base
    })
  }, [])

  const renderCell = useCallback((row: MCFGridRow, colKey: string) => {
    switch (colKey) {
      case 'order':
        return (
          <div className="flex items-center gap-1.5">
            <Badge variant="default" size="sm">{row.channel}</Badge>
            <span className="font-mono text-sm text-slate-900 dark:text-slate-100">{row.channelOrderId}</span>
          </div>
        )
      case 'amazonId':
        return (
          <span className="font-mono text-xs text-slate-500 dark:text-slate-400" title={row.amazonFulfillmentOrderId}>
            {row.amazonFulfillmentOrderId.slice(-16)}
          </span>
        )
      case 'status':
        return (
          <div>
            <Badge variant={statusVariant(row.status)} size="sm">{row.status}</Badge>
            {row.lastError && (
              <div className="text-xs text-rose-600 mt-0.5 truncate max-w-[200px]" title={row.lastError}>
                {row.lastError.slice(0, 60)}
              </div>
            )}
          </div>
        )
      case 'tracking':
        return row.trackingNumber ? (
          <div>
            <div className="font-mono text-sm text-slate-700 dark:text-slate-300">{row.trackingNumber}</div>
            {row.carrier && <div className="text-xs text-slate-500 dark:text-slate-400">{row.carrier}</div>}
          </div>
        ) : <span className="text-slate-300 dark:text-slate-600">—</span>
      case 'requested':
        return (
          <div className="text-sm text-slate-500 dark:text-slate-400" title={new Date(row.requestedAt).toLocaleString()}>
            <div>{formatRelative(row.requestedAt, t)}</div>
            {row.lastSyncedAt && (
              <div className="text-xs text-tertiary dark:text-slate-500">
                {t('stock.mcf.syncedAt', { when: formatRelative(row.lastSyncedAt, t) })}
              </div>
            )}
          </div>
        )
      case 'actions':
        return (
          <div className="inline-flex items-center gap-1">
            <button type="button" onClick={() => handleSync(row)} disabled={actingId === row.id}
              title={t('stock.mcf.syncTitle')} aria-label={t('stock.mcf.syncTitle')}
              className="h-7 w-7 inline-flex items-center justify-center text-slate-500 dark:text-slate-400 bg-white dark:bg-slate-900 border border-default dark:border-slate-700 rounded hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50">
              <RefreshCw size={11} className={actingId === row.id ? 'animate-spin' : ''} />
            </button>
            {!TERMINAL_STATUSES.has(row.status) && (
              <button type="button" onClick={() => handleCancel(row)} disabled={actingId === row.id}
                aria-label={t('stock.mcf.cancel')}
                className="h-7 w-7 inline-flex items-center justify-center text-rose-600 bg-white dark:bg-slate-900 border border-rose-200 rounded hover:bg-rose-50 disabled:opacity-50">
                <X size={11} />
              </button>
            )}
          </div>
        )
      default:
        return null
    }
  }, [t, actingId, handleSync, handleCancel])

  return (
    <div className="space-y-4">
      <PageHeader
        title={t('stock.mcf.title')}
        description={t('stock.mcf.description')}
        breadcrumbs={[
          { label: t('nav.fulfillment'), href: '/fulfillment' },
          { label: t('stock.title'), href: '/fulfillment/stock' },
          { label: t('stock.mcf.title') },
        ]}
        actions={
          <Link href="/fulfillment/stock"
            className="inline-flex items-center gap-1.5 h-11 sm:h-8 px-3 text-base text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100">
            <ArrowLeft size={14} /> {t('stock.title')}
          </Link>
        }
      />
      <StockSubNav />

      <GridToolbar
        quickFilterSlot={
          <div className="flex items-center gap-1">
            {FILTERS.map(f => (
              <button key={f.key} type="button" onClick={() => setFilter(f.key)}
                className={cn('min-h-[44px] sm:min-h-0 px-2.5 py-1 text-sm font-medium rounded border transition-colors',
                  filter === f.key
                    ? 'bg-slate-900 text-white border-slate-900'
                    : 'bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 border-default dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600')}>
                {t(f.labelKey)}
              </button>
            ))}
          </div>
        }
        density={<DensityToggle density={density} onChange={setDensity} />}
        autoRefresh={
          <AutoRefreshSelect
            value={autoRefreshMin}
            onChange={setAutoRefreshMin}
            onTick={fetchData}
          />
        }
        freshness={
          <FreshnessIndicator
            lastFetchedAt={lastFetchedAt}
            onRefresh={fetchData}
            loading={loading}
          />
        }
      />

      {error && (
        <div className="text-base text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2 inline-flex items-center gap-2">
          <AlertCircle className="w-3.5 h-3.5" /> {error}
        </div>
      )}

      {loading && !shipments && (
        <div className="space-y-2">
          {[0,1,2].map(i => <div key={i} className="h-16 bg-white dark:bg-slate-900 border border-default dark:border-slate-700 rounded-lg animate-pulse" />)}
        </div>
      )}

      {shipments !== null && rows.length === 0 && !loading && (
        <EmptyState icon={Truck} title={t('stock.mcf.empty.title')} description={t('stock.mcf.empty.description')}
          action={{ label: t('stock.title'), href: '/fulfillment/stock' }} />
      )}

      {rows.length > 0 && (<>
        <VirtualizedGrid
          rows={rows}
          visible={MCF_COLUMNS}
          density={density}
          cellPad={cellPad}
          selected={_EMPTY_SET}
          toggleSelect={_NOOP as any}
          toggleSelectAll={_NOOP}
          allSelected={false}
          sortBy={sortBy}
          onSort={onSort}
          sortKeys={MCF_SORT_KEYS}
          expandedParents={_EMPTY_SET}
          childrenByParent={_EMPTY_MAP}
          loadingChildren={_EMPTY_SET}
          onToggleExpand={_NOOP}
          focusedRowId={null}
          searchTerm=""
          riskFlaggedSkus={_EMPTY_SET}
          storageKey={STORAGE_KEY}
          showExpandColumn={false}
          renderCell={renderCell}
        />
        <GridFooter count={rows.length} label="shipments" />
      </>)}
    </div>
  )
}
