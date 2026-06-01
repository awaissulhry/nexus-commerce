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

import { useCallback, useEffect, useMemo, useState, Fragment, type ReactNode } from 'react'
import { Search, ChevronDown, ChevronRight, RefreshCw, Download, Image as ImageIcon, ChevronLeft, ChevronsLeft, ChevronsRight } from 'lucide-react'
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
  const arrow = (k: string) => (sortKey === k ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '')

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

  const allChecked = paged.length > 0 && paged.every((p) => sel.has(p.id))

  return (
    <div className="az-wrap">
      <div className="az-tabs">
        {MODES.map((t) => <button key={t.k} className={`az-tab ${mode === t.k ? 'on' : ''}`} onClick={() => setMode(t.k)}>{mode === t.k && <span className="ck">✔</span>}{t.label}</button>)}
      </div>

      <div className="az-listhead">
        <span className="title">Advertised products <ChevronDown size={18} /></span>
        <div className="az-search" style={{ minWidth: 320 }}><Search size={15} /><input placeholder="Find a product, ASIN or SKU" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
        <span style={{ flex: 1 }} />
      </div>

      <PerformancePanel adProduct="" days={days} />

      <div className="az-tbar2">
        <span className="az-menuwrap">
          <span className="ctl" onClick={() => setShowRange((v) => !v)}>{rangeLabel} <ChevronDown size={14} /></span>
          {showRange && <>
            <div style={{ position: 'fixed', inset: 0, zIndex: 29 }} onClick={() => setShowRange(false)} />
            <div className="az-menu">{RANGES.map((r) => <button key={r.d} className={days === r.d ? 'on' : ''} onClick={() => { setDays(r.d); setShowRange(false) }}>{r.label}{days === r.d && <span>✔</span>}</button>)}</div>
          </>}
        </span>
        <button className="az-iconbtn" onClick={() => void refetch()} title="Refresh"><RefreshCw size={15} className={loading ? 'az-spin' : ''} /></button>
        <span className="ctl" onClick={exportCsv}><Download size={14} /> Export <ChevronDown size={14} /></span>
      </div>

      <div className="az-tablewrap">
        <table className="az-table">
          <thead>
            <tr>
              <th className="l az-cellsticky"><input className="az-check" type="checkbox" checked={allChecked} onChange={(e) => setSel((s) => { const n = new Set(s); paged.forEach((p) => { if (e.target.checked) n.add(p.id); else n.delete(p.id) }); return n })} /></th>
              <th className="l az-prodstick" onClick={() => toggleSort('product')}>Product{arrow('product')}</th>
              {COLS.map((c) => <th key={c.key} onClick={() => toggleSort(c.key)}>{c.label}{arrow(c.key)}</th>)}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && <tr><td className="az-empty" colSpan={2 + COLS.length}>{loading ? 'Loading…' : 'No products in this view.'}</td></tr>}
            {paged.map((p) => {
              const isOpen = expanded.has(p.id)
              const data = isOpen ? camps[`${p.id}:${days}`] : undefined
              const canExpand = (p.campaignCount ?? 0) > 0 && !p.unmatched
              return (
                <Fragment key={p.id}>
                  <tr className={sel.has(p.id) ? 'sel' : ''}>
                    <td className="l az-cellsticky"><input className="az-check" type="checkbox" checked={sel.has(p.id)} onChange={(e) => setSel((s) => { const n = new Set(s); if (e.target.checked) n.add(p.id); else n.delete(p.id); return n })} /></td>
                    <td className="l az-prodstick">
                      <span className="az-prod">
                        {canExpand
                          ? <button className={`az-expand ${isOpen ? 'open' : ''}`} onClick={() => toggleExpand(p.id)} aria-label={isOpen ? 'Collapse campaigns' : 'Expand campaigns'} aria-expanded={isOpen}><ChevronRight size={15} /></button>
                          : <span style={{ width: 19, display: 'inline-block' }} />}
                        {p.photoUrl ? <img className="ph" src={p.photoUrl} alt="" /> : <span className="ph ph0"><ImageIcon size={16} /></span>}
                        <span className="meta">
                          {p.unmatched ? <span className="nm" style={{ color: 'var(--ink)' }}>{p.name}</span> : <a className="nm" href={`/products/${p.id}`} target="_blank" rel="noopener noreferrer">{p.name}</a>}
                          <span className="ids">{p.asin ? `ASIN ${p.asin}` : ''}{p.asin && p.sku ? ' · ' : ''}{p.sku ? `SKU ${p.sku}` : ''}{p.isParent && p.childCount ? ` · ${p.childCount} variants` : ''}</span>
                        </span>
                      </span>
                    </td>
                    {COLS.map((c) => <td key={c.key} className="num">{cell(c.key, p)}</td>)}
                  </tr>
                  {isOpen && (data === undefined || data === 'loading') && <tr className="childrow"><td className="l az-cellsticky" /><td className="l az-prodstick" colSpan={1 + COLS.length}><span className="childmsg">Loading campaigns…</span></td></tr>}
                  {isOpen && data === 'error' && <tr className="childrow"><td className="l az-cellsticky" /><td className="l az-prodstick" colSpan={1 + COLS.length}><span className="childmsg">Couldn’t load campaigns.</span></td></tr>}
                  {isOpen && Array.isArray(data) && data.length === 0 && <tr className="childrow"><td className="l az-cellsticky" /><td className="l az-prodstick" colSpan={1 + COLS.length}><span className="childmsg">No campaigns advertise this product in range.</span></td></tr>}
                  {isOpen && Array.isArray(data) && data.map((c) => (
                    <tr key={c.id} className="childrow">
                      <td className="l az-cellsticky" />
                      <td className="l az-prodstick"><span className="childname"><span className="gname">{c.name}</span>{c.status === 'ENABLED' ? <span className="az-badge deliver">Delivering</span> : <span className="az-badge paused">{titlecase(c.status || 'Paused')}</span>}</span></td>
                      {COLS.map((col) => <td key={col.key} className="num">{childCell(col.key, c)}</td>)}
                    </tr>
                  ))}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>

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
