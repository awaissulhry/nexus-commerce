'use client'

/**
 * S.13 — Transfers list. Reads /api/stock/transfers (paired
 * TRANSFER_OUT/TRANSFER_IN movements collapsed to a single row).
 *
 * S.1 — table replaced with SharedVirtualizedGrid.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { ArrowRightLeft, ArrowLeft, Package, AlertCircle, AlignJustify, Menu as MenuIcon, Equal } from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { StockSubNav } from '@/components/inventory/StockSubNav'
import { Badge } from '@/components/ui/Badge'
import { EmptyState } from '@/components/ui/EmptyState'
import FreshnessIndicator from '@/components/filters/FreshnessIndicator'
import { getBackendUrl } from '@/lib/backend-url'
import { useTranslations } from '@/lib/i18n/use-translations'
import { formatRelative } from '@/components/inventory/formatRelative'
import { AutoRefreshSelect, VirtualizedGrid, GridFooter } from '@/app/_shared/grid-lens'
import type { GridLensColumn, GridLensRow } from '@/app/_shared/grid-lens'
import { type Density, DENSITY_CELL_CLASS } from '@/lib/products/theme'

// ── Types ─────────────────────────────────────────────────────────────

interface Transfer {
  id: string
  siblingOutId: string | null
  quantity: number
  createdAt: string
  startedAt: string
  actor: string | null
  notes: string | null
  from: { id: string; code: string; name: string; type: string } | null
  to: { id: string; code: string; name: string; type: string } | null
  product: {
    id: string; sku: string; name: string
    amazonAsin: string | null; thumbnailUrl: string | null
  } | null
  status: 'COMPLETED' | 'IN_TRANSIT'
}

type TransferRow = Transfer & GridLensRow

// ── Constants ─────────────────────────────────────────────────────────

const TRANSFER_COLUMNS: GridLensColumn[] = [
  { key: 'product',  label: 'Product',  subLabel: 'SKU · Name', width: 300 },
  { key: 'from',     label: 'From',     subLabel: 'Location',   width: 110 },
  { key: 'to',       label: 'To',       subLabel: 'Location',   width: 110 },
  { key: 'quantity', label: 'Qty',      subLabel: 'Units',      width: 80  },
  { key: 'status',   label: 'Status',   subLabel: 'State',      width: 110 },
  { key: 'when',     label: 'When',     subLabel: 'Timestamp',  width: 120 },
]

const TRANSFER_SORT_KEYS: Record<string, string> = {
  quantity: 'quantity', when: 'when',
}

const STORAGE_KEY = 'stock-transfers'
const _EMPTY_SET = new Set<string>()
const _EMPTY_MAP = {}
const _NOOP = () => {}

// ── Component ─────────────────────────────────────────────────────────

export default function TransfersClient() {
  const { t } = useTranslations()
  const [transfers, setTransfers] = useState<Transfer[] | null>(null)
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState<string | null>(null)
  const [sortBy, setSortBy]       = useState('when') // most recent first (desc)
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
      const res = await fetch(`${getBackendUrl()}/api/stock/transfers?limit=100`, { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      setTransfers(json.transfers ?? [])
      setLastFetchedAt(Date.now())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { fetchData() }, [fetchData])

  const rows = useMemo((): TransferRow[] => {
    if (!transfers) return []
    const base = transfers.map(tr => ({ ...tr, isParent: false as const, childCount: 0, parentId: null }))
    const [key, dir] = sortBy.endsWith('-asc') ? [sortBy.slice(0, -4), 'asc'] : [sortBy, 'desc']
    return [...base].sort((a, b) => {
      let av: any, bv: any
      switch (key) {
        case 'quantity': av = a.quantity;   bv = b.quantity;   break
        case 'when':     av = a.createdAt;  bv = b.createdAt;  break
        default: return 0
      }
      const cmp = typeof av === 'string' ? av.localeCompare(bv) : ((av ?? 0) - (bv ?? 0))
      return dir === 'asc' ? cmp : -cmp
    })
  }, [transfers, sortBy])

  const cellPad = DENSITY_CELL_CLASS[density] ?? DENSITY_CELL_CLASS.comfortable

  const onSort = useCallback((key: string) => {
    setSortBy(prev => {
      const base = key.replace(/-asc$/, '')
      if (prev === base) return `${base}-asc`
      if (prev === `${base}-asc`) return base
      return base
    })
  }, [])

  const renderCell = useCallback((row: TransferRow, colKey: string) => {
    switch (colKey) {
      case 'product':
        return (
          <div className="flex items-center gap-2 min-w-0">
            {row.product?.thumbnailUrl ? (
              <img src={row.product.thumbnailUrl} alt="" className="w-8 h-8 rounded object-cover bg-slate-100 dark:bg-slate-800 flex-shrink-0" />
            ) : (
              <div className="w-8 h-8 rounded bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-400 flex-shrink-0">
                <Package size={14} />
              </div>
            )}
            <div className="min-w-0">
              <div className="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">{row.product?.name ?? '—'}</div>
              <div className="text-xs text-slate-500 dark:text-slate-400 font-mono truncate">
                {row.product?.sku ?? ''}
                {row.product?.amazonAsin && <span> · {row.product.amazonAsin}</span>}
              </div>
            </div>
          </div>
        )
      case 'from':
        return row.from ? (
          <span className="inline-block text-xs font-semibold uppercase tracking-wider px-1.5 py-0.5 border rounded bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700" title={row.from.name}>
            {row.from.code}
          </span>
        ) : <span className="text-slate-300 dark:text-slate-600">—</span>
      case 'to':
        return (
          <span className="inline-flex items-center gap-1">
            <ArrowRightLeft size={12} className="text-slate-400 dark:text-slate-500 flex-shrink-0" />
            {row.to ? (
              <span className="inline-block text-xs font-semibold uppercase tracking-wider px-1.5 py-0.5 border rounded bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700" title={row.to.name}>
                {row.to.code}
              </span>
            ) : <span className="text-slate-300 dark:text-slate-600">—</span>}
          </span>
        )
      case 'quantity':
        return <span className="tabular-nums font-semibold text-sm text-slate-900 dark:text-slate-100">{row.quantity}</span>
      case 'status':
        return (
          <Badge variant={row.status === 'COMPLETED' ? 'success' : 'info'} size="sm">
            {t(row.status === 'COMPLETED' ? 'stock.transfers.status.completed' : 'stock.transfers.status.inTransit')}
          </Badge>
        )
      case 'when':
        return (
          <span className="text-sm tabular-nums text-slate-500 dark:text-slate-400" title={new Date(row.createdAt).toLocaleString()}>
            {formatRelative(row.createdAt, t)}
          </span>
        )
      default:
        return null
    }
  }, [t])

  const DENSITY_OPTIONS: { d: Density; icon: React.ReactNode; label: string }[] = [
    { d: 'compact',     icon: <AlignJustify size={13} />, label: 'Compact' },
    { d: 'comfortable', icon: <MenuIcon size={13} />,     label: 'Comfortable' },
    { d: 'spacious',    icon: <Equal size={13} />,        label: 'Spacious' },
  ]

  return (
    <div className="space-y-4">
      <PageHeader
        title={t('stock.transfers.title')}
        description={t('stock.transfers.description')}
        breadcrumbs={[
          { label: t('nav.fulfillment'), href: '/fulfillment' },
          { label: t('stock.title'), href: '/fulfillment/stock' },
          { label: t('stock.transfers.title') },
        ]}
        actions={
          <div className="flex items-center gap-2">
            <Link href="/fulfillment/stock"
              className="inline-flex items-center gap-1.5 h-11 sm:h-8 px-3 text-base text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100">
              <ArrowLeft size={14} /> {t('stock.title')}
            </Link>
            <AutoRefreshSelect
              value={autoRefreshMin}
              onChange={setAutoRefreshMin}
              onTick={fetchData}
            />
            <FreshnessIndicator
              lastFetchedAt={lastFetchedAt}
              onRefresh={fetchData}
              loading={loading}
            />
          </div>
        }
      />
      <StockSubNav />

      {/* Density toolbar */}
      <div className="flex items-center gap-2">
        <span className="text-sm text-slate-500 dark:text-slate-400">
          {rows.length} {t('stock.transfers.title').toLowerCase()}
        </span>
        <div className="ml-auto flex items-center gap-0.5 border border-slate-200 dark:border-slate-700 rounded p-0.5">
          {DENSITY_OPTIONS.map(({ d, icon, label }) => (
            <button key={d} onClick={() => setDensity(d)} title={label} aria-pressed={density === d}
              className={`h-6 w-6 inline-flex items-center justify-center rounded transition-colors ${density === d ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900' : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'}`}>
              {icon}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="text-base text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2 inline-flex items-center gap-2">
          <AlertCircle className="w-3.5 h-3.5" /> {error}
        </div>
      )}

      {loading && !transfers && (
        <div className="space-y-2">
          {[0, 1, 2, 3].map(i => (
            <div key={i} className="h-16 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg animate-pulse" />
          ))}
        </div>
      )}

      {transfers !== null && rows.length === 0 && !loading && (
        <EmptyState icon={ArrowRightLeft} title={t('stock.transfers.empty.title')} description={t('stock.transfers.empty.description')}
          action={{ label: t('stock.title'), href: '/fulfillment/stock' }} />
      )}

      {rows.length > 0 && (<>
        <VirtualizedGrid
          rows={rows}
          visible={TRANSFER_COLUMNS}
          density={density}
          cellPad={cellPad}
          selected={_EMPTY_SET}
          toggleSelect={_NOOP as any}
          toggleSelectAll={_NOOP}
          allSelected={false}
          sortBy={sortBy}
          onSort={onSort}
          sortKeys={TRANSFER_SORT_KEYS}
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
        <GridFooter count={rows.length} label="transfers" />
      </>)}
    </div>
  )
}
