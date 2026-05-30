'use client'

/**
 * AME.6 — Ad-group drill-down (Amazon parity, image #3). Left nav
 * (Ads / Targeting / Negative targeting / Search terms / Ad group settings /
 * History) + KPI chart header + ads table. Metrics derive live from the daily
 * table (server-supplied), so the numbers match the campaign + by-product views.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { ChevronLeft, Megaphone, ShoppingCart, TrendingUp, Package, Search, Download } from 'lucide-react'
import { KpiStrip, Thumbnail, type KpiTileSpec } from '@/app/_shared/grid-lens'
import { useColumnResize } from '@/app/_shared/useColumnResize'
import { StatusChip } from '@/app/_shared/ads-ui'
import { marketplaceCode, marketplaceCountryName } from '@/lib/marketplace-code'
import { getBackendUrl } from '@/lib/backend-url'
import { CampaignTrendChart, type TrendRow } from '../../CampaignTrendChart'

interface Ad { id: string; asin: string | null; sku: string | null; productId: string | null; status: string; name: string; photoUrl: string | null; impressions: number; clicks: number; spendCents: number; salesCents: number; orders: number; acos: number | null; roas: number | null }
interface AgTarget { id: string; kind: string; expressionType: string; expressionValue: string; bidCents: number; status: string; impressions: number; clicks: number; spendCents: number; salesCents: number; ordersCount?: number; isNegative?: boolean }
export interface AdGroupDetail {
  id: string; name: string; status: string; defaultBidCents: number
  externalAdGroupId: string | null
  campaign: { id: string; name: string; marketplace: string | null; type: string; status: string; externalCampaignId: string | null; dailyBudget?: string }
  metrics: { impressions: number; clicks: number; spendCents: number; salesCents: number; orders: number; acos: number | null; roas: number | null }
  ads: Ad[]
  targets: AgTarget[]
  trend: Array<{ date: string; spendCents: number; salesCents: number; impressions: number; clicks: number; orders: number }>
  windowDays: number
  dataThrough: string | null
}

const eur = (c: number | null | undefined) => (c == null ? '—' : new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(c / 100))
const num = (n: number) => new Intl.NumberFormat('en-US').format(Math.round(n))
const pct = (v: number | null | undefined) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`)
const x2 = (v: number | null | undefined) => (v == null ? '—' : `${v.toFixed(2)}×`)
const acosTone = (v: number | null | undefined) => (v == null ? 'bg-slate-300' : v < 0.2 ? 'bg-emerald-500' : v < 0.35 ? 'bg-amber-500' : 'bg-rose-500')
const acosText = (v: number | null | undefined) => (v == null ? 'text-slate-400' : v < 0.2 ? 'text-emerald-600 dark:text-emerald-400' : v < 0.35 ? 'text-amber-600 dark:text-amber-400' : 'text-rose-600 dark:text-rose-400')

type Tab = 'ads' | 'targeting' | 'negatives' | 'searchterms' | 'settings' | 'history'
const NAV: Array<[Tab, string]> = [
  ['ads', 'Ads'],
  ['targeting', 'Targeting'],
  ['negatives', 'Negative targeting'],
  ['searchterms', 'Search terms'],
  ['settings', 'Ad group settings'],
  ['history', 'History'],
]

export function AdGroupDetailCockpit({ adGroup }: { adGroup: AdGroupDetail }) {
  const [tab, setTab] = useState<Tab>('ads')
  const [searchTerms, setSearchTerms] = useState<Array<Record<string, unknown>> | null>(null)
  const [history, setHistory] = useState<Array<Record<string, unknown>> | null>(null)
  // AME.6 — metrics/trend/ads track the chart window; identity is stable.
  const [data, setData] = useState<AdGroupDetail>(adGroup)
  const [windowDays, setWindowDays] = useState(adGroup.windowDays)
  useEffect(() => {
    if (windowDays === adGroup.windowDays) return
    let alive = true
    void fetch(`${getBackendUrl()}/api/advertising/ad-groups/${adGroup.id}?windowDays=${windowDays}`, { cache: 'no-store' })
      .then((x) => x.json()).then((d) => { if (alive && d?.adGroup) setData(d.adGroup) }).catch(() => {})
    return () => { alive = false }
  }, [windowDays, adGroup.id, adGroup.windowDays])
  const m = data.metrics

  // AME.7 — Amazon-style toolbar state for the Ads table.
  const [adSearch, setAdSearch] = useState('')
  const [adStatus, setAdStatus] = useState('')
  const [sortKey, setSortKey] = useState<'spendCents' | 'salesCents' | 'acos' | 'roas' | 'orders' | 'name'>('spendCents')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  // AF.8 — resizable + persisted columns per Amazon Ads table.
  const adCols = useColumnResize('ads:adgroup:ads', ['name', 'status', 'sku', 'cost', 'orders', 'sales', 'acos', 'roas'], { name: 260, status: 110, sku: 160, cost: 110, orders: 100, sales: 100, acos: 90, roas: 90 })
  const tgtCols = useColumnResize('ads:adgroup:targeting', ['target', 'match', 'bid', 'status'], { target: 280, match: 110, bid: 110, status: 120 })
  const stCols = useColumnResize('ads:adgroup:searchterms', ['query', 'match', 'impr', 'clicks', 'spend', 'orders', 'sales'], { query: 280, match: 110, impr: 90, clicks: 90, spend: 100, orders: 90, sales: 100 })
  const negCols = useColumnResize('ads:adgroup:negatives', ['neg', 'match'], { neg: 320, match: 160 })
  const histCols = useColumnResize('ads:adgroup:history', ['field', 'change', 'by', 'when'], { field: 160, change: 280, by: 140, when: 180 })
  const toggleSort = (k: typeof sortKey) => { if (sortKey === k) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc')); else { setSortKey(k); setSortDir(k === 'name' ? 'asc' : 'desc') } }
  const visibleAds = useMemo(() => {
    const q = adSearch.trim().toLowerCase()
    let r = data.ads.filter((a) => (!q || a.name.toLowerCase().includes(q) || (a.sku ?? '').toLowerCase().includes(q) || (a.asin ?? '').toLowerCase().includes(q)) && (!adStatus || a.status === adStatus))
    const dir = sortDir === 'asc' ? 1 : -1
    r = [...r].sort((a, b) => {
      const va = sortKey === 'name' ? a.name.toLowerCase() : (a[sortKey] ?? -1)
      const vb = sortKey === 'name' ? b.name.toLowerCase() : (b[sortKey] ?? -1)
      return va < vb ? -1 * dir : va > vb ? 1 * dir : 0
    })
    return r
  }, [data.ads, adSearch, adStatus, sortKey, sortDir])
  const adStatuses = useMemo(() => [...new Set(data.ads.map((a) => a.status))].sort(), [data.ads])
  const exportAdsCsv = useCallback(() => {
    const head = ['Ad', 'Status', 'SKU', 'ASIN', 'TotalCost', 'Purchases', 'Sales', 'ACOS', 'ROAS']
    const rows = visibleAds.map((a) => [a.name, a.status, a.sku ?? '', a.asin ?? '', (a.spendCents / 100).toFixed(2), a.orders, (a.salesCents / 100).toFixed(2), a.acos != null ? (a.acos * 100).toFixed(1) : '', a.roas != null ? a.roas.toFixed(2) : ''])
    const csv = [head, ...rows].map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
    const a = document.createElement('a'); a.href = url; a.download = `adgroup-${data.id}-ads.csv`; a.click(); URL.revokeObjectURL(url)
  }, [visibleAds, data.id])
  const sortIcon = (k: typeof sortKey) => (sortKey === k ? (sortDir === 'asc' ? ' ↑' : ' ↓') : '')
  const ariaSort = (k: typeof sortKey): 'ascending' | 'descending' | 'none' => (sortKey === k ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none')

  const tiles: KpiTileSpec[] = [
    { icon: Megaphone, label: 'Total cost', value: eur(m.spendCents), tone: 'amber', detail: `${num(m.clicks)} clicks` },
    { icon: ShoppingCart, label: 'Sales', value: eur(m.salesCents), tone: 'violet', detail: `${num(m.orders)} purchases` },
    { icon: TrendingUp, label: 'ROAS', value: x2(m.roas), tone: 'emerald', detail: `ACOS ${pct(m.acos)}` },
    { icon: Package, label: 'Impressions', value: num(m.impressions), tone: 'slate', detail: m.impressions > 0 ? `CTR ${pct(m.clicks / m.impressions)}` : '—' },
  ]

  const trendRows: TrendRow[] = useMemo(() => data.trend.map((t) => ({
    date: t.date, impressions: t.impressions, clicks: t.clicks, orders: t.orders,
    adSpendCents: t.spendCents, adSalesCents: t.salesCents,
    acos: t.salesCents > 0 ? t.spendCents / t.salesCents : null,
    ctr: t.impressions > 0 ? t.clicks / t.impressions : null,
  })), [data.trend])

  const loadSearchTerms = useCallback(async () => {
    if (!adGroup.campaign.externalCampaignId) { setSearchTerms([]); return }
    // AF.1e — scope to THIS ad group (by external id), not the whole campaign.
    const agScope = adGroup.externalAdGroupId ? `&adGroupId=${adGroup.externalAdGroupId}` : ''
    const r = await fetch(`${getBackendUrl()}/api/advertising/reports/search-terms?campaignId=${adGroup.campaign.externalCampaignId}${agScope}&limit=200`, { cache: 'no-store' }).then((x) => x.json()).catch(() => ({ items: [] }))
    setSearchTerms((r.items ?? r.rows ?? r.searchTerms ?? []) as Array<Record<string, unknown>>)
  }, [adGroup.campaign.externalCampaignId, adGroup.externalAdGroupId])
  const loadHistory = useCallback(async () => {
    const r = await fetch(`${getBackendUrl()}/api/advertising/bid-history?entityType=AD_GROUP&entityId=${adGroup.id}&limit=100`, { cache: 'no-store' }).then((x) => x.json()).catch(() => ({ items: [] }))
    setHistory((r.items ?? []) as Array<Record<string, unknown>>)
  }, [adGroup.id])
  useEffect(() => { if (tab === 'searchterms' && searchTerms == null) void loadSearchTerms() }, [tab, searchTerms, loadSearchTerms])
  useEffect(() => { if (tab === 'history' && history == null) void loadHistory() }, [tab, history, loadHistory])

  // AF.5/AF.6 — inline bid editing + enable/pause toggles. Reuses the existing
  // audited mutation endpoints (PATCH ad-targets/:id, ad-groups/:id,
  // product-ads/:id); applyImmediately pushes to Amazon when live.
  const [busy, setBusy] = useState<string | null>(null)
  const [editBidId, setEditBidId] = useState<string | null>(null)
  const [bidDraft, setBidDraft] = useState('')
  const [defBidDraft, setDefBidDraft] = useState('')
  const [editDefBid, setEditDefBid] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // AF.7 — suggested bid (data-grounded: own observed CPCs) shown in the editor.
  const [suggest, setSuggest] = useState<Record<string, number>>({})
  const patch = useCallback(async (url: string, body: Record<string, unknown>): Promise<Record<string, unknown> | null> => {
    setErr(null)
    const r = await fetch(`${getBackendUrl()}${url}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ applyImmediately: true, ...body }) })
      .then((x) => x.json()).catch(() => null)
    if (!r || r.ok === false) { setErr(r?.error ? String(r.error) : 'Update failed'); return null }
    return r
  }, [])
  const nextStatus = (s: string) => (s === 'ENABLED' ? 'PAUSED' : 'ENABLED')
  const toggleTargetStatus = useCallback(async (t: AgTarget) => {
    setBusy(t.id); const s = nextStatus(t.status)
    const ok = await patch(`/api/advertising/ad-targets/${t.id}`, { status: s, reason: 'ad-group cockpit toggle' })
    if (ok) setData((d) => ({ ...d, targets: d.targets.map((x) => (x.id === t.id ? { ...x, status: s } : x)) }))
    setBusy(null)
  }, [patch])
  const saveBid = useCallback(async (t: AgTarget) => {
    const eur2 = Number(bidDraft.replace(',', '.')); const cents = Math.round(eur2 * 100)
    setEditBidId(null)
    if (!Number.isFinite(cents) || cents < 5 || cents === t.bidCents) return
    setBusy(t.id)
    const ok = await patch(`/api/advertising/ad-targets/${t.id}`, { bidCents: cents, reason: 'ad-group cockpit bid edit' })
    if (ok) { const eff = typeof ok.cpcClamp === 'object' && ok.cpcClamp ? Number((ok.cpcClamp as { to: number }).to) : cents; setData((d) => ({ ...d, targets: d.targets.map((x) => (x.id === t.id ? { ...x, bidCents: eff } : x)) })) }
    setBusy(null)
  }, [bidDraft, patch])
  const loadSuggestion = useCallback(async (t: AgTarget) => {
    if (t.kind !== 'KEYWORD' || suggest[t.id] != null) return
    const r = await fetch(`${getBackendUrl()}/api/advertising/bid-suggestions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ keywords: [t.expressionValue], matchType: t.expressionType, marketplace: data.campaign.marketplace }) }).then((x) => x.json()).catch(() => null)
    const cents = r?.suggestions?.[0]?.suggestedBidCents
    if (Number.isFinite(cents)) setSuggest((s) => ({ ...s, [t.id]: cents }))
  }, [suggest, data.campaign.marketplace])
  const applySuggestion = useCallback(async (t: AgTarget) => {
    const cents = suggest[t.id]; if (!Number.isFinite(cents) || cents < 5) return
    setEditBidId(null); setBusy(t.id)
    const ok = await patch(`/api/advertising/ad-targets/${t.id}`, { bidCents: cents, reason: 'ad-group cockpit applied suggested bid' })
    if (ok) { const eff = typeof ok.cpcClamp === 'object' && ok.cpcClamp ? Number((ok.cpcClamp as { to: number }).to) : cents; setData((d) => ({ ...d, targets: d.targets.map((x) => (x.id === t.id ? { ...x, bidCents: eff } : x)) })) }
    setBusy(null)
  }, [suggest, patch])
  const toggleAdGroupStatus = useCallback(async () => {
    setBusy('adgroup'); const s = nextStatus(data.status)
    const ok = await patch(`/api/advertising/ad-groups/${data.id}`, { status: s, reason: 'ad-group cockpit toggle' })
    if (ok) setData((d) => ({ ...d, status: s }))
    setBusy(null)
  }, [data.status, data.id, patch])
  const saveDefaultBid = useCallback(async () => {
    const cents = Math.round(Number(defBidDraft.replace(',', '.')) * 100)
    setEditDefBid(false)
    if (!Number.isFinite(cents) || cents < 5 || cents === data.defaultBidCents) return
    setBusy('defbid')
    const ok = await patch(`/api/advertising/ad-groups/${data.id}`, { defaultBidCents: cents, reason: 'ad-group cockpit default-bid edit' })
    if (ok) setData((d) => ({ ...d, defaultBidCents: cents }))
    setBusy(null)
  }, [defBidDraft, data.defaultBidCents, data.id, patch])
  const toggleAdStatus = useCallback(async (a: Ad) => {
    setBusy(a.id); const s = nextStatus(a.status)
    const ok = await patch(`/api/advertising/product-ads/${a.id}`, { status: s, reason: 'ad-group cockpit toggle' })
    if (ok) setData((d) => ({ ...d, ads: d.ads.map((x) => (x.id === a.id ? { ...x, status: s } : x)) }))
    setBusy(null)
  }, [patch])
  const StatusToggle = ({ status, onToggle, busy: b }: { status: string; onToggle: () => void; busy: boolean }) => (
    <button onClick={onToggle} disabled={b || status === 'ARCHIVED'} title={status === 'ARCHIVED' ? 'Archived' : `Click to ${status === 'ENABLED' ? 'pause' : 'enable'}`}
      className={`relative inline-flex h-4 w-7 items-center rounded-full transition disabled:opacity-40 ${status === 'ENABLED' ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-600'}`} aria-label={`${status === 'ENABLED' ? 'Pause' : 'Enable'}`} role="switch" aria-checked={status === 'ENABLED'}>
      <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition ${status === 'ENABLED' ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
    </button>
  )

  return (
    <div className="px-4 py-4">
      <Link href={`/marketing/advertising/campaigns/${adGroup.campaign.id}`} className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 mb-2"><ChevronLeft size={14} /> {adGroup.campaign.name}</Link>
      <div className="flex items-center gap-2 flex-wrap">
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Ad group: {adGroup.name}</h1>
        <StatusChip status={data.status} dot />
        <StatusToggle status={data.status} onToggle={toggleAdGroupStatus} busy={busy === 'adgroup'} />
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 mt-1 mb-3">
        <span title={marketplaceCountryName(adGroup.campaign.marketplace)}>{marketplaceCode(adGroup.campaign.marketplace)}</span><span>·</span>
        <span>{adGroup.campaign.type}</span><span>·</span>
        <span className="inline-flex items-center gap-1">Default bid{' '}
          {editDefBid ? (
            <input autoFocus type="number" step="0.01" min="0.05" defaultValue={(data.defaultBidCents / 100).toFixed(2)} onChange={(e) => setDefBidDraft(e.target.value)} onBlur={saveDefaultBid} onKeyDown={(e) => { if (e.key === 'Enter') saveDefaultBid(); if (e.key === 'Escape') setEditDefBid(false) }} aria-label="Default bid (EUR)" className="w-16 px-1 py-0.5 rounded border border-blue-400 bg-white dark:bg-slate-900 tabular-nums" />
          ) : (
            <button onClick={() => { setDefBidDraft(''); setEditDefBid(true) }} className="font-medium text-slate-700 dark:text-slate-200 hover:text-blue-600 hover:underline tabular-nums disabled:opacity-40" disabled={busy === 'defbid'} title="Edit default bid">{eur(data.defaultBidCents)}</button>
          )}
        </span>
        {data.dataThrough && <><span>·</span><span className="text-slate-400">data through {data.dataThrough}</span></>}
        {err && <><span>·</span><span className="text-rose-600 dark:text-rose-400">{err}</span></>}
      </div>

      <div className="flex gap-5 items-start mt-1">
        <nav aria-label="Ad group sections" className="w-52 flex-shrink-0 sticky top-4">
          <div className="space-y-0.5">
            {NAV.map(([k, label]) => (
              <button key={k} onClick={() => setTab(k)} aria-current={tab === k ? 'page' : undefined}
                className={`w-full text-left px-2.5 py-1.5 text-sm rounded-md transition ${tab === k ? 'bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300 font-medium' : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800/70'}`}>
                {label}
              </button>
            ))}
          </div>
        </nav>

        <div className="flex-1 min-w-0">
          <KpiStrip tiles={tiles} className="mb-3" />
          <CampaignTrendChart rows={trendRows} windowDays={windowDays} onWindowChange={setWindowDays} loading={false} />

          {/* AF.4 — contain wide tables to this box (page no longer scrolls). */}
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 mt-3 overflow-x-auto">
            {tab === 'ads' && (<>
              <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-900/40">
                <div className="relative">
                  <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input value={adSearch} onChange={(e) => setAdSearch(e.target.value)} placeholder="Find a product" aria-label="Find a product" className="pl-7 pr-2 py-1 text-sm rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 w-52" />
                </div>
                <select value={adStatus} onChange={(e) => setAdStatus(e.target.value)} aria-label="Filter by status" className="py-1 px-2 text-sm rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900">
                  <option value="">All statuses</option>{adStatuses.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
                <span className="ml-auto text-xs text-slate-400 tabular-nums">{visibleAds.length} of {data.ads.length}</span>
                <button onClick={exportAdsCsv} className="inline-flex items-center gap-1 px-2.5 py-1 text-sm rounded-md border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800"><Download size={13} /> Export</button>
              </div>
              <table className="min-w-full text-sm" style={{ tableLayout: 'fixed', width: 'max-content' }}>
                <thead className="bg-slate-50 dark:bg-slate-900/60 text-xs text-slate-500"><tr>
                  <th {...adCols.thProps('name')} className="text-left px-3 py-2" aria-sort={ariaSort('name')}><button onClick={() => toggleSort('name')} aria-label="Sort by ad name" className="hover:text-slate-700">Ad{sortIcon('name')}</button><adCols.ResizeHandle col="name" /></th><th {...adCols.thProps('status')} className="text-left px-3 py-2">Status<adCols.ResizeHandle col="status" /></th><th {...adCols.thProps('sku')} className="text-left px-3 py-2">SKU / ASIN<adCols.ResizeHandle col="sku" /></th>
                  <th {...adCols.thProps('cost')} className="text-right px-3 py-2" aria-sort={ariaSort('spendCents')}><button onClick={() => toggleSort('spendCents')} aria-label="Sort by total cost" className="hover:text-slate-700">Total cost{sortIcon('spendCents')}</button><adCols.ResizeHandle col="cost" /></th><th {...adCols.thProps('orders')} className="text-right px-3 py-2" aria-sort={ariaSort('orders')}><button onClick={() => toggleSort('orders')} aria-label="Sort by purchases" className="hover:text-slate-700">Purchases{sortIcon('orders')}</button><adCols.ResizeHandle col="orders" /></th><th {...adCols.thProps('sales')} className="text-right px-3 py-2" aria-sort={ariaSort('salesCents')}><button onClick={() => toggleSort('salesCents')} aria-label="Sort by sales" className="hover:text-slate-700">Sales{sortIcon('salesCents')}</button><adCols.ResizeHandle col="sales" /></th><th {...adCols.thProps('acos')} className="text-right px-3 py-2" aria-sort={ariaSort('acos')}><button onClick={() => toggleSort('acos')} aria-label="Sort by ACOS" className="hover:text-slate-700">ACOS{sortIcon('acos')}</button><adCols.ResizeHandle col="acos" /></th><th {...adCols.thProps('roas')} className="text-right px-3 py-2" aria-sort={ariaSort('roas')}><button onClick={() => toggleSort('roas')} aria-label="Sort by ROAS" className="hover:text-slate-700">ROAS{sortIcon('roas')}</button><adCols.ResizeHandle col="roas" /></th>
                </tr></thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {visibleAds.length === 0 ? <tr><td colSpan={8} className="px-3 py-8 text-center text-slate-400 text-xs">{data.ads.length === 0 ? 'No ads in this ad group.' : 'No ads match your filters.'}</td></tr> : visibleAds.map((a) => (
                    <tr key={a.id} className="hover:bg-slate-50 dark:hover:bg-slate-900/40">
                      <td className="px-3 py-1.5">
                        <div className="flex items-center gap-2 min-w-0">
                          <Thumbnail src={a.photoUrl} alt={a.name} hoverPreview={false} />
                          {a.productId
                            ? <Link href={`/products/${a.productId}/edit`} className="truncate max-w-[22rem] text-blue-600 dark:text-blue-400 hover:underline">{a.name}</Link>
                            : <span className="truncate max-w-[22rem]">{a.name}</span>}
                        </div>
                      </td>
                      <td className="px-3 py-1.5"><span className="inline-flex items-center gap-1.5"><StatusToggle status={a.status} onToggle={() => toggleAdStatus(a)} busy={busy === a.id} /><StatusChip status={a.status} dot /></span></td>
                      <td className="px-3 py-1.5 text-xs text-slate-500">{a.sku ?? '—'}{a.asin ? <span className="block text-slate-400">{a.asin}</span> : null}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{eur(a.spendCents)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{num(a.orders)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{eur(a.salesCents)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums"><span className="inline-flex items-center gap-1"><span className={`h-1.5 w-1.5 rounded-full ${acosTone(a.acos)}`} /><span className={acosText(a.acos)}>{pct(a.acos)}</span></span></td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{x2(a.roas)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>)}
            {tab === 'targeting' && (
              <table className="min-w-full text-sm" style={{ tableLayout: 'fixed', width: 'max-content' }}>
                <thead className="bg-slate-50 dark:bg-slate-900/60 text-xs text-slate-500"><tr><th {...tgtCols.thProps('target')} className="text-left px-3 py-2">Target<tgtCols.ResizeHandle col="target" /></th><th {...tgtCols.thProps('match')} className="text-left px-3 py-2">Match<tgtCols.ResizeHandle col="match" /></th><th {...tgtCols.thProps('bid')} className="text-right px-3 py-2">Bid<tgtCols.ResizeHandle col="bid" /></th><th {...tgtCols.thProps('status')} className="text-left px-3 py-2">Status<tgtCols.ResizeHandle col="status" /></th></tr></thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {data.targets.filter((t) => !t.isNegative).length === 0 ? <tr><td colSpan={4} className="px-3 py-8 text-center text-slate-400 text-xs">No keyword/product targets. Auto-targeting ad groups discover terms automatically.</td></tr> : data.targets.filter((t) => !t.isNegative).map((t) => (
                    <tr key={t.id} className="hover:bg-slate-50 dark:hover:bg-slate-900/40">
                      <td className="px-3 py-1.5">{t.expressionValue}</td>
                      <td className="px-3 py-1.5 text-xs text-slate-500">{t.expressionType}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">
                        {editBidId === t.id ? (
                          <span className="inline-flex items-center gap-1 justify-end">
                            <input autoFocus type="number" step="0.01" min="0.05" defaultValue={(t.bidCents / 100).toFixed(2)} onChange={(e) => setBidDraft(e.target.value)} onBlur={() => saveBid(t)} onKeyDown={(e) => { if (e.key === 'Enter') saveBid(t); if (e.key === 'Escape') setEditBidId(null) }} aria-label={`Bid for ${t.expressionValue}`} className="w-20 px-1 py-0.5 rounded border border-blue-400 bg-white dark:bg-slate-900 text-right tabular-nums" />
                            {suggest[t.id] != null && suggest[t.id] !== t.bidCents && (
                              <button onMouseDown={(e) => { e.preventDefault(); applySuggestion(t) }} title="Apply suggested bid (from your observed CPCs)" className="px-1 py-0.5 rounded bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300 text-[11px] whitespace-nowrap">↳ {eur(suggest[t.id])}</button>
                            )}
                          </span>
                        ) : (
                          <button onClick={() => { setBidDraft(''); setEditBidId(t.id); void loadSuggestion(t) }} disabled={busy === t.id} className="hover:text-blue-600 hover:underline disabled:opacity-40" title="Edit bid">{eur(t.bidCents)}</button>
                        )}
                      </td>
                      <td className="px-3 py-1.5"><span className="inline-flex items-center gap-1.5"><StatusToggle status={t.status} onToggle={() => toggleTargetStatus(t)} busy={busy === t.id} /><StatusChip status={t.status} dot /></span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {tab === 'searchterms' && (
              searchTerms == null ? <div className="p-8 text-center text-slate-400 text-sm">Loading…</div> :
              <table className="min-w-full text-sm" style={{ tableLayout: 'fixed', width: 'max-content' }}>
                <thead className="bg-slate-50 dark:bg-slate-900/60 text-xs text-slate-500"><tr><th {...stCols.thProps('query')} className="text-left px-3 py-2">Search term<stCols.ResizeHandle col="query" /></th><th {...stCols.thProps('match')} className="text-left px-3 py-2">Match<stCols.ResizeHandle col="match" /></th><th {...stCols.thProps('impr')} className="text-right px-3 py-2">Impr<stCols.ResizeHandle col="impr" /></th><th {...stCols.thProps('clicks')} className="text-right px-3 py-2">Clicks<stCols.ResizeHandle col="clicks" /></th><th {...stCols.thProps('spend')} className="text-right px-3 py-2">Spend<stCols.ResizeHandle col="spend" /></th><th {...stCols.thProps('orders')} className="text-right px-3 py-2">Orders<stCols.ResizeHandle col="orders" /></th><th {...stCols.thProps('sales')} className="text-right px-3 py-2">Sales<stCols.ResizeHandle col="sales" /></th></tr></thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {searchTerms.length === 0 ? <tr><td colSpan={7} className="px-3 py-8 text-center text-slate-400 text-xs">No search-term data yet (campaign-level report).</td></tr> : searchTerms.slice(0, 200).map((s, i) => (
                    <tr key={i} className="hover:bg-slate-50 dark:hover:bg-slate-900/40"><td className="px-3 py-1.5">{String(s.query ?? '')}</td><td className="px-3 py-1.5 text-xs text-slate-500">{String(s.matchType ?? '')}</td><td className="px-3 py-1.5 text-right tabular-nums">{num(Number(s.impressions ?? 0))}</td><td className="px-3 py-1.5 text-right tabular-nums">{num(Number(s.clicks ?? 0))}</td><td className="px-3 py-1.5 text-right tabular-nums">{eur(Number(s.costMicros ?? 0) / 10000)}</td><td className="px-3 py-1.5 text-right tabular-nums">{num(Number(s.orders7d ?? 0))}</td><td className="px-3 py-1.5 text-right tabular-nums">{eur(Number(s.sales7dCents ?? 0))}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
            {tab === 'negatives' && (
              data.targets.filter((t) => t.isNegative).length === 0
                ? <div className="p-4 text-sm text-slate-600 dark:text-slate-300">No negative keywords on this ad group yet.<div className="mt-3"><Link href={`/marketing/advertising/campaigns/${adGroup.campaign.id}`} className="inline-flex items-center gap-1 px-3 py-1.5 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-700">Manage negative targeting →</Link></div></div>
                : <table className="min-w-full text-sm" style={{ tableLayout: 'fixed', width: 'max-content' }}>
                    <thead className="bg-slate-50 dark:bg-slate-900/60 text-xs text-slate-500"><tr><th {...negCols.thProps('neg')} className="text-left px-3 py-2">Negative<negCols.ResizeHandle col="neg" /></th><th {...negCols.thProps('match')} className="text-left px-3 py-2">Match<negCols.ResizeHandle col="match" /></th></tr></thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {data.targets.filter((t) => t.isNegative).map((t) => (
                        <tr key={t.id} className="hover:bg-slate-50 dark:hover:bg-slate-900/40"><td className="px-3 py-1.5">{t.expressionValue}</td><td className="px-3 py-1.5 text-xs text-slate-500">Negative {t.expressionType.toLowerCase()}</td></tr>
                      ))}
                    </tbody>
                  </table>
            )}
            {tab === 'settings' && (
              <dl className="p-4 grid grid-cols-2 gap-x-6 gap-y-2 text-sm max-w-xl">
                <div><dt className="text-xs text-slate-400">Name</dt><dd className="text-slate-700 dark:text-slate-200">{adGroup.name}</dd></div>
                <div><dt className="text-xs text-slate-400">Status</dt><dd><StatusChip status={adGroup.status} dot /></dd></div>
                <div><dt className="text-xs text-slate-400">Default bid</dt><dd className="text-slate-700 dark:text-slate-200 tabular-nums">{eur(adGroup.defaultBidCents)}</dd></div>
                <div><dt className="text-xs text-slate-400">Campaign</dt><dd><Link href={`/marketing/advertising/campaigns/${adGroup.campaign.id}`} className="text-blue-600 dark:text-blue-400 hover:underline">{adGroup.campaign.name}</Link></dd></div>
                <div><dt className="text-xs text-slate-400">Marketplace</dt><dd className="text-slate-700 dark:text-slate-200">{marketplaceCountryName(adGroup.campaign.marketplace)}</dd></div>
                <div><dt className="text-xs text-slate-400">Type</dt><dd className="text-slate-700 dark:text-slate-200">{adGroup.campaign.type}</dd></div>
              </dl>
            )}
            {tab === 'history' && (
              history == null ? <div className="p-8 text-center text-slate-400 text-sm">Loading…</div> :
              <table className="min-w-full text-sm" style={{ tableLayout: 'fixed', width: 'max-content' }}>
                <thead className="bg-slate-50 dark:bg-slate-900/60 text-xs text-slate-500"><tr><th {...histCols.thProps('field')} className="text-left px-3 py-2">Field<histCols.ResizeHandle col="field" /></th><th {...histCols.thProps('change')} className="text-left px-3 py-2">Change<histCols.ResizeHandle col="change" /></th><th {...histCols.thProps('by')} className="text-left px-3 py-2">By<histCols.ResizeHandle col="by" /></th><th {...histCols.thProps('when')} className="text-right px-3 py-2">When<histCols.ResizeHandle col="when" /></th></tr></thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {history.length === 0 ? <tr><td colSpan={4} className="px-3 py-8 text-center text-slate-400 text-xs">No changes yet.</td></tr> : history.map((h, i) => (
                    <tr key={i}><td className="px-3 py-1.5">{String(h.field ?? '')}</td><td className="px-3 py-1.5 text-xs">{String(h.oldValue ?? '—')} → <span className="font-medium">{String(h.newValue ?? '—')}</span></td><td className="px-3 py-1.5 text-xs text-slate-500">{String(h.changedBy ?? '')}</td><td className="px-3 py-1.5 text-right text-xs text-slate-400">{h.changedAt ? new Date(String(h.changedAt)).toLocaleString() : ''}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
