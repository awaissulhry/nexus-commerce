'use client'

/**
 * Collapsible, grouped in-page sidebar for the Advertising workspace.
 * Curated: ~12 daily-driver surfaces up top, the redundant/deep-dive tools
 * folded under a collapsible "Advanced" group. Recommendations is the action
 * hub (bid/negative/budget/retail surface there), so the individual optimizer
 * tools live under Advanced. The whole rail also collapses to icons.
 */

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import {
  Activity, Target, Plus, Wand2, Sparkles, Gauge, Wallet, Clock, Sprout,
  Radar, Brain, Crosshair, PackageX, Lightbulb, BarChart2, Tv, Users,
  Bot, Search, ClipboardList, TrendingUp, Rss, Zap, History, Filter,
  PanelLeftClose, PanelLeftOpen, ChevronDown, ChevronRight,
} from 'lucide-react'

interface Item { href: string; label: string; icon: LucideIcon }
interface Group { label: string; items: Item[]; advanced?: boolean }

const GROUPS: Group[] = [
  { label: 'Overview', items: [
    { href: '/marketing/advertising/campaigns', label: 'Campaigns', icon: Activity },
    { href: '/marketing/advertising/recommendations', label: 'Recommendations', icon: Sparkles },
    { href: '/marketing/advertising/momentum', label: 'Live momentum', icon: Zap },
  ] },
  { label: 'Create', items: [
    { href: '/marketing/advertising/goals', label: 'New goal', icon: Target },
    { href: '/marketing/advertising/architect', label: 'Auto-architect', icon: Wand2 },
    { href: '/marketing/advertising/funnel', label: 'Launch & funnel', icon: Filter },
  ] },
  { label: 'Optimize', items: [
    { href: '/marketing/advertising/automation', label: 'Automation', icon: Bot },
    { href: '/marketing/advertising/budget-manager', label: 'Budget Manager', icon: Wallet },
    { href: '/marketing/advertising/dayparting', label: 'Dayparting', icon: Clock },
  ] },
  { label: 'Intelligence', items: [
    { href: '/marketing/advertising/analytics', label: 'Analytics', icon: BarChart2 },
    { href: '/marketing/advertising/share-of-voice', label: 'Share of voice', icon: Radar },
    { href: '/marketing/advertising/incrementality', label: 'iROAS', icon: Crosshair },
    { href: '/marketing/advertising/retail-readiness', label: 'Retail readiness', icon: PackageX },
  ] },
  { label: 'Programmatic', items: [
    { href: '/marketing/advertising/dsp', label: 'DSP', icon: Tv },
    { href: '/marketing/advertising/audiences', label: 'Audiences', icon: Users },
  ] },
  { label: 'Advanced', advanced: true, items: [
    { href: '/marketing/advertising/bid-optimizer', label: 'Bid optimizer', icon: Gauge },
    { href: '/marketing/advertising/harvest', label: 'Harvesting', icon: Sprout },
    { href: '/marketing/advertising/pacing', label: 'Budget pacing', icon: Wallet },
    { href: '/marketing/advertising/budget-pools', label: 'Budget pools', icon: Wallet },
    { href: '/marketing/advertising/ngrams', label: 'N-gram intel', icon: Brain },
    { href: '/marketing/advertising/search-terms', label: 'Search terms', icon: Search },
    { href: '/marketing/advertising/events', label: 'Events', icon: History },
    { href: '/marketing/advertising/create', label: 'Single campaign', icon: Plus },
    { href: '/marketing/advertising/insights', label: 'Insights', icon: Lightbulb },
    { href: '/marketing/advertising/reports', label: 'Reports', icon: ClipboardList },
    { href: '/marketing/advertising/profit', label: 'True profit', icon: TrendingUp },
    { href: '/marketing/advertising/feeds', label: 'Feeds', icon: Rss },
  ] },
]

export function AdvertisingSidebar() {
  const pathname = usePathname()
  const [collapsed, setCollapsed] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem('ax.sidebar.collapsed') === '1')
      // Auto-open Advanced if the current page lives inside it.
      const adv = GROUPS.find((g) => g.advanced)
      if (adv?.items.some((i) => location.pathname.startsWith(i.href))) setAdvancedOpen(true)
      else setAdvancedOpen(localStorage.getItem('ax.sidebar.advanced') === '1')
    } catch {}
  }, [])
  const toggle = () => setCollapsed((c) => { const n = !c; try { localStorage.setItem('ax.sidebar.collapsed', n ? '1' : '0') } catch {}; return n })
  const toggleAdvanced = () => setAdvancedOpen((o) => { const n = !o; try { localStorage.setItem('ax.sidebar.advanced', n ? '1' : '0') } catch {}; return n })

  const renderItems = (items: Item[]) => (
    <ul className="space-y-0.5">
      {items.map((it) => {
        const active = pathname.startsWith(it.href)
        const Icon = it.icon
        return (
          <li key={it.href}>
            <Link href={it.href} title={collapsed ? it.label : undefined} aria-current={active ? 'page' : undefined}
              className={`flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm ${collapsed ? 'justify-center' : ''} ${active ? 'bg-blue-600 text-white' : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'}`}>
              <Icon size={16} className="shrink-0" />
              {!collapsed && <span className="truncate">{it.label}</span>}
            </Link>
          </li>
        )
      })}
    </ul>
  )

  return (
    <aside className={`shrink-0 border-r border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/30 ${collapsed ? 'w-14' : 'w-56'} transition-[width] duration-150 sticky top-0 self-start h-[calc(100vh-3.5rem)] overflow-y-auto`}>
      <div className={`flex items-center ${collapsed ? 'justify-center' : 'justify-between'} px-2 py-2 sticky top-0 bg-slate-50/80 dark:bg-slate-900/60 backdrop-blur z-10`}>
        {!collapsed && <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 px-2">Advertising</span>}
        <button onClick={toggle} title={collapsed ? 'Expand' : 'Collapse'} className="p-1.5 rounded-md text-slate-400 hover:text-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800">
          {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
        </button>
      </div>
      <nav className="px-2 pb-6 space-y-3">
        {GROUPS.map((g) => {
          // Advanced group: collapsible section (expanded mode only).
          if (g.advanced && !collapsed) {
            return (
              <div key={g.label}>
                <button onClick={toggleAdvanced} className="w-full flex items-center justify-between text-[10px] font-medium uppercase tracking-wider text-slate-400 px-2 mb-1 hover:text-slate-600">
                  <span>{g.label}</span>{advancedOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                </button>
                {advancedOpen && renderItems(g.items)}
              </div>
            )
          }
          return (
            <div key={g.label}>
              {!collapsed && <div className="text-[10px] font-medium uppercase tracking-wider text-slate-400 px-2 mb-1">{g.label}</div>}
              {renderItems(g.items)}
            </div>
          )
        })}
      </nav>
    </aside>
  )
}
