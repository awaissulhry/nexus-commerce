/**
 * UX.2 — Advanced index. The 8 power-features demoted from the primary nav live
 * here as a labeled card grid — still fully working, just out of the everyday
 * Overview / Respond / Ask-for-reviews path. "Demote, don't delete."
 */

import Link from 'next/link'
import { AlertTriangle, Grid, Package, Wrench, Bot, Lightbulb, Upload, SlidersHorizontal, type LucideIcon } from 'lucide-react'
import { ReviewsNav } from '../_shared/ReviewsNav'

export const dynamic = 'force-dynamic'

const FEATURES: { href: string; label: string; desc: string; icon: LucideIcon }[] = [
  { href: '/marketing/reviews/spikes', label: 'Spikes', desc: 'Negative-review spikes by category — acknowledge and resolve.', icon: AlertTriangle },
  { href: '/marketing/reviews/actions', label: 'Action items', desc: 'AI fix suggestions (bullets, A+, recall flags) generated from spikes.', icon: Wrench },
  { href: '/marketing/reviews/spotlight', label: 'AI Spotlight', desc: 'Voice-of-customer brief: complaints, praises, emerging themes.', icon: Lightbulb },
  { href: '/marketing/reviews/by-product', label: 'By product', desc: 'Per-SKU review rollup, sorted by negative rate.', icon: Package },
  { href: '/marketing/reviews/heatmap', label: 'Heatmap', desc: 'Day × category sentiment grid.', icon: Grid },
  { href: '/marketing/reviews/automation', label: 'Automation', desc: 'Rule-driven review automation (added disabled + dry-run).', icon: Bot },
  { href: '/marketing/reviews/import', label: 'Import reviews', desc: 'Upload CSV / JSON / XLSX exports (Seller Central, Judge.me, Loox).', icon: Upload },
  { href: '/orders/reviews/rules', label: 'Request rules', desc: 'Define when post-purchase review requests are sent.', icon: SlidersHorizontal },
]

export default function AdvancedPage() {
  return (
    <div className="px-4 py-4">
      <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100 mb-2">Reviews</h1>
      <ReviewsNav />
      <p className="mb-4 text-sm text-slate-500 dark:text-slate-400">Power tools — everything beyond the everyday flow. All fully functional.</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {FEATURES.map((f) => {
          const Icon = f.icon
          return (
            <Link
              key={f.href}
              href={f.href}
              className="group block rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 hover:border-blue-400 dark:hover:border-blue-500 transition-colors"
            >
              <div className="flex items-center gap-2 mb-1.5">
                <span className="inline-flex items-center justify-center h-8 w-8 rounded-md bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 group-hover:bg-blue-50 group-hover:text-blue-600 dark:group-hover:bg-blue-950">
                  <Icon className="h-4 w-4" aria-hidden="true" />
                </span>
                <span className="font-medium text-slate-900 dark:text-slate-100">{f.label}</span>
              </div>
              <p className="text-sm text-slate-500 dark:text-slate-400">{f.desc}</p>
            </Link>
          )
        })}
      </div>
    </div>
  )
}
