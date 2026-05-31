'use client'

/**
 * Trading Desk — Campaigns / Ad Manager grid (P2), native in the hub.
 *
 * Spike-styled dense grid wired to real data: /api/advertising/campaigns
 * (base rows + derived placement multipliers) merged with
 * /api/advertising/campaigns/v1-metrics (30d spend/sales/orders/ACOS/ROAS).
 * Inline budget edit + status toggle + bulk actions + SSE-live, and the
 * "beat-Amazon" inline ToS/PDP/RoS placement columns. Clicking a campaign
 * opens the existing detail in a new tab until the native cockpit lands.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Search, Plus, RefreshCw, Play, Pause, ArrowUpRight } from 'lucide-react'
import { marketplaceCode, marketplaceCountryName } from '@/lib/marketplace-code'
import { getBackendUrl } from '@/lib/backend-url'
import { useMarketingEvents } from '@/lib/sync/use-marketing-events'
import { ByProductTable } from './ByProductTable'

interface Placements { tos: number | null; pdp: number | null; ros: number | null }
interface CampaignBase {
  id: string; name: string; type: 'SP' | 'SB' | 'SD'; adProduct: string | null; status: string
  marketplace: string | null; externalCampaignId: string | null; dailyBudget: string; biddingStrategy: string
  impressions: number; clicks: number; spend: string; sales: string; acos: string | null; roas: string | null
  trueProfitCents: number; trueProfitMarginPct: string | null; deliveryStatus: string | null; deliveryReasons: string[]
  placements?: Placements
}
interface V1Metric { impressions?: number; clicks?: number; costUnits?: number; salesCents?: number; orders?: number; acos?: number | null; roas?: number | null }
interface Row { base: CampaignBase; spendC: number; salesC: number; orders: number; acos: number | null; budgetC: number }

const OLD = '/marketing/advertising/campaigns'
const eur = (c: number | null | undefined) => (c == null ? '—' : new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(c / 100))
const eur0 = (c: number | null | undefined) => (c == null ? '—' : new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(c / 100))
const pct = (v: number | null | undefined) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`)
const acosCls = (v: number | null | undefined) => (v == null ? '' : v <= 0.2 ? 'acos-good' : v <= 0.35 ? 'acos-mid' : 'acos-bad')
const profitColor = (c: number) => (c < 0 ? 'var(--red)' : c === 0 ? 'var(--ink3)' : '#6d28d9')
function Mult({ v }: { v: number | null | undefined }) {
  if (v == null || v === 0) return <span className="mult">—</span>
  return <span className={`mult ${v > 0 ? 'pos' : ''}`}>{v > 0 ? `+${v}%` : `${v}%`}</span>
}

export function CampaignsGrid({ initial }: { initial: CampaignBase[] }) {
  const [raw, setRaw] = useState<CampaignBase[]>(initial)
  const [metrics, setMetrics] = useState<Record<string, V1Metric>>({})
  const [loading, setLoading] = useState(false)
  const [live, setLive] = useState(false)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')
  const [type, setType] = useState('')
  const [market, setMarket] = useState('')
  const [sortKey, setSortKey] = useState('spendC')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [view, setView] = useState<'campaign' | 'product'>('campaign')

  const refetch = useCallback(async () => {
    setLoading(true)
    try {
      const b = getBackendUrl()
      const [c, m] = await Promise.all([
        fetch(`${b}/api/advertising/campaigns?limit=500`, { cache: 'no-store' }).then((r) => r.json()).catch(() => ({ items: [] })),
        fetch(`${b}/api/advertising/campaigns/v1-metrics?windowDays=30`, { cache: 'no-store' }).then((r) => r.json()).catch(() => ({ byCampaign: {} })),
      ])
      setRaw((c.items ?? []) as CampaignBase[])
      setMetrics((m.byCampaign ?? {}) as Record<string, V1Metric>)
    } finally { setLoading(false) }
  }, [])
  useEffect(() => { void refetch() }, [refetch])
  useMarketingEvents(useCallback(() => { void refetch(); setLive(true); setTimeout(() => setLive(false), 4000) }, [refetch]))

  const rows: Row[] = useMemo(() => raw.map((b) => {
    const m = (b.externalCampaignId && metrics[b.externalCampaignId]) || {}
    const spendC = m.costUnits != null ? Math.round(m.costUnits * 100) : Math.round(parseFloat(b.spend || '0') * 100)
    const salesC = m.salesCents ?? Math.round(parseFloat(b.sales || '0') * 100)
    const orders = m.orders ?? 0
    const acos = m.acos ?? (b.acos != null ? parseFloat(b.acos) : salesC > 0 ? spendC / salesC : null)
    return { base: b, spendC, salesC, orders, acos, budgetC: Math.round(parseFloat(b.dailyBudget || '0') * 100) }
  }), [raw, metrics])

  const markets = useMemo(() => [...new Set(raw.map((c) => c.marketplace).filter((x): x is string => !!x))].sort(), [raw])

  const filtered = useMemo(() => {
    let r = rows
    if (search.trim()) { const q = search.toLowerCase(); r = r.filter((x) => x.base.name.toLowerCase().includes(q)) }
    if (status) r = r.filter((x) => x.base.status === status)
    if (type) r = r.filter((x) => x.base.type === type)
    if (market) r = r.filter((x) => x.base.marketplace === market)
    const dir = sortDir === 'asc' ? 1 : -1
    const get = (x: Row): number | string => {
      switch (sortKey) {
        case 'name': return x.base.name
        case 'salesC': return x.salesC
        case 'acos': return x.acos ?? -1
        case 'budgetC': return x.budgetC
        case 'trueProfit': return x.base.trueProfitCents
        default: return x.spendC
      }
    }
    return [...r].sort((a, b) => { const av = get(a), bv = get(b); return typeof av === 'string' && typeof bv === 'string' ? av.localeCompare(bv) * dir : ((av as number) - (bv as number)) * dir })
  }, [rows, search, status, type, market, sortKey, sortDir])

  const totals = useMemo(() => filtered.reduce((a, r) => ({ spendC: a.spendC + r.spendC, salesC: a.salesC + r.salesC }), { spendC: 0, salesC: 0 }), [filtered])

  const sort = (k: string) => { if (sortKey === k) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc')); else { setSortKey(k); setSortDir('desc') } }
  const arrow = (k: string) => (sortKey === k ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '')

  const patch = (id: string, body: Record<string, unknown>) =>
    fetch(`${getBackendUrl()}/api/advertising/campaigns/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

  const saveBudget = async (c: CampaignBase) => {
    const v = edits[c.id]; if (v == null) return
    const n = parseFloat(v); if (!Number.isFinite(n) || n < 0) return
    setBusy(c.id)
    try { await patch(c.id, { dailyBudget: n }); setEdits((e) => { const next = { ...e }; delete next[c.id]; return next }); void refetch() } finally { setBusy(null) }
  }
  const toggle = async (c: CampaignBase) => {
    setBusy(c.id)
    try { await patch(c.id, { status: c.status === 'ENABLED' ? 'PAUSED' : 'ENABLED' }); void refetch() } finally { setBusy(null) }
  }
  const bulkStatus = async (s: string) => { await Promise.all([...sel].map((id) => patch(id, { status: s }))); setSel(new Set()); void refetch() }
  const bulkBudgetPct = async (p: number) => {
    const targets = filtered.filter((r) => sel.has(r.base.id))
    await Promise.all(targets.map((r) => patch(r.base.id, { dailyBudget: Math.max(1, Math.round((r.budgetC / 100) * (1 + p / 100) * 100) / 100) })))
    setSel(new Set()); void refetch()
  }

  const allChecked = filtered.length > 0 && filtered.every((r) => sel.has(r.base.id))

  return (
    <>
      <div className="top">
        <div><h1>Campaigns</h1><div className="sub">{view === 'campaign' ? `${filtered.length} campaigns` : 'By product'} · Amazon · last 30 days</div></div>
        <span className="spacer" />
        <span className="livewrap">{loading && <span style={{ color: 'var(--ink3)', fontWeight: 500 }}>updating…&nbsp;</span>}<span className="livedot" style={{ opacity: live ? 1 : 0.6 }} />{live ? 'Updated just now' : 'Live'}</span>
      </div>

      <div className="scroll">
        <div className="toolbar">
          <div className="seg">
            <button className={view === 'campaign' ? 'on' : ''} onClick={() => setView('campaign')}>By campaign</button>
            <button className={view === 'product' ? 'on' : ''} onClick={() => setView('product')}>By product</button>
          </div>
          <div className="search"><Search size={14} /><input placeholder="Find a campaign…" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
          {view === 'campaign' && (<>
            <select className="flt" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status"><option value="">All status</option>{['ENABLED', 'PAUSED', 'ARCHIVED', 'DRAFT'].map((s) => <option key={s}>{s}</option>)}</select>
            <select className="flt" value={type} onChange={(e) => setType(e.target.value)} aria-label="Filter by type"><option value="">All types</option>{['SP', 'SB', 'SD'].map((s) => <option key={s}>{s}</option>)}</select>
          </>)}
          <select className="flt" value={market} onChange={(e) => setMarket(e.target.value)} aria-label="Filter by market"><option value="">All markets</option>{markets.map((m) => <option key={m} value={m}>{marketplaceCode(m)}</option>)}</select>
          <span className="spacer" />
          <a className="ctl" href={OLD} target="_blank" rel="noopener noreferrer" title="Launch a campaign (opens the current tool in a new tab)"><Plus size={14} /><span>Launch</span></a>
          <button className="ctl" onClick={() => void refetch()} title="Refresh"><RefreshCw size={14} className={loading ? 'spin' : ''} /></button>
        </div>

        {view === 'campaign' && sel.size > 0 && (
          <div className="bulkbar">
            <b>{sel.size} selected</b>
            <button className="gho" onClick={() => void bulkStatus('ENABLED')}>Enable</button>
            <button className="gho" onClick={() => void bulkStatus('PAUSED')}>Pause</button>
            <button className="gho" onClick={() => void bulkBudgetPct(10)}>Budget +10%</button>
            <button className="gho" onClick={() => void bulkBudgetPct(-10)}>Budget −10%</button>
            <button className="clear" onClick={() => setSel(new Set())}>Clear</button>
          </div>
        )}

        {view === 'campaign' ? (
        <div className="card">
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th className="l" style={{ width: 28 }}><input type="checkbox" checked={allChecked} onChange={(e) => setSel(e.target.checked ? new Set(filtered.map((r) => r.base.id)) : new Set())} aria-label="Select all" /></th>
                  <th className="l s" onClick={() => sort('name')}>Campaign{arrow('name')}</th>
                  <th className="l">Status</th><th className="l">Type</th><th className="l">Mkt</th>
                  <th className="s" onClick={() => sort('budgetC')}>Daily budget{arrow('budgetC')}</th>
                  <th className="s" onClick={() => sort('spendC')}>Spend{arrow('spendC')}</th>
                  <th className="s" onClick={() => sort('salesC')}>Sales{arrow('salesC')}</th>
                  <th className="s" onClick={() => sort('acos')}>ACOS{arrow('acos')}</th>
                  <th className="s" onClick={() => sort('trueProfit')}>True profit{arrow('trueProfit')}</th>
                  <th title="Top of Search">ToS</th><th title="Product pages">PDP</th><th title="Rest of search">RoS</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 && <tr><td colSpan={14} className="empty">No campaigns match these filters.</td></tr>}
                {filtered.map((r) => {
                  const b = r.base; const editing = edits[b.id] != null; const p = b.placements
                  return (
                    <tr key={b.id} className={sel.has(b.id) ? 'sel' : ''}>
                      <td className="l"><input type="checkbox" checked={sel.has(b.id)} onChange={(e) => setSel((s) => { const n = new Set(s); if (e.target.checked) n.add(b.id); else n.delete(b.id); return n })} aria-label={`Select ${b.name}`} /></td>
                      <td className="l"><a className="cname" href={`${OLD}/${b.id}`} target="_blank" rel="noopener noreferrer" title={b.name}><span>{b.name}</span><ArrowUpRight className="ext" size={11} /></a></td>
                      <td className="l">{b.status === 'ENABLED' ? <span className="pill g">Enabled</span> : <span className="pill n">{b.status === 'PAUSED' ? 'Paused' : b.status}</span>}</td>
                      <td className="l"><span className="cc az"><span className="dot" style={{ background: 'var(--az)' }} />{b.type}</span></td>
                      <td className="l" title={marketplaceCountryName(b.marketplace)}>{marketplaceCode(b.marketplace)}</td>
                      <td className="num">{editing
                        ? <input autoFocus className="bedit" type="number" step="0.01" value={edits[b.id]} onChange={(e) => setEdits((s) => ({ ...s, [b.id]: e.target.value }))} onKeyDown={(e) => { if (e.key === 'Enter') void saveBudget(b); if (e.key === 'Escape') setEdits((s) => { const next = { ...s }; delete next[b.id]; return next }) }} onBlur={() => void saveBudget(b)} disabled={busy === b.id} />
                        : <button className="budget-btn" onClick={() => setEdits((s) => ({ ...s, [b.id]: (r.budgetC / 100).toFixed(2) }))} title="Edit daily budget">{eur(r.budgetC)}</button>}</td>
                      <td className="num">{eur(r.spendC)}</td>
                      <td className="num">{eur(r.salesC)}</td>
                      <td><span className={acosCls(r.acos)}>{pct(r.acos)}</span></td>
                      <td className="num" style={{ color: profitColor(b.trueProfitCents), fontWeight: 700 }}>{eur(b.trueProfitCents)}</td>
                      <td><Mult v={p?.tos} /></td><td><Mult v={p?.pdp} /></td><td><Mult v={p?.ros} /></td>
                      <td><button className="iact" disabled={busy === b.id} onClick={() => void toggle(b)} title={b.status === 'ENABLED' ? 'Pause' : 'Enable'}>{b.status === 'ENABLED' ? <Pause size={12} /> : <Play size={12} />}</button></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div className="legend" style={{ padding: '12px 14px' }}>
            <span><b>ToS / PDP / RoS</b> = placement bid multipliers, inline (Amazon hides these behind clicks).</span>
            <span><span className="d" style={{ background: 'var(--green)' }} /> ACOS ≤ 20%</span>
            <span><span className="d" style={{ background: 'var(--amber)' }} /> 20–35%</span>
            <span><span className="d" style={{ background: 'var(--red)' }} /> &gt; 35%</span>
            <span style={{ marginLeft: 'auto', fontWeight: 600 }}>Σ Spend {eur0(totals.spendC)} · Sales {eur0(totals.salesC)}</span>
          </div>
        </div>
        ) : (
          <ByProductTable search={search} market={market} />
        )}
      </div>
    </>
  )
}
