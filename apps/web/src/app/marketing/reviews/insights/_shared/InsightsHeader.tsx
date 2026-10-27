'use client'

/**
 * Reviews › Insights — the header every Insights page shows (the boards' "Shared Insights header", ruling 1): crumbs
 * "Marketing › Reviews › Insights › <page>" from the Reviews navigation, the title "Insights", the page's line, and the
 * scope: the channel-and-market picker and the period (7 days · 30 days · 90 days · 12 months). Both stay in the
 * address (useInsights.ts). The "Reviews" button opens the sub-sidebar below 1024 px. A page adds its own actions after
 * the scope.
 */
import type { ReactNode } from 'react'
import { Listbox } from '@/design-system/components'
import { PageHeader } from '@/design-system/patterns'
import { SegmentedControl } from '@/design-system/primitives'
import { usePathname } from '@/lib/workspaces/navigation'
import { reviewsCrumbs } from '../../_shell/reviews-crumbs'
import { ReviewsMenuButton } from '../../_shell/ReviewsShell'
import { PERIOD_OPTIONS, parseInsightsPeriod, scopeFromKey, scopeKey, scopeOptions, type InsightsScope, type ScopeChoice } from './insightsScope'
import s from './insights.module.css'

export interface InsightsHeaderProps {
  scope: InsightsScope | null
  onScope: (next: Partial<InsightsScope>) => void
  /** The page's line under the title. */
  subtitle: ReactNode
  /** The picker's choices (useScopeChoices); the scope on screen is always one of them. */
  choices: readonly ScopeChoice[]
  /** The picker's name (Brief: "Brief for which channel and market"). */
  pickerLabel?: string
  /** Show each choice's note (Brief: "Brief from 26 Oct"). */
  notes?: boolean
  /** The page's own actions, after the scope. */
  actions?: ReactNode
}

export function InsightsHeader({ scope, onScope, subtitle, choices, pickerLabel = 'Channel and market', notes = false, actions }: InsightsHeaderProps) {
  const pathname = usePathname() ?? '/marketing/reviews/insights/themes'
  const current = scope ?? { channel: null, market: null, period: '30d' as const }
  const options = scopeOptions(choices, current, { notes })
  const header = (
    <div className={s.actions}>
      <ReviewsMenuButton />
      <Listbox
        size="sm"
        width={230}
        ariaLabel={pickerLabel}
        options={options}
        value={scopeKey(current)}
        onChange={(value) => onScope(scopeFromKey(value))}
        searchable={options.length > 8}
      />
      <SegmentedControl
        size="sm"
        ariaLabel="Period"
        options={PERIOD_OPTIONS}
        value={current.period}
        onChange={(value) => onScope({ period: parseInsightsPeriod(value) })}
      />
      {actions}
    </div>
  )
  return <PageHeader eyebrow={reviewsCrumbs(pathname)} title="Insights" subtitle={subtitle} actions={header} />
}
