'use client'

/**
 * Automation Console chrome — no icon rail.
 * Layout: [Main nav 208px, collapsible] [Sub nav 192px, collapsible] [Content]
 * When main nav is collapsed a hamburger in the top bar re-expands it.
 */

import Link from '@/lib/workspaces/Link'
import type { ReactNode } from 'react'
import { useSearchParams } from 'next/navigation'
import { usePathname, useRouter } from '@/lib/workspaces/navigation'
import { useEffect, useState } from 'react'
import {
  LayoutDashboard, Zap, Crosshair, Activity, FileSpreadsheet, Settings,
  ExternalLink, Bell, HelpCircle, User, Megaphone, ChevronLeft, ChevronRight, Menu,
  type LucideIcon,
  History,
} from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { amazonCampaignsHref, marketLabel } from './amazonLinks'

const BASE = '/marketing/ads-console'
const LS_NAV = 'ads:nav-collapsed'
const LS_SUB = 'ads:subnav-collapsed'

interface NavItem { k: string; label: string; href: string; Icon: LucideIcon }
// OC (2026-10-06) — the old console is retired except Rank Control (its product rank plans live only here for now).
// Every other entry opens its Ad Manager page; the old addresses redirect there too (next.config.js).
const NAV: NavItem[] = [
  { k: 'overview',   label: 'Overview',     href: '/marketing/ads/dashboard',                              Icon: LayoutDashboard },
  { k: 'automation', label: 'Automation',   href: '/marketing/ads/rules-automation/automations',           Icon: Zap             },
  { k: 'rank',       label: 'Rank Control', href: `${BASE}/rank`,                                         Icon: Crosshair       },
  { k: 'activity',   label: 'Activity',     href: '/marketing/ads/rules-automation/control-room?tab=activity', Icon: Activity    },
  { k: 'bulk',       label: 'Bulk',         href: '/marketing/ads/bulk',                                   Icon: FileSpreadsheet },
  { k: 'settings',   label: 'Settings',     href: '/settings/advertising',                                 Icon: Settings        },
]

interface SubItem { k: string; label: string; Icon?: LucideIcon; sep?: boolean }
// RC5.1 — the keyword/strategy/conquest/tos modes are now absorbed into the one
// cockpit, so the sub-nav is just Overview · Cockpit · Managed campaigns.
const RANK_ITEMS: SubItem[] = [
  { k: 'overview', label: 'Overview',          Icon: LayoutDashboard },
  { k: 'cockpit',  label: 'Cockpit',           Icon: Crosshair },
  { k: 'managed',  label: 'Managed campaigns',  Icon: History },
]

interface SubNavDef { title: string; paramKey: string; items: SubItem[]; defaultKey: string }
const SUB_NAVS: Record<string, SubNavDef> = {
  [`${BASE}/rank`]:       { title: 'Rank Control', paramKey: 'mode',   items: RANK_ITEMS,       defaultKey: 'cockpit'   },
}

interface Conn { profileId: string; marketplace: string; isActive: boolean; mode: string }

function activeKey(p: string): string {
  return p.includes('/rank') ? 'rank' : 'overview'
}
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
  const [navCollapsed, setNavCollapsed] = useState(false)
  const [subCollapsed, setSubCollapsed] = useState(false)

  useEffect(() => {
    setNavCollapsed(readLS(LS_NAV, false))
    // Sub nav: default OPEN. We store the key only if the user explicitly
    // collapsed it in THIS version (v2). Old stale '1' from earlier testing
    // is invalidated by checking for the version marker.
    const subKey = localStorage.getItem(LS_SUB + ':v2')
    setSubCollapsed(subKey === '1')
  }, [])

  useEffect(() => {
    const base = getBackendUrl()
    void fetch(`${base}/api/advertising/connections`, { cache: 'no-store' })
      .then(r => r.json()).then(d => setConns((d.items ?? []).filter((c: Conn) => c.isActive))).catch(() => {})
  }, [])

  const toggleNav = () => { const n = !navCollapsed; setNavCollapsed(n); writeLS(LS_NAV, n) }
  const toggleSub = () => {
    const n = !subCollapsed; setSubCollapsed(n)
    try { localStorage.setItem(LS_SUB + ':v2', n ? '1' : '0') } catch { /* ignore */ }
  }

  const subNavDef = Object.entries(SUB_NAVS).find(([k]) => pathname.startsWith(k))?.[1] ?? null
  const activeParam = subNavDef ? (searchParams.get(subNavDef.paramKey) ?? subNavDef.defaultKey) : null
  const navigateSub = (def: SubNavDef, k: string) => router.replace(`${pathname}?${def.paramKey}=${k}`, { scroll: false })

  const crumb = NAV.find(n => n.k === active)?.label ?? 'Overview'

  return (
    <>
      {/* ── Top bar ─────────────────────────────────────────── */}
      <div className="az-top">
        {/* Hamburger — only visible when main nav is collapsed */}
        {navCollapsed && (
          <button onClick={toggleNav} title="Open navigation"
            style={{ background: 'none', border: 'none', color: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', padding: '0 10px 0 0', opacity: 0.85 }}>
            <Menu size={19} />
          </button>
        )}
        <Link href="/marketing/ads/dashboard" className="brand">
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
        {/* ── Main nav ────────────────────────────────────────── */}
        <nav className={`az-nav ${navCollapsed ? 'nav-collapsed' : ''}`}>
          {/* Collapse button — top right of nav */}
          <button className="az-nav-toggle" onClick={toggleNav} title="Collapse navigation" style={{ border: 'none' }}>
            <ChevronLeft size={13} />
          </button>

          <div style={{ paddingTop: 30 }}>
            {NAV.map(({ k, label, href, Icon }) => (
              <Link key={k} href={href} className={active === k ? 'on' : ''}
                style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <Icon size={15} style={{ opacity: 0.6, flexShrink: 0 }} />
                {label}
              </Link>
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
        </nav>

        {/* ── Sub nav ─────────────────────────────────────────── */}
        {subNavDef && (
          <div className={`az-subnav ${subCollapsed ? 'subnav-collapsed' : ''}`}>
            <div className="az-subnav-inner">
              <div className="az-subnav-header">
                <span className="az-subnav-title">{subNavDef.title}</span>
                <button className="az-subnav-toggle" onClick={toggleSub} title={subCollapsed ? 'Expand panel' : 'Collapse panel'}>
                  {subCollapsed ? <ChevronRight size={12} /> : <ChevronLeft size={12} />}
                </button>
              </div>

              {subNavDef.items.map(item => {
                if (item.sep) return <div key={item.k} className="az-subnav-sep" />
                const Icon = item.Icon
                return (
                  <button key={item.k}
                    className={`az-subnav-item ${activeParam === item.k ? 'on' : ''}`}
                    onClick={() => navigateSub(subNavDef, item.k)}
                    title={subCollapsed ? item.label : undefined}
                  >
                    {Icon && <span className="ic"><Icon size={15} /></span>}
                    <span className="lbl">{item.label}</span>
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
