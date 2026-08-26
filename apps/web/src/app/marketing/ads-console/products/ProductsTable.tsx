'use client'

/**
 * Amazon-Ads-faithful "Advertised products" screen. Reuses the Campaigns
 * substrate (chrome, Performance panel, Balham table, pagination, expandable
 * rows) but rows are advertised PRODUCTS (photo + ASIN/SKU) with per-product
 * spend/sales/ACOS/ROAS/units/TACOS + the Nexus-only True profit / Net margin
 * columns. Expand a product → the campaigns advertising it (same columns).
 * Mode tabs: Advertised · Opportunities (selling, not advertised) · Unmatched.
 * Data: GET /advertising/by-product (+ /by-product/campaigns for expansion).
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Search, ChevronDown, ChevronRight, RefreshCw, Download, Image as ImageIcon, ChevronLeft, ChevronsLeft, ChevronsRight } from 'lucide-react'
import { Button, Input, ToolbarButton } from '@/design-system/primitives'
import { DataGrid, type Column } from '@/design-system/components'
import { getBackendUrl } from '@/lib/backend-url'
import { useMarketingEvents } from '@/lib/sync/use-marketing-events'
import { PerformancePanel } from '../campaigns/PerformancePanel'

interface Prod {
  id: string; sku?: string | null; name: string; asin?: string | null; photoUrl?: string | null; photoCount?: number
  adSpendCents: number; revenueCents: number; profitCents: number; units: number; tacos: number | null; marginPct: number | null
  campaignCount: number; marketCount: number; isParent?: boolean; childCount?: number; unmatched?: boolean
}
interface Camp { id: string; name: string; marketplace: string | null; status: string; adProduct: string | null; dailyBudgetCents: number; adSpendCents: number; adSalesCents: number; acos: number | null; impressions: number; clicks: number; orders: number }

const MODES = [{ k: 'advertised', label: 'Advertised products' }, { k: 'opportunity', label: 'Opportunities' }, { k: 'unmatched', label: 'Unmatched ASINs' }]
const RANGES = [{ d: 1, label: 'Today' }, { d: 7, label: 'Last 7 days' }, { d: 14, label: 'Last 14 days' }, { d: 30, label: 'Last 30 days' }, { d: 60, label: 'Last 60 days' }, { d: 90, label: 'Last 90 days' }]

/** A product row, or one of its campaign rows. They live in ONE array so the campaign metrics
 *  stay under the same column headers as the product's — comparing a campaign's spend to its
 *  product's, down the column, is the whole point of expanding. `DataGrid.renderExpanded`
 *  cannot do that: it renders a single full-width `<td colSpan>`, which is a different feature. */
type GridRow =
  | { kind: 'product'; p: Prod }
  | { kind: 'child'; parentId: string; c: Camp }
  | { kind: 'note'; parentId: string; text: string }

/** Sorting is the component's, so the spec only describes cells. `sortable` is still on every
 *  column — the grid reports the click and the component re-sorts `filtered`, which keeps the
 *  parent/child grouping intact. */
const productColumns = (ctx: {
  COLS: ReadonlyArray<{ key: string; label: string }>
  cell: (key: string, p: Prod) => ReactNode
  childCell: (key: string, c: Camp) => ReactNode
  expanded: Set<string>
  toggleExpand: (id: string) => void
}): Array<Column<GridRow>> => [
  { key: 'product', label: 'Product', sticky: true, width: 320, sortable: true, render: (r) => {
    if (r.kind === 'note') return <span className="childmsg">{r.text}</span>
    if (r.kind === 'child') return (
      <span className="childname"><span className="gname">{r.c.name}</span>
        {r.c.status === 'ENABLED' ? <span className="az-badge deliver">Delivering</span> : <span className="az-badge paused">{titlecase(r.c.status || 'Paused')}</span>}
      </span>
    )
    const p = r.p
    const isOpen = ctx.expanded.has(p.id)
    const canExpand = (p.campaignCount ?? 0) > 0 && !p.unmatched
    return (
      <span className="az-prod">
        {canExpand
          ? <button type="button" className={`az-expand ${isOpen ? 'open' : ''}`} onClick={() => ctx.toggleExpand(p.id)} aria-label={isOpen ? 'Collapse campaigns' : 'Expand campaigns'} aria-expanded={isOpen}><ChevronRight size={15} /></button>
          : <span style={{ width: 19, display: 'inline-block' }} />}
        {p.photoUrl ? <img className="ph" src={p.photoUrl} alt="" /> : <span className="ph ph0"><ImageIcon size={16} /></span>}
        <span className="meta">
          {p.unmatched ? <span className="nm" style={{ color: 'var(--ink)' }}>{p.name}</span> : <a className="nm" href={`/products/${p.id}`} target="_blank" rel="noopener noreferrer">{p.name}</a>}
          <span className="ids">{p.asin ? `ASIN ${p.asin}` : ''}{p.asin && p.sku ? ' · ' : ''}{p.sku ? `SKU ${p.sku}` : ''}{p.isParent && p.childCount ? ` · ${p.childCount} variants` : ''}</span>
        </span>
      </span>
    )
  } },
  ...ctx.COLS.map((c): Column<GridRow> => ({
    key: c.key, label: c.label, align: 'right', sortable: true,
    render: (r) => (r.kind === 'product' ? ctx.cell(c.key, r.p) : r.kind === 'child' ? ctx.childCell(c.key, r.c) : null),
  })),
]

const COLS = [
  { key: 'spend', label: 'Spend' }, { key: 'sales', label: 'Sales' }, { key: 'acos', label: 'ACOS' }, { key: 'roas', label: 'ROAS' },
  { key: 'units', label: 'Units' }, { key: 'tacos', label: 'TACOS' }, { key: 'trueProfit', label: 'True profit' }, { key: 'margin', label: 'Net margin' },
  { key: 'campaigns', label: 'Campaigns' }, { key: 'markets', label: 'Markets' },
]
const eur = (c: number | null | undefined) => (c == null ? '—' : new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(c / 100))
const num = (n: number | null | undefined) => (n == null ? '—' : new Intl.NumberFormat('en-US').format(Math.round(n)))
const pct = (v: number | null | undefined, dp = 1) => (v == null ? '—' : `${(v * 100).toFixed(dp)}%`)
const x2 = (v: number | null | undefined) => (v == null ? '—' : v.toFixed(2))
const titlecase = (s: string) => s.charAt(0) + s.slice(1).toLowerCase()

export function ProductsTable({ initial }: { initial: Prod[] }) {
  const [raw, setRaw] = useState<Prod[]>(initial)
  const [mode, setMode] = useState('advertised')
  const [search, setSearch] = useState('')
  const [sortKey, setSortKey] = useState('spend')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [days, setDays] = useState(30)
  const [showRange, setShowRange] = useState(false)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [camps, setCamps] = useState<Record<string, Camp[] | 'loading' | 'error'>>({})
  const [loading, setLoading] = useState(false)
  const rangeLabel = RANGES.find((r) => r.d === days)?.label ?? `Last ${days} days`

  const refetch = useCallback(async () => {
    setLoading(true)
    try {
      const d = await fetch(`${getBackendUrl()}/api/advertising/by-product?windowDays=${days}&mode=${mode}&limit=300`, { cache: 'no-store' }).then((r) => r.json()).catch(() => ({ rows: [] }))
      setRaw((d.rows ?? []) as Prod[])
    } finally { setLoading(false) }
  }, [days, mode])
  useEffect(() => { void refetch() }, [refetch])
  useMarketingEvents(useCallback(() => { void refetch() }, [refetch]))

  const fetchCamps = useCallback(async (id: string) => {
    const k = `${id}:${days}`
    setCamps((c) => ({ ...c, [k]: 'loading' }))
    try {
      const d = await fetch(`${getBackendUrl()}/api/advertising/by-product/campaigns?productId=${encodeURIComponent(id)}&windowDays=${days}`, { cache: 'no-store' }).then((r) => r.json())
      setCamps((c) => ({ ...c, [k]: (d.rows ?? []) as Camp[] }))
    } catch { setCamps((c) => ({ ...c, [k]: 'error' })) }
  }, [days])
  useEffect(() => { for (const id of expanded) { if (!camps[`${id}:${days}`]) void fetchCamps(id) } }, [expanded, days, camps, fetchCamps])
  const toggleExpand = (id: string) => setExpanded((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })

  const mval = useCallback((p: Prod, key: string): number | null => {
    switch (key) {
      case 'spend': return p.adSpendCents
      case 'sales': return p.revenueCents
      case 'acos': return p.revenueCents > 0 ? p.adSpendCents / p.revenueCents : null
      case 'roas': return p.adSpendCents > 0 ? p.revenueCents / p.adSpendCents : null
      case 'units': return p.units
      case 'tacos': return p.tacos
      case 'trueProfit': return p.profitCents
      case 'margin': return p.revenueCents > 0 ? p.profitCents / p.revenueCents : null
      case 'campaigns': return p.campaignCount
      case 'markets': return p.marketCount
      default: return null
    }
  }, [])

  const filtered = useMemo(() => {
    let r = raw
    if (search.trim()) { const q = search.toLowerCase(); r = r.filter((p) => p.name.toLowerCase().includes(q) || (p.asin ?? '').toLowerCase().includes(q) || (p.sku ?? '').toLowerCase().includes(q)) }
    const dir = sortDir === 'asc' ? 1 : -1
    return [...r].sort((a, b) => {
      if (sortKey === 'product') return a.name.localeCompare(b.name) * dir
      return ((mval(a, sortKey) ?? -1) - (mval(b, sortKey) ?? -1)) * dir
    })
  }, [raw, search, sortKey, sortDir, mval])

  useEffect(() => { setPage(1) }, [mode, search, pageSize, sortKey, sortDir])
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const curPage = Math.min(page, totalPages)
  const paged = useMemo(() => filtered.slice((curPage - 1) * pageSize, curPage * pageSize), [filtered, curPage, pageSize])
  const firstRow = filtered.length === 0 ? 0 : (curPage - 1) * pageSize + 1
  const lastRow = Math.min(curPage * pageSize, filtered.length)

  const toggleSort = (k: string) => { if (sortKey === k) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc')); else { setSortKey(k); setSortDir('desc') } }

  const cell = (key: string, p: Prod): ReactNode => {
    switch (key) {
      case 'spend': return eur(p.adSpendCents)
      case 'sales': return eur(p.revenueCents)
      case 'acos': return pct(mval(p, 'acos'))
      case 'roas': return x2(mval(p, 'roas'))
      case 'units': return num(p.units)
      case 'tacos': return p.tacos == null ? '—' : `${p.tacos.toFixed(1)}%`
      case 'trueProfit': return <span style={{ color: p.profitCents < 0 ? '#cc1100' : p.profitCents > 0 ? 'var(--green)' : undefined, fontWeight: 500 }}>{eur(p.profitCents)}</span>
      case 'margin': return <span style={{ color: (mval(p, 'margin') ?? 0) < 0 ? '#cc1100' : undefined }}>{pct(mval(p, 'margin'))}</span>
      case 'campaigns': return num(p.campaignCount)
      case 'markets': return num(p.marketCount)
      default: return '—'
    }
  }
  const childCell = (key: string, c: Camp): ReactNode => {
    switch (key) {
      case 'spend': return eur(c.adSpendCents)
      case 'sales': return eur(c.adSalesCents)
      case 'acos': return c.acos == null ? '—' : `${c.acos.toFixed(1)}%`
      case 'roas': return x2(c.adSpendCents > 0 ? c.adSalesCents / c.adSpendCents : null)
      default: return ''
    }
  }

  const exportCsv = () => {
    const head = ['Product', 'ASIN', 'SKU', ...COLS.map((c) => c.label)]
    const lines = [head.join(',')]
    for (const p of filtered) {
      const vals = [p.name, p.asin ?? '', p.sku ?? '', (p.adSpendCents / 100).toFixed(2), (p.revenueCents / 100).toFixed(2),
        mval(p, 'acos') != null ? (mval(p, 'acos')! * 100).toFixed(1) : '', mval(p, 'roas') != null ? mval(p, 'roas')!.toFixed(2) : '',
        String(p.units), p.tacos != null ? p.tacos.toFixed(1) : '', (p.profitCents / 100).toFixed(2),
        mval(p, 'margin') != null ? (mval(p, 'margin')! * 100).toFixed(1) : '', String(p.campaignCount), String(p.marketCount)]
      lines.push(vals.map((x) => `"${String(x).replace(/"/g, '""')}"`).join(','))
    }
    const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' })); const a = document.createElement('a'); a.href = url; a.download = 'advertised-products.csv'; a.click(); URL.revokeObjectURL(url)
  }

  /** Parent rows with their expanded campaigns interleaved, in display order. Flattening here
   *  rather than nesting is what keeps a campaign's metrics under the same column headers as its
   *  product's. The four states the old `<tbody>` spelled out inline — loading, error, empty,
   *  rows — become `note` rows, which occupy the product column and leave the metrics blank,
   *  exactly as the `colSpan` version did. */
  const gridRows = useMemo<GridRow[]>(() => {
    const out: GridRow[] = []
    for (const p of paged) {
      out.push({ kind: 'product', p })
      if (!expanded.has(p.id)) continue
      const data = camps[`${p.id}:${days}`]
      if (data === undefined || data === 'loading') out.push({ kind: 'note', parentId: p.id, text: 'Loading campaigns…' })
      else if (data === 'error') out.push({ kind: 'note', parentId: p.id, text: 'Couldn’t load campaigns.' })
      else if (data.length === 0) out.push({ kind: 'note', parentId: p.id, text: 'No campaigns advertise this product in range.' })
      else for (const c of data) out.push({ kind: 'child', parentId: p.id, c })
    }
    return out
  }, [paged, expanded, camps, days])


  return (
    <div className="az-wrap">
      <div className="az-tabs">
        {MODES.map((t) => <button key={t.k} className={`az-tab ${mode === t.k ? 'on' : ''}`} onClick={() => setMode(t.k)}>{mode === t.k && <span className="ck">✔</span>}{t.label}</button>)}
      </div>

      <div className="az-listhead">
        <span className="title">Advertised products <ChevronDown size={18} /></span>
        <Input leadingIcon={<Search size={15} />} placeholder="Find a product, ASIN or SKU" aria-label="Find a product, ASIN or SKU" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 294 }} />
        <span style={{ flex: 1 }} />
      </div>

      <PerformancePanel adProduct="" days={days} />

      <div className="az-tbar2">
        <span className="az-menuwrap">
          <Button variant="quiet" size="sm" aria-haspopup="menu" aria-expanded={showRange} onClick={() => setShowRange((v) => !v)}>{rangeLabel} <ChevronDown size={14} /></Button>
          {showRange && <>
            <div style={{ position: 'fixed', inset: 0, zIndex: 29 }} onClick={() => setShowRange(false)} />
            <div className="az-menu">{RANGES.map((r) => <button key={r.d} className={days === r.d ? 'on' : ''} onClick={() => { setDays(r.d); setShowRange(false) }}>{r.label}{days === r.d && <span>✔</span>}</button>)}</div>
          </>}
        </span>
        <ToolbarButton variant="boxed" icon={<RefreshCw size={15} className={loading ? 'az-spin' : ''} />} label="Refresh" onClick={() => void refetch()} />
        <Button variant="quiet" size="sm" onClick={exportCsv}><Download size={14} /> Export <ChevronDown size={14} /></Button>
      </div>

      <DataGrid<GridRow>
        rows={gridRows}
        rowKey={(r) => (r.kind === 'product' ? r.p.id : r.kind === 'child' ? `c:${r.parentId}:${r.c.id}` : `n:${r.parentId}`)}
        columns={productColumns({ COLS, cell, childCell, expanded, toggleExpand })}
        selectable
        selected={sel}
        onSelectedChange={setSel}
        rowSelectable={(r) => r.kind === 'product'}
        rowSelectableHint="Campaign rows are not selectable"
        selectAllHint="Select every product on this page"
        rowClassName={(r) => (r.kind === 'child' ? 'childrow' : undefined)}
        /* CONTROLLED, and deliberately `null`. The rows array is parent-then-children, so
           letting the grid sort it would tear children away from their parent. The component
           sorts `filtered` and flattens afterwards; `null` means "controlled and currently
           unsorted — render `rows` as given", which is exactly that contract. The headers stay
           clickable through `onSortChange`. */
        sort={null}
        onSortChange={({ key }) => toggleSort(key)}
        emptyState={loading ? 'Loading…' : 'No products in this view.'}
      />

      <div className="az-pager">
        <span className="count">{filtered.length} products · {mode} · last {days} days{loading ? ' · updating…' : ''}</span>
        <span className="rpp">Results per page
          <select value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))} aria-label="Results per page">{[25, 50, 100, 200, 300].map((n) => <option key={n} value={n}>{n}</option>)}</select>
        </span>
        <span className="range">{firstRow}–{lastRow} of {filtered.length}</span>
        <span className="nav">
          <button onClick={() => setPage(1)} disabled={curPage <= 1} aria-label="First page"><ChevronsLeft size={16} /></button>
          <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={curPage <= 1} aria-label="Previous page"><ChevronLeft size={16} /></button>
          <span className="pg">{curPage} / {totalPages}</span>
          <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={curPage >= totalPages} aria-label="Next page"><ChevronRight size={16} /></button>
          <button onClick={() => setPage(totalPages)} disabled={curPage >= totalPages} aria-label="Last page"><ChevronsRight size={16} /></button>
        </span>
      </div>
    </div>
  )
}
