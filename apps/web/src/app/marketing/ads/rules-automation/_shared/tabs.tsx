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
import { useEffect, useState } from 'react'
import { getBackendUrl } from '@/lib/backend-url'

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
  // RA.AUTO — one page for all 51 automations, with the type filter that replaces the five
  // action-type tabs below. Added rather than swapped: the tabs it supersedes are retired in
  // the session that owns them, once this page is live and verified (plan Part 6).
  {
    key: 'automations',
    label: 'Automations',
    routed: true,
    subtitle: 'Every automation you have, what it can change, and the one control that decides',
  },
  { key: 'bid', label: 'Bid' },
  { key: 'keyword-harvest', label: 'Keyword Harvest' },
  // NEG.1 — its own page. The tab used to render the protections panel above a rule list and
  // nothing else: 2,059 negatives existed and no screen anywhere in the product listed one.
  {
    key: 'negative-targeting',
    label: 'Negative Targeting',
    routed: true,
    subtitle: 'What you are blocking, where, and who decided',
  },
  { key: 'budget', label: 'Budget' },
  { key: 'dayparting', label: 'Rank & Dayparting Schedules', routed: true, subtitle: 'Hold a rank, on a schedule, across many campaigns' },
  { key: 'budget-schedules', label: 'Budget Schedules' },
  { key: 'placement', label: 'Placement' },
  { key: 'share-of-voice', label: 'Share of Voice' },
  // KT.1 — its own page. The tab used to render SovTrackerTab kind="tracker": a [ Rules | Report ]
  // segment over KeywordRank, a table with 0 rows, so all four columns read `#—` on every row.
  {
    key: 'keyword-tracker',
    label: 'Keyword Tracker',
    routed: true,
    subtitle: 'On the keywords you chose — are we on the page, and is it moving?',
  },
]

export const rulesTabByKey = (key: string): RulesTab | undefined => RULES_TABS.find((t) => t.key === key)

/**
 * Which ACTION TYPES belong to each tab.
 *
 * These tabs used to filter with `actions[0].type === <tab key>` — comparing an action type
 * against a tab key. Those are different vocabularies and the comparison could never be true,
 * so all five live tabs rendered empty. Measured on prod 2026-08-05: the Negative Targeting
 * tab read "Showing 0 Negative Targeting Rules" while five negation rules existed and three
 * were enabled. Same shape as the KEYWORD/AD_TARGET grain mismatch — two halves of one
 * feature disagreeing about the name of the thing they exchange.
 *
 * Two rules this map has to follow:
 *
 *   · Match ANY action on the rule, not `actions[0]`. Rules routinely pair a change with a
 *     `notify`, and ordering inside the array is incidental — filtering on the first element
 *     hides a bid rule because someone listed the notification first.
 *   · A rule may legitimately appear under more than one tab. `harvest_and_negate` both
 *     promotes a converting term and negates a wasteful one, so it belongs to both; filing it
 *     under one would hide it from an operator looking in the other.
 *
 * Deliberately unmapped: notify, alert_operator, retail_guard, the pause_* family and
 * archive_keyword. They are real actions but none of these five tabs is their home, and
 * inventing a home would misfile them where nobody would think to look. They remain visible
 * on Apply Rules, which lists every rule regardless of type.
 */
export const RULE_TAB_ACTION_TYPES: Record<string, string[]> = {
  bid: ['bid_to_target_acos', 'bid_up', 'bid_down', 'lower_bid_to_floor', 'raise_bids_for_rank_defense'],
  budget: ['adjust_ad_budget'],
  placement: ['set_placement_multiplier', 'defend_top_of_search'],
  'keyword-harvest': ['promote_to_exact', 'harvest_and_negate'],
  'negative-targeting': ['harvest_and_negate', 'add_negative_exact', 'add_negative_phrase', 'sync_negatives_across_campaigns'],
}

/** True when any of the rule's actions belongs to `tabKey`. */
export function ruleBelongsToTab(actions: unknown, tabKey: string): boolean {
  const want = RULE_TAB_ACTION_TYPES[tabKey]
  if (!want) return false
  const list = Array.isArray(actions) ? actions : []
  return list.some((a) => want.includes(String((a as { type?: unknown })?.type ?? '')))
}

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
  // Counts in the tab labels, so the information architecture does the prioritising: you see
  // where the work is before clicking anything. Computed from RULE_TAB_ACTION_TYPES — the same
  // map the lists filter by — so a label can never claim a number its tab won't show.
  //
  // Only the five mapped tabs get a count. The rest genuinely have no number to state here, and
  // a blank is honest where a 0 would read as "nothing to do".
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

  return (
    <div className="h10-cd-tabs h10-rules-tabs" role="tablist" aria-label="Rule types">
      {RULES_TABS.map((t) => {
        const n = counts?.[t.key]
        return (
          <Link
            key={t.key}
            href={rulesTabHref(t)}
            role="tab"
            aria-selected={t.key === active}
            className={`h10-cd-tab ${t.key === active ? 'on' : ''}`}
            scroll={false}
          >
            {t.label}
            {n != null && <span className="h10-cd-tabn">{n}</span>}
          </Link>
        )
      })}
    </div>
  )
}
