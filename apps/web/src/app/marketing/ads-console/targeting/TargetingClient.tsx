'use client'

/**
 * Amazon-Ads-faithful Targeting screen. Two sub-tabs:
 *  • Keywords & targets — account-wide AdTarget roster (GET /advertising/targets)
 *    with match-type badges, inline bid edit (POST /ad-targets/bulk-bid), status,
 *    and the standard metric columns.
 *  • Search terms — the search-term report (GET /advertising/reports/search-terms)
 *    with one-click harvesting: promote a term to an Exact/Phrase keyword
 *    (POST /advertising/search-terms/promote) or negate it (POST /negative-keywords).
 * Reuses the console substrate (chrome, Performance chart, Balham table, range).
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Search, ChevronDown, RefreshCw, Plus, Ban, Check } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { marketplaceCountryName } from '@/lib/marketplace-code'
import { useMarketingEvents } from '@/lib/sync/use-marketing-events'
import { PerformancePanel } from '../campaigns/PerformancePanel'

interface Targ {
  id: string; text: string; kind: string; matchType: string; bidCents: number; status: string
  campaignId: string; campaignName: string; externalCampaignId: string | null; marketplace: string | null
  adGroupId: string; externalAdGroupId: string | null; adGroupName: string
  impressions: number; clicks: number; spendCents: number; salesCents: number; orders: number; acos: number | null; roas: number | null; windowed?: boolean
}
interface ST {
  query: string; matchType: string | null; campaignId: string; adGroupId: string; marketplace: string; adProduct: string
  impressions: number; clicks: number; costUnits: number; salesCents: number; orders: number; acos: number | null; roas: number | null; ctr: number | null; cpc: number | null; isCandidate: boolean
}

const TABS = [{ k: 'targeting', label: 'Keywords & targets' }, { k: 'searchterms', label: 'Search terms' }]
const RANGES = [{ d: 7, label: 'Last 7 days' }, { d: 14, label: 'Last 14 days' }, { d: 30, label: 'Last 30 days' }, { d: 60, label: 'Last 60 days' }, { d: 90, label: 'Last 90 days' }]
const eur = (c: number | null | undefined) => (c == null ? '—' : new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(c / 100))
const num = (n: number | null | undefined) => (n == null ? '—' : new Intl.NumberFormat('en-US').format(Math.round(n)))
const pct = (v: number | null | undefined, dp = 1) => (v == null ? '—' : `${(v * 100).toFixed(dp)}%`)
const x2 = (v: number | null | undefined) => (v == null ? '—' : v.toFixed(2))
const MATCH_LABEL: Record<string, string> = { EXACT: 'Exact', PHRASE: 'Phrase', BROAD: 'Broad', ASIN: 'Product', CATEGORY_REFINEMENT: 'Category', CATEGORY: 'Category', AUTO: 'Auto' }

export function TargetingClient({ initialTargets }: { initialTargets: Targ[] }) {
  const [tab, setTab] = useState('targeting')
  const [days, setDays] = useState(30)
  const [showRange, setShowRange] = useState(false)
  const rangeLabel = RANGES.find((r) => r.d === days)?.label ?? `Last ${days} days`

  // ── keywords/targets tab ──────────────────────────────────────────────
  const [targets, setTargets] = useState<Targ[]>(initialTargets)
  const [tLoading, setTLoading] = useState(false)
  const [search, setSearch] = useState('')
  const [sortKey, setSortKey] = useState('spendCents')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [edit, setEdit] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)

  const refetchTargets = useCallback(async () => {
    setTLoading(true)
    try {
      const d = await fetch(`${getBackendUrl()}/api/advertising/targets?windowDays=${days}&limit=500`, { cache: 'no-store' }).then((r) => r.json()).catch(() => ({ rows: [] }))
      setTargets((d.rows ?? []) as Targ[])
    } finally { setTLoading(false) }
  }, [days])
  useEffect(() => { void refetchTargets() }, [refetchTargets])
  useMarketingEvents(useCallback(() => { if (tab === 'targeting') void refetchTargets() }, [tab, refetchTargets]))

  const tSorted = useMemo(() => {
    let r = targets
    if (search.trim()) { const q = search.toLowerCase(); r = r.filter((t) => t.text.toLowerCase().includes(q) || t.campaignName.toLowerCase().includes(q)) }
    const dir = sortDir === 'asc' ? 1 : -1
    const val = (t: Targ): number | string => {
      switch (sortKey) {
        case 'text': return t.text; case 'match': return t.matchType; case 'campaign': return t.campaignName; case 'status': return t.status
        case 'bidCents': return t.bidCents; case 'impressions': return t.impressions; case 'clicks': return t.clicks
        case 'ctr': return t.impressions > 0 ? t.clicks / t.impressions : -1; case 'spendCents': return t.spendCents
        case 'cpc': return t.clicks > 0 ? t.spendCents / t.clicks : -1; case 'orders': return t.orders; case 'salesCents': return t.salesCents
        case 'acos': return t.acos ?? -1; case 'roas': return t.roas ?? -1; default: return t.spendCents
      }
    }
    return [...r].sort((a, b) => { const av = val(a), bv = val(b); return typeof av === 'string' && typeof bv === 'string' ? av.localeCompare(bv) * dir : ((av as number) - (bv as number)) * dir })
  }, [targets, search, sortKey, sortDir])
  const toggleSort = (k: string) => { if (sortKey === k) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc')); else { setSortKey(k); setSortDir('desc') } }
  const arrow = (k: string) => (sortKey === k ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '')

  const saveBid = async (t: Targ) => {
    const v = edit[t.id]; if (v == null) return
    const n = parseFloat(v)
    if (!Number.isFinite(n) || n < 0.05) { setEdit((e) => { const x = { ...e }; delete x[t.id]; return x }); return }
    setBusy(t.id)
    try {
      await fetch(`${getBackendUrl()}/api/advertising/ad-targets/bulk-bid`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entries: [{ adTargetId: t.id, bidCents: Math.round(n * 100) }] }) })
      setEdit((e) => { const x = { ...e }; delete x[t.id]; return x }); void refetchTargets()
    } finally { setBusy(null) }
  }

  // ── search terms tab ──────────────────────────────────────────────────
  const [st, setSt] = useState<ST[]>([])
  const [stLoading, setStLoading] = useState(false)
  const [stLoaded, setStLoaded] = useState(false)
  const [minSpend, setMinSpend] = useState('0')
  const [hasOrders, setHasOrders] = useState<'any' | 'some' | 'none'>('any')
  const [campMap, setCampMap] = useState<Record<string, string>>({})
  const [done, setDone] = useState<Record<string, 'exact' | 'phrase' | 'neg'>>({})

  const refetchST = useCallback(async () => {
    setStLoading(true)
    try {
      const qs = new URLSearchParams({ lookbackDays: String(days), sortBy: 'spend', limit: '200' })
      if (Number(minSpend) > 0) qs.set('minSpend', minSpend)
      if (hasOrders !== 'any') qs.set('hasOrders', hasOrders)
      const d = await fetch(`${getBackendUrl()}/api/advertising/reports/search-terms?${qs}`, { cache: 'no-store' }).then((r) => r.json()).catch(() => ({ items: [] }))
      setSt((d.items ?? []) as ST[]); setStLoaded(true)
    } finally { setStLoading(false) }
  }, [days, minSpend, hasOrders])
  useEffect(() => { if (tab === 'searchterms') void refetchST() }, [tab, refetchST])
  useEffect(() => {
    if (tab !== 'searchterms' || Object.keys(campMap).length) return
    void fetch(`${getBackendUrl()}/api/advertising/campaigns?limit=500`, { cache: 'no-store' }).then((r) => r.json()).then((d) => {
      const m: Record<string, string> = {}
      for (const c of (d.items ?? [])) if (c.externalCampaignId) m[c.externalCampaignId] = c.name
      setCampMap(m)
    }).catch(() => {})
  }, [tab, campMap])

  const promote = async (r: ST, matchType: 'EXACT' | 'PHRASE') => {
    const key = `${r.query}:${r.campaignId}`; setBusy(key)
    try {
      const bidEur = r.cpc && r.cpc > 0 ? Math.max(0.1, Math.round(r.cpc * 100) / 100) : 0.5
      const res = await fetch(`${getBackendUrl()}/api/advertising/search-terms/promote`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: r.query, externalAdGroupId: r.adGroupId, matchType, bidEur }) })
      if (res.ok) setDone((d) => ({ ...d, [key]: matchType === 'EXACT' ? 'exact' : 'phrase' }))
    } finally { setBusy(null) }
  }
  const negate = async (r: ST) => {
    const key = `${r.query}:${r.campaignId}`; setBusy(key)
    try {
      const res = await fetch(`${getBackendUrl()}/api/advertising/negative-keywords`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ externalCampaignId: r.campaignId, externalAdGroupId: r.adGroupId, keywordText: r.query, matchType: 'NEGATIVE_EXACT', scope: 'AD_GROUP', marketplace: r.marketplace }) })
      if (res.ok) setDone((d) => ({ ...d, [key]: 'neg' }))
    } finally { setBusy(null) }
  }

  const statusBadge = (s: string) => s === 'ENABLED' ? <span className="az-badge deliver">Delivering</span> : <span className="az-badge paused">{s.charAt(0) + s.slice(1).toLowerCase()}</span>

  return (
    <div className="az-wrap">
      <div className="az-tabs">
        {TABS.map((t) => <button key={t.k} className={`az-tab ${tab === t.k ? 'on' : ''}`} onClick={() => setTab(t.k)}>{tab === t.k && <span className="ck">✔</span>}{t.label}</button>)}
      </div>

      <div className="az-listhead">
        <span className="title">{tab === 'targeting' ? 'Keywords & targets' : 'Search terms'} <ChevronDown size={18} /></span>
        {tab === 'targeting' && <div className="az-search" style={{ minWidth: 300 }}><Search size={15} /><input placeholder="Find a keyword or target" value={search} onChange={(e) => setSearch(e.target.value)} /></div>}
        <span style={{ flex: 1 }} />
      </div>

      <PerformancePanel adProduct="" days={days} />

      <div className="az-tbar2">
        {tab === 'searchterms' && <>
          <span className="ctl" style={{ cursor: 'default' }}>Min spend €<input type="number" step="1" min="0" value={minSpend} onChange={(e) => setMinSpend(e.target.value)} style={{ width: 56, marginLeft: 6, border: '1px solid var(--border)', borderRadius: 6, padding: '4px 6px', font: 'inherit' }} /></span>
          <span className="ctl" style={{ cursor: 'default' }}>Orders
            <select value={hasOrders} onChange={(e) => setHasOrders(e.target.value as 'any' | 'some' | 'none')} style={{ marginLeft: 6, border: '1px solid var(--border)', borderRadius: 6, padding: '4px 6px', font: 'inherit', cursor: 'pointer' }}>
              <option value="any">Any</option><option value="some">With orders</option><option value="none">No orders (waste)</option>
            </select>
          </span>
        </>}
        <span className="az-menuwrap">
          <span className="ctl" onClick={() => setShowRange((v) => !v)}>{rangeLabel} <ChevronDown size={14} /></span>
          {showRange && <>
            <div style={{ position: 'fixed', inset: 0, zIndex: 29 }} onClick={() => setShowRange(false)} />
            <div className="az-menu">{RANGES.map((r) => <button key={r.d} className={days === r.d ? 'on' : ''} onClick={() => { setDays(r.d); setShowRange(false) }}>{r.label}{days === r.d && <span>✔</span>}</button>)}</div>
          </>}
        </span>
        <button className="az-iconbtn" onClick={() => { if (tab === 'targeting') void refetchTargets(); else void refetchST() }} title="Refresh"><RefreshCw size={15} className={(tab === 'targeting' ? tLoading : stLoading) ? 'az-spin' : ''} /></button>
      </div>

      {tab === 'targeting' ? (
        <div className="az-tablewrap">
          <table className="az-table">
            <thead><tr>
              <th className="l" onClick={() => toggleSort('text')}>Keyword / target{arrow('text')}</th>
              <th className="l" onClick={() => toggleSort('match')}>Match{arrow('match')}</th>
              <th className="l" onClick={() => toggleSort('campaign')}>Campaign{arrow('campaign')}</th>
              <th className="l" onClick={() => toggleSort('status')}>Status{arrow('status')}</th>
              <th onClick={() => toggleSort('bidCents')}>Bid{arrow('bidCents')}</th>
              <th onClick={() => toggleSort('impressions')}>Impressions{arrow('impressions')}</th>
              <th onClick={() => toggleSort('clicks')}>Clicks{arrow('clicks')}</th>
              <th onClick={() => toggleSort('ctr')}>CTR{arrow('ctr')}</th>
              <th onClick={() => toggleSort('spendCents')}>Spend{arrow('spendCents')}</th>
              <th onClick={() => toggleSort('cpc')}>CPC{arrow('cpc')}</th>
              <th onClick={() => toggleSort('orders')}>Orders{arrow('orders')}</th>
              <th onClick={() => toggleSort('salesCents')}>Sales{arrow('salesCents')}</th>
              <th onClick={() => toggleSort('acos')}>ACOS{arrow('acos')}</th>
              <th onClick={() => toggleSort('roas')}>ROAS{arrow('roas')}</th>
            </tr></thead>
            <tbody>
              {tSorted.length === 0 && <tr><td className="az-empty" colSpan={14}>{tLoading ? 'Loading…' : 'No keywords or targets yet.'}</td></tr>}
              {tSorted.map((t) => {
                const ctr = t.impressions > 0 ? t.clicks / t.impressions : null, cpc = t.clicks > 0 ? t.spendCents / t.clicks : null
                return (
                  <tr key={t.id}>
                    <td className="l"><div style={{ fontWeight: 500 }}>{t.text}</div><div className="sub">{MATCH_LABEL[t.kind] ?? t.kind}</div></td>
                    <td className="l"><span className="az-badge paused">{MATCH_LABEL[t.matchType] ?? t.matchType}</span></td>
                    <td className="l">{t.campaignName}<div className="sub">{marketplaceCountryName(t.marketplace) || ''}</div></td>
                    <td className="l">{statusBadge(t.status)}</td>
                    <td className="num">{edit[t.id] != null
                      ? <input autoFocus className="az-edit" type="number" step="0.01" value={edit[t.id]} onChange={(e) => setEdit((s) => ({ ...s, [t.id]: e.target.value }))} onKeyDown={(e) => { if (e.key === 'Enter') void saveBid(t); if (e.key === 'Escape') setEdit((s) => { const x = { ...s }; delete x[t.id]; return x }) }} onBlur={() => void saveBid(t)} disabled={busy === t.id} />
                      : <button className="az-editbtn" onClick={() => setEdit((s) => ({ ...s, [t.id]: (t.bidCents / 100).toFixed(2) }))}>{eur(t.bidCents)}</button>}</td>
                    <td className="num">{num(t.impressions)}</td>
                    <td className="num">{num(t.clicks)}</td>
                    <td className="num">{pct(ctr, 2)}</td>
                    <td className="num">{eur(t.spendCents)}</td>
                    <td className="num">{eur(cpc)}</td>
                    <td className="num">{num(t.orders)}</td>
                    <td className="num">{eur(t.salesCents)}</td>
                    <td className="num">{pct(t.acos)}</td>
                    <td className="num">{x2(t.roas)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="az-tablewrap">
          <table className="az-table">
            <thead><tr>
              <th className="l">Search term</th>
              <th className="l">Match</th>
              <th className="l">Campaign</th>
              <th>Impressions</th><th>Clicks</th><th>Spend</th><th>Orders</th><th>Sales</th><th>ACOS</th>
              <th className="l" style={{ minWidth: 230 }}>Harvest</th>
            </tr></thead>
            <tbody>
              {st.length === 0 && <tr><td className="az-empty" colSpan={10}>{stLoading ? 'Loading search terms…' : stLoaded ? 'No search terms match these filters.' : 'Loading…'}</td></tr>}
              {st.map((r, i) => {
                const key = `${r.query}:${r.campaignId}`; const d = done[key]; const b = busy === key
                return (
                  <tr key={`${key}:${i}`}>
                    <td className="l"><span style={{ fontWeight: 500 }}>{r.query}</span>{r.isCandidate && <span className="az-badge warn" style={{ marginLeft: 8 }}>waste</span>}</td>
                    <td className="l">{r.matchType ? <span className="az-badge paused">{MATCH_LABEL[r.matchType] ?? r.matchType}</span> : '—'}</td>
                    <td className="l">{campMap[r.campaignId] ?? <span className="sub">{r.campaignId}</span>}<div className="sub">{marketplaceCountryName(r.marketplace) || ''}</div></td>
                    <td className="num">{num(r.impressions)}</td>
                    <td className="num">{num(r.clicks)}</td>
                    <td className="num">{eur(Math.round(r.costUnits * 100))}</td>
                    <td className="num">{num(r.orders)}</td>
                    <td className="num">{eur(r.salesCents)}</td>
                    <td className="num">{pct(r.acos)}</td>
                    <td className="l">
                      {d ? <span className="az-badge deliver"><Check size={12} /> {d === 'neg' ? 'Negated' : d === 'exact' ? 'Added exact' : 'Added phrase'}</span>
                        : <span style={{ display: 'inline-flex', gap: 6 }}>
                          <button className="az-btn" disabled={b} onClick={() => void promote(r, 'EXACT')} title="Add as exact keyword"><Plus size={13} />Exact</button>
                          <button className="az-btn" disabled={b} onClick={() => void promote(r, 'PHRASE')} title="Add as phrase keyword"><Plus size={13} />Phrase</button>
                          <button className="az-btn" disabled={b} onClick={() => void negate(r)} title="Add as negative exact"><Ban size={13} />Negate</button>
                        </span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="az-pager">
        <span className="count">{tab === 'targeting' ? `${tSorted.length} keywords & targets` : `${st.length} search terms`} · last {days} days{(tab === 'targeting' ? tLoading : stLoading) ? ' · updating…' : ''}</span>
      </div>
    </div>
  )
}
