'use client'

import { Receipt } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { cn } from '@/lib/utils'
import { formatCurrency, NUM_FMT, PCT_FMT } from '../_lib/format'
import type { OverviewPayload, T } from '../_lib/types'

/**
 * DO.29 — financial overview.
 *
 * Three-column grid showing:
 *   - Gross margin estimate (revenue − COGS), with margin % and a
 *     "n% of items have cost data on file" caveat when coverage
 *     is below the threshold.
 *   - Refund count in the window (paired with the existing refund
 *     value KPI in the strip).
 *   - Tax collected aggregate (Italian VAT-inclusive sum from
 *     OrderItem.vatRate). The detailed per-market breakdown lives
 *     at /reports/business; this is the headline.
 *
 * Hidden when no financial activity at all in the window — empty
 * panel adds noise.
 */
export default function FinancialPanel({
  t,
  financial,
  currency,
}: {
  t: T
  financial: OverviewPayload['financial']
  currency: string
}) {
  const hasAny =
    financial.grossRevenue > 0 ||
    financial.refundCount > 0 ||
    financial.taxCollected > 0
  if (!hasAny) return null

  const lowCoverage = financial.costCoveragePct < 60
  return (
    <Card
      title={
        <span className="inline-flex items-center gap-1.5">
          <Receipt className="w-3.5 h-3.5 text-slate-400" />
          {t('overview.financial.heading')}
        </span>
      }
    >
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-base">
        <div>
          <div className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400 font-medium">
            {t('overview.financial.margin')}
          </div>
          <div className="mt-0.5 text-xl font-semibold text-slate-900 dark:text-slate-100 tabular-nums">
            {formatCurrency(financial.margin, currency)}
          </div>
          <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
            {PCT_FMT.format(financial.marginPct / 100)}
            {lowCoverage && (
              <>
                {' · '}
                <span
                  className={cn('text-amber-600 dark:text-amber-400')}
                  title={t('overview.financial.lowCoverageTooltip')}
                >
                  {t('overview.financial.lowCoverage', {
                    pct: NUM_FMT.format(Math.round(financial.costCoveragePct)),
                  })}
                </span>
              </>
            )}
          </div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400 font-medium">
            {t('overview.financial.refundCount')}
          </div>
          <div className="mt-0.5 text-xl font-semibold text-slate-900 dark:text-slate-100 tabular-nums">
            {NUM_FMT.format(financial.refundCount)}
          </div>
          <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            {t('overview.financial.refundCountHint')}
          </div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400 font-medium">
            {t('overview.financial.taxCollected')}
          </div>
          <div className="mt-0.5 text-xl font-semibold text-slate-900 dark:text-slate-100 tabular-nums">
            {formatCurrency(financial.taxCollected, currency)}
          </div>
          <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            {t('overview.financial.taxHint')}
          </div>
        </div>
      </div>
    </Card>
  )
}
