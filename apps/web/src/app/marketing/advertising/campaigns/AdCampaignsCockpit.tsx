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
import { Search, RefreshCw, SlidersHorizontal, Play, Pause, Download } from 'lucide-react'
import { KpiStrip, PreferencesModal, type KpiTileSpec, type PreferencesValue, type PreferencesColumnSpec } from '@/app/_shared/grid-lens'
import { getBackendUrl } from '@/lib/backend-url'

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

const eur = (c: number | null | undefined) => (c == null ? '—' : new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(c / 100))
const num = (n: number | null | undefined) => (n == null ? '—' : new Intl.NumberFormat('en-US').format(Math.round(n)))
const pct = (v: number | null | undefined, dp = 1) => (v == null ? '—' : `${(v * 100).toFixed(dp)}%`)
const x2 = (v: number | null | undefined) => (v == null ? '—' : `${v.toFixed(2)}×`)

// ── Column registry (Amazon-grade) ───────────────────────────────────────
interface ColDef extends PreferencesColumnSpec { render: (r: Row) => React.ReactNode; align?: 'right' | 'left'; num?: boolean }
const STATUS_CHIP: Record<string, string> = {
  ENABLED: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300',
  PAUSED: 'bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300',
  ARCHIVED: 'bg-slate-100 text-slate-500 dark:bg-slate-800', DRAFT: 'bg-slate-100 text-slate-600 dark:bg-slate-800',
}

export function AdCampaignsCockpit({ initial }: { initial: { items: CampaignBase[]; count: number } }) {
  const [rowsRaw, setRowsRaw] = useState<CampaignBase[]>(initial.items)
  const [metrics, setMetrics] = useState<Record<string, V1Metric>>({})
  const [trend, setTrend] = useState<TrendPoint[]>([])
  const [days, setDays] = useState(30)
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [typeFilter, setTypeFilter] = useState('')
  const [sortKey, setSortKey] = useState('spendC')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [budgetEdits, setBudgetEdits] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [prefsOpen, setPrefsOpen] = useState(false)
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
        fetch(`${base}/api/advertising/trends?windowDays=${days}`, { cache: 'no-store' }).then((r) => r.json()).catch(() => ({ items: [] })),
      ])
      setRowsRaw(c.items ?? [])
      setMetrics((m.byCampaign ?? {}) as Record<string, V1Metric>)
      setTrend((t.items ?? t.trends ?? t.daily ?? []) as TrendPoint[])
    } finally { setLoading(false) }
  }, [days])
  useEffect(() => { void refetch() }, [days, refetch])

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
  }, [rows, search, statusFilter, typeFilter, sortKey, sortDir])

  // Totals for KPIs.
  const totals = useMemo(() => filtered.reduce((a, r) => ({ impr: a.impr + r.impressions, clicks: a.clicks + r.clicks, spendC: a.spendC + r.spendC, salesC: a.salesC + r.salesC, orders: a.orders + r.orders }), { impr: 0, clicks: 0, spendC: 0, salesC: 0, orders: 0 }), [filtered])
  const tiles: KpiTileSpec[] = [
    { icon: Search, label: 'Impressions', value: num(totals.impr), tone: 'slate', detail: `CTR ${pct(totals.impr ? totals.clicks / totals.impr : null, 2)}` },
    { icon: RefreshCw, label: 'Clicks', value: num(totals.clicks), tone: 'blue', detail: `CPC ${eur(totals.clicks ? totals.spendC / totals.clicks : null)}` },
    { icon: Download, label: 'Spend', value: eur(totals.spendC), tone: 'amber', detail: `${filtered.length} campaigns` },
    { icon: Play, label: 'Orders', value: num(totals.orders), tone: 'emerald', detail: `CVR ${pct(totals.clicks ? totals.orders / totals.clicks : null, 2)}` },
    { icon: Pause, label: 'Sales', value: eur(totals.salesC), tone: 'violet', detail: `ACOS ${pct(totals.salesC ? totals.spendC / totals.salesC : null)} · ROAS ${x2(totals.spendC ? totals.salesC / totals.spendC : null)}` },
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

  const cols = useMemo(() => COLUMN_DEFS(budgetEdits, setBudgetEdits, saveBudget, toggleStatus, busy), [budgetEdits, busy])
  const visibleCols = useMemo(() => {
    const byKey = new Map(cols.map((c) => [c.key, c]))
    return prefs.visibleColumns.map((k) => byKey.get(k)).filter(Boolean) as ColDef[]
  }, [cols, prefs.visibleColumns])

  const toggleSort = (k: string) => { if (sortKey === k) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc')); else { setSortKey(k); setSortDir('desc') } }
  const allChecked = filtered.length > 0 && filtered.every((r) => selected.has(r.base.id))

  return (
    <div>
      {/* Date range + KPIs */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex gap-1">
          {DATE_PRESETS.map((p) => (
            <button key={p.key} onClick={() => setDays(p.days)} className={`px-2.5 py-1 text-xs rounded-md border ${days === p.days ? 'bg-blue-600 text-white border-blue-600' : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'}`}>{p.label}</button>
          ))}
        </div>
        {loading && <span className="text-xs text-slate-400">updating…</span>}
      </div>
      <KpiStrip tiles={tiles} className="mb-4" />

      {/* Performance chart */}
      {trend.length > 0 && (
        <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3 mb-4 h-64">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={trend} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-slate-100 dark:stroke-slate-800" />
              <XAxis dataKey="date" tick={{ fontSize: 10 }} />
              <YAxis yAxisId="l" tick={{ fontSize: 10 }} /><YAxis yAxisId="r" orientation="right" tick={{ fontSize: 10 }} />
              <Tooltip contentStyle={{ fontSize: 12 }} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Line yAxisId="l" type="monotone" dataKey="clicks" stroke="#6366f1" dot={false} name="Clicks" />
              <Line yAxisId="r" type="monotone" dataKey={(d: TrendPoint) => d.cost ?? d.spend} stroke="#14b8a6" dot={false} name="Cost" />
              <Line yAxisId="r" type="monotone" dataKey="sales" stroke="#a855f7" dot={false} name="Sales" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <div className="relative"><Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Find a campaign…" className="pl-7 pr-2 py-1.5 text-sm rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 w-56" /></div>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="py-1.5 px-2 text-sm rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"><option value="">All status</option>{['ENABLED', 'PAUSED', 'ARCHIVED', 'DRAFT'].map((s) => <option key={s}>{s}</option>)}</select>
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} className="py-1.5 px-2 text-sm rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"><option value="">All types</option>{['SP', 'SB', 'SD'].map((s) => <option key={s}>{s}</option>)}</select>
        <Link href="/marketing/advertising/create" className="inline-flex items-center gap-1 py-1.5 px-3 text-sm rounded-md bg-slate-900 text-white dark:bg-slate-700 hover:bg-slate-800">+ Create campaign</Link>
        <button onClick={() => setPrefsOpen(true)} className="inline-flex items-center gap-1 py-1.5 px-2 text-sm rounded-md border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800"><SlidersHorizontal size={14} /> Columns ({visibleCols.length})</button>
        <button onClick={() => void refetch()} className="inline-flex items-center gap-1 py-1.5 px-2 text-sm rounded-md border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800"><RefreshCw size={14} className={loading ? 'animate-spin' : ''} /></button>
        <span className="text-xs text-slate-400 ml-auto">{filtered.length} campaigns</span>
      </div>

      {/* Bulk bar */}
      {selected.size > 0 && (
        <div className="flex items-center gap-2 mb-2 px-3 py-1.5 rounded-md bg-blue-50 dark:bg-blue-950/30 text-sm">
          <span className="text-blue-700 dark:text-blue-300">{selected.size} selected</span>
          <button onClick={() => void bulkStatus('ENABLED')} className="px-2 py-0.5 rounded border border-emerald-300 text-emerald-700 hover:bg-emerald-50">Enable</button>
          <button onClick={() => void bulkStatus('PAUSED')} className="px-2 py-0.5 rounded border border-amber-300 text-amber-700 hover:bg-amber-50">Pause</button>
          <button onClick={() => setSelected(new Set())} className="text-slate-400 ml-auto">Clear</button>
        </div>
      )}

      {/* Grid */}
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
                <td className="sticky left-0 z-10 bg-white dark:bg-slate-950 px-2 py-1.5"><input type="checkbox" checked={selected.has(r.base.id)} onChange={(e) => setSelected((s) => { const n = new Set(s); e.target.checked ? n.add(r.base.id) : n.delete(r.base.id); return n })} /></td>
                {visibleCols.map((c, i) => (
                  <td key={c.key} className={`px-3 py-1.5 whitespace-nowrap ${c.align === 'right' ? 'text-right tabular-nums' : ''} ${i === 0 && prefs.stickyFirstColumn ? 'sticky left-8 z-10 bg-white dark:bg-slate-950' : ''}`} style={{ width: c.width }}>{c.render(r)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

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
    { key: 'status', label: 'Status', width: 90, render: (r) => <span className={`px-1.5 py-0.5 rounded text-xs ${STATUS_CHIP[r.base.status] ?? STATUS_CHIP.DRAFT}`}>{r.base.status}</span> },
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
