'use client'

/**
 * CBN — AI Advertising dashboard (the "get-started" page), matched to Helium 10 Ads.
 * Empty-state: header → Get Started hero → Overview (KPI strip + chart) → Goals table.
 * Reuses the shared `.h10-*` design system; "+ Product Goal" launches the AI Goal builder.
 */
import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Video, ExternalLink, ChevronDown, Check, Plus, BookOpen, Download, SlidersHorizontal, Play, ChevronLeft, ChevronRight, ChevronsUpDown } from 'lucide-react'
import { DateRangePicker } from '../_shell/DateRangePicker'
import { IconAtom } from '../_shell/builder-icons'
import { getBackendUrl } from '@/lib/backend-url'

const FLAG: Record<string, string> = { IT: '🇮🇹', DE: '🇩🇪', FR: '🇫🇷', ES: '🇪🇸', GB: '🇬🇧', UK: '🇬🇧', NL: '🇳🇱', SE: '🇸🇪', PL: '🇵🇱', BE: '🇧🇪', IE: '🇮🇪', TR: '🇹🇷', US: '🇺🇸' }
const MARKET_NAME: Record<string, string> = { IT: 'Italy', DE: 'Germany', FR: 'France', ES: 'Spain', GB: 'United Kingdom', UK: 'United Kingdom', NL: 'Netherlands', SE: 'Sweden', PL: 'Poland', BE: 'Belgium', IE: 'Ireland', TR: 'Türkiye', US: 'United States' }

const HERO_CHECKS = ['Sponsored Product campaign management', 'Real-time bid optimization', 'Smart budget allocation', 'Keyword discovery and removal']

const KPIS: Array<{ key: string; label: string; dot: string; fmt: (v: number) => string }> = [
  { key: 'spend', label: 'Spend', dot: '#1f6fde', fmt: (v) => `€${v.toFixed(2)}` },
  { key: 'sales', label: 'Sales', dot: '#16a34a', fmt: (v) => `€${v.toFixed(2)}` },
  { key: 'acos', label: 'ACoS', dot: '#f59e0b', fmt: (v) => `${v.toFixed(2)}%` },
  { key: 'orders', label: 'PPC Orders', dot: '#7c3aed', fmt: (v) => `${v}` },
]

// Goals table columns — order matched to H10 (Start Date is the default sort).
const COLS: Array<{ key: string; label: string; beta?: boolean; sortable?: boolean; sorted?: boolean }> = [
  { key: 'goal', label: 'Goal' },
  { key: 'aiTarget', label: 'AI Target', beta: true },
  { key: 'aiControl', label: 'AI Control' },
  { key: 'status', label: 'Status', sortable: true },
  { key: 'startDate', label: 'Start Date', sortable: true, sorted: true },
  { key: 'budgetMode', label: 'Budget Mode' },
  { key: 'dailyBudget', label: 'Daily Budget', sortable: true },
  { key: 'budgetUtil', label: 'Budget Utilization(Today)' },
  { key: 'spend', label: 'Spend', sortable: true },
  { key: 'sales', label: 'Sales', sortable: true },
  { key: 'acos', label: 'ACoS', sortable: true },
  { key: 'orders', label: 'Orders', sortable: true },
]

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

export function AiAdvertisingDashboard() {
  const [dateRange, setDateRange] = useState(() => { const e = new Date(); e.setHours(0, 0, 0, 0); const s = new Date(e); s.setDate(s.getDate() - 10); return { start: s, end: e } })
  const [tab, setTab] = useState<'ASIN' | 'Campaign'>('Campaign')
  const totals = { spend: 0, sales: 0, acos: 0, orders: 0 }
  const fmtRangeLong = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

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

      {/* Get Started hero */}
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

      {/* Overview */}
      <div className="h10-aiad-ov">
        <div className="ovh"><h3>Overview</h3><span className="sub">{fmtRangeLong(dateRange.start)} - {fmtRangeLong(dateRange.end)}</span></div>
        <div className="kpis">
          {KPIS.map((k) => (
            <div className="kpi" key={k.key}>
              <span className="lb"><span className="dot" style={{ background: k.dot }} />{k.label}</span>
              <span className="vl">{k.fmt(totals[k.key as keyof typeof totals])}</span>
            </div>
          ))}
        </div>
        <EmptyChart />
      </div>

      {/* Goals table */}
      <div className="h10-aiad-tbl">
        <div className="tbar">
          <span className="cnt">Showing 0 Goals</span>
          <button type="button" className="h10-am-btn"><SlidersHorizontal size={13} /> Filters</button>
          <span className="seg">
            <button type="button" className={tab === 'ASIN' ? 'on' : ''} onClick={() => setTab('ASIN')}>ASIN</button>
            <button type="button" className={tab === 'Campaign' ? 'on' : ''} onClick={() => setTab('Campaign')}>Campaign</button>
          </span>
          <span className="grow" />
          <button type="button" className="h10-am-btn"><Download size={13} /> Export Data...</button>
          <Link href="/marketing/ads/ai-advertising/new-goal" className="h10-am-btn primary"><Plus size={13} /> Product Goal</Link>
        </div>
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
              <tr><td className="empty" colSpan={COLS.length + 1}>There are no products set up with AI Advertising.</td></tr>
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
