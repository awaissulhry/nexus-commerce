'use client'

/**
 * Amazon-Ads-faithful Campaigns table. Ad-type tabs + toolbar + dense
 * Balham-style grid with the Active on/off toggle, status badges, inline budget
 * edit, bulk actions, and a fully registry-driven column system: every column
 * comes from columns.ts and the "Customise columns" modal (Phase B) controls
 * which are shown and in what order (persisted to localStorage). Wired to real
 * data (/advertising/campaigns merged with 7-day v1-metrics). KPI strip + the
 * multi-metric Performance chart land in Phase C.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Search, ChevronDown, MoreVertical, RefreshCw, Settings, Download, Filter, Info } from 'lucide-react'
import { marketplaceCountryName } from '@/lib/marketplace-code'
import { getBackendUrl } from '@/lib/backend-url'
import { useMarketingEvents } from '@/lib/sync/use-marketing-events'
import { CustomiseColumns } from './CustomiseColumns'
import { PerformancePanel } from './PerformancePanel'
import { META_BY_KEY, DEFAULT_VISIBLE, STORAGE_KEY } from './columns'

interface Placements { tos: number | null; pdp: number | null; ros: number | null }
interface Base {
  id: string; name: string; type: 'SP' | 'SB' | 'SD'; adProduct: string | null; status: string
  marketplace: string | null; externalCampaignId: string | null; dailyBudget: string; biddingStrategy: string
  impressions: number; clicks: number; spend: string; sales: string; acos: string | null; roas: string | null
  trueProfitCents: number; deliveryStatus: string | null; deliveryReasons: string[]
  startDate?: string | null; endDate?: string | null; portfolioId?: string | null; placements?: Placements
}
interface V1 { impressions?: number; clicks?: number; costUnits?: number; salesCents?: number; orders?: number; acos?: number | null; roas?: number | null }
interface Row {
  b: Base; impr: number; clicks: number; spendC: number; salesC: number; orders: number
  ctr: number | null; cpc: number | null; cpm: number | null; cvr: number | null; aov: number | null
  acos: number | null; roas: number | null; budgetC: number; trueProfitC: number; marginPct: number | null
}

const TABS = [{ k: '', label: 'All' }, { k: 'SP', label: 'Sponsored Products' }, { k: 'SB', label: 'Sponsored Brands' }, { k: 'SD', label: 'Display, Video & Audio' }]
const TYPE_LABEL: Record<string, string> = { SP: 'Sponsored Products', SB: 'Sponsored Brands', SD: 'Sponsored Display' }
const BID_STRATEGY: Record<string, string> = {
  DOWN_ONLY: 'Dynamic bids - down only', LEGACY_FOR_SALES: 'Dynamic bids - down only',
  AUTO_FOR_SALES: 'Dynamic bids - up and down', UP_AND_DOWN: 'Dynamic bids - up and down',
  MANUAL: 'Fixed bids', FIXED: 'Fixed bids', RULE_BASED: 'Rule-based bidding',
}
const eur = (c: number | null | undefined) => (c == null ? '—' : new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(c / 100))
const num = (n: number | null | undefined) => (n == null ? '—' : new Intl.NumberFormat('en-US').format(Math.round(n)))
const pct = (v: number | null | undefined, dp = 2) => (v == null ? '—' : `${(v * 100).toFixed(dp)}%`)
const x2 = (v: number | null | undefined) => (v == null ? '—' : v.toFixed(2))
const fdate = (d?: string | null) => (d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : null)
const isAuto = (name: string) => /\bauto|close match|loose match|substitute|complement/i.test(name)
const bidLabel = (s: string | null | undefined) => (s ? BID_STRATEGY[s] ?? s.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase()) : '—')
const titlecase = (s: string) => s.charAt(0) + s.slice(1).toLowerCase()
const TD = '/marketing/trading-desk/campaigns'
const RANGES = [{ d: 1, label: 'Today' }, { d: 7, label: 'Last 7 days' }, { d: 14, label: 'Last 14 days' }, { d: 30, label: 'Last 30 days' }, { d: 60, label: 'Last 60 days' }, { d: 90, label: 'Last 90 days' }]

export function CampaignsTable({ initial }: { initial: Base[] }) {
  const [raw, setRaw] = useState<Base[]>(initial)
  const [metrics, setMetrics] = useState<Record<string, V1>>({})
  const [tab, setTab] = useState('SP')
  const [search, setSearch] = useState('')
  const [sortKey, setSortKey] = useState('spend')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [edit, setEdit] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [visible, setVisible] = useState<string[]>(DEFAULT_VISIBLE)
  const [showCols, setShowCols] = useState(false)
  const [days, setDays] = useState(30)
  const [showRange, setShowRange] = useState(false)
  const rangeLabel = RANGES.find((r) => r.d === days)?.label ?? `Last ${days} days`

  // hydrate column prefs from localStorage (client-only → no SSR mismatch)
  useEffect(() => {
    try {
      const s = localStorage.getItem(STORAGE_KEY)
      if (s) { const arr = JSON.parse(s); if (Array.isArray(arr)) setVisible(arr.filter((k: string) => META_BY_KEY[k] && !META_BY_KEY[k].locked)) }
    } catch { /* ignore */ }
  }, [])
  const applyCols = (next: string[]) => {
    setVisible(next); setShowCols(false)
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)) } catch { /* ignore */ }
  }

  const refetch = useCallback(async () => {
    setLoading(true)
    try {
      const b = getBackendUrl()
      const [c, m] = await Promise.all([
        fetch(`${b}/api/advertising/campaigns?limit=500`, { cache: 'no-store' }).then((r) => r.json()).catch(() => ({ items: [] })),
        fetch(`${b}/api/advertising/campaigns/v1-metrics?windowDays=${days}`, { cache: 'no-store' }).then((r) => r.json()).catch(() => ({ byCampaign: {} })),
      ])
      setRaw((c.items ?? []) as Base[]); setMetrics((m.byCampaign ?? {}) as Record<string, V1>)
    } finally { setLoading(false) }
  }, [days])
  useEffect(() => { void refetch() }, [refetch])
  useMarketingEvents(useCallback(() => { void refetch() }, [refetch]))

  const rows: Row[] = useMemo(() => raw.map((b) => {
    const m = (b.externalCampaignId && metrics[b.externalCampaignId]) || {}
    const impr = m.impressions ?? b.impressions ?? 0, clicks = m.clicks ?? b.clicks ?? 0
    const spendC = m.costUnits != null ? Math.round(m.costUnits * 100) : Math.round(parseFloat(b.spend || '0') * 100)
    const salesC = m.salesCents ?? Math.round(parseFloat(b.sales || '0') * 100)
    const orders = m.orders ?? 0
    const trueProfitC = b.trueProfitCents ?? 0
    return {
      b, impr, clicks, spendC, salesC, orders,
      ctr: impr > 0 ? clicks / impr : null, cpc: clicks > 0 ? spendC / clicks : null,
      cpm: impr > 0 ? (spendC / impr) * 1000 : null, cvr: clicks > 0 ? orders / clicks : null,
      aov: orders > 0 ? salesC / orders : null,
      acos: m.acos ?? (b.acos != null ? parseFloat(b.acos) : salesC > 0 ? spendC / salesC : null),
      roas: m.roas ?? (b.roas != null ? parseFloat(b.roas) : spendC > 0 ? salesC / spendC : null),
      budgetC: Math.round(parseFloat(b.dailyBudget || '0') * 100),
      trueProfitC, marginPct: salesC > 0 ? trueProfitC / salesC : null,
    }
  }), [raw, metrics])

  const sortVal = useCallback((key: string, r: Row): number | string => {
    const b = r.b
    switch (key) {
      case 'active': case 'status': return b.status
      case 'name': return b.name
      case 'country': return marketplaceCountryName(b.marketplace) || ''
      case 'type': return b.type
      case 'targeting': return isAuto(b.name) ? 'Automatic' : 'Manual'
      case 'portfolio': return b.portfolioId ?? ''
      case 'bidStrategy': return bidLabel(b.biddingStrategy)
      case 'budgetType': return 'Daily'
      case 'startDate': return b.startDate ? Date.parse(b.startDate) : 0
      case 'endDate': return b.endDate ? Date.parse(b.endDate) : 0
      case 'budget': return r.budgetC
      case 'spend': return r.spendC
      case 'cpc': return r.cpc ?? -1
      case 'cpm': return r.cpm ?? -1
      case 'impressions': return r.impr
      case 'clicks': return r.clicks
      case 'ctr': return r.ctr ?? -1
      case 'orders': return r.orders
      case 'cvr': return r.cvr ?? -1
      case 'sales': return r.salesC
      case 'acos': return r.acos ?? -1
      case 'roas': return r.roas ?? -1
      case 'aov': return r.aov ?? -1
      case 'trueProfit': return r.trueProfitC
      case 'marginPct': return r.marginPct ?? -1
      default: return -1
    }
  }, [])

  const filtered = useMemo(() => {
    let r = rows
    if (tab) r = r.filter((x) => x.b.type === tab)
    if (search.trim()) { const q = search.toLowerCase(); r = r.filter((x) => x.b.name.toLowerCase().includes(q)) }
    const dir = sortDir === 'asc' ? 1 : -1
    return [...r].sort((a, b) => { const av = sortVal(sortKey, a), bv = sortVal(sortKey, b); return typeof av === 'string' && typeof bv === 'string' ? av.localeCompare(bv) * dir : ((av as number) - (bv as number)) * dir })
  }, [rows, tab, search, sortKey, sortDir, sortVal])

  const order = useMemo(() => ['active', 'name', ...visible.filter((k) => META_BY_KEY[k] && !META_BY_KEY[k].locked)], [visible])

  const toggleSort = (k: string) => { if (sortKey === k) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc')); else { setSortKey(k); setSortDir('desc') } }
  const arrow = (k: string) => (sortKey === k ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '')
  const patch = (id: string, body: Record<string, unknown>) => fetch(`${getBackendUrl()}/api/advertising/campaigns/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const toggleActive = async (b: Base) => { setBusy(b.id); try { await patch(b.id, { status: b.status === 'ENABLED' ? 'PAUSED' : 'ENABLED' }); void refetch() } finally { setBusy(null) } }
  const saveBudget = async (b: Base) => { const v = edit[b.id]; if (v == null) return; const n = parseFloat(v); if (!Number.isFinite(n) || n < 0) { setEdit((e) => { const x = { ...e }; delete x[b.id]; return x }); return } setBusy(b.id); try { await patch(b.id, { dailyBudget: n }); setEdit((e) => { const x = { ...e }; delete x[b.id]; return x }); void refetch() } finally { setBusy(null) } }
  const bulkStatus = async (s: string) => { await Promise.all([...sel].map((id) => patch(id, { status: s }))); setSel(new Set()); void refetch() }

  const statusBadge = (b: Base) => {
    if (b.status === 'PAUSED') return <span className="az-badge paused">Paused</span>
    if (b.status === 'ARCHIVED' || b.status === 'DRAFT') return <span className="az-badge paused">{titlecase(b.status)}</span>
    if (b.deliveryReasons && b.deliveryReasons.length) return <span className="az-badge warn">{b.deliveryReasons[0].replace(/_/g, ' ').toLowerCase()} <Info className="i" size={12} /></span>
    return <span className="az-badge deliver">Delivering <Info className="i" size={12} /></span>
  }

  // ── cell renderer (registry-key → ReactNode) ─────────────────────────────
  const cell = (key: string, r: Row): ReactNode => {
    const b = r.b
    switch (key) {
      case 'active': return <button className={`az-toggle ${b.status === 'ENABLED' ? 'on' : ''}`} disabled={busy === b.id} onClick={() => void toggleActive(b)} aria-label="Toggle active"><i /></button>
      case 'name': return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><a className="cn" href={`${TD}/${b.id}`} target="_blank" rel="noopener noreferrer">{b.name}</a><button className="az-kebab" title="Actions"><MoreVertical size={15} /></button></span>
      case 'country': return marketplaceCountryName(b.marketplace) || '—'
      case 'status': return statusBadge(b)
      case 'type': return TYPE_LABEL[b.type] ?? b.type
      case 'targeting': return isAuto(b.name) ? 'Automatic' : 'Manual'
      case 'portfolio': return b.portfolioId ? <a className="cn">{b.portfolioId}</a> : <span className="sub">—</span>
      case 'bidStrategy': return bidLabel(b.biddingStrategy)
      case 'startDate': return fdate(b.startDate) ?? '—'
      case 'endDate': return fdate(b.endDate) ?? <span className="sub">No end date</span>
      case 'budget': return edit[b.id] != null
        ? <input autoFocus className="az-edit" type="number" step="0.01" value={edit[b.id]} onChange={(e) => setEdit((s) => ({ ...s, [b.id]: e.target.value }))} onKeyDown={(e) => { if (e.key === 'Enter') void saveBudget(b); if (e.key === 'Escape') setEdit((s) => { const x = { ...s }; delete x[b.id]; return x }) }} onBlur={() => void saveBudget(b)} disabled={busy === b.id} />
        : <button className="az-editbtn" onClick={() => setEdit((s) => ({ ...s, [b.id]: (r.budgetC / 100).toFixed(2) }))}>{eur(r.budgetC)}<span className="sub"> / day</span></button>
      case 'budgetType': return 'Daily'
      case 'spend': return eur(r.spendC)
      case 'cpc': return eur(r.cpc)
      case 'cpm': return eur(r.cpm)
      case 'impressions': return num(r.impr)
      case 'clicks': return num(r.clicks)
      case 'ctr': return pct(r.ctr)
      case 'orders': return num(r.orders)
      case 'cvr': return pct(r.cvr)
      case 'sales': return eur(r.salesC)
      case 'acos': return pct(r.acos, 1)
      case 'roas': return x2(r.roas)
      case 'aov': return eur(r.aov)
      case 'trueProfit': return <span style={{ color: r.trueProfitC < 0 ? '#cc1100' : r.trueProfitC > 0 ? 'var(--green)' : undefined, fontWeight: 500 }}>{eur(r.trueProfitC)}</span>
      case 'marginPct': return <span style={{ color: r.marginPct != null && r.marginPct < 0 ? '#cc1100' : undefined }}>{pct(r.marginPct, 1)}</span>
      default: return <span className="sub">—</span>   // viewableImpr, dpv, units, ntb*, tacos (no data yet)
    }
  }

  const csvCell = (key: string, r: Row): string => {
    const b = r.b
    switch (key) {
      case 'active': return b.status === 'ENABLED' ? 'Enabled' : 'Paused'
      case 'name': return b.name
      case 'country': return marketplaceCountryName(b.marketplace) || ''
      case 'status': return b.deliveryReasons?.length ? b.deliveryReasons[0] : (b.status === 'ENABLED' ? 'Delivering' : titlecase(b.status))
      case 'type': return TYPE_LABEL[b.type] ?? b.type
      case 'targeting': return isAuto(b.name) ? 'Automatic' : 'Manual'
      case 'portfolio': return b.portfolioId ?? ''
      case 'bidStrategy': return bidLabel(b.biddingStrategy)
      case 'startDate': return fdate(b.startDate) ?? ''
      case 'endDate': return fdate(b.endDate) ?? ''
      case 'budget': return (r.budgetC / 100).toFixed(2)
      case 'budgetType': return 'Daily'
      case 'spend': return (r.spendC / 100).toFixed(2)
      case 'cpc': return r.cpc != null ? (r.cpc / 100).toFixed(2) : ''
      case 'cpm': return r.cpm != null ? (r.cpm / 100).toFixed(2) : ''
      case 'impressions': return String(r.impr)
      case 'clicks': return String(r.clicks)
      case 'ctr': return r.ctr != null ? (r.ctr * 100).toFixed(2) : ''
      case 'orders': return String(r.orders)
      case 'cvr': return r.cvr != null ? (r.cvr * 100).toFixed(2) : ''
      case 'sales': return (r.salesC / 100).toFixed(2)
      case 'acos': return r.acos != null ? (r.acos * 100).toFixed(1) : ''
      case 'roas': return r.roas != null ? r.roas.toFixed(2) : ''
      case 'aov': return r.aov != null ? (r.aov / 100).toFixed(2) : ''
      case 'trueProfit': return (r.trueProfitC / 100).toFixed(2)
      case 'marginPct': return r.marginPct != null ? (r.marginPct * 100).toFixed(1) : ''
      default: return ''
    }
  }

  const exportCsv = () => {
    const head = order.map((k) => META_BY_KEY[k]?.label ?? k)
    const lines = [head.join(',')]
    for (const r of filtered) lines.push(order.map((k) => `"${csvCell(k, r).replace(/"/g, '""')}"`).join(','))
    const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' })); const a = document.createElement('a'); a.href = url; a.download = 'campaigns.csv'; a.click(); URL.revokeObjectURL(url)
  }

  const allChecked = filtered.length > 0 && filtered.every((r) => sel.has(r.b.id))

  return (
    <div className="az-wrap">
      <div className="az-tabs">
        {TABS.map((t) => <button key={t.k} className={`az-tab ${tab === t.k ? 'on' : ''}`} onClick={() => setTab(t.k)}>{tab === t.k && <span className="ck">✔</span>}{t.label}</button>)}
      </div>

      <div className="az-listhead">
        <span className="title">Campaigns <ChevronDown size={18} /></span>
        <a className="az-btn dark" href="/marketing/advertising/create" target="_blank" rel="noopener noreferrer">Create campaign</a>
        <div className="az-search" style={{ minWidth: 300 }}><Search size={15} /><input placeholder="Find a campaign" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
        <span className="az-link" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Filter size={14} />Filter by <ChevronDown size={14} /></span>
        {sel.size > 0
          ? <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}><b>{sel.size} selected</b><button className="az-btn" onClick={() => void bulkStatus('ENABLED')}>Enable</button><button className="az-btn" onClick={() => void bulkStatus('PAUSED')}>Pause</button><button className="az-link" onClick={() => setSel(new Set())}>Clear</button></span>
          : <span className="az-link" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, opacity: .6 }}>Bulk actions <ChevronDown size={14} /></span>}
        <span style={{ flex: 1 }} />
      </div>

      <PerformancePanel adProduct={tab} days={days} />

      <div className="az-tbar2">
        <span className="ctl">View: Compact <ChevronDown size={14} /></span>
        <span className="ctl" onClick={() => setShowCols(true)} title="Customise columns">Columns <ChevronDown size={14} /></span>
        <span className="az-menuwrap">
          <span className="ctl" onClick={() => setShowRange((v) => !v)}>{rangeLabel} <ChevronDown size={14} /></span>
          {showRange && <>
            <div style={{ position: 'fixed', inset: 0, zIndex: 29 }} onClick={() => setShowRange(false)} />
            <div className="az-menu">
              {RANGES.map((r) => <button key={r.d} className={days === r.d ? 'on' : ''} onClick={() => { setDays(r.d); setShowRange(false) }}>{r.label}{days === r.d && <span>✔</span>}</button>)}
            </div>
          </>}
        </span>
        <button className="az-iconbtn" onClick={() => void refetch()} title="Refresh"><RefreshCw size={15} className={loading ? 'az-spin' : ''} /></button>
        <span className="az-iconbtn" style={{ border: 0 }} onClick={() => setShowCols(true)} title="Settings"><Settings size={16} /></span>
        <span className="ctl" onClick={exportCsv}><Download size={14} /> Export <ChevronDown size={14} /></span>
      </div>

      <div className="az-tablewrap">
        <table className="az-table">
          <thead>
            <tr>
              <th className="l az-cellsticky" style={{ width: 36 }}><input className="az-check" type="checkbox" checked={allChecked} onChange={(e) => setSel(e.target.checked ? new Set(filtered.map((r) => r.b.id)) : new Set())} /></th>
              {order.map((k) => {
                const m = META_BY_KEY[k]; const label = k === 'active' ? 'Active' : m?.label ?? k
                return (
                  <th key={k} className={`${m?.numeric ? '' : 'l '}${sortKey === k ? 'sorted' : ''}`} onClick={() => toggleSort(k)} title={m?.desc}>
                    {label}{m?.info && <Info className="info" size={12} />}{arrow(k)}
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && <tr><td className="az-empty" colSpan={1 + order.length}>{loading ? 'Loading…' : 'No campaigns.'}</td></tr>}
            {filtered.map((r) => {
              const b = r.b
              return (
                <tr key={b.id} className={sel.has(b.id) ? 'sel' : ''}>
                  <td className="l az-cellsticky"><input className="az-check" type="checkbox" checked={sel.has(b.id)} onChange={(e) => setSel((s) => { const n = new Set(s); if (e.target.checked) n.add(b.id); else n.delete(b.id); return n })} /></td>
                  {order.map((k) => <td key={k} className={META_BY_KEY[k]?.numeric ? 'num' : 'l'}>{cell(k, r)}</td>)}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div style={{ padding: '10px 2px', color: 'var(--ink2)', fontSize: 12 }}>{filtered.length} campaigns · {order.length} columns · metrics last {days} days{loading ? ' · updating…' : ''}</div>

      {showCols && <CustomiseColumns visible={visible} onClose={() => setShowCols(false)} onApply={applyCols} />}
    </div>
  )
}
