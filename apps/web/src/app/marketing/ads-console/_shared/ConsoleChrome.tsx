'use client'

/**
 * Amazon-Ads-faithful console chrome: dark top bar + left icon rail +
 * secondary text nav (Portfolios / Campaigns / Drafts / …). Pixel-modelled on
 * the real console. Our wordmark in the logo spot (can't use Amazon's mark).
 * Campaigns is built; other nav items light up as their pages land.
 */

import Link from 'next/link'
import type { ReactNode } from 'react'
import { usePathname } from 'next/navigation'
import {
  Plus, Megaphone, ShieldCheck, Image as ImageIcon, LineChart, BarChart3, Workflow,
  LayoutGrid, Briefcase, Settings, ChevronLeft, Home, Bell, HelpCircle, User,
} from 'lucide-react'

const BASE = '/marketing/ads-console'
const RAIL = [Plus, Megaphone, ShieldCheck, ImageIcon, LineChart, BarChart3, Workflow, LayoutGrid, Briefcase]
const NAV = ['Portfolios', 'Campaigns', 'Drafts', 'Products', 'Targeting', 'Budgets', 'History', 'Bulk operations', 'Rules', 'Settings']
// Nav items that are built (real links). The rest light up as their pages land.
const ROUTES: Record<string, string> = { Campaigns: `${BASE}/campaigns`, Products: `${BASE}/products`, Targeting: `${BASE}/targeting`, 'Bulk operations': `${BASE}/bulk`, Rules: `${BASE}/automation` }

export function ConsoleChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname() || ''
  const crumb = pathname.includes('/products') ? 'Products' : pathname.includes('/targeting') ? 'Targeting' : pathname.includes('/bulk') ? 'Bulk operations' : pathname.includes('/automation') ? 'Automation' : 'Campaigns'
  return (
    <>
      <div className="az-top">
        <Link href={`${BASE}/campaigns`} className="brand"><Megaphone size={18} /><span>Nexus<span className="mk"> ads</span></span></Link>
        <span className="crumb">{crumb}</span>
        <span className="home"><Home size={16} /></span>
        <span className="sp" />
        <div className="acct"><div className="n">XAVIA</div><div className="s">Sponsored ads, multiple countries</div></div>
        <span className="ti"><Bell size={17} /></span>
        <span className="ti"><HelpCircle size={17} /></span>
        <span className="ti"><User size={18} /></span>
      </div>

      <div className="az-body">
        <div className="az-rail">
          {RAIL.map((Icon, i) => <span key={i} className={`ri ${i === 1 ? 'on' : ''}`}><Icon size={20} /></span>)}
          <span className="sp" style={{ flex: 1 }} />
          <span className="ri"><Settings size={20} /></span>
        </div>

        <nav className="az-nav">
          <div className="collapse"><ChevronLeft size={16} /></div>
          {NAV.map((label) => {
            const href = ROUTES[label]
            const active = !!href && pathname.startsWith(href)
            return href
              ? <Link key={label} href={href} className={active ? 'on' : ''}>{label}</Link>
              : <a key={label} className="" title="Lands in a later phase" onClick={(e) => e.preventDefault()} style={{ color: 'var(--ink2)' }}>{label}</a>
          })}
        </nav>

        <div className="az-content">{children}</div>
      </div>
    </>
  )
}
