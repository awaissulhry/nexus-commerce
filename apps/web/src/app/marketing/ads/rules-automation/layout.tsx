/**
 * Rules & Automation sub-tree layout. Two jobs:
 *   · load the Rules-specific stylesheet (builder · rule-type modal · bulk-edit) in isolation
 *     from the shared ads.css;
 *   · mount the tab-count provider ONCE for the whole section — the layout persists across
 *     navigation inside the segment, so the bar's five badges cost one fetch per session
 *     instead of one per page (S4).
 */
import './rules-automation.css'
import type { ReactNode } from 'react'
import { RulesTabCountsProvider } from './_shared/tabCounts'

export default function RulesAutomationLayout({ children }: { children: ReactNode }) {
  return <RulesTabCountsProvider>{children}</RulesTabCountsProvider>
}
