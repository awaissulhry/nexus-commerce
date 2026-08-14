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
 *   · only the five mapped tabs ever get a number — a blank is honest where a 0 would read as
 *     "nothing to do";
 *   · a failed count must never blank the navigation — the catch leaves `counts` null and the
 *     bar renders every label without a badge.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { getBackendUrl } from '@/lib/backend-url'
import { RULE_TAB_ACTION_TYPES, ruleBelongsToTab } from './tabs'
import { RulesTabCountsContext } from './tabCountsContext'

export function RulesTabCountsProvider({ children }: { children: ReactNode }) {
  const [counts, setCounts] = useState<Record<string, number> | null>(null)
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const j = await fetch(`${getBackendUrl()}/api/advertising/automation-rules`, { cache: 'no-store' }).then((r) => r.json())
        const all = (Array.isArray(j?.rules) ? j.rules : Array.isArray(j?.items) ? j.items : Array.isArray(j) ? j : []) as Array<Record<string, unknown>>
        const next: Record<string, number> = {}
        for (const key of Object.keys(RULE_TAB_ACTION_TYPES)) {
          next[key] = all.filter((r) => ruleBelongsToTab(r.actions, key)).length
        }
        if (alive) setCounts(next)
      } catch { /* a failed count must never blank the navigation */ }
    })()
    return () => { alive = false }
  }, [])
  return <RulesTabCountsContext.Provider value={counts}>{children}</RulesTabCountsContext.Provider>
}
