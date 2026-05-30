'use client'

/**
 * AX.2 — Amazon-grade campaigns cockpit.
 *
 * Replaces the thin 13-column CampaignsListClient with: date-range + KPI
 * tiles + a multi-metric performance chart (recharts) + a dense, 40+ column
 * table with Customize Columns (drag-arrange/show-hide/saved via grid-lens
 * PreferencesModal, persisted to localStorage), sort, filters, inline
 * budget/state edit (existing PATCH /api/advertising/campaigns/:id), and a
 * bulk-action bar. Built to match/beat Amazon's Campaigns screen.
 *
 * Data: /api/advertising/campaigns (base rows) merged with
 * /api/advertising/campaigns/v1-metrics (orders/units/NTB by externalId) +
 * /api/advertising/trends (daily series for the chart).
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from 'recharts'
import { Search, RefreshCw, SlidersHorizontal, Play, Pause, Download, FileDown, Rows, AlignJustify } from 'lucide-react'
import { KpiStrip, PreferencesModal, type KpiTileSpec, type PreferencesValue, type PreferencesColumnSpec } from '@/app/_shared/grid-lens'
import { StatusChip } from '@/app/_shared/ads-ui'
import { getBackendUrl } from '@/lib/backend-url'
import { useMarketingEvents } from '@/lib/sync/use-marketing-events'

interface TrendSummary { impressions: number; clicks: number; orders: number; spendCents: number; salesCents: number }

interface CampaignBase {
  id: string; name: string; type: 'SP' | 'SB' | 'SD'; adProduct: string | null
  status: string; marketplace: string | null; externalCampaignId: string | null
  dailyBudget: string; biddingStrategy: string
  impressions: number; clicks: number; spend: string; sales: string
  acos: string | null; roas: string | null; trueProfitCents: number; trueProfitMarginPct: string | null
  deliveryStatus: string | null; deliveryReasons: string[]
  portfolioName?: string | null; startDate?: string | null; endDate?: string | null; lastSyncedAt?: string | null
}
// /api/advertising/campaigns/v1-metrics returns { byCampaign: Record<extId, {...}> }.
interface V1Metric { impressions?: number; clicks?: number; costUnits?: number; salesCents?: number; orders?: number; acos?: number | null; roas?: number | null }
interface TrendPoint { date: string; spend?: number; cost?: number; sales?: number; clicks?: number; orders?: number; impressions?: number; acos?: number }

/** Merged + derived row. */
interface Row {
  base: CampaignBase
  impressions: number; clicks: number; spendC: number; salesC: number
  orders: number; units: number | null; ntbOrders: number | null; ntbSalesC: number | null; viewImpr: number | null; dpv: number | null
  ctr: number | null; cpc: number | null; cvr: number | null; acos: number | null; roas: number | null
  marginPct: number | null; budgetC: number; aov: number | null
}

const DATE_PRESETS = [
  { key: '7', label: 'Last 7 days', days: 7 },
  { key: '14', label: 'Last 14 days', days: 14 },
  { key: '30', label: 'Last 30 days', days: 30 },
  { key: '60', label: 'Last 60 days', days: 60 },
  { key: '90', label: 'Last 90 days', days: 90 },
]

const CHART_METRICS: Array<{ key: string; label: string; color: string; axis: 'l' | 'r' }> = [
  { key: 'clicks', label: 'Clicks', color: '#6366f1', axis: 'l' },
  { key: 'cost', label: 'Cost', color: '#14b8a6', axis: 'r' },
  { key: 'sales', label: 'Sales', color: '#a855f7', axis: 'r' },
  { key: 'orders', label: 'Orders', color: '#f59e0b', axis: 'l' },
  { key: 'impressions', label: 'Impressions', color: '#94a3b8', axis: 'l' },
]

const eur = (c: number | null | undefined) => (c == null ? '—' : new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(c / 100))
const num = (n: number | null | undefined) => (n == null ? '—' : new Intl.NumberFormat('en-US').format(Math.round(n)))
const pct = (v: number | null | undefined, dp = 1) => (v == null ? '—' : `${(v * 100).toFixed(dp)}%`)
const x2 = (v: number | null | undefined) => (v == null ? '—' : `${v.toFixed(2)}×`)
// ACOS colour (fraction 0-1): green low, amber mid, rose high.
const acosTone = (v: number | null | undefined) => (v == null ? 'bg-slate-300' : v <= 0.2 ? 'bg-emerald-500' : v <= 0.35 ? 'bg-amber-500' : 'bg-rose-500')
const acosText = (v: number | null | undefined) => (v == null ? 'text-slate-400' : v <= 0.2 ? 'text-emerald-600 dark:text-emerald-400' : v <= 0.35 ? 'text-amber-600 dark:text-amber-400' : 'text-rose-600 dark:text-rose-400')
const TYPE_TONE: Record<string, string> = { SP: 'bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300', SB: 'bg-violet-100 text-violet-700 dark:bg-violet-950/50 dark:text-violet-300', SD: 'bg-teal-100 text-teal-700 dark:bg-teal-950/50 dark:text-teal-300' }

// ── Column registry (Amazon-grade) ───────────────────────────────────────
interface ColDef extends PreferencesColumnSpec { render: (r: Row) => React.ReactNode; align?: 'right' | 'left'; num?: boolean }

export function AdCampaignsCockpit({ initial }: { initial: { items: CampaignBase[]; count: number } }) {
  const [rowsRaw, setRowsRaw] = useState<CampaignBase[]>(initial.items)
  const [metrics, setMetrics] = useState<Record<string, V1Metric>>({})
  const [trend, setTrend] = useState<TrendPoint[]>([])
  const [trendPrev, setTrendPrev] = useState<TrendSummary | null>(null) // CD.13
  const [liveTs, setLiveTs] = useState<number | null>(null) // CD.13
  const [days, setDays] = useState(30)
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [typeFilter, setTypeFilter] = useState('')
  const [marketplaceFilter, setMarketplaceFilter] = useState('') // PCG.2
  const [sortKey, setSortKey] = useState('spendC')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [budgetEdits, setBudgetEdits] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [prefsOpen, setPrefsOpen] = useState(false)
  const [density, setDensity] = useState<'comfortable' | 'compact'>('comfortable')
  const [layout, setLayout] = useState<'cards' | 'table'>('cards') // PCG.3 — polished 2-line rows vs flat table
  const [chartMetrics, setChartMetrics] = useState<Set<string>>(() => new Set(['clicks', 'cost', 'sales']))
  const [bulkBudgetVal, setBulkBudgetVal] = useState('')
  const [importMsg, setImportMsg] = useState('')
  const [prefs, setPrefs] = useState<PreferencesValue>(() => {
    if (typeof window !== 'undefined') {
      try { const s = localStorage.getItem('ax.campaigns.prefs.v1'); if (s) return JSON.parse(s) } catch {}
    }
    return { pageSize: 100, visibleColumns: DEFAULT_VISIBLE.slice(), stickyFirstColumn: true, stickyLastColumn: false, sortBy: 'spendC', sortDir: 'desc' }
  })
  useEffect(() => { try { localStorage.setItem('ax.campaigns.prefs.v1', JSON.stringify(prefs)) } catch {} }, [prefs])

  const refetch = useCallback(async () => {
    setLoading(true)
    try {
      const base = getBackendUrl()
      const [c, m, t] = await Promise.all([
        fetch(`${base}/api/advertising/campaigns?limit=500`, { cache: 'no-store' }).then((r) => r.json()).catch(() => ({ items: [] })),
        fetch(`${base}/api/advertising/campaigns/v1-metrics?windowDays=${days}`, { cache: 'no-store' }).then((r) => r.json()).catch(() => ({ items: [] })),
        fetch(`${base}/api/advertising/trends?windowDays=${days}&compare=true`, { cache: 'no-store' }).then((r) => r.json()).catch(() => ({ items: [] })),
      ])
      setRowsRaw(c.items ?? [])
      setMetrics((m.byCampaign ?? {}) as Record<string, V1Metric>)
      setTrend((t.items ?? t.trends ?? t.daily ?? t.rows ?? []) as TrendPoint[])
      setTrendPrev((t.previous ?? null) as TrendSummary | null)
    } finally { setLoading(false) }
  }, [days])
  useEffect(() => { void refetch() }, [days, refetch])

  // CD.13 — parity: live-refresh the roster on marketing events + a Live badge.
  useMarketingEvents(useCallback(() => { void refetch(); setLiveTs(Date.now()); setTimeout(() => setLiveTs(null), 4000) }, [refetch]))

  // Merge + derive.
  const rows: Row[] = useMemo(() => rowsRaw.map((b) => {
    // v1-metrics (Reports API, date-range-aware) override the base counters when present.
    const m = (b.externalCampaignId && metrics[b.externalCampaignId]) || {}
    const impressions = m.impressions ?? b.impressions ?? 0, clicks = m.clicks ?? b.clicks ?? 0
    const spendC = m.costUnits != null ? Math.round(m.costUnits * 100) : Math.round(parseFloat(b.spend || '0') * 100)
    const salesC = m.salesCents ?? Math.round(parseFloat(b.sales || '0') * 100)
    const orders = m.orders ?? 0
    const acos = m.acos ?? (b.acos != null ? parseFloat(b.acos) : salesC > 0 ? spendC / salesC : null)
    const roas = m.roas ?? (b.roas != null ? parseFloat(b.roas) : spendC > 0 ? salesC / spendC : null)
    return {
      base: b, impressions, clicks, spendC, salesC, orders, units: null,
      ntbOrders: null, ntbSalesC: null, viewImpr: null, dpv: null,
      ctr: impressions > 0 ? clicks / impressions : null, cpc: clicks > 0 ? spendC / clicks : null,
      cvr: clicks > 0 ? orders / clicks : null, acos, roas,
      marginPct: b.trueProfitMarginPct != null ? parseFloat(b.trueProfitMarginPct) : null,
      budgetC: Math.round(parseFloat(b.dailyBudget || '0') * 100), aov: orders > 0 ? salesC / orders : null,
    }
  }), [rowsRaw, metrics])

  const filtered = useMemo(() => {
    let r = rows
    if (search.trim()) { const q = search.toLowerCase(); r = r.filter((x) => x.base.name.toLowerCase().includes(q)) }
    if (statusFilter) r = r.filter((x) => x.base.status === statusFilter)
    if (typeFilter) r = r.filter((x) => x.base.type === typeFilter)
    if (marketplaceFilter) r = r.filter((x) => x.base.marketplace === marketplaceFilter)
    const dir = sortDir === 'asc' ? 1 : -1
    const get = (x: Row): number | string => {
      switch (sortKey) {
        case 'name': return x.base.name
        case 'status': return x.base.status
        case 'spendC': return x.spendC; case 'salesC': return x.salesC; case 'impressions': return x.impressions
        case 'clicks': return x.clicks; case 'orders': return x.orders; case 'acos': return x.acos ?? -1
        case 'roas': return x.roas ?? -1; case 'ctr': return x.ctr ?? -1; case 'cpc': return x.cpc ?? -1
        case 'budgetC': return x.budgetC; default: return x.spendC
      }
    }
    return [...r].sort((a, b) => { const av = get(a), bv = get(b); return typeof av === 'string' && typeof bv === 'string' ? av.localeCompare(bv) * dir : ((av as number) - (bv as number)) * dir })
  }, [rows, search, statusFilter, typeFilter, marketplaceFilter, sortKey, sortDir])
  // PCG.2 — distinct markets present, for the marketplace filter.
  const markets = useMemo(() => [...new Set(rowsRaw.map((c) => c.marketplace).filter((m): m is string => !!m))].sort(), [rowsRaw])

  // Totals for KPIs.
  const totals = useMemo(() => filtered.reduce((a, r) => ({ impr: a.impr + r.impressions, clicks: a.clicks + r.clicks, spendC: a.spendC + r.spendC, salesC: a.salesC + r.salesC, orders: a.orders + r.orders }), { impr: 0, clicks: 0, spendC: 0, salesC: 0, orders: 0 }), [filtered])
  // CD.13 — vs-prior-period deltas (account-level compare). Only shown when no
  // filters are active, so the filtered totals stay consistent with the
  // account-wide previous-window summary.
  const noFilters = !search.trim() && !statusFilter && !typeFilter
  const dPct = (cur: number, prev: number | undefined | null) => (prev != null && prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : null)
  const delta = (cur: number, prev: number | undefined, goodWhenUp: boolean): KpiTileSpec['delta'] | undefined => {
    if (!noFilters || !trendPrev) return undefined
    const p = dPct(cur, prev)
    return { pct: p, good: goodWhenUp ? (p ?? 0) >= 0 : (p ?? 0) <= 0 }
  }
  const tiles: KpiTileSpec[] = [
    { icon: Search, label: 'Impressions', value: num(totals.impr), tone: 'slate', detail: `CTR ${pct(totals.impr ? totals.clicks / totals.impr : null, 2)}`, delta: delta(totals.impr, trendPrev?.impressions, true) },
    { icon: RefreshCw, label: 'Clicks', value: num(totals.clicks), tone: 'blue', detail: `CPC ${eur(totals.clicks ? totals.spendC / totals.clicks : null)}`, delta: delta(totals.clicks, trendPrev?.clicks, true) },
    { icon: Download, label: 'Spend', value: eur(totals.spendC), tone: 'amber', detail: `${filtered.length} campaigns`, delta: delta(totals.spendC, trendPrev?.spendCents, false) },
    { icon: Play, label: 'Orders', value: num(totals.orders), tone: 'emerald', detail: `CVR ${pct(totals.clicks ? totals.orders / totals.clicks : null, 2)}`, delta: delta(totals.orders, trendPrev?.orders, true) },
    { icon: Pause, label: 'Sales', value: eur(totals.salesC), tone: 'violet', detail: `ACOS ${pct(totals.salesC ? totals.spendC / totals.salesC : null)} · ROAS ${x2(totals.spendC ? totals.salesC / totals.spendC : null)}`, delta: delta(totals.salesC, trendPrev?.salesCents, true) },
  ]

  // Inline budget save + status toggle (existing endpoints).
  const saveBudget = async (c: CampaignBase) => {
    const v = budgetEdits[c.id]; if (v == null) return
    const n = parseFloat(v); if (!Number.isFinite(n) || n < 0) return
    setBusy(c.id)
    try {
      await fetch(`${getBackendUrl()}/api/advertising/campaigns/${c.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dailyBudget: n }) })
      setBudgetEdits((e) => { const { [c.id]: _, ...rest } = e; return rest })
      void refetch()
    } finally { setBusy(null) }
  }
  const toggleStatus = async (c: CampaignBase) => {
    setBusy(c.id)
    try {
      await fetch(`${getBackendUrl()}/api/advertising/campaigns/${c.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: c.status === 'ENABLED' ? 'PAUSED' : 'ENABLED' }) })
      void refetch()
    } finally { setBusy(null) }
  }
  const bulkStatus = async (status: string) => {
    const ids = [...selected]
    await Promise.all(ids.map((id) => fetch(`${getBackendUrl()}/api/advertising/campaigns/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) })))
    setSelected(new Set()); void refetch()
  }
  const bulkBudget = async (mode: 'set' | 'pct', value: number) => {
    const targets = filtered.filter((r) => selected.has(r.base.id))
    await Promise.all(targets.map((r) => {
      const next = mode === 'set' ? value : Math.max(1, Math.round((r.budgetC / 100) * (1 + value / 100) * 100) / 100)
      return fetch(`${getBackendUrl()}/api/advertising/campaigns/${r.base.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dailyBudget: next }) })
    }))
    setSelected(new Set()); setBulkBudgetVal(''); void refetch()
  }
  // AX2.5 — bulksheet import: CSV with columns id|externalCampaignId, budget, status.
  const importCsv = async (file: File) => {
    setImportMsg('Importing…')
    try {
      const text = await file.text()
      const lines = text.split(/\r?\n/).filter((l) => l.trim())
      const header = lines.shift()?.split(',').map((h) => h.trim().toLowerCase().replace(/^"|"$/g, '')) ?? []
      const idIx = header.findIndex((h) => h === 'id' || h === 'campaign id' || h === 'externalcampaignid')
      const extIx = header.findIndex((h) => h === 'externalcampaignid')
      const budIx = header.findIndex((h) => h.startsWith('budget'))
      const statIx = header.findIndex((h) => h === 'status')
      if (idIx < 0 && extIx < 0) { setImportMsg('CSV needs an id (or externalCampaignId) column'); return }
      const byExt = new Map(rowsRaw.map((r) => [r.externalCampaignId ?? '', r.id]))
      let applied = 0, skipped = 0
      await Promise.all(lines.map(async (line) => {
        const cells = line.split(',').map((c) => c.trim().replace(/^"|"$/g, ''))
        let id = idIx >= 0 ? cells[idIx] : ''
        if ((!id || !rowsRaw.some((r) => r.id === id)) && extIx >= 0) id = byExt.get(cells[extIx]) ?? id
        if (!id || !rowsRaw.some((r) => r.id === id)) { skipped++; return }
        const patch: Record<string, unknown> = {}
        if (budIx >= 0 && cells[budIx] && Number.isFinite(parseFloat(cells[budIx]))) patch.dailyBudget = parseFloat(cells[budIx])
        if (statIx >= 0 && cells[statIx]) patch.status = cells[statIx].toUpperCase()
        if (Object.keys(patch).length === 0) { skipped++; return }
        await fetch(`${getBackendUrl()}/api/advertising/campaigns/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) })
        applied++
      }))
      setImportMsg(`✓ ${applied} updated${skipped ? `, ${skipped} skipped` : ''}`); void refetch()
    } catch (e) { setImportMsg((e as Error).message) }
  }
  const exportCsv = () => {
    const headers = ['Campaign', 'Status', 'Type', 'Market', 'Budget/d', 'Impressions', 'Clicks', 'CTR%', 'Spend', 'CPC', 'Orders', 'CVR%', 'Sales', 'ACOS%', 'ROAS', 'Margin%']
    const lines = [headers.join(',')]
    for (const r of filtered) {
      const v = [r.base.name, r.base.status, r.base.type, r.base.marketplace ?? '', (r.budgetC / 100).toFixed(2), r.impressions, r.clicks, r.ctr != null ? (r.ctr * 100).toFixed(2) : '', (r.spendC / 100).toFixed(2), r.cpc != null ? (r.cpc / 100).toFixed(2) : '', r.orders, r.cvr != null ? (r.cvr * 100).toFixed(2) : '', (r.salesC / 100).toFixed(2), r.acos != null ? (r.acos * 100).toFixed(1) : '', r.roas != null ? r.roas.toFixed(2) : '', r.marginPct != null ? (r.marginPct * 100).toFixed(1) : '']
      lines.push(v.map((x) => `"${String(x).replace(/"/g, '""')}"`).join(','))
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `campaigns-${days}d.csv`; a.click(); URL.revokeObjectURL(url)
  }

  const cols = useMemo(() => COLUMN_DEFS(budgetEdits, setBudgetEdits, saveBudget, toggleStatus, busy), [budgetEdits, busy])
  const visibleCols = useMemo(() => {
    const byKey = new Map(cols.map((c) => [c.key, c]))
    return prefs.visibleColumns.map((k) => byKey.get(k)).filter(Boolean) as ColDef[]
  }, [cols, prefs.visibleColumns])

  const toggleSort = (k: string) => { if (sortKey === k) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc')); else { setSortKey(k); setSortDir('desc') } }
  const allChecked = filtered.length > 0 && filtered.every((r) => selected.has(r.base.id))
  const rowPad = density === 'compact' ? 'py-0.5' : 'py-1.5'

  return (
    <div>
      {/* Date range + KPIs */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex gap-1">
          {DATE_PRESETS.map((p) => (
            <button key={p.key} onClick={() => setDays(p.days)} className={`px-2.5 py-1 text-xs rounded-md border ${days === p.days ? 'bg-blue-600 text-white border-blue-600' : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'}`}>{p.label}</button>
          ))}
        </div>
        <span className="inline-flex items-center gap-1.5 text-xs">
          {loading && <span className="text-slate-400">updating…</span>}
          <span className={`inline-flex h-2 w-2 rounded-full ${liveTs ? 'bg-emerald-500 animate-pulse' : 'bg-emerald-500/70'}`} />
          <span className="text-emerald-600 dark:text-emerald-400 font-medium">{liveTs ? 'Updated just now' : 'Live'}</span>
        </span>
      </div>
      <KpiStrip tiles={tiles} className="mb-4" />

      {/* Performance chart */}
      {trend.length > 0 && (
        <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3 mb-4">
          <div className="flex flex-wrap gap-1.5 mb-2">
            {CHART_METRICS.map((m) => {
              const on = chartMetrics.has(m.key)
              return <button key={m.key} onClick={() => setChartMetrics((s) => { const n = new Set(s); n.has(m.key) ? n.delete(m.key) : n.add(m.key); return n })} className={`inline-flex items-center gap-1.5 px-2 py-0.5 text-xs rounded-full border transition ${on ? 'border-transparent text-white' : 'border-slate-200 dark:border-slate-700 text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800'}`} style={on ? { backgroundColor: m.color } : undefined}><span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: on ? '#fff' : m.color }} />{m.label}</button>
            })}
          </div>
          <div className="h-60">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={trend} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-slate-100 dark:stroke-slate-800" />
              <XAxis dataKey="date" tick={{ fontSize: 10 }} tickFormatter={(d: string) => (typeof d === 'string' ? d.slice(5) : d)} />
              <YAxis yAxisId="l" tick={{ fontSize: 10 }} width={44} /><YAxis yAxisId="r" orientation="right" tick={{ fontSize: 10 }} width={44} />
              <Tooltip contentStyle={{ fontSize: 12 }} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {CHART_METRICS.filter((m) => chartMetrics.has(m.key)).map((m) => (
                <Line key={m.key} yAxisId={m.axis} type="monotone" dataKey={m.key === 'cost' ? ((d: TrendPoint) => d.cost ?? d.spend) : m.key} stroke={m.color} strokeWidth={2} dot={false} name={m.label} />
              ))}
            </LineChart>
          </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <div className="relative"><Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Find a campaign…" className="pl-7 pr-2 py-1.5 text-sm rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 w-56" /></div>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="Filter by status" className="py-1.5 px-2 text-sm rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"><option value="">All status</option>{['ENABLED', 'PAUSED', 'ARCHIVED', 'DRAFT'].map((s) => <option key={s}>{s}</option>)}</select>
        <select value={marketplaceFilter} onChange={(e) => setMarketplaceFilter(e.target.value)} aria-label="Filter by marketplace" className="py-1.5 px-2 text-sm rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"><option value="">All markets</option>{markets.map((m) => <option key={m} value={m}>{m}</option>)}</select>
        <div className="inline-flex rounded-md border border-slate-200 dark:border-slate-700 overflow-hidden">
          {[['', 'All'], ['SP', 'SP'], ['SB', 'SB'], ['SD', 'SD']].map(([v, label]) => (
            <button key={v} onClick={() => setTypeFilter(v)} className={`px-2.5 py-1.5 text-xs border-l first:border-l-0 border-slate-200 dark:border-slate-700 ${typeFilter === v ? 'bg-blue-600 text-white' : 'text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'}`}>{label}</button>
          ))}
        </div>
        <div className="inline-flex items-center rounded-md border border-slate-200 dark:border-slate-700 p-0.5" title="Channel — eBay/Shopify have no keyword PPC yet">
          {[['Amazon', true], ['eBay', false], ['Shopify', false]].map(([label, on]) => (
            <span key={label as string} className={`px-2 py-1 text-xs rounded ${on ? 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 font-medium' : 'text-slate-300 dark:text-slate-600 cursor-not-allowed'}`}>{label}</span>
          ))}
        </div>
        <Link href="/marketing/advertising/create" className="inline-flex items-center gap-1 py-1.5 px-3 text-sm rounded-md bg-slate-900 text-white dark:bg-slate-700 hover:bg-slate-800">+ Create campaign</Link>
        <div className="ml-auto flex items-center gap-2">
          {importMsg && <span className={`text-xs ${importMsg.startsWith('✓') ? 'text-emerald-600' : 'text-slate-400'}`}>{importMsg}</span>}
          <span className="text-xs text-slate-400">{filtered.length} campaigns</span>
          {layout === 'cards' && (
            <select value={`${sortKey}:${sortDir}`} onChange={(e) => { const [k, d] = e.target.value.split(':'); setSortKey(k); setSortDir(d as 'asc' | 'desc') }} aria-label="Sort" className="py-1.5 px-2 text-xs rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900">
              {[['spendC', 'Spend'], ['salesC', 'Sales'], ['acos', 'ACOS'], ['roas', 'ROAS'], ['impressions', 'Impressions'], ['clicks', 'Clicks'], ['orders', 'Orders'], ['name', 'Name']].map(([k, label]) => (
                <optgroup key={k} label={label}>
                  <option value={`${k}:desc`}>{label} ↓</option>
                  <option value={`${k}:asc`}>{label} ↑</option>
                </optgroup>
              ))}
            </select>
          )}
          <div className="inline-flex rounded-md border border-slate-200 dark:border-slate-700 overflow-hidden" title="Layout">
            <button onClick={() => setLayout('cards')} className={`px-1.5 py-1.5 ${layout === 'cards' ? 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200' : 'text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800'}`} title="Polished rows"><Rows size={14} /></button>
            <button onClick={() => setLayout('table')} className={`px-1.5 py-1.5 border-l border-slate-200 dark:border-slate-700 ${layout === 'table' ? 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200' : 'text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800'}`} title="Dense table"><SlidersHorizontal size={14} /></button>
          </div>
          <div className="inline-flex rounded-md border border-slate-200 dark:border-slate-700 overflow-hidden" title="Row density">
            <button onClick={() => setDensity('comfortable')} className={`px-1.5 py-1.5 ${density === 'comfortable' ? 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200' : 'text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800'}`}><Rows size={14} /></button>
            <button onClick={() => setDensity('compact')} className={`px-1.5 py-1.5 border-l border-slate-200 dark:border-slate-700 ${density === 'compact' ? 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200' : 'text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800'}`}><AlignJustify size={14} /></button>
          </div>
          <button onClick={exportCsv} className="inline-flex items-center gap-1 py-1.5 px-2 text-sm rounded-md border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800" title="Export CSV"><FileDown size={14} /></button>
          <label className="inline-flex items-center gap-1 py-1.5 px-2 text-sm rounded-md border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer" title="Import bulksheet CSV (id, budget, status)"><Download size={14} className="rotate-180" /><input type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void importCsv(f); e.target.value = '' }} /></label>
          <button onClick={() => setPrefsOpen(true)} className="inline-flex items-center gap-1 py-1.5 px-2 text-sm rounded-md border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800"><SlidersHorizontal size={14} /> Columns ({visibleCols.length})</button>
          <button onClick={() => void refetch()} className="inline-flex items-center gap-1 py-1.5 px-2 text-sm rounded-md border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800"><RefreshCw size={14} className={loading ? 'animate-spin' : ''} /></button>
        </div>
      </div>

      {/* Bulk bar */}
      {selected.size > 0 && (
        <div className="flex items-center gap-2 mb-2 px-3 py-1.5 rounded-md bg-blue-50 dark:bg-blue-950/30 text-sm">
          <span className="text-blue-700 dark:text-blue-300">{selected.size} selected</span>
          <button onClick={() => void bulkStatus('ENABLED')} className="px-2 py-0.5 rounded border border-emerald-300 text-emerald-700 hover:bg-emerald-50">Enable</button>
          <button onClick={() => void bulkStatus('PAUSED')} className="px-2 py-0.5 rounded border border-amber-300 text-amber-700 hover:bg-amber-50">Pause</button>
          <span className="w-px h-4 bg-blue-200 dark:bg-blue-800" />
          <span className="text-blue-700 dark:text-blue-300">Budget</span>
          <button onClick={() => void bulkBudget('pct', 10)} className="px-2 py-0.5 rounded border border-blue-300 text-blue-700 hover:bg-blue-100">+10%</button>
          <button onClick={() => void bulkBudget('pct', -10)} className="px-2 py-0.5 rounded border border-blue-300 text-blue-700 hover:bg-blue-100">−10%</button>
          <span className="inline-flex items-center gap-1">set €<input type="number" step="0.01" value={bulkBudgetVal} onChange={(e) => setBulkBudgetVal(e.target.value)} className="w-16 px-1 py-0.5 rounded border border-blue-300 bg-white dark:bg-slate-900" /><button disabled={!bulkBudgetVal} onClick={() => { const n = parseFloat(bulkBudgetVal); if (Number.isFinite(n) && n > 0) void bulkBudget('set', n) }} className="px-2 py-0.5 rounded border border-blue-300 text-blue-700 hover:bg-blue-100 disabled:opacity-40">Apply</button></span>
          <button onClick={() => setSelected(new Set())} className="text-slate-400 ml-auto">Clear</button>
        </div>
      )}

      {/* PCG.3 — polished 2-line rows (default) */}
      {layout === 'cards' ? (
        <div className="rounded-lg border border-slate-200 dark:border-slate-800 divide-y divide-slate-100 dark:divide-slate-800 overflow-hidden">
          {filtered.length === 0 && <div className="px-3 py-10 text-center text-slate-400">No campaigns. Run the Amazon Ads sync to import.</div>}
          {filtered.map((r) => {
            const b = r.base
            const editing = budgetEdits[b.id] != null
            return (
              <div key={b.id} className={`group px-3 ${density === 'compact' ? 'py-1.5' : 'py-2.5'} hover:bg-slate-50 dark:hover:bg-slate-900/40 ${selected.has(b.id) ? 'bg-blue-50/50 dark:bg-blue-950/20' : ''}`}>
                <div className="flex items-center gap-2 min-w-0">
                  <input type="checkbox" checked={selected.has(b.id)} onChange={(e) => setSelected((s) => { const n = new Set(s); e.target.checked ? n.add(b.id) : n.delete(b.id); return n })} className="flex-shrink-0" />
                  <Link href={`/marketing/advertising/campaigns/${b.id}`} className="font-medium text-sm text-slate-800 dark:text-slate-100 hover:underline truncate max-w-[26rem]" title={b.name}>{b.name}</Link>
                  <StatusChip status={b.status} dot />
                  <span className={`px-1.5 py-px text-[10px] font-medium rounded flex-shrink-0 ${TYPE_TONE[b.type] ?? 'bg-slate-100 text-slate-600'}`}>{b.type}</span>
                  <span className="text-xs text-slate-400 flex-shrink-0">{b.marketplace ?? '—'}</span>
                  {editing ? (
                    <span className="inline-flex items-center gap-1 flex-shrink-0">€<input autoFocus type="number" step="0.01" value={budgetEdits[b.id]} onChange={(e) => setBudgetEdits((s) => ({ ...s, [b.id]: e.target.value }))} onKeyDown={(e) => { if (e.key === 'Enter') saveBudget(b); if (e.key === 'Escape') setBudgetEdits((s) => { const { [b.id]: _, ...rest } = s; return rest }) }} onBlur={() => saveBudget(b)} className="w-16 px-1 py-0.5 text-xs text-right rounded border border-blue-400 bg-white dark:bg-slate-900" disabled={busy === b.id} />/d</span>
                  ) : (
                    <button onClick={() => setBudgetEdits((s) => ({ ...s, [b.id]: (r.budgetC / 100).toFixed(2) }))} className="text-xs text-slate-500 hover:text-slate-700 hover:underline decoration-dotted flex-shrink-0" title="Edit daily budget">{eur(r.budgetC)}/d</button>
                  )}
                  <div className="ml-auto flex items-center gap-1 flex-shrink-0 md:opacity-0 md:group-hover:opacity-100 transition">
                    <button onClick={() => void toggleStatus(b)} disabled={busy === b.id} className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50">{b.status === 'ENABLED' ? <><Pause size={11} /> Pause</> : <><Play size={11} /> Enable</>}</button>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-0.5 mt-1 pl-6 text-xs">
                  {([['Impr', num(r.impressions)], ['CTR', pct(r.ctr, 2)], ['Spend', eur(r.spendC)], ['Sales', eur(r.salesC)], ['ROAS', x2(r.roas)], ['Orders', num(r.orders)]] as const).map(([label, val]) => (
                    <span key={label} className="inline-flex items-center gap-1"><span className="text-slate-400">{label}</span><span className="tabular-nums text-slate-700 dark:text-slate-200">{val}</span></span>
                  ))}
                  <span className="inline-flex items-center gap-1"><span className={`h-1.5 w-1.5 rounded-full ${acosTone(r.acos)}`} /><span className="text-slate-400">ACOS</span><span className={`tabular-nums font-medium ${acosText(r.acos)}`}>{pct(r.acos)}</span></span>
                  {r.marginPct != null && <span className="inline-flex items-center gap-1"><span className="text-slate-400">Margin</span><span className={`tabular-nums ${r.marginPct >= 0 ? 'text-slate-600 dark:text-slate-300' : 'text-rose-600'}`}>{pct(r.marginPct)}</span></span>}
                </div>
              </div>
            )
          })}
        </div>
      ) : (
      <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800">
        <table className="text-sm border-collapse" style={{ minWidth: 'max-content' }}>
          <thead className="bg-slate-50 dark:bg-slate-900/60 text-slate-500 text-xs">
            <tr>
              <th className="sticky left-0 z-10 bg-slate-50 dark:bg-slate-900/60 px-2 py-2 w-8"><input type="checkbox" checked={allChecked} onChange={(e) => setSelected(e.target.checked ? new Set(filtered.map((r) => r.base.id)) : new Set())} /></th>
              {visibleCols.map((c, i) => (
                <th key={c.key} onClick={() => toggleSort(c.key)} className={`px-3 py-2 font-medium whitespace-nowrap cursor-pointer ${c.align === 'right' ? 'text-right' : 'text-left'} ${i === 0 && prefs.stickyFirstColumn ? 'sticky left-8 z-10 bg-slate-50 dark:bg-slate-900/60' : ''}`} style={{ width: c.width }}>
                  {c.label}{sortKey === c.key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {filtered.length === 0 && <tr><td colSpan={visibleCols.length + 1} className="px-3 py-10 text-center text-slate-400">No campaigns. Run the Amazon Ads sync to import.</td></tr>}
            {filtered.map((r) => (
              <tr key={r.base.id} className="hover:bg-slate-50 dark:hover:bg-slate-900/40">
                <td className={`sticky left-0 z-10 bg-white dark:bg-slate-950 px-2 ${rowPad}`}><input type="checkbox" checked={selected.has(r.base.id)} onChange={(e) => setSelected((s) => { const n = new Set(s); e.target.checked ? n.add(r.base.id) : n.delete(r.base.id); return n })} /></td>
                {visibleCols.map((c, i) => (
                  <td key={c.key} className={`px-3 ${rowPad} whitespace-nowrap ${c.align === 'right' ? 'text-right tabular-nums' : ''} ${i === 0 && prefs.stickyFirstColumn ? 'sticky left-8 z-10 bg-white dark:bg-slate-950' : ''}`} style={{ width: c.width }}>{c.render(r)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      )}

      <PreferencesModal
        open={prefsOpen} onClose={() => setPrefsOpen(false)} value={prefs} onConfirm={(v) => { setPrefs(v); setPrefsOpen(false) }}
        allColumns={cols.map(({ key, label, width }) => ({ key, label, width }))} defaultVisible={DEFAULT_VISIBLE}
        sortFieldOptions={cols.filter((c) => c.num || c.key === 'name').map((c) => ({ value: c.key, label: c.label }))}
        title="Customize columns"
      />
    </div>
  )
}

// ── Column definitions (~45) ──────────────────────────────────────────────
const DEFAULT_VISIBLE = ['name', 'status', 'type', 'marketplace', 'budget', 'deliveryStatus', 'impressions', 'clicks', 'ctr', 'spend', 'cpc', 'orders', 'sales', 'acos', 'roas', 'marginPct', 'actions']

function COLUMN_DEFS(
  budgetEdits: Record<string, string>, setBudgetEdits: React.Dispatch<React.SetStateAction<Record<string, string>>>,
  saveBudget: (c: CampaignBase) => void, toggleStatus: (c: CampaignBase) => void, busy: string | null,
): ColDef[] {
  return [
    { key: 'name', label: 'Campaign', width: 280, render: (r) => <Link href={`/marketing/advertising/campaigns/${r.base.id}`} className="font-medium text-blue-600 hover:underline truncate block max-w-[260px]">{r.base.name}</Link> },
    { key: 'status', label: 'Status', width: 100, render: (r) => <StatusChip status={r.base.status} /> },
    { key: 'type', label: 'Type', width: 60, render: (r) => <span className="text-xs text-slate-500">{r.base.type}</span> },
    { key: 'adProduct', label: 'Ad product', width: 150, render: (r) => <span className="text-xs text-slate-500">{r.base.adProduct ?? '—'}</span> },
    { key: 'marketplace', label: 'Market', width: 70, render: (r) => <span className="text-xs">{r.base.marketplace ?? '—'}</span> },
    { key: 'portfolio', label: 'Portfolio', width: 120, render: (r) => <span className="text-xs text-slate-500">{r.base.portfolioName ?? '—'}</span> },
    { key: 'biddingStrategy', label: 'Bid strategy', width: 130, render: (r) => <span className="text-xs text-slate-500">{r.base.biddingStrategy}</span> },
    { key: 'budget', label: 'Budget', width: 110, align: 'right', num: true, render: (r) => {
      const editing = budgetEdits[r.base.id] != null
      return editing ? (
        <span className="inline-flex items-center gap-1">€<input autoFocus type="number" step="0.01" value={budgetEdits[r.base.id]} onChange={(e) => setBudgetEdits((s) => ({ ...s, [r.base.id]: e.target.value }))} onKeyDown={(e) => { if (e.key === 'Enter') saveBudget(r.base); if (e.key === 'Escape') setBudgetEdits((s) => { const { [r.base.id]: _, ...rest } = s; return rest }) }} onBlur={() => saveBudget(r.base)} className="w-16 px-1 py-0.5 text-right text-xs rounded border border-blue-400 bg-white dark:bg-slate-900" disabled={busy === r.base.id} /></span>
      ) : <button onClick={() => setBudgetEdits((s) => ({ ...s, [r.base.id]: (r.budgetC / 100).toFixed(2) }))} className="hover:underline decoration-dotted">{eur(r.budgetC)}/d</button>
    } },
    { key: 'deliveryStatus', label: 'Delivery', width: 130, render: (r) => <span className="text-xs text-slate-500">{r.base.deliveryStatus ?? '—'}{r.base.deliveryReasons?.length ? <span className="text-rose-400"> · {r.base.deliveryReasons[0]}</span> : null}</span> },
    { key: 'impressions', label: 'Impressions', width: 100, align: 'right', num: true, render: (r) => num(r.impressions) },
    { key: 'clicks', label: 'Clicks', width: 80, align: 'right', num: true, render: (r) => num(r.clicks) },
    { key: 'ctr', label: 'CTR', width: 70, align: 'right', num: true, render: (r) => pct(r.ctr, 2) },
    { key: 'spend', label: 'Spend', width: 90, align: 'right', num: true, render: (r) => eur(r.spendC) },
    { key: 'cpc', label: 'CPC', width: 70, align: 'right', num: true, render: (r) => eur(r.cpc) },
    { key: 'orders', label: 'Orders', width: 70, align: 'right', num: true, render: (r) => num(r.orders) },
    { key: 'units', label: 'Units', width: 70, align: 'right', num: true, render: (r) => num(r.units) },
    { key: 'cvr', label: 'CVR', width: 70, align: 'right', num: true, render: (r) => pct(r.cvr, 2) },
    { key: 'sales', label: 'Sales', width: 100, align: 'right', num: true, render: (r) => eur(r.salesC) },
    { key: 'aov', label: 'AOV', width: 80, align: 'right', num: true, render: (r) => eur(r.aov) },
    { key: 'acos', label: 'ACOS', width: 80, align: 'right', num: true, render: (r) => <span className={r.acos != null && r.acos > 0.5 ? 'text-rose-600' : ''}>{pct(r.acos)}</span> },
    { key: 'roas', label: 'ROAS', width: 70, align: 'right', num: true, render: (r) => x2(r.roas) },
    { key: 'trueProfit', label: 'True profit', width: 100, align: 'right', num: true, render: (r) => eur(r.base.trueProfitCents) },
    { key: 'marginPct', label: 'Margin %', width: 90, align: 'right', num: true, render: (r) => <span className={r.marginPct != null ? (r.marginPct >= 0.15 ? 'text-emerald-600' : r.marginPct >= 0.05 ? 'text-amber-600' : 'text-rose-600') : ''}>{pct(r.marginPct)}</span> },
    { key: 'ntbOrders', label: 'NTB orders', width: 90, align: 'right', num: true, render: (r) => num(r.ntbOrders) },
    { key: 'ntbSales', label: 'NTB sales', width: 90, align: 'right', num: true, render: (r) => eur(r.ntbSalesC) },
    { key: 'viewImpr', label: 'Viewable impr', width: 110, align: 'right', num: true, render: (r) => num(r.viewImpr) },
    { key: 'dpv', label: 'Detail views', width: 100, align: 'right', num: true, render: (r) => num(r.dpv) },
    { key: 'startDate', label: 'Start', width: 100, render: (r) => <span className="text-xs text-slate-400">{r.base.startDate?.slice(0, 10) ?? '—'}</span> },
    { key: 'endDate', label: 'End', width: 100, render: (r) => <span className="text-xs text-slate-400">{r.base.endDate?.slice(0, 10) ?? '—'}</span> },
    { key: 'lastSynced', label: 'Last synced', width: 130, render: (r) => <span className="text-xs text-slate-400">{r.base.lastSyncedAt ? new Date(r.base.lastSyncedAt).toLocaleString() : '—'}</span> },
    { key: 'actions', label: '', width: 50, locked: true, render: (r) => <button disabled={busy === r.base.id} onClick={() => toggleStatus(r.base)} title={r.base.status === 'ENABLED' ? 'Pause' : 'Enable'} className="p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40">{r.base.status === 'ENABLED' ? <Pause size={14} className="text-amber-600" /> : <Play size={14} className="text-emerald-600" />}</button> },
  ]
}
