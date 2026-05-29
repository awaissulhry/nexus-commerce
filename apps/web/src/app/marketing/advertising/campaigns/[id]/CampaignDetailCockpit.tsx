'use client'

/**
 * AX.3 — Amazon-style campaign drill-down. Header (status/type/budget/
 * schedule + KPI tiles) + tabs: Ad groups · Targeting · Search terms ·
 * Placements · History. Targeting bids edit inline (PATCH
 * /advertising/targets/:id); search terms can be added as negatives
 * (existing create); placements read (writes land in AX.8). Search terms +
 * placements fetch lazily on tab open.
 */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { ChevronLeft, Check } from 'lucide-react'
import { KpiStrip, type KpiTileSpec } from '@/app/_shared/grid-lens'
import { getBackendUrl } from '@/lib/backend-url'
import { Megaphone, MousePointerClick, ShoppingCart, TrendingUp } from 'lucide-react'

interface Target { id: string; kind: string; expressionType: string; expressionValue: string; bidCents: number; status: string; impressions: number; clicks: number; spendCents: number; salesCents: number }
interface AdGroup { id: string; name: string; defaultBidCents: number; status: string; impressions: number; clicks: number; spendCents: number; salesCents: number; targets: Target[]; productAds: Array<{ id: string; asin: string | null; sku: string | null; productId: string | null; status: string }> }
export interface CampaignDetailData {
  id: string; name: string; type: string; status: string; marketplace: string | null; externalCampaignId: string | null
  dailyBudget: string; biddingStrategy: string; impressions: number; clicks: number; spend: string; sales: string
  acos: string | null; roas: string | null; trueProfitCents: number; trueProfitMarginPct: string | null
  startDate?: string | null; endDate?: string | null; adGroups: AdGroup[]
}
export interface BidHistoryRow { id: string; entityType: string; field: string; oldValue: string | null; newValue: string | null; changedAt: string; changedBy: string; reason: string | null }

const eur = (c: number | null | undefined) => (c == null ? '—' : new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(c / 100))
const num = (n: number) => new Intl.NumberFormat('en-US').format(Math.round(n))
const pct = (v: number | null | undefined) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`)

type Tab = 'adgroups' | 'targeting' | 'searchterms' | 'placements' | 'history'

export function CampaignDetailCockpit({ campaign, history }: { campaign: CampaignDetailData; history: BidHistoryRow[] }) {
  const [tab, setTab] = useState<Tab>('adgroups')
  const [targets, setTargets] = useState<Target[]>(() => campaign.adGroups.flatMap((g) => g.targets.map((t) => ({ ...t }))))
  const [bidEdit, setBidEdit] = useState<Record<string, string>>({})
  const [searchTerms, setSearchTerms] = useState<Array<Record<string, unknown>> | null>(null)
  const [placements, setPlacements] = useState<Array<Record<string, unknown>> | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const firstAg = campaign.adGroups[0]?.id ?? ''
  const [tForm, setTForm] = useState({ open: false, adGroupId: firstAg, kind: 'PRODUCT' as 'PRODUCT' | 'CATEGORY' | 'AUTO' | 'NEGATIVE', value: '', auto: 'CLOSE_MATCH', bid: '0.50', saving: false, msg: '' })

  const spendC = Math.round(parseFloat(campaign.spend || '0') * 100), salesC = Math.round(parseFloat(campaign.sales || '0') * 100)
  const acos = campaign.acos != null ? parseFloat(campaign.acos) : salesC > 0 ? spendC / salesC : null
  const roas = campaign.roas != null ? parseFloat(campaign.roas) : spendC > 0 ? salesC / spendC : null
  const tiles: KpiTileSpec[] = [
    { icon: Megaphone, label: 'Impressions', value: num(campaign.impressions), tone: 'slate', detail: `CTR ${pct(campaign.impressions ? campaign.clicks / campaign.impressions : null)}` },
    { icon: MousePointerClick, label: 'Clicks', value: num(campaign.clicks), tone: 'blue', detail: `CPC ${eur(campaign.clicks ? spendC / campaign.clicks : null)}` },
    { icon: ShoppingCart, label: 'Spend', value: eur(spendC), tone: 'amber', detail: `ACOS ${pct(acos)}` },
    { icon: TrendingUp, label: 'Sales', value: eur(salesC), tone: 'violet', detail: `ROAS ${roas != null ? roas.toFixed(2) + '×' : '—'}` },
  ]

  const loadSearchTerms = useCallback(async () => {
    if (searchTerms != null) return
    const r = await fetch(`${getBackendUrl()}/api/advertising/reports/search-terms?campaignId=${campaign.externalCampaignId ?? ''}&limit=200`, { cache: 'no-store' }).then((x) => x.json()).catch(() => ({ items: [] }))
    setSearchTerms(r.items ?? [])
  }, [searchTerms, campaign.externalCampaignId])
  const loadPlacements = useCallback(async () => {
    if (placements != null) return
    const r = await fetch(`${getBackendUrl()}/api/advertising/campaigns/${campaign.id}/placements`, { cache: 'no-store' }).then((x) => x.json()).catch(() => ({ placements: [] }))
    setPlacements(r.placements ?? [])
  }, [placements, campaign.id])
  useEffect(() => { if (tab === 'searchterms') void loadSearchTerms(); if (tab === 'placements') void loadPlacements() }, [tab, loadSearchTerms, loadPlacements])

  const saveBid = async (t: Target) => {
    const v = bidEdit[t.id]; if (v == null) return
    const cents = Math.round(parseFloat(v) * 100); if (!Number.isFinite(cents) || cents < 5) return
    setBusy(t.id)
    try {
      await fetch(`${getBackendUrl()}/api/advertising/targets/${t.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bidCents: cents }) })
      setTargets((ts) => ts.map((x) => (x.id === t.id ? { ...x, bidCents: cents } : x)))
      setBidEdit((e) => { const { [t.id]: _, ...rest } = e; return rest })
    } finally { setBusy(null) }
  }
  const submitTarget = async () => {
    if (!tForm.adGroupId) { setTForm((f) => ({ ...f, msg: 'Pick an ad group' })); return }
    setTForm((f) => ({ ...f, saving: true, msg: '' }))
    try {
      if (tForm.kind === 'NEGATIVE') {
        if (!tForm.value.trim()) throw new Error('ASIN required')
        const r = await fetch(`${getBackendUrl()}/api/advertising/negative-targets/create`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ adGroupId: tForm.adGroupId, asin: tForm.value.trim() }) }).then((x) => x.json())
        if (r?.error) throw new Error(r.error)
        setTargets((ts) => [{ id: r.id, kind: 'PRODUCT', expressionType: 'ASIN', expressionValue: `NOT ${tForm.value.trim()}`, bidCents: 0, status: 'ENABLED', impressions: 0, clicks: 0, spendCents: 0, salesCents: 0 }, ...ts])
      } else {
        const value = tForm.kind === 'AUTO' ? tForm.auto : tForm.value.trim()
        if (!value) throw new Error(tForm.kind === 'CATEGORY' ? 'Category id required' : 'ASIN required')
        const r = await fetch(`${getBackendUrl()}/api/advertising/targets/create`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ adGroupId: tForm.adGroupId, kind: tForm.kind, value, bidEur: parseFloat(tForm.bid) || 0.5 }) }).then((x) => x.json())
        if (r?.error) throw new Error(r.error)
        setTargets((ts) => [{ id: r.id, kind: tForm.kind, expressionType: tForm.kind === 'PRODUCT' ? 'ASIN' : tForm.kind === 'CATEGORY' ? 'CATEGORY' : 'AUTO', expressionValue: value, bidCents: Math.round((parseFloat(tForm.bid) || 0.5) * 100), status: 'ENABLED', impressions: 0, clicks: 0, spendCents: 0, salesCents: 0 }, ...ts])
      }
      setTForm((f) => ({ ...f, value: '', saving: false, msg: '✓ added' }))
    } catch (e) { setTForm((f) => ({ ...f, saving: false, msg: (e as Error).message })) }
  }
  const addNegative = async (query: string) => {
    if (!campaign.externalCampaignId) return
    await fetch(`${getBackendUrl()}/api/advertising/negative-keywords/create`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ externalCampaignId: campaign.externalCampaignId, keywordText: query, matchType: 'NEGATIVE_EXACT', scope: 'CAMPAIGN' }) }).catch(() => {})
  }

  const TABS: Array<[Tab, string, number]> = [
    ['adgroups', 'Ad groups', campaign.adGroups.length],
    ['targeting', 'Targeting', targets.length],
    ['searchterms', 'Search terms', searchTerms?.length ?? 0],
    ['placements', 'Placements', placements?.length ?? 0],
    ['history', 'History', history.length],
  ]

  return (
    <div className="px-4 py-4">
      <Link href="/marketing/advertising/campaigns" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 mb-2"><ChevronLeft size={14} /> All campaigns</Link>
      <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">{campaign.name}</h1>
      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 mt-1 mb-3">
        <span className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800">{campaign.status}</span>
        <span>{campaign.type}</span><span>·</span><span>{campaign.marketplace ?? '—'}</span><span>·</span>
        <span>Budget {eur(Math.round(parseFloat(campaign.dailyBudget || '0') * 100))}/d</span><span>·</span>
        <span>{campaign.biddingStrategy}</span>
        {campaign.startDate && <><span>·</span><span>{campaign.startDate.slice(0, 10)} → {campaign.endDate?.slice(0, 10) ?? 'no end'}</span></>}
      </div>
      <KpiStrip tiles={tiles} className="mb-4" />

      <nav className="border-b border-slate-200 dark:border-slate-800 mb-3 flex gap-1">
        {TABS.map(([k, label, n]) => (
          <button key={k} onClick={() => setTab(k)} className={`px-3 py-2 text-sm border-b-2 ${tab === k ? 'border-blue-600 text-blue-700 dark:text-blue-300' : 'border-transparent text-slate-500 hover:text-slate-800'}`}>{label}{n > 0 ? <span className="ml-1 text-xs text-slate-400">({n})</span> : null}</button>
        ))}
      </nav>

      <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800">
        {tab === 'adgroups' && (
          <table className="w-full text-sm"><thead className="bg-slate-50 dark:bg-slate-900/60 text-xs text-slate-500"><tr><th className="text-left px-3 py-2">Ad group</th><th className="text-left px-3 py-2">Status</th><th className="text-right px-3 py-2">Default bid</th><th className="text-right px-3 py-2">Targets</th><th className="text-right px-3 py-2">Impr</th><th className="text-right px-3 py-2">Clicks</th><th className="text-right px-3 py-2">Spend</th><th className="text-right px-3 py-2">Sales</th></tr></thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">{campaign.adGroups.map((g) => <tr key={g.id} className="hover:bg-slate-50 dark:hover:bg-slate-900/40"><td className="px-3 py-1.5 font-medium">{g.name}</td><td className="px-3 py-1.5 text-xs">{g.status}</td><td className="px-3 py-1.5 text-right tabular-nums">{eur(g.defaultBidCents)}</td><td className="px-3 py-1.5 text-right tabular-nums">{g.targets.length}</td><td className="px-3 py-1.5 text-right tabular-nums">{num(g.impressions)}</td><td className="px-3 py-1.5 text-right tabular-nums">{num(g.clicks)}</td><td className="px-3 py-1.5 text-right tabular-nums">{eur(g.spendCents)}</td><td className="px-3 py-1.5 text-right tabular-nums">{eur(g.salesCents)}</td></tr>)}</tbody></table>
        )}
        {tab === 'targeting' && (<>
          <div className="border-b border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-900/40 px-3 py-2">
            {!tForm.open ? (
              <button onClick={() => setTForm((f) => ({ ...f, open: true }))} className="text-sm text-blue-600 hover:underline">+ Add targeting (ASIN · category · auto · negative)</button>
            ) : (
              <div className="flex flex-wrap items-end gap-2">
                <label className="flex flex-col text-[11px] text-slate-500">Ad group
                  <select value={tForm.adGroupId} onChange={(e) => setTForm((f) => ({ ...f, adGroupId: e.target.value }))} className="mt-0.5 px-2 py-1 text-sm rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 min-w-[10rem]">
                    {campaign.adGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                  </select></label>
                <label className="flex flex-col text-[11px] text-slate-500">Type
                  <select value={tForm.kind} onChange={(e) => setTForm((f) => ({ ...f, kind: e.target.value as typeof f.kind, value: '' }))} className="mt-0.5 px-2 py-1 text-sm rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900">
                    <option value="PRODUCT">Product (ASIN)</option><option value="CATEGORY">Category</option><option value="AUTO">Auto-targeting</option><option value="NEGATIVE">Negative ASIN</option>
                  </select></label>
                {tForm.kind === 'AUTO' ? (
                  <label className="flex flex-col text-[11px] text-slate-500">Match
                    <select value={tForm.auto} onChange={(e) => setTForm((f) => ({ ...f, auto: e.target.value }))} className="mt-0.5 px-2 py-1 text-sm rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900">
                      <option value="CLOSE_MATCH">Close match</option><option value="LOOSE_MATCH">Loose match</option><option value="SUBSTITUTES">Substitutes</option><option value="COMPLEMENTS">Complements</option>
                    </select></label>
                ) : (
                  <label className="flex flex-col text-[11px] text-slate-500">{tForm.kind === 'CATEGORY' ? 'Category id' : 'ASIN'}
                    <input value={tForm.value} onChange={(e) => setTForm((f) => ({ ...f, value: e.target.value }))} placeholder={tForm.kind === 'CATEGORY' ? 'e.g. 12345678011' : 'B0XXXXXXXX'} className="mt-0.5 px-2 py-1 text-sm rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 w-36" /></label>
                )}
                {tForm.kind !== 'NEGATIVE' && (
                  <label className="flex flex-col text-[11px] text-slate-500">Bid €
                    <input type="number" step="0.01" value={tForm.bid} onChange={(e) => setTForm((f) => ({ ...f, bid: e.target.value }))} className="mt-0.5 px-2 py-1 text-sm rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 w-20" /></label>
                )}
                <button onClick={submitTarget} disabled={tForm.saving} className="px-3 py-1 text-sm rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">{tForm.saving ? 'Adding…' : 'Add'}</button>
                <button onClick={() => setTForm((f) => ({ ...f, open: false, msg: '' }))} className="px-2 py-1 text-sm text-slate-500 hover:text-slate-700">Cancel</button>
                {tForm.msg && <span className={`text-xs ${tForm.msg.startsWith('✓') ? 'text-emerald-600' : 'text-rose-600'}`}>{tForm.msg}</span>}
              </div>
            )}
          </div>
          <table className="w-full text-sm"><thead className="bg-slate-50 dark:bg-slate-900/60 text-xs text-slate-500"><tr><th className="text-left px-3 py-2">Target</th><th className="text-left px-3 py-2">Match</th><th className="text-right px-3 py-2">Bid</th><th className="text-right px-3 py-2">Impr</th><th className="text-right px-3 py-2">Clicks</th><th className="text-right px-3 py-2">Spend</th><th className="text-right px-3 py-2">Sales</th><th className="text-right px-3 py-2">ACOS</th></tr></thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">{targets.map((t) => { const a = t.salesCents > 0 ? t.spendCents / t.salesCents : null; return <tr key={t.id} className="hover:bg-slate-50 dark:hover:bg-slate-900/40"><td className="px-3 py-1.5">{t.expressionValue}</td><td className="px-3 py-1.5 text-xs text-slate-500">{t.expressionType}</td><td className="px-3 py-1.5 text-right tabular-nums">{bidEdit[t.id] != null ? <span className="inline-flex items-center gap-1">€<input autoFocus type="number" step="0.01" value={bidEdit[t.id]} onChange={(e) => setBidEdit((s) => ({ ...s, [t.id]: e.target.value }))} onKeyDown={(e) => { if (e.key === 'Enter') saveBid(t); if (e.key === 'Escape') setBidEdit((s) => { const { [t.id]: _, ...r } = s; return r }) }} className="w-14 px-1 py-0.5 text-right text-xs rounded border border-blue-400 bg-white dark:bg-slate-900" disabled={busy === t.id} /><button onClick={() => saveBid(t)} className="text-blue-600"><Check size={12} /></button></span> : <button onClick={() => setBidEdit((s) => ({ ...s, [t.id]: (t.bidCents / 100).toFixed(2) }))} className="hover:underline decoration-dotted">{eur(t.bidCents)}</button>}</td><td className="px-3 py-1.5 text-right tabular-nums">{num(t.impressions)}</td><td className="px-3 py-1.5 text-right tabular-nums">{num(t.clicks)}</td><td className="px-3 py-1.5 text-right tabular-nums">{eur(t.spendCents)}</td><td className="px-3 py-1.5 text-right tabular-nums">{eur(t.salesCents)}</td><td className="px-3 py-1.5 text-right tabular-nums">{pct(a)}</td></tr> })}</tbody></table>
        </>)}
        {tab === 'searchterms' && (
          searchTerms == null ? <div className="p-6 text-center text-slate-400 text-sm">Loading…</div> :
          <table className="w-full text-sm"><thead className="bg-slate-50 dark:bg-slate-900/60 text-xs text-slate-500"><tr><th className="text-left px-3 py-2">Search term</th><th className="text-left px-3 py-2">Match</th><th className="text-right px-3 py-2">Impr</th><th className="text-right px-3 py-2">Clicks</th><th className="text-right px-3 py-2">Spend</th><th className="text-right px-3 py-2">Orders</th><th className="text-right px-3 py-2">Sales</th><th className="px-3 py-2"></th></tr></thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">{searchTerms.length === 0 ? <tr><td colSpan={8} className="px-3 py-6 text-center text-slate-400 text-xs">No search-term data yet (run the search-terms report cycle).</td></tr> : searchTerms.map((s, i) => <tr key={i} className="hover:bg-slate-50 dark:hover:bg-slate-900/40"><td className="px-3 py-1.5">{String(s.query ?? '')}</td><td className="px-3 py-1.5 text-xs text-slate-500">{String(s.matchType ?? '')}</td><td className="px-3 py-1.5 text-right tabular-nums">{num(Number(s.impressions ?? 0))}</td><td className="px-3 py-1.5 text-right tabular-nums">{num(Number(s.clicks ?? 0))}</td><td className="px-3 py-1.5 text-right tabular-nums">{eur(Number(s.costMicros ?? 0) / 10000)}</td><td className="px-3 py-1.5 text-right tabular-nums">{num(Number(s.orders7d ?? 0))}</td><td className="px-3 py-1.5 text-right tabular-nums">{eur(Number(s.sales7dCents ?? 0))}</td><td className="px-3 py-1.5 text-right"><button onClick={() => addNegative(String(s.query ?? ''))} className="text-xs text-rose-600 hover:underline">+ Negative</button></td></tr>)}</tbody></table>
        )}
        {tab === 'placements' && (
          placements == null ? <div className="p-6 text-center text-slate-400 text-sm">Loading…</div> :
          <table className="w-full text-sm"><thead className="bg-slate-50 dark:bg-slate-900/60 text-xs text-slate-500"><tr><th className="text-left px-3 py-2">Placement</th><th className="text-right px-3 py-2">Adjustment</th><th className="text-right px-3 py-2">Impr</th><th className="text-right px-3 py-2">Clicks</th><th className="text-right px-3 py-2">Cost</th><th className="text-right px-3 py-2">Orders</th></tr></thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">{placements.length === 0 ? <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-400 text-xs">No placement data yet.</td></tr> : placements.map((p, i) => <tr key={i} className="hover:bg-slate-50 dark:hover:bg-slate-900/40"><td className="px-3 py-1.5">{String(p.placement ?? '')}</td><td className="px-3 py-1.5 text-right tabular-nums">{Number(p.adjustmentPct ?? 0)}%</td><td className="px-3 py-1.5 text-right tabular-nums">{num(Number(p.impressions ?? 0))}</td><td className="px-3 py-1.5 text-right tabular-nums">{num(Number(p.clicks ?? 0))}</td><td className="px-3 py-1.5 text-right tabular-nums">{eur(Number(p.costMicros ?? 0) / 10000)}</td><td className="px-3 py-1.5 text-right tabular-nums">{num(Number(p.orders7d ?? 0))}</td></tr>)}</tbody></table>
        )}
        {tab === 'history' && (
          <table className="w-full text-sm"><thead className="bg-slate-50 dark:bg-slate-900/60 text-xs text-slate-500"><tr><th className="text-left px-3 py-2">Field</th><th className="text-left px-3 py-2">Change</th><th className="text-left px-3 py-2">By</th><th className="text-right px-3 py-2">When</th></tr></thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">{history.length === 0 ? <tr><td colSpan={4} className="px-3 py-6 text-center text-slate-400 text-xs">No changes yet.</td></tr> : history.map((h) => <tr key={h.id}><td className="px-3 py-1.5">{h.field}</td><td className="px-3 py-1.5 text-xs">{h.oldValue ?? '—'} → <span className="font-medium">{h.newValue ?? '—'}</span></td><td className="px-3 py-1.5 text-xs text-slate-500">{h.changedBy}</td><td className="px-3 py-1.5 text-right text-xs text-slate-400">{new Date(h.changedAt).toLocaleString()}</td></tr>)}</tbody></table>
        )}
      </div>
    </div>
  )
}
