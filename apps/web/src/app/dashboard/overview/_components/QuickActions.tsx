'use client'

import Link from 'next/link'
import {
  AlertTriangle,
  ArrowRight,
  CheckSquare,
  FileText,
  PackageCheck,
  RotateCcw,
  Truck,
} from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { cn } from '@/lib/utils'
import { NUM_FMT } from '../_lib/format'
import type { OverviewPayload, T } from '../_lib/types'

/**
 * Quick actions launchpad — operationally relevant.
 *
 * DO.23 — replaces the previous fixed catalog/marketing list (Add
 * product / Bulk operations / Generate AI content / Channel
 * settings). Those targets weren't wrong, but they don't match
 * what an operator actually does daily on the Command Center: ship
 * orders, resolve errors, review returns, approve drafts, run
 * replenishment, generate reports.
 *
 * Each action shows a count badge when there's relevant work
 * waiting (e.g., Process pending shipments shows "3" when
 * pendingOrders=3). Operator learns at a glance what queue is
 * deepest without scanning the alerts panel.
 */
export default function QuickActions({
  t,
  alerts,
}: {
  t: T
  alerts: OverviewPayload['alerts']
}) {
  const actions: Array<{
    label: string
    href: string
    icon: typeof Truck
    badge?: number
    badgeTone?: 'rose' | 'amber'
  }> = [
    {
      label: t('overview.quickActions.processShipments'),
      href: '/fulfillment/outbound',
      icon: Truck,
      badge: alerts.pendingOrders,
      badgeTone: alerts.lateShipments > 0 ? 'rose' : 'amber',
    },
    {
      label: t('overview.quickActions.resolveErrors'),
      href: '/listings?listingStatus=ERROR',
      icon: AlertTriangle,
      badge: alerts.failedListings,
      badgeTone: 'rose',
    },
    {
      label: t('overview.quickActions.reviewReturns'),
      href: '/fulfillment/returns',
      icon: RotateCcw,
      badge: alerts.returnsBacklog,
      badgeTone: 'amber',
    },
    {
      label: t('overview.quickActions.approveDrafts'),
      href: '/products/drafts',
      icon: CheckSquare,
      badge: alerts.draftListings,
      badgeTone: 'amber',
    },
    {
      label: t('overview.quickActions.replenish'),
      href: '/fulfillment/replenishment',
      icon: PackageCheck,
    },
    {
      label: t('overview.quickActions.generateReport'),
      href: '/dashboard/reports',
      icon: FileText,
    },
  ]
  return (
    <Card title={t('overview.quickActions.heading')} noPadding>
      <ul className="px-2 py-2">
        {actions.map((a) => {
          const Icon = a.icon
          const showBadge = a.badge !== undefined && a.badge > 0
          return (
            <li key={a.label}>
              <Link
                href={a.href}
                className={cn(
                  'group flex items-center gap-2 px-2 py-1.5 rounded text-base text-slate-700 dark:text-slate-300',
                  'hover:bg-slate-50 dark:hover:bg-slate-800',
                  'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40',
                )}
              >
                <Icon className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400 flex-shrink-0" />
                <span className="flex-1">{a.label}</span>
                {showBadge && (
                  <span
                    className={cn(
                      'inline-flex items-center px-1.5 py-0.5 rounded text-xs font-semibold tabular-nums',
                      a.badgeTone === 'rose'
                        ? 'bg-rose-100 dark:bg-rose-950/50 text-rose-700 dark:text-rose-400'
                        : 'bg-amber-100 dark:bg-amber-950/50 text-amber-700 dark:text-amber-400',
                    )}
                  >
                    {NUM_FMT.format(a.badge!)}
                  </span>
                )}
                <ArrowRight className="w-3 h-3 text-slate-300 dark:text-slate-600 group-hover:text-slate-500 dark:group-hover:text-slate-400 transition-colors flex-shrink-0" />
              </Link>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}
