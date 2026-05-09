'use client'

import Link from 'next/link'
import { ChevronRight, MapPin, Users } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { cn } from '@/lib/utils'
import { formatCurrency, NUM_FMT } from '../_lib/format'
import type { OverviewPayload, T } from '../_lib/types'

/**
 * DO.27 — customer intelligence panel.
 *
 * Three sub-sections:
 *   1. New / returning split for the active window — two big
 *      counts + a hint at the ratio.
 *   2. Top 5 customers by lifetime spend — links to the customer
 *      profile.
 *   3. Geography — top countries by order count in the window
 *      (compact bar chart of relative share).
 *
 * Hidden entirely when no customer data exists (early-life
 * platform): a near-empty panel is worse than no panel.
 */
export default function CustomerPanel({
  t,
  customers,
  currency,
}: {
  t: T
  customers: OverviewPayload['customers']
  currency: string
}) {
  const hasAny =
    customers.newInWindow > 0 ||
    customers.returningInWindow > 0 ||
    customers.topByLtv.length > 0 ||
    customers.byCountry.length > 0
  if (!hasAny) return null

  const totalCustomersInWindow =
    customers.newInWindow + customers.returningInWindow
  const newPct =
    totalCustomersInWindow > 0
      ? (customers.newInWindow / totalCustomersInWindow) * 100
      : 0
  const returningPct =
    totalCustomersInWindow > 0
      ? (customers.returningInWindow / totalCustomersInWindow) * 100
      : 0

  const maxCountryOrders = customers.byCountry.reduce(
    (m, c) => Math.max(m, c.orders),
    1,
  )

  return (
    <Card
      title={
        <span className="inline-flex items-center gap-1.5">
          <Users className="w-3.5 h-3.5 text-slate-400" />
          {t('overview.customers.heading')}
        </span>
      }
      action={
        <Link
          href="/customers"
          className="text-sm text-blue-600 hover:underline inline-flex items-center gap-1"
        >
          {t('overview.customers.openAll')} <ChevronRight className="w-3 h-3" />
        </Link>
      }
    >
      <div className="space-y-4">
        {/* New vs returning split */}
        {totalCustomersInWindow > 0 && (
          <div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400 font-medium">
                  {t('overview.customers.new')}
                </div>
                <div className="mt-0.5 text-xl font-semibold text-slate-900 dark:text-slate-100 tabular-nums">
                  {NUM_FMT.format(customers.newInWindow)}
                </div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400 font-medium">
                  {t('overview.customers.returning')}
                </div>
                <div className="mt-0.5 text-xl font-semibold text-slate-900 dark:text-slate-100 tabular-nums">
                  {NUM_FMT.format(customers.returningInWindow)}
                </div>
              </div>
            </div>
            {/* Stacked bar showing the ratio */}
            <div className="mt-2 h-1.5 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden flex">
              <div
                className="h-full bg-emerald-500"
                style={{ width: `${newPct}%` }}
                title={t('overview.customers.new')}
              />
              <div
                className="h-full bg-blue-500"
                style={{ width: `${returningPct}%` }}
                title={t('overview.customers.returning')}
              />
            </div>
          </div>
        )}

        {/* Top by LTV */}
        {customers.topByLtv.length > 0 && (
          <div>
            <div className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400 font-semibold mb-1.5">
              {t('overview.customers.topLtv')}
            </div>
            <ul className="space-y-1">
              {customers.topByLtv.map((c) => (
                <li key={c.id}>
                  <Link
                    href={`/customers/${c.id}`}
                    className={cn(
                      'flex items-center justify-between gap-2 px-2 py-1 rounded text-sm',
                      'hover:bg-slate-50 dark:hover:bg-slate-800',
                      'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40',
                    )}
                  >
                    <span className="text-slate-700 dark:text-slate-300 truncate">
                      {c.name ?? c.email}
                    </span>
                    <span className="text-slate-900 dark:text-slate-100 font-semibold tabular-nums flex-shrink-0">
                      {formatCurrency(c.spentCents / 100, currency)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Geographic distribution */}
        {customers.byCountry.length > 0 && (
          <div>
            <div className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400 font-semibold mb-1.5 inline-flex items-center gap-1">
              <MapPin className="w-3 h-3" />
              {t('overview.customers.byCountry')}
            </div>
            <ul className="space-y-1">
              {customers.byCountry.slice(0, 6).map((c) => {
                const pct = (c.orders / maxCountryOrders) * 100
                return (
                  <li
                    key={c.country}
                    className="flex items-center gap-2 text-sm tabular-nums"
                  >
                    <span className="font-mono text-xs text-slate-600 dark:text-slate-400 w-12 flex-shrink-0">
                      {c.country}
                    </span>
                    <div className="flex-1 h-1.5 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-violet-400"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="text-slate-700 dark:text-slate-300 w-8 text-right flex-shrink-0">
                      {NUM_FMT.format(c.orders)}
                    </span>
                  </li>
                )
              })}
            </ul>
          </div>
        )}
      </div>
    </Card>
  )
}
