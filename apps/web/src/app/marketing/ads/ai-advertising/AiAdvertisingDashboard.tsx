'use client'

/**
 * AIAD.3 — AI Advertising dashboard, console-native rebuild.
 *
 * The first version of this page was a pixel-matched Helium 10 clone: its own header, a hero
 * with a fake video player, a footer, a hand-rolled table with dead controls, and a 1320px
 * width cap. All of that is gone. The page is now composed from the console's own parts —
 * AdsPageHeader · MetricStrip · MetricChart (the ONE time-series chart) · AdsDataGrid — at
 * full width, with URL-linkable sort/filter/search/page state and a goal drawer that shows
 * the AI's actual decisions (the transparency the competitors' lockout model hides).
 *
 * Data: `/ai-goals` (rows) + `/ai-goals/summary` (per-goal perf, series, totals + previous-
 * period deltas, pending proposals) + `/ai-goals/:id` (drawer) + the plan decision SSE.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Plus, Archive } from 'lucide-react'
import { AdsPageHeader } from '../_shell/AdsPageHeader'
import { useAdsMarketplace, ALL_MARKETS } from '../_shell/MarketplaceContext'
import { AdsDataGrid, type GridColumn, type GridFilter, type FilterState } from '../campaigns/_grid/AdsDataGrid'
import { MetricChart, type ChartMetric } from '../_shared/MetricChart'
import { MetricStrip, type Metric } from '@/design-system/components/MetricStrip'
import { EmptyState } from '@/design-system/components/EmptyState'
import { IconAtom } from '../_shell/builder-icons'
import { getBackendUrl } from '@/lib/backend-url'
import { GoalDrawer } from './GoalDrawer'
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/primitives.css'
import '@/design-system/styles/components.css'
import './ai-advertising.css'

type Goal = {
  id: string; name: string; aiTarget: string; budgetMode: string; advancedAllocation: boolean
  status: string; productCount: number; dailyBudgetCents: number; startDate: string
  materializedAt: string | null; planId: string | null; campaignCount: number; aiControl: string | null
}
type GoalPerf = {
  goalId: string; spendCents: number; salesCents: number; orders: number; clicks: number; impressions: number
  acosPct: number | null; utilizationPct: number | null; utilizationDate: string | null; pendingProposals: number
}
type Totals = { spendCents: number; salesCents: number; orders: number; acosPct: number | null }
type Summary = {
  goals: GoalPerf[]
  series: Array<{ date: string; spendCents: number; salesCents: number; orders: number; acosPct: number | null }>
  totals: Totals; prevTotals: Totals
}

const TARGET_LABEL: Record<string, string> = { IMPRESSION: 'Impression & Click', SALES: 'Sales', ROAS: 'ROAS' }
const MODE_LABEL: Record<string, string> = { STRICT: 'Strict Control', SHARED: 'Shared Budget' }
const CONTROL_LABEL: Record<string, { label: string; cls: string }> = {
  SUGGEST: { label: 'Propose', cls: 'propose' }, AUTO: { label: 'Auto', cls: 'auto' }, OFF: { label: 'Off', cls: 'off' },
}
const CHART_METRICS: ChartMetric[] = [
  { key: 'spend', label: 'Spend', unit: 'eur' },
  { key: 'sales', label: 'Sales', unit: 'eur' },
  { key: 'acos', label: 'ACoS', unit: 'pct' },
  { key: 'orders', label: 'PPC Orders', unit: 'count' },
]
const METRICS_STORE = 'aiad-chart-metrics'

const eur2 = (cents: number) => `€${(cents / 100).toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const fmtDay = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) }
const dayParam = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** Delta vs the previous period. `goodDown` marks metrics where a fall is the good direction. */
function delta(cur: number | null, prev: number | null, goodDown = false): Metric['delta'] {
  if (cur == null || prev == null || prev === 0) return undefined
  const pct = ((cur - prev) / Math.abs(prev)) * 100
  if (!Number.isFinite(pct)) return undefined
  const sign = pct >= 0 ? '+' : ''
  return { value: `${sign}${pct.toFixed(1)}%`, positive: goodDown ? pct <= 0 : pct >= 0 }
}

export function AiAdvertisingDashboard() {
  const router = useRouter()
  const pathname = usePathname()
  const sp = useSearchParams()
  const { markets: marketList, scopeMarket, setScopeMarket } = useAdsMarketplace()
  const markets = useMemo(() => marketList.map((m) => m.code), [marketList])

  // URL-seeded state (read once at mount; the grid re-syncs itself when the seeds change).
  const seed = useRef({
    sort: sp.get('sort') ?? 'startDate',
    dir: (sp.get('dir') === 'asc' ? 'asc' : 'desc') as 'asc' | 'desc',
    q: sp.get('q') ?? '',
    page: Math.max(1, Number(sp.get('p')) || 1),
    filters: (() => {
      const f: FilterState = {}
      for (const k of ['status', 'target', 'mode'] as const) { const v = sp.get(k); if (v) f[k] = v }
      return f
    })(),
    goal: sp.get('goal'),
  }).current

  const [dateRange, setDateRange] = useState(() => { const e = new Date(); e.setHours(0, 0, 0, 0); const s = new Date(e); s.setDate(s.getDate() - 29); return { start: s, end: e } })
  const [goals, setGoals] = useState<Goal[]>([])
  const [goalsLoading, setGoalsLoading] = useState(true)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [selMetrics, setSelMetrics] = useState<string[]>(() => {
    if (typeof window !== 'undefined') {
      try { const s = JSON.parse(localStorage.getItem(METRICS_STORE) ?? '') as string[]; if (Array.isArray(s) && s.length) return s } catch { /* default below */ }
    }
    return ['spend', 'sales', 'acos', 'orders']
  })
  const pickMetrics = (keys: string[]) => { setSelMetrics(keys); try { localStorage.setItem(METRICS_STORE, JSON.stringify(keys)) } catch { /* ignore */ } }
  const [drawerGoal, setDrawerGoal] = useState<string | null>(seed.goal)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<string | null>(null)
  const [urlBits, setUrlBits] = useState({ sort: seed.sort, dir: seed.dir, q: seed.q, page: seed.page, filters: seed.filters })

  // Write the view back to the address bar so a copied link reproduces it.
  useEffect(() => {
    const ps = new URLSearchParams()
    if (urlBits.sort !== 'startDate' || urlBits.dir !== 'desc') { ps.set('sort', urlBits.sort); ps.set('dir', urlBits.dir) }
    if (urlBits.q) ps.set('q', urlBits.q)
    if (urlBits.page > 1) ps.set('p', String(urlBits.page))
    for (const k of ['status', 'target', 'mode'] as const) { const v = urlBits.filters[k]; if (typeof v === 'string' && v) ps.set(k, v) }
    if (drawerGoal) ps.set('goal', drawerGoal)
    const qs = ps.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }, [urlBits, drawerGoal, pathname, router])

  const mkParam = scopeMarket !== ALL_MARKETS ? `marketplace=${encodeURIComponent(scopeMarket)}` : ''
  useEffect(() => {
    let alive = true
    setGoalsLoading(true)
    fetch(`${getBackendUrl()}/api/advertising/ai-goals${mkParam ? `?${mkParam}` : ''}`, { cache: 'no-store' })
      .then((r) => r.json()).then((j) => { if (alive) setGoals(Array.isArray(j?.items) ? j.items : []) })
      .catch(() => {}).finally(() => { if (alive) setGoalsLoading(false) })
    return () => { alive = false }
  }, [mkParam, refreshKey])
  useEffect(() => {
    let alive = true
    const q = [`start=${dayParam(dateRange.start)}`, `end=${dayParam(dateRange.end)}`, mkParam].filter(Boolean).join('&')
    fetch(`${getBackendUrl()}/api/advertising/ai-goals/summary?${q}`, { cache: 'no-store' })
      .then((r) => r.json()).then((j) => { if (alive && j && Array.isArray(j.series)) setSummary(j as Summary) }).catch(() => {})
    return () => { alive = false }
  }, [dateRange, mkParam, refreshKey])

  const perfByGoal = useMemo(() => new Map((summary?.goals ?? []).map((g) => [g.goalId, g])), [summary])
  const totals = summary?.totals ?? { spendCents: 0, salesCents: 0, orders: 0, acosPct: null }
  const prev = summary?.prevTotals ?? { spendCents: 0, salesCents: 0, orders: 0, acosPct: null }
  const pendingTotal = (summary?.goals ?? []).reduce((n, g) => n + (g.pendingProposals || 0), 0)
  const activeGoals = goals.filter((g) => g.status === 'ACTIVE' && g.materializedAt).length

  const chartData = useMemo(() => (summary?.series ?? []).map((s) => ({
    date: s.date, spend: s.spendCents / 100, sales: s.salesCents / 100,
    acos: s.acosPct != null ? s.acosPct / 100 : null, orders: s.orders,
  })), [summary])

  const stripMetrics: Metric[] = [
    { label: 'Spend', value: eur2(totals.spendCents), delta: delta(totals.spendCents, prev.spendCents, true) },
    { label: 'Sales', value: eur2(totals.salesCents), delta: delta(totals.salesCents, prev.salesCents) },
    { label: 'ACoS', value: totals.acosPct == null ? '—' : `${totals.acosPct.toFixed(2)}%`, delta: delta(totals.acosPct, prev.acosPct, true) },
    { label: 'PPC Orders', value: String(totals.orders), delta: delta(totals.orders, prev.orders) },
    { label: 'Active Goals', value: String(activeGoals) },
    { label: 'Pending Proposals', value: pendingTotal > 0 ? <Link className="aiad-metric-link" href="/marketing/ads/suggestions">{pendingTotal}</Link> : '0' },
  ]

  const materialize = async (id: string) => {
    if (busy) return
    setBusy(id)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/ai-goals/${id}/materialize`, { method: 'POST' })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || j?.ok === false) throw new Error(j?.error || 'Launch failed')
      setRefreshKey((k) => k + 1)
    } catch { /* surfaced by the still-unlaunched state */ } finally { setBusy(null) }
  }

  const archive = async (ids: string[], clear: () => void) => {
    if (!ids.length || !window.confirm(`Archive ${ids.length} goal${ids.length === 1 ? '' : 's'}? Their campaigns stay live — only the goal is retired.`)) return
    await Promise.all(ids.map((id) => fetch(`${getBackendUrl()}/api/advertising/ai-goals/${id}/archive`, { method: 'POST' }).catch(() => {})))
    clear(); setRefreshKey((k) => k + 1)
  }

  const statusOf = (g: Goal) => (!g.materializedAt ? 'Not launched' : g.status === 'ACTIVE' ? 'Enabled' : g.status === 'DRAFT' ? 'Draft' : g.status)

  const columns: GridColumn<Goal>[] = [
    { key: 'aiTarget', label: 'AI Target', sortable: true, sortValue: (g) => TARGET_LABEL[g.aiTarget] ?? g.aiTarget, render: (g) => TARGET_LABEL[g.aiTarget] ?? g.aiTarget },
    {
      key: 'aiControl', label: 'AI Control', tip: "The goal's autonomy — the same vocabulary the Control Room governs. Propose = every decision needs your approval.",
      sortable: true, sortValue: (g) => g.aiControl ?? '',
      render: (g) => { const c = g.aiControl ? CONTROL_LABEL[g.aiControl] ?? { label: g.aiControl, cls: 'off' } : null; return c ? <span className={`aiad-ctl ${c.cls}`}>{c.label}</span> : <span className="aiad-ctl off">—</span> },
    },
    {
      key: 'status', label: 'Status', sortable: true, sortValue: (g) => statusOf(g),
      render: (g) => g.materializedAt
        ? <span className={`aiad-status${g.status === 'ACTIVE' ? '' : ' muted'}`}>{statusOf(g)}</span>
        : (
          <span className="aiad-status-wrap">
            <span className="aiad-status warn">Not launched</span>
            <button type="button" className="h10-am-btn primary aiad-launch" disabled={busy === g.id} onClick={(e) => { e.stopPropagation(); void materialize(g.id) }}>{busy === g.id ? 'Launching…' : 'Launch'}</button>
          </span>
        ),
    },
    { key: 'startDate', label: 'Start Date', sortable: true, sortValue: (g) => new Date(g.startDate).getTime(), render: (g) => fmtDay(g.startDate) },
    { key: 'budgetMode', label: 'Budget Mode', sortable: true, sortValue: (g) => g.budgetMode, render: (g) => MODE_LABEL[g.budgetMode] ?? g.budgetMode, defaultHidden: true },
    {
      key: 'dailyBudget', label: 'Daily Budget', metric: true, sortable: true, sortValue: (g) => g.dailyBudgetCents,
      render: (g) => eur2(g.dailyBudgetCents), total: (rows) => eur2(rows.reduce((n, r) => n + r.dailyBudgetCents, 0)),
    },
    {
      key: 'utilization', label: 'Budget Utilization', tip: 'Latest reported day’s spend against the daily budget. Report data lags a day or two — the date is in the cell tooltip.',
      metric: true, sortable: true, sortValue: (g) => perfByGoal.get(g.id)?.utilizationPct ?? -1,
      render: (g) => {
        const p = perfByGoal.get(g.id)
        if (p?.utilizationPct == null) return '—'
        const pct = p.utilizationPct
        return (
          <span className={`aiad-util${pct > 100 ? ' hot' : ''}`} title={p.utilizationDate ? `Latest reported day: ${p.utilizationDate}` : undefined}>
            <span className="bar"><i style={{ width: `${Math.min(100, pct)}%` }} /></span>
            <span className="pct">{pct}%</span>
          </span>
        )
      },
    },
    {
      key: 'spend', label: 'Spend', metric: true, sortable: true, sortValue: (g) => perfByGoal.get(g.id)?.spendCents ?? -1, filterValue: (g) => (perfByGoal.get(g.id)?.spendCents ?? 0) / 100,
      render: (g) => { const p = perfByGoal.get(g.id); return p ? eur2(p.spendCents) : '—' },
      total: (rows) => eur2(rows.reduce((n, r) => n + (perfByGoal.get(r.id)?.spendCents ?? 0), 0)),
    },
    {
      key: 'sales', label: 'Sales', metric: true, sortable: true, sortValue: (g) => perfByGoal.get(g.id)?.salesCents ?? -1,
      render: (g) => { const p = perfByGoal.get(g.id); return p ? eur2(p.salesCents) : '—' },
      total: (rows) => eur2(rows.reduce((n, r) => n + (perfByGoal.get(r.id)?.salesCents ?? 0), 0)),
    },
    {
      key: 'acos', label: 'ACoS', metric: true, sortable: true, sortValue: (g) => perfByGoal.get(g.id)?.acosPct ?? -1, filterValue: (g) => perfByGoal.get(g.id)?.acosPct ?? 0,
      render: (g) => { const p = perfByGoal.get(g.id); return p?.acosPct == null ? '—' : `${p.acosPct.toFixed(2)}%` },
    },
    {
      key: 'orders', label: 'Orders', metric: true, sortable: true, sortValue: (g) => perfByGoal.get(g.id)?.orders ?? -1,
      render: (g) => { const p = perfByGoal.get(g.id); return p ? String(p.orders) : '—' },
      total: (rows) => String(rows.reduce((n, r) => n + (perfByGoal.get(r.id)?.orders ?? 0), 0)),
    },
    {
      key: 'proposals', label: 'Proposals', tip: 'Pending AI proposals for this goal, waiting for your approval.',
      metric: true, sortable: true, sortValue: (g) => perfByGoal.get(g.id)?.pendingProposals ?? 0,
      render: (g) => {
        const n = perfByGoal.get(g.id)?.pendingProposals ?? 0
        return n > 0 ? <Link className="aiad-metric-link" href="/marketing/ads/suggestions" onClick={(e) => e.stopPropagation()}>{n}</Link> : '0'
      },
      total: (rows) => String(rows.reduce((n, r) => n + (perfByGoal.get(r.id)?.pendingProposals ?? 0), 0)),
    },
  ]

  const filters: GridFilter[] = [
    { key: 'status', label: 'Status', kind: 'select', placeholder: 'All', value: (r) => statusOf(r as Goal), options: [{ value: 'Enabled', label: 'Enabled' }, { value: 'Not launched', label: 'Not launched' }, { value: 'Draft', label: 'Draft' }] },
    { key: 'target', label: 'AI Target', kind: 'select', placeholder: 'All', value: (r) => (r as Goal).aiTarget, options: Object.entries(TARGET_LABEL).map(([value, label]) => ({ value, label })) },
    { key: 'mode', label: 'Budget Mode', kind: 'select', placeholder: 'All', value: (r) => (r as Goal).budgetMode, options: Object.entries(MODE_LABEL).map(([value, label]) => ({ value, label })) },
    { key: 'spend', label: 'Spend', kind: 'range', unit: '€', value: (r) => (perfByGoal.get((r as Goal).id)?.spendCents ?? 0) / 100 },
    { key: 'acos', label: 'ACoS', kind: 'range', unit: '%', value: (r) => perfByGoal.get((r as Goal).id)?.acosPct ?? 0 },
  ]

  const csv = () => {
    const head = ['Goal', 'Products', 'Campaigns', 'AI Target', 'AI Control', 'Status', 'Start Date', 'Budget Mode', 'Daily Budget EUR', 'Utilization %', 'Spend EUR', 'Sales EUR', 'ACoS %', 'Orders', 'Pending Proposals']
    const cell = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
    const body = goals.map((g) => {
      const p = perfByGoal.get(g.id)
      return [g.name, g.productCount, g.campaignCount, TARGET_LABEL[g.aiTarget] ?? g.aiTarget, g.aiControl ?? '', statusOf(g), g.startDate.slice(0, 10), MODE_LABEL[g.budgetMode] ?? g.budgetMode,
        (g.dailyBudgetCents / 100).toFixed(2), p?.utilizationPct ?? '', p ? (p.spendCents / 100).toFixed(2) : '', p ? (p.salesCents / 100).toFixed(2) : '', p?.acosPct ?? '', p?.orders ?? '', p?.pendingProposals ?? 0]
    })
    const blob = new Blob([[head, ...body].map((r) => r.map(cell).join(',')).join('\n')], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `ai-advertising-goals-${dayParam(new Date())}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const renderFirst = (g: Goal): ReactNode => (
    <span className="aiad-goal">
      <span className="t">{g.name}</span>
      <span className="sub">{g.productCount} product{g.productCount === 1 ? '' : 's'}{g.campaignCount > 0 ? ` · ${g.campaignCount} campaigns` : ''}</span>
    </span>
  )

  return (
    <div className="aiad-page">
      <AdsPageHeader
        title="AI Advertising"
        subtitle="Goal-based autonomous campaigns — set the target, the AI builds, proposes and earns autonomy."
        markets={markets} market={scopeMarket} onMarketChange={setScopeMarket}
        showDataSync={false}
        dateRange={dateRange} onDateRange={(start, end) => setDateRange({ start, end })}
        primaryAction={{ label: 'Product Goal', icon: <Plus size={14} />, href: '/marketing/ads/ai-advertising/new-goal' }}
      />

      <MetricStrip metrics={stripMetrics} />

      <MetricChart
        title="Overview"
        subtitle={`${fmtDay(dateRange.start.toISOString())} – ${fmtDay(dateRange.end.toISOString())} · all AI-managed campaigns`}
        data={chartData}
        metrics={CHART_METRICS}
        selected={selMetrics}
        onSelectedChange={pickMetrics}
        loading={!summary}
        emptyLabel="No performance data yet — the chart fills in as the AI's campaigns start serving."
        storageKey="aiad-chart"
      />

      <AdsDataGrid<Goal>
        rows={goals}
        loading={goalsLoading}
        rowId={(g) => g.id}
        noun="Goal"
        firstColLabel="Goal"
        renderFirst={renderFirst}
        firstSortValue={(g) => g.name}
        columns={columns}
        filters={filters}
        initialFilters={seed.filters}
        onFilterChange={(f) => setUrlBits((b) => ({ ...b, filters: f as FilterState }))}
        defaultSort={{ key: seed.sort, dir: seed.dir }}
        onSortChange={(s) => setUrlBits((b) => ({ ...b, sort: s?.key ?? 'startDate', dir: s?.dir ?? 'desc' }))}
        initialSearch={seed.q}
        onSearchChange={(q) => setUrlBits((b) => ({ ...b, q }))}
        initialPage={seed.page}
        onPageChange={(page) => setUrlBits((b) => ({ ...b, page }))}
        searchable
        searchPlaceholder="Search goals…"
        searchValue={(g) => g.name}
        selectable
        selected={selected}
        onSelectedChange={setSelected}
        selectionActions={(ids, clear) => (
          <button type="button" className="h10-am-btn" onClick={() => void archive(ids, clear)}><Archive size={13} /> Archive {ids.length}</button>
        )}
        exportable
        onExport={csv}
        customizable
        storageKey="aiad-goals-grid"
        showTotal
        enabledFirst={(g) => g.status === 'ACTIVE' && !!g.materializedAt}
        onRowClick={(g) => setDrawerGoal(g.id)}
        emptyNode={
          <EmptyState
            icon={<IconAtom size={30} />}
            title="No product goals yet"
            description="Pick products, a target and a budget — the AI builds the campaign structure, then proposes every optimization for your approval as data arrives."
            action={<Link className="h10-am-btn primary" href="/marketing/ads/ai-advertising/new-goal"><Plus size={13} /> Product Goal</Link>}
          />
        }
      />

      <GoalDrawer
        goalId={drawerGoal}
        onClose={() => setDrawerGoal(null)}
        onMutated={() => setRefreshKey((k) => k + 1)}
        onLaunch={(id) => void materialize(id)}
        launching={busy != null}
      />
    </div>
  )
}
