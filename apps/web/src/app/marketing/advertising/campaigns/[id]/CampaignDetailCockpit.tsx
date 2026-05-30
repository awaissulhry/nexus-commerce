'use client'

/**
 * AX.3 — Amazon-style campaign drill-down. Header (status/type/budget/
 * schedule + KPI tiles) + tabs: Ad groups · Targeting · Search terms ·
 * Placements · History. Targeting bids edit inline (PATCH
 * /advertising/targets/:id); search terms can be added as negatives
 * (existing create); placements read (writes land in AX.8). Search terms +
 * placements fetch lazily on tab open.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ChevronLeft, Check, Lightbulb, Copy } from 'lucide-react'
import { useMarketingEvents } from '@/lib/sync/use-marketing-events'
import { KpiStrip, type KpiTileSpec, BulkActionShell } from '@/app/_shared/grid-lens'
import { useColumnResize } from '@/app/_shared/useColumnResize'
import { Pause, Play, ChevronsUp, ChevronsDown, Ban, Plus, Search, Download } from 'lucide-react'
import { StatusChip } from '@/app/_shared/ads-ui'
import { CampaignTrendChart, type TrendRow } from './CampaignTrendChart'
import { CampaignBudgetPace } from './CampaignBudgetPace'
import { CampaignRecommendations } from './CampaignRecommendations'
import { CampaignHealth, type HealthFactor } from './CampaignHealth'
import { CampaignProfitLens } from './CampaignProfitLens'
import { CampaignCopyModal } from './CampaignCopyModal'
import { CampaignDayparting } from './CampaignDayparting'
import { Sparkline } from './Sparkline'

interface TrendSummary { impressions: number; clicks: number; orders: number; spendCents: number; salesCents: number; acos: number | null; roas: number | null; ctr: number | null }
import { getBackendUrl } from '@/lib/backend-url'
import { Megaphone, MousePointerClick, ShoppingCart, TrendingUp } from 'lucide-react'

interface Target { id: string; kind: string; expressionType: string; expressionValue: string; bidCents: number; status: string; impressions: number; clicks: number; spendCents: number; salesCents: number; isNegative?: boolean }
interface AdGroup { id: string; name: string; defaultBidCents: number; status: string; impressions: number; clicks: number; spendCents: number; salesCents: number; targets: Target[]; productAds: Array<{ id: string; asin: string | null; sku: string | null; productId: string | null; status: string }> }
export interface CampaignDetailData {
  id: string; name: string; type: string; status: string; marketplace: string | null; externalCampaignId: string | null
  dailyBudget: string; biddingStrategy: string; impressions: number; clicks: number; spend: string; sales: string
  acos: string | null; roas: string | null; trueProfitCents: number; trueProfitMarginPct: string | null
  lastSyncedAt?: string | null; lastSyncStatus?: string | null
  startDate?: string | null; endDate?: string | null; adGroups: AdGroup[]
}
export interface BidHistoryRow { id: string; entityType: string; field: string; oldValue: string | null; newValue: string | null; changedAt: string; changedBy: string; reason: string | null }

const eur = (c: number | null | undefined) => (c == null ? '—' : new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(c / 100))
const num = (n: number) => new Intl.NumberFormat('en-US').format(Math.round(n))
const pct = (v: number | null | undefined) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`)
const ago = (iso: string | null | undefined) => {
  if (!iso) return null
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

type Tab = 'adgroups' | 'targeting' | 'searchterms' | 'bidadjust' | 'dayparting' | 'negatives' | 'budgetrules' | 'settings' | 'history'

export function CampaignDetailCockpit({ campaign, history }: { campaign: CampaignDetailData; history: BidHistoryRow[] }) {
  const [tab, setTab] = useState<Tab>('adgroups')
  const [targets, setTargets] = useState<Target[]>(() => campaign.adGroups.flatMap((g) => g.targets.map((t) => ({ ...t }))))
  // AF.2 — negatives sync correctly (isNegative=true) but were rendered in the
  // Targeting tab. Split: positives in Targeting, negatives in Negative targeting.
  const positiveTargets = useMemo(() => targets.filter((t) => !t.isNegative), [targets])
  const ingestedNegatives = useMemo(() => targets.filter((t) => t.isNegative), [targets])
  const [bidEdit, setBidEdit] = useState<Record<string, string>>({})
  const [searchTerms, setSearchTerms] = useState<Array<Record<string, unknown>> | null>(null)
  const [placements, setPlacements] = useState<Array<Record<string, unknown>> | null>(null)
  const [placeTrend, setPlaceTrend] = useState<Record<string, number[]>>({})
  // CPC-ceiling guardrail (loaded with placements, saved via /cpc-ceiling).
  const [cpcCeiling, setCpcCeiling] = useState<{ enabled: boolean; multiple: number }>({ enabled: false, multiple: 1.5 })
  const [cpcSaving, setCpcSaving] = useState(false)
  const [cpcMsg, setCpcMsg] = useState('')
  const [clampMsg, setClampMsg] = useState('')
  // CD.7 — per-target suggested bid (data-grounded, from account CPC history).
  const [bidSug, setBidSug] = useState<Record<string, { suggestedBidCents: number; lowCents: number; highCents: number; basis: string } | 'loading' | 'none'>>({})
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
  // CD.8 — bulk selection on Targeting + Search-terms.
  const [selTargets, setSelTargets] = useState<Set<string>>(new Set())
  const [selTerms, setSelTerms] = useState<Set<string>>(new Set())
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkStatus, setBulkStatus] = useState<string | null>(null)
  const [copyOpen, setCopyOpen] = useState(false) // CD.10b
  const normStrategy = campaign.biddingStrategy?.toLowerCase().includes('auto') ? 'autoForSales' : campaign.biddingStrategy?.toLowerCase().includes('manual') ? 'manual' : 'legacyForSales'

  // AF.8 — resizable + persisted columns per Amazon Ads table.
  const agCols = useColumnResize('ads:campaign:adgroups', ['name', 'status', 'bid', 'targets', 'impr', 'clicks', 'spend', 'sales', 's14'], { name: 220, status: 110, bid: 90, targets: 80, impr: 90, clicks: 90, spend: 100, sales: 100, s14: 80 })
  const tgtCols = useColumnResize('ads:campaign:targeting', ['sel', 'target', 'match', 'bid', 'impr', 'clicks', 'spend', 'sales', 'acos', 's14'], { sel: 36, target: 240, match: 90, bid: 130, impr: 80, clicks: 80, spend: 90, sales: 90, acos: 80, s14: 80 })
  const stCols = useColumnResize('ads:campaign:searchterms', ['sel', 'query', 'match', 'impr', 'clicks', 'spend', 'orders', 'sales', 'act'], { sel: 36, query: 260, match: 90, impr: 80, clicks: 80, spend: 90, orders: 80, sales: 90, act: 120 })
  const negCols = useColumnResize('ads:campaign:negatives', ['neg', 'type', 'match'], { neg: 280, type: 120, match: 140 })
  const plCols = useColumnResize('ads:campaign:placements', ['placement', 'adj', 'impr', 'clicks', 'cost', 'orders', 's14'], { placement: 220, adj: 110, impr: 90, clicks: 90, cost: 100, orders: 90, s14: 80 })
  const histCols = useColumnResize('ads:campaign:history', ['field', 'change', 'by', 'when'], { field: 160, change: 280, by: 140, when: 180 })

  // CD.1/CD.2 — campaign-scoped windowed trends + period-over-period compare.
  // The single fetch powers both the chart (rows) and the windowed KPI tiles
  // (summary + previous → ▲/▼ deltas). Defaults to 30d; window selector lives
  // on the chart and is shared here.
  const [windowDays, setWindowDays] = useState(30)
  const [trendRows, setTrendRows] = useState<TrendRow[] | null>(null)
  const [trendSummary, setTrendSummary] = useState<TrendSummary | null>(null)
  const [trendPrev, setTrendPrev] = useState<TrendSummary | null>(null)
  const [trendLoading, setTrendLoading] = useState(true)
  const loadTrends = useCallback(async () => {
    setTrendLoading(true)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/trends?campaignId=${campaign.id}&windowDays=${windowDays}&compare=true`, { cache: 'no-store' })
        .then((x) => x.json()).catch(() => ({ rows: [] }))
      setTrendRows(r.rows ?? [])
      setTrendSummary(r.summary ?? null)
      setTrendPrev(r.previous ?? null)
    } finally { setTrendLoading(false) }
  }, [campaign.id, windowDays])
  useEffect(() => { void loadTrends() }, [loadTrends])

  // AME.5 — ad-group rows track the chart window so the table never disagrees
  // with the KPI chart. Seeded from the server prop (windowDays 30 default);
  // refetched live from the daily-derived detail endpoint when the window changes.
  const [adGroups, setAdGroups] = useState(campaign.adGroups)
  // AME.7 — ad-groups table toolbar (search + export).
  const [agSearch, setAgSearch] = useState('')
  const visibleAgs = useMemo(() => {
    const q = agSearch.trim().toLowerCase()
    return q ? adGroups.filter((g) => g.name.toLowerCase().includes(q)) : adGroups
  }, [adGroups, agSearch])
  const exportAgsCsv = useCallback(() => {
    const head = ['Ad group', 'Status', 'DefaultBid', 'Targets', 'Impr', 'Clicks', 'Spend', 'Sales']
    const rows = visibleAgs.map((g) => [g.name, g.status, (g.defaultBidCents / 100).toFixed(2), g.targets.length, g.impressions, g.clicks, (g.spendCents / 100).toFixed(2), (g.salesCents / 100).toFixed(2)])
    const csv = [head, ...rows].map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
    const a = document.createElement('a'); a.href = url; a.download = `campaign-${campaign.id}-adgroups.csv`; a.click(); URL.revokeObjectURL(url)
  }, [visibleAgs, campaign.id])
  const firstWindowRef = useRef(true)
  useEffect(() => {
    if (firstWindowRef.current) { firstWindowRef.current = false; return }
    let alive = true
    void fetch(`${getBackendUrl()}/api/advertising/campaigns/${campaign.id}?windowDays=${windowDays}`, { cache: 'no-store' })
      .then((x) => x.json()).then((d) => { if (alive && d?.campaign?.adGroups) setAdGroups(d.campaign.adGroups) }).catch(() => {})
    return () => { alive = false }
  }, [campaign.id, windowDays])

  // CD.6 — per-entity sparklines (trailing 14d spend) for the ad-group + target
  // tables, fetched in two batched round-trips and refreshed on live events.
  const [agSparks, setAgSparks] = useState<Record<string, number[]>>({})
  const [tgtSparks, setTgtSparks] = useState<Record<string, number[]>>({})
  const loadSparks = useCallback(async () => {
    const base = `${getBackendUrl()}/api/advertising/trends/sparklines?campaignId=${campaign.id}&metric=spend&windowDays=14`
    const [ag, tg] = await Promise.all([
      fetch(`${base}&entityType=AD_GROUP`, { cache: 'no-store' }).then((x) => x.json()).catch(() => ({ series: {} })),
      fetch(`${base}&entityType=AD_TARGET`, { cache: 'no-store' }).then((x) => x.json()).catch(() => ({ series: {} })),
    ])
    setAgSparks(ag.series ?? {})
    setTgtSparks(tg.series ?? {})
  }, [campaign.id])
  useEffect(() => { void loadSparks() }, [loadSparks])

  // CD.3 — live updates. The marketing-events SSE bus fires when this
  // campaign mutates, its metrics refresh, a budget rebalances, or a rule
  // executes. On any of those: refresh server data (campaign + history),
  // reload the windowed trends, and invalidate the lazy tab caches (setting
  // them null makes the open tab re-fetch via the load effect below). A
  // "Live" badge flashes so the operator knows data is current.
  const router = useRouter()
  const [liveTs, setLiveTs] = useState<number | null>(null)
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onLiveEvent = useCallback(() => {
    router.refresh()
    void loadTrends()
    void loadSparks()
    setSearchTerms(null)
    setPlacements(null)
    setLiveTs(Date.now())
    if (flashTimer.current) clearTimeout(flashTimer.current)
    flashTimer.current = setTimeout(() => setLiveTs(null), 4000)
  }, [router, loadTrends, loadSparks])
  useMarketingEvents(onLiveEvent)
  useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current) }, [])

  // Lifetime fallbacks (used until the windowed summary lands).
  const lifeSpendC = Math.round(parseFloat(campaign.spend || '0') * 100), lifeSalesC = Math.round(parseFloat(campaign.sales || '0') * 100)
  const sm = trendSummary
  const impr = sm?.impressions ?? campaign.impressions
  const clk = sm?.clicks ?? campaign.clicks
  const spendC = sm?.spendCents ?? lifeSpendC
  const salesC = sm?.salesCents ?? lifeSalesC
  const acos = sm?.acos != null ? sm.acos / 100 : campaign.acos != null ? parseFloat(campaign.acos) : salesC > 0 ? spendC / salesC : null
  const roas = sm?.roas != null ? sm.roas : campaign.roas != null ? parseFloat(campaign.roas) : spendC > 0 ? salesC / spendC : null
  const dPct = (cur: number, prev: number | undefined | null) => (prev != null && prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : null)
  const tiles: KpiTileSpec[] = [
    { icon: Megaphone, label: 'Impressions', value: num(impr), tone: 'slate', detail: `CTR ${pct(impr ? clk / impr : null)}`, ...(trendPrev ? { delta: { pct: dPct(impr, trendPrev.impressions), good: (dPct(impr, trendPrev.impressions) ?? 0) >= 0 } } : {}) },
    { icon: MousePointerClick, label: 'Clicks', value: num(clk), tone: 'blue', detail: `CPC ${eur(clk ? spendC / clk : null)}`, ...(trendPrev ? { delta: { pct: dPct(clk, trendPrev.clicks), good: (dPct(clk, trendPrev.clicks) ?? 0) >= 0 } } : {}) },
    { icon: ShoppingCart, label: 'Spend', value: eur(spendC), tone: 'amber', detail: `ACOS ${pct(acos)}`, ...(trendPrev ? { delta: { pct: dPct(spendC, trendPrev.spendCents), good: (dPct(spendC, trendPrev.spendCents) ?? 0) <= 0 } } : {}) },
    { icon: TrendingUp, label: 'Sales', value: eur(salesC), tone: 'violet', detail: `ROAS ${roas != null ? roas.toFixed(2) + '×' : '—'}`, ...(trendPrev ? { delta: { pct: dPct(salesC, trendPrev.salesCents), good: (dPct(salesC, trendPrev.salesCents) ?? 0) >= 0 } } : {}) },
  ]

  // CD.9 — health score from signals already on hand. Transparent, weighted
  // penalties; each factor surfaces as a chip with its detail.
  const { healthScore, healthFactors } = (() => {
    const factors: HealthFactor[] = []
    let s = 100
    const acosPct = sm?.acos ?? null
    if (acosPct == null) {
      if (spendC > 0) { s -= 45; factors.push({ label: 'ACOS', status: 'bad', detail: 'spend, no sales' }) }
      else factors.push({ label: 'ACOS', status: 'warn', detail: 'no spend yet' })
    } else if (acosPct <= 15) factors.push({ label: 'ACOS', status: 'good', detail: `${acosPct.toFixed(0)}%` })
    else if (acosPct <= 25) { s -= 5; factors.push({ label: 'ACOS', status: 'good', detail: `${acosPct.toFixed(0)}%` }) }
    else if (acosPct <= 35) { s -= 15; factors.push({ label: 'ACOS', status: 'warn', detail: `${acosPct.toFixed(0)}%` }) }
    else if (acosPct <= 50) { s -= 30; factors.push({ label: 'ACOS', status: 'warn', detail: `${acosPct.toFixed(0)}%` }) }
    else { s -= 45; factors.push({ label: 'ACOS', status: 'bad', detail: `${acosPct.toFixed(0)}%` }) }

    const pm = campaign.trueProfitMarginPct != null ? parseFloat(campaign.trueProfitMarginPct) : null
    if (pm != null) {
      if (pm < 0) { s -= 20; factors.push({ label: 'Profit', status: 'bad', detail: `${pm.toFixed(0)}% margin` }) }
      else factors.push({ label: 'Profit', status: 'good', detail: `${pm.toFixed(0)}% margin` })
    }

    if (campaign.lastSyncedAt) {
      const days = (Date.now() - new Date(campaign.lastSyncedAt).getTime()) / 86_400_000
      if (days > 2) { s -= 12; factors.push({ label: 'Sync', status: 'warn', detail: `${Math.round(days)}d ago` }) }
      else factors.push({ label: 'Sync', status: 'good', detail: 'fresh' })
    } else { s -= 8; factors.push({ label: 'Sync', status: 'warn', detail: 'never synced' }) }

    const ctrPct = sm?.ctr ?? null
    if (ctrPct != null && ctrPct < 0.15 && impr > 500) { s -= 8; factors.push({ label: 'CTR', status: 'warn', detail: `${ctrPct.toFixed(2)}%` }) }
    else if (ctrPct != null) factors.push({ label: 'CTR', status: 'good', detail: `${ctrPct.toFixed(2)}%` })

    const budgetCents = Math.round(parseFloat(campaign.dailyBudget || '0') * 100)
    if (budgetCents > 0 && trendRows && trendRows.length > 0) {
      const constrained = trendRows.filter((r) => r.adSpendCents >= budgetCents * 0.95).length
      if (constrained >= Math.max(2, Math.ceil(trendRows.length * 0.3))) { s -= 10; factors.push({ label: 'Budget', status: 'warn', detail: `capped ${constrained}/${trendRows.length}d` }) }
    }
    return { healthScore: Math.max(0, Math.min(100, s)), healthFactors: factors }
  })()

  const loadSearchTerms = useCallback(async () => {
    if (searchTerms != null) return
    const r = await fetch(`${getBackendUrl()}/api/advertising/reports/search-terms?campaignId=${campaign.externalCampaignId ?? ''}&limit=200`, { cache: 'no-store' }).then((x) => x.json()).catch(() => ({ items: [] }))
    setSearchTerms(r.items ?? [])
  }, [searchTerms, campaign.externalCampaignId])
  const loadPlacements = useCallback(async () => {
    if (placements != null) return
    const r = await fetch(`${getBackendUrl()}/api/advertising/campaigns/${campaign.id}/placements?windowDays=14`, { cache: 'no-store' }).then((x) => x.json()).catch(() => ({ placements: [] }))
    setPlacements(r.placements ?? [])
    setPlaceTrend(r.trend?.series ?? {})
    if (r.cpcCeiling) setCpcCeiling({ enabled: !!r.cpcCeiling.enabled, multiple: Number(r.cpcCeiling.multiple) || 1.5 })
    const seed: Record<string, string> = {}
    for (const p of (r.placements ?? []) as Array<Record<string, unknown>>) { const k = String(p.placement ?? ''); if (k in placeAdj && Number(p.adjustmentPct) > 0) seed[k] = String(p.adjustmentPct) }
    if (Object.keys(seed).length) setPlaceAdj((a) => ({ ...a, ...seed }))
  }, [placements, campaign.id, placeAdj])
  // CD.7 — fetch a data-grounded suggested bid for a target (uses the account's
  // historical CPC via /advertising/bid-suggestions) and open the bid editor
  // pre-filled with it. No fabricated elasticity; the bidding-engine dry-run
  // path is wired once that microservice is deployed.
  const suggestBid = useCallback(async (t: Target) => {
    setBidSug((s) => ({ ...s, [t.id]: 'loading' }))
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/bid-suggestions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keywords: [t.expressionValue], matchType: t.expressionType, marketplace: campaign.marketplace }) }).then((x) => x.json())
      const sug = r?.suggestions?.[0]
      if (sug?.suggestedBidCents) {
        setBidSug((s) => ({ ...s, [t.id]: { suggestedBidCents: sug.suggestedBidCents, lowCents: sug.lowCents, highCents: sug.highCents, basis: sug.basis } }))
        setBidEdit((e) => ({ ...e, [t.id]: (sug.suggestedBidCents / 100).toFixed(2) }))
      } else setBidSug((s) => ({ ...s, [t.id]: 'none' }))
    } catch { setBidSug((s) => ({ ...s, [t.id]: 'none' })) }
  }, [campaign.marketplace])
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
  const saveCpcCeiling = async () => {
    setCpcSaving(true); setCpcMsg('')
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/campaigns/${campaign.id}/cpc-ceiling`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: cpcCeiling.enabled, multiple: cpcCeiling.multiple }) }).then((x) => x.json())
      if (r?.error) throw new Error(r.error)
      setCpcMsg('✓ saved')
    } catch (e) { setCpcMsg((e as Error).message) } finally { setCpcSaving(false) }
  }

  const saveBid = async (t: Target) => {
    const v = bidEdit[t.id]; if (v == null) return
    const cents = Math.round(parseFloat(v) * 100); if (!Number.isFinite(cents) || cents < 5) return
    setBusy(t.id)
    try {
      // Canonical audited route is /ad-targets/:id (the old /targets/:id PATCH
      // was a 404 — pre-existing AX.3 bug fixed in CD.8). The route may clamp
      // the bid to the campaign's CPC ceiling and return cpcClamp.
      const r = await fetch(`${getBackendUrl()}/api/advertising/ad-targets/${t.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bidCents: cents }) }).then((x) => x.json()).catch(() => ({}))
      const effective = r?.cpcClamp?.to ?? cents
      setTargets((ts) => ts.map((x) => (x.id === t.id ? { ...x, bidCents: effective } : x)))
      setBidEdit((e) => { const { [t.id]: _, ...rest } = e; return rest })
      if (r?.cpcClamp) { setClampMsg(`Bid capped at ${eur(effective)} by CPC ceiling`); setTimeout(() => setClampMsg(''), 5000) }
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
  // CD.8 — bulk target status (loop the audited /ad-targets/:id PATCH).
  const bulkTargetStatus = async (status: 'ENABLED' | 'PAUSED') => {
    const ids = [...selTargets]; if (!ids.length) return
    setBulkBusy(true); setBulkStatus(null)
    let ok = 0, fail = 0
    for (const id of ids) {
      try {
        const r = await fetch(`${getBackendUrl()}/api/advertising/ad-targets/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) }).then((x) => x.json())
        if (r?.ok === false) fail++; else { ok++; setTargets((ts) => ts.map((x) => (x.id === id ? { ...x, status } : x))) }
      } catch { fail++ }
      setBulkStatus(`${ok + fail}/${ids.length}…`)
    }
    setBulkBusy(false); setBulkStatus(`✓ ${ok} updated${fail ? ` · ${fail} failed` : ''}`)
    setSelTargets(new Set())
  }
  // CD.8 — bulk bid adjust via the audited /ad-targets/bulk-bid endpoint.
  const bulkTargetBid = async (factor: number) => {
    const ids = [...selTargets]; if (!ids.length) return
    setBulkBusy(true); setBulkStatus(null)
    const entries = targets.filter((t) => selTargets.has(t.id)).map((t) => ({ adTargetId: t.id, bidCents: Math.max(5, Math.round(t.bidCents * factor)) }))
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/ad-targets/bulk-bid`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entries, reason: `bulk ${factor > 1 ? '+' : '−'}${Math.abs(Math.round((factor - 1) * 100))}%` }) }).then((x) => x.json())
      if (r?.ok === false) throw new Error(r.error)
      const clamps: Array<{ adTargetId: string; to: number }> = r?.cpcClamps ?? []
      const clampTo = new Map(clamps.map((c) => [c.adTargetId, c.to]))
      setTargets((ts) => ts.map((x) => { const e = entries.find((n) => n.adTargetId === x.id); return e ? { ...x, bidCents: clampTo.get(x.id) ?? e.bidCents } : x }))
      setBulkStatus(`✓ ${entries.length} bids updated${clamps.length ? ` · ${clamps.length} capped by CPC ceiling` : ''}`)
    } catch (e) { setBulkStatus((e as Error).message) } finally { setBulkBusy(false); setSelTargets(new Set()) }
  }
  // CD.8 — bulk search-term actions (reuse the single-row handlers).
  const bulkTermAction = async (as: 'NEGATIVE' | 'EXACT') => {
    const qs = [...selTerms]; if (!qs.length) return
    setBulkBusy(true); setBulkStatus(null)
    let done = 0
    for (const q of qs) { await addSearchTermAs(q, as); done++; setBulkStatus(`${done}/${qs.length}…`) }
    setBulkBusy(false); setBulkStatus(`✓ ${done} ${as === 'NEGATIVE' ? 'negated' : 'promoted to exact'}`)
    setSelTerms(new Set())
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

  // AME.5 — Amazon-parity left-nav, grouped. "Manage" mirrors Seller Central's
  // campaign rail; "Insights & tools" keeps our value-add panels (Amazon nests
  // targeting/search-terms under the ad group — surfaced here + in the ad-group
  // detail page).
  const NAV: Array<{ group: string; items: Array<[Tab, string, number]> }> = [
    { group: 'Manage', items: [
      ['adgroups', 'Ad groups', adGroups.length],
      ['bidadjust', 'Bid adjustments', 0],
      ['negatives', 'Negative targeting', ingestedNegatives.length + addedNegs.length],
      ['budgetrules', 'Budget rules', 0],
      ['settings', 'Campaign settings', 0],
      ['history', 'History', history.length],
    ] },
    { group: 'Insights & tools', items: [
      ['targeting', 'Targeting', positiveTargets.length],
      ['searchterms', 'Search terms', searchTerms?.length ?? 0],
      ['dayparting', 'Dayparting', 0],
    ] },
  ]

  return (
    <div className="px-4 py-4">
      <Link href="/marketing/advertising/campaigns" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 mb-2"><ChevronLeft size={14} /> All campaigns</Link>
      <div className="flex items-start justify-between gap-3">
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">{campaign.name}</h1>
        <button onClick={() => setCopyOpen(true)} className="inline-flex items-center gap-1 px-2.5 py-1 text-sm rounded-md border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-900 flex-shrink-0"><Copy size={13} /> Copy settings to…</button>
      </div>
      {copyOpen && <CampaignCopyModal sourceId={campaign.id} sourceName={campaign.name} marketplace={campaign.marketplace} biddingStrategy={normStrategy} dailyBudget={parseFloat(campaign.dailyBudget || '0')} onClose={() => setCopyOpen(false)} />}
      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 mt-1 mb-3">
        <StatusChip status={campaign.status} />
        <span>{campaign.type}</span><span>·</span><span>{campaign.marketplace ?? '—'}</span><span>·</span>
        <span>Budget {eur(Math.round(parseFloat(campaign.dailyBudget || '0') * 100))}/d</span><span>·</span>
        <span>{campaign.biddingStrategy}</span>
        {campaign.startDate && <><span>·</span><span>{campaign.startDate.slice(0, 10)} → {campaign.endDate?.slice(0, 10) ?? 'no end'}</span></>}
        <span className="ml-auto inline-flex items-center gap-1.5">
          <span className={`inline-flex h-2 w-2 rounded-full ${liveTs ? 'bg-emerald-500 animate-pulse' : 'bg-emerald-500/70'}`} />
          <span className="text-emerald-600 dark:text-emerald-400 font-medium">{liveTs ? 'Updated just now' : 'Live'}</span>
          {campaign.lastSyncedAt && !liveTs && (
            <span className="text-slate-400" title={`Last sync: ${new Date(campaign.lastSyncedAt).toLocaleString()}${campaign.lastSyncStatus ? ` · ${campaign.lastSyncStatus}` : ''}`}>· synced {ago(campaign.lastSyncedAt)}</span>
          )}
        </span>
      </div>
      <div className="flex gap-5 items-start mt-1">
        {/* AME.5 — Amazon-parity vertical left nav (replaces the horizontal
            scrolling tab bar). Sticky so it stays in view while scrolling. */}
        <nav aria-label="Campaign sections" className="w-52 flex-shrink-0 sticky top-4 space-y-3">
          {NAV.map((grp) => (
            <div key={grp.group}>
              <div className="px-2.5 pb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">{grp.group}</div>
              <div className="space-y-0.5">
                {grp.items.map(([k, label, n]) => (
                  <button
                    key={k}
                    onClick={() => setTab(k)}
                    aria-current={tab === k ? 'page' : undefined}
                    className={`w-full text-left px-2.5 py-1.5 text-sm rounded-md flex items-center justify-between transition ${tab === k ? 'bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300 font-medium' : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800/70'}`}
                  >
                    <span>{label}</span>{n > 0 ? <span className="text-xs text-slate-400 tabular-nums">{n}</span> : null}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </nav>

        <div className="flex-1 min-w-0">
          {/* KPI chart header — Amazon-style (metric tiles + windowed line chart). */}
          <KpiStrip tiles={tiles} className="mb-3" />
          <CampaignTrendChart rows={trendRows} windowDays={windowDays} onWindowChange={setWindowDays} loading={trendLoading} />
          {tab === 'adgroups' && (<>
            <CampaignRecommendations campaignId={campaign.id} onNegate={addNegative} onGoToTab={(t) => setTab(t)} refreshKey={liveTs ?? 0} />
            <CampaignHealth score={healthScore} factors={healthFactors} marketplace={campaign.marketplace} refreshKey={liveTs ?? 0} />
            <CampaignProfitLens trueProfitCents={campaign.trueProfitCents} trueProfitMarginPct={campaign.trueProfitMarginPct} lifetimeSpendCents={lifeSpendC} />
          </>)}

          {clampMsg && <div className="my-2 px-3 py-1.5 text-xs rounded-md text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900">{clampMsg}</div>}
          {/* AF.4 — overflow-x-auto contains a wide table to THIS box; without it
              the table overflowed and scrolled the whole page (AME.5 regression). */}
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 mt-3 overflow-x-auto">
        {tab === 'adgroups' && (<>
          <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-900/40">
            <div className="relative">
              <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
              <input value={agSearch} onChange={(e) => setAgSearch(e.target.value)} placeholder="Find an ad group" aria-label="Find an ad group" className="pl-7 pr-2 py-1 text-sm rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 w-52" />
            </div>
            <span className="ml-auto text-xs text-slate-400 tabular-nums">{visibleAgs.length} of {adGroups.length}</span>
            <button onClick={exportAgsCsv} className="inline-flex items-center gap-1 px-2.5 py-1 text-sm rounded-md border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800"><Download size={13} /> Export</button>
          </div>
          <table className="min-w-full text-sm" style={{ tableLayout: 'fixed', width: 'max-content' }}><thead className="bg-slate-50 dark:bg-slate-900/60 text-xs text-slate-500"><tr><th {...agCols.thProps('name')} className="text-left px-3 py-2">Ad group<agCols.ResizeHandle col="name" /></th><th {...agCols.thProps('status')} className="text-left px-3 py-2">Status<agCols.ResizeHandle col="status" /></th><th {...agCols.thProps('bid')} className="text-right px-3 py-2">Default bid<agCols.ResizeHandle col="bid" /></th><th {...agCols.thProps('targets')} className="text-right px-3 py-2">Targets<agCols.ResizeHandle col="targets" /></th><th {...agCols.thProps('impr')} className="text-right px-3 py-2">Impr<agCols.ResizeHandle col="impr" /></th><th {...agCols.thProps('clicks')} className="text-right px-3 py-2">Clicks<agCols.ResizeHandle col="clicks" /></th><th {...agCols.thProps('spend')} className="text-right px-3 py-2">Spend<agCols.ResizeHandle col="spend" /></th><th {...agCols.thProps('sales')} className="text-right px-3 py-2">Sales<agCols.ResizeHandle col="sales" /></th><th {...agCols.thProps('s14')} className="text-right px-3 py-2">14d<agCols.ResizeHandle col="s14" /></th></tr></thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">{visibleAgs.length === 0 ? <tr><td colSpan={9} className="px-3 py-8 text-center text-slate-400 text-xs">No ad groups match.</td></tr> : visibleAgs.map((g) => <tr key={g.id} className="hover:bg-slate-50 dark:hover:bg-slate-900/40"><td className="px-3 py-1.5 font-medium"><Link href={`/marketing/advertising/campaigns/${campaign.id}/ad-groups/${g.id}`} className="text-blue-600 dark:text-blue-400 hover:underline">{g.name}</Link></td><td className="px-3 py-1.5"><StatusChip status={g.status} dot /></td><td className="px-3 py-1.5 text-right tabular-nums">{eur(g.defaultBidCents)}</td><td className="px-3 py-1.5 text-right tabular-nums">{g.targets.length}</td><td className="px-3 py-1.5 text-right tabular-nums">{num(g.impressions)}</td><td className="px-3 py-1.5 text-right tabular-nums">{num(g.clicks)}</td><td className="px-3 py-1.5 text-right tabular-nums">{eur(g.spendCents)}</td><td className="px-3 py-1.5 text-right tabular-nums">{eur(g.salesCents)}</td><td className="px-3 py-1.5 text-right" title="Spend, last 14 days"><Sparkline data={agSparks[g.id]} color="#f59e0b" /></td></tr>)}</tbody></table>
        </>)}
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
          {selTargets.size > 0 && <div className="px-3 py-2 border-b border-slate-200 dark:border-slate-800"><BulkActionShell selectedCount={selTargets.size} noun="target" onClear={() => setSelTargets(new Set())} busy={bulkBusy} status={bulkStatus} actions={[
            { id: 'enable', label: 'Enable', icon: Play, onClick: () => bulkTargetStatus('ENABLED') },
            { id: 'pause', label: 'Pause', icon: Pause, onClick: () => bulkTargetStatus('PAUSED') },
            { id: 'bidup', label: 'Bid +10%', icon: ChevronsUp, tone: 'primary', onClick: () => bulkTargetBid(1.1) },
            { id: 'biddown', label: 'Bid −10%', icon: ChevronsDown, onClick: () => bulkTargetBid(0.9) },
          ]} /></div>}
          <table className="min-w-full text-sm" style={{ tableLayout: 'fixed', width: 'max-content' }}><thead className="bg-slate-50 dark:bg-slate-900/60 text-xs text-slate-500"><tr><th {...tgtCols.thProps('sel')} className="px-2 py-2"><input type="checkbox" aria-label="Select all targets" checked={positiveTargets.length > 0 && selTargets.size === positiveTargets.length} onChange={(e) => setSelTargets(e.target.checked ? new Set(positiveTargets.map((t) => t.id)) : new Set())} /></th><th {...tgtCols.thProps('target')} className="text-left px-3 py-2">Target<tgtCols.ResizeHandle col="target" /></th><th {...tgtCols.thProps('match')} className="text-left px-3 py-2">Match<tgtCols.ResizeHandle col="match" /></th><th {...tgtCols.thProps('bid')} className="text-right px-3 py-2">Bid<tgtCols.ResizeHandle col="bid" /></th><th {...tgtCols.thProps('impr')} className="text-right px-3 py-2">Impr<tgtCols.ResizeHandle col="impr" /></th><th {...tgtCols.thProps('clicks')} className="text-right px-3 py-2">Clicks<tgtCols.ResizeHandle col="clicks" /></th><th {...tgtCols.thProps('spend')} className="text-right px-3 py-2">Spend<tgtCols.ResizeHandle col="spend" /></th><th {...tgtCols.thProps('sales')} className="text-right px-3 py-2">Sales<tgtCols.ResizeHandle col="sales" /></th><th {...tgtCols.thProps('acos')} className="text-right px-3 py-2">ACOS<tgtCols.ResizeHandle col="acos" /></th><th {...tgtCols.thProps('s14')} className="text-right px-3 py-2">14d<tgtCols.ResizeHandle col="s14" /></th></tr></thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">{positiveTargets.length === 0 ? <tr><td colSpan={10} className="px-3 py-6 text-center text-slate-400 text-xs">No keyword/product targets on this campaign.</td></tr> : positiveTargets.map((t) => { const a = t.salesCents > 0 ? t.spendCents / t.salesCents : null; return <tr key={t.id} className={`hover:bg-slate-50 dark:hover:bg-slate-900/40 ${selTargets.has(t.id) ? 'bg-blue-50/50 dark:bg-blue-950/20' : ''}`}><td className="px-2 text-center"><input type="checkbox" aria-label={`Select ${t.expressionValue}`} checked={selTargets.has(t.id)} onChange={(e) => setSelTargets((s) => { const n = new Set(s); if (e.target.checked) n.add(t.id); else n.delete(t.id); return n })} /></td><td className="px-3 py-1.5">{t.expressionValue}</td><td className="px-3 py-1.5 text-xs text-slate-500">{t.expressionType}</td><td className="px-3 py-1.5 text-right tabular-nums">{bidEdit[t.id] != null ? <span className="inline-flex items-center gap-1">€<input autoFocus type="number" step="0.01" value={bidEdit[t.id]} onChange={(e) => setBidEdit((s) => ({ ...s, [t.id]: e.target.value }))} onKeyDown={(e) => { if (e.key === 'Enter') saveBid(t); if (e.key === 'Escape') setBidEdit((s) => { const { [t.id]: _, ...r } = s; return r }) }} className="w-14 px-1 py-0.5 text-right text-xs rounded border border-blue-400 bg-white dark:bg-slate-900" disabled={busy === t.id} /><button onClick={() => saveBid(t)} className="text-blue-600"><Check size={12} /></button>{(() => { const sg = bidSug[t.id]; return sg && sg !== 'loading' && sg !== 'none' ? <span className="text-[10px] text-slate-400" title={`suggested range · basis: ${sg.basis}`}>{eur(sg.lowCents)}–{eur(sg.highCents)}</span> : null })()}</span> : <span className="inline-flex items-center gap-1"><button onClick={() => setBidEdit((s) => ({ ...s, [t.id]: (t.bidCents / 100).toFixed(2) }))} className="hover:underline decoration-dotted">{eur(t.bidCents)}</button><button onClick={() => suggestBid(t)} title="Suggest a bid from account CPC history" className="text-violet-500 hover:text-violet-600 disabled:opacity-40" disabled={bidSug[t.id] === 'loading'}>{bidSug[t.id] === 'loading' ? '…' : <Lightbulb size={11} />}</button></span>}</td><td className="px-3 py-1.5 text-right tabular-nums">{num(t.impressions)}</td><td className="px-3 py-1.5 text-right tabular-nums">{num(t.clicks)}</td><td className="px-3 py-1.5 text-right tabular-nums">{eur(t.spendCents)}</td><td className="px-3 py-1.5 text-right tabular-nums">{eur(t.salesCents)}</td><td className="px-3 py-1.5 text-right tabular-nums">{pct(a)}</td><td className="px-3 py-1.5 text-right" title="Spend, last 14 days"><Sparkline data={tgtSparks[t.id]} color="#f59e0b" /></td></tr> })}</tbody></table>
        </>)}
        {tab === 'searchterms' && (
          searchTerms == null ? <div className="p-6 text-center text-slate-400 text-sm">Loading…</div> :
          <>
          {selTerms.size > 0 && <div className="px-3 py-2 border-b border-slate-200 dark:border-slate-800"><BulkActionShell selectedCount={selTerms.size} noun="term" onClear={() => setSelTerms(new Set())} busy={bulkBusy} status={bulkStatus} actions={[
            { id: 'negate', label: 'Negate', icon: Ban, tone: 'danger', onClick: () => bulkTermAction('NEGATIVE') },
            { id: 'promote', label: 'Add as exact', icon: Plus, tone: 'primary', onClick: () => bulkTermAction('EXACT') },
          ]} /></div>}
          <table className="min-w-full text-sm" style={{ tableLayout: 'fixed', width: 'max-content' }}><thead className="bg-slate-50 dark:bg-slate-900/60 text-xs text-slate-500"><tr><th {...stCols.thProps('sel')} className="px-2 py-2"><input type="checkbox" aria-label="Select all search terms" checked={searchTerms.length > 0 && selTerms.size === searchTerms.length} onChange={(e) => setSelTerms(e.target.checked ? new Set(searchTerms.map((s) => String(s.query ?? ''))) : new Set())} /></th><th {...stCols.thProps('query')} className="text-left px-3 py-2">Search term<stCols.ResizeHandle col="query" /></th><th {...stCols.thProps('match')} className="text-left px-3 py-2">Match<stCols.ResizeHandle col="match" /></th><th {...stCols.thProps('impr')} className="text-right px-3 py-2">Impr<stCols.ResizeHandle col="impr" /></th><th {...stCols.thProps('clicks')} className="text-right px-3 py-2">Clicks<stCols.ResizeHandle col="clicks" /></th><th {...stCols.thProps('spend')} className="text-right px-3 py-2">Spend<stCols.ResizeHandle col="spend" /></th><th {...stCols.thProps('orders')} className="text-right px-3 py-2">Orders<stCols.ResizeHandle col="orders" /></th><th {...stCols.thProps('sales')} className="text-right px-3 py-2">Sales<stCols.ResizeHandle col="sales" /></th><th {...stCols.thProps('act')} className="px-3 py-2"></th></tr></thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">{searchTerms.length === 0 ? <tr><td colSpan={9} className="px-3 py-6 text-center text-slate-400 text-xs">No search-term data yet (run the search-terms report cycle).</td></tr> : searchTerms.map((s, i) => { const qk = String(s.query ?? ''); return <tr key={i} className={`hover:bg-slate-50 dark:hover:bg-slate-900/40 ${selTerms.has(qk) ? 'bg-blue-50/50 dark:bg-blue-950/20' : ''}`}><td className="px-2 text-center"><input type="checkbox" aria-label={`Select ${qk}`} checked={selTerms.has(qk)} onChange={(e) => setSelTerms((st) => { const n = new Set(st); if (e.target.checked) n.add(qk); else n.delete(qk); return n })} /></td><td className="px-3 py-1.5">{String(s.query ?? '')}</td><td className="px-3 py-1.5 text-xs text-slate-500">{String(s.matchType ?? '')}</td><td className="px-3 py-1.5 text-right tabular-nums">{num(Number(s.impressions ?? 0))}</td><td className="px-3 py-1.5 text-right tabular-nums">{num(Number(s.clicks ?? 0))}</td><td className="px-3 py-1.5 text-right tabular-nums">{eur(Number(s.costMicros ?? 0) / 10000)}</td><td className="px-3 py-1.5 text-right tabular-nums">{num(Number(s.orders7d ?? 0))}</td><td className="px-3 py-1.5 text-right tabular-nums">{eur(Number(s.sales7dCents ?? 0))}</td><td className="px-3 py-1.5 text-right"><div className="inline-flex items-center gap-1 text-xs">{(['EXACT', 'PHRASE', 'BROAD'] as const).map((m) => <button key={m} disabled={stAddBusy === String(s.query ?? '') + m} onClick={() => addSearchTermAs(String(s.query ?? ''), m)} title={`Add as ${m.toLowerCase()} keyword`} className="px-1 text-blue-600 hover:underline disabled:opacity-40">{m[0]}</button>)}<button onClick={() => addSearchTermAs(String(s.query ?? ''), 'NEGATIVE')} className="px-1 text-rose-600 hover:underline">⊘</button></div></td></tr> })}</tbody></table></>
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
          <table className="min-w-full text-sm" style={{ tableLayout: 'fixed', width: 'max-content' }}><thead className="bg-slate-50 dark:bg-slate-900/60 text-xs text-slate-500"><tr><th {...negCols.thProps('neg')} className="text-left px-3 py-2">Negative<negCols.ResizeHandle col="neg" /></th><th {...negCols.thProps('type')} className="text-left px-3 py-2">Type<negCols.ResizeHandle col="type" /></th><th {...negCols.thProps('match')} className="text-left px-3 py-2">Match<negCols.ResizeHandle col="match" /></th></tr></thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">{(ingestedNegatives.length === 0 && addedNegs.length === 0) ? <tr><td colSpan={3} className="px-3 py-6 text-center text-slate-400 text-xs">Add negative keywords or products to stop wasted impressions on irrelevant searches.</td></tr> : [
            ...ingestedNegatives.map((t) => <tr key={t.id}><td className="px-3 py-1.5">{t.expressionValue}</td><td className="px-3 py-1.5 text-xs text-slate-500">{t.kind === 'PRODUCT' ? 'Product' : 'Keyword'}</td><td className="px-3 py-1.5 text-xs text-slate-500">Negative {t.expressionType.toLowerCase()}</td></tr>),
            ...addedNegs.map((n, i) => <tr key={`added-${i}`}><td className="px-3 py-1.5">{n.value}</td><td className="px-3 py-1.5 text-xs text-slate-500">{n.kind === 'ASIN' ? 'Product' : 'Keyword'}</td><td className="px-3 py-1.5 text-xs text-slate-500">{n.match?.replace('NEGATIVE_', '').toLowerCase() ?? '—'}</td></tr>),
          ]}</tbody></table>
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
            {/* CPC-ceiling guardrail — caps how high a bid can be set vs the target's own CPC history. */}
            <div className="mt-3 pt-3 border-t border-slate-200 dark:border-slate-800 flex flex-wrap items-center gap-3">
              <label className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 dark:text-slate-300">
                <input type="checkbox" checked={cpcCeiling.enabled} onChange={(e) => setCpcCeiling((c) => ({ ...c, enabled: e.target.checked }))} /> CPC ceiling
              </label>
              <label className="inline-flex items-center gap-1 text-[11px] text-slate-500">cap at
                <input type="number" min="1" max="10" step="0.1" value={cpcCeiling.multiple} disabled={!cpcCeiling.enabled} onChange={(e) => setCpcCeiling((c) => ({ ...c, multiple: parseFloat(e.target.value) || 1.5 }))} className="w-16 px-2 py-1 text-sm rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-right disabled:opacity-50" />× the target's CPC
              </label>
              <button onClick={saveCpcCeiling} disabled={cpcSaving} className="px-3 py-1 text-sm rounded bg-slate-700 text-white hover:bg-slate-800 disabled:opacity-50">{cpcSaving ? 'Saving…' : 'Save ceiling'}</button>
              {cpcMsg && <span className={`text-xs ${cpcMsg.startsWith('✓') ? 'text-emerald-600' : 'text-rose-600'}`}>{cpcMsg}</span>}
              <span className="text-[11px] text-slate-400">Bids above the cap are clamped on save (targets with click history).</span>
            </div>
          </div>
          <table className="min-w-full text-sm" style={{ tableLayout: 'fixed', width: 'max-content' }}><thead className="bg-slate-50 dark:bg-slate-900/60 text-xs text-slate-500"><tr><th {...plCols.thProps('placement')} className="text-left px-3 py-2">Placement<plCols.ResizeHandle col="placement" /></th><th {...plCols.thProps('adj')} className="text-right px-3 py-2">Adjustment<plCols.ResizeHandle col="adj" /></th><th {...plCols.thProps('impr')} className="text-right px-3 py-2">Impr<plCols.ResizeHandle col="impr" /></th><th {...plCols.thProps('clicks')} className="text-right px-3 py-2">Clicks<plCols.ResizeHandle col="clicks" /></th><th {...plCols.thProps('cost')} className="text-right px-3 py-2">Cost<plCols.ResizeHandle col="cost" /></th><th {...plCols.thProps('orders')} className="text-right px-3 py-2">Orders<plCols.ResizeHandle col="orders" /></th><th {...plCols.thProps('s14')} className="text-right px-3 py-2">14d<plCols.ResizeHandle col="s14" /></th></tr></thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">{placements.length === 0 ? <tr><td colSpan={7} className="px-3 py-6 text-center text-slate-400 text-xs">No placement data yet.</td></tr> : placements.map((p, i) => <tr key={i} className="hover:bg-slate-50 dark:hover:bg-slate-900/40"><td className="px-3 py-1.5">{String(p.placement ?? '')}</td><td className="px-3 py-1.5 text-right tabular-nums">{Number(p.adjustmentPct ?? 0)}%</td><td className="px-3 py-1.5 text-right tabular-nums">{num(Number(p.impressions ?? 0))}</td><td className="px-3 py-1.5 text-right tabular-nums">{num(Number(p.clicks ?? 0))}</td><td className="px-3 py-1.5 text-right tabular-nums">{eur(Number(p.costMicros ?? 0) / 10000)}</td><td className="px-3 py-1.5 text-right tabular-nums">{num(Number(p.orders7d ?? 0))}</td><td className="px-3 py-1.5 text-right" title="Spend, last 14 days"><Sparkline data={placeTrend[String(p.placement ?? '')]} color="#0ea5e9" /></td></tr>)}</tbody></table></>
        )}
        {tab === 'dayparting' && (
          <CampaignDayparting campaignId={campaign.id} marketplace={campaign.marketplace} refreshKey={liveTs ?? 0} />
        )}
        {tab === 'budgetrules' && (
          <div className="p-4 space-y-4">
            <CampaignBudgetPace rows={trendRows} dailyBudget={campaign.dailyBudget} windowDays={windowDays} />
            <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-4">
              <div className="font-medium text-sm text-slate-700 dark:text-slate-200 mb-1">Scheduled &amp; performance-based budget rules</div>
              <p className="text-xs text-slate-500 mb-3 max-w-prose">Automatically raise budgets for peak events (Prime Day, Black Friday) or when ROAS/CTR/conversion clears a threshold, then return to baseline. Rules are managed centrally so they apply consistently across campaigns and markets.</p>
              <Link href="/marketing/advertising/budget-manager" className="inline-flex items-center gap-1 px-3 py-1.5 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-700">Open Budget Manager →</Link>
            </div>
          </div>
        )}
        {tab === 'history' && (
          <table className="min-w-full text-sm" style={{ tableLayout: 'fixed', width: 'max-content' }}><thead className="bg-slate-50 dark:bg-slate-900/60 text-xs text-slate-500"><tr><th {...histCols.thProps('field')} className="text-left px-3 py-2">Field<histCols.ResizeHandle col="field" /></th><th {...histCols.thProps('change')} className="text-left px-3 py-2">Change<histCols.ResizeHandle col="change" /></th><th {...histCols.thProps('by')} className="text-left px-3 py-2">By<histCols.ResizeHandle col="by" /></th><th {...histCols.thProps('when')} className="text-right px-3 py-2">When<histCols.ResizeHandle col="when" /></th></tr></thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">{history.length === 0 ? <tr><td colSpan={4} className="px-3 py-6 text-center text-slate-400 text-xs">No changes yet.</td></tr> : history.map((h) => <tr key={h.id}><td className="px-3 py-1.5">{h.field}</td><td className="px-3 py-1.5 text-xs">{h.oldValue ?? '—'} → <span className="font-medium">{h.newValue ?? '—'}</span></td><td className="px-3 py-1.5 text-xs text-slate-500">{h.changedBy}</td><td className="px-3 py-1.5 text-right text-xs text-slate-400">{new Date(h.changedAt).toLocaleString()}</td></tr>)}</tbody></table>
        )}
          </div>
        </div>
      </div>
    </div>
  )
}
