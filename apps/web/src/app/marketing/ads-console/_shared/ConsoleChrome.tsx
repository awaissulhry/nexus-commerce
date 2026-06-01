'use client'

/**
 * Automation Console chrome — Phase 1 rebuild + dual collapsible sidebars.
 *
 * Three-panel layout:
 *   Icon rail (56px, always visible)
 *   Main nav (208px, collapsible → 0)
 *   Sub nav  (192px, collapsible → 0, per-section items)
 *   Content  (flex:1)
 *
 * Both collapse states persist to localStorage. Sub nav items drive URL param
 * navigation (?tab= / ?mode= / ?filter=) so clicking here and clicking a chip
 * inside the page both update the same URL state.
 */

import Link from 'next/link'
import type { ReactNode } from 'react'
import { usePathname, useSearchParams, useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import {
  LayoutDashboard, Zap, Crosshair, Activity, FileSpreadsheet, Settings,
  ExternalLink, Bell, HelpCircle, User, Megaphone, ChevronLeft, ChevronRight,

  type LucideIcon,
  BookOpen, Layers, PenTool, BarChart3, CheckSquare, LineChart, TrendingUp,
  Clock, Swords, Sprout, Ban, ShoppingCart, DollarSign, Shield, Heart, Radio,
  Target, Gauge, Anchor, Download, Upload, History, Filter,
  BarChart2, SlidersHorizontal, Percent,
} from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { amazonCampaignsHref, marketLabel } from './amazonLinks'

const BASE = '/marketing/ads-console'
const LS_NAV = 'ads:nav-collapsed'
const LS_SUB = 'ads:subnav-collapsed'

/* ── Main nav items ──────────────────────────────────────────── */
interface NavItem { k: string; label: string; href: string; Icon: LucideIcon }
const NAV: NavItem[] = [
  { k: 'overview',   label: 'Overview',     href: `${BASE}/overview`,   Icon: LayoutDashboard },
  { k: 'automation', label: 'Automation',   href: `${BASE}/automation`, Icon: Zap             },
  { k: 'rank',       label: 'Rank Control', href: `${BASE}/rank`,       Icon: Crosshair       },
  { k: 'activity',   label: 'Activity',     href: `${BASE}/activity`,   Icon: Activity        },
  { k: 'bulk',       label: 'Bulk',         href: `${BASE}/bulk`,       Icon: FileSpreadsheet },
]

/* ── Sub-nav definitions ─────────────────────────────────────── */
interface SubItem { k: string; label: string; Icon?: LucideIcon; countKey?: string; sep?: boolean }

const AUTOMATION_ITEMS: SubItem[] = [
  { k: 'library',    label: 'Library',           Icon: BookOpen },
  { k: 'playbooks',  label: 'Playbooks',          Icon: Layers },
  { k: 'composer',   label: 'Composer',           Icon: PenTool },
  { k: 'rank',       label: 'Rank Control',       Icon: Crosshair },
  { k: 'active',     label: 'Active rules',       Icon: CheckSquare, countKey: 'rules' },
  { sep: true, k: 's1', label: '' },
  { k: 'analytics',  label: 'Analytics',          Icon: BarChart3 },
  { k: 'efficiency', label: 'Efficiency',         Icon: LineChart },
  { k: 'dayparting', label: 'Dayparting',         Icon: Clock },
  { k: 'recs',       label: 'Recommendations',    Icon: TrendingUp, countKey: 'recs' },
  { k: 'anomaly',    label: 'Anomalies',          Icon: Radio },
  { k: 'competitive',label: 'Competitive',        Icon: Swords },
  { sep: true, k: 's2', label: '' },
  { k: 'harvest',    label: 'Harvest',            Icon: Sprout },
  { k: 'negatives',  label: 'Negatives',          Icon: Ban },
  { k: 'retail',     label: 'Retail',             Icon: ShoppingCart },
  { k: 'budget',     label: 'Budgets',            Icon: DollarSign },
  { sep: true, k: 's3', label: '' },
  { k: 'engine',     label: 'Engine & autonomy',  Icon: Gauge },
  { k: 'guardrails', label: 'Guardrails',         Icon: Shield },
  { k: 'health',     label: 'Health',             Icon: Heart },
]

const RANK_ITEMS: SubItem[] = [
  { k: 'placement', label: 'Placement %',        Icon: Percent },
  { k: 'keywords',  label: 'Keyword targeting',  Icon: Target },
  { k: 'strategy',  label: 'Strategy & cost',    Icon: SlidersHorizontal },
  { k: 'conquest',  label: 'Conquesting',        Icon: Anchor },
  { k: 'tos',       label: 'Top-of-Search IS',   Icon: BarChart2 },
]

const ACTIVITY_ITEMS: SubItem[] = [
  { k: 'all',    label: 'All executions',  Icon: Activity },
  { k: 'live',   label: 'Live actions',    Icon: CheckSquare },
  { k: 'dry',    label: 'Dry-run',        Icon: Filter },
  { k: 'failed', label: 'Failed / capped', Icon: Ban },
]

const BULK_ITEMS: SubItem[] = [
  { k: 'download', label: 'Download',         Icon: Download },
  { k: 'upload',   label: 'Upload',           Icon: Upload },
  { k: 'diff',     label: 'Automation diff',  Icon: History },
]

interface SubNavDef { title: string; paramKey: string; items: SubItem[]; defaultKey: string }
const SUB_NAVS: Record<string, SubNavDef> = {
  [`${BASE}/automation`]: { title: 'Automation', paramKey: 'tab', items: AUTOMATION_ITEMS, defaultKey: 'library' },
  [`${BASE}/rank`]:       { title: 'Rank Control', paramKey: 'mode', items: RANK_ITEMS, defaultKey: 'placement' },
  [`${BASE}/activity`]:   { title: 'Activity', paramKey: 'filter', items: ACTIVITY_ITEMS, defaultKey: 'all' },
  [`${BASE}/bulk`]:       { title: 'Bulk', paramKey: 'tab', items: BULK_ITEMS, defaultKey: 'download' },
}

interface Conn { profileId: string; marketplace: string; isActive: boolean; mode: string }
interface Counts { rules: number; recs: number }

function activeKey(pathname: string): string {
  if (pathname.includes('/automation')) return 'automation'
  if (pathname.includes('/rank')) return 'rank'
  if (pathname.includes('/activity')) return 'activity'
  if (pathname.includes('/bulk')) return 'bulk'
  if (pathname.includes('/settings')) return 'settings'
  return 'overview'
}

// Read/write localStorage only on client
function readLS(key: string, def: boolean): boolean {
  if (typeof window === 'undefined') return def
  try { const v = localStorage.getItem(key); return v == null ? def : v === '1' } catch { return def }
}
function writeLS(key: string, v: boolean) {
  try { localStorage.setItem(key, v ? '1' : '0') } catch { /* ignore */ }
}

export function ConsoleChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname() || ''
  const searchParams = useSearchParams()
  const router = useRouter()
  const active = activeKey(pathname)
  const [conns, setConns] = useState<Conn[]>([])
  const [counts, setCounts] = useState<Counts>({ rules: 0, recs: 0 })
  const [navCollapsed, setNavCollapsed] = useState(false)
  const [subCollapsed, setSubCollapsed] = useState(false)

  // Init collapse from localStorage after mount
  useEffect(() => {
    setNavCollapsed(readLS(LS_NAV, false))
    setSubCollapsed(readLS(LS_SUB, false))
  }, [])

  // Fetch connections + counts
  useEffect(() => {
    const base = getBackendUrl()
    void fetch(`${base}/api/advertising/connections`, { cache: 'no-store' })
      .then(r => r.json()).then(d => setConns((d.items ?? []).filter((c: Conn) => c.isActive))).catch(() => {})
    void fetch(`${base}/api/advertising/automation-rules?limit=200`, { cache: 'no-store' })
      .then(r => r.json()).then(d => setCounts(c => ({ ...c, rules: (d.rules ?? []).filter((r: { enabled: boolean }) => r.enabled).length }))).catch(() => {})
    void fetch(`${base}/api/advertising/recommendations?limit=1`, { cache: 'no-store' })
      .then(r => r.json()).then(d => setCounts(c => ({ ...c, recs: d.recommendations?.length ?? 0 }))).catch(() => {})
  }, [])

  const toggleNav = () => { const next = !navCollapsed; setNavCollapsed(next); writeLS(LS_NAV, next) }
  const toggleSub = () => { const next = !subCollapsed; setSubCollapsed(next); writeLS(LS_SUB, next) }

  // Determine sub nav for current route
  const subNavDef = Object.entries(SUB_NAVS).find(([k]) => pathname.startsWith(k))?.[1] ?? null
  const activeParam = subNavDef ? (searchParams.get(subNavDef.paramKey) ?? subNavDef.defaultKey) : null

  const navigateSub = (def: SubNavDef, k: string) => {
    router.replace(`${pathname}?${def.paramKey}=${k}`, { scroll: false })
  }

  const countFor = (item: SubItem) => {
    if (item.countKey === 'rules') return counts.rules
    if (item.countKey === 'recs') return counts.recs
    return 0
  }

  const crumb = NAV.find(n => n.k === active)?.label ?? (active === 'settings' ? 'Settings' : 'Overview')

  return (
    <>
      {/* ── Top bar ─────────────────────────── */}
      <div className="az-top">
        <Link href={`${BASE}/overview`} className="brand">
          <Megaphone size={18} />
          <span>Nexus<span className="mk"> ads</span></span>
        </Link>
        <span className="crumb">{crumb}</span>
        <span className="sp" />
        <div className="acct">
          <div className="n">XAVIA</div>
          <div className="s">Automation console · {conns.length} market{conns.length !== 1 ? 's' : ''}</div>
        </div>
        <span className="ti"><Bell size={17} /></span>
        <span className="ti"><HelpCircle size={17} /></span>
        <span className="ti"><User size={18} /></span>
      </div>

      <div className="az-body">
        {/* ── Icon rail ───────────────────────── */}
        <div className="az-rail">
          {/* Expand main nav when collapsed */}
          {navCollapsed && (
            <button className="az-rail-expand" onClick={toggleNav} title="Expand navigation" style={{ border: 'none', background: 'none' }}>
              <ChevronRight size={16} />
            </button>
          )}
          {NAV.map(({ k, href, Icon, label }) => (
            <Link key={k} href={href} className={`ri ${active === k ? 'on' : ''}`} title={label}>
              <Icon size={20} />
            </Link>
          ))}
          <span style={{ flex: 1 }} />
          <Link href={`${BASE}/settings`} className={`ri ${active === 'settings' ? 'on' : ''}`} title="Settings">
            <Settings size={20} />
          </Link>
        </div>

        {/* ── Main nav sidebar ────────────────── */}
        <nav className={`az-nav ${navCollapsed ? 'nav-collapsed' : ''}`}>
          {/* Collapse toggle */}
          <button className="az-nav-toggle" onClick={toggleNav} title={navCollapsed ? 'Expand' : 'Collapse'} style={{ border: 'none' }}>
            {navCollapsed ? <ChevronRight size={13} /> : <ChevronLeft size={13} />}
          </button>

          <div style={{ paddingTop: 30 }}>
            {NAV.map(({ k, label, href }) => (
              <Link key={k} href={href} className={active === k ? 'on' : ''}>{label}</Link>
            ))}
          </div>

          {/* Amazon deep links */}
          {conns.length > 0 && (
            <div style={{ marginTop: 16, borderTop: '1px solid var(--divider)', paddingTop: 10 }}>
              <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--ink3)', letterSpacing: 0.6, padding: '0 12px 6px', textTransform: 'uppercase' }}>Open in Amazon</div>
              {conns.map(c => (
                <a key={c.marketplace} href={amazonCampaignsHref(c.profileId, c.marketplace)} target="_blank" rel="noopener noreferrer" className="az-amazon-link">
                  <span className="lbl">{marketLabel(c.marketplace)}</span>
                  {c.mode === 'production' && <span className="live-chip">LIVE</span>}
                  <ExternalLink size={11} style={{ opacity: 0.5, flexShrink: 0 }} />
                </a>
              ))}
            </div>
          )}

          <div style={{ marginTop: 8, borderTop: '1px solid var(--divider)', paddingTop: 8 }}>
            <Link href={`${BASE}/settings`} className={active === 'settings' ? 'on' : ''}>Settings</Link>
          </div>
        </nav>

        {/* ── Sub nav sidebar ─────────────────── */}
        {subNavDef && (
          <div className={`az-subnav ${subCollapsed ? 'subnav-collapsed' : ''}`}>
            <div className="az-subnav-inner">
              <div className="az-subnav-header">
                {!subCollapsed && <span className="az-subnav-title">{subNavDef.title}</span>}
                <button className="az-subnav-toggle" onClick={toggleSub} title={subCollapsed ? 'Expand' : 'Collapse'} style={{ border: 'none', marginLeft: 'auto' }}>
                  {subCollapsed ? <ChevronRight size={12} /> : <ChevronLeft size={12} />}
                </button>
              </div>

              {subNavDef.items.map(item => {
                if (item.sep) return <div key={item.k} className="az-subnav-sep" />
                const Icon = item.Icon
                const count = item.countKey ? countFor(item) : 0
                return (
                  <button
                    key={item.k}
                    className={`az-subnav-item ${activeParam === item.k ? 'on' : ''}`}
                    onClick={() => navigateSub(subNavDef, item.k)}
                  >
                    {Icon && <Icon size={14} style={{ flexShrink: 0, opacity: 0.7 }} />}
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.label}</span>
                    {count > 0 && <span className="badge">{count}</span>}
                  </button>
                )
              })}
            </div>
          </div>
        )}

        <div className="az-content">{children}</div>
      </div>
    </>
  )
}
