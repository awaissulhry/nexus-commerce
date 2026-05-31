'use client'

/**
 * Amazon-Ads-faithful Campaigns table (Phase A). Ad-type tabs + toolbar +
 * dense Balham-style table with the Active on/off toggle, status badges,
 * sortable columns, inline budget edit, and bulk actions — wired to real data
 * (/advertising/campaigns merged with 7-day v1-metrics). Customise-columns (full
 * 40–50 set) + KPI strip + Performance chart land in Phases B/C.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Search, ChevronDown, MoreVertical, RefreshCw, Settings, Download, Filter, Info } from 'lucide-react'
import { marketplaceCountryName } from '@/lib/marketplace-code'
import { getBackendUrl } from '@/lib/backend-url'
import { useMarketingEvents } from '@/lib/sync/use-marketing-events'

interface Placements { tos: number | null; pdp: number | null; ros: number | null }
interface Base {
  id: string; name: string; type: 'SP' | 'SB' | 'SD'; adProduct: string | null; status: string
  marketplace: string | null; externalCampaignId: string | null; dailyBudget: string; biddingStrategy: string
  impressions: number; clicks: number; spend: string; sales: string; acos: string | null; roas: string | null
  trueProfitCents: number; deliveryStatus: string | null; deliveryReasons: string[]
  startDate?: string | null; endDate?: string | null; portfolioId?: string | null; placements?: Placements
}
interface V1 { impressions?: number; clicks?: number; costUnits?: number; salesCents?: number; orders?: number; acos?: number | null; roas?: number | null }
interface Row { b: Base; impr: number; clicks: number; spendC: number; salesC: number; orders: number; ctr: number | null; cpc: number | null; acos: number | null; roas: number | null; budgetC: number }

const TABS = [{ k: '', label: 'All' }, { k: 'SP', label: 'Sponsored Products' }, { k: 'SB', label: 'Sponsored Brands' }, { k: 'SD', label: 'Display, Video & Audio' }]
const TYPE_LABEL: Record<string, string> = { SP: 'Sponsored Products', SB: 'Sponsored Brands', SD: 'Sponsored Display' }
const eur = (c: number | null | undefined) => (c == null ? '—' : new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(c / 100))
const num = (n: number | null | undefined) => (n == null ? '—' : new Intl.NumberFormat('en-US').format(Math.round(n)))
const pct = (v: number | null | undefined, dp = 2) => (v == null ? '—' : `${(v * 100).toFixed(dp)}%`)
const x2 = (v: number | null | undefined) => (v == null ? '—' : v.toFixed(2))
const fdate = (d?: string | null) => (d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : null)
const TD = '/marketing/trading-desk/campaigns'

// numeric metric columns (right-aligned), in default order
const METRICS: Array<{ key: string; label: string; get: (r: Row) => string }> = [
  { key: 'impr', label: 'Impressions', get: (r) => num(r.impr) },
  { key: 'clicks', label: 'Clicks', get: (r) => num(r.clicks) },
  { key: 'ctr', label: 'CTR', get: (r) => pct(r.ctr) },
  { key: 'spendC', label: 'Spend', get: (r) => eur(r.spendC) },
  { key: 'cpc', label: 'CPC', get: (r) => eur(r.cpc) },
  { key: 'orders', label: 'Orders', get: (r) => num(r.orders) },
  { key: 'salesC', label: 'Sales', get: (r) => eur(r.salesC) },
  { key: 'acos', label: 'ACOS', get: (r) => pct(r.acos, 1) },
  { key: 'roas', label: 'ROAS', get: (r) => x2(r.roas) },
]

export function CampaignsTable({ initial }: { initial: Base[] }) {
  const [raw, setRaw] = useState<Base[]>(initial)
  const [metrics, setMetrics] = useState<Record<string, V1>>({})
  const [tab, setTab] = useState('SP')
  const [search, setSearch] = useState('')
  const [sortKey, setSortKey] = useState('spendC')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [edit, setEdit] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const refetch = useCallback(async () => {
    setLoading(true)
    try {
      const b = getBackendUrl()
      const [c, m] = await Promise.all([
        fetch(`${b}/api/advertising/campaigns?limit=500`, { cache: 'no-store' }).then((r) => r.json()).catch(() => ({ items: [] })),
        fetch(`${b}/api/advertising/campaigns/v1-metrics?windowDays=7`, { cache: 'no-store' }).then((r) => r.json()).catch(() => ({ byCampaign: {} })),
      ])
      setRaw((c.items ?? []) as Base[]); setMetrics((m.byCampaign ?? {}) as Record<string, V1>)
    } finally { setLoading(false) }
  }, [])
  useEffect(() => { void refetch() }, [refetch])
  useMarketingEvents(useCallback(() => { void refetch() }, [refetch]))

  const rows: Row[] = useMemo(() => raw.map((b) => {
    const m = (b.externalCampaignId && metrics[b.externalCampaignId]) || {}
    const impr = m.impressions ?? b.impressions ?? 0, clicks = m.clicks ?? b.clicks ?? 0
    const spendC = m.costUnits != null ? Math.round(m.costUnits * 100) : Math.round(parseFloat(b.spend || '0') * 100)
    const salesC = m.salesCents ?? Math.round(parseFloat(b.sales || '0') * 100)
    const orders = m.orders ?? 0
    return {
      b, impr, clicks, spendC, salesC, orders,
      ctr: impr > 0 ? clicks / impr : null, cpc: clicks > 0 ? spendC / clicks : null,
      acos: m.acos ?? (b.acos != null ? parseFloat(b.acos) : salesC > 0 ? spendC / salesC : null),
      roas: m.roas ?? (b.roas != null ? parseFloat(b.roas) : spendC > 0 ? salesC / spendC : null),
      budgetC: Math.round(parseFloat(b.dailyBudget || '0') * 100),
    }
  }), [raw, metrics])

  const filtered = useMemo(() => {
    let r = rows
    if (tab) r = r.filter((x) => x.b.type === tab)
    if (search.trim()) { const q = search.toLowerCase(); r = r.filter((x) => x.b.name.toLowerCase().includes(q)) }
    const dir = sortDir === 'asc' ? 1 : -1
    const get = (x: Row): number | string => {
      switch (sortKey) {
        case 'name': return x.b.name; case 'country': return x.b.marketplace ?? ''; case 'status': return x.b.status
        case 'type': return x.b.type; case 'budgetC': return x.budgetC
        case 'impr': return x.impr; case 'clicks': return x.clicks; case 'ctr': return x.ctr ?? -1
        case 'spendC': return x.spendC; case 'cpc': return x.cpc ?? -1; case 'orders': return x.orders
        case 'salesC': return x.salesC; case 'acos': return x.acos ?? -1; case 'roas': return x.roas ?? -1
        default: return x.spendC
      }
    }
    return [...r].sort((a, b) => { const av = get(a), bv = get(b); return typeof av === 'string' && typeof bv === 'string' ? av.localeCompare(bv) * dir : ((av as number) - (bv as number)) * dir })
  }, [rows, tab, search, sortKey, sortDir])

  const toggleSort = (k: string) => { if (sortKey === k) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc')); else { setSortKey(k); setSortDir('desc') } }
  const arrow = (k: string) => (sortKey === k ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '')
  const patch = (id: string, body: Record<string, unknown>) => fetch(`${getBackendUrl()}/api/advertising/campaigns/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const toggleActive = async (b: Base) => { setBusy(b.id); try { await patch(b.id, { status: b.status === 'ENABLED' ? 'PAUSED' : 'ENABLED' }); void refetch() } finally { setBusy(null) } }
  const saveBudget = async (b: Base) => { const v = edit[b.id]; if (v == null) return; const n = parseFloat(v); if (!Number.isFinite(n) || n < 0) { setEdit((e) => { const x = { ...e }; delete x[b.id]; return x }); return } setBusy(b.id); try { await patch(b.id, { dailyBudget: n }); setEdit((e) => { const x = { ...e }; delete x[b.id]; return x }); void refetch() } finally { setBusy(null) } }
  const bulkStatus = async (s: string) => { await Promise.all([...sel].map((id) => patch(id, { status: s }))); setSel(new Set()); void refetch() }
  const exportCsv = () => {
    const head = ['Campaign', 'Country', 'Status', 'Type', 'Budget/d', 'Impressions', 'Clicks', 'CTR%', 'Spend', 'CPC', 'Orders', 'Sales', 'ACOS%', 'ROAS']
    const lines = [head.join(',')]
    for (const r of filtered) lines.push([r.b.name, marketplaceCountryName(r.b.marketplace), r.b.status, TYPE_LABEL[r.b.type], (r.budgetC / 100).toFixed(2), r.impr, r.clicks, r.ctr != null ? (r.ctr * 100).toFixed(2) : '', (r.spendC / 100).toFixed(2), r.cpc != null ? (r.cpc / 100).toFixed(2) : '', r.orders, (r.salesC / 100).toFixed(2), r.acos != null ? (r.acos * 100).toFixed(1) : '', r.roas != null ? r.roas.toFixed(2) : ''].map((x) => `"${String(x).replace(/"/g, '""')}"`).join(','))
    const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' })); const a = document.createElement('a'); a.href = url; a.download = 'campaigns.csv'; a.click(); URL.revokeObjectURL(url)
  }

  const statusBadge = (b: Base) => {
    if (b.status === 'PAUSED') return <span className="az-badge paused">Paused</span>
    if (b.status === 'ARCHIVED' || b.status === 'DRAFT') return <span className="az-badge paused">{b.status[0] + b.status.slice(1).toLowerCase()}</span>
    if (b.deliveryReasons && b.deliveryReasons.length) return <span className="az-badge warn">{b.deliveryReasons[0].replace(/_/g, ' ').toLowerCase()} <Info className="i" size={12} /></span>
    return <span className="az-badge deliver">Delivering <Info className="i" size={12} /></span>
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

      <div className="az-tbar2">
        <span className="ctl">View: Compact <ChevronDown size={14} /></span>
        <span className="ctl" title="Customise columns lands in Phase B">Columns <ChevronDown size={14} /></span>
        <span className="ctl">25 May - 1 Jun 2026 <ChevronDown size={14} /></span>
        <button className="az-iconbtn" onClick={() => void refetch()} title="Refresh"><RefreshCw size={15} className={loading ? 'az-spin' : ''} /></button>
        <span className="az-iconbtn" style={{ border: 0 }}><Settings size={16} /></span>
        <span className="ctl" onClick={exportCsv}><Download size={14} /> Export <ChevronDown size={14} /></span>
      </div>

      <div className="az-tablewrap">
        <table className="az-table">
          <thead>
            <tr>
              <th className="l az-cellsticky" style={{ width: 36 }}><input className="az-check" type="checkbox" checked={allChecked} onChange={(e) => setSel(e.target.checked ? new Set(filtered.map((r) => r.b.id)) : new Set())} /></th>
              <th className="l">Active</th>
              <th className="l" onClick={() => toggleSort('name')}>Campaign name{arrow('name')}</th>
              <th className="l" style={{ width: 28 }} />
              <th className="l" onClick={() => toggleSort('country')}>Country{arrow('country')}</th>
              <th className="l" onClick={() => toggleSort('status')}>Status{arrow('status')} <Info className="info" size={12} /></th>
              <th className="l" onClick={() => toggleSort('type')}>Type{arrow('type')} <Info className="info" size={12} /></th>
              <th className="l">Portfolio name <Info className="info" size={12} /></th>
              <th className="l">Start date</th>
              <th className="l">End date</th>
              <th onClick={() => toggleSort('budgetC')}>Budget{arrow('budgetC')}</th>
              {METRICS.map((m) => <th key={m.key} onClick={() => toggleSort(m.key)}>{m.label}{arrow(m.key)}</th>)}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && <tr><td className="az-empty" colSpan={11 + METRICS.length}>{loading ? 'Loading…' : 'No campaigns.'}</td></tr>}
            {filtered.map((r) => {
              const b = r.b; const editing = edit[b.id] != null
              return (
                <tr key={b.id} className={sel.has(b.id) ? 'sel' : ''}>
                  <td className="l az-cellsticky"><input className="az-check" type="checkbox" checked={sel.has(b.id)} onChange={(e) => setSel((s) => { const n = new Set(s); if (e.target.checked) n.add(b.id); else n.delete(b.id); return n })} /></td>
                  <td className="l"><button className={`az-toggle ${b.status === 'ENABLED' ? 'on' : ''}`} disabled={busy === b.id} onClick={() => void toggleActive(b)} aria-label="Toggle active"><i /></button></td>
                  <td className="l"><a className="cn" href={`${TD}/${b.id}`} target="_blank" rel="noopener noreferrer">{b.name}</a></td>
                  <td className="l"><button className="az-kebab" title="Actions"><MoreVertical size={16} /></button></td>
                  <td className="l">{marketplaceCountryName(b.marketplace) || '—'}</td>
                  <td className="l">{statusBadge(b)}</td>
                  <td className="l"><div>{TYPE_LABEL[b.type] ?? b.type}</div><div className="sub">{/auto|close|loose|substitute/i.test(b.name) ? 'Automatic Targeting' : 'Manual targeting'}</div></td>
                  <td className="l">{b.portfolioId ? <a className="cn">{b.portfolioId}</a> : <span className="sub">—</span>}</td>
                  <td className="l">{fdate(b.startDate) ?? '—'}</td>
                  <td className="l">{fdate(b.endDate) ?? <span className="sub">No end date</span>}</td>
                  <td className="num">{editing
                    ? <input autoFocus className="az-edit" type="number" step="0.01" value={edit[b.id]} onChange={(e) => setEdit((s) => ({ ...s, [b.id]: e.target.value }))} onKeyDown={(e) => { if (e.key === 'Enter') void saveBudget(b); if (e.key === 'Escape') setEdit((s) => { const x = { ...s }; delete x[b.id]; return x }) }} onBlur={() => void saveBudget(b)} disabled={busy === b.id} />
                    : <button className="az-editbtn" onClick={() => setEdit((s) => ({ ...s, [b.id]: (r.budgetC / 100).toFixed(2) }))}>{eur(r.budgetC)}<span className="sub"> / day</span></button>}</td>
                  {METRICS.map((m) => <td key={m.key} className="num">{m.get(r)}</td>)}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div style={{ padding: '10px 2px', color: 'var(--ink2)', fontSize: 12 }}>{filtered.length} campaigns · metrics last 7 days{loading ? ' · updating…' : ''}</div>
    </div>
  )
}
