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
import { VirtualizedGrid, KpiStrip, Thumbnail, PreferencesModal, DensityToggle, BulkActionShell, type GridLensColumn, type GridLensRow, type KpiTileSpec, type PreferencesValue } from '@/app/_shared/grid-lens'
import { type Density, DENSITY_CELL_CLASS } from '@/lib/products/theme'
import { StatusChip } from '@/app/_shared/ads-ui'
import { getBackendUrl } from '@/lib/backend-url'
import { useMarketingEvents } from '@/lib/sync/use-marketing-events'
import { Megaphone, ShoppingCart, Coins, Package, Search, SlidersHorizontal, Pause, Play, ChevronsUp, ChevronsDown } from 'lucide-react'

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
  opportunity?: boolean
  unmatched?: boolean
}
type Mode = 'advertised' | 'opportunity' | 'unmatched'

const eur = (c: number | null | undefined) => (c == null ? '—' : new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(c / 100))
const num = (n: number | null | undefined) => (n == null ? '—' : new Intl.NumberFormat('en-US').format(Math.round(n)))
const pct = (v: number | null | undefined) => (v == null ? '—' : `${v.toFixed(1)}%`)
const tacosColor = (v: number | null | undefined) => (v == null ? '' : v <= 10 ? 'text-emerald-600 dark:text-emerald-400' : v <= 25 ? 'text-amber-600 dark:text-amber-400' : 'text-rose-600 dark:text-rose-400')

// PC.7b — derived per-product recommendation (data-efficient, no extra call).
function rowRec(row: { profitCents?: number; tacos?: number | null; revenueCents?: number; opportunity?: boolean }): { label: string; cls: string } | null {
  if (row.opportunity) return { label: 'Launch ads', cls: 'bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300' }
  if ((row.profitCents ?? 0) < 0) return { label: 'Unprofitable', cls: 'bg-rose-100 text-rose-700 dark:bg-rose-950/50 dark:text-rose-300' }
  if (row.tacos != null && row.tacos > 25) return { label: 'High TACOS', cls: 'bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300' }
  if (row.tacos != null && row.tacos < 8 && (row.revenueCents ?? 0) > 0) return { label: 'Scale', cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300' }
  return null
}

const DATE_PRESETS = [{ label: '7d', days: 7 }, { label: '14d', days: 14 }, { label: '30d', days: 30 }, { label: '60d', days: 60 }, { label: '90d', days: 90 }]

const ALL_COLUMNS: GridLensColumn[] = [
  { key: 'product', label: 'Product', width: 320, locked: true },
  { key: 'campaigns', label: 'Campaigns', width: 96 },
  { key: 'markets', label: 'Markets', width: 84 },
  { key: 'adspend', label: 'Ad spend', width: 110 },
  { key: 'revenue', label: 'Revenue', width: 120 },
  { key: 'tacos', label: 'TACOS', width: 90 },
  { key: 'acos', label: 'ACOS', width: 90 },
  { key: 'profit', label: 'True profit', width: 120 },
  { key: 'margin', label: 'Margin', width: 90 },
  { key: 'units', label: 'Units', width: 80 },
]
const DEFAULT_VISIBLE = ALL_COLUMNS.map((c) => c.key)
const PREFS_KEY = 'ax.byproduct.prefs.v1'
const SORT_KEYS: Record<string, string> = { adspend: 'spend', revenue: 'revenue', tacos: 'tacos', profit: 'profit', margin: 'margin', campaigns: 'campaigns' }
const CHANNELS = [{ key: 'AMAZON', label: 'Amazon', enabled: true }, { key: 'EBAY', label: 'eBay', enabled: false }, { key: 'SHOPIFY', label: 'Shopify', enabled: false }]

export function ByProductView() {
  const [rows, setRows] = useState<Row[]>([])
  const [totals, setTotals] = useState<{ adSpendCents: number; revenueCents: number; profitCents: number; products: number }>({ adSpendCents: 0, revenueCents: 0, profitCents: 0, products: 0 })
  const [prevTotals, setPrevTotals] = useState<{ adSpendCents: number; revenueCents: number; profitCents: number } | null>(null)
  const [unattributed, setUnattributed] = useState(0)
  const [liveTs, setLiveTs] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [windowDays, setWindowDays] = useState(30)
  const [density, setDensity] = useState<Density>('comfortable')
  const [search, setSearch] = useState('')
  const [mode, setMode] = useState<Mode>('advertised')
  const [marketplace, setMarketplace] = useState('')
  const [marketplaces, setMarketplaces] = useState<string[]>([])
  const [prefsOpen, setPrefsOpen] = useState(false)
  const [prefs, setPrefs] = useState<PreferencesValue>(() => {
    try { const s = localStorage.getItem(PREFS_KEY); if (s) return JSON.parse(s) } catch { /* default */ }
    return { pageSize: 100, visibleColumns: DEFAULT_VISIBLE.slice(), stickyFirstColumn: true, stickyLastColumn: false, sortBy: 'spend', sortDir: 'desc' }
  })
  useEffect(() => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)) } catch { /* ignore */ } }, [prefs])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkStatus, setBulkStatus] = useState<string | null>(null)
  const [sortBy, setSortBy] = useState('adspend')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [expandedParents, setExpandedParents] = useState<Set<string>>(new Set())
  const [childrenByParent, setChildrenByParent] = useState<Record<string, Row[]>>({})
  const [loadingChildren, setLoadingChildren] = useState<Set<string>>(new Set())

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const sortParam = SORT_KEYS[sortBy] ?? 'spend'
      const qs = new URLSearchParams({ windowDays: String(windowDays), sort: sortParam, dir: sortDir, limit: '500', compare: 'true', mode })
      if (search.trim()) qs.set('search', search.trim())
      if (marketplace) qs.set('marketplace', marketplace)
      const r = await fetch(`${getBackendUrl()}/api/advertising/by-product?${qs}`, { cache: 'no-store' }).then((x) => x.json()).catch(() => ({ rows: [] }))
      setRows((r.rows ?? []) as Row[])
      setTotals(r.totals ?? { adSpendCents: 0, revenueCents: 0, profitCents: 0, products: 0 })
      setPrevTotals(r.previousTotals ?? null)
      setUnattributed(r.unattributedSpendCents ?? 0)
      if (Array.isArray(r.marketplaces)) setMarketplaces(r.marketplaces)
    } finally { setLoading(false) }
  }, [windowDays, sortBy, sortDir, search, marketplace, mode])
  useEffect(() => { const t = setTimeout(() => void load(), search ? 300 : 0); return () => clearTimeout(t) }, [load, search])

  // PC.5 — live refresh on marketing events.
  useMarketingEvents(useCallback(() => { void load(); setLiveTs(Date.now()); setTimeout(() => setLiveTs(null), 4000) }, [load]))

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
      // PC.4 — cluster by marketplace, then spend within each market, so a
      // product's campaigns group visually by market in the expansion.
      kids.sort((a, b) => (a.marketplace ?? '').localeCompare(b.marketplace ?? '') || b.adSpendCents - a.adSpendCents)
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

  // PC.7 — bulk action fans out to the campaigns behind selected products.
  const bulkAction = useCallback(async (action: 'pause' | 'enable' | 'budgetPct', value?: number) => {
    const ids = [...selected]; if (!ids.length) return
    setBulkBusy(true); setBulkStatus(null)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/by-product/bulk`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ productIds: ids, action, value }) }).then((x) => x.json())
      if (r?.error) throw new Error(r.error)
      setBulkStatus(`✓ ${r.succeeded}/${r.campaignsAffected} campaigns updated${r.failed ? ` · ${r.failed} failed` : ''}`)
      setSelected(new Set())
      void load()
    } catch (e) { setBulkStatus((e as Error).message) } finally { setBulkBusy(false) }
  }, [selected, load])

  const dPct = (cur: number, prev: number | undefined | null) => (prev != null && prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : null)
  const tiles: KpiTileSpec[] = [
    { icon: Megaphone, label: 'Ad spend', value: eur(totals.adSpendCents), tone: 'amber', detail: `${totals.products} advertised products`, ...(prevTotals ? { delta: { pct: dPct(totals.adSpendCents, prevTotals.adSpendCents), good: (dPct(totals.adSpendCents, prevTotals.adSpendCents) ?? 0) <= 0 } } : {}) },
    { icon: ShoppingCart, label: 'Revenue', value: eur(totals.revenueCents), tone: 'violet', detail: `TACOS ${pct(totals.revenueCents > 0 ? (totals.adSpendCents / totals.revenueCents) * 100 : null)}`, ...(prevTotals ? { delta: { pct: dPct(totals.revenueCents, prevTotals.revenueCents), good: (dPct(totals.revenueCents, prevTotals.revenueCents) ?? 0) >= 0 } } : {}) },
    { icon: Coins, label: 'True profit', value: eur(totals.profitCents), tone: 'emerald', detail: `Margin ${pct(totals.revenueCents > 0 ? (totals.profitCents / totals.revenueCents) * 100 : null)}`, ...(prevTotals ? { delta: { pct: dPct(totals.profitCents, prevTotals.profitCents), good: (dPct(totals.profitCents, prevTotals.profitCents) ?? 0) >= 0 } } : {}) },
    { icon: Package, label: 'Unattributed spend', value: eur(unattributed), tone: unattributed > totals.adSpendCents * 0.15 ? 'rose' : 'slate', detail: 'account − product-attributed' },
  ]

  const renderCell = useCallback((row: Row, colKey: string, isChild: boolean) => {
    if (isChild) {
      switch (colKey) {
        case 'product': return (
          <span className="pl-6 inline-flex flex-col min-w-0">
            <a href={`/marketing/advertising/campaigns/${row.id}`} className="text-sm text-slate-700 dark:text-slate-200 truncate hover:underline" title={row.name}>{row.name}</a>
            <span className="text-[10px] text-slate-400">{num(row.impressions)} impr · {num(row.clicks)} clk</span>
          </span>
        )
        case 'campaigns': return <StatusChip status={row.status ?? ''} />
        case 'markets': return <span className="text-xs text-slate-500">{row.marketplace}</span>
        case 'adspend': return <span className="tabular-nums">{eur(row.adSpendCents)}</span>
        case 'revenue': return <span className="tabular-nums">{eur(row.revenueCents)}</span>
        case 'tacos': return <span className="tabular-nums text-slate-500" title="Campaign ACOS">{pct(row.acos)} <span className="text-[9px] text-slate-400">ACOS</span></span>
        case 'profit': return <span className="text-[11px] text-slate-300 dark:text-slate-600">—</span>
        case 'margin': return null
        default: return null
      }
    }
    switch (colKey) {
      case 'product': return (
        <div className="flex items-center gap-2 min-w-0">
          <Thumbnail src={row.photoUrl ?? null} photoCount={row.photoCount} alt={row.name} />
          <div className="min-w-0">
            <a href={`/products/${row.id}/edit?tab=ads`} target="_blank" rel="noopener noreferrer" className="block truncate text-sm font-medium text-slate-800 dark:text-slate-100 hover:underline">{row.name}</a>
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="text-[11px] text-slate-400 truncate">{row.sku}{row.asin ? ` · ${row.asin}` : ''}</span>
              {(() => { const rec = rowRec(row); return rec ? <span className={`px-1 py-px text-[9px] font-medium rounded ${rec.cls} flex-shrink-0`}>{rec.label}</span> : null })()}
            </div>
          </div>
        </div>
      )
      case 'campaigns': return row.opportunity
        ? <a href={`/products/${row.id}/edit?tab=ads`} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-600 hover:underline">+ Create campaign</a>
        : row.unmatched
        ? <span className="text-[11px] text-amber-600 dark:text-amber-400">unmatched</span>
        : <span className="tabular-nums">{num(row.campaignCount)}</span>
      case 'markets': return <span className="tabular-nums">{num(row.marketCount)}</span>
      case 'adspend': return <span className="tabular-nums font-medium">{eur(row.adSpendCents)}</span>
      case 'revenue': return <span className="tabular-nums">{eur(row.revenueCents)}</span>
      case 'tacos': return <span className={`tabular-nums font-medium ${tacosColor(row.tacos)}`}>{pct(row.tacos)}</span>
      case 'acos': return <span className={`tabular-nums ${tacosColor(row.acos)}`}>{pct(row.acos)}</span>
      case 'profit': return <span className={`tabular-nums ${(row.profitCents ?? 0) >= 0 ? '' : 'text-rose-600'}`}>{eur(row.profitCents)}</span>
      case 'margin': return <span className="tabular-nums">{pct(row.marginPct)}</span>
      case 'units': return <span className="tabular-nums">{num(row.units)}</span>
      default: return null
    }
  }, [])

  // Derive visible columns from prefs (locked 'product' always first).
  const visible = useMemo(() => {
    const byKey = new Map(ALL_COLUMNS.map((c) => [c.key, c]))
    const ordered = prefs.visibleColumns.map((k) => byKey.get(k)).filter(Boolean) as GridLensColumn[]
    if (!ordered.some((c) => c.key === 'product')) ordered.unshift(byKey.get('product')!)
    return ordered
  }, [prefs.visibleColumns])

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
        <span className="inline-flex items-center gap-1.5 text-xs">
          {loading && <span className="text-slate-400">updating…</span>}
          <span className={`inline-flex h-2 w-2 rounded-full ${liveTs ? 'bg-emerald-500 animate-pulse' : 'bg-emerald-500/70'}`} />
          <span className="text-emerald-600 dark:text-emerald-400 font-medium">{liveTs ? 'Updated just now' : 'Live'}</span>
        </span>
      </div>
      <KpiStrip tiles={tiles} className="mb-4" />

      {/* Mode chips: advertised · opportunity · unmatched */}
      <div className="inline-flex items-center rounded-lg border border-slate-200 dark:border-slate-700 p-0.5 mb-3 bg-slate-50 dark:bg-slate-900">
        {([['advertised', 'Advertised'], ['opportunity', 'Not advertised (opportunity)'], ['unmatched', 'Unmatched ASINs']] as const).map(([m, label]) => (
          <button key={m} onClick={() => { setMode(m); setSelected(new Set()) }}
            className={`px-3 py-1 text-xs rounded-md transition ${mode === m ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-sm font-medium' : 'text-slate-500 hover:text-slate-700'}`}>{label}</button>
        ))}
      </div>

      {/* Toolbar: search · market · channel · density · customize */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="relative">
          <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search products" placeholder="Search product / SKU / ASIN" className="pl-7 pr-2 py-1.5 text-sm rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 w-60" />
        </div>
        <select value={marketplace} onChange={(e) => setMarketplace(e.target.value)} aria-label="Filter by marketplace" className="px-2 py-1.5 text-sm rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950">
          <option value="">All markets</option>
          {marketplaces.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <div className="inline-flex items-center rounded-md border border-slate-200 dark:border-slate-700 p-0.5">
          {CHANNELS.map((c) => (
            <span key={c.key} title={c.enabled ? c.label : `${c.label} — no keyword PPC yet`}
              className={`px-2 py-1 text-xs rounded ${c.enabled ? 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 font-medium' : 'text-slate-300 dark:text-slate-600 cursor-not-allowed'}`}>{c.label}</span>
          ))}
        </div>
        <div className="ml-auto inline-flex items-center gap-2">
          <DensityToggle density={density} onChange={setDensity} />
          <button onClick={() => setPrefsOpen(true)} aria-label="Customize columns" className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-sm rounded-md border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"><SlidersHorizontal size={14} /> Customize</button>
        </div>
      </div>
      <PreferencesModal
        open={prefsOpen}
        onClose={() => setPrefsOpen(false)}
        value={prefs}
        onConfirm={(next) => { setPrefs(next); setPrefsOpen(false) }}
        allColumns={ALL_COLUMNS}
        defaultVisible={DEFAULT_VISIBLE}
        sortFieldOptions={[]}
        title="Customize product grid"
      />
      {selected.size > 0 && (
        <div className="mb-2"><BulkActionShell selectedCount={selected.size} noun="product" onClear={() => setSelected(new Set())} busy={bulkBusy} status={bulkStatus} actions={[
          { id: 'enable', label: 'Enable campaigns', icon: Play, onClick: () => bulkAction('enable') },
          { id: 'pause', label: 'Pause campaigns', icon: Pause, onClick: () => bulkAction('pause') },
          { id: 'budgetup', label: 'Budget +10%', icon: ChevronsUp, tone: 'primary', onClick: () => bulkAction('budgetPct', 10) },
          { id: 'budgetdown', label: 'Budget −10%', icon: ChevronsDown, onClick: () => bulkAction('budgetPct', -10) },
        ]} /></div>
      )}
      {rows.length === 0 && !loading ? (
        <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-10 text-center text-sm text-slate-400">
          {mode === 'opportunity' ? `No un-advertised products with sales in the last ${windowDays} days.`
            : mode === 'unmatched' ? 'No unmatched advertised ASINs (every ad maps to a product).'
            : `No advertised products with spend in the last ${windowDays} days.`}
        </div>
      ) : (
        <VirtualizedGrid<Row>
          rows={rows}
          visible={visible}
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
          stickyLeft={prefs.stickyFirstColumn}
          stickyRight={prefs.stickyLastColumn}
        />
      )}
    </div>
  )
}
