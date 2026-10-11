'use client'

/**
 * S4 — the tab-count context, alone in its own module so the dependency graph stays one-way:
 * `tabs.tsx` (the bar) reads this context; `tabCounts.tsx` (the provider) writes it and imports
 * the bar's filter map. Folding this into either file makes the other a circular import.
 */
import { createContext, useContext } from 'react'
import type { CountedRule } from './rulesFrame'

/**
 * The rules the bar counts (actions + market), not the counts: the bar counts them for the market the header shows
 * (polish round 2, S12), so a market change costs no fetch.
 */
export const RulesTabCountsContext = createContext<CountedRule[] | null>(null)

/** Null until the provider's fetch lands (or forever, if it fails) — both render as badge-less labels. */
export function useRulesTabRules(): CountedRule[] | null {
  return useContext(RulesTabCountsContext)
}
