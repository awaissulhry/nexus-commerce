/**
 * Rules & Automation sub-tree layout. Three jobs:
 *   · load the Rules-specific stylesheet (builder · rule-type modal · bulk-edit) in isolation
 *     from the shared ads.css;
 *   · mount the tab-count provider ONCE for the whole section — the layout persists across
 *     navigation inside the segment, so the bar's count badges cost one fetch per session
 *     instead of one per page (S4);
 *   · the section's header in the design system (bid page programme, lane SHELL, 2026-10-10): every tab page keeps
 *     calling `AdsPageHeader` with its own props and gets `RulesHeader` — one compact row, title · Change log ·
 *     market — above the shared link `RulesTabs`.
 */
import './rules-automation.css'
import type { ReactNode } from 'react'
import { RulesHeaderFrame } from './_shared/RulesHeader'
import { RulesTabCountsProvider } from './_shared/tabCounts'

export default function RulesAutomationLayout({ children }: { children: ReactNode }) {
  return (
    <RulesTabCountsProvider>
      <RulesHeaderFrame>{children}</RulesHeaderFrame>
    </RulesTabCountsProvider>
  )
}
