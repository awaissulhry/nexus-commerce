'use client'

/**
 * DPS.3 — "Rank & Dayparting Schedules" as its own page.
 *
 * Was tab #6 of a `useState` tab bar with no URL of its own. It is now a real route
 * (/marketing/ads/rules-automation/dayparting): deep-linkable, refresh-safe, back-button-correct.
 *
 * Chrome is deliberately identical to the index — same AdsPageHeader, same shared RulesTabs row —
 * so navigating between tabs reads as one section rather than a jump to a different kind of page.
 * The body is the existing RankGoalsList, moved across unchanged.
 */
import { useEffect, useMemo, useState } from 'react'
import { Plus } from 'lucide-react'
import { AdsPageHeader } from '../../_shell/AdsPageHeader'
import { RulesTabs, rulesTabByKey } from '../_shared/tabs'
import { RankGoalsList } from '../tabs/RankGoalsList'
import { HourlyPerformance, type ScopeOption } from './HourlyPerformance'
import { getBackendUrl } from '@/lib/backend-url'

export function DaypartingSchedulesClient() {
  // The header's market switch is fed by the campaigns the account actually has, matching the index.
  const [markets, setMarkets] = useState<string[]>([])
  const [market, setMarket] = useState('all')
  // DPS.4 — the heatmap can be narrowed to one schedule, so it needs the schedule names. Only
  // groups that actually hold campaigns can produce a heatmap, so empty ones are left out.
  const [scopes, setScopes] = useState<ScopeOption[]>([])

  useEffect(() => {
    let alive = true
    void fetch(`${getBackendUrl()}/api/advertising/campaigns?limit=500`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return
        const items = (Array.isArray(d?.items) ? d.items : []) as Array<{ marketplace?: string | null }>
        setMarkets(Array.from(new Set(items.map((c) => c.marketplace).filter(Boolean))) as string[])
      })
      .catch(() => {})
    void fetch(`${getBackendUrl()}/api/advertising/rank-schedule-groups`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return
        const items = (Array.isArray(d?.items) ? d.items : []) as Array<{ id?: string; name?: string; campaignCount?: number }>
        setScopes(items
          .filter((g) => g.id && Number(g.campaignCount ?? 0) > 0)
          .map((g) => ({ value: String(g.id), label: String(g.name ?? g.id) })))
      })
      .catch(() => {})
    return () => { alive = false }
  }, [])

  const subtitle = useMemo(() => rulesTabByKey('dayparting')?.subtitle ?? '', [])

  return (
    <div className="h10-rules-page">
      <AdsPageHeader
        title="Rules & Automation"
        subtitle={subtitle}
        markets={markets}
        market={market}
        onMarketChange={setMarket}
        showLearn={false}
        showDataSync={false}
        showDateRange={false}
        // Without an explicit primary the header falls back to an "Action ▾" dropdown, which on this
        // page would open EMPTY (no `actions` to put in it). The section's one creation verb is
        // making a schedule, so name it — same slot the index uses for "+ Rule".
        primaryAction={{ label: 'Rank Schedule', icon: <Plus size={15} />, href: '/marketing/ads/rules-automation/builder/dayparting-schedule' }}
      />
      <RulesTabs active="dayparting" />
      {/* Look first, author second — the grid sits above the list of schedules it justifies. */}
      <HourlyPerformance scopes={scopes} />
      <RankGoalsList />
    </div>
  )
}
