'use client'

/**
 * AD.2 — Tab navigation for the Trading Desk workspace.
 *
 * Surfaces the four sub-paths under /marketing/advertising:
 *   campaigns   — campaign list with inline edit
 *   storage-age — FBA aged-stock heatmap
 *   profit      — daily P&L grid
 *   automation  — rule editor (stub in AD.2, fills in AD.3)
 *
 * The landing at /marketing/advertising remains a ComingSoonPage —
 * operators navigate directly to these sub-paths today.
 */

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Activity, Warehouse, TrendingUp, Bot, Wallet } from 'lucide-react'

import type { LucideIcon } from 'lucide-react'

interface Tab {
  href: string
  label: string
  icon: LucideIcon
  matchPrefix: string
  soon?: boolean
}

const TABS: Tab[] = [
  {
    href: '/marketing/advertising/campaigns',
    label: 'Campagne',
    icon: Activity,
    matchPrefix: '/marketing/advertising/campaigns',
  },
  {
    href: '/marketing/advertising/storage-age',
    label: 'Stock invecchiato',
    icon: Warehouse,
    matchPrefix: '/marketing/advertising/storage-age',
  },
  {
    href: '/marketing/advertising/profit',
    label: 'Margine reale',
    icon: TrendingUp,
    matchPrefix: '/marketing/advertising/profit',
  },
  {
    href: '/marketing/advertising/automation',
    label: 'Automazione',
    icon: Bot,
    matchPrefix: '/marketing/advertising/automation',
  },
  {
    href: '/marketing/advertising/budget-pools',
    label: 'Budget pool',
    icon: Wallet,
    matchPrefix: '/marketing/advertising/budget-pools',
  },
]

export function AdvertisingNav() {
  const pathname = usePathname()
  return (
    <nav className="border-b border-slate-200 dark:border-slate-800 mb-4">
      <ul className="flex items-center gap-1 -mb-px">
        {TABS.map((tab) => {
          const active = pathname.startsWith(tab.matchPrefix)
          const Icon = tab.icon
          return (
            <li key={tab.href}>
              <Link
                href={tab.href}
                aria-current={active ? 'page' : undefined}
                className={`inline-flex items-center gap-1.5 px-3 py-2 text-sm border-b-2 transition-colors ${
                  active
                    ? 'border-blue-600 text-blue-700 dark:text-blue-300 dark:border-blue-400'
                    : 'border-transparent text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
                }`}
              >
                <Icon className="h-4 w-4" aria-hidden="true" />
                {tab.label}
                {tab.soon && (
                  <span className="text-[10px] uppercase tracking-wider px-1 py-0.5 rounded ring-1 ring-inset bg-slate-50 text-slate-500 ring-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:ring-slate-700">
                    AD.3
                  </span>
                )}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
