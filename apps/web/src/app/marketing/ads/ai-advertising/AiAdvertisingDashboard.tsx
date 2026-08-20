'use client'

/**
 * CBN — AI Advertising dashboard (the "get-started" page), matched to Helium 10 Ads.
 * Empty-state: header → Get Started hero → Overview (KPI strip + chart) → Goals table.
 * Reuses the shared `.h10-*` design system; "+ Product Goal" launches the AI Goal builder.
 *
 * AIAD.0/1 (2026-08-20) — the page now tells the truth: Overview + per-goal Spend/Sales/
 * ACoS/Orders/Utilization come from `/ai-goals/summary` (AmazonAdsDailyPerformance over each
 * goal's materialized campaigns). A goal that has no campaigns yet shows "Not launched" with
 * an inline Launch action (materialize), never fake zeros. "AI Control" reads the linked
 * AutopilotPlan's autonomy — the same vocabulary the Control Room governs.
 */
import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Video, ExternalLink, ChevronDown, Check, Plus, BookOpen, Download, SlidersHorizontal, Play, ChevronLeft, ChevronRight, ChevronsUpDown } from 'lucide-react'
import { ResponsiveContainer, ComposedChart, Line, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts'
import { DateRangePicker } from '../_shell/DateRangePicker'
import { IconAtom } from '../_shell/builder-icons'
import { getBackendUrl } from '@/lib/backend-url'
import './aiad-live.css'

const FLAG: Record<string, string> = { IT: '🇮🇹', DE: '🇩🇪', FR: '🇫🇷', ES: '🇪🇸', GB: '🇬🇧', UK: '🇬🇧', NL: '🇳🇱', SE: '🇸🇪', PL: '🇵🇱', BE: '🇧🇪', IE: '🇮🇪', TR: '🇹🇷', US: '🇺🇸' }
const MARKET_NAME: Record<string, string> = { IT: 'Italy', DE: 'Germany', FR: 'France', ES: 'Spain', GB: 'United Kingdom', UK: 'United Kingdom', NL: 'Netherlands', SE: 'Sweden', PL: 'Poland', BE: 'Belgium', IE: 'Ireland', TR: 'Türkiye', US: 'United States' }

const HERO_CHECKS = ['Sponsored Product campaign management', 'Real-time bid optimization', 'Smart budget allocation', 'Keyword discovery and removal']

// KPI dot colors sampled from the reference frames.
const KPI_META = [
  { key: 'spend', label: 'Spend', dot: '#138ae7' },
  { key: 'sales', label: 'Sales', dot: '#1a9796' },
  { key: 'acos', label: 'ACoS', dot: '#f94773' },
  { key: 'orders', label: 'PPC Orders', dot: '#5d24b8' },
] as const

// Goals table columns — H10 order, extended with the performance metrics past Spend
// (Sales / ACoS / Orders, per the AIAD.0 rollup). Start Date is the default sort.
const COLS: Array<{ key: string; label: string; beta?: boolean; sortable?: boolean; sorted?: boolean }> = [
  { key: 'goal', label: 'Goal' },
  { key: 'aiTarget', label: 'AI Target', beta: true },
  { key: 'aiControl', label: 'AI Control' },
  { key: 'status', label: 'Status', sortable: true },
  { key: 'startDate', label: 'Start Date', sortable: true, sorted: true },
  { key: 'budgetMode', label: 'Budget Mode' },
  { key: 'dailyBudget', label: 'Daily Budget', sortable: true },
  { key: 'budgetUtil', label: 'Budget Utilization' },
  { key: 'spend', label: 'Spend', sortable: true },
  { key: 'sales', label: 'Sales' },
  { key: 'acos', label: 'ACoS' },
  { key: 'orders', label: 'Orders' },
]

type Goal = {
  id: string; name: string; aiTarget: string; budgetMode: string; advancedAllocation: boolean
  status: string; productCount: number; dailyBudgetCents: number; startDate: string
  materializedAt: string | null; planId: string | null; campaignCount: number; aiControl: string | null
}
type GoalPerf = { goalId: string; spendCents: number; salesCents: number; orders: number; clicks: number; impressions: number; acosPct: number | null; utilizationPct: number | null; utilizationDate: string | null }
type Summary = {
  goals: GoalPerf[]
  series: Array<{ date: string; spendCents: number; salesCents: number; orders: number; acosPct: number | null }>
  totals: { spendCents: number; salesCents: number; orders: number; acosPct: number | null }
}
const TARGET_LABEL: Record<string, string> = { IMPRESSION: 'Impression & Click', SALES: 'Sales', ROAS: 'ROAS' }
const MODE_LABEL: Record<string, string> = { STRICT: 'Strict Control', SHARED: 'Shared Budget' }
const CONTROL_LABEL: Record<string, { label: string; cls: string }> = {
  SUGGEST: { label: 'Propose', cls: 'propose' }, AUTO: { label: 'Auto', cls: 'auto' }, OFF: { label: 'Off', cls: 'off' },
}
const eur2 = (cents: number) => `€${(cents / 100).toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const fmtDay = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) }
const dayParam = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

function AmazonMark() {
  return (
    <svg viewBox="0 0 24 16" width="16" height="11" aria-hidden style={{ display: 'block' }}>
      <text x="0" y="12" fontSize="13" fontWeight="700" fill="#232f3e" fontFamily="Arial, sans-serif">a</text>
      <path d="M2 13.5c3.2 2 7.5 2 10.6-.2" stroke="#ff9900" strokeWidth="1.6" fill="none" strokeLinecap="round" />
    </svg>
  )
}

function AccountSelect() {
  const [markets, setMarkets] = useState<string[]>(['IT'])
  const [sel, setSel] = useState('IT')
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let alive = true
    fetch(`${getBackendUrl()}/api/advertising/campaigns?limit=500`).then((r) => r.json()).then((j) => {
      if (!alive) return
      const ms = Array.from(new Set((j?.items ?? []).map((c: { marketplace?: string | null }) => (c.marketplace ?? '').toUpperCase()).filter(Boolean))) as string[]
      if (ms.length) { setMarkets(ms); setSel(ms.includes('IT') ? 'IT' : ms[0]) }
    }).catch(() => {})
    return () => { alive = false }
  }, [])
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h)
  }, [])
  const label = (m: string) => `${FLAG[m] ?? '🏳️'} ${MARKET_NAME[m] ?? m}`
  return (
    <div className="h10-aiad-acct" ref={ref}>
      <button type="button" className="h10-hbtn acct" onClick={() => setOpen((o) => !o)}>
        <AmazonMark /><span className="chip">{label(sel)}</span><ChevronDown size={15} />
      </button>
      {open && (
        <div className="h10-menu right">
          {markets.map((m) => (
            <button type="button" key={m} className={m === sel ? 'on' : ''} onClick={() => { setSel(m); setOpen(false) }}>{label(m)}</button>
          ))}
        </div>
      )}
    </div>
  )
}

/** Empty performance chart — faint axes + curves + centered "No data" (matches H10 empty state). */
function EmptyChart() {
  return (
    <div className="h10-aiad-chart">
      <svg viewBox="0 0 1000 220" preserveAspectRatio="none" aria-hidden>
        {[40, 90, 140, 190].map((y) => <line key={y} x1="10" y1={y} x2="990" y2={y} stroke="#eef1f5" strokeWidth="1" />)}
        <path d="M10 150 C 200 120, 360 90, 520 110 S 840 70, 990 95" fill="none" stroke="#eef1f5" strokeWidth="2" />
        <path d="M10 180 C 220 175, 380 150, 540 165 S 860 140, 990 150" fill="none" stroke="#f2f4f7" strokeWidth="2" />
      </svg>
      <span className="nodata">No data</span>
    </div>
  )
}

/** AIAD.0 — the live overview chart: Spend/Sales on the € axis, ACoS on %, Orders on its own hidden scale. */
function PerfChart({ series }: { series: Summary['series'] }) {
  if (!series.length) return <EmptyChart />
  const data = series.map((s) => ({
    date: s.date.slice(5), spend: s.spendCents / 100, sales: s.salesCents / 100,
    acos: s.acosPct, orders: s.orders,
  }))
  const fmt = (v: unknown, name: string) =>
    name === 'ACoS' ? (v == null ? '—' : `${Number(v).toFixed(2)}%`) : name === 'PPC Orders' ? `${v ?? 0}` : `€${Number(v ?? 0).toFixed(2)}`
  return (
    <div className="h10-aiad-chart live">
      <ResponsiveContainer width="100%" height={220}>
        <ComposedChart data={data} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="#eef1f5" vertical={false} />
          <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#8b93a2' }} tickLine={false} axisLine={{ stroke: '#e3e7ee' }} minTickGap={24} />
          <YAxis yAxisId="eur" tick={{ fontSize: 11, fill: '#8b93a2' }} tickLine={false} axisLine={false} tickFormatter={(v: number) => `€${v}`} width={54} />
          <YAxis yAxisId="pct" orientation="right" tick={{ fontSize: 11, fill: '#8b93a2' }} tickLine={false} axisLine={false} tickFormatter={(v: number) => `${v}%`} width={44} />
          <YAxis yAxisId="n" hide />
          <Tooltip formatter={(v, name) => [fmt(v, String(name)), String(name)]} labelStyle={{ fontSize: 12, fontWeight: 600 }} contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e3e7ee' }} />
          <Line yAxisId="eur" dataKey="spend" name="Spend" stroke="#138ae7" strokeWidth={2} dot={false} />
          <Line yAxisId="eur" dataKey="sales" name="Sales" stroke="#1a9796" strokeWidth={2} dot={false} />
          <Line yAxisId="pct" dataKey="acos" name="ACoS" stroke="#f94773" strokeWidth={2} dot={false} strokeDasharray="4 3" connectNulls />
          <Line yAxisId="n" dataKey="orders" name="PPC Orders" stroke="#5d24b8" strokeWidth={2} dot={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}

export function AiAdvertisingDashboard() {
  const [dateRange, setDateRange] = useState(() => { const e = new Date(); e.setHours(0, 0, 0, 0); const s = new Date(e); s.setDate(s.getDate() - 10); return { start: s, end: e } })
  const [tab, setTab] = useState<'ASIN' | 'Campaign'>('Campaign')
  const [goals, setGoals] = useState<Goal[]>([])
  const [summary, setSummary] = useState<Summary | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<{ text: string; err: boolean } | null>(null)

  useEffect(() => {
    let alive = true
    fetch(`${getBackendUrl()}/api/advertising/ai-goals`).then((r) => r.json()).then((j) => { if (alive) setGoals(Array.isArray(j?.items) ? j.items : []) }).catch(() => {})
    return () => { alive = false }
  }, [refreshKey])
  useEffect(() => {
    let alive = true
    const q = `start=${dayParam(dateRange.start)}&end=${dayParam(dateRange.end)}`
    fetch(`${getBackendUrl()}/api/advertising/ai-goals/summary?${q}`, { cache: 'no-store' })
      .then((r) => r.json()).then((j) => { if (alive && j && Array.isArray(j.series)) setSummary(j as Summary) }).catch(() => {})
    return () => { alive = false }
  }, [dateRange, refreshKey])

  const perfByGoal = new Map((summary?.goals ?? []).map((g) => [g.goalId, g]))
  const totals = summary?.totals ?? { spendCents: 0, salesCents: 0, orders: 0, acosPct: null }
  const kpiValue: Record<string, string> = {
    spend: eur2(totals.spendCents), sales: eur2(totals.salesCents),
    acos: totals.acosPct == null ? '—' : `${totals.acosPct.toFixed(2)}%`, orders: String(totals.orders),
  }
  const fmtRangeLong = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

  const materialize = async (id: string) => {
    if (busy) return
    setBusy(id); setNote(null)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/ai-goals/${id}/materialize`, { method: 'POST' })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || j?.ok === false) throw new Error(j?.error || 'Launch failed')
      const n = Array.isArray(j?.campaigns) ? j.campaigns.length : 0
      setNote({ text: `Launched ${n} campaign${n === 1 ? '' : 's'}. The AI proposes its first optimizations on the Suggestions page as data arrives.`, err: false })
      setRefreshKey((k) => k + 1)
    } catch (e) { setNote({ text: (e as Error).message, err: true }) } finally { setBusy(null) }
  }

  return (
    <div className="h10-aiad">
      {/* header */}
      <div className="h10-aiad-hdr">
        <div className="l">
          <h1><span className="ic"><IconAtom size={26} /></span> AI Advertising</h1>
          <p>Enhancing Ad Optimization Efficiency with AI-Driven Advertising</p>
        </div>
        <div className="r">
          <button type="button" className="h10-hbtn"><Video size={15} /> Learn</button>
          <a className="h10-hbtn ghost" href="mailto:feedback@nexus-commerce.app?subject=AI%20Advertising%20feedback"><ExternalLink size={14} /> Share Feedback</a>
          <DateRangePicker value={dateRange} onChange={(s, e) => setDateRange({ start: s, end: e })} />
          <AccountSelect />
        </div>
      </div>

      {/* Get Started hero — shown only until the first goal exists (H10) */}
      {goals.length === 0 && (
      <div className="h10-aiad-hero">
        <div className="hl">
          <h2>Get Started with AI Advertising</h2>
          <p>AI Advertising is included in your subscription. Set up your first product goal to enjoy the benefits of fully automated PPC management.</p>
          <ul className="checks">
            {HERO_CHECKS.map((c) => <li key={c}><span className="ck"><Check size={12} strokeWidth={3} /></span>{c}</li>)}
          </ul>
          <div className="cta-lbl">Set up your first product goal with AI Advertising.</div>
          <div className="cta">
            <Link href="/marketing/ads/ai-advertising/new-goal" className="h10-am-btn primary"><Plus size={14} /> Product Goal</Link>
            <button type="button" className="h10-am-btn"><BookOpen size={14} /> Learn More</button>
          </div>
        </div>
        <div className="hr">
          <div className="vid">
            <div className="brand"><span className="mk"><IconAtom size={26} /></span><div><b>Nexus Ads</b><span>AI-Driven Advertising</span></div></div>
            <button type="button" className="play" aria-label="Play"><Play size={20} fill="#fff" /></button>
            <div className="ctrl"><Play size={12} fill="#fff" /><span className="bar"><span /></span><span className="tt">0:00</span></div>
          </div>
        </div>
      </div>
      )}

      {/* Overview */}
      <div className="h10-aiad-ov">
        <div className="ovh"><h3>Overview</h3><span className="sub">{fmtRangeLong(dateRange.start)} - {fmtRangeLong(dateRange.end)}</span></div>
        <div className="kpis">
          {KPI_META.map((k) => (
            <div className="kpi" key={k.key}>
              <span className="lb"><span className="dot" style={{ background: k.dot }} />{k.label}</span>
              <span className="vl">{kpiValue[k.key]}</span>
            </div>
          ))}
        </div>
        <PerfChart series={summary?.series ?? []} />
      </div>

      {/* Goals table */}
      <div className="h10-aiad-tbl">
        <div className="tbar">
          <span className="cnt">Showing {goals.length} Goal{goals.length === 1 ? '' : 's'}</span>
          <button type="button" className="h10-am-btn"><SlidersHorizontal size={13} /> Filters</button>
          <span className="seg">
            <button type="button" className={tab === 'ASIN' ? 'on' : ''} onClick={() => setTab('ASIN')}>ASIN</button>
            <button type="button" className={tab === 'Campaign' ? 'on' : ''} onClick={() => setTab('Campaign')}>Campaign</button>
          </span>
          <span className="grow" />
          <button type="button" className="h10-am-btn"><Download size={13} /> Export Data...</button>
          <Link href="/marketing/ads/ai-advertising/new-goal" className="h10-am-btn primary"><Plus size={13} /> Product Goal</Link>
        </div>
        {note && <div className={`h10-aiad-note${note.err ? ' err' : ''}`}>{note.text}</div>}
        <div className="grid">
          <table>
            <thead>
              <tr>
                <th className="ck"><input type="checkbox" aria-label="Select all" /></th>
                {COLS.map((c) => (
                  <th key={c.key} className={c.sorted ? 'sorted' : ''}>
                    <span className="h">{c.label}{c.beta && <i className="beta">BETA</i>}{c.sortable && <ChevronsUpDown size={12} className="srt" />}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {goals.length === 0 ? (
                <tr><td className="empty" colSpan={COLS.length + 1}>There are no products set up with AI Advertising.</td></tr>
              ) : goals.map((g) => {
                const p = perfByGoal.get(g.id)
                const ctl = g.aiControl ? CONTROL_LABEL[g.aiControl] ?? { label: g.aiControl, cls: 'off' } : null
                return (
                <tr key={g.id}>
                  <td className="ck"><input type="checkbox" aria-label={`Select ${g.name}`} /></td>
                  <td className="gname">{g.name}<span className="sub">{g.productCount} product{g.productCount === 1 ? '' : 's'}{g.campaignCount > 0 ? ` · ${g.campaignCount} campaigns` : ''}</span></td>
                  <td>{TARGET_LABEL[g.aiTarget] ?? g.aiTarget}</td>
                  <td>{ctl ? <span className={`aictl ${ctl.cls}`}>{ctl.label}</span> : <span className="aictl off">—</span>}</td>
                  <td>
                    {g.materializedAt
                      ? <span className="gstatus">{g.status === 'ACTIVE' ? 'Enabled' : g.status}</span>
                      : <span className="aiad-nl">
                          <span className="gstatus warn">Not launched</span>
                          <button type="button" className="h10-am-btn primary aiad-launch" disabled={busy === g.id} onClick={() => materialize(g.id)}>{busy === g.id ? 'Launching…' : 'Launch'}</button>
                        </span>}
                  </td>
                  <td>{fmtDay(g.startDate)}</td>
                  <td>{MODE_LABEL[g.budgetMode] ?? g.budgetMode}</td>
                  <td>{eur2(g.dailyBudgetCents)}</td>
                  <td title={p?.utilizationDate ? `Latest reported day: ${p.utilizationDate}` : undefined}>{p?.utilizationPct != null ? `${p.utilizationPct}%` : '—'}</td>
                  <td>{p ? eur2(p.spendCents) : '—'}</td>
                  <td>{p ? eur2(p.salesCents) : '—'}</td>
                  <td>{p ? (p.acosPct == null ? '—' : `${p.acosPct.toFixed(2)}%`) : '—'}</td>
                  <td>{p ? p.orders : '—'}</td>
                </tr>
              )})}
            </tbody>
          </table>
        </div>
        <div className="pager">
          <span className="grow" />
          <button type="button" className="pg" aria-label="Previous"><ChevronLeft size={15} /></button>
          <button type="button" className="pg on">1</button>
          <button type="button" className="pg" aria-label="Next"><ChevronRight size={15} /></button>
          <span className="rpp">Rows per page: <b>10</b></span>
        </div>
      </div>

      <div className="h10-aiad-foot">
        <span>Privacy Policy</span><span>Terms &amp; Conditions</span><span>Submit Testimonial</span><span>Site Map</span>
        <span className="grow" />
        <span className="cp">Nexus Ads · Copyright 2026</span>
      </div>
    </div>
  )
}
