'use client'

/**
 * LP.1 — Lots dashboard. Default sort by expiresAt ASC (FEFO order)
 * with quick filter chips for "expiring soon" / "active only".
 *
 * S.1 — table replaced with SharedVirtualizedGrid so column-resize,
 * keyboard nav, density, and all future GridLens features apply here.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Package, AlertCircle } from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { StockSubNav } from '@/components/inventory/StockSubNav'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import FreshnessIndicator from '@/components/filters/FreshnessIndicator'
import { getBackendUrl } from '@/lib/backend-url'
import { useTranslations } from '@/lib/i18n/use-translations'
import { formatRelative } from '@/components/inventory/formatRelative'
import { AutoRefreshSelect, DensityToggle, GridToolbar, VirtualizedGrid, GridFooter } from '@/app/_shared/grid-lens'
import type { GridLensColumn, GridLensRow } from '@/app/_shared/grid-lens'
import { type Density, DENSITY_CELL_CLASS } from '@/lib/products/theme'

// ── Types ─────────────────────────────────────────────────────────────

interface Lot {
  id: string
  lotNumber: string
  receivedAt: string
  expiresAt: string | null
  unitsReceived: number
  unitsRemaining: number
  supplierLotRef: string | null
  product: { id: string; sku: string; name: string }
  variation: { id: string; sku: string } | null
}

type LotRow = Lot & GridLensRow

type ExpiryFilter = 'all' | 'expiring30' | 'expiring90'

// ── Constants ─────────────────────────────────────────────────────────

const LOT_COLUMNS: GridLensColumn[] = [
  { key: 'lot',         label: 'Lot',          subLabel: 'Lot number',    width: 160 },
  { key: 'product',     label: 'Product',      subLabel: 'SKU · Name',    width: 300 },
  { key: 'units',       label: 'Units',        subLabel: 'Remaining / Rx',width: 110 },
  { key: 'expires',     label: 'Expires',      subLabel: 'FEFO date',     width: 160 },
  { key: 'received',    label: 'Received',     subLabel: 'When',          width: 120 },
  { key: 'supplierRef', label: 'Supplier Ref', subLabel: 'Ref number',    width: 150 },
]

const LOT_SORT_KEYS: Record<string, string> = {
  lot: 'lot', units: 'units', expires: 'expires', received: 'received',
}

const STORAGE_KEY = 'stock-lots'
const _EMPTY_SET = new Set<string>()
const _EMPTY_MAP = {}
const _NOOP = () => {}

// ── Component ─────────────────────────────────────────────────────────

export default function LotsClient() {
  const { t } = useTranslations()
  const [lots, setLots]         = useState<Lot[] | null>(null)
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState<string | null>(null)
  const [activeOnly, setActiveOnly] = useState(true)
  const [expiry, setExpiry]     = useState<ExpiryFilter>('all')
  const [sortBy, setSortBy]     = useState('expires-asc') // FEFO default
  const [lastFetchedAt, setLastFetchedAt] = useState<number | null>(null)
  const [autoRefreshMin, setAutoRefreshMin] = useState<0 | 5 | 15>(0)
  const [density, setDensity]   = useState<Density>(() => {
    try { return (localStorage.getItem(`${STORAGE_KEY}.density`) as Density) ?? 'comfortable' } catch { return 'comfortable' }
  })

  useEffect(() => {
    try { localStorage.setItem(`${STORAGE_KEY}.density`, density) } catch {}
  }, [density])

  const fetchLots = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams()
      if (!activeOnly) params.set('activeOnly', '0')
      if (expiry === 'expiring30') params.set('expiringWithinDays', '30')
      else if (expiry === 'expiring90') params.set('expiringWithinDays', '90')
      params.set('limit', '500')
      const res = await fetch(`${getBackendUrl()}/api/stock/lots?${params}`, { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = await res.json()
      setLots(body.items)
      setLastFetchedAt(Date.now())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setLoading(false) }
  }, [activeOnly, expiry])

  useEffect(() => { fetchLots() }, [fetchLots])

  // Client-side sort
  const rows = useMemo((): LotRow[] => {
    if (!lots) return []
    const base = lots.map(l => ({ ...l, isParent: false as const, childCount: 0, parentId: null }))
    const [key, dir] = sortBy.endsWith('-asc') ? [sortBy.slice(0, -4), 'asc'] : [sortBy, 'desc']
    return [...base].sort((a, b) => {
      let av: any, bv: any
      switch (key) {
        case 'lot':      av = a.lotNumber;      bv = b.lotNumber;      break
        case 'units':    av = a.unitsRemaining; bv = b.unitsRemaining; break
        case 'expires':  av = a.expiresAt ?? '9999'; bv = b.expiresAt ?? '9999'; break
        case 'received': av = a.receivedAt;     bv = b.receivedAt;     break
        default: return 0
      }
      const cmp = typeof av === 'string' ? av.localeCompare(bv) : ((av ?? 0) - (bv ?? 0))
      return dir === 'asc' ? cmp : -cmp
    })
  }, [lots, sortBy])

  const cellPad = DENSITY_CELL_CLASS[density] ?? DENSITY_CELL_CLASS.comfortable

  const onSort = useCallback((key: string) => {
    setSortBy(prev => {
      const base = key.replace(/-asc$/, '')
      if (prev === base) return `${base}-asc`
      if (prev === `${base}-asc`) return base
      return base
    })
  }, [])

  const renderCell = useCallback((row: LotRow, colKey: string) => {
    const expiresInDays = row.expiresAt
      ? Math.ceil((new Date(row.expiresAt).getTime() - Date.now()) / 86400_000)
      : null
    const expiringSoon = expiresInDays != null && expiresInDays <= 30

    switch (colKey) {
      case 'lot':
        return <span className="font-mono text-sm text-slate-900 dark:text-slate-100 whitespace-nowrap">{row.lotNumber}</span>
      case 'product':
        return (
          <Link href={`/products/${row.product.id}/edit`} className="hover:underline">
            <span className="font-mono text-xs text-slate-500 dark:text-slate-400">{row.product.sku}</span>
            {' · '}
            <span className="text-sm text-slate-700 dark:text-slate-300">{row.product.name}</span>
          </Link>
        )
      case 'units':
        return (
          <span className="tabular-nums text-sm">
            <span className="font-semibold text-slate-900 dark:text-slate-100">{row.unitsRemaining}</span>
            <span className="text-slate-400 dark:text-slate-500">/{row.unitsReceived}</span>
          </span>
        )
      case 'expires':
        return row.expiresAt ? (
          <span className={`text-sm whitespace-nowrap ${expiringSoon ? 'text-amber-700 dark:text-amber-400 font-medium' : 'text-slate-600 dark:text-slate-400'}`}>
            {new Date(row.expiresAt).toLocaleDateString()}
            {expiringSoon && <span className="ml-1 text-xs">· {t('stock.lots.expiringInDays', { days: expiresInDays })}</span>}
          </span>
        ) : <span className="text-slate-300 dark:text-slate-600">—</span>
      case 'received':
        return <span className="text-sm text-slate-500 dark:text-slate-400">{formatRelative(row.receivedAt, t)}</span>
      case 'supplierRef':
        return row.supplierLotRef
          ? <span className="font-mono text-xs text-slate-500 dark:text-slate-400">{row.supplierLotRef}</span>
          : <span className="text-slate-300 dark:text-slate-600">—</span>
      default:
        return null
    }
  }, [t])

  return (
    <div className="p-3 sm:p-6 space-y-3 sm:space-y-6">
      <PageHeader
        title={t('stock.lots.pageTitle')}
        description={t('stock.lots.pageDescription')}
        breadcrumbs={[
          { label: t('nav.fulfillment'), href: '/fulfillment' },
          { label: t('stock.title'), href: '/fulfillment/stock' },
          { label: t('stock.lots.pageTitle') },
        ]}
      />
      <StockSubNav />

      <GridToolbar
        quickFilterSlot={
          <>
            <div className="inline-flex items-center gap-1 border border-slate-200 dark:border-slate-700 rounded-md p-0.5">
              {(['all', 'expiring30', 'expiring90'] as const).map(e => (
                <button
                  key={e}
                  onClick={() => setExpiry(e)}
                  aria-pressed={expiry === e}
                  className={`h-8 px-3 text-sm rounded ${expiry === e ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900' : 'text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800'}`}
                >
                  {t(`stock.lots.filter.${e}` as any)}
                </button>
              ))}
            </div>
            <label className="inline-flex items-center gap-1.5 text-sm text-slate-700 dark:text-slate-300">
              <input type="checkbox" checked={activeOnly} onChange={e => setActiveOnly(e.target.checked)} />
              {t('stock.lots.activeOnly')}
            </label>
          </>
        }
        density={<DensityToggle density={density} onChange={setDensity} />}
        autoRefresh={
          <AutoRefreshSelect
            value={autoRefreshMin}
            onChange={setAutoRefreshMin}
            onTick={fetchLots}
          />
        }
        freshness={
          <FreshnessIndicator
            lastFetchedAt={lastFetchedAt}
            onRefresh={fetchLots}
            loading={loading}
          />
        }
      />

      {error && (
        <Card>
          <div className="text-rose-700 inline-flex items-center gap-2">
            <AlertCircle size={14} aria-hidden="true" /> {error}
          </div>
        </Card>
      )}

      {!loading && rows.length === 0 && !error && (
        <EmptyState icon={Package} title={t('stock.lots.empty.title')} description={t('stock.lots.empty.description')} />
      )}

      {rows.length > 0 && (<>
        <VirtualizedGrid
          rows={rows}
          visible={LOT_COLUMNS}
          density={density}
          cellPad={cellPad}
          selected={_EMPTY_SET}
          toggleSelect={_NOOP as any}
          toggleSelectAll={_NOOP}
          allSelected={false}
          sortBy={sortBy}
          onSort={onSort}
          sortKeys={LOT_SORT_KEYS}
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
        <GridFooter count={rows.length} label="lots" />
      </>)}
    </div>
  )
}
