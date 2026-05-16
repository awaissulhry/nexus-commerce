'use client'

/**
 * SR.2 — Tab nav for the Sentient Review Loop workspace.
 *
 * Tabs:
 *   Feed       — flat review list with filters
 *   Heatmap    — day × category cube (SR.2)
 *   Per prodotto — sortable by negative rate (SR.2)
 *   Spike      — open + acknowledged spikes (covered in right rail of /)
 */

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { List, Grid, Package, AlertTriangle } from 'lucide-react'

const TABS = [
  { href: '/marketing/reviews', label: 'Feed', icon: List, exact: true },
  {
    href: '/marketing/reviews/heatmap',
    label: 'Heatmap',
    icon: Grid,
    exact: false,
  },
  {
    href: '/marketing/reviews/by-product',
    label: 'By Product',
    icon: Package,
    exact: false,
  },
  {
    href: '/marketing/reviews/spikes',
    label: 'Spikes',
    icon: AlertTriangle,
    exact: false,
  },
]

export function ReviewsNav() {
  const pathname = usePathname()
  return (
    <nav className="border-b border-slate-200 dark:border-slate-800 mb-4">
      <ul className="flex items-center gap-1 -mb-px">
        {TABS.map((tab) => {
          const active = tab.exact ? pathname === tab.href : pathname.startsWith(tab.href)
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
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

export const CATEGORY_LABEL: Record<string, string> = {
  FIT_SIZING: 'Fit / Sizing',
  DURABILITY: 'Durability',
  SHIPPING: 'Shipping',
  VALUE: 'Value',
  DESIGN: 'Design',
  QUALITY: 'Quality',
  SAFETY: 'Safety',
  COMFORT: 'Comfort',
  OTHER: 'Other',
}
