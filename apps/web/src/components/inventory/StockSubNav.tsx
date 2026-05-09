'use client'

/**
 * S.32 — shared sub-navigation strip for the /fulfillment/stock
 * workspace. Renders below each page's PageHeader as a horizontal
 * tab strip with bottom-border accent on the active route.
 *
 * Wayfinding lives here so the per-page header can stay focused on
 * page-local view controls (density / columns / saved views /
 * refresh) instead of cramming 8+ sub-route links into one wrap row.
 *
 * The cycleCountActive badge is optional — pages that already fetch
 * the sidecar (StockWorkspace) can pass it; others render the tab
 * without a badge.
 */

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  Boxes,
  ClipboardCheck,
  ArrowRightLeft,
  Lock as LockIcon,
  Activity,
  AlertTriangle,
  Upload,
  Store,
  Truck,
  Globe,
  ShieldAlert,
  Package,
} from 'lucide-react'
import { useTranslations } from '@/lib/i18n/use-translations'
import { cn } from '@/lib/utils'

interface StockSubNavProps {
  /** Number of active (DRAFT or IN_PROGRESS) cycle-count sessions. */
  cycleCountActive?: number
  /** L.4 — Number of OPEN lot recalls. Surfaces as a red badge on
   *  the Recalls tab so the operator sees compliance issues
   *  immediately on every stock surface. */
  recallsOpen?: number
}

export function StockSubNav({ cycleCountActive = 0, recallsOpen = 0 }: StockSubNavProps) {
  const pathname = usePathname()
  const { t } = useTranslations()

  const tabs = [
    { href: '/fulfillment/stock', labelKey: 'stock.subnav.inventory', icon: Boxes, exact: true },
    { href: '/fulfillment/stock/cycle-count', labelKey: 'stock.action.cycleCounts', icon: ClipboardCheck, badge: cycleCountActive },
    { href: '/fulfillment/stock/transfers', labelKey: 'stock.transfers.title', icon: ArrowRightLeft },
    { href: '/fulfillment/stock/reservations', labelKey: 'stock.reservations.title', icon: LockIcon },
    { href: '/fulfillment/stock/analytics', labelKey: 'stock.analytics.title', icon: Activity },
    { href: '/fulfillment/stock/stockouts', labelKey: 'stock.stockouts.title', icon: AlertTriangle },
    { href: '/fulfillment/stock/lots', labelKey: 'stock.lots.subnav', icon: Package },
    { href: '/fulfillment/stock/recalls', labelKey: 'stock.recalls.title', icon: ShieldAlert, badge: recallsOpen, badgeTone: 'rose' as const },
    { href: '/fulfillment/stock/import', labelKey: 'stock.import.title', icon: Upload },
    { href: '/fulfillment/stock/shopify-locations', labelKey: 'stock.shopifyLocations.title', icon: Store },
    { href: '/fulfillment/stock/mcf', labelKey: 'stock.mcf.title', icon: Truck },
    { href: '/fulfillment/stock/fba-pan-eu', labelKey: 'stock.fbaPanEu.title', icon: Globe },
  ] as const

  function isActive(tab: typeof tabs[number]) {
    if (!pathname) return false
    if ((tab as { exact?: boolean }).exact) return pathname === tab.href
    return pathname === tab.href || pathname.startsWith(`${tab.href}/`)
  }

  return (
    // The wrapper isolates the scroll: width:100% + min-w-0 +
    // overflow-x-hidden keeps the nav inside its grid/flex parent so
    // the page itself never scrolls sideways. The inner <nav> is the
    // actual scroll viewport; only the tab list overflows, never the
    // page. (min-w-0 alone is insufficient when a sibling table or
    // wide content forces the parent wider than the viewport.)
    <div className="w-full min-w-0 overflow-x-hidden">
      <nav
        aria-label={t('stock.subnav.ariaLabel')}
        className="border-b border-slate-200 dark:border-slate-700 overflow-x-auto overscroll-x-contain"
      >
        <ul className="flex items-center gap-0.5 w-max">
          {tabs.map((tab) => {
            const active = isActive(tab)
            const Icon = tab.icon
            const badge = (tab as { badge?: number }).badge ?? 0
            return (
              <li key={tab.href}>
                <Link
                  href={tab.href}
                  aria-current={active ? 'page' : undefined}
                  title={t(tab.labelKey)}
                  className={cn(
                    'inline-flex items-center gap-1.5 px-2.5 py-2 text-sm font-medium border-b-2 transition-colors -mb-px whitespace-nowrap',
                    'min-h-[44px] sm:min-h-[36px]',
                    active
                      ? 'border-blue-600 text-slate-900 dark:text-slate-100 dark:border-blue-400'
                      : 'border-transparent text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 hover:border-slate-300 dark:hover:border-slate-600',
                  )}
                >
                  <Icon
                    size={13}
                    aria-hidden="true"
                    className={cn('shrink-0', active ? 'text-blue-600 dark:text-blue-400' : '')}
                  />
                  {t(tab.labelKey)}
                  {badge > 0 && (
                    <span
                      className={cn(
                        'ml-0.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 text-xs font-semibold rounded-full text-white tabular-nums',
                        (tab as { badgeTone?: 'rose' | 'amber' }).badgeTone === 'rose'
                          ? 'bg-rose-600'
                          : 'bg-amber-500',
                      )}
                      aria-label={t('stock.subnav.badgeAriaLabel', { n: badge })}
                    >
                      {badge}
                    </span>
                  )}
                </Link>
              </li>
            )
          })}
        </ul>
      </nav>
    </div>
  )
}
