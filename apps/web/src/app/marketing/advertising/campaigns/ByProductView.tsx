'use client'

/**
 * PC.1/PC.2 — Product-centric advertising grid.
 *
 * One row per ADVERTISED product (photo + identity + windowed ad spend /
 * revenue / TACOS / true profit, from /advertising/by-product), expandable to
 * that product's campaigns across markets (reusing /advertising/product-ads).
 * Built on the same VirtualizedGrid the /products page uses, so expansion,
 * density, sticky columns and virtualization come for free. Headline metric is
 * TACOS (real); ACOS lives per-campaign in the expansion.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { VirtualizedGrid, KpiStrip, Thumbnail, type GridLensColumn, type GridLensRow, type KpiTileSpec } from '@/app/_shared/grid-lens'
import { type Density, DENSITY_CELL_CLASS } from '@/lib/products/theme'
import { StatusChip } from '@/app/_shared/ads-ui'
import { getBackendUrl } from '@/lib/backend-url'
import { Megaphone, ShoppingCart, Coins, Package } from 'lucide-react'

interface Row extends GridLensRow {
  name: string
  sku?: string
  asin?: string | null
  photoUrl?: string | null
  photoCount?: number
  adSpendCents: number
  revenueCents?: number
  profitCents?: number
  tacos?: number | null
  marginPct?: number | null
  campaignCount?: number
  marketCount?: number
  units?: number
  // child (campaign) only
  marketplace?: string
  status?: string
  acos?: number | null
  impressions?: number
  clicks?: number
}

const eur = (c: number | null | undefined) => (c == null ? '—' : new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(c / 100))
const num = (n: number | null | undefined) => (n == null ? '—' : new Intl.NumberFormat('en-US').format(Math.round(n)))
const pct = (v: number | null | undefined) => (v == null ? '—' : `${v.toFixed(1)}%`)
const tacosColor = (v: number | null | undefined) => (v == null ? '' : v <= 10 ? 'text-emerald-600 dark:text-emerald-400' : v <= 25 ? 'text-amber-600 dark:text-amber-400' : 'text-rose-600 dark:text-rose-400')

const DATE_PRESETS = [{ label: '7d', days: 7 }, { label: '14d', days: 14 }, { label: '30d', days: 30 }, { label: '60d', days: 60 }, { label: '90d', days: 90 }]

const COLUMNS: GridLensColumn[] = [
  { key: 'product', label: 'Product', width: 320, locked: true },
  { key: 'campaigns', label: 'Campaigns', width: 96 },
  { key: 'markets', label: 'Markets', width: 84 },
  { key: 'adspend', label: 'Ad spend', width: 110 },
  { key: 'revenue', label: 'Revenue', width: 120 },
  { key: 'tacos', label: 'TACOS', width: 90 },
  { key: 'profit', label: 'True profit', width: 120 },
  { key: 'margin', label: 'Margin', width: 90 },
]
const SORT_KEYS: Record<string, string> = { adspend: 'spend', revenue: 'revenue', tacos: 'tacos', profit: 'profit', margin: 'margin', campaigns: 'campaigns' }

export function ByProductView() {
  const [rows, setRows] = useState<Row[]>([])
  const [totals, setTotals] = useState<{ adSpendCents: number; revenueCents: number; profitCents: number; products: number }>({ adSpendCents: 0, revenueCents: 0, profitCents: 0, products: 0 })
  const [unattributed, setUnattributed] = useState(0)
  const [loading, setLoading] = useState(true)
  const [windowDays, setWindowDays] = useState(30)
  const [density] = useState<Density>('comfortable')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [sortBy, setSortBy] = useState('adspend')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [expandedParents, setExpandedParents] = useState<Set<string>>(new Set())
  const [childrenByParent, setChildrenByParent] = useState<Record<string, Row[]>>({})
  const [loadingChildren, setLoadingChildren] = useState<Set<string>>(new Set())

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const sortParam = SORT_KEYS[sortBy] ?? 'spend'
      const r = await fetch(`${getBackendUrl()}/api/advertising/by-product?windowDays=${windowDays}&sort=${sortParam}&dir=${sortDir}&limit=500`, { cache: 'no-store' }).then((x) => x.json()).catch(() => ({ rows: [] }))
      setRows((r.rows ?? []) as Row[])
      setTotals(r.totals ?? { adSpendCents: 0, revenueCents: 0, profitCents: 0, products: 0 })
      setUnattributed(r.unattributedSpendCents ?? 0)
    } finally { setLoading(false) }
  }, [windowDays, sortBy, sortDir])
  useEffect(() => { void load() }, [load])

  const fetchChildrenFor = useCallback(async (productId: string) => {
    if (childrenByParent[productId]) return
    setLoadingChildren((s) => new Set(s).add(productId))
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/product-ads?productId=${productId}&windowDays=${windowDays}`, { cache: 'no-store' }).then((x) => x.json()).catch(() => ({ campaigns: [] }))
      const kids: Row[] = (r.campaigns ?? []).map((c: Record<string, unknown>) => ({
        id: String(c.id), parentId: productId, isParent: false,
        name: String(c.name ?? ''), marketplace: String(c.marketplace ?? '—'), status: String(c.status ?? ''),
        adSpendCents: Number(c.spendCents ?? 0), revenueCents: Number(c.adSalesCents ?? 0),
        acos: c.acos == null ? null : Number(c.acos), impressions: Number(c.impressions ?? 0), clicks: Number(c.clicks ?? 0),
      }))
      // Highest-spend campaigns first.
      kids.sort((a, b) => b.adSpendCents - a.adSpendCents)
      setChildrenByParent((m) => ({ ...m, [productId]: kids }))
    } finally {
      setLoadingChildren((s) => { const n = new Set(s); n.delete(productId); return n })
    }
  }, [childrenByParent, windowDays])

  const onToggleExpand = useCallback((productId: string) => {
    setExpandedParents((prev) => {
      const next = new Set(prev)
      if (next.has(productId)) next.delete(productId)
      else { next.add(productId); void fetchChildrenFor(productId) }
      return next
    })
  }, [fetchChildrenFor])

  const onSort = useCallback((key: string) => {
    if (sortBy === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortBy(key); setSortDir('desc') }
  }, [sortBy])

  const toggleSelect = useCallback((id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n }), [])
  const toggleSelectAll = useCallback(() => setSelected((s) => (s.size === rows.length ? new Set() : new Set(rows.map((r) => r.id)))), [rows])

  const tiles: KpiTileSpec[] = [
    { icon: Megaphone, label: 'Ad spend', value: eur(totals.adSpendCents), tone: 'amber', detail: `${totals.products} advertised products` },
    { icon: ShoppingCart, label: 'Revenue', value: eur(totals.revenueCents), tone: 'violet', detail: `TACOS ${pct(totals.revenueCents > 0 ? (totals.adSpendCents / totals.revenueCents) * 100 : null)}` },
    { icon: Coins, label: 'True profit', value: eur(totals.profitCents), tone: 'emerald', detail: `Margin ${pct(totals.revenueCents > 0 ? (totals.profitCents / totals.revenueCents) * 100 : null)}` },
    { icon: Package, label: 'Unattributed spend', value: eur(unattributed), tone: unattributed > totals.adSpendCents * 0.15 ? 'rose' : 'slate', detail: 'account − product-attributed' },
  ]

  const renderCell = useCallback((row: Row, colKey: string, isChild: boolean) => {
    if (isChild) {
      switch (colKey) {
        case 'product': return <span className="pl-6 text-sm text-slate-700 dark:text-slate-200 truncate">{row.name}</span>
        case 'campaigns': return <StatusChip status={row.status ?? ''} />
        case 'markets': return <span className="text-xs text-slate-500">{row.marketplace}</span>
        case 'adspend': return <span className="tabular-nums">{eur(row.adSpendCents)}</span>
        case 'revenue': return <span className="tabular-nums">{eur(row.revenueCents)}</span>
        case 'tacos': return <span className="tabular-nums text-slate-400" title="ACOS (campaign)">{pct(row.acos)}<span className="text-[9px] ml-0.5">ACOS</span></span>
        case 'profit': return <span className="text-xs text-slate-400">{num(row.impressions)} impr</span>
        case 'margin': return <span className="text-xs text-slate-400">{num(row.clicks)} clk</span>
        default: return null
      }
    }
    switch (colKey) {
      case 'product': return (
        <div className="flex items-center gap-2 min-w-0">
          <Thumbnail src={row.photoUrl ?? null} photoCount={row.photoCount} alt={row.name} />
          <div className="min-w-0">
            <a href={`/products/${row.id}/edit?tab=ads`} target="_blank" rel="noopener noreferrer" className="block truncate text-sm font-medium text-slate-800 dark:text-slate-100 hover:underline">{row.name}</a>
            <div className="text-[11px] text-slate-400 truncate">{row.sku}{row.asin ? ` · ${row.asin}` : ''}</div>
          </div>
        </div>
      )
      case 'campaigns': return <span className="tabular-nums">{num(row.campaignCount)}</span>
      case 'markets': return <span className="tabular-nums">{num(row.marketCount)}</span>
      case 'adspend': return <span className="tabular-nums font-medium">{eur(row.adSpendCents)}</span>
      case 'revenue': return <span className="tabular-nums">{eur(row.revenueCents)}</span>
      case 'tacos': return <span className={`tabular-nums font-medium ${tacosColor(row.tacos)}`}>{pct(row.tacos)}</span>
      case 'profit': return <span className={`tabular-nums ${(row.profitCents ?? 0) >= 0 ? '' : 'text-rose-600'}`}>{eur(row.profitCents)}</span>
      case 'margin': return <span className="tabular-nums">{pct(row.marginPct)}</span>
      default: return null
    }
  }, [])

  const cellPad = DENSITY_CELL_CLASS[density] ?? DENSITY_CELL_CLASS.comfortable
  const emptySet = useMemo(() => new Set<string>(), [])

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div className="flex gap-1">
          {DATE_PRESETS.map((p) => (
            <button key={p.days} onClick={() => setWindowDays(p.days)} className={`px-2.5 py-1 text-xs rounded-md border ${windowDays === p.days ? 'bg-blue-600 text-white border-blue-600' : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'}`}>{p.label}</button>
          ))}
        </div>
        {loading && <span className="text-xs text-slate-400">updating…</span>}
      </div>
      <KpiStrip tiles={tiles} className="mb-4" />
      {rows.length === 0 && !loading ? (
        <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-10 text-center text-sm text-slate-400">
          No advertised products with spend in the last {windowDays} days.
        </div>
      ) : (
        <VirtualizedGrid<Row>
          rows={rows}
          visible={COLUMNS}
          density={density}
          cellPad={cellPad}
          selected={selected}
          toggleSelect={toggleSelect}
          toggleSelectAll={toggleSelectAll}
          allSelected={rows.length > 0 && selected.size === rows.length}
          sortBy={sortBy}
          onSort={onSort}
          sortKeys={SORT_KEYS}
          expandedParents={expandedParents}
          childrenByParent={childrenByParent}
          loadingChildren={loadingChildren}
          onToggleExpand={onToggleExpand}
          focusedRowId={null}
          searchTerm=""
          riskFlaggedSkus={emptySet}
          storageKey="ax.byproduct"
          renderCell={renderCell}
        />
      )}
    </div>
  )
}
