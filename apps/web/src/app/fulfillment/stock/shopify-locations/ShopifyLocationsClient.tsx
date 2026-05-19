'use client'

/**
 * S.23 — Shopify Locations settings UI.
 *
 * S.1 — table replaced with SharedVirtualizedGrid.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Store, ArrowLeft, RefreshCw, AlertCircle, Search, AlignJustify, Menu as MenuIcon, Equal } from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { StockSubNav } from '@/components/inventory/StockSubNav'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { EmptyState } from '@/components/ui/EmptyState'
import { useToast } from '@/components/ui/Toast'
import FreshnessIndicator from '@/components/filters/FreshnessIndicator'
import { getBackendUrl } from '@/lib/backend-url'
import { useTranslations } from '@/lib/i18n/use-translations'
import { AutoRefreshSelect, VirtualizedGrid, GridFooter } from '@/app/_shared/grid-lens'
import type { GridLensColumn, GridLensRow } from '@/app/_shared/grid-lens'
import { type Density, DENSITY_CELL_CLASS } from '@/lib/products/theme'

// ── Types ─────────────────────────────────────────────────────────────

interface ShopifyLocationRow {
  id: string
  code: string
  name: string
  externalLocationId: string | null
  isActive: boolean
  skuCount: number
  totalQuantity: number
}

type LocationRow = ShopifyLocationRow & GridLensRow

// ── Constants ─────────────────────────────────────────────────────────

const LOCATION_COLUMNS: GridLensColumn[] = [
  { key: 'code',       label: 'Code',       subLabel: 'Location code', width: 120 },
  { key: 'name',       label: 'Name',       subLabel: 'Display name',  width: 220 },
  { key: 'shopifyId',  label: 'Shopify ID', subLabel: 'External ID',   width: 160 },
  { key: 'skuCount',   label: 'SKUs',       subLabel: 'Distinct SKUs', width: 80  },
  { key: 'units',      label: 'Units',      subLabel: 'Total qty',     width: 80  },
  { key: 'status',     label: 'Status',     subLabel: 'Active flag',   width: 90  },
  { key: 'actions',    label: '',                                       width: 110 },
]

const LOCATION_SORT_KEYS: Record<string, string> = {
  code: 'code', name: 'name', skuCount: 'skuCount', units: 'units',
}

const STORAGE_KEY = 'stock-shopify-locations'
const _EMPTY_SET = new Set<string>()
const _EMPTY_MAP = {}
const _NOOP = () => {}

// ── Component ─────────────────────────────────────────────────────────

export default function ShopifyLocationsClient() {
  const { t } = useTranslations()
  const { toast } = useToast()
  const [locations, setLocations] = useState<ShopifyLocationRow[] | null>(null)
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState<string | null>(null)
  const [discovering, setDiscovering] = useState(false)
  const [togglingId, setTogglingId]   = useState<string | null>(null)
  const [sortBy, setSortBy]       = useState('code-asc')
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
      const res = await fetch(`${getBackendUrl()}/api/stock/shopify-locations`, { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      setLocations(json.locations ?? [])
      setLastFetchedAt(Date.now())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { fetchData() }, [fetchData])

  const runDiscover = useCallback(async () => {
    setDiscovering(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/stock/shopify-locations/discover`, { method: 'POST' })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
      toast.success(t('stock.shopifyLocations.toast.discovered', {
        created: body.created ?? 0, updated: body.updated ?? 0, unchanged: body.unchanged ?? 0,
      }))
      await fetchData()
    } catch (err) {
      toast.error(t('stock.shopifyLocations.toast.discoverFailed', { error: err instanceof Error ? err.message : String(err) }))
    } finally { setDiscovering(false) }
  }, [fetchData, t, toast])

  const toggleActive = useCallback(async (loc: ShopifyLocationRow) => {
    setTogglingId(loc.id)
    try {
      const res = await fetch(`${getBackendUrl()}/api/stock/shopify-locations/${loc.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: !loc.isActive }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      await fetchData()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally { setTogglingId(null) }
  }, [fetchData, toast])

  const rows = useMemo((): LocationRow[] => {
    if (!locations) return []
    const base = locations.map(l => ({ ...l, isParent: false as const, childCount: 0, parentId: null }))
    const [key, dir] = sortBy.endsWith('-asc') ? [sortBy.slice(0, -4), 'asc'] : [sortBy, 'desc']
    return [...base].sort((a, b) => {
      let av: any, bv: any
      switch (key) {
        case 'code':     av = a.code;          bv = b.code;          break
        case 'name':     av = a.name;          bv = b.name;          break
        case 'skuCount': av = a.skuCount;      bv = b.skuCount;      break
        case 'units':    av = a.totalQuantity; bv = b.totalQuantity; break
        default: return 0
      }
      const cmp = typeof av === 'string' ? av.localeCompare(bv) : ((av ?? 0) - (bv ?? 0))
      return dir === 'asc' ? cmp : -cmp
    })
  }, [locations, sortBy])

  const cellPad = DENSITY_CELL_CLASS[density] ?? DENSITY_CELL_CLASS.comfortable

  const onSort = useCallback((key: string) => {
    setSortBy(prev => {
      const base = key.replace(/-asc$/, '')
      if (prev === base) return `${base}-asc`
      if (prev === `${base}-asc`) return base
      return base
    })
  }, [])

  const renderCell = useCallback((row: LocationRow, colKey: string) => {
    switch (colKey) {
      case 'code':
        return <span className="font-mono text-sm text-slate-700 dark:text-slate-300">{row.code}</span>
      case 'name':
        return <span className="text-sm text-slate-900 dark:text-slate-100">{row.name}</span>
      case 'shopifyId':
        return row.externalLocationId
          ? <span className="font-mono text-xs text-slate-500 dark:text-slate-400">{row.externalLocationId}</span>
          : <span className="text-slate-300 dark:text-slate-600">—</span>
      case 'skuCount':
        return <span className="tabular-nums text-sm text-slate-700 dark:text-slate-300">{row.skuCount}</span>
      case 'units':
        return <span className="tabular-nums font-semibold text-sm text-slate-900 dark:text-slate-100">{row.totalQuantity}</span>
      case 'status':
        return (
          <Badge variant={row.isActive ? 'success' : 'default'} size="sm">
            {row.isActive ? t('stock.shopifyLocations.active') : t('stock.shopifyLocations.inactive')}
          </Badge>
        )
      case 'actions':
        return (
          <button
            type="button"
            onClick={() => toggleActive(row)}
            disabled={togglingId === row.id}
            className="min-h-[44px] sm:min-h-0 px-2 py-1 text-sm font-medium text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50"
          >
            {row.isActive ? t('stock.shopifyLocations.disable') : t('stock.shopifyLocations.enable')}
          </button>
        )
      default:
        return null
    }
  }, [t, toggleActive, togglingId])

  const DENSITY_OPTIONS: { d: Density; icon: React.ReactNode; label: string }[] = [
    { d: 'compact',     icon: <AlignJustify size={13} />, label: 'Compact' },
    { d: 'comfortable', icon: <MenuIcon size={13} />,     label: 'Comfortable' },
    { d: 'spacious',    icon: <Equal size={13} />,        label: 'Spacious' },
  ]

  return (
    <div className="space-y-4">
      <PageHeader
        title={t('stock.shopifyLocations.title')}
        description={t('stock.shopifyLocations.description')}
        breadcrumbs={[
          { label: t('nav.fulfillment'), href: '/fulfillment' },
          { label: t('stock.title'), href: '/fulfillment/stock' },
          { label: t('stock.shopifyLocations.title') },
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
            <Button variant="primary" size="sm" onClick={runDiscover} disabled={discovering}>
              {discovering ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
              {t('stock.shopifyLocations.discover')}
            </Button>
          </div>
        }
      />
      <StockSubNav />

      {/* Density toolbar */}
      <div className="flex items-center gap-2">
        <span className="text-sm text-slate-500 dark:text-slate-400">{rows.length} location{rows.length === 1 ? '' : 's'}</span>
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

      {loading && !locations && (
        <div className="space-y-2">
          {[0, 1, 2].map(i => (
            <div key={i} className="h-16 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg animate-pulse" />
          ))}
        </div>
      )}

      {locations !== null && rows.length === 0 && !loading && (
        <EmptyState icon={Store} title={t('stock.shopifyLocations.empty.title')} description={t('stock.shopifyLocations.empty.description')}
          action={{ label: t('stock.shopifyLocations.discover'), onClick: runDiscover }} />
      )}

      {rows.length > 0 && (<>
        <VirtualizedGrid
          rows={rows}
          visible={LOCATION_COLUMNS}
          density={density}
          cellPad={cellPad}
          selected={_EMPTY_SET}
          toggleSelect={_NOOP as any}
          toggleSelectAll={_NOOP}
          allSelected={false}
          sortBy={sortBy}
          onSort={onSort}
          sortKeys={LOCATION_SORT_KEYS}
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
        <GridFooter count={rows.length} label="locations" />
      </>)}
    </div>
  )
}
