'use client'

/**
 * S4 — the tab-count context, alone in its own module so the dependency graph stays one-way:
 * `tabs.tsx` (the bar) reads this context; `tabCounts.tsx` (the provider) writes it and imports
 * the bar's filter map. Folding this into either file makes the other a circular import.
 */
import { createContext, useContext } from 'react'

export const RulesTabCountsContext = createContext<Record<string, number> | null>(null)

/** Null until the provider's fetch lands (or forever, if it fails) — both render as badge-less labels. */
export function useRulesTabCounts(): Record<string, number> | null {
  return useContext(RulesTabCountsContext)
}
