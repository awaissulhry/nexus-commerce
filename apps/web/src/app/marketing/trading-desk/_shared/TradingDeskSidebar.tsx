'use client'

/**
 * Trading Desk — the rebuilt advertising hub's left rail.
 *
 * Deliberately tight: 7 primary surfaces grouped Operate / Automate /
 * Intelligence / Setup (vs the 30-entry sprawl of the legacy
 * /marketing/advertising sidebar, which stays live and untouched).
 *
 * Surfaces not yet rebuilt natively here link out to their existing
 * /marketing/advertising/* page and open in a NEW TAB (↗) — the same
 * pattern the product editor uses for Datasheet/Flat File. As each surface
 * is rebuilt natively in this hub (P2 Campaigns, P3 Suggestions, …) its
 * item flips to in-hub navigation (no new tab) and the phase tag drops.
 */

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import {
  LayoutDashboard, Megaphone, ListChecks, Wand2, Crosshair, BarChart3, Settings,
  ArrowUpRight, PanelLeftClose, PanelLeftOpen,
} from 'lucide-react'

const BASE = '/marketing/trading-desk'

interface Item {
  label: string
  icon: LucideIcon
  href: string
  /** Rebuilt natively in this hub → in-hub <Link>. Otherwise opens legacy page in a new tab. */
  native?: boolean
  /** Phase in which this surface gets rebuilt natively (shown as a faint tag). */
  phase?: string
}
interface Group { label: string; items: Item[] }

const GROUPS: Group[] = [
  { label: 'Operate', items: [
    { label: 'Dashboard', icon: LayoutDashboard, href: BASE, native: true },
    { label: 'Campaigns', icon: Megaphone, href: '/marketing/advertising/campaigns', phase: 'P2' },
    { label: 'Suggestions', icon: ListChecks, href: '/marketing/advertising/recommendations', phase: 'P3' },
  ] },
  { label: 'Automate', items: [
    { label: 'Automation', icon: Wand2, href: '/marketing/advertising/automation', phase: 'P4–9' },
  ] },
  { label: 'Intelligence', items: [
    { label: 'Competitive', icon: Crosshair, href: '/marketing/advertising/share-of-voice', phase: 'P9' },
    { label: 'Analytics', icon: BarChart3, href: '/marketing/advertising/analytics', phase: 'P11' },
  ] },
  { label: 'Setup', items: [
    { label: 'Settings', icon: Settings, href: '/marketing/advertising/debug' },
  ] },
]

export function TradingDeskSidebar() {
  const pathname = usePathname()
  const [collapsed, setCollapsed] = useState(false)
  useEffect(() => {
    try { setCollapsed(localStorage.getItem('td.sidebar.collapsed') === '1') } catch {}
  }, [])
  const toggle = () => setCollapsed((c) => {
    const n = !c
    try { localStorage.setItem('td.sidebar.collapsed', n ? '1' : '0') } catch {}
    return n
  })

  const renderItem = (it: Item) => {
    const Icon = it.icon
    const active = it.native && pathname === it.href
    const cls = `flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm ${collapsed ? 'justify-center' : ''} ${
      active
        ? 'bg-blue-600 text-white'
        : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
    }`
    const inner = (
      <>
        <Icon size={16} className="shrink-0" />
        {!collapsed && <span className="truncate flex-1">{it.label}</span>}
        {!collapsed && !it.native && (
          <span className="flex items-center gap-1 shrink-0">
            {it.phase && <span className="text-[9px] font-semibold text-slate-400 bg-slate-100 dark:bg-slate-800 rounded px-1 py-px">{it.phase}</span>}
            <ArrowUpRight size={12} className="text-slate-400" />
          </span>
        )}
      </>
    )
    if (it.native) {
      return (
        <Link key={it.href} href={it.href} title={collapsed ? it.label : undefined} aria-current={active ? 'page' : undefined} className={cls}>
          {inner}
        </Link>
      )
    }
    return (
      <a key={it.href} href={it.href} target="_blank" rel="noopener noreferrer"
        title={collapsed ? `${it.label} (opens current tool in a new tab)` : 'Opens the current tool in a new tab'} className={cls}>
        {inner}
      </a>
    )
  }

  return (
    <aside className={`shrink-0 border-r border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/30 ${collapsed ? 'w-14' : 'w-56'} transition-[width] duration-150 sticky top-0 self-start h-[calc(100vh-3.5rem)] overflow-y-auto`}>
      <div className={`flex items-center ${collapsed ? 'justify-center' : 'justify-between'} px-2 py-2 sticky top-0 bg-slate-50/80 dark:bg-slate-900/60 backdrop-blur z-10`}>
        {!collapsed && (
          <div className="px-2 leading-tight">
            <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">Trading Desk</div>
            <div className="text-[10px] font-medium uppercase tracking-wider text-blue-500">Preview · rebuild</div>
          </div>
        )}
        <button onClick={toggle} title={collapsed ? 'Expand' : 'Collapse'} className="p-1.5 rounded-md text-slate-400 hover:text-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800">
          {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
        </button>
      </div>

      <nav className="px-2 pb-4 space-y-3">
        {GROUPS.map((g) => (
          <div key={g.label}>
            {!collapsed && <div className="text-[10px] font-medium uppercase tracking-wider text-slate-400 px-2 mb-1">{g.label}</div>}
            <ul className="space-y-0.5">{g.items.map((it) => <li key={it.href}>{renderItem(it)}</li>)}</ul>
          </div>
        ))}
      </nav>

      {!collapsed && (
        <div className="px-3 pb-6 mt-2 border-t border-slate-200/70 dark:border-slate-800 pt-3">
          <a href="/marketing/advertising" target="_blank" rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-700 dark:hover:text-slate-300">
            <ArrowUpRight size={12} /> Classic Advertising (all tools)
          </a>
          <p className="text-[10px] text-slate-400 mt-1.5 leading-relaxed">↗ items open the current tool in a new tab until rebuilt here.</p>
        </div>
      )}
    </aside>
  )
}
