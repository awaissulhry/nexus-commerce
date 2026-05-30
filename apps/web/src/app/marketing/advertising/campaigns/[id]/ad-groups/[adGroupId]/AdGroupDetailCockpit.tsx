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
import { StatusChip } from '@/app/_shared/ads-ui'
import { marketplaceCode, marketplaceCountryName } from '@/lib/marketplace-code'
import { getBackendUrl } from '@/lib/backend-url'
import { CampaignTrendChart, type TrendRow } from '../../CampaignTrendChart'

interface Ad { id: string; asin: string | null; sku: string | null; productId: string | null; status: string; name: string; photoUrl: string | null; impressions: number; clicks: number; spendCents: number; salesCents: number; orders: number; acos: number | null; roas: number | null }
interface AgTarget { id: string; kind: string; expressionType: string; expressionValue: string; bidCents: number; status: string; impressions: number; clicks: number; spendCents: number; salesCents: number; ordersCount?: number }
export interface AdGroupDetail {
  id: string; name: string; status: string; defaultBidCents: number
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
    const r = await fetch(`${getBackendUrl()}/api/advertising/reports/search-terms?campaignId=${adGroup.campaign.externalCampaignId}`, { cache: 'no-store' }).then((x) => x.json()).catch(() => ({ rows: [] }))
    setSearchTerms((r.rows ?? r.searchTerms ?? []) as Array<Record<string, unknown>>)
  }, [adGroup.campaign.externalCampaignId])
  const loadHistory = useCallback(async () => {
    const r = await fetch(`${getBackendUrl()}/api/advertising/bid-history?entityType=AD_GROUP&entityId=${adGroup.id}&limit=100`, { cache: 'no-store' }).then((x) => x.json()).catch(() => ({ items: [] }))
    setHistory((r.items ?? []) as Array<Record<string, unknown>>)
  }, [adGroup.id])
  useEffect(() => { if (tab === 'searchterms' && searchTerms == null) void loadSearchTerms() }, [tab, searchTerms, loadSearchTerms])
  useEffect(() => { if (tab === 'history' && history == null) void loadHistory() }, [tab, history, loadHistory])

  return (
    <div className="px-4 py-4">
      <Link href={`/marketing/advertising/campaigns/${adGroup.campaign.id}`} className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 mb-2"><ChevronLeft size={14} /> {adGroup.campaign.name}</Link>
      <div className="flex items-center gap-2 flex-wrap">
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Ad group: {adGroup.name}</h1>
        <StatusChip status={adGroup.status} dot />
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 mt-1 mb-3">
        <span title={marketplaceCountryName(adGroup.campaign.marketplace)}>{marketplaceCode(adGroup.campaign.marketplace)}</span><span>·</span>
        <span>{adGroup.campaign.type}</span><span>·</span>
        <span>Default bid {eur(adGroup.defaultBidCents)}</span>
        {data.dataThrough && <><span>·</span><span className="text-slate-400">data through {data.dataThrough}</span></>}
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
              <table className="w-full text-sm">
                <thead className="bg-slate-50 dark:bg-slate-900/60 text-xs text-slate-500"><tr>
                  <th className="text-left px-3 py-2" aria-sort={ariaSort('name')}><button onClick={() => toggleSort('name')} aria-label="Sort by ad name" className="hover:text-slate-700">Ad{sortIcon('name')}</button></th><th className="text-left px-3 py-2">Status</th><th className="text-left px-3 py-2">SKU / ASIN</th>
                  <th className="text-right px-3 py-2" aria-sort={ariaSort('spendCents')}><button onClick={() => toggleSort('spendCents')} aria-label="Sort by total cost" className="hover:text-slate-700">Total cost{sortIcon('spendCents')}</button></th><th className="text-right px-3 py-2" aria-sort={ariaSort('orders')}><button onClick={() => toggleSort('orders')} aria-label="Sort by purchases" className="hover:text-slate-700">Purchases{sortIcon('orders')}</button></th><th className="text-right px-3 py-2" aria-sort={ariaSort('salesCents')}><button onClick={() => toggleSort('salesCents')} aria-label="Sort by sales" className="hover:text-slate-700">Sales{sortIcon('salesCents')}</button></th><th className="text-right px-3 py-2" aria-sort={ariaSort('acos')}><button onClick={() => toggleSort('acos')} aria-label="Sort by ACOS" className="hover:text-slate-700">ACOS{sortIcon('acos')}</button></th><th className="text-right px-3 py-2" aria-sort={ariaSort('roas')}><button onClick={() => toggleSort('roas')} aria-label="Sort by ROAS" className="hover:text-slate-700">ROAS{sortIcon('roas')}</button></th>
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
                      <td className="px-3 py-1.5"><StatusChip status={a.status} dot /></td>
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
              <table className="w-full text-sm">
                <thead className="bg-slate-50 dark:bg-slate-900/60 text-xs text-slate-500"><tr><th className="text-left px-3 py-2">Target</th><th className="text-left px-3 py-2">Match</th><th className="text-right px-3 py-2">Bid</th><th className="text-left px-3 py-2">Status</th></tr></thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {data.targets.length === 0 ? <tr><td colSpan={4} className="px-3 py-8 text-center text-slate-400 text-xs">No targets. Auto-targeting ad groups discover terms automatically.</td></tr> : data.targets.map((t) => (
                    <tr key={t.id} className="hover:bg-slate-50 dark:hover:bg-slate-900/40"><td className="px-3 py-1.5">{t.expressionValue}</td><td className="px-3 py-1.5 text-xs text-slate-500">{t.expressionType}</td><td className="px-3 py-1.5 text-right tabular-nums">{eur(t.bidCents)}</td><td className="px-3 py-1.5"><StatusChip status={t.status} dot /></td></tr>
                  ))}
                </tbody>
              </table>
            )}
            {tab === 'searchterms' && (
              searchTerms == null ? <div className="p-8 text-center text-slate-400 text-sm">Loading…</div> :
              <table className="w-full text-sm">
                <thead className="bg-slate-50 dark:bg-slate-900/60 text-xs text-slate-500"><tr><th className="text-left px-3 py-2">Search term</th><th className="text-left px-3 py-2">Match</th><th className="text-right px-3 py-2">Impr</th><th className="text-right px-3 py-2">Clicks</th><th className="text-right px-3 py-2">Spend</th><th className="text-right px-3 py-2">Orders</th><th className="text-right px-3 py-2">Sales</th></tr></thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {searchTerms.length === 0 ? <tr><td colSpan={7} className="px-3 py-8 text-center text-slate-400 text-xs">No search-term data yet (campaign-level report).</td></tr> : searchTerms.slice(0, 200).map((s, i) => (
                    <tr key={i} className="hover:bg-slate-50 dark:hover:bg-slate-900/40"><td className="px-3 py-1.5">{String(s.query ?? '')}</td><td className="px-3 py-1.5 text-xs text-slate-500">{String(s.matchType ?? '')}</td><td className="px-3 py-1.5 text-right tabular-nums">{num(Number(s.impressions ?? 0))}</td><td className="px-3 py-1.5 text-right tabular-nums">{num(Number(s.clicks ?? 0))}</td><td className="px-3 py-1.5 text-right tabular-nums">{eur(Number(s.costMicros ?? 0) / 10000)}</td><td className="px-3 py-1.5 text-right tabular-nums">{num(Number(s.orders7d ?? 0))}</td><td className="px-3 py-1.5 text-right tabular-nums">{eur(Number(s.sales7dCents ?? 0))}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
            {tab === 'negatives' && (
              <div className="p-4 text-sm text-slate-600 dark:text-slate-300">
                Negative keywords and ASINs for this ad group are managed alongside the campaign so they apply consistently.
                <div className="mt-3"><Link href={`/marketing/advertising/campaigns/${adGroup.campaign.id}`} className="inline-flex items-center gap-1 px-3 py-1.5 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-700">Manage negative targeting →</Link></div>
              </div>
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
              <table className="w-full text-sm">
                <thead className="bg-slate-50 dark:bg-slate-900/60 text-xs text-slate-500"><tr><th className="text-left px-3 py-2">Field</th><th className="text-left px-3 py-2">Change</th><th className="text-left px-3 py-2">By</th><th className="text-right px-3 py-2">When</th></tr></thead>
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
