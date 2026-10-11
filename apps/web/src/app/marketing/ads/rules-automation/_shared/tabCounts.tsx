'use client'

/**
 * S4 — one counts fetch for eleven pages.
 *
 * `RulesTabs` used to fire `GET /advertising/automation-rules` on mount to compute five tab
 * badges — on every one of the eleven pages, eleven times per walk across the section. The
 * layout at `rules-automation/layout.tsx` persists across navigation inside the segment, so this
 * provider mounted there fetches once per session instead of once per page.
 *
 * The honesty rules travel with the fetch, not the render:
 *   · only the mapped tabs ever get a number, counted for the market the header shows (the bar does
 *     that, `rulesTabCounts`), and a 0 draws no pill — the same blank as a tab that is not counted;
 *   · a failed count must never blank the navigation — the catch leaves `counts` null and the
 *     bar renders every label without a badge.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { getBackendUrl } from '@/lib/backend-url'
import { RulesTabCountsContext } from './tabCountsContext'
import type { CountedRule } from './rulesFrame'
import { useAdsSync } from './adsBus'

export function RulesTabCountsProvider({ children }: { children: ReactNode }) {
  // Polish round 2 (S12): the provider keeps each rule's actions and market; the bar counts them for the market the
  // header shows (`rulesTabCounts`), so the pills follow a market change without another read.
  const [rules, setRules] = useState<CountedRule[] | null>(null)

  const load = useCallback(async () => {
    try {
      const j = await fetch(`${getBackendUrl()}/api/advertising/automation-rules`, { cache: 'no-store' }).then((r) => r.json())
      const all = (Array.isArray(j?.rules) ? j.rules : Array.isArray(j?.items) ? j.items : Array.isArray(j) ? j : []) as Array<Record<string, unknown>>
      setRules(all.map((r) => ({ actions: r.actions, market: typeof r.scopeMarketplace === 'string' ? r.scopeMarketplace : null })))
    } catch { /* a failed count must never blank the navigation */ }
  }, [])

  useEffect(() => { void load() }, [load])

  /**
   * RT.1 — the badges were fetched once per session and never again, because the layout persists
   * across every navigation inside the segment. That is what makes them cheap, and it is also what
   * made them WRONG the moment a rule was created: the builder saves, the operator returns to a
   * tab bar still showing the old five numbers, and only a full page reload corrected it.
   *
   * One subscription fixes it for all eleven tabs. Rules are the only subject that moves a badge,
   * so this listens to exactly one event.
   */
  useAdsSync(['ads.rule.changed'], () => { void load() })

  return <RulesTabCountsContext.Provider value={rules}>{children}</RulesTabCountsContext.Provider>
}
