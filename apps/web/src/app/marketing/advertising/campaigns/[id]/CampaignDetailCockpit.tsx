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
import { StatusChip } from '@/app/_shared/ads-ui'
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

type Tab = 'adgroups' | 'targeting' | 'searchterms' | 'bidadjust' | 'negatives' | 'settings' | 'history'

export function CampaignDetailCockpit({ campaign, history }: { campaign: CampaignDetailData; history: BidHistoryRow[] }) {
  const [tab, setTab] = useState<Tab>('adgroups')
  const [targets, setTargets] = useState<Target[]>(() => campaign.adGroups.flatMap((g) => g.targets.map((t) => ({ ...t }))))
  const [bidEdit, setBidEdit] = useState<Record<string, string>>({})
  const [searchTerms, setSearchTerms] = useState<Array<Record<string, unknown>> | null>(null)
  const [placements, setPlacements] = useState<Array<Record<string, unknown>> | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [placeAdj, setPlaceAdj] = useState<Record<string, string>>({ PLACEMENT_TOP: '0', PLACEMENT_PRODUCT_PAGE: '0', PLACEMENT_REST_OF_SEARCH: '0' })
  const [placeStrat, setPlaceStrat] = useState(campaign.biddingStrategy?.toLowerCase().includes('auto') ? 'autoForSales' : campaign.biddingStrategy?.toLowerCase().includes('manual') ? 'manual' : 'legacyForSales')
  const [placeSaving, setPlaceSaving] = useState(false)
  const [placeMsg, setPlaceMsg] = useState('')
  const firstAg = campaign.adGroups[0]?.id ?? ''
  const [tForm, setTForm] = useState({ open: false, adGroupId: firstAg, kind: 'PRODUCT' as 'PRODUCT' | 'CATEGORY' | 'AUTO' | 'AUDIENCE' | 'NEGATIVE', value: '', auto: 'CLOSE_MATCH', audType: 'AUDIENCE', bid: '0.50', saving: false, msg: '' })
  // Campaign settings (editable, Amazon-native).
  const [settings, setSettings] = useState({ name: campaign.name, dailyBudget: String(parseFloat(campaign.dailyBudget || '0').toFixed(2)), biddingStrategy: campaign.biddingStrategy?.toLowerCase().includes('auto') ? 'autoForSales' : campaign.biddingStrategy?.toLowerCase().includes('manual') ? 'manual' : 'legacyForSales', status: campaign.status, saving: false, msg: '' })
  // Negative targeting (campaign-level add).
  const [negForm, setNegForm] = useState({ kind: 'KEYWORD' as 'KEYWORD' | 'ASIN', value: '', match: 'NEGATIVE_EXACT', adGroupId: firstAg, saving: false, msg: '' })
  const [addedNegs, setAddedNegs] = useState<Array<{ kind: string; value: string; match?: string }>>([])
  const [stAddBusy, setStAddBusy] = useState<string | null>(null)

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
    const seed: Record<string, string> = {}
    for (const p of (r.placements ?? []) as Array<Record<string, unknown>>) { const k = String(p.placement ?? ''); if (k in placeAdj && Number(p.adjustmentPct) > 0) seed[k] = String(p.adjustmentPct) }
    if (Object.keys(seed).length) setPlaceAdj((a) => ({ ...a, ...seed }))
  }, [placements, campaign.id, placeAdj])
  const savePlacements = async () => {
    setPlaceSaving(true); setPlaceMsg('')
    try {
      const adjustments = Object.entries(placeAdj).map(([placement, v]) => ({ placement, percentage: Math.max(0, Math.min(900, Math.round(parseFloat(v) || 0))) }))
      const r = await fetch(`${getBackendUrl()}/api/advertising/campaigns/${campaign.id}/placements`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ adjustments, biddingStrategy: placeStrat }) }).then((x) => x.json())
      if (r?.error) throw new Error(r.error)
      setPlaceMsg(`✓ saved (${r.mode})`)
    } catch (e) { setPlaceMsg((e as Error).message) } finally { setPlaceSaving(false) }
  }
  useEffect(() => { if (tab === 'searchterms') void loadSearchTerms(); if (tab === 'bidadjust') void loadPlacements() }, [tab, loadSearchTerms, loadPlacements])

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
        if (!value) throw new Error(tForm.kind === 'CATEGORY' ? 'Category id required' : tForm.kind === 'AUDIENCE' ? 'Audience id / ASIN required' : 'ASIN required')
        const r = await fetch(`${getBackendUrl()}/api/advertising/targets/create`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ adGroupId: tForm.adGroupId, kind: tForm.kind, value, audienceType: tForm.kind === 'AUDIENCE' ? tForm.audType : undefined, bidEur: parseFloat(tForm.bid) || 0.5 }) }).then((x) => x.json())
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
  // Amazon-style "Add as" from a search term: promote to a managed keyword or negate it.
  const addSearchTermAs = async (query: string, as: 'EXACT' | 'PHRASE' | 'BROAD' | 'NEGATIVE') => {
    if (!query) return
    setStAddBusy(query + as)
    try {
      if (as === 'NEGATIVE') { await addNegative(query) }
      else if (firstAg) { await fetch(`${getBackendUrl()}/api/advertising/keywords/create`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ adGroupId: firstAg, keywordText: query, matchType: as, bidEur: 0.5 }) }).catch(() => {}) }
    } finally { setStAddBusy(null) }
  }
  const saveSettings = async () => {
    setSettings((s) => ({ ...s, saving: true, msg: '' }))
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/campaigns/${campaign.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: settings.name, dailyBudget: parseFloat(settings.dailyBudget) || undefined, biddingStrategy: settings.biddingStrategy, status: settings.status }) }).then((x) => x.json())
      if (r?.error) throw new Error(r.error)
      setSettings((s) => ({ ...s, saving: false, msg: '✓ saved' }))
    } catch (e) { setSettings((s) => ({ ...s, saving: false, msg: (e as Error).message })) }
  }
  const submitNegative = async () => {
    if (!negForm.value.trim()) { setNegForm((f) => ({ ...f, msg: 'Value required' })); return }
    setNegForm((f) => ({ ...f, saving: true, msg: '' }))
    try {
      if (negForm.kind === 'ASIN') {
        if (!negForm.adGroupId) throw new Error('Pick an ad group')
        const r = await fetch(`${getBackendUrl()}/api/advertising/negative-targets/create`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ adGroupId: negForm.adGroupId, asin: negForm.value.trim() }) }).then((x) => x.json())
        if (r?.error) throw new Error(r.error)
      } else {
        if (!campaign.externalCampaignId) throw new Error('Campaign not synced')
        const r = await fetch(`${getBackendUrl()}/api/advertising/negative-keywords/create`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ externalCampaignId: campaign.externalCampaignId, keywordText: negForm.value.trim(), matchType: negForm.match, scope: 'CAMPAIGN' }) }).then((x) => x.json())
        if (r?.error) throw new Error(r.error)
      }
      setAddedNegs((n) => [{ kind: negForm.kind, value: negForm.value.trim(), match: negForm.kind === 'KEYWORD' ? negForm.match : undefined }, ...n])
      setNegForm((f) => ({ ...f, value: '', saving: false, msg: '✓ added' }))
    } catch (e) { setNegForm((f) => ({ ...f, saving: false, msg: (e as Error).message })) }
  }

  const TABS: Array<[Tab, string, number]> = [
    ['adgroups', 'Ad groups', campaign.adGroups.length],
    ['targeting', 'Targeting', targets.filter((t) => !t.expressionValue.startsWith('NOT ')).length],
    ['searchterms', 'Search terms', searchTerms?.length ?? 0],
    ['bidadjust', 'Bid adjustments', 0],
    ['negatives', 'Negative targeting', addedNegs.length],
    ['settings', 'Campaign settings', 0],
    ['history', 'History', history.length],
  ]

  return (
    <div className="px-4 py-4">
      <Link href="/marketing/advertising/campaigns" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 mb-2"><ChevronLeft size={14} /> All campaigns</Link>
      <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">{campaign.name}</h1>
      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 mt-1 mb-3">
        <StatusChip status={campaign.status} />
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
                    <option value="PRODUCT">Product (ASIN)</option><option value="CATEGORY">Category</option><option value="AUTO">Auto-targeting</option><option value="AUDIENCE">Audience (SD)</option><option value="NEGATIVE">Negative ASIN</option>
                  </select></label>
                {tForm.kind === 'AUDIENCE' && (
                  <label className="flex flex-col text-[11px] text-slate-500">Audience type
                    <select value={tForm.audType} onChange={(e) => setTForm((f) => ({ ...f, audType: e.target.value }))} className="mt-0.5 px-2 py-1 text-sm rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900">
                      <option value="AUDIENCE">Amazon audience (in-market / lifestyle / interests)</option><option value="VIEWS_REMARKETING">Views remarketing</option><option value="PURCHASES_REMARKETING">Purchases remarketing</option>
                    </select></label>
                )}
                {tForm.kind === 'AUTO' ? (
                  <label className="flex flex-col text-[11px] text-slate-500">Match
                    <select value={tForm.auto} onChange={(e) => setTForm((f) => ({ ...f, auto: e.target.value }))} className="mt-0.5 px-2 py-1 text-sm rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900">
                      <option value="CLOSE_MATCH">Close match</option><option value="LOOSE_MATCH">Loose match</option><option value="SUBSTITUTES">Substitutes</option><option value="COMPLEMENTS">Complements</option>
                    </select></label>
                ) : (
                  <label className="flex flex-col text-[11px] text-slate-500">{tForm.kind === 'CATEGORY' ? 'Category id' : tForm.kind === 'AUDIENCE' ? (tForm.audType === 'AUDIENCE' ? 'Audience id' : 'ASIN / category') : 'ASIN'}
                    <input value={tForm.value} onChange={(e) => setTForm((f) => ({ ...f, value: e.target.value }))} placeholder={tForm.kind === 'CATEGORY' ? 'e.g. 12345678011' : tForm.kind === 'AUDIENCE' && tForm.audType === 'AUDIENCE' ? 'audienceId' : 'B0XXXXXXXX'} className="mt-0.5 px-2 py-1 text-sm rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 w-36" /></label>
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
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">{searchTerms.length === 0 ? <tr><td colSpan={8} className="px-3 py-6 text-center text-slate-400 text-xs">No search-term data yet (run the search-terms report cycle).</td></tr> : searchTerms.map((s, i) => <tr key={i} className="hover:bg-slate-50 dark:hover:bg-slate-900/40"><td className="px-3 py-1.5">{String(s.query ?? '')}</td><td className="px-3 py-1.5 text-xs text-slate-500">{String(s.matchType ?? '')}</td><td className="px-3 py-1.5 text-right tabular-nums">{num(Number(s.impressions ?? 0))}</td><td className="px-3 py-1.5 text-right tabular-nums">{num(Number(s.clicks ?? 0))}</td><td className="px-3 py-1.5 text-right tabular-nums">{eur(Number(s.costMicros ?? 0) / 10000)}</td><td className="px-3 py-1.5 text-right tabular-nums">{num(Number(s.orders7d ?? 0))}</td><td className="px-3 py-1.5 text-right tabular-nums">{eur(Number(s.sales7dCents ?? 0))}</td><td className="px-3 py-1.5 text-right"><div className="inline-flex items-center gap-1 text-xs">{(['EXACT', 'PHRASE', 'BROAD'] as const).map((m) => <button key={m} disabled={stAddBusy === String(s.query ?? '') + m} onClick={() => addSearchTermAs(String(s.query ?? ''), m)} title={`Add as ${m.toLowerCase()} keyword`} className="px-1 text-blue-600 hover:underline disabled:opacity-40">{m[0]}</button>)}<button onClick={() => addSearchTermAs(String(s.query ?? ''), 'NEGATIVE')} className="px-1 text-rose-600 hover:underline">⊘</button></div></td></tr>)}</tbody></table>
        )}
        {tab === 'negatives' && (<>
          <div className="border-b border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-900/40 px-3 py-2 flex flex-wrap items-end gap-2">
            <label className="flex flex-col text-[11px] text-slate-500">Type
              <select value={negForm.kind} onChange={(e) => setNegForm((f) => ({ ...f, kind: e.target.value as 'KEYWORD' | 'ASIN' }))} className="mt-0.5 px-2 py-1 text-sm rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"><option value="KEYWORD">Negative keyword</option><option value="ASIN">Negative product (ASIN)</option></select></label>
            {negForm.kind === 'KEYWORD' ? (
              <label className="flex flex-col text-[11px] text-slate-500">Match
                <select value={negForm.match} onChange={(e) => setNegForm((f) => ({ ...f, match: e.target.value }))} className="mt-0.5 px-2 py-1 text-sm rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"><option value="NEGATIVE_EXACT">Negative exact</option><option value="NEGATIVE_PHRASE">Negative phrase</option></select></label>
            ) : (
              <label className="flex flex-col text-[11px] text-slate-500">Ad group
                <select value={negForm.adGroupId} onChange={(e) => setNegForm((f) => ({ ...f, adGroupId: e.target.value }))} className="mt-0.5 px-2 py-1 text-sm rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 min-w-[9rem]">{campaign.adGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</select></label>
            )}
            <label className="flex flex-col text-[11px] text-slate-500">{negForm.kind === 'KEYWORD' ? 'Keyword' : 'ASIN'}
              <input value={negForm.value} onChange={(e) => setNegForm((f) => ({ ...f, value: e.target.value }))} placeholder={negForm.kind === 'KEYWORD' ? 'e.g. damen' : 'B0XXXXXXXX'} className="mt-0.5 px-2 py-1 text-sm rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 w-44" /></label>
            <button onClick={submitNegative} disabled={negForm.saving} className="px-3 py-1 text-sm rounded bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-50">{negForm.saving ? 'Adding…' : 'Add negative'}</button>
            {negForm.msg && <span className={`text-xs ${negForm.msg.startsWith('✓') ? 'text-emerald-600' : 'text-rose-600'}`}>{negForm.msg}</span>}
          </div>
          <table className="w-full text-sm"><thead className="bg-slate-50 dark:bg-slate-900/60 text-xs text-slate-500"><tr><th className="text-left px-3 py-2">Negative</th><th className="text-left px-3 py-2">Type</th><th className="text-left px-3 py-2">Match</th></tr></thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">{addedNegs.length === 0 ? <tr><td colSpan={3} className="px-3 py-6 text-center text-slate-400 text-xs">Add negative keywords or products to stop wasted impressions on irrelevant searches.</td></tr> : addedNegs.map((n, i) => <tr key={i}><td className="px-3 py-1.5">{n.value}</td><td className="px-3 py-1.5 text-xs text-slate-500">{n.kind === 'ASIN' ? 'Product' : 'Keyword'}</td><td className="px-3 py-1.5 text-xs text-slate-500">{n.match?.replace('NEGATIVE_', '').toLowerCase() ?? '—'}</td></tr>)}</tbody></table>
        </>)}
        {tab === 'settings' && (
          <div className="p-4 max-w-[640px] space-y-3">
            <label className="block text-xs text-slate-500">Campaign name<input value={settings.name} onChange={(e) => setSettings((s) => ({ ...s, name: e.target.value }))} className="w-full mt-0.5 px-2 py-1.5 text-sm rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950" /></label>
            <div className="flex gap-2">
              <label className="flex-1 text-xs text-slate-500">Daily budget €<input type="number" step="0.01" value={settings.dailyBudget} onChange={(e) => setSettings((s) => ({ ...s, dailyBudget: e.target.value }))} className="w-full mt-0.5 px-2 py-1.5 text-sm rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950" /></label>
              <label className="flex-1 text-xs text-slate-500">Bidding strategy<select value={settings.biddingStrategy} onChange={(e) => setSettings((s) => ({ ...s, biddingStrategy: e.target.value }))} className="w-full mt-0.5 px-2 py-1.5 text-sm rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"><option value="legacyForSales">Dynamic bids — down only</option><option value="autoForSales">Dynamic bids — up and down</option><option value="manual">Fixed bids</option></select></label>
              <label className="flex-1 text-xs text-slate-500">Status<select value={settings.status} onChange={(e) => setSettings((s) => ({ ...s, status: e.target.value }))} className="w-full mt-0.5 px-2 py-1.5 text-sm rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"><option value="ENABLED">Active</option><option value="PAUSED">Paused</option><option value="ARCHIVED">Archived</option></select></label>
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-slate-500 pt-1">
              <div><dt className="inline text-slate-400">Type:</dt> <dd className="inline">{campaign.type}</dd></div>
              <div><dt className="inline text-slate-400">Marketplace:</dt> <dd className="inline">{campaign.marketplace ?? '—'}</dd></div>
              <div><dt className="inline text-slate-400">Campaign ID:</dt> <dd className="inline font-mono">{campaign.externalCampaignId ?? '—'}</dd></div>
              <div><dt className="inline text-slate-400">Schedule:</dt> <dd className="inline">{campaign.startDate?.slice(0, 10) ?? '—'} → {campaign.endDate?.slice(0, 10) ?? 'no end'}</dd></div>
            </dl>
            <div className="flex items-center gap-3 pt-1">
              <button onClick={saveSettings} disabled={settings.saving} className="px-3 py-1.5 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">{settings.saving ? 'Saving…' : 'Save settings'}</button>
              {settings.msg && <span className={`text-sm ${settings.msg.startsWith('✓') ? 'text-emerald-700 dark:text-emerald-300' : 'text-rose-600'}`}>{settings.msg}</span>}
            </div>
          </div>
        )}
        {tab === 'bidadjust' && (
          placements == null ? <div className="p-6 text-center text-slate-400 text-sm">Loading…</div> :
          <><div className="border-b border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-900/40 px-3 py-3">
            <div className="flex flex-wrap items-end gap-3">
              <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Bid adjustments by placement</span>
              {([['PLACEMENT_TOP', 'Top of search'], ['PLACEMENT_PRODUCT_PAGE', 'Product pages'], ['PLACEMENT_REST_OF_SEARCH', 'Rest of search']] as const).map(([k, label]) => (
                <label key={k} className="flex flex-col text-[11px] text-slate-500">{label}
                  <span className="mt-0.5 inline-flex items-center gap-1"><input type="number" min="0" max="900" step="1" value={placeAdj[k]} onChange={(e) => setPlaceAdj((a) => ({ ...a, [k]: e.target.value }))} className="w-20 px-2 py-1 text-sm rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-right" /><span className="text-slate-400">%</span></span></label>
              ))}
              <label className="flex flex-col text-[11px] text-slate-500">Bidding strategy
                <select value={placeStrat} onChange={(e) => setPlaceStrat(e.target.value)} className="mt-0.5 px-2 py-1 text-sm rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900">
                  <option value="legacyForSales">Down only</option><option value="autoForSales">Up and down</option><option value="manual">Fixed</option>
                </select></label>
              <button onClick={savePlacements} disabled={placeSaving} className="px-3 py-1 text-sm rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">{placeSaving ? 'Saving…' : 'Save adjustments'}</button>
              {placeMsg && <span className={`text-xs ${placeMsg.startsWith('✓') ? 'text-emerald-600' : 'text-rose-600'}`}>{placeMsg}</span>}
            </div>
          </div>
          <table className="w-full text-sm"><thead className="bg-slate-50 dark:bg-slate-900/60 text-xs text-slate-500"><tr><th className="text-left px-3 py-2">Placement</th><th className="text-right px-3 py-2">Adjustment</th><th className="text-right px-3 py-2">Impr</th><th className="text-right px-3 py-2">Clicks</th><th className="text-right px-3 py-2">Cost</th><th className="text-right px-3 py-2">Orders</th></tr></thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">{placements.length === 0 ? <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-400 text-xs">No placement data yet.</td></tr> : placements.map((p, i) => <tr key={i} className="hover:bg-slate-50 dark:hover:bg-slate-900/40"><td className="px-3 py-1.5">{String(p.placement ?? '')}</td><td className="px-3 py-1.5 text-right tabular-nums">{Number(p.adjustmentPct ?? 0)}%</td><td className="px-3 py-1.5 text-right tabular-nums">{num(Number(p.impressions ?? 0))}</td><td className="px-3 py-1.5 text-right tabular-nums">{num(Number(p.clicks ?? 0))}</td><td className="px-3 py-1.5 text-right tabular-nums">{eur(Number(p.costMicros ?? 0) / 10000)}</td><td className="px-3 py-1.5 text-right tabular-nums">{num(Number(p.orders7d ?? 0))}</td></tr>)}</tbody></table></>
        )}
        {tab === 'history' && (
          <table className="w-full text-sm"><thead className="bg-slate-50 dark:bg-slate-900/60 text-xs text-slate-500"><tr><th className="text-left px-3 py-2">Field</th><th className="text-left px-3 py-2">Change</th><th className="text-left px-3 py-2">By</th><th className="text-right px-3 py-2">When</th></tr></thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">{history.length === 0 ? <tr><td colSpan={4} className="px-3 py-6 text-center text-slate-400 text-xs">No changes yet.</td></tr> : history.map((h) => <tr key={h.id}><td className="px-3 py-1.5">{h.field}</td><td className="px-3 py-1.5 text-xs">{h.oldValue ?? '—'} → <span className="font-medium">{h.newValue ?? '—'}</span></td><td className="px-3 py-1.5 text-xs text-slate-500">{h.changedBy}</td><td className="px-3 py-1.5 text-right text-xs text-slate-400">{new Date(h.changedAt).toLocaleString()}</td></tr>)}</tbody></table>
        )}
      </div>
    </div>
  )
}
