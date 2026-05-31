'use client'

/**
 * Trading Desk rail — the spike's dark navy sidebar, in React.
 *
 * Tight 7-item nav (vs the 30-entry legacy /marketing/advertising rail, which
 * stays live & untouched). Only Dashboard is rebuilt natively here so far; the
 * rest open the existing tool in a NEW TAB (↗) with a phase tag showing when it
 * gets rebuilt in this hub. Flips to in-hub navigation as each lands.
 */

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { LucideIcon } from 'lucide-react'
import {
  LayoutDashboard, Megaphone, ListChecks, Wand2, Crosshair, BarChart3, Settings, ArrowUpRight,
} from 'lucide-react'

const BASE = '/marketing/trading-desk'

interface Item { label: string; href: string; icon: LucideIcon; native?: boolean; phase?: string }
interface Group { label: string; items: Item[] }

const GROUPS: Group[] = [
  { label: 'Operate', items: [
    { label: 'Dashboard', href: BASE, icon: LayoutDashboard, native: true },
    { label: 'Campaigns', href: '/marketing/advertising/campaigns', icon: Megaphone, phase: 'P2' },
    { label: 'Suggestions', href: '/marketing/advertising/recommendations', icon: ListChecks, phase: 'P3' },
  ] },
  { label: 'Automate', items: [
    { label: 'Automation', href: '/marketing/advertising/automation', icon: Wand2, phase: 'P4–9' },
  ] },
  { label: 'Intelligence', items: [
    { label: 'Competitive', href: '/marketing/advertising/share-of-voice', icon: Crosshair, phase: 'P9' },
    { label: 'Analytics', href: '/marketing/advertising/analytics', icon: BarChart3, phase: 'P11' },
  ] },
  { label: 'Setup', items: [
    { label: 'Settings', href: '/marketing/advertising/debug', icon: Settings },
  ] },
]

export function TradingDeskSidebar() {
  const pathname = usePathname() || ''
  return (
    <aside className="side">
      <div className="brand">
        <div className="logo">◎</div>
        <div>Nexus Ads<small>Trading Desk</small></div>
      </div>

      <nav className="nav">
        {GROUPS.map((g) => (
          <div key={g.label}>
            <div className="grp">{g.label}</div>
            {g.items.map((it) => {
              const Icon = it.icon
              const active = !!it.native && pathname === it.href
              const body = (
                <>
                  <Icon size={17} />
                  <span className="label">{it.label}</span>
                  {!it.native && (
                    <>
                      {it.phase && <span className="ph">{it.phase}</span>}
                      <ArrowUpRight className="ext" size={12} />
                    </>
                  )}
                </>
              )
              return it.native ? (
                <Link key={it.href} href={it.href} className={active ? 'on' : undefined} aria-current={active ? 'page' : undefined}>
                  {body}
                </Link>
              ) : (
                <a key={it.href} href={it.href} target="_blank" rel="noopener noreferrer" title="Opens the current tool in a new tab">
                  {body}
                </a>
              )
            })}
          </div>
        ))}
      </nav>

      <div className="foot">
        <a className="classic" href="/marketing/advertising" target="_blank" rel="noopener noreferrer">
          <ArrowUpRight size={12} /> Classic Advertising
        </a>
        <div className="hint">↗ items open the current tool in a new tab until rebuilt here.</div>
      </div>

      <div className="acct">
        <div className="av">XV</div>
        <div>
          <div style={{ color: '#e2e8f0', fontWeight: 600 }}>Xavia</div>
          <div style={{ fontSize: '10.5px' }}>Amazon · eBay · Shopify</div>
        </div>
      </div>
    </aside>
  )
}
