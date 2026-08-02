'use client'

/**
 * DPS.3 — the Rules & Automation tab substrate.
 *
 * The 10 tabs used to live as `useState` inside RulesAutomationClient, which meant the section had
 * exactly one URL: refreshing, bookmarking or sharing any tab always dropped you back on "Apply
 * Rules". Every tab is now addressable.
 *
 * Two kinds of destination, so tabs can migrate one at a time instead of in one large change:
 *   · `routed: true`  → its own page at /rules-automation/<key> (own route, own data loading)
 *   · otherwise       → the index page at /rules-automation?tab=<key> (still deep-linkable)
 *
 * Flipping a tab to its own page = build the route, set `routed: true`, drop its branch from the
 * index. Nothing else in the bar changes.
 */
import Link from 'next/link'

export interface RulesTab {
  key: string
  label: string
  /** true once this tab has its own page under /rules-automation/<key> */
  routed?: boolean
  /** shown under the page title when this tab is active */
  subtitle?: string
}

export const RULES_BASE = '/marketing/ads/rules-automation'

// Order matches Helium 10 Ads. "Dayparting Schedules" is renamed because 100% of the live rows are
// rank-goal schedules (hold an impression share), not classic bid/pause dayparting — the old label
// described the mode nobody uses.
export const RULES_TABS: RulesTab[] = [
  { key: 'rules', label: 'Apply Rules', subtitle: 'Create and manage rules for all of your campaigns' },
  { key: 'bid', label: 'Bid' },
  { key: 'keyword-harvest', label: 'Keyword Harvest' },
  { key: 'negative-targeting', label: 'Negative Targeting' },
  { key: 'budget', label: 'Budget' },
  { key: 'dayparting', label: 'Rank & Dayparting Schedules', routed: true, subtitle: 'Hold a rank, on a schedule, across many campaigns' },
  { key: 'budget-schedules', label: 'Budget Schedules' },
  { key: 'placement', label: 'Placement' },
  { key: 'share-of-voice', label: 'Share of Voice' },
  { key: 'keyword-tracker', label: 'Keyword Tracker' },
]

export const rulesTabByKey = (key: string): RulesTab | undefined => RULES_TABS.find((t) => t.key === key)

/** Where clicking a tab goes. Routed tabs get a real path; the rest ride the index's ?tab= param. */
export function rulesTabHref(tab: RulesTab): string {
  if (tab.routed) return `${RULES_BASE}/${tab.key}`
  return tab.key === 'rules' ? RULES_BASE : `${RULES_BASE}?tab=${tab.key}`
}

/**
 * The sticky tab bar, shared by the index and every routed tab page so the row is identical
 * wherever you are. Links (not buttons) so middle-click / cmd-click / back all behave.
 */
export function RulesTabs({ active }: { active: string }) {
  return (
    <div className="h10-cd-tabs h10-rules-tabs" role="tablist" aria-label="Rule types">
      {RULES_TABS.map((t) => (
        <Link
          key={t.key}
          href={rulesTabHref(t)}
          role="tab"
          aria-selected={t.key === active}
          className={`h10-cd-tab ${t.key === active ? 'on' : ''}`}
          scroll={false}
        >
          {t.label}
        </Link>
      ))}
    </div>
  )
}
