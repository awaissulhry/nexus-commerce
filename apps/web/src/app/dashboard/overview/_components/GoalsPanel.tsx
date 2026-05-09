'use client'

import { Target } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { cn } from '@/lib/utils'
import { formatCurrency, NUM_FMT, PCT_FMT } from '../_lib/format'
import type { OverviewPayload, T } from '../_lib/types'

/**
 * DO.30 — operator goal tracking.
 *
 * Renders one progress row per ACTIVE Goal: label / period /
 * current vs target / progress bar. Bar tone:
 *
 *   ≥ 100%   emerald — target met or beaten
 *   ≥ 80%    amber  — close, within striking distance
 *   < 80%    slate  — early in period or behind pace
 *
 * Hidden when no goals exist. Goals are inserted via DB or a
 * future admin UI; the dashboard side just reads.
 */
export default function GoalsPanel({
  t,
  goals,
}: {
  t: T
  goals: OverviewPayload['goals']
}) {
  if (goals.length === 0) return null
  return (
    <Card
      title={
        <span className="inline-flex items-center gap-1.5">
          <Target className="w-3.5 h-3.5 text-blue-500" />
          {t('overview.goals.heading')}
        </span>
      }
    >
      <ul className="space-y-3">
        {goals.map((g) => {
          const isCurrency = g.type === 'revenue' || g.type === 'aov'
          const fmt = (v: number) =>
            isCurrency ? formatCurrency(v, g.currency) : NUM_FMT.format(v)
          const tone =
            g.pct >= 100
              ? 'emerald'
              : g.pct >= 80
              ? 'amber'
              : 'slate'
          const barClass =
            tone === 'emerald'
              ? 'bg-emerald-500'
              : tone === 'amber'
              ? 'bg-amber-500'
              : 'bg-slate-400'
          // useTranslations falls back to the key itself when a
          // translation is missing, so unknown types still render
          // legibly (just as the raw key string) until the catalog
          // catches up.
          const labelText = g.label ?? t(`overview.goals.type.${g.type}`)
          return (
            <li key={g.id}>
              <div className="flex items-baseline justify-between gap-2 flex-wrap">
                <div className="text-sm font-medium text-slate-800 dark:text-slate-200">
                  {labelText}
                  <span className="ml-2 text-xs text-slate-500 dark:text-slate-400 font-normal">
                    {t(`overview.goals.period.${g.period}`)}
                  </span>
                </div>
                <div className="text-sm tabular-nums text-slate-700 dark:text-slate-300">
                  <span
                    className={cn(
                      'font-semibold',
                      tone === 'emerald' &&
                        'text-emerald-700 dark:text-emerald-400',
                      tone === 'amber' &&
                        'text-amber-700 dark:text-amber-400',
                    )}
                  >
                    {fmt(g.current)}
                  </span>
                  <span className="text-slate-400 dark:text-slate-500">
                    {' / '}
                    {fmt(g.target)}
                  </span>
                </div>
              </div>
              <div className="mt-1 flex items-center gap-2">
                <div className="flex-1 h-1.5 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                  <div
                    className={cn('h-full', barClass)}
                    style={{ width: `${Math.min(g.pct, 100)}%` }}
                  />
                </div>
                <span
                  className={cn(
                    'text-xs tabular-nums w-12 text-right',
                    tone === 'emerald' &&
                      'text-emerald-700 dark:text-emerald-400',
                    tone === 'amber' &&
                      'text-amber-700 dark:text-amber-400',
                    tone === 'slate' &&
                      'text-slate-500 dark:text-slate-400',
                  )}
                >
                  {PCT_FMT.format(g.pct / 100)}
                </span>
              </div>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}
