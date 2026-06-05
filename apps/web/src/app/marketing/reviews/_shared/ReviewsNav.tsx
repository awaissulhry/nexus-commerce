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
import { Star, Inbox, Mail, SlidersHorizontal } from 'lucide-react'
import { GlobalFilterBar } from './GlobalFilterBar'

// UX.1 — four kid-simple tabs. The 8 power-features (Spikes, Heatmap, By-Product,
// Actions, Automation, Spotlight, Import, Rules) are demoted to the Advanced index
// (/advanced) — still fully working, just out of the everyday path.
const TABS = [
  { href: '/marketing/reviews', label: 'Overview', icon: Star, exact: true },
  { href: '/marketing/reviews/desk', label: 'Respond', icon: Inbox, exact: false },
  { href: '/marketing/reviews/requests', label: 'Ask for reviews', icon: Mail, exact: false },
  { href: '/marketing/reviews/advanced', label: 'Advanced', icon: SlidersHorizontal, exact: false },
]

// Routes that live under "Advanced" — the Advanced tab highlights for any of them.
const ADVANCED_PREFIXES = [
  '/marketing/reviews/advanced', '/marketing/reviews/spikes', '/marketing/reviews/heatmap',
  '/marketing/reviews/by-product', '/marketing/reviews/actions', '/marketing/reviews/automation',
  '/marketing/reviews/spotlight', '/marketing/reviews/import',
]

export function ReviewsNav() {
  const pathname = usePathname()
  const isAdvanced = ADVANCED_PREFIXES.some((p) => pathname.startsWith(p))
  return (
    <div className="border-b border-slate-200 dark:border-slate-800 mb-4">
      <nav>
        <ul className="flex items-center gap-1 -mb-px">
          {TABS.map((tab) => {
            const active = tab.href === '/marketing/reviews/advanced' ? isAdvanced : tab.exact ? pathname === tab.href : pathname.startsWith(tab.href)
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
      <GlobalFilterBar />
    </div>
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
